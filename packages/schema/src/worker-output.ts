import { z } from "zod";
import { CardType, IssueSeverity } from "./events.js";
import type { WorkerRole } from "./config.js";

/**
 * Structured worker returns (DESIGN §8.2). All fields required (empty
 * arrays / "" instead of optionality) to stay friendly to strict
 * structured-output enforcement; `--output-schema` files are generated
 * from these via `workerOutputJsonSchema(role)`.
 */

export const MemoIssue = z.object({
  severity: IssueSeverity,
  location: z.string(),
  summary: z.string(),
  repairHint: z.string(),
});
export type MemoIssue = z.infer<typeof MemoIssue>;

export const MemoClaim = z.object({
  statement: z.string(),
  evidence: z.enum(["proved-in-artifact", "computation", "cited", "unverified"]),
  where: z.string(),
});
export type MemoClaim = z.infer<typeof MemoClaim>;

export const MemoCardProposal = z.object({
  type: CardType,
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(6_000),
  abstract: z.string().min(1).max(480),
  tags: z.array(z.string().min(1).max(40)).max(8),
  provenance: z.string().min(1).max(500),
});
export type MemoCardProposal = z.infer<typeof MemoCardProposal>;

export const MemoComputation = z.object({
  /** entry command relative to scratch/, e.g. "python3 verify_bound.py" */
  entry: z.string(),
  inputs: z.string(),
  outputsDescription: z.string(),
});
export type MemoComputation = z.infer<typeof MemoComputation>;

export const Memo = z.object({
  summary: z.string(),
  newClaims: z.array(MemoClaim),
  issues: z.array(MemoIssue),
  obligations: z.array(z.string()),
  deadEnds: z.array(z.string()),
  proposedCards: z.array(MemoCardProposal),
  computations: z.array(MemoComputation),
  budgetReport: z.string(),
});
export type Memo = z.infer<typeof Memo>;

export const RecallEntry = z.object({
  op: z.enum(["search", "expand"]),
  args: z.string(),
  why: z.string(),
});
export type RecallEntry = z.infer<typeof RecallEntry>;

/** Solver / Explorer / Synthesizer return. */
export const WorkerOutput = z.object({
  conclusion: z.enum(["PROVED", "DISPROVED", "UNCERTAIN"]),
  artifactMarkdown: z.string().min(1),
  memo: Memo,
  recallLog: z.array(RecallEntry),
});
export type WorkerOutput = z.infer<typeof WorkerOutput>;

/** Reviewer return. */
export const ReviewerOutput = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  artifactMarkdown: z.string().min(1),
  memo: Memo,
  recallLog: z.array(RecallEntry),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

export type AnyWorkerOutput = WorkerOutput | ReviewerOutput;

export function workerOutputSchema(role: WorkerRole): z.ZodType<AnyWorkerOutput> {
  return role === "reviewer" ? ReviewerOutput : WorkerOutput;
}

/** JSON Schema (draft 2020-12) for `codex exec --output-schema`. */
export function workerOutputJsonSchema(role: WorkerRole): Record<string, unknown> {
  return z.toJSONSchema(workerOutputSchema(role) as z.ZodType) as Record<string, unknown>;
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
