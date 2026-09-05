import { VerificationEvidenceSummary } from "./verification-evidence.js";
import { z } from "zod";
import { ActiveModelSettings, ProjectConfig, ProjectSettings, WorkerRole } from "./config.js";

/**
 * Event taxonomy (DESIGN.md §5). Every state change in a project is exactly
 * one of these, appended to events.jsonl as `{ seq, ts, ...event }`.
 *
 * Deviations from the DESIGN §5 listing (recorded in PLAN.md deviation log):
 * `task.extended` and `autonomy.changed` added (implied by the §12 API),
 * `decision.proposed` carries planner usage, `claim.added` carries optional
 * dependsOn, and `candidate.frozen` carries usedClaimIds (needed by the
 * evidence graph).
 */

export const Phase = z.enum([
  "CREATED",
  "INTAKE",
  "AWAITING_CONFIRMATION",
  "DISCOVERY",
  "SYNTHESIS",
  "REVIEW",
  "REPAIR",
  "TERMINAL",
]);
export type Phase = z.infer<typeof Phase>;

export const Result = z.enum(["PROVED", "DISPROVED", "UNCERTAIN"]);
export type Result = z.infer<typeof Result>;

export const PublicationKind = z.enum(["preprint", "research_report"]);
export type PublicationKind = z.infer<typeof PublicationKind>;

/**
 * NEEDS_REVISION means missing material or damaged notation prevented a full
 * check. FAILED means this particular statement-and-proof submission had a
 * mathematical error or proof gap; it does not assert that the statement is false.
 * REFUTED is reserved for a concrete mathematical disproof.
 */
