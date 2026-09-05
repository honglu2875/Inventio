import type { ProjectState, WorkerRole } from "@inventio/schema";
import { factConcerns, factDisplayStatus, factIsSettled } from "@inventio/schema";
import { withMathematicalWritingGuidance } from "./shared.js";

/**
 * Central prompt surface for trajectories-v2.
 *
 * Call sites:
 * - engine/engine.ts generateIntake(): TRAJECTORY_INTAKE_PROMPT, once at first
 *   intake and whenever the owner explicitly regenerates editable W000.
 * - engine/engine.ts executeTrajectoryTask(): trajectoryWorkerFiles() and
 *   TRAJECTORY_WORKER_PROMPT, once for every Solver/Explorer in a round.
 * - engine/engine.ts executeVerification(): verificationFiles() and
 *   VERIFICATION_PROMPT, independently V times for every new claim.
 * - engine/engine.ts compareTrajectoryClaims(): claimComparisonFiles() and
 *   CLAIM_COMPARISON_PROMPT, once before a round's proofs are checked when
 *   there are statements worth comparing.
 * - engine/engine.ts reviewTrajectorySummary(): summaryReviewFiles() and
 *   SUMMARY_REVIEW_PROMPT, once after a completed round; this call may make a
 *   small edit to W000 but cannot select or brief workers.
 * - engine/engine.ts finalizeTrajectory(): trajectoryFinalFiles() and
 *   TRAJECTORY_FINAL_PROMPT, once when the deterministic research loop stops.
 *
 * These prompts intentionally give mathematical trajectories room to think.
 * Scheduling, file ownership, budgets, and state transitions belong to code,
 * not to model prose.
 */

export const TRAJECTORY_INTAKE_PROMPT = `Read the complete raw intake materials in this directory. Think about them as a mathematician who understands the subject and is preparing to begin a serious investigation with several independent researchers.

Write W000 as your present mathematical understanding of the problem, the intended meaning of the owner's proposals and terminology, and the ideas or sources that seem genuinely relevant. Use ordinary mathematical judgment and preserve the exact meaning supplied by context; do not replace a named method by a nearby formalism. This is an editable mathematical view, not a report about reading files and not a research plan. Keep its abstract within four concise sentences.

Reply with ONLY one JSON object conforming to the provided output schema.`;

/**
 * Files for the v2 W000 call. Keep this separate from the legacy
 * Research-Manager intake packet: W000 is an initial mathematical reading,
 * not the first turn of a continuing controller. Raw source files and their
 * index are copied beside these files by engine/intakeSources.ts.
 */
