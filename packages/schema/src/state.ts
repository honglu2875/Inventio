import { initialResearchState, type ResearchState } from "./research.js";
import type { VerificationEvidenceSummary } from "./verification-evidence.js";
import type {
  Ambiguity,
  Clarification,
  ArtifactKind,
  CardStatus,
  ClaimRelation,
  ClaimStatus,
  DecisionKind,
  IssueSeverity,
  IntakeMemory,
  IntakeSource,
  Phase,
  PublicationKind,
  ProposedCard,
  Result,
  RosterEntry,
  Usage,
  VerificationFinding,
  VerificationVerdict,
} from "./events.js";
import type { ProjectConfig, WorkerRole } from "./config.js";
import type { IdKind } from "./ids.js";

/**
 * ProjectState is the pure fold of the event log (DESIGN §5). It is plain
 * serializable data; the same reducer runs in the conductor and the UI.
 */

export type TaskStatus = "queued" | "running" | "completed" | "interrupted" | "failed";

export interface TaskState {
  id: string;
  waveId: string;
  role: WorkerRole;
  methodTag: string;
  direction: string;
  status: TaskStatus;
  budgetTokens: number;
  packetManifest: string[];
  threadId: string | null;
  estimatedTokens: number;
  /** Cumulative worker-token charge already applied to the project budget. */
  chargedTokens: number;
  lastItem: { type: string; preview: string } | null;
  usage: Usage | null;
  artifactIds: string[];
  reviewOf: string | null;
  computation: boolean;
  invalidOutputErrors: string[] | null;
  interruptReason: string | null;
  error: string | null;
  crossExams: { questionMarkdown: string; refIds: string[]; answerMarkdown: string | null }[];
  /** Curator's durable decision about whether and how later work should use this attempt. */
  disposition: "carry_forward" | "needs_precise_unblock" | "set_aside" | null;
  dispositionReason: string | null;
  preciseUnblock: string | null;
  /** Mathematical turning points recorded during a long v2 trajectory. */
  milestoneIds: string[];
}

export type WaveStatus = "open" | "softInterrupted" | "closed";

export interface WaveState {
  id: string;
  /** Event sequence at which this research round was accepted and created. */
  plannedAtSeq: number;
  title: string;
  status: WaveStatus;
  decisionId: string;
  roster: RosterEntry[];
  reserveTokens: number;
  rationale: string;
  taskIds: string[];
  docketMarkdown: string | null;
  resolutionPath: string | null;
  /** v2 summary reader has considered this round, including a no-change decision. */
  summaryReviewed: boolean;
  /** v2 has compared this round's statements for mathematical identity. */
  claimsCompared: boolean;
  /** Null means a historical comparison with no conflict-check contract. */
  conflictCheck: "COMPLETE" | "UNAVAILABLE" | null;
  claimsComparedAtSeq: number;
}

export interface ArtifactMeta {
  id: string;
  kind: ArtifactKind;
  taskId: string | null;
  path: string;
  conclusion: string | null;
  recordedAtSeq: number;
}

export interface LineageState {
  id: string;
  title: string;
  status: "active" | "abandoned" | "established";
  abandonReason: string | null;
  establishedCandidateId: string | null;
  versionIds: string[];
}

export interface CandidateState {
  id: string;
  lineageId: string;
  version: number;
  fromArtifact: string;
  obligations: string[];
  reviewQuestions: string[];
  usedClaimIds: string[];
  /** null = a candidate for the whole problem; text = a scoped partial result */
  scope: string | null;
  reviewIds: string[];
  issueIds: string[];
  acceptance: { passed: boolean; failing: string[] } | null;
}

export interface ReviewState {
  id: string;
  candidateId: string;
  verdict: "PASS" | "FAIL";
  issueIds: string[];
  taskId: string;
}

