import type { Event, EventType, Usage } from "../src/index.js";
import { defaultConfig } from "../src/index.js";

/**
 * A canonical coherent event sequence exercising every event type at least
 * once. Used for totality, determinism, and graph tests.
 */

const usage: Usage = {
  input_tokens: 10_000,
  cached_input_tokens: 4_000,
  output_tokens: 2_000,
  reasoning_output_tokens: 500,
};

type Payload<T extends EventType> = Omit<Extract<Event, { type: T }>, "seq" | "ts" | "type">;

export function buildCanonicalEvents(): Event[] {
  let seq = 0;
  const events: Event[] = [];
  function ev<T extends EventType>(type: T, payload: Payload<T>): void {
    seq += 1;
    events.push({ seq, ts: new Date(1700000000000 + seq * 1000).toISOString(), type, ...payload } as Event);
  }

  const grants = { artifactIds: [], cardIds: [], sourceMounts: [] };

  ev("project.created", {
    slug: "test-problem",
    title: "Test problem",
    statement: "Prove that P.",
    contextMarkdown: "The owner supplied a long literature note and a tentative induction idea.",
    config: defaultConfig(),
  });
  ev("intake.rawUpdated", {
    statement: "Prove that P, keeping every hypothesis explicit.",
    contextMarkdown: "The owner supplied a revised long literature note and a tentative induction idea.",
    by: "human",
  });
  ev("phase.changed", { from: "CREATED", to: "INTAKE", reason: "start" });
  ev("intake.completed", {
    problemMarkdown: "# Problem\nProve that P.",
    contextDigestMarkdown: "The literature note suggests induction, but the idea is unverified.",
    rawMemories: [{
      type: "ATTEMPT-SUMMARY",
      title: "Tentative induction",
      abstract: "An unverified route supplied at intake.",
      content: "Try an induction after clarifying the domain.",
      tags: ["induction"],
    }],
    ambiguities: [{ text: "Is n a natural number?", material: true }],
    clarifications: [{ id: "CL1", question: "Is n a natural number?", kind: "choice", options: ["yes", "no"], why: "changes the domain", suggested: "yes" }],
  });
  ev("intake.sourcesUpdated", {
    sources: [{
      id: "S001",
      kind: "objective",
      title: "Original objective",
      relativePath: "intake/original-objective.md",
      size: 13,
      sha256: "0".repeat(64),
      abstract: "The owner asks for a proof of P.",
      excerptMarkdown: "**Objective.** Prove that $P$.",
    }],
  });
  ev("phase.changed", { from: "INTAKE", to: "AWAITING_CONFIRMATION", reason: "intake done" });
  ev("intake.answered", { answers: [{ id: "CL1", answer: "yes" }] });
  ev("intake.revised", { problemMarkdown: "# Problem\nProve that P for n ∈ ℕ.", notes: "applied CL1" });
  ev("problem.confirmed", {
    problemMarkdown: "# Problem\nProve that P, n ∈ ℕ.",
    contextDigestMarkdown: "The owner retained induction as an explicitly unverified starting route.",
    rawMemories: [{
      type: "ATTEMPT-SUMMARY",
      title: "Owner-edited induction route",
      abstract: "An unverified route retained by the owner.",
      content: "Try induction over natural numbers and check the parity split.",
      tags: ["induction", "parity"],
    }],
  });
  ev("phase.changed", { from: "AWAITING_CONFIRMATION", to: "DISCOVERY", reason: "confirmed" });
  ev("autonomy.changed", { mode: "auto", by: "human" });
  ev("models.changed", {
    models: {
      researchManager: { model: "gpt-5.6-sol", effort: "max" },
      solver: { model: "gpt-5.6-sol", effort: "max" },
      explorer: { model: null, effort: "medium" },
      reviewer: { model: null, effort: "high" },
      synthesizer: { model: "gpt-5.6-terra", effort: "high" },
    },
    by: "human",
  });
  ev("webSearch.changed", { enabled: true, by: "human" });
  ev("project.settingsChanged", {
    settings: {
      models: {
        researchManager: { model: "gpt-5.6-sol", effort: "max" },
        solver: { model: "gpt-5.6-sol", effort: "max" },
        explorer: { model: null, effort: "medium" },
        reviewer: { model: null, effort: "high" },
        synthesizer: { model: "gpt-5.6-terra", effort: "high" },
      },
      autonomy: "auto",
      allowWebSearch: true,
      totalTokens: 40_000_000,
      maxWaves: 20,
    },
    by: "human",
  });
  ev("directive.submitted", { id: "D001", text: "Try induction first.", urgent: false });

  ev("decision.requested", { decisionId: "DEC001", kind: "next_move", waveId: null });
  ev("decision.proposed", { decisionId: "DEC001", action: { action: "plan_wave" }, usage });
  ev("decision.rejected", { decisionId: "DEC001", violations: ["reserve below 25%"] });
  ev("decision.proposed", { decisionId: "DEC001", action: { action: "plan_wave" }, usage });
  ev("decision.accepted", { decisionId: "DEC001", action: { action: "plan_wave" } });
  ev("directive.consumed", { id: "D001", decisionId: "DEC001" });
  ev("gate.opened", { decisionId: "DEC001" });
  ev("gate.resolved", { decisionId: "DEC001", resolution: "approve" });

  ev("wave.planned", {
    waveId: "W001",
    title: "Independent discovery",
    decisionId: "DEC001",
    reserveTokens: 500_000,
    rationale: "little is known",
    roster: [
      { taskId: "T001", role: "solver", methodTag: "induction", direction: "Direct proof by induction", briefMarkdown: "Prove P by induction.", tokenBudget: 1_000_000, computation: false, webSearch: false, reviewOf: null, grants },
      { taskId: "T002", role: "explorer", methodTag: "small-cases", direction: "Small cases", briefMarkdown: "Compute small cases.", tokenBudget: 500_000, computation: true, webSearch: false, reviewOf: null, grants },
      { taskId: "T003", role: "solver", methodTag: "contradiction", direction: "Contradiction", briefMarkdown: "Assume not-P.", tokenBudget: 800_000, computation: false, webSearch: false, reviewOf: null, grants },
    ],
  });

  ev("task.dispatched", { taskId: "T001", waveId: "W001", role: "solver", methodTag: "induction", direction: "Direct proof by induction", packetManifest: ["AGENTS.md", "problem.md", "assignment.md"], budgetTokens: 1_000_000 });
  ev("task.session", { taskId: "T001", threadId: "thr-001" });
  ev("task.progress", { taskId: "T001", estimatedTokens: 1234, lastItem: { type: "reasoning", preview: "…" } });
  ev("task.milestone", {
    milestoneId: "MS001",
    taskId: "T001",
    title: "Inductive reduction",
    markdown: "The argument reduces to the even case.",
  });
  ev("task.extended", { taskId: "T001", addTokens: 200_000, by: "human" });
  ev("task.completed", { taskId: "T001", usage });
  ev("task.accounted", { taskId: "T001", chargedTokens: 8_000, basis: "reported" });
  ev("artifact.recorded", { artifactId: "A001", kind: "attempt", taskId: "T001", path: "artifacts/attempts/A001.md", conclusion: "UNCERTAIN" });
  ev("crossexam.sent", { taskId: "T001", decisionId: "DEC001", refIds: ["K001"], questionMarkdown: "Clarify step 3." });
  ev("crossexam.answered", { taskId: "T001", answerMarkdown: "Step 3 uses monotonicity.", usage: null });

  ev("task.dispatched", { taskId: "T002", waveId: "W001", role: "explorer", methodTag: "small-cases", direction: "Small cases", packetManifest: ["AGENTS.md"], budgetTokens: 500_000 });
  ev("task.outputInvalid", { taskId: "T002", errors: ["memo.summary: required"] });
  ev("task.interrupted", { taskId: "T002", reason: "budget", usage: null });

  ev("task.dispatched", { taskId: "T003", waveId: "W001", role: "solver", methodTag: "contradiction", direction: "Contradiction", packetManifest: ["AGENTS.md"], budgetTokens: 800_000 });
  ev("task.failed", { taskId: "T003", error: "codex exited 1" });

  ev("claim.added", { claimId: "K001", statement: "P holds for n=1.", status: "UNVERIFIED", provenance: "A001 §2", sourceTaskId: "T001", dependsOn: [] });
  ev("claim.provenanceRepaired", {
    claimId: "K001",
    from: "A001 §2",
    to: "A001 §2 (from T001)",
  });
  ev("claim.added", { claimId: "K002", statement: "P(n) implies P(n+1).", status: "UNVERIFIED", provenance: "A001 §3", sourceTaskId: "T001", dependsOn: ["K001"] });
  ev("claim.equivalent", {
    leftClaimId: "K001",
    rightClaimId: "K002",
    reason: "fixture exercises the equivalence relation",
    by: "conductor",
  });
  ev("claim.status", { claimId: "K001", from: "UNVERIFIED", to: "VERIFIED", justification: "checked by hand", by: "human" });
  ev("fact.recorded", {
    factId: "F001",
    claimId: "K001",
    path: "facts/F001.md",
  });
  ev("claim.added", {
    claimId: "K003",
    title: "Correction to the base case",
    statement: "The recorded base case omits a boundary hypothesis.",
    proofMarkdown: "At the omitted boundary the displayed expression is undefined.",
    status: "UNVERIFIED",
    provenance: "T001",
    sourceTaskId: "T001",
    sourceWaveId: "W001",
    path: "claims/K003.md",
    relationToGoal: "RELATED",
    kind: "correction",
    targetFactId: "F001",
    dependsOn: [],
  });
  ev("fact.suspicionRaised", {
    factId: "F001",
    correctionClaimId: "K003",
    reason: "A concrete omitted boundary case was supplied.",
    by: "T001",
  });
  ev("verification.requested", { verificationId: "V001", claimId: "K003", ordinal: 1 });
  ev("verification.started", { verificationId: "V001" });
  ev("verification.completed", {
    verificationId: "V001",
    verdict: "PASS",
    summaryMarkdown: "The boundary objection is correct.",
    artifactPath: "verifications/V001.md",
    usage: null,
  });
  ev("claim.status", {
    claimId: "K003",
    from: "UNVERIFIED",
    to: "VERIFIED",
    justification: "independent verification passed",
    by: "conductor",
  });
  ev("fact.suspicionCleared", {
    factId: "F001",
    correctionClaimId: "K003",
    reason: "fixture exercises clearing a warning before the final correction disposition",
  });
  ev("fact.retracted", {
    factId: "F001",
    correctionClaimId: "K003",
    reason: "The correction passed independent verification.",
  });

  ev("memory.cardProposed", { cardId: "M001", by: "T001", card: { type: "LEMMA", title: "Base case", content: "P(1) holds.", abstract: "Base case verified.", tags: ["induction"], provenance: "A001 §2", sourceArtifact: "A001", dependsOn: [] } });
  ev("memory.cardAdmitted", { cardId: "M001", status: "PROPOSED", reason: "new claim, not self-verified" });
  ev("memory.cardStatus", { cardId: "M001", from: "PROPOSED", to: "VERIFIED", reason: "K001 verified", by: "conductor" });
  ev("memory.recall", { taskId: "T001", op: "search", args: "induction base", returnedIds: ["M001"], refusedIds: [] });

  ev("computation.recorded", { compId: "X001", taskId: "T002", entry: "python3 cases.py", inputsHash: "abc", outputHash: "def" });
  ev("computation.baselineRepaired", { compId: "X001", inputsHash: "abc2", outputHash: "def2", exitCode: 0, stderr: "", reason: "legacy working-directory repair" });
  ev("computation.reproduced", { compId: "X001", match: true, outputHash: "def2", exitCode: 0, stderr: "" });

  ev("wave.softInterrupted", { waveId: "W001", by: "human" });
  ev("wave.closed", { waveId: "W001", docketMarkdown: "## Docket\n- K001, K002 proposed" });
  ev("wave.claimsCompared", { waveId: "W001" });
  ev("task.dispositioned", { taskId: "T001", waveId: "W001", disposition: "carry_forward", reason: "The base case is worth independent review.", unblock: null });
  ev("manager.noteRecorded", {
    waveId: "W001",
    path: "artifacts/manager-notes/W001.md",
    markdown: "The induction route has reduced the problem to the even case.",
    source: "research_manager",
  });
  ev("summary.recorded", {
    waveId: "W001",
    path: "artifacts/mathematical-view/W001.md",
    markdown: "The induction route now depends on a corrected boundary statement.",
    abstract: "The boundary case requires correction.",
    changed: true,
    reason: "The verified correction changes the current picture.",
    source: "summary_reader",
    usage: null,
  });
  ev("wave.summaryReviewed", { waveId: "W001" });
  ev("resolution.recorded", { waveId: "W001", path: "artifacts/resolutions/W001.md" });
  ev("capsule.updated", { role: "solver", waveId: "W001", path: "memory/capsules/solver.md" });
  ev("digest.updated", {});

  ev("lineage.created", { lineageId: "C001", title: "Induction route" });
  ev("candidate.frozen", { candidateId: "C001.v1", lineageId: "C001", version: 1, fromArtifact: "A001", obligations: ["Close the inductive step for even n"], reviewQuestions: ["Check the equality case."], usedClaimIds: ["K001", "K002"], scopeMarkdown: null });
  ev("phase.changed", { from: "DISCOVERY", to: "REVIEW", reason: "candidate frozen" });

  ev("issue.raised", { issueId: "I001", candidateId: "C001.v1", severity: "CRITICAL", location: "step 3, uses K002", summary: "Inductive step unproved for even n.", by: "R001" });
  ev("review.recorded", { reviewId: "R001", candidateId: "C001.v1", verdict: "FAIL", issueIds: ["I001"], taskId: "T001" });
  ev("acceptance.evaluated", { candidateId: "C001.v1", passed: false, failing: ["open CRITICAL issue I001"] });
  ev("issue.resolved", { issueId: "I001", disposition: "rejected", reason: "even case covered by symmetry argument in §4", by: "planner" });

  ev("question.raised", { id: "Q001", text: "Allow analytic tools?", blocking: false, context: "solver asked", raisedBy: "planner", interaction: "answer" });
  ev("question.answered", { id: "Q001", answer: "Yes." });
  ev("question.raised", { id: "Q002", text: "The planner stopped twice.", blocking: false, context: "operational recovery", raisedBy: "conductor", interaction: "acknowledge" });
  ev("question.dismissed", { id: "Q002" });
  ev("human.intervention", { kind: "note", target: "C001.v1", note: "Watch the parity split." });

  ev("project.paused", { by: "human" });
  ev("project.resumed", { by: "human" });

  ev("lineage.abandoned", { lineageId: "C001", reason: "structural flaw" });
  ev("lineage.created", { lineageId: "C002", title: "Verified base case" });
  ev("candidate.frozen", { candidateId: "C002.v1", lineageId: "C002", version: 1, fromArtifact: "A001", obligations: [], reviewQuestions: [], usedClaimIds: [], scopeMarkdown: "The base case P(1) holds under the hypotheses of problem.md." });
  ev("lineage.established", { lineageId: "C002", candidateId: "C002.v1" });
  ev("phase.changed", { from: "REVIEW", to: "TERMINAL", reason: "budget exhausted" });
  ev("terminal.reached", { result: "UNCERTAIN", finalPath: "artifacts/final.md" });
  ev("project.continued", {
    previousResult: "UNCERTAIN",
    previousFinalPath: "artifacts/final.md",
    note: "Push the parity reduction one step further.",
    addTokens: 100_000,
    addWaves: 2,
    by: "human",
  });
  ev("phase.changed", { from: "TERMINAL", to: "DISCOVERY", reason: "owner continued" });
  ev("phase.changed", { from: "DISCOVERY", to: "TERMINAL", reason: "second checkpoint" });
  ev("terminal.reached", { result: "UNCERTAIN", finalPath: "artifacts/final.md" });
  const publicationCheckpointSeq = seq;
  ev("decision.requested", { decisionId: "DEC002", kind: "publication", waveId: null });
  ev("publication.requested", {
    publicationId: "P001",
    decisionId: "DEC002",
    terminalResult: "UNCERTAIN",
    terminalFinalPath: "artifacts/final.md",
    terminalReachedAtSeq: publicationCheckpointSeq,
    by: "human",
  });
  ev("decision.proposed", {
    decisionId: "DEC002",
    action: { kind: "research_report", result: "UNCERTAIN" },
    usage: null,
  });
  ev("decision.accepted", {
    decisionId: "DEC002",
    action: { kind: "research_report", result: "UNCERTAIN" },
  });
  ev("publication.drafted", {
    publicationId: "P001",
    kind: "research_report",
    result: "UNCERTAIN",
    title: "A report on P",
    assessment: "The inductive step remains open.",
    texPath: "publications/P001/manuscript.tex",
    logPath: "publications/P001/compile.log",
  });
  ev("publication.failed", {
    publicationId: "P001",
    stage: "compilation",
    error: "the local compiler was interrupted",
  });
  ev("publication.compilationRequested", { publicationId: "P001", by: "human" });
  ev("publication.completed", {
    publicationId: "P001",
    pdfPath: "publications/P001/manuscript.pdf",
    compiler: "tectonic 0.16.9",
  });

  return events;
}