export function trajectoryIntakeFiles(
  statement: string,
  contextMarkdown: string,
): Record<string, string> {
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Initial mathematical reading

Read the original objective, background, and every usable item listed in
raw-materials/index.md. Form a mathematically engaged understanding of what is
being asked and what the supplied terminology, proposals, and references mean.
Preserve a named method in its intended sense rather than substituting a nearby
formalism. This is not yet a research trajectory or a plan for other agents.

Write a natural, editable current mathematical view in managerNoteMarkdown and
a navigation abstract of no more than four concise sentences in
managerAbstract. Concentrate on the mathematics rather than the act of reading
the submission. A useful uncertain idea should be understood and situated, not
merely attributed or defensively dismissed.

The output schema retains several fields for older projects. Copy statement.md
verbatim into problemMarkdown. Keep contextDigestMarkdown, rawMemories,
ambiguities, clarifications, and notes empty. Give each source in
raw-materials/index.md one concise sourceSummaries entry so the original can be
found later; summaries aid navigation and do not replace the source.

Return only the JSON object required by the output schema. Because the reply is
JSON, double TeX backslashes so they survive JSON decoding.`),
    "statement.md": statement,
    "context.md": contextMarkdown.trim() || "(No separate background notes supplied.)",
  };
}

function compact(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

export function latestMathematicalView(state: ProjectState): { abstract: string; markdown: string } {
  const view = state.mathematicalViews.at(-1);
  if (view) return { abstract: view.abstract, markdown: view.markdown };
  const legacy = state.researchManagerNotes.at(-1);
  if (legacy) return { abstract: legacy.abstract, markdown: legacy.markdown };
  return {
    abstract: "",
    markdown: state.problem.contextDigestMarkdown || state.problem.confirmedMarkdown || state.statement,
  };
}

export function claimConflictSummary(state: ProjectState): string {
  const unavailable = state.waveOrder.filter(id => state.waves[id]?.conflictCheck === "UNAVAILABLE")
    .map(id => `- The comparison of potentially conflicting statements in ${id} could not be completed.`);
  const open = (state.claimConflicts ?? []).filter((conflict) => conflict.status === "OPEN");
  const warnings = [...unavailable, ...open.map((conflict) =>
    `- ${conflict.leftClaimId} and ${conflict.rightClaimId}: ${compact(conflict.reason, 640)}`,
  )];
  return warnings.join("\n") || "(No recorded unresolved conflicts.)";
}

export function trajectoryKnowledgeIndex(state: ProjectState): string {
  const out = [
    "# Mathematical library",
    "",
    "Full statements and proofs can be opened with the knowledge tools. A claim is not a fact until independent verification passes. A fact labelled SUSPICIOUS or UNSETTLED has an unresolved challenge or dependency and must not be used as settled mathematics.",
    "",
    "## Facts",
    "",
  ];
  const facts = state.factOrder
    .map((id) => state.facts[id]!)
    .filter((fact) => fact.status === "ACTIVE" || fact.status === "SUSPICIOUS");
  if (facts.length === 0) out.push("(none yet)");
  for (const fact of facts) {
    out.push(`- **${fact.id}** [${factDisplayStatus(state, fact.id)}] ${fact.title || compact(fact.statement, 120)} — ${compact(fact.statement, 420)}`);
    for (const reason of factConcerns(state, fact.id).slice(0, 3)) out.push(`  Warning: ${compact(reason, 480)}`);
  }
  out.push("", "## Unresolved conflicting statements", "", claimConflictSummary(state), "", "## Claims awaiting verification", "");
  const claims = state.claimOrder
    .map((id) => state.claims[id]!)
    .filter((claim) => claim.status === "UNVERIFIED");
  if (claims.length === 0) out.push("(none)");
  for (const claim of claims) {
    out.push(`- **${claim.id}** [${claim.relationToGoal}] ${claim.title || compact(claim.statement, 120)} — ${compact(claim.statement, 420)}`);
  }
  out.push("", "## Claims needing a revised write-up", "");
  const needsRevision = state.claimOrder
    .map((id) => state.claims[id]!)
    .filter((claim) => claim.status === "NEEDS_REVISION");
  if (needsRevision.length === 0) out.push("(none)");
  for (const claim of needsRevision) {
    out.push(`- **${claim.id}** ${claim.title || compact(claim.statement, 120)} — ${compact(claim.statement, 420)}`);
  }
  out.push("");
  return out.join("\n");
}

/**
 * Editorial index for locating complete statements and comparing their relations.
 * Failed proofs remain visible here because a later proof may establish the
 * same theorem; facts point back to their source K ID so the reader never has
 * to guess whether an F ID is legal in the comparison result.
 */
export function trajectoryClaimStatementIndex(state: ProjectState): string {
  const out = [
    "# Claim statement index",
    "",
    "Use only K claim IDs when comparing statements. These entries are excerpts: read the complete statements under statements/ before asserting identity or incompatibility. FAILED means the submitted proof did not pass; it does not mean the statement is false. NEEDS_REVISION means the submitted text was not complete enough to check. REFUTED is reserved for a concrete disproof.",
    "",
  ];
  if (state.claimOrder.length === 0) out.push("(none)");
  for (const claimId of state.claimOrder) {
    const claim = state.claims[claimId]!;
    const facts = state.factOrder
      .map((factId) => state.facts[factId]!)
      .filter((fact) => fact.claimId === claim.id)
      .map((fact) => `${fact.id} [${factDisplayStatus(state, fact.id)}]`);
    const factSuffix = facts.length > 0 ? `; recorded as ${facts.join(", ")}` : "";
    out.push(
      `- **${claim.id}** [${claim.status}; ${claim.relationToGoal}; ${claim.kind}] ${claim.title || "Untitled result"}${factSuffix}`,
      `  ${compact(claim.statement, 700)}`,
    );
  }
  out.push("");
  return out.join("\n");
}

function trajectoryRole(role: "solver" | "explorer"): string {
  if (role === "solver") {
    return `You are an independent Solver. Sustain a self-directed attack on the original problem itself. Choose and revise your own strategy, follow useful branches, search the literature when it helps, calculate or write code when it helps, and revisit earlier mathematics through the available tools. A hard or famous open problem is a reason to look for new reductions, lemmas, obstructions, examples, or counterexamples—not a reason to stop early.`;
  }
  return `You are an independent Explorer. Develop mathematics that can change our understanding of the target without being forced to solve it immediately. Special cases, neighboring theorems, explicit computations, alternative formulations, examples, obstructions, and connections to other subjects are all legitimate. Follow a promising discovery as far as it deserves, including all the way to the original result when possible.`;
}

export function trajectoryWorkerFiles(
  state: ProjectState,
  waveId: string,
  taskId: string,
  role: "solver" | "explorer",
  ordinal: number,
  ownerGuidance: string,
  toolsAvailable: boolean,
): Record<string, string> {
  const view = latestMathematicalView(state);
  const sourceCatalog = state.problem.sources.length === 0
    ? "# Original materials\n\nNo supplementary source was retained."
    : [
        "# Original materials",
        "",
        "Use source_list and source_open to inspect the original text when needed.",
        "",
        ...state.problem.sources.map((source) =>
          `- **${source.id}** ${source.title} — ${source.abstract || compact(source.excerptMarkdown, 360)}`
        ),
        "",
      ].join("\n");
  const agents = [
    `# Independent mathematical trajectory — ${taskId}`,
    "",
    trajectoryRole(role),
    "",
    `This is trajectory ${ordinal} of its role in research round ${waveId}. Other trajectories are deliberately absent. You have a long working session: use it for sustained mathematical research rather than producing an early generic answer. You may inspect files, use the project tools, search the web when enabled, and create calculations under \`scratch/\`. Do not spawn other agents or read outside this directory.`,
    "",
    "The current mathematical view is orientation, not authority. Facts in the library passed the configured independent checks, but a concrete contradiction may still justify one carefully stated correction flag. Claims remain unverified. Check anything on which your argument depends.",
    "",
    toolsAvailable
      ? "Available project tools let you search/open facts, claims, earlier write-ups, and original intake sources; record a milestone when a mathematical turning point would help a human follow this trajectory. The fact-correction tool is only for a concrete contradiction or disproof, never for general doubt."
      : "Project tools are unavailable in this environment; rely on the supplied compact record and state any missing dependency honestly.",
    "",
    "Write mathematics for another mathematician. Explain the governing idea, retain exact hypotheses and notation, and distinguish proof from evidence or conjecture. Actively test your own proposed argument. Keep useful failures and obstructions in the write-up; they need not become claims.",
    "",
    "## Final response",
    "",
    "Return only the JSON object required by the output schema. The readable \`writeupMarkdown\` is your mathematical handoff. The short \`summaryMarkdown\` should say what actually changed.",
    "",
    "List in \`claims\` only a small set of useful new propositions, lemmas, theorems, or counterexamples that you believe you established. Each item needs a precise self-contained statement and a complete proof that can be sent alone to an independent verifier. Do not list assumptions, plans, vague insights, imported standard facts, or a repetitive sequence of individual computed cases. Prefer a natural statement with exactly the scope supported by the proof. An empty list is correct when no such result was proved. State each imported theorem precisely with its source and check its hypotheses. Include the decisive calculation or derivation in the claim itself; a reference to your scratch work or a statement that a computation was performed is insufficient. Do not bundle a proved lemma with an unresolved extension. In dependsOnFactIds name any existing project facts used as premises. These references track provenance only: state the required mathematics and its justification within the proof, without internal project IDs or an instruction to open other project files.",
    "",
    "The conclusion PROVED or DISPROVED is reserved for the original problem; otherwise use UNCERTAIN even when you proved valuable partial results.",
    "",
  ].join("\n");

  return {
    "AGENTS.md": withMathematicalWritingGuidance(agents),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "current-mathematical-view.md": `# Current mathematical view\n\n${view.markdown}`,
    "mathematical-library.md": trajectoryKnowledgeIndex(state),
    "original-materials.md": sourceCatalog,
    ...(ownerGuidance.trim()
      ? { "owner-guidance.md": `# Current guidance from the owner\n\n${ownerGuidance.trim()}\n` }
      : {}),
  };
}