export interface ClaimState {
  id: string;
  title: string;
  statement: string;
  proofMarkdown: string;
  status: ClaimStatus;
  provenance: string;
  /** The proposing task, when known. Replayed legacy events infer this from provenance. */
  sourceTaskId: string | null;
  sourceWaveId: string | null;
  path: string | null;
  relationToGoal: ClaimRelation;
  kind: "mathematical" | "correction";
  targetFactId: string | null;
  /** Frozen when the claim is proposed; null only for replayed legacy claims. */
  verificationPolicy: { verifiersPerClaim: number; passesRequired: number } | null;
  dependsOn: string[];
  equivalentIds: string[];
  verificationIds: string[];
  promotedFactId: string | null;
  history: { from: ClaimStatus; to: ClaimStatus; justification: string; by: string; seq: number }[];
}

export interface ClaimConflictState {
  leftClaimId: string;
  rightClaimId: string;
  reason: string;
  status: "OPEN" | "RESOLVED";
  resolutionReason: string | null;
  recordedAtSeq: number;
  resolvedAtSeq: number | null;
}

export interface VerificationState {
  evidenceRequired: boolean;
  executionEvidence: VerificationEvidenceSummary | null;
  id: string;
  claimId: string;
  ordinal: number;
  status: "queued" | "running" | "completed";
  verdict: VerificationVerdict | null;
  finding: VerificationFinding | null;
  summaryMarkdown: string;
  artifactPath: string | null;
  usage: Usage | null;
  requestedAtSeq: number;
  completedAtSeq: number | null;
}

export interface FactState {
  id: string;
  claimId: string;
  title: string;
  statement: string;
  proofMarkdown: string;
  path: string;
  status: "ACTIVE" | "SUSPICIOUS" | "RETRACTED" | "SUPERSEDED";
  correctionClaimIds: string[];
  retractedByClaimId: string | null;
  /** Set when an equivalence relation later reveals a duplicate fact. */
  supersededByFactId: string | null;
  recordedAtSeq: number;
}

export interface MilestoneState {
  id: string;
  taskId: string;
  title: string;
  markdown: string;
  recordedAtSeq: number;
  recordedAt: string;
}

export interface IssueState {
  id: string;
  candidateId: string;
  severity: IssueSeverity;
  location: string;
  summary: string;
  by: string;
  status: "open" | "resolved";
  disposition: "repaired" | "rejected" | "stale" | null;
  dispositionReason: string | null;
}

export interface CardState {
  id: string;
  card: ProposedCard;
  proposedBy: string;
  status: CardStatus | "PENDING"; // PENDING = proposed, not yet through admission
  admissionReason: string | null;
}

export interface QuestionState {
  id: string;
  text: string;
  blocking: boolean;
  context: string;
  raisedBy: string;
  /** Whether the owner must answer, retry an operation, or only acknowledge it. */
  interaction: "answer" | "retry" | "acknowledge";
  status: "open" | "answered" | "dismissed";
  answer: string | null;
}

export interface DirectiveState {
  id: string;
  text: string;
  urgent: boolean;
  status: "pending" | "consumed";
  consumedByDecision: string | null;
}

export interface DecisionState {
  id: string;
  kind: DecisionKind;
  waveId: string | null;
  status: "requested" | "proposed" | "rejected" | "accepted" | "gated" | "gateResolved";
  action: unknown;
  violations: string[][];
  gateResolution: "approve" | "edit" | "reject" | null;
  plannerSpend: number;
}

export interface ComputationState {
  id: string;
  taskId: string;
  entry: string;
  inputsHash: string;
  outputHash: string;
  /** null means the baseline predates process-status recording. */
  exitCode: number | null;
  stderr: string;
  repairedReason: string | null;
  reproduced: {
    match: boolean;
    outputHash: string;
    /** null means the rerun predates process-status recording. */
    exitCode: number | null;
    stderr: string;
  } | null;
}

export interface BudgetState {
  totalTokens: number;
  /** worker spend (tasks), by the DESIGN §6.5 metric */
  spentTokens: number;
  /** planner/curation/intake/final spend */
  plannerSpentTokens: number;
}

export interface TerminalRecord {
  result: Result;
  finalPath: string;
  reachedAtSeq: number;
}

export interface ContinuationState {
  previousResult: Result;
  previousFinalPath: string;
  note: string;
  addTokens: number;
  addWaves: number;
  by: string;
  atSeq: number;
}

export type PublicationStatus = "drafting" | "drafted" | "compiling" | "ready" | "failed";

