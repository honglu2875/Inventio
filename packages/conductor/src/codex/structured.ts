import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { Usage } from "@inventio/schema";
import { toJsonSchema } from "@inventio/schema";
import {
  addUsage,
  runCodex,
  ZERO_USAGE,
  type RunCodexOptions,
  type RunCodexResult,
} from "./runner.js";
import { parseModelJson } from "./modelJson.js";
import {
  PROCESS_FAILURE_RESUME_PROMPT,
  structuredOutputRepairPrompt,
} from "../prompts/operational.js";

/**
 * Structured execution with the DESIGN §14 retry policy:
 *  - process failed before a thread existed → one fresh retry;
 *  - process failed mid-thread → one resume asking it to finish;
 *  - completed but output invalid → one resume carrying the zod errors;
 *  - interrupted (budget/timeout/kill) → returned as-is for salvage.
 */

export interface StructuredRunResult<T> {
  status: "completed" | "interrupted" | "failed";
  output: T | null;
  threadId: string | null;
  usage: Usage;
  estimatedTokens: number;
  interruptReason: string | null;
  lastAgentMessage: string | null;
  validationErrors: string[] | null;
  errorDetail: string | null;
  runs: RunCodexResult[];
}

export interface StructuredExtras {
  /** called when a completed run produced schema-invalid output (before the repair resume) */
  onInvalidOutput?: (errors: string[]) => void;
}

export async function runStructured<T>(
  opts: RunCodexOptions,
  schema: z.ZodType<T>,
  extras: StructuredExtras = {},
): Promise<StructuredRunResult<T>> {
  if (opts.outputSchemaFile) {
    mkdirSync(path.dirname(opts.outputSchemaFile), { recursive: true });
    writeFileSync(opts.outputSchemaFile, JSON.stringify(toJsonSchema(schema as z.ZodType), null, 2));
  }

  const runs: RunCodexResult[] = [];
  let totalUsage: Usage = ZERO_USAGE;
  let estimatedTokens = 0;

  const doRun = async (o: RunCodexOptions): Promise<RunCodexResult> => {
    const r = await runCodex(o);
    runs.push(r);
    if (r.usage) totalUsage = addUsage(totalUsage, r.usage);
    estimatedTokens = Math.max(estimatedTokens, r.estimatedTokens);
    return r;
  };

  let attempt = await doRun(opts);

  // Crash policy.
  if (attempt.status === "failed") {
    if (attempt.threadId === null) {
      attempt = await doRun(opts); // fresh retry
    } else {
      attempt = await doRun({
        ...opts,
        resumeThreadId: attempt.threadId,
        prompt: PROCESS_FAILURE_RESUME_PROMPT,
      });
    }
  }

  const finish = (
    status: StructuredRunResult<T>["status"],
    output: T | null,
    validationErrors: string[] | null,
  ): StructuredRunResult<T> => ({
    status,
    output,
    threadId: runs.find((r) => r.threadId)?.threadId ?? null,
    usage: totalUsage,
    estimatedTokens,
    interruptReason: attempt.interruptReason,
    lastAgentMessage: attempt.lastAgentMessage,
    validationErrors,
    errorDetail: attempt.errorDetail,
    runs,
  });

  if (attempt.status !== "completed") {
    return finish(attempt.status, null, null);
  }

  // Validation with one repair round-trip.
  let parsed = parseOutput(opts, attempt, schema);
  if (!parsed.ok) {
    extras.onInvalidOutput?.(parsed.errors);
    if (attempt.threadId) {
      attempt = await doRun({
        ...opts,
        resumeThreadId: attempt.threadId,
        prompt: structuredOutputRepairPrompt(parsed.errors),
      });
      if (attempt.status === "completed") {
        parsed = parseOutput(opts, attempt, schema);
        if (parsed.ok) return finish("completed", parsed.value, null);
      }
      return finish("failed", null, parsed.ok ? null : parsed.errors);
    }
    return finish("failed", null, parsed.errors);
  }
  return finish("completed", parsed.value, null);
}

function parseOutput<T>(
  opts: RunCodexOptions,
  run: RunCodexResult,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; errors: string[] } {
  let text: string | null = null;
  if (opts.outputLastMessageFile && existsSync(opts.outputLastMessageFile)) {
    text = readFileSync(opts.outputLastMessageFile, "utf8");
  }
  if (text === null || text === "") text = run.lastAgentMessage;
  if (text === null || text === "") return { ok: false, errors: ["no final message produced"] };

  let json: unknown;
  try {
    json = parseModelJson(stripFences(text));
  } catch (err) {
    return { ok: false, errors: [`final message is not valid JSON: ${String(err).slice(0, 200)}`] };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, value: result.data };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return m ? m[1]! : trimmed;
}
