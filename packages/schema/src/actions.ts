import { z } from "zod";
import { WorkerRole } from "./config.js";
import { CardStatus, CardType, Grants, IntakeMemory } from "./events.js";

/**
 * Research Manager action envelope (DESIGN §6.3). Deliberately flat: `action` names
 * the variant and exactly that variant's field must be non-null. The base
 * schema stays JSON-Schema-friendly (all fields required, nullable), and
 * `validateActionEnvelope` adds the cross-field rule for the conductor.
 */

export const PlannedTask = z.object({
  role: WorkerRole,
  methodTag: z.string().min(1).max(60),
  direction: z.string().min(1),
  briefMarkdown: z.string().min(1),
  tokenBudget: z.number().int().positive(),
  computation: z.boolean(),
  /**
   * Grant this task Codex's native web_search tool. Network reaches a worker
   * only as this explicit grant, and anything found is a citation requiring
   * provenance — never a proof (PROTOCOL §8).
   */
  webSearch: z.boolean(),
  /** Frozen candidate id this task audits; null unless role === "reviewer". */
  reviewOf: z.string().nullable(),
  grants: Grants,
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlanWave = z.object({
  title: z.string().min(1).max(120),
  rationale: z.string().min(1),
  reserveTokens: z.number().int().min(0),
  // The eight-seat limit applies only to creative/review assignments and is
  // checked against state in the deterministic validator. Synthesis is a
  // separate assembly role and therefore is not capped by this transport
  // schema (it remains bounded by budget and runtime concurrency).
  tasks: z.array(PlannedTask).min(1),
});
export type PlanWave = z.infer<typeof PlanWave>;

export const CrossExamine = z.object({
  rationale: z.string(),
  items: z
    .array(
      z.object({
        taskId: z.string(),
        refIds: z.array(z.string()),
        questionMarkdown: z.string().min(1),
      }),
    )
    .min(1)
    .max(6),
});
export type CrossExamine = z.infer<typeof CrossExamine>;

export const FreezeCandidate = z.object({
  /** Existing lineage to add a version to; null with newLineageTitle set to open one. */
  lineageId: z.string().nullable(),
  newLineageTitle: z.string().nullable(),
  fromArtifactId: z.string(),
  /** Known proof gaps. A candidate cannot pass acceptance while these remain. */
  obligations: z.array(z.string()),
  /** Adversarial points for referees to check; these are not admitted gaps. */
  reviewQuestions: z.array(z.string().min(1)).max(12).default([]),
  usedClaimIds: z.array(z.string()),
  /**
   * null when the candidate addresses the whole problem. Otherwise the exact
   * narrower statement it proves — a partial result, reviewed like any other
   * but never able to satisfy acceptance for problem.md.
   */
  scopeMarkdown: z.string().nullable(),
  rationale: z.string(),
});
export type FreezeCandidate = z.infer<typeof FreezeCandidate>;

export const RecordDispositions = z.object({
  items: z
    .array(
      z.object({
        issueId: z.string(),
        disposition: z.enum(["accepted", "rejected"]),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});
export type RecordDispositions = z.infer<typeof RecordDispositions>;

/** Cleanup for completed tasks left without curation, and explicit revision
 * of a non-final carry/follow-up disposition when later evidence changes it. */
export const AssessResults = z.object({
  items: z
    .array(
      z.object({
        taskId: z.string(),
        disposition: z.enum(["carry_forward", "needs_precise_unblock", "set_aside"]),
        reason: z.string().min(1),
        unblock: z.string().min(1).nullable(),
      }),
    )
    .min(1)
    .max(24),
});
export type AssessResults = z.infer<typeof AssessResults>;

export const AbandonLineage = z.object({
  lineageId: z.string(),
  reason: z.string().min(1),
});
export type AbandonLineage = z.infer<typeof AbandonLineage>;

export const RaiseQuestion = z.object({
  text: z.string().min(1),
  blocking: z.boolean(),
  context: z.string(),
});
export type RaiseQuestion = z.infer<typeof RaiseQuestion>;

export const Terminate = z.object({
  /** Result is always UNCERTAIN via this path; acceptance is mechanical. */
  rationale: z.string().min(1),
});
export type Terminate = z.infer<typeof Terminate>;

export const ACTION_NAMES = [
  "plan_wave",
  "cross_examine",
  "freeze_candidate",
  "assess_results",
  "record_dispositions",
  "abandon_lineage",
  "raise_question",
  "terminate",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const ActionEnvelope = z.object({
  action: z.enum(ACTION_NAMES),
  plan_wave: PlanWave.nullable(),
  cross_examine: CrossExamine.nullable(),
  freeze_candidate: FreezeCandidate.nullable(),
  assess_results: AssessResults.nullable(),
  record_dispositions: RecordDispositions.nullable(),
  abandon_lineage: AbandonLineage.nullable(),
  raise_question: RaiseQuestion.nullable(),
  terminate: Terminate.nullable(),
});
export type ActionEnvelope = z.infer<typeof ActionEnvelope>;

/** Structural validation beyond the base schema: exactly the named variant set. */
export function validateActionEnvelope(
  raw: unknown,
): { ok: true; envelope: ActionEnvelope } | { ok: false; errors: string[] } {
  const parsed = ActionEnvelope.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const env = parsed.data;
  const errors: string[] = [];
  for (const name of ACTION_NAMES) {
    const value = env[name];
    if (name === env.action && value === null) {
      errors.push(`action is "${env.action}" but field "${name}" is null`);
    }
    if (name !== env.action && value !== null) {
      errors.push(`field "${name}" must be null when action is "${env.action}"`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, envelope: env };
}

// ---------------------------------------------------------------------------
// Research Manager and intake special modes (DESIGN §6.3)
// ---------------------------------------------------------------------------

/**
 * Generated intake abstracts are navigation labels, not miniature outlines.
 * The prompt targets substantially less; this hard ceiling catches a model
 * filling the field until its JSON-schema limit and cutting off mid-sentence.
 */
export const INTAKE_ABSTRACT_MAX_CHARS = 320;
export const INTAKE_ABSTRACT_TARGET_CHARS = 220;

const CompleteSingleParagraphAbstract = z
  .string()
  .max(INTAKE_ABSTRACT_MAX_CHARS)
  .regex(/^(?:[^\r\n]*[.!?…。！？])?$/u, "must be one paragraph ending in a complete sentence");

export const IntakeOutput = z.object({
  /**
   * Compatibility fields retained for event replay and older simulated
   * replies. New intake calls copy the owner's objective here verbatim and do
   * not manufacture a second taxonomy of background notes.
   */
  problemMarkdown: z.string().min(1).max(12_000),
  contextDigestMarkdown: z.string().max(6_000).default(""),
  rawMemories: z.array(IntakeMemory).max(8).default([]),
  /** One or two complete sentences; never an outline or a truncated prefix. */
  managerAbstract: CompleteSingleParagraphAbstract.default(""),
  /** The Research Manager's free-form initial mathematical view. */
  managerNoteMarkdown: z.string().max(16_000).default(""),
  /** Short catalog entries for the immutable raw materials. */
  sourceSummaries: z.array(
    z.object({
      sourceId: z.string(),
      abstract: CompleteSingleParagraphAbstract.min(1),
      excerptMarkdown: z.string().max(4_000),
    }),
  ).max(64).default([]),
  ambiguities: z.array(
    z.object({
      text: z.string().min(1).max(500),
      material: z.boolean(),
      options: z.array(z.string().min(1).max(200)).max(4),
    }),
  ).max(3),
  /**
   * Questions worth putting to the owner, each answerable in a click. Ask only
   * what genuinely changes the mathematics — an empty list is the right answer
   * for a clear statement.
   */
  clarifications: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      kind: z.enum(["choice", "text"]),
      options: z.array(z.string()),
      why: z.string(),
      suggested: z.string(),
    }),
  ).max(3),
  notes: z.string().max(1_000),
});
export type IntakeOutput = z.infer<typeof IntakeOutput>;

/**
 * A short working-library card written by the curator, not a new proof.
 * Sources make the condensation reversible; the conductor derives the
 * persisted provenance and keeps every superseded source in the event log.
 */
export const CurationCardProposal = z.object({
  type: CardType,
  title: z.string().min(1).max(120),
  /** One to four terse sentences; the conductor enforces the sentence cap. */
  abstract: z.string().min(1).max(480),
  /** Conclusion-only theorem/lemma/example/remark blocks, never a work diary. */
  conclusionsMarkdown: z.string().min(1).max(4_000),
  tags: z.array(z.string().min(1).max(40)).max(8),
  sourceCardIds: z.array(z.string()).max(16),
  sourceArtifactIds: z.array(z.string()).max(16),
  /** Existing active, unverified cards replaced by this condensation. */
  supersedesCardIds: z.array(z.string()).max(16),
  /** Adds the ordinary `promising` tag and raises recall ranking. */
  promising: z.boolean(),
});
export type CurationCardProposal = z.infer<typeof CurationCardProposal>;

export const LibraryRetirement = z.object({
  cardId: z.string(),
  reason: z.string().min(1).max(500),
});
export type LibraryRetirement = z.infer<typeof LibraryRetirement>;

export const CurationOutput = z.object({
  /**
   * The Research Manager's rewritten current mathematical view. This is
   * deliberately free-form prose, persisted after every completed round, and
   * supplied again at the next decision. The default preserves old simulated
   * and in-flight replies during the migration.
   */
  managerNoteMarkdown: z.string().max(16_000).default(""),
  resolutionMarkdown: z.string().min(1),
  digestMarkdown: z.string().min(1),
  taskDispositions: z.array(
    z.object({
      taskId: z.string(),
      disposition: z.enum(["carry_forward", "needs_precise_unblock", "set_aside"]),
      reason: z.string().min(1),
      /** Required only for needs_precise_unblock; null otherwise. */
      unblock: z.string().min(1).nullable(),
    }),
  ),
  cardDecisions: z.array(
    z.object({
      cardId: z.string(),
      admit: z.boolean(),
      status: CardStatus,
      reason: z.string(),
    }),
  ),
  /** At most a few pristine condensations per round; each remains PROPOSED. */
  libraryAdditions: z.array(CurationCardProposal).max(4).default([]),
  /** Reversible removal from the working library; source evidence is retained. */
  libraryRetirements: z.array(LibraryRetirement).max(24).default([]),
  claimExtractions: z.array(
    z.object({
      statement: z.string().min(1),
      provenance: z.string(),
      fromTaskId: z.string(),
      dependsOn: z.array(z.string()),
    }),
  ).max(8),
  claimUpdates: z.array(
    z.object({
      claimId: z.string(),
      status: z.enum(["VERIFIED", "REFUTED", "SUPERSEDED"]),
      reason: z.string().min(1),
      /** Current-round sealed tasks that independently checked or corrected it. */
      evidenceTaskIds: z.array(z.string()).min(1).max(4),
    }),
  ).max(16).default([]),
  capsules: z.object({
    solver: z.string(),
    explorer: z.string(),
    reviewer: z.string(),
  }),
});
export type CurationOutput = z.infer<typeof CurationOutput>;

/** Re-normalization after the owner answers the clarification questions. */
export const IntakeRevision = z.object({
  problemMarkdown: z.string().min(1),
  notes: z.string(),
});
export type IntakeRevision = z.infer<typeof IntakeRevision>;

export const FinalOutput = z.object({ finalMarkdown: z.string().min(1) });
export type FinalOutput = z.infer<typeof FinalOutput>;

export const CrossExamAnswer = z.object({ answerMarkdown: z.string().min(1) });
export type CrossExamAnswer = z.infer<typeof CrossExamAnswer>;
