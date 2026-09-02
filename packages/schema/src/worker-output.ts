import { z } from "zod";
import {
  CardType,
  ClaimRelation,
  IssueSeverity,
  VerificationFinding,
} from "./events.js";
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

/** One high-value result handed from a long trajectory to later researchers. */
export const TrajectoryClaim = z.object({
  title: z.string().min(1).max(160),
  statementMarkdown: z.string().min(1),
  proofMarkdown: z.string().min(1),
  relationToGoal: ClaimRelation,
});
export type TrajectoryClaim = z.infer<typeof TrajectoryClaim>;

export interface TrajectoryClaimPreparationProblem {
  field: "statementMarkdown" | "proofMarkdown";
  message: string;
}

function proseWithoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

/**
 * Count LaTeX-style math delimiters without mistaking a TeX row break for
 * one.  The delimiter slash is active exactly when it ends an odd-length run
 * of backslashes: `\\(` opens math, while `\\\\(` is a row break followed by
 * an ordinary parenthesis (as in `\\substack{a\\\\(a,b)\\ne0}`).
 */
function countTexDelimiter(source: string, delimiter: "(" | ")" | "[" | "]"): number {
  let count = 0;
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] !== delimiter || source[index - 1] !== "\\") continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) count += 1;
  }
  return count;
}

function mathDelimiterProblems(text: string): string[] {
  const source = proseWithoutCode(text);
  let inline = 0;
  let display = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "$" || source[index - 1] === "\\") continue;
    if (source[index + 1] === "$") {
      display += 1;
      index += 1;
    } else {
      inline += 1;
    }
  }
  const problems: string[] = [];
  if (inline % 2 !== 0) problems.push("has an unmatched inline $ delimiter");
  if (display % 2 !== 0) problems.push("has an unmatched $$ delimiter");

  const paired = [
    ["(", ")", "\\( ... \\)"],
    ["[", "]", "\\[ ... \\]"],
  ] as const;
  for (const [open, close, label] of paired) {
    const opens = countTexDelimiter(source, open);
    const closes = countTexDelimiter(source, close);
    if (opens !== closes) problems.push(`has unmatched ${label} delimiters`);
  }

  const environments: string[] = [];
  for (const match of source.matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
    const [, kind, name] = match;
    if (kind === "begin") environments.push(name!);
    else if (environments.pop() !== name) {
      problems.push(`has an unmatched \\end{${name}}`);
      break;
    }
  }
  if (environments.length > 0) {
    problems.push(`has an unmatched \\begin{${environments.at(-1)}}`);
  }
  return problems;
}

/**
 * Objective preparation checks only. These catch damaged or non-standalone
 * handoffs without judging the mathematical idea, proof strategy, or result.
 */
export function trajectoryClaimPreparationProblems(
  claim: Pick<TrajectoryClaim, "statementMarkdown" | "proofMarkdown">,
): TrajectoryClaimPreparationProblem[] {
  const problems: TrajectoryClaimPreparationProblem[] = [];
  for (const field of ["statementMarkdown", "proofMarkdown"] as const) {
    const text = claim[field];
    if (text.trim() === "") {
      problems.push({ field, message: "must contain non-whitespace mathematics" });
      continue;
    }
    if (/[\u0000-\u0009\u000B-\u001F\u007F-\u009F�]/u.test(text)) {
      problems.push({
        field,
        message: "contains a control, tab, or replacement character; rewrite it with intact TeX",
      });
    }
    for (const message of mathDelimiterProblems(text)) problems.push({ field, message });
  }

  const standalone = `${claim.statementMarkdown}\n${claim.proofMarkdown}`;
  if (/\b(?:T|A|E|K|F)\d{3,}\b/.test(standalone)) {
    problems.push({
      field: "proofMarkdown",
      message: "uses an internal project ID; restate the needed mathematics so the claim stands alone",
    });
  }
  const deictic = [
    /\b(?:as|by)\s+(?:shown|proved|computed|defined|explained)\s+(?:above|below|earlier|previously)\b/i,
    /\b(?:see|refer to)\s+(?:the\s+)?(?:write-?up|analysis|discussion|argument)\b/i,
    /\b(?:proof|details?|calculation)\s+(?:is|are)\s+(?:omitted|above|in the write-?up)\b/i,
    /\b(?:left|leave)\s+to\s+the\s+reader\b/i,
    /\b(?:TODO|TBD|FIXME)\b/,
  ];
  if (deictic.some((pattern) => pattern.test(standalone))) {
    problems.push({
      field: "proofMarkdown",
      message: "refers to omitted or surrounding work; include the needed argument in this claim",
    });
  }
  return problems;
}

/**
 * The small structured tail of a long Solver or Explorer session. The full
 * trajectory remains in Codex's event archive; writeupMarkdown is the readable
 * mathematical handoff, while claims are the only entries sent to verification.
 */
export const TrajectoryOutput = z.object({
  conclusion: z.enum(["PROVED", "DISPROVED", "UNCERTAIN"]),
  summaryMarkdown: z.string().min(1).max(4_000),
  writeupMarkdown: z.string().min(1),
  claims: z.array(TrajectoryClaim).max(8),
}).superRefine((output, context) => {
  output.claims.forEach((claim, index) => {
    for (const problem of trajectoryClaimPreparationProblems(claim)) {
      context.addIssue({
        code: "custom",
        path: ["claims", index, problem.field],
        message: problem.message,
      });
    }
  });
});
export type TrajectoryOutput = z.infer<typeof TrajectoryOutput>;

/** Independent assessment of exactly one self-contained claim. */
export const VerificationOutput = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  finding: VerificationFinding,
  summaryMarkdown: z.string().min(1).max(2_000),
  reportMarkdown: z.string().min(1),
}).superRefine((output, context) => {
  if (output.verdict === "PASS" && output.finding !== "NONE") {
    context.addIssue({ code: "custom", path: ["finding"], message: "PASS requires NONE" });
  }
  if (output.verdict === "FAIL" && output.finding === "NONE") {
    context.addIssue({ code: "custom", path: ["finding"], message: "FAIL requires a specific finding" });
  }
});
export type VerificationOutput = z.infer<typeof VerificationOutput>;

/** One narrow comparison of statements before independent proof checking. */
export const ClaimComparisonOutput = z.object({
  equivalentClaimGroups: z.array(z.array(z.string()).min(2)).max(20),
});
export type ClaimComparisonOutput = z.infer<typeof ClaimComparisonOutput>;

/** A deliberately small editorial reconsideration after one research round. */
export const SummaryRevisionOutput = z.object({
  changed: z.boolean(),
  // Runtime validation enforces the 480-character publication limit. Keeping
  // a wider transport field prevents strict decoding from silently chopping
  // the last word at exactly that boundary.
  abstract: z.string().min(1).max(800),
  markdown: z.string().min(1),
  reason: z.string().max(1_000),
});
export type SummaryRevisionOutput = z.infer<typeof SummaryRevisionOutput>;

export function workerOutputSchema(role: WorkerRole): z.ZodType<AnyWorkerOutput> {
  return role === "reviewer" ? ReviewerOutput : WorkerOutput;
}

/** JSON Schema (draft 2020-12) for `codex exec --output-schema`. */
export function workerOutputJsonSchema(role: WorkerRole): Record<string, unknown> {
  return z.toJSONSchema(workerOutputSchema(role) as z.ZodType) as Record<string, unknown>;
}

export function trajectoryOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TrajectoryOutput) as Record<string, unknown>;
}

export function verificationOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(VerificationOutput) as Record<string, unknown>;
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
