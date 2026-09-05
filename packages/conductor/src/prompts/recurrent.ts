import { resultMathematics, resultStatus, auditCoverage, type ProjectState, type ResearchRole, type ResearchRound, type FrozenResult } from "@inventio/schema";
import { withMathematicalWritingGuidance } from "./shared.js";

export const RESEARCH_PROMPT = "Read AGENTS.md and the original problem. Conduct the investigation, save mathematical notes, and return refined results with their exact supported scope.";
export const REPAIR_PROMPT = "Read the newly appended objections.md. Revisit the exact result in this conversation. Revise, withdraw, defend with mathematics, or leave the issue unresolved; return the same author envelope.";
export const CHECK_PROMPT = "Read AGENTS.md and independently check the complete target mathematics, including its scope and exact premises. Return one substantive assessment.";
export const AUDIT_PROMPT = "Read AGENTS.md and audit every target in audit-targets.md independently. Derive delicate identities from definitions or their original source. Return an assessment of each exact version.";
export const AUDIT_TAIL_PROMPT = "Additional mathematics is now available in audit-targets.md and mathematics/. Audit the listed exact versions; earlier assessments do not cover a revised argument. Assess each listed target explicitly.";
export const EDITOR_PROMPT = "Read AGENTS.md and the sealed mathematical record. Write the readable round summary and a compact next-round brief, referencing exact result versions.";
export const FINAL_PROMPT = "Read AGENTS.md, the original problem, and the fixed outcome. Write a coherent self-contained mathematical report with the recorded proofs, sources, qualifications, and open questions.";