export const ClaimStatus = z.enum([
  "UNVERIFIED",
  "NEEDS_REVISION",
  "VERIFIED",
  "FAILED",
  "REFUTED",
  "SUPERSEDED",
]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const ClaimRelation = z.enum(["PROVES", "DISPROVES", "PARTIAL", "RELATED"]);
export type ClaimRelation = z.infer<typeof ClaimRelation>;

export const VerificationVerdict = z.enum(["PASS", "FAIL", "ERROR"]);
export type VerificationVerdict = z.infer<typeof VerificationVerdict>;

/** Why an independent check failed; NONE is required for PASS. */
export const VerificationFinding = z.enum([
  "NONE",
  "INCORRECT",
  "PROOF_GAP",
  "MISSING_DEPENDENCY",
  "PRESENTATION",
]);
export type VerificationFinding = z.infer<typeof VerificationFinding>;

export const IssueSeverity = z.enum(["CRITICAL", "MAJOR", "MINOR"]);
export type IssueSeverity = z.infer<typeof IssueSeverity>;

export const CardType = z.enum([
  "DEFINITION",
  "LEMMA",
  "COUNTEREXAMPLE",
  "COMPUTATION",
  "OBSTRUCTION",
  "ATTEMPT-SUMMARY",
  "OPEN-QUESTION",
]);
export type CardType = z.infer<typeof CardType>;

export const CardStatus = z.enum(["PROPOSED", "VERIFIED", "REFUTED", "SUPERSEDED", "QUARANTINED"]);
export type CardStatus = z.infer<typeof CardStatus>;

export const ArtifactKind = z.enum([
  "attempt",
  "exploration",
  "review",
  "candidate",
  "resolution",
  "writeup",
  "verification",
  "fact",
  "final",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Raw token usage as reported by `codex exec` turn.completed. */
export const Usage = z.object({
  input_tokens: z.number().int().min(0),
  cached_input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  reasoning_output_tokens: z.number().int().min(0),
});
export type Usage = z.infer<typeof Usage>;

/** Spend metric per DESIGN §6.5. */
export function usageSpend(u: Usage): number {
  return Math.max(0, u.input_tokens - u.cached_input_tokens) + u.output_tokens;
}

export const Grants = z.object({
  artifactIds: z
    .array(
      z
        .string()
        .describe("ID of an existing full research write-up, such as A001, E001, R001, or C001.v1"),
    )
    .describe("Full research write-ups supplied to this assignment; never put K claim IDs here"),
  cardIds: z
    .array(z.string().describe("ID of an existing research-library note; these IDs always begin with M, e.g. M001"))
    .describe("Short research-library notes supplied to this assignment; only M IDs are valid, never K claim IDs"),
  sourceMounts: z
    .array(z.string().describe("Name of an existing source collection from the project configuration"))
    .describe("Owner-supplied source collections made available to this assignment"),
});
export type Grants = z.infer<typeof Grants>;

/** A roster entry as frozen at wave.planned (task IDs already allocated). */
export const RosterEntry = z.object({
  taskId: z.string(),
  role: WorkerRole,
  methodTag: z.string(),
  direction: z.string(),
  briefMarkdown: z.string(),
  tokenBudget: z.number().int().positive(),
  computation: z.boolean(),
  /** Defaulted so event logs written before web search existed still replay. */
  webSearch: z.boolean().default(false),
  /** Frozen candidate id this task audits; null for non-review tasks. */
  reviewOf: z.string().nullable(),
  grants: Grants,
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const Ambiguity = z.object({
  text: z.string(),
  material: z.boolean(),
  /** Optional so event logs created before choice-preservation still replay. */
  options: z.array(z.string()).optional(),
});

/**
 * One thing the intake model genuinely could not decide, asked as a question
 * the owner can answer in a click. `kind` picks the widget; a "choice"
 * question still accepts free text, because the offered options are guesses.
 */
export const Clarification = z.object({
  id: z.string(),
  question: z.string(),
  kind: z.enum(["choice", "text"]),
  options: z.array(z.string()),
  /** why this matters — what changes in the problem depending on the answer */
  why: z.string(),
  /** the reading the model would take if the owner says nothing */
  suggested: z.string(),
});
export type Clarification = z.infer<typeof Clarification>;

export const ClarificationAnswer = z.object({ id: z.string(), answer: z.string() });
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;
export type Ambiguity = z.infer<typeof Ambiguity>;

/** A compact, human-editable lead extracted from the owner's intake notes. */
export const IntakeMemory = z.object({
  type: CardType,
  title: z.string().min(1).max(120),
  abstract: z.string().min(1).max(400),
  content: z.string().min(1).max(4_000),
  tags: z.array(z.string().min(1).max(40)).max(8),
});
export type IntakeMemory = z.infer<typeof IntakeMemory>;

/** A durable pointer from a short catalog entry to one verbatim intake item. */
export const IntakeSource = z.object({
  id: z.string().regex(/^S\d{3,}$/),
  kind: z.enum(["objective", "background", "upload"]),
  title: z.string(),
  relativePath: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  abstract: z.string().max(480),
  excerptMarkdown: z.string().max(4_000),
});
export type IntakeSource = z.infer<typeof IntakeSource>;

export const DecisionKind = z.enum([
  "next_move",
  "intake",
  "continuation_revision",
  "curation",
  "final",
  "publication",
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const Actor = z.string(); // "conductor" | "planner" | "human" | task id

export const ProposedCard = z.object({
  type: CardType,
  title: z.string(),
  content: z.string(),
  abstract: z.string(),
  tags: z.array(z.string()),
  provenance: z.string(),
  sourceArtifact: z.string().nullable(),
  dependsOn: z.array(z.string()),
});
export type ProposedCard = z.infer<typeof ProposedCard>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const base = { seq: z.number().int().min(1), ts: z.string() };

export const EventSchema = z.discriminatedUnion("type", [
  // Lifecycle & phases
  z.object({ ...base, type: z.literal("project.created"), slug: z.string(), title: z.string(), statement: z.string(), contextMarkdown: z.string().optional(), config: ProjectConfig }),
  z.object({ ...base, type: z.literal("project.paused"), by: Actor }),
  z.object({ ...base, type: z.literal("project.resumed"), by: Actor }),
  z.object({ ...base, type: z.literal("phase.changed"), from: Phase, to: Phase, reason: z.string() }),
  z.object({ ...base, type: z.literal("terminal.reached"), result: Result, finalPath: z.string() }),
  z.object({
    ...base,
    type: z.literal("project.continued"),
    previousResult: Result,
    previousFinalPath: z.string(),
    note: z.string(),
    addTokens: z.number().int().min(0),
    addWaves: z.number().int().min(0),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("publication.requested"),
    publicationId: z.string(),
    decisionId: z.string(),
    terminalResult: Result,
    terminalFinalPath: z.string(),
    terminalReachedAtSeq: z.number().int().positive(),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("publication.drafted"),
    publicationId: z.string(),
    kind: PublicationKind,
    result: Result,
    title: z.string(),
    assessment: z.string(),
    texPath: z.string(),
    logPath: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("publication.compilationRequested"),
    publicationId: z.string(),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("publication.completed"),
    publicationId: z.string(),
    pdfPath: z.string(),
    compiler: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("publication.failed"),
    publicationId: z.string(),
    stage: z.enum(["drafting", "validation", "compilation"]),
    error: z.string(),
  }),
  z.object({ ...base, type: z.literal("autonomy.changed"), mode: z.enum(["auto", "gated"]), by: Actor }),
  z.object({ ...base, type: z.literal("models.changed"), models: ActiveModelSettings, by: Actor }),
  z.object({ ...base, type: z.literal("webSearch.changed"), enabled: z.boolean(), by: Actor }),
  z.object({ ...base, type: z.literal("project.settingsChanged"), settings: ProjectSettings, by: Actor }),

  // Intake & human channel
  z.object({ ...base, type: z.literal("intake.rawUpdated"), statement: z.string(), contextMarkdown: z.string(), by: Actor }),
  z.object({ ...base, type: z.literal("intake.completed"), problemMarkdown: z.string(), contextDigestMarkdown: z.string().optional(), rawMemories: z.array(IntakeMemory).optional(), ambiguities: z.array(Ambiguity), clarifications: z.array(Clarification).default([]) }),
  z.object({ ...base, type: z.literal("intake.sourcesUpdated"), sources: z.array(IntakeSource) }),
  z.object({ ...base, type: z.literal("intake.answered"), answers: z.array(ClarificationAnswer) }),
  z.object({ ...base, type: z.literal("intake.revised"), problemMarkdown: z.string(), notes: z.string() }),
  z.object({ ...base, type: z.literal("problem.confirmed"), problemMarkdown: z.string(), contextDigestMarkdown: z.string().optional(), rawMemories: z.array(IntakeMemory).optional() }),
  z.object({ ...base, type: z.literal("directive.submitted"), id: z.string(), text: z.string(), urgent: z.boolean() }),
  z.object({ ...base, type: z.literal("directive.consumed"), id: z.string(), decisionId: z.string() }),
  z.object({ ...base, type: z.literal("question.raised"), id: z.string(), text: z.string(), blocking: z.boolean(), context: z.string(), raisedBy: Actor, interaction: z.enum(["answer", "retry", "acknowledge"]).optional() }),
  z.object({ ...base, type: z.literal("question.answered"), id: z.string(), answer: z.string() }),
  z.object({ ...base, type: z.literal("question.dismissed"), id: z.string() }),
  z.object({ ...base, type: z.literal("human.intervention"), kind: z.string(), target: z.string(), note: z.string() }),

  // Decisions (Planner)
  z.object({ ...base, type: z.literal("decision.requested"), decisionId: z.string(), kind: DecisionKind, waveId: z.string().nullable() }),
  z.object({ ...base, type: z.literal("decision.proposed"), decisionId: z.string(), action: z.unknown(), usage: Usage.nullable() }),
  z.object({ ...base, type: z.literal("decision.rejected"), decisionId: z.string(), violations: z.array(z.string()) }),
  z.object({ ...base, type: z.literal("decision.accepted"), decisionId: z.string(), action: z.unknown() }),
  z.object({ ...base, type: z.literal("gate.opened"), decisionId: z.string() }),
  z.object({ ...base, type: z.literal("gate.resolved"), decisionId: z.string(), resolution: z.enum(["approve", "edit", "reject"]), action: z.unknown().optional(), note: z.string().optional() }),

  // Waves & tasks
  z.object({ ...base, type: z.literal("wave.planned"), waveId: z.string(), title: z.string(), decisionId: z.string(), roster: z.array(RosterEntry), reserveTokens: z.number().int().min(0), rationale: z.string() }),
  z.object({ ...base, type: z.literal("wave.softInterrupted"), waveId: z.string(), by: Actor }),
  z.object({ ...base, type: z.literal("wave.closed"), waveId: z.string(), docketMarkdown: z.string() }),
  z.object({ ...base, type: z.literal("wave.claimsCompared"), waveId: z.string(), conflictCheck: z.enum(["COMPLETE", "UNAVAILABLE"]).optional() }),
  z.object({ ...base, type: z.literal("task.dispatched"), taskId: z.string(), waveId: z.string(), role: WorkerRole, methodTag: z.string(), direction: z.string(), packetManifest: z.array(z.string()), budgetTokens: z.number().int().positive() }),
  z.object({ ...base, type: z.literal("task.session"), taskId: z.string(), threadId: z.string() }),
  z.object({ ...base, type: z.literal("task.progress"), taskId: z.string(), estimatedTokens: z.number().min(0), lastItem: z.object({ type: z.string(), preview: z.string() }).nullable() }),
  z.object({
    ...base,
    type: z.literal("task.completed"),
    taskId: z.string(),
    usage: Usage,
    /** Recovery may clear an obsolete validator error; ordinary repair history remains visible. */
    clearInvalidOutput: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("task.outputInvalid"), taskId: z.string(), errors: z.array(z.string()) }),
  z.object({ ...base, type: z.literal("task.interrupted"), taskId: z.string(), reason: z.string(), usage: Usage.nullable() }),
  // `usage` is optional so logs written before failed-call metering still replay.
  z.object({ ...base, type: z.literal("task.failed"), taskId: z.string(), error: z.string(), usage: Usage.nullable().optional() }),
  /**
   * Cumulative task charge, used when Codex ended before reporting exact
   * usage. Repeating the same total is intentionally idempotent in the reducer.
   */
  z.object({
    ...base,
    type: z.literal("task.accounted"),
    taskId: z.string(),
    chargedTokens: z.number().int().min(0),
    basis: z.enum(["reported", "estimated", "mixed"]),
  }),
  z.object({ ...base, type: z.literal("task.extended"), taskId: z.string(), addTokens: z.number().int().positive(), by: Actor }),
  z.object({
    ...base,
    type: z.literal("task.milestone"),
    milestoneId: z.string(),
    taskId: z.string(),
    title: z.string().min(1).max(160),
    markdown: z.string().min(1).max(4_000),
  }),
  z.object({
    ...base,
    type: z.literal("task.dispositioned"),
    taskId: z.string(),
    waveId: z.string(),
    disposition: z.enum(["carry_forward", "needs_precise_unblock", "set_aside"]),
    reason: z.string(),
    unblock: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal("crossexam.sent"), taskId: z.string(), decisionId: z.string(), refIds: z.array(z.string()), questionMarkdown: z.string() }),
  z.object({ ...base, type: z.literal("crossexam.answered"), taskId: z.string(), answerMarkdown: z.string(), usage: Usage.nullable() }),

  // Evidence
  z.object({ ...base, type: z.literal("artifact.recorded"), artifactId: z.string(), kind: ArtifactKind, taskId: z.string().nullable(), path: z.string(), conclusion: z.string().nullable() }),
  z.object({ ...base, type: z.literal("lineage.created"), lineageId: z.string(), title: z.string() }),
  z.object({ ...base, type: z.literal("lineage.abandoned"), lineageId: z.string(), reason: z.string() }),
  z.object({ ...base, type: z.literal("lineage.established"), lineageId: z.string(), candidateId: z.string() }),
  z.object({ ...base, type: z.literal("candidate.frozen"), candidateId: z.string(), lineageId: z.string(), version: z.number().int().positive(), fromArtifact: z.string(), obligations: z.array(z.string()), reviewQuestions: z.array(z.string()).default([]), usedClaimIds: z.array(z.string()), /** null = addresses problem.md in full; text = an explicitly narrower claim */ scopeMarkdown: z.string().nullable().default(null) }),
  z.object({ ...base, type: z.literal("review.recorded"), reviewId: z.string(), candidateId: z.string(), verdict: z.enum(["PASS", "FAIL"]), issueIds: z.array(z.string()), taskId: z.string() }),
  z.object({
    ...base,
    type: z.literal("claim.added"),
    claimId: z.string(),
    title: z.string().optional(),
    statement: z.string(),
    proofMarkdown: z.string().optional(),
    status: ClaimStatus,
    provenance: z.string(),
    sourceTaskId: z.string().nullable().default(null),
    sourceWaveId: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
    relationToGoal: ClaimRelation.optional(),
    kind: z.enum(["mathematical", "correction"]).optional(),
    targetFactId: z.string().nullable().optional(),
    verificationPolicy: z
      .object({
        verifiersPerClaim: z.number().int().positive(),
        passesRequired: z.number().int().positive(),
      })
      .optional(),
    dependsOn: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal("claim.status"), claimId: z.string(), from: ClaimStatus, to: ClaimStatus, justification: z.string(), by: Actor }),
  z.object({
    ...base,
    type: z.literal("claim.provenanceRepaired"),
    claimId: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("claim.equivalent"),
    leftClaimId: z.string(),
    rightClaimId: z.string(),
    reason: z.string(),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("claim.conflictRecorded"),
    leftClaimId: z.string(),
    rightClaimId: z.string(),
    reason: z.string().min(1).max(4_000),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("claim.conflictResolved"),
    leftClaimId: z.string(),
    rightClaimId: z.string(),
    reason: z.string().min(1).max(4_000),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("verification.requested"),
    evidenceRequired: z.boolean().optional(),
    verificationId: z.string(),
    claimId: z.string(),
    ordinal: z.number().int().positive(),
  }),
  z.object({
    ...base,
    type: z.literal("verification.started"),
    verificationId: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("verification.evidenceRecorded"),
    verificationId: z.string(),
    evidence: VerificationEvidenceSummary,
  }),
  z.object({
    ...base,
    type: z.literal("verification.completed"),
    verificationId: z.string(),
    verdict: VerificationVerdict,
    /** Optional so projects written before failure categories still replay. */
    finding: VerificationFinding.nullable().optional(),
    summaryMarkdown: z.string(),
    artifactPath: z.string().nullable(),
    usage: Usage.nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("fact.recorded"),
    factId: z.string(),
    claimId: z.string(),
    path: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("fact.suspicionRaised"),
    factId: z.string(),
    correctionClaimId: z.string(),
    reason: z.string(),
    by: Actor,
  }),
  z.object({
    ...base,
    type: z.literal("fact.retracted"),
    factId: z.string(),
    correctionClaimId: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("fact.suspicionCleared"),
    factId: z.string(),
    correctionClaimId: z.string(),
    reason: z.string(),
  }),
  z.object({ ...base, type: z.literal("issue.raised"), issueId: z.string(), candidateId: z.string(), severity: IssueSeverity, location: z.string(), summary: z.string(), by: Actor }),
  z.object({ ...base, type: z.literal("issue.resolved"), issueId: z.string(), disposition: z.enum(["repaired", "rejected", "stale"]), reason: z.string(), by: Actor }),
  z.object({
    ...base,
    type: z.literal("computation.recorded"),
    compId: z.string(),
    taskId: z.string(),
    entry: z.string(),
    inputsHash: z.string(),
    outputHash: z.string(),
    /** null when replaying a legacy event that did not record process status */
    exitCode: z.number().int().nullable().optional(),
    stderr: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("summary.recorded"),
    waveId: z.string(),
    path: z.string(),
    markdown: z.string(),
    abstract: z.string(),
    changed: z.boolean(),
    reason: z.string(),
    source: z.enum(["intake", "summary_reader", "human_edited", "fallback"]),
    usage: Usage.nullable(),
  }),
  z.object({ ...base, type: z.literal("wave.summaryReviewed"), waveId: z.string() }),
  z.object({
    ...base,
    type: z.literal("computation.baselineRepaired"),
    compId: z.string(),
    inputsHash: z.string(),
    outputHash: z.string(),
    exitCode: z.number().int().nullable(),
    stderr: z.string(),
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("computation.reproduced"),
    compId: z.string(),
    match: z.boolean(),
    outputHash: z.string(),
    exitCode: z.number().int().nullable().optional(),
    stderr: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("acceptance.evaluated"), candidateId: z.string(), passed: z.boolean(), failing: z.array(z.string()) }),

  // Memory
  z.object({ ...base, type: z.literal("memory.cardProposed"), cardId: z.string(), by: Actor, card: ProposedCard }),
  z.object({ ...base, type: z.literal("memory.cardAdmitted"), cardId: z.string(), status: CardStatus, reason: z.string() }),
  z.object({ ...base, type: z.literal("memory.cardStatus"), cardId: z.string(), from: CardStatus, to: CardStatus, reason: z.string(), by: Actor }),
  z.object({
    ...base,
    type: z.literal("memory.recall"),
    taskId: z.string(),
    op: z.enum([
      "search",
      "expand",
      "source_list",
      "source_open",
      "knowledge_search",
      "knowledge_open",
      "writeup_search",
      "writeup_open",
      "mark_milestone",
      "flag_fact",
    ]),
    args: z.string(),
    returnedIds: z.array(z.string()),
    refusedIds: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal("capsule.updated"), role: z.enum(["solver", "explorer", "reviewer"]), waveId: z.string(), path: z.string() }),
  z.object({
    ...base,
    type: z.literal("manager.noteRecorded"),
    waveId: z.string(),
    path: z.string(),
    markdown: z.string(),
    abstract: z.string().optional(),
    source: z.enum(["research_manager", "human_edited", "fallback"]),
  }),
  z.object({ ...base, type: z.literal("resolution.recorded"), waveId: z.string(), path: z.string() }),
  z.object({ ...base, type: z.literal("digest.updated") }),
]);

export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

/** All event type literals, for totality tests. */
export const EVENT_TYPES: readonly EventType[] = EventSchema.options.map(
  (o) => o.shape.type.value as EventType,
);
