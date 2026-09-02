import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildArgs, codexEventErrorMessage, runCodex } from "../src/codex/runner.js";
import { runStructured } from "../src/codex/structured.js";
import { workerLaunchPrompt } from "../src/prompts/operational.js";

const SIM_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../codex-sim/bin/codex-sim.mjs",
);

const OutSchema = z.object({ hello: z.string() });

const USAGE = {
  input_tokens: 1000,
  cached_input_tokens: 200,
  output_tokens: 300,
  reasoning_output_tokens: 50,
};

interface ScenarioCall {
  match?: Record<string, unknown>;
  threadId?: string;
  behavior?: string;
  stubbornSigint?: boolean;
  exitCode?: number;
  delayMs?: number;
  items?: Record<string, unknown>[];
  finalMessage?: unknown;
  usage?: Record<string, number>;
}

function setup(calls: ScenarioCall[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collq-runner-"));
  const scenario = path.join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ calls }));
  const packet = path.join(dir, "packet");
  writeFileSync(scenario, JSON.stringify({ calls }));
  return {
    dir,
    packet,
    baseOpts: {
      bin: SIM_BIN,
      cwd: dir,
      prompt: workerLaunchPrompt("research-question.md"),
      sandbox: "read-only" as const,
      eventsArchiveFile: path.join(dir, "archive", "codex-events.jsonl"),
      outputLastMessageFile: path.join(dir, "last-message.json"),
      outputSchemaFile: path.join(dir, "output-schema.json"),
      killGraceMs: 300,
      extraEnv: {
        INVENTIO_SIM_SCENARIO: scenario,
        INVENTIO_SIM_STATE_DIR: path.join(dir, "state"),
      },
    },
  };
}