export const TRAJECTORY_WORKER_PROMPT =
  "Work on the original problem in problem.md for a sustained independent research session. Read AGENTS.md and the supplied mathematical context, use every relevant tool available to you, and return only the required JSON object when your investigation is genuinely complete or the limit is reached.";

export const TRAJECTORY_RESTART_PROMPT =
  "Continue the same mathematical investigation after the process restart. Re-read AGENTS.md and problem.md, recover the most useful thread of your reasoning, and finish with only the required JSON object.";

export function verificationFiles(
  problemMarkdown: string,
  claimId: string,
  claimMarkdown: string,
  ordinal = 1,
): Record<string, string> {
  const emphasis = ordinal % 2 === 1
    ? "Check the logical argument in order, with particular attention to imported results, hypotheses, and the scope of the conclusion."
    : "Independently derive the step most capable of changing the conclusion from the definitions or cited source formula, then compare it with the submitted derivation. For a computation, retain the intermediate terms and conventions. When reducing a recursion or summing boundary contributions, derive the surviving terms before cancellation and justify the omitted terms. For a structural argument, check its decisive implication or limiting operation. This emphasis does not exempt the rest of the proof from review.";
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Independent verification — ${claimId}\n\nYou are an independent mathematical verifier. Decide whether the supplied statement follows from the supplied proof exactly as written. The submission is required to be self-contained; check whether it actually is. No other project argument is authoritative. The current directory is the complete project material authorized for this check: do not attempt to inspect parent directories, neighboring checks, other project write-ups, or the repository. Try seriously to falsify the claim by inspecting every hypothesis, implication, cited result, boundary case, and computation that matters. You may use web search to check an external theorem when enabled, and may calculate under scratch/. Do not silently repair a gap.\n\n${emphasis}\n\nIn reportMarkdown, give a concise mathematical account of the decisive checks: identify the source equation or definition, show the derived expression or implication, and explain the hypotheses or vanishing terms that matter. Generic assurances that signs, calculations, or citations are correct do not document a check. For FAIL, give the exact location and the missing or incorrect step; a complete audit of unrelated steps is unnecessary. Do not claim computational confirmation from a failed command. A successful rerun checks the code execution, not whether the code expresses the intended mathematics. If you instead verify the step by hand, show that derivation. In evidence, declare whether the decisive check uses derivation, computation, or both. For computation or both, list the exact shell commands you relied on in supportingCommands, as supplied to your shell tool; prefer a saved script and short invocation. Include only commands whose successful execution supports the mathematical check. For derivation alone, use an empty list. These declarations are compared with the recorded command outcomes; merely opening a file or listing a directory is not mathematical confirmation.\n\nPASS means the statement and complete proof are correct, and that any claimed relation to the original problem is exact. For PASS use finding NONE. For FAIL, classify the principal reason without softening the verdict: INCORRECT for a false step or counterexample; PROOF_GAP for a substantive missing implication; MISSING_DEPENDENCY when a needed theorem, hypothesis, definition, or calculation was not actually supplied; PRESENTATION only when damaged or undefined notation prevents the mathematical content from being checked. Expository preferences alone do not cause FAIL.\n\nReturn only the JSON object required by the output schema.`),
    "problem.md": problemMarkdown,
    "claim.md": claimMarkdown,
  };
}

export const VERIFICATION_PROMPT =
  "Independently check claim.md as described in AGENTS.md. Return only the required JSON object.";

/** Compare identity and incompatibility before independently checking proofs. */
export function claimComparisonFiles(
  state: ProjectState,
  waveId: string,
): Record<string, string> {
  const currentIds = state.claimOrder.filter(
    (claimId) => state.claims[claimId]?.sourceWaveId === waveId,
  );
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Compare mathematical statements\n\nRead the complete statements under statements/ for any proposed relation; the index contains excerpts only. Identify exact mathematical identity: the same hypotheses, quantifiers, scope, and conclusion. Different wording and notation may express the same statement. Do not group implications, special cases, generalizations, or thematic similarity. Distinct proofs remain separate.\n\nAlso report a small number of explicit pairs of incompatible statements in conflicts, with a concise mathematical reason identifying the incompatible formula or conclusion under the same hypotheses and conventions. Mere differences in scope, proof quality, or lack of a proof are not conflicts. Do not assess proof quality, decide which statement is true, or choose research directions. A FAILED or NEEDS_REVISION proof has not refuted its statement. Do not report a pair as both identical and incompatible.\n\nEvery group and conflicting pair must contain a claim from current-round-claims.md. Use only existing K claim IDs. Return only the JSON object required by the output schema.`),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "current-round-claims.md": currentIds.length > 0
      ? `# Claims from ${waveId}\n\n${currentIds.map((id) => `- ${id}`).join("\n")}\n`
      : `# Claims from ${waveId}\n\n(none)\n`,
    "claim-statement-index.md": trajectoryClaimStatementIndex(state),
    ...Object.fromEntries(state.claimOrder.map((id) => [
      `statements/${id}.md`, state.claims[id]!.statement,
    ])),
  };
}

