import { z } from "zod";
import { ModelChoice } from "./config.js";
import { VerificationEvidenceDeclaration } from "./verification-evidence.js";

export const ResearchRole = z.enum(["solver", "explorer", "verifier", "auditor", "editor", "writer"]);
export type ResearchRole = z.infer<typeof ResearchRole>;
export const ContentKind = z.enum(["PROPOSITION", "CALCULATION", "CONJECTURE", "NOTE"]);
export const CheckingStatus = z.enum(["UNCHECKED", "CHECKED", "AUDITED", "NEEDS_REVISION", "DISPUTED", "RETRACTED"]);
export type CheckingStatus = z.infer<typeof CheckingStatus>;
const ref = z.string().regex(/^B\d{3,}\.v[1-9]\d*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(200_000);
const relation = z.enum(["PROVES", "DISPROVES", "PARTIAL", "RELATED"]);
export const ResultSubmission = z.object({
  resultId: z.string().regex(/^B\d{3,}$/).nullable(),
  parentVersionId: ref.nullable(),
  kind: ContentKind,
  title: z.string().trim().min(1).max(200),
  statement: text,
  proofMarkdown: z.string().max(200_000),
  relationToGoal: relation,
  dependencies: z.array(ref).max(100),
  sourceIds: z.array(z.string().min(1).max(200)).max(100),
  attachmentPaths: z.array(z.string().min(1).max(300)).max(32),
});
export type ResultSubmission = z.infer<typeof ResultSubmission>;
export const AuthorResponse = z.object({
  versionId: ref,
  action: z.enum(["REVISE", "WITHDRAW", "DEFEND", "UNRESOLVED"]),
  reasonMarkdown: text,
  objectionIds: z.array(z.string()).min(1).max(100),
  replacementIndex: z.number().int().nonnegative().nullable(),
});
/** The same envelope is retained during an author's research and repair turns. */
export const ResearchAuthorOutput = z.object({
  writeupMarkdown: text,
  results: z.array(ResultSubmission).max(24),
  responses: z.array(AuthorResponse).max(24),
  questions: z.array(z.object({ text: z.string().min(1).max(1000), context: text })).max(3),
});
export type ResearchAuthorOutput = z.infer<typeof ResearchAuthorOutput>;
export const Assessment = z.object({
  versionId: ref,
  hash,
  verdict: z.enum(["CONFIRM", "QUARANTINE", "DOWNGRADE", "RETRACT", "UNABLE"]),
  finding: z.enum(["NONE", "MATHEMATICAL_ERROR", "PROOF_GAP", "MISSING_SOURCE", "SCOPE", "OPERATIONAL"]),
  reasonMarkdown: text,
  scopeSupported: z.boolean(),
  evidence: VerificationEvidenceDeclaration,
});
export type Assessment = z.infer<typeof Assessment>;
export const ResearchCheckOutput = z.object({ assessment: Assessment });
export const ResearchAuditOutput = z.object({ assessments: z.array(Assessment).max(500) });
export const ResearchEditorialOutput = z.object({
  summaryMarkdown: text,
  briefMarkdown: z.string().min(1).max(12_000),
  referencedVersions: z.array(ref).max(500),
});
export const ResearchFinalOutput = z.object({ reportMarkdown: text, referencedVersions: z.array(ref).max(500) });

export const FrozenResult = ResultSubmission.omit({ resultId: true, parentVersionId: true, attachmentPaths: true }).extend({
  id: ref, resultId: z.string(), version: z.number().int().positive(), parentVersionId: ref.nullable(),
  sessionId: z.string(), roundId: z.string(), hash,
  attachments: z.array(z.object({ name: z.string(), hash, content: z.string().max(200_000) })).max(32),
});
export type FrozenResult = z.infer<typeof FrozenResult>;
const usage = z.object({
  input_tokens: z.number().int().nonnegative(), cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(), reasoning_output_tokens: z.number().int().nonnegative(),
});
const target = z.object({ versionId: ref, hash });
export const ResearchChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("round.opened"), id: z.string(), number: z.number().int().positive(), briefMarkdown: z.string(), researchModel: ModelChoice, supportModel: ModelChoice }),
  z.object({ kind: z.literal("round.sealed"), id: z.string() }),
  z.object({ kind: z.literal("round.closed"), id: z.string() }),
  z.object({ kind: z.literal("session.opened"), id: z.string(), roundId: z.string(), role: ResearchRole, model: ModelChoice }),
  z.object({ kind: z.literal("session.thread"), id: z.string(), threadId: z.string() }),
  z.object({ kind: z.literal("turn.opened"), id: z.string(), sessionId: z.string(), roundId: z.string(), purpose: z.enum(["research", "repair", "check", "audit", "editorial", "final"]), targets: z.array(target), objectionIds: z.array(z.string()), budgetTokens: z.number().int().nonnegative(), resumeThreadId: z.string().nullable() }),
  z.object({ kind: z.literal("turn.progress"), id: z.string(), estimatedTokens: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("turn.completed"), id: z.string(), status: z.enum(["completed", "interrupted", "failed"]), usage: usage.nullable(), chargedTokens: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), error: z.string().nullable(), outputPath: z.string().nullable() }),
  z.object({ kind: z.literal("result.recorded"), result: FrozenResult }),
  z.object({ kind: z.literal("note.recorded"), id: z.string(), sessionId: z.string(), roundId: z.string(), name: z.string(), hash, markdown: text }),
  z.object({ kind: z.literal("response.recorded"), id: z.string(), turnId: z.string(), sessionId: z.string(), roundId: z.string(), response: AuthorResponse, replacementVersionId: ref.nullable() }),
  z.object({ kind: z.literal("assessment.recorded"), id: z.string(), turnId: z.string(), sessionId: z.string(), roundId: z.string(), mode: z.enum(["check", "audit"]), assessment: Assessment, evidencePath: z.string(), evidenceValid: z.boolean(), evidenceIssues: z.array(z.string()) }),
  z.object({ kind: z.literal("audit.targets"), roundId: z.string(), sessionId: z.string(), targets: z.array(target), sealed: z.boolean() }),
  z.object({ kind: z.literal("editorial.recorded"), roundId: z.string(), summaryMarkdown: text, briefMarkdown: text, referencedVersions: z.array(ref), fallback: z.boolean() }),
  z.object({ kind: z.literal("final.fixed"), result: z.enum(["PROVED", "DISPROVED", "UNCERTAIN"]), reason: text, roundId: z.string(), eligibleVersions: z.array(ref), auditComplete: z.boolean() }),
  z.object({ kind: z.literal("final.written"), markdown: text, referencedVersions: z.array(ref), fallback: z.boolean() }),
]);
export type ResearchChange = z.infer<typeof ResearchChange>;
type Change<K extends ResearchChange["kind"]> = Extract<ResearchChange, { kind: K }>;
export interface ResearchRound extends Change<"round.opened"> {
  status: "open" | "sealed" | "closed";
  sessionIds: string[];
  audit: { sessionId: string; targets: z.infer<typeof target>[]; sealed: boolean } | null;
  editorial: Change<"editorial.recorded"> | null;
}
export interface ResearchSession extends Change<"session.opened"> { threadId: string | null; turnIds: string[] }
export interface ResearchTurn extends Change<"turn.opened"> {
  status: "running" | "completed" | "interrupted" | "failed";
  estimatedTokens: number;
  completed: Change<"turn.completed"> | null;
}
export interface ResearchState {
  rounds: Record<string, ResearchRound>;
  roundOrder: string[];
  sessions: Record<string, ResearchSession>;
  turns: Record<string, ResearchTurn>;
  versions: Record<string, FrozenResult>;
  versionOrder: string[];
  notes: Record<string, Change<"note.recorded">>;
  responses: Change<"response.recorded">[];
  assessments: Change<"assessment.recorded">[];
  continuedAfterRound: number;
  final: (Change<"final.fixed"> & { writing: Change<"final.written"> | null }) | null;
}
export function initialResearchState(): ResearchState {
  return { rounds: {}, roundOrder: [], sessions: {}, turns: {}, versions: {}, versionOrder: [], notes: {}, responses: [], assessments: [], continuedAfterRound: 0, final: null };
}
const need = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`Missing ${label}`);
  return value;
};