function readLog(dir: string): { taskToken: string | null; index: number }[] {
  const raw = readFileSync(path.join(dir, "state", "calls.log.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { taskToken: string | null; index: number });
}

describe("runCodex", () => {
  it("strictly auto-approves only the attached project MCP tools", () => {
    const { baseOpts } = setup([]);
    const args = buildArgs({
      ...baseOpts,
      mcp: {
        serverName: "memory",
        url: "http://127.0.0.1:4701/mcp",
        tokenEnvVar: "INVENTIO_TASK_TOKEN",
        token: "not-placed-on-argv",
        enabledTools: ["source_list", "source_open"],
      },
    });
    expect(args).toContain("--strict-config");
    expect(args).toContain(
      'mcp_servers.memory={url="http://127.0.0.1:4701/mcp",bearer_token_env_var="INVENTIO_TASK_TOKEN",required=true,default_tools_approval_mode="approve",enabled_tools=["source_list","source_open"]}',
    );
    expect(args.join(" ")).not.toContain("not-placed-on-argv");
  });

  it("uses a packet-only permission profile without the broad legacy sandbox", () => {
    const { baseOpts, packet } = setup([]);
    const args = buildArgs({
      ...baseOpts,
      cwd: packet,
      sandbox: "workspace-write",
      permissionProfile: {
        name: "inventio_verifier",
        filesystem: { ":minimal": "read", [packet]: "write" },
      },
    });
    const joined = args.join(" ");
    expect(args).not.toContain("-s");
    expect(joined).toContain("permissions.inventio_verifier=");
    expect(joined).toContain(JSON.stringify(packet));
    expect(joined).toContain('default_permissions="inventio_verifier"');
  });

  it("extracts structured API failures from the JSONL event stream", () => {
    const nested = JSON.stringify({
      type: "error",
      error: {
        code: "invalid_json_schema",
        message: "Invalid schema: oneOf is not permitted.",
      },
      status: 400,
    });
    expect(codexEventErrorMessage({ type: "error", message: nested })).toBe(
      "Invalid schema: oneOf is not permitted.",
    );
    expect(
      codexEventErrorMessage({
        type: "turn.failed",
        error: { message: nested },
      }),
    ).toBe("Invalid schema: oneOf is not permitted.");
  });

  it("happy path: events parsed, usage captured, archive written", async () => {
    const { dir, baseOpts } = setup([
      {
        threadId: "sim-h1",
        items: [{ type: "reasoning", text: "thinking hard" }],
        finalMessage: { hello: "world" },
        usage: USAGE,
      },
    ]);
    const progress: number[] = [];
    const r = await runCodex({
      ...baseOpts,
      mcp: {
        serverName: "memory",
        url: "http://127.0.0.1:4701/mcp",
        tokenEnvVar: "INVENTIO_TASK_TOKEN",
        token: "tok-123",
        enabledTools: ["memory_search", "memory_expand"],
      },
      onProgress: (p) => progress.push(p.estimatedTokens),
    });
    expect(r.status).toBe("completed");
    expect(r.threadId).toBe("sim-h1");
    expect(r.usage).toEqual(USAGE);
    expect(JSON.parse(r.lastAgentMessage!)).toEqual({ hello: "world" });
    expect(progress.length).toBeGreaterThan(0);
    const archive = readFileSync(baseOpts.eventsArchiveFile, "utf8");
    expect(archive).toContain('"thread.started"');
    expect(archive).toContain('"turn.completed"');
    // the sim saw the bearer token through the environment
    expect(readLog(dir)[0]!.taskToken).toBe("tok-123");
  });

  it("budget estimator kills a hanging process", async () => {
    const { baseOpts } = setup([
      {
        threadId: "sim-b1",
        behavior: "hang",
        items: [{ type: "reasoning", text: "x".repeat(8000) }],
      },
    ]);
    const r = await runCodex({ ...baseOpts, maxEstimatedTokens: 500 });
    expect(r.status).toBe("interrupted");
    expect(r.interruptReason).toBe("budget");
    expect(r.estimatedTokens).toBeGreaterThan(500);
  });

  it("wall clock kills a hanging process", async () => {
    const { baseOpts } = setup([{ threadId: "sim-t1", behavior: "hang" }]);
    const r = await runCodex({ ...baseOpts, wallClockMs: 300 });
    expect(r.status).toBe("interrupted");
    expect(r.interruptReason).toBe("timeout");
  });

  it("escalates to SIGKILL for a stubborn process", async () => {
    const { baseOpts } = setup([
      { threadId: "sim-s1", behavior: "hang", stubbornSigint: true },
    ]);
    const start = Date.now();
    const r = await runCodex({ ...baseOpts, wallClockMs: 200, killGraceMs: 200 });
    expect(r.status).toBe("interrupted");
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);
});

describe("runStructured", () => {
  it("valid output parses against the schema and writes the schema file", async () => {
    const { baseOpts } = setup([
      { threadId: "sim-v1", finalMessage: { hello: "there" }, usage: USAGE },
    ]);
    const r = await runStructured(baseOpts, OutSchema);
    expect(r.status).toBe("completed");
    expect(r.output).toEqual({ hello: "there" });
    const schemaFile = JSON.parse(readFileSync(baseOpts.outputSchemaFile, "utf8")) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schemaFile.properties ?? {})).toContain("hello");
  });

  it("malformed output triggers one repair resume that fixes it", async () => {
    const { baseOpts } = setup([
      { threadId: "sim-m1", finalMessage: { wrong: 1 }, usage: USAGE },
      {
        match: { resumeOf: "sim-m1" },
        finalMessage: { hello: "fixed" },
        usage: USAGE,
      },
    ]);
    const invalid: string[][] = [];
    const r = await runStructured(baseOpts, OutSchema, {
      onInvalidOutput: (e) => invalid.push(e),
    });
    expect(r.status).toBe("completed");
    expect(r.output).toEqual({ hello: "fixed" });
    expect(r.runs.length).toBe(2);
    expect(invalid.length).toBe(1);
    // usage summed across both calls
    expect(r.usage.input_tokens).toBe(2000);
  });

  it("malformed twice fails with validation errors", async () => {
    const { baseOpts } = setup([
      { threadId: "sim-m2", finalMessage: { wrong: 1 }, usage: USAGE },
      { match: { resumeOf: "sim-m2" }, finalMessage: { wrong: 2 }, usage: USAGE },
    ]);
    const r = await runStructured(baseOpts, OutSchema);
    expect(r.status).toBe("failed");
    expect(r.validationErrors).toBeTruthy();
  });

  it("crash mid-stream resumes once and completes", async () => {
    const { baseOpts } = setup([
      { threadId: "sim-c1", behavior: "crash-mid-stream", items: [{ type: "reasoning", text: "…" }] },
      { match: { resumeOf: "sim-c1" }, finalMessage: { hello: "recovered" }, usage: USAGE },
    ]);
    const r = await runStructured(baseOpts, OutSchema);
    expect(r.status).toBe("completed");
    expect(r.output).toEqual({ hello: "recovered" });
  });

  it("failure before a thread exists retries fresh once", async () => {
    const { baseOpts } = setup([
      { behavior: "exit-nonzero", exitCode: 3 },
      { threadId: "sim-f2", finalMessage: { hello: "second" }, usage: USAGE },
    ]);
    const r = await runStructured(baseOpts, OutSchema);
    expect(r.status).toBe("completed");
    expect(r.output).toEqual({ hello: "second" });
    expect(r.runs.length).toBe(2);
  });

  it("interruption is returned as-is for salvage", async () => {
    const { baseOpts } = setup([{ threadId: "sim-i1", behavior: "hang" }]);
    const r = await runStructured({ ...baseOpts, wallClockMs: 250 }, OutSchema);
    expect(r.status).toBe("interrupted");
    expect(r.output).toBeNull();
    expect(r.interruptReason).toBe("timeout");
  });
});