/**
 * One owner-requested, post-terminal publication review. It is tied to an
 * immutable stopping checkpoint: continuing research never rewrites an older
 * manuscript or its mathematical reassessment.
 */
export interface PublicationState {
  id: string;
  decisionId: string;
  status: PublicationStatus;
  terminalResult: Result;
  terminalFinalPath: string;
  terminalReachedAtSeq: number;
  requestedAtSeq: number;
  requestedBy: string;
  kind: PublicationKind | null;
  result: Result | null;
  title: string | null;
  assessment: string | null;
  texPath: string | null;
  pdfPath: string | null;
  logPath: string | null;
  compiler: string | null;
  failureStage: "drafting" | "validation" | "compilation" | null;
  error: string | null;
  completedAtSeq: number | null;
}

/** One recurrent Research Manager view, written at intake, a round, or a numbered continuation revision. */
export interface ResearchManagerNoteState {
  waveId: string;
  path: string;
  abstract: string;
  markdown: string;
  source: "research_manager" | "human_edited" | "fallback";
  recordedAtSeq: number;
  recordedAt: string;
}

/** Editable W000 followed by small, optional end-of-round revisions in v2. */
export interface MathematicalViewState {
  waveId: string;
  path: string;
  abstract: string;
  markdown: string;
  changed: boolean;
  reason: string;
  source: "intake" | "summary_reader" | "human_edited" | "fallback";
  recordedAtSeq: number;
  recordedAt: string;
}

export interface ProjectState {
  research: ResearchState;
  slug: string;
  title: string;
  config: ProjectConfig;
  seq: number;
  phase: Phase;
  paused: boolean;
  /** @deprecated Compatibility mirror of config.autonomy. */
  autonomy: "auto" | "gated";
  statement: string;
  /** Long owner-supplied notes, kept verbatim and separate from the objective. */
  contextMarkdown: string;
  problem: {
    normalizedMarkdown: string | null;
    confirmedMarkdown: string | null;
    contextDigestMarkdown: string;
    rawMemories: IntakeMemory[];
    /** Verbatim intake items with compact catalog descriptions. */
    sources: IntakeSource[];
    /** Latest event that changed the raw submission's text, membership, or bytes. */
    rawUpdatedAtSeq: number;
    ambiguities: Ambiguity[];
    /** open questions the owner can answer before confirming */
    clarifications: Clarification[];
    /** answers given so far, by clarification id */
    answers: Record<string, string>;
    /** true once the statement has been re-normalized against the answers */
    revised: boolean;
  };
  waves: Record<string, WaveState>;
  waveOrder: string[];
  tasks: Record<string, TaskState>;
  artifacts: Record<string, ArtifactMeta>;
  lineages: Record<string, LineageState>;
  activeLineageId: string | null;
  candidates: Record<string, CandidateState>;
  reviews: Record<string, ReviewState>;
  claims: Record<string, ClaimState>;
  claimOrder: string[];
  claimConflicts: ClaimConflictState[];
  facts: Record<string, FactState>;
  factOrder: string[];
  verifications: Record<string, VerificationState>;
  verificationOrder: string[];
  milestones: Record<string, MilestoneState>;
  milestoneOrder: string[];
  issues: Record<string, IssueState>;
  cards: Record<string, CardState>;
  questions: Record<string, QuestionState>;
  directives: Record<string, DirectiveState>;
  directiveOrder: string[];
  decisions: Record<string, DecisionState>;
  decisionOrder: string[];
  /** Chronological snapshots; the last entry is the Manager's current view. */
  researchManagerNotes: ResearchManagerNoteState[];
  /** v2 current mathematical view and its concise revision history. */
  mathematicalViews: MathematicalViewState[];
  computations: Record<string, ComputationState>;
  budget: BudgetState;
  openGateDecisionId: string | null;
  terminal: { result: Result; finalPath: string } | null;
  /** Every stopping report, including the current one when terminal. */
  terminalHistory: TerminalRecord[];
  /** Owner-authorized resumptions; prior reports remain immutable evidence. */
  continuations: ContinuationState[];
  /** Post-terminal manuscripts and reports, oldest first. */
  publications: PublicationState[];
  counters: Partial<Record<IdKind, number>>;
}