/** All mathematical changes are version-bound; there is no promoted fact copy. */
export function applyResearchChange(s: ResearchState, c: ResearchChange): void {
  switch (c.kind) {
    case "round.opened":
      if (s.rounds[c.id] || c.number !== s.roundOrder.length + 1) throw new Error("Invalid round identity");
      if (s.roundOrder.some(id => s.rounds[id]!.status !== "closed")) throw new Error("Previous round is still open");
      s.rounds[c.id] = { ...c, status: "open", sessionIds: [], audit: null, editorial: null };
      s.roundOrder.push(c.id); s.final = null; return;
    case "round.sealed": {
      const round = need(s.rounds[c.id], "round");
      if (round.status !== "open" || Object.values(s.turns).some(t => t.roundId === c.id && t.status === "running")) throw new Error("Cannot seal an active round");
      round.status = "sealed"; return;
    }
    case "round.closed": {
      const round = need(s.rounds[c.id], "round");
      if (round.status !== "sealed" || !round.editorial) throw new Error("Round must be sealed and summarized");
      if (Object.values(s.turns).some(t => t.roundId === c.id && t.status === "running")) throw new Error("Round still has an active turn");
      round.status = "closed"; return;
    }
    case "session.opened": {
      const round = need(s.rounds[c.roundId], "round");
      if (s.sessions[c.id]) throw new Error("Duplicate session");
      if (["solver", "explorer", "auditor"].includes(c.role) && round.sessionIds.some(id => s.sessions[id]!.role === c.role)) throw new Error("Only one session per research role per round");
      s.sessions[c.id] = { ...c, threadId: null, turnIds: [] }; round.sessionIds.push(c.id); return;
    }
    case "session.thread": need(s.sessions[c.id], "session").threadId = c.threadId; return;
    case "turn.opened": {
      const session = need(s.sessions[c.sessionId], "session");
      if (s.turns[c.id] || session.turnIds.some(id => s.turns[id]!.status === "running")) throw new Error("Session already advancing");
      for (const t of c.targets) if (need(s.versions[t.versionId], "target").hash !== t.hash) throw new Error("Target hash changed");
      s.turns[c.id] = { ...c, status: "running", estimatedTokens: 0, completed: null }; session.turnIds.push(c.id); return;
    }
    case "turn.progress": need(s.turns[c.id], "turn").estimatedTokens = c.estimatedTokens; return;
    case "turn.completed": {
      const turn = need(s.turns[c.id], "turn");
      if (turn.completed) throw new Error("Turn already accounted");
      turn.status = c.status; turn.completed = c; return;
    }
    case "result.recorded": {
      const v = c.result;
      const session = need(s.sessions[v.sessionId], "author session");
      if (session.role !== "solver" && session.role !== "explorer") throw new Error("Only researchers author results");
      if (need(s.rounds[v.roundId], "result round").status !== "open") throw new Error("Mathematical record is sealed");
      if (s.versions[v.id]) throw new Error("Immutable version already exists");
      if (v.id !== `${v.resultId}.v${v.version}`) throw new Error("Invalid version identity");
      const previous = s.versionOrder.filter(id => s.versions[id]!.resultId === v.resultId);
      if (v.version !== previous.length + 1) throw new Error("Nonsequential result version");
      if (v.parentVersionId) {
        const parent = need(s.versions[v.parentVersionId], "parent version");
        if (parent.resultId !== v.resultId || parent.sessionId !== v.sessionId) throw new Error("Cannot revise another author's result");
      } else if (previous.length) throw new Error("Revision requires a parent");
      if ((v.kind === "PROPOSITION" || v.kind === "CALCULATION") && !v.proofMarkdown.trim()) throw new Error("Checkable result requires a derivation");
      for (const id of v.dependencies) {
        const dependency = need(s.versions[id], "dependency");
        if (dependency.kind !== "PROPOSITION" && dependency.kind !== "CALCULATION") throw new Error("A note or conjecture is not an established premise");
      }
      s.versions[v.id] = v; s.versionOrder.push(v.id); return;
    }
    case "note.recorded":
      need(s.sessions[c.sessionId], "note author");
      if (s.notes[c.id]) throw new Error("Note snapshots are immutable");
      s.notes[c.id] = c; return;
    case "response.recorded": {
      const version = need(s.versions[c.response.versionId], "response version");
      const turn = need(s.turns[c.turnId], "response turn");
      if (version.sessionId !== c.sessionId || turn.sessionId !== c.sessionId || turn.purpose !== "repair") throw new Error("Response must come from originating session");
      if (!c.response.objectionIds.every(id => turn.objectionIds.includes(id))) throw new Error("Response names an unrelated objection");
      if (c.response.action === "REVISE" && !c.replacementVersionId) throw new Error("Revision must identify its replacement");
      if (c.replacementVersionId) {
        const replacement = need(s.versions[c.replacementVersionId], "replacement");
        if (replacement.parentVersionId !== version.id) throw new Error("Replacement does not revise the target");
      }
      if (s.responses.some(r => r.id === c.id)) throw new Error("Duplicate response");
      s.responses.push(c); return;
    }
    case "assessment.recorded": {
      const version = need(s.versions[c.assessment.versionId], "assessment version");
      const session = need(s.sessions[c.sessionId], "checking session");
      const turn = need(s.turns[c.turnId], "checking turn");
      if (session.role !== (c.mode === "audit" ? "auditor" : "verifier") || version.sessionId === c.sessionId) throw new Error("Assessment is not independent");
      if (turn.sessionId !== c.sessionId || !turn.targets.some(t => t.versionId === version.id && t.hash === c.assessment.hash) || version.hash !== c.assessment.hash) throw new Error("Assessment target mismatch");
      if (c.assessment.verdict === "CONFIRM" && (c.assessment.finding !== "NONE" || !c.assessment.scopeSupported || !c.evidenceValid)) throw new Error("Unsupported confirmation");
      if (c.assessment.verdict !== "CONFIRM" && c.assessment.finding === "NONE") throw new Error("Objection requires a concrete finding");
      if (c.mode === "check" && c.assessment.verdict === "RETRACT") throw new Error("Routine checking cannot retract memory");
      if (s.assessments.some(a => a.id === c.id || (a.turnId === c.turnId && a.assessment.versionId === version.id))) throw new Error("Duplicate assessment");
      s.assessments.push(c); return;
    }
    case "audit.targets": {
      const round = need(s.rounds[c.roundId], "audit round");
      const session = need(s.sessions[c.sessionId], "audit session");
      if (session.role !== "auditor" || session.roundId !== c.roundId) throw new Error("Wrong auditor");
      if (round.audit?.sealed) throw new Error("Audit target set is sealed");
      for (const t of c.targets) if (need(s.versions[t.versionId], "audit target").hash !== t.hash) throw new Error("Audit hash mismatch");
      const targets = new Map((round.audit?.targets ?? []).map(t => [t.versionId, t]));
      c.targets.forEach(t => targets.set(t.versionId, t));
      round.audit = { sessionId: c.sessionId, targets: [...targets.values()], sealed: c.sealed }; return;
    }
    case "editorial.recorded": {
      const round = need(s.rounds[c.roundId], "editorial round");
      if (round.status !== "sealed") throw new Error("Editorial record must be sealed");
      c.referencedVersions.forEach(id => need(s.versions[id], "editorial source"));
      round.editorial = c; return;
    }
    case "final.fixed":
      if (c.result !== "UNCERTAIN" && (!c.auditComplete || !auditCoverage(s, c.roundId).complete || !c.eligibleVersions.some(id => resultStatus(s, id, c.roundId) === "AUDITED" && s.versions[id]!.relationToGoal === (c.result === "PROVED" ? "PROVES" : "DISPROVES")))) throw new Error("Decisive result requires complete independent audit");
      if (c.result !== "UNCERTAIN") {
        const opposite = c.result === "PROVED" ? "DISPROVES" : "PROVES";
        if (s.versionOrder.some(id => s.versions[id]!.relationToGoal === opposite && ["PROPOSITION", "CALCULATION"].includes(s.versions[id]!.kind) && resultStatus(s, id, c.roundId) !== "RETRACTED")) throw new Error("Unresolved opposing conclusion");
      }
      if (s.final) throw new Error("Outcome is already fixed");
      s.final = { ...c, writing: null }; return;
    case "final.written": {
      const final = need(s.final, "fixed outcome");
      if (!c.referencedVersions.every(id => s.versions[id])) throw new Error("Unknown final source");
      final.writing = c; return;
    }
  }
}