export const CLAIM_COMPARISON_PROMPT =
  "Compare only the mathematical statements as described in AGENTS.md and return only the required JSON object.";

export function summaryReviewFiles(
  state: ProjectState,
  waveId: string,
  roundSummaries: string,
): Record<string, string> {
  const current = latestMathematicalView(state);
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Small revision of the current mathematical view\n\nRead the current view and the completed round as a mathematician. Change the view only when a new result, obstruction, example, or correction materially changes the mathematical picture. This is not a planning step: do not choose directions, assign researchers, narrate the workflow, or expand the document merely because new text exists. Preserve its natural research voice. The abstract must be plain prose of at most four complete sentences and 480 characters; never end it mid-word or spill an outline into it. If no mathematical change is warranted, return the current abstract and markdown verbatim with changed=false. Do not make repeated stylistic rewrites. An already malformed abstract may be repaired editorially without changing its mathematical meaning.\n\nReturn only the JSON object required by the output schema.`),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "current-mathematical-view.md": `ABSTRACT:\n${current.abstract}\n\nVIEW:\n${current.markdown}`,
    "completed-round.md": `# Completed research round ${waveId}\n\n${roundSummaries}`,
    "mathematical-library.md": trajectoryKnowledgeIndex(state),
  };
}

export const SUMMARY_REVIEW_PROMPT =
  "Consider whether the completed round materially changes the current mathematical view. Make at most a small editorial revision and return only the required JSON object.";

