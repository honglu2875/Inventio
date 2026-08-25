import type { Memo, WorkerRole } from "@inventio/schema";

/**
 * Mechanical docket builder (DESIGN §6.6): a pure function over the wave's
 * validated memos and task outcomes. No model call, no interpretation.
 * Claims are author-neutral by role; task IDs appear only in the outcomes
 * section (needed for cross-examination targeting).
 */

export interface TaskOutcome {
  taskId: string;
  role: WorkerRole;
  methodTag: string;
  status: "completed" | "interrupted" | "failed";
  /** conclusion (workers) or verdict (reviewers); null if unavailable */
  headline: string | null;
  memo: Memo | null;
  interruptReason: string | null;
  error: string | null;
  /** head of salvaged partial work for interrupted tasks with no valid memo */
  salvageExcerpt?: string;
}

export function buildDocket(waveId: string, title: string, outcomes: TaskOutcome[]): string {
  const lines: string[] = [`# Findings from research round ${waveId}: ${title}`, ""];

  // New claims, deduplicated by normalized statement.
  const seen = new Map<string, { statement: string; evidence: string; roles: Set<string> }>();
  for (const o of outcomes) {
    for (const c of o.memo?.newClaims ?? []) {
      const key = normalize(c.statement);
      const existing = seen.get(key);
      if (existing) {
        existing.roles.add(o.role);
        if (rank(c.evidence) > rank(existing.evidence)) existing.evidence = c.evidence;
      } else {
        seen.set(key, { statement: c.statement, evidence: c.evidence, roles: new Set([o.role]) });
      }
    }
  }
  lines.push("## New claims");
  if (seen.size === 0) lines.push("(none)");
  for (const c of seen.values()) {
    lines.push(`- ${c.statement} — support: ${evidenceLabel(c.evidence)}; reported by ${[...c.roles].map(article).join(", ")}`);
  }
  lines.push("");

  // Issues raised (reviewer memos).
  lines.push("## Referee concerns");
  const issues = outcomes.flatMap((o) => (o.memo?.issues ?? []).map((i) => ({ ...i, role: o.role })));
  if (issues.length === 0) lines.push("(none)");
  for (const i of issues) {
    lines.push(`- [${i.severity}] at ${i.location}: ${i.summary} — smallest repair: ${i.repairHint || "(none given)"}`);
  }
  lines.push("");

  // Obstructions and dead ends.
  lines.push("## Obstructions and dead ends");
  const deadEnds = dedupe(outcomes.flatMap((o) => o.memo?.deadEnds ?? []));
  if (deadEnds.length === 0) lines.push("(none)");
  for (const d of deadEnds) lines.push(`- ${d}`);
  lines.push("");

  // Open obligations.
  lines.push("## Remaining mathematical obligations");
  const obligations = dedupe(outcomes.flatMap((o) => o.memo?.obligations ?? []));
  if (obligations.length === 0) lines.push("(none)");
  for (const ob of obligations) lines.push(`- ${ob}`);
  lines.push("");

  // Computations.
  const comps = outcomes.flatMap((o) =>
    (o.memo?.computations ?? []).map((c) => ({ ...c, taskId: o.taskId })),
  );
  if (comps.length > 0) {
    lines.push("## Computations");
    for (const c of comps) {
      lines.push(`- ${c.taskId}: \`${c.entry}\` — ${c.outputsDescription}`);
    }
    lines.push("");
  }

  // Task outcomes (operational; IDs are for cross-examination targeting).
  lines.push("## Assignment reports");
  for (const o of outcomes) {
    const state =
      o.status === "completed"
        ? o.headline ?? "completed"
        : o.status === "interrupted"
          ? `INTERRUPTED (${o.interruptReason ?? "unknown"}) — partial results only`
          : `FAILED (${truncate(o.error ?? "unknown", 120)})`;
    const summary = o.memo?.summary ? ` — ${truncate(o.memo.summary, 240)}` : "";
    lines.push(`- ${o.taskId} (${article(o.role)}, ${o.methodTag}): ${state}${summary}`);
    if (o.memo?.budgetReport) lines.push(`  - use of allocation: ${truncate(o.memo.budgetReport, 160)}`);
    if (o.salvageExcerpt) {
      lines.push(`  - partial notes preserved after the assignment stopped (not checked): ${truncate(o.salvageExcerpt.replace(/\s+/g, " "), 600)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = normalize(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function rank(evidence: string): number {
  switch (evidence) {
    case "proved-in-artifact":
      return 3;
    case "computation":
      return 2;
    case "cited":
      return 1;
    default:
      return 0;
  }
}

function evidenceLabel(evidence: string): string {
  switch (evidence) {
    case "proved-in-artifact":
      return "proved in the write-up";
    case "computation":
      return "computation";
    case "cited":
      return "cited source";
    default:
      return "UNVERIFIED";
  }
}

function article(role: string): string {
  return `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