/** Qualifications propagate through exact premises, never through a summary. */
export function resultStatus(s: ResearchState, id: string, auditRoundId?: string): CheckingStatus {
  const visiting = new Set<string>();
  const visit = (key: string): CheckingStatus => {
    const v = s.versions[key];
    if (!v || visiting.has(key)) return "NEEDS_REVISION";
    if (v.kind === "CONJECTURE" || v.kind === "NOTE") return "UNCHECKED";
    if (s.responses.some(r => r.response.versionId === key && r.response.action === "WITHDRAW")) return "RETRACTED";
    const checks = s.assessments.filter(a => a.assessment.versionId === key && a.assessment.verdict !== "UNABLE");
    const lastAudit = checks.filter(a => a.mode === "audit").at(-1);
    const last = lastAudit ?? checks.at(-1);
    if (!last) return "UNCHECKED";
    const verdict = last.assessment.verdict;
    if (verdict === "RETRACT") return "RETRACTED";
    if (verdict === "QUARANTINE") return "DISPUTED";
    if (verdict === "DOWNGRADE") return "NEEDS_REVISION";
    // A newer routine objection cannot silently disappear behind an old audit.
    const afterAudit = lastAudit ? checks.slice(checks.indexOf(lastAudit) + 1) : [];
    if (afterAudit.some(a => a.assessment.verdict !== "CONFIRM")) return "DISPUTED";
    visiting.add(key);
    const dependencies = v.dependencies.map(visit);
    visiting.delete(key);
    if (dependencies.some(status => status !== "CHECKED" && status !== "AUDITED")) return "NEEDS_REVISION";
    const audited = last.mode === "audit" && (!auditRoundId || last.roundId === auditRoundId);
    return audited && dependencies.every(status => status === "AUDITED") ? "AUDITED" : "CHECKED";
  };
  return visit(id);
}
export function auditCoverage(s: ResearchState, roundId: string): { total: number; assessed: number; challenged: number; complete: boolean; remaining: string[] } {
  const audit = s.rounds[roundId]?.audit;
  const targets = audit?.targets ?? [];
  const remaining = targets.filter(t => !s.assessments.some(a => a.mode === "audit" && a.roundId === roundId && a.assessment.versionId === t.versionId && a.assessment.hash === t.hash && a.assessment.verdict !== "UNABLE"));
  const challenged = targets.filter(t => s.assessments.filter(a => a.mode === "audit" && a.roundId === roundId && a.assessment.versionId === t.versionId).at(-1)?.assessment.verdict !== "CONFIRM").length - remaining.length;
  return { total: targets.length, assessed: targets.length - remaining.length, challenged: Math.max(0, challenged), complete: audit?.sealed === true && remaining.length === 0, remaining: remaining.map(t => t.versionId) };
}
/** Author/model identities and previous verdicts are deliberately absent. */
export function resultMathematics(v: FrozenResult): string {
  return [`# ${v.id}: ${v.title}`, `Content: ${v.kind}; scope relative to the original problem: ${v.relationToGoal}`, "## Statement", v.statement, "## Derivation", v.proofMarkdown, `Dependencies: ${v.dependencies.join(", ") || "none"}`, `Original sources: ${v.sourceIds.join(", ") || "none"}`, ...v.attachments.map(a => `## Attachment: ${a.name}\n\n${a.content}`)].join("\n\n");
}