export function researchIndex(state: ProjectState): string {
  const s = state.research;
  return ["# Mathematical library", ...s.versionOrder.map(id => {
    const v = s.versions[id]!;
    return `- ${id} [${v.kind}; ${resultStatus(s, id)}; ${v.relationToGoal}] ${v.title}`;
  }), ...Object.values(s.notes).map(n => `- ${n.id}: ${n.name}`)].join("\n");
}
export function qualifiedRecord(state: ProjectState): string {
  return state.research.versionOrder.map(id => `Current qualification: ${resultStatus(state.research, id)}\n\n${resultMathematics(state.research.versions[id]!)}`).join("\n\n---\n\n");
}
export function authorFiles(state: ProjectState, round: ResearchRound, role: "solver" | "explorer"): Record<string, string> {
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Mathematical investigation\n\nYou are the ${role === "solver" ? "Solver" : "Explorer"}. ${role === "solver" ? "Attack the original problem and develop a complete argument when possible." : "Investigate useful examples, methods, special cases, obstructions and independent calculations."}
Choose your own methods and pacing. The original hypotheses and objective are authoritative.
A failed attempted proof is not a disproof. Treat a discrepancy between calculations as unresolved mathematics until its terms are reconciled.

Save mathematical notes, including drafts and unsuccessful approaches, under notes/. At natural pauses use research_checkpoint to share immutable snapshots and, when worthwhile, submit self-contained results. All saved notes are catalogued at a checkpoint and at the end; you need not nominate individual files. Do not publish raw thinking transcripts. Use research_search and research_open to find all saved mathematics, including disputed results and previous versions. Source tools read the owner's original materials. You cannot inspect another author's live workspace.

A result separates content kind, current checking qualifications, and relation to the goal. PROPOSITION and CALCULATION require a complete alleged proof or derivation. State conventions, inputs, hypotheses, and the exact versus numerical scope. CONJECTURE and NOTE never become established premises. Cite exact version IDs in dependencies; cite original source IDs in sourceIds. A new result has resultId and parentVersionId null. A revision names its existing result and parent version; it must not inherit the old proof's checks. Attachment paths are relative files in notes/. All decisive calculations must be self-contained, with relevant summands and contractions visible before cancellation.

The response contains writeupMarkdown, results, responses, and questions. During research, responses is empty. Submit genuine material ambiguities as questions. Do not invent results to fill the response. After an objection, return only the targeted result's response and any corresponding revised version. REVISE names its replacement's index in results; WITHDRAW, DEFEND and UNRESOLVED have null replacementIndex. A defense supplies the actual missing mathematics, not confidence or an appeal to model strength.`),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "brief.md": round.briefMarkdown,
    "memory-index.md": researchIndex(state),
    "owner-guidance.md": [...state.continuations.map(c => c.note), ...Object.values(state.directives).map(d => d.text), ...Object.values(state.questions).filter(q => q.status === "answered").map(q => `${q.text}\n${q.answer ?? ""}`)].join("\n\n"),
  };
}
export function independentFiles(state: ProjectState, role: "verifier" | "auditor", targets: FrozenResult[], dependencies: FrozenResult[]): Record<string, string> {
  const files: Record<string, string> = {
    "AGENTS.md": withMathematicalWritingGuidance(`# Independent mathematical ${role === "auditor" ? "audit" : "verification"}

You receive the original problem and complete mathematical statements, alleged proofs, exact premises and original sources. You have no access to author transcripts, editorial summaries or previous verdicts. Check the mathematics independently. Do not infer truth from a document's presence or from its identifier.

Assess every listed target, including its exact scope relative to the original goal and all nontrivial premises. A numerical example does not prove a general statement. For a decisive recurrence or identity, start from its defining or source formula, display every surviving summand and contraction before cancellation, and check index ranges, symmetry factors, boundary terms and normalization. A discrepancy that equals an omitted summand needs reconciliation, not a confidence vote. Inability to check a source or a failed command does not disprove a statement.

CONFIRM requires a substantive derivation with supported scope. QUARANTINE requires a concrete defect or incompatible calculation; DOWNGRADE identifies a proof gap, missing source or unjustified scope; RETRACT explains why this proof version is unusable and does not imply the statement is false without an actual disproof. UNABLE leaves coverage incomplete. finding NONE is reserved for confirmation. Declare whether the assessment relies on hand derivation, computation or both; name the exact successful supporting shell commands when computation supplies evidence. Successful execution alone does not certify the mathematics encoded by a script.

${role === "auditor" ? "Use audit_assess to record a justified assessment as soon as it is ready, particularly when a concrete defect should immediately quarantine a premise. The same exact version must not receive inconsistent duplicate assessments within one turn. You may resolve a mathematical disagreement by checking the complete arguments. Do not author a corrected theorem and certify it yourself; describe the defect and let an author submit a new version for independent checking." : "Return one assessment. Routine verification does not confer strong-audit status."}
${role === "verifier" ? "Routine checks use QUARANTINE for an unusable argument; only the strong auditor may RETRACT a version." : ""}
Use only research_search/research_open for the authorized mathematical versions and source_list/source_open for original source text. Your permitted sources do not include prior notes or reviews.`),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "audit-targets.md": targets.map(v => `${v.id} ${v.hash}`).join("\n"),
  };
  for (const v of [...dependencies, ...targets]) files[`mathematics/${v.id}.md`] = resultMathematics(v);
  return files;
}
export function editorialFiles(state: ProjectState, roundId: string, final = false): Record<string, string> {
  const coverage = auditCoverage(state.research, roundId);
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# ${final ? "Final mathematical exposition" : "Round exposition"}

${final ? "Write one coherent self-contained report from the fixed outcome and qualified mathematics." : "Write a substantial readable round summary and a shorter next-round brief from the sealed record."}
Explain the decisive mathematics, exact hypotheses, corrections, useful unsuccessful approaches, limitations and open questions in ordinary academic language. Keep result references as [B001.v1](result:B001.v1). The runtime supplies canonical statement/proof blocks and status notices from their immutable source versions. Your paraphrases are exposition, never replacements for hypotheses or proofs. Do not invent a missing argument, settle a dispute, elevate a conjecture or prescribe the next research strategy. Preserve the distinction between CHECKED and AUDITED. State audit coverage accurately, including incomplete work. An editorial failure has a readable deterministic fallback.
Return ${final ? "reportMarkdown and referencedVersions" : "summaryMarkdown, briefMarkdown and referencedVersions"}. Every referenced version must exist in the supplied record.`),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "record.md": qualifiedRecord(state),
    "memory-index.md": researchIndex(state),
    "notes.md": Object.values(state.research.notes).filter(n => n.roundId === roundId).map(n => `# ${n.id}: ${n.name}\n\n${n.markdown}`).join("\n\n"),
    "coverage.json": JSON.stringify(coverage, null, 2),
    "outcome.json": final ? JSON.stringify(state.research.final, null, 2) : "Round summary; no stopping outcome is assigned.",
  };
}
export function responseMathematics(body: string): string {
  return `# Additional mathematical argument\n\n${body}`;
}

export const recoveryPrompt = (prompt: string): string => `${prompt}\nContinue the interrupted turn in this same conversation and return the required complete response.`;
