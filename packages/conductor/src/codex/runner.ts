import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { ReasoningEffort, Usage } from "@inventio/schema";
import { Usage as UsageSchema } from "@inventio/schema";

/**
 * Low-level driver for one `codex exec` (or `codex exec resume`) process
 * (DESIGN §8). Speaks the verified JSONL dialect, archives every raw line,
 * meters an estimator for mid-task budget kills, and enforces wall-clock.
 *
 * Note (verified live): `codex exec resume` does NOT accept `-C` / `-s`;
 * resume runs set cwd via spawn options and inherit the session sandbox.
 */

export type SandboxMode = "read-only" | "workspace-write";

export interface McpAttachment {
  serverName: string;
  url: string;
  tokenEnvVar: string;
  token: string;
}

export interface RunCodexOptions {
  bin: string;
  cwd: string;
  prompt: string;
  sandbox: SandboxMode;
  eventsArchiveFile: string;
  model?: string | null;
  effort?: ReasoningEffort;
  outputSchemaFile?: string;
  outputLastMessageFile?: string;
  mcp?: McpAttachment;
  resumeThreadId?: string;
  /** Enable Codex's native web_search tool (granted per task, never default). */
  webSearch?: boolean;
  /** Ignore repository AGENTS.md files and disable delegation for a small standalone call. */
  isolatedTask?: boolean;
  /** estimator kill threshold; undefined = no budget kill; a function is re-read live (task extensions) */
  maxEstimatedTokens?: number | (() => number);
  /** starting estimate: fixed turn overhead + packet size / 4 (see CODEX_TURN_BASE_TOKENS) */
  baseEstimatedTokens?: number;
  wallClockMs?: number;
  /** SIGINT → SIGKILL grace (default 10s) */
  killGraceMs?: number;
  extraEnv?: Record<string, string>;
  onProgress?: (p: { estimatedTokens: number; lastItem: { type: string; preview: string } | null }) => void;
  /** fires as soon as thread.started arrives — used for crash recovery */
  onThread?: (threadId: string) => void;
  /** receives a kill function for external interrupts (human hard-stop) */
  registerKill?: (kill: (reason: InterruptReason) => void) => void;
}

export type InterruptReason = "budget" | "timeout" | "killed";

export interface RunCodexResult {
  status: "completed" | "interrupted" | "failed";
  threadId: string | null;
  usage: Usage | null;
  lastAgentMessage: string | null;
  estimatedTokens: number;
  interruptReason: InterruptReason | null;
  exitCode: number | null;
  errorDetail: string | null;
}

/**
 * Fixed cost of one `codex exec` turn before the model emits anything: the
 * CLI's own system prompt and tooling context. Measured against codex-cli
 * 0.149.0 (a one-word reply reported 15,548 input tokens; small real worker
 * turns land near 33,000 with a packet attached).
 *
 * The streamed item events only reflect OUTPUT, so an estimator built from
 * them alone under-counts by roughly this much on every turn and a budget cap
 * would never fire on short tasks. Seeding the estimate with this constant
 * plus the packet size makes the mid-flight estimate track reality closely
 * enough to enforce a cap; exact usage still reconciles at turn.completed.
 */
export const CODEX_TURN_BASE_TOKENS = 16_000;

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_output_tokens: a.reasoning_output_tokens + b.reasoning_output_tokens,
  };
}

export function buildArgs(opts: RunCodexOptions): string[] {
  const args: string[] = ["exec"];
  if (opts.resumeThreadId) {
    args.push("resume", opts.resumeThreadId);
  }
  args.push("--json", "--ignore-user-config", "--skip-git-repo-check");
  if (!opts.resumeThreadId) {
    args.push("-C", opts.cwd, "-s", opts.sandbox);
  }
  if (opts.model) args.push("-m", opts.model);
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  if (opts.webSearch) args.push("-c", "tools.web_search=true");
  if (opts.isolatedTask) {
    args.push("-c", "project_doc_max_bytes=0", "-c", "agents.enabled=false");
  }
  if (opts.mcp) {
    args.push(
      "-c",
      `mcp_servers.${opts.mcp.serverName}={url="${opts.mcp.url}",bearer_token_env_var="${opts.mcp.tokenEnvVar}"}`,
    );
  }
  if (opts.outputSchemaFile) args.push("--output-schema", opts.outputSchemaFile);
  if (opts.outputLastMessageFile) args.push("--output-last-message", opts.outputLastMessageFile);
  args.push("-");
  return args;
}

function nestedErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    const clean = value.trim();
    if (clean === "") return null;
    try {
      const parsed = JSON.parse(clean) as unknown;
      return nestedErrorMessage(parsed, depth + 1) ?? clean;
    } catch {
      return clean;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return (
    nestedErrorMessage(record["error"], depth + 1) ??
    nestedErrorMessage(record["message"], depth + 1) ??
    null
  );
}

/** Extract the useful API/CLI error carried on Codex's JSONL stdout. */
export function codexEventErrorMessage(event: Record<string, unknown>): string | null {
  if (event["type"] !== "error" && event["type"] !== "turn.failed") return null;
  return (
    nestedErrorMessage(event["error"]) ??
    nestedErrorMessage(event["message"]) ??
    null
  );
}

export function runCodex(opts: RunCodexOptions): Promise<RunCodexResult> {
  mkdirSync(path.dirname(opts.eventsArchiveFile), { recursive: true });
  const archive = createWriteStream(opts.eventsArchiveFile, { flags: "a" });

  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.extraEnv };
    if (opts.mcp) env[opts.mcp.tokenEnvVar] = opts.mcp.token;

    const child = spawn(opts.bin, buildArgs(opts), {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let threadId: string | null = null;
    let usage: Usage | null = null;
    let lastAgentMessage: string | null = null;
    let estimatedTokens = opts.baseEstimatedTokens ?? 0;
    let interruptReason: InterruptReason | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let wallTimer: NodeJS.Timeout | null = null;
    let spawnError: string | null = null;
    let eventError: string | null = null;
    let settled = false;

    const kill = (reason: InterruptReason) => {
      if (interruptReason) return;
      interruptReason = reason;
      child.kill("SIGINT");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, opts.killGraceMs ?? 10_000);
    };

    if (opts.wallClockMs) {
      wallTimer = setTimeout(() => kill("timeout"), opts.wallClockMs);
    }
    opts.registerKill?.(kill);

    const budgetCap = () =>
      typeof opts.maxEstimatedTokens === "function"
        ? opts.maxEstimatedTokens()
        : opts.maxEstimatedTokens;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      archive.write(line + "\n");
      let ev: { type?: string; [k: string]: unknown };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        return; // tolerate non-JSON noise
      }
      const reportedError = codexEventErrorMessage(ev);
      if (reportedError) eventError = reportedError.slice(-4_000);
      if (ev.type === "thread.started" && typeof ev["thread_id"] === "string") {
        threadId = ev["thread_id"];
        opts.onThread?.(threadId);
        return;
      }
      if (typeof ev.type === "string" && ev.type.startsWith("item.")) {
        const item = ev["item"] as { type?: string; text?: string; command?: string } | undefined;
        estimatedTokens += Math.ceil(line.length / 4);
        if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          lastAgentMessage = item.text;
        }
        const preview = (item?.text ?? item?.command ?? "").slice(0, 120);
        opts.onProgress?.({ estimatedTokens, lastItem: item?.type ? { type: item.type, preview } : null });
        const cap = budgetCap();
        if (cap !== undefined && estimatedTokens > cap) {
          kill("budget");
        }
        return;
      }
      if (ev.type === "turn.completed") {
        const parsed = UsageSchema.safeParse({ ...(ZERO_USAGE as object), ...(ev["usage"] as object ?? {}) });
        if (parsed.success) usage = usage ? addUsage(usage, parsed.data) : parsed.data;
        return;
      }
      // turn.failed, unknown types: archived above, otherwise ignored.
    };

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
        handleLine(stdoutBuffer.slice(0, idx));
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
      }
    });

    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split("\n")) {
        if (line.trim()) archive.write(JSON.stringify({ type: "_stderr", text: line }) + "\n");
      }
    });

    child.on("error", (err) => {
      spawnError = String(err);
    });

    child.stdin.on("error", () => {
      /* EPIPE when the child dies before reading the prompt */
    });
    child.stdin.end(opts.prompt);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (wallTimer) clearTimeout(wallTimer);
      if (stdoutBuffer) handleLine(stdoutBuffer);
      archive.end();

      let status: RunCodexResult["status"];
      if (interruptReason) {
        status = "interrupted";
      } else if (code === 0 && usage !== null) {
        status = "completed";
      } else {
        status = "failed";
      }
      resolve({
        status,
        threadId,
        usage,
        lastAgentMessage,
        estimatedTokens,
        interruptReason,
        exitCode: code,
        errorDetail:
          status === "failed"
            ? spawnError ??
              eventError ??
              `exit ${code}${usage === null ? ", no turn.completed" : ""}; stderr tail: ${stderrTail.slice(-500)}`
            : null,
      });
    });
  });
}