/** Latest publication attempt for the current stopping checkpoint, if any. */
export function currentTerminalPublication(state: ProjectState): PublicationState | null {
  const terminal = state.terminal;
  const checkpoint = state.terminalHistory.at(-1);
  if (!terminal || !checkpoint) return null;
  for (let index = state.publications.length - 1; index >= 0; index -= 1) {
    const publication = state.publications[index]!;
    if (
      publication.terminalReachedAtSeq === checkpoint.reachedAtSeq &&
      publication.terminalResult === terminal.result &&
      publication.terminalFinalPath === terminal.finalPath
    ) {
      return publication;
    }
  }
  return null;
}

/**
 * The latest intake decision is the only one that can still be running.
 * Keeping this derivation in the shared schema lets every UI client recover
 * the same busy state from a snapshot or SSE replay instead of relying on a
 * component-local loading flag.
 */
export function pendingIntakeDecision(state: ProjectState): DecisionState | null {
  for (let index = state.decisionOrder.length - 1; index >= 0; index -= 1) {
    const decision = state.decisions[state.decisionOrder[index]!]!;
    if (decision.kind !== "intake") continue;
    return decision.status === "requested" ? decision : null;
  }
  return null;
}

/**
 * Latest continuation awaiting its W###.n revised Manager view. A later wave
 * marks an older, pre-revision continuation that must not be rewritten during
 * replay after work has already begun.
 */
export function pendingContinuationRevision(
  state: ProjectState,
): ContinuationState | null {
  if (state.terminal !== null) return null;
  const continuation = state.continuations.at(-1);
  if (!continuation) return null;
  if (state.researchManagerNotes.some((note) => note.recordedAtSeq > continuation.atSeq)) {
    return null;
  }
  if (
    state.waveOrder.some(
      (waveId) => state.waves[waveId]!.plannedAtSeq > continuation.atSeq,
    )
  ) {
    return null;
  }
  return continuation;
}

/** W020 is version one at its checkpoint; renewed views are W020.2, .3, … */
export function nextContinuationRevisionId(state: ProjectState): string {
  const base = state.waveOrder.at(-1) ?? "W000";
  let highest = 1;
  const notes =
    state.config.workflow === "trajectories-v2"
      ? state.mathematicalViews
      : state.researchManagerNotes;
  for (const note of notes) {
    if (note.waveId === base) {
      highest = Math.max(highest, 1);
      continue;
    }
    if (!note.waveId.startsWith(`${base}.`)) continue;
    const suffix = Number(note.waveId.slice(base.length + 1));
    if (Number.isSafeInteger(suffix) && suffix >= 2) highest = Math.max(highest, suffix);
  }
  return `${base}.${highest + 1}`;
}

export function initialState(): ProjectState {
  return {
    research: initialResearchState(),
    slug: "",
    title: "",
    // populated by project.created; placeholder keeps the type total
    config: undefined as unknown as ProjectConfig,
    seq: 0,
    phase: "CREATED",
    paused: false,
    autonomy: "auto",
    statement: "",
    contextMarkdown: "",
    problem: {
      normalizedMarkdown: null,
      confirmedMarkdown: null,
      contextDigestMarkdown: "",
      rawMemories: [],
      sources: [],
      rawUpdatedAtSeq: 0,
      ambiguities: [],
      clarifications: [],
      answers: {},
      revised: false,
    },
    waves: {},
    waveOrder: [],
    tasks: {},
    artifacts: {},
    lineages: {},
    activeLineageId: null,
    candidates: {},
    reviews: {},
    claims: {},
    claimOrder: [],
    claimConflicts: [],
    facts: {},
    factOrder: [],
    verifications: {},
    verificationOrder: [],
    milestones: {},
    milestoneOrder: [],
    issues: {},
    cards: {},
    questions: {},
    directives: {},
    directiveOrder: [],
    decisions: {},
    decisionOrder: [],
    researchManagerNotes: [],
    mathematicalViews: [],
    computations: {},
    budget: { totalTokens: 0, spentTokens: 0, plannerSpentTokens: 0 },
    openGateDecisionId: null,
    terminal: null,
    terminalHistory: [],
    continuations: [],
    publications: [],
    counters: {},
  };
}