export function trajectoryFinalFiles(state: ProjectState, result: string, reason: string): Record<string, string> {
  const view = latestMathematicalView(state);
  const facts = state.factOrder
    .map((id) => state.facts[id]!)
    .filter((fact) => factIsSettled(state, fact.id))
    .map((fact) => `## ${fact.id}: ${fact.title}\n\n${fact.statement}\n\n### Proof\n\n${fact.proofMarkdown}`)
    .join("\n\n");
  const unsettled = state.factOrder
    .map((id) => state.facts[id]!)
    .filter((fact) => fact.status === "ACTIVE" || fact.status === "SUSPICIOUS")
    .flatMap((fact) => factConcerns(state, fact.id).map((reason) => `- ${fact.id}: ${reason}`))
    .join("\n");
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Final mathematical report\n\nWrite a concise, self-contained account of what the investigation established and what remains. The deterministic verification record has already fixed the result shown in stopping-status.md; do not elevate an unverified claim or a fact with an unresolved challenge. Explain useful new partial results and failed approaches mathematically, without referring to internal workflow vocabulary, task IDs, token budgets, or software. Return only {\"finalMarkdown\": \"...\"}.`),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "stopping-status.md": `RESULT: ${result}\nREASON: ${reason}`,
    "current-mathematical-view.md": view.markdown,
    "verified-results.md": facts || "(No independently verified new result.)",
    "unsettled-warnings.md": unsettled || "(none)",
    "conflicting-statements.md": claimConflictSummary(state),
  };
}

export const TRAJECTORY_FINAL_PROMPT =
  "Compose the self-contained final mathematical report described in AGENTS.md and return only the required JSON object.";

/** Roles participating in the main v2 research rounds. */
export function isTrajectoryResearchRole(role: WorkerRole): role is "solver" | "explorer" {
  return role === "solver" || role === "explorer";
}
