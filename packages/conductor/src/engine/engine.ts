import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ActiveModelSettings,
  ActionEnvelope,
  CrossExamAnswer,
  ContinuationRevisionOutput,
  CurationOutput,
  FinalOutput,
  IntakeOutput,
  IntakeRevision,
  ProjectSettings,
  applyEvent,
  candidateId as makeCandidateId,
  initialState,
  makeId,
  nextContinuationRevisionId,
  pendingIntakeDecision,
  pendingContinuationRevision,
  projectSettingsFromConfig,
  validateActionEnvelope,
  workerOutputSchema,
  type CardStatus,
  type Event,
  type IdKind,
  type IntakeMemory,
  type IntakeSource,
  type ModelChoice,
  type Phase,
  type ProjectConfig,
  type ProjectState,
  type Result,
  type RosterEntry,
  type TaskState,
  type Usage,
  type WorkerRole,
  repairLegacyArtifactControls,
  usageSpend,
} from "@inventio/schema";
import type { z } from "zod";
import { EventLog, type NewEvent } from "../store/eventLog.js";
import {
  createProjectDirs,
  defaultProjectFile,
  projectPaths,
  readProjectFile,
  writeFileAtomic,
  writeProjectFile,
  type ProjectPaths,
} from "../store/projectStore.js";
import { runStructured } from "../codex/structured.js";
import {
  addUsage,
  CODEX_TURN_BASE_TOKENS,
  ZERO_USAGE,
  type InterruptReason,
  type RunCodexOptions,
  type SandboxMode,
} from "../codex/runner.js";
import { WorkerPool } from "./pool.js";
import { composePacket } from "./packets.js";
import { buildDocket, type TaskOutcome } from "./docket.js";
import { validateAction, nextCandidateVersion } from "./validate.js";
import { evaluateAcceptance } from "./acceptance.js";
import {
  recordComputation,
  repairComputationBaseline,
  reproduceComputation,
} from "./computations.js";
import {
  CONTINUATION_REVISION_PROMPT,
  CURATION_PROMPT,
  DECISION_PROMPT,
  FINAL_PROMPT,
  intakePrompt,
  curationPacketFiles,
  continuationRevisionPacketFiles,
  decisionPacketFiles,
  finalPacketFiles,
  intakePacketFiles,
  intakeContextMarkdown,
  ledgerSummary,
  revisionPacketFiles,
  REVISION_PROMPT,
} from "../prompts/researchManager.js";
import {
  curationRetryNote,
  focusedFollowUpPrompt,
  freshWorkerReplacementPrompt,
  nextMoveCallRetryNote,
  rejectedNextMoveNote,
  unusableWorkCorrectionPrompt,
  workerLaunchPrompt,
  workerRestartPrompt,
} from "../prompts/operational.js";
import { serializeCard } from "../memory/cardStore.js";
import { returnedWorkProblems } from "./taskIntegrity.js";
import type { MemoryCard, RecallRecord, TaskScope } from "../memory/types.js";
import type { AnyWorkerOutput } from "@inventio/schema";
import {
  applyIntakeSourceSummaries,
  copyIntakeSourcesToPacket,
  indexIntakeSources,
} from "./intakeSources.js";

/** Narrow view of the memory service the engine needs (wired in main.ts). */
export interface MemoryAccess {
  url: string;
  mintToken(scope: TaskScope): string;
  revokeToken(token: string): void;
}

export interface EngineDeps {
  root: string;
  codexBin: string;
  pool: WorkerPool;
  memory: MemoryAccess | null;
  /** test overrides */
  taskWallClockMsOverride?: number;
  plannerWallClockMsOverride?: number;
  killGraceMs?: number;
  progressThrottleMs?: number;
}

const CAPSULE_CHAR_CAPS = { solver: 2500, explorer: 2000, reviewer: 2500 } as const;
const DIGEST_CHAR_CAP = 6400;

type CurationResult = z.infer<typeof CurationOutput>;

/** A legacy null worker model means account default, except that synthesis is
 * intentionally assigned to the smaller rigorous-assembly model. */
function effectiveWorkerModel(config: ProjectConfig, role: WorkerRole): ModelChoice {
  const configured = config.models[role];
  return role === "synthesizer" && configured.model === null
    ? { model: "gpt-5.6-terra", effort: configured.effort }
    : configured;
}

function validateTaskDispositions(out: CurationResult, outcomes: TaskOutcome[]): string[] {
  const expected = new Set(outcomes.map((outcome) => outcome.taskId));
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const item of out.taskDispositions) {
    if (!expected.has(item.taskId)) violations.push(`taskDispositions contains unknown task ${item.taskId}`);
    if (seen.has(item.taskId)) violations.push(`taskDispositions repeats ${item.taskId}`);
    seen.add(item.taskId);
    if (item.disposition === "needs_precise_unblock" && item.unblock === null) {
      violations.push(`${item.taskId} uses needs_precise_unblock but gives no exact question in the internal unblock field`);
    }
    if (item.disposition !== "needs_precise_unblock" && item.unblock !== null) {
      violations.push(`${item.taskId} must set the internal unblock field to null for ${item.disposition}`);
    }
  }
  for (const taskId of expected) {
    if (!seen.has(taskId)) violations.push(`taskDispositions is missing ${taskId}`);
  }
  const dispositions = new Map(out.taskDispositions.map((item) => [item.taskId, item.disposition]));
  for (const claim of out.claimExtractions) {
    if (!expected.has(claim.fromTaskId)) {
      violations.push(`claimExtractions cites unknown current-round task ${claim.fromTaskId}`);
    } else if (dispositions.get(claim.fromTaskId) === "set_aside") {
      violations.push(
        `claimExtractions cites ${claim.fromTaskId}, but that attempt was set aside; preserve it in the round summary rather than adding it to the current claims`,
      );
    }
  }
  return violations;
}

function abstractSentenceCount(text: string): number {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact === "") return 0;
  const marked = compact.match(/[.!?]+(?=\s|$)/g)?.length ?? 0;
  return Math.max(1, marked + (/[.!?]+$/.test(compact) ? 0 : 1));
}

const CONCLUSION_BLOCK = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Definition|Theorem|Proposition|Lemma|Corollary|Example|Computation|Obstruction|Question|Heuristic|Remark)\b/im;

/** Validate the curator's reversible working-library edits before any event is written. */
function validateLibraryEdits(state: ProjectState, out: CurationResult): string[] {
  const violations: string[] = [];
  const pending = new Set(
    Object.values(state.cards).filter((card) => card.status === "PENDING").map((card) => card.id),
  );
  const decided = new Set<string>();
  for (const decision of out.cardDecisions) {
    const card = state.cards[decision.cardId];
    if (!card) violations.push(`cardDecisions references unknown card ${decision.cardId}`);
    else if (card.status !== "PENDING") violations.push(`${decision.cardId} is not awaiting a decision`);
    if (decided.has(decision.cardId)) violations.push(`cardDecisions repeats ${decision.cardId}`);
    decided.add(decision.cardId);
  }
  for (const cardId of pending) {
    if (!decided.has(cardId)) violations.push(`cardDecisions is missing pending card ${cardId}`);
  }

  const retired = new Set<string>();
  out.libraryAdditions.forEach((addition, index) => {
    const label = `libraryAdditions[${index}]`;
    if (abstractSentenceCount(addition.abstract) > 4) {
      violations.push(`${label}.abstract exceeds four sentences`);
    }
    if (!CONCLUSION_BLOCK.test(addition.conclusionsMarkdown)) {
      violations.push(
        `${label}.conclusionsMarkdown must be organized as named mathematical conclusions, not a process narrative`,
      );
    }
    if (addition.sourceCardIds.length + addition.sourceArtifactIds.length === 0) {
      violations.push(`${label} has no source note or write-up from which a reader could recover the details`);
    }
    const normalizedTags = addition.tags.map((tag) => tag.toLowerCase());
    if (new Set(normalizedTags).size !== normalizedTags.length) violations.push(`${label} repeats a tag`);
    if (normalizedTags.includes("promising")) {
      violations.push(`${label} must express the promising marker only through promising=true`);
    }
    if (new Set(addition.sourceCardIds).size !== addition.sourceCardIds.length) {
      violations.push(`${label} repeats a source note`);
    }
    if (new Set(addition.sourceArtifactIds).size !== addition.sourceArtifactIds.length) {
      violations.push(`${label} repeats a source write-up`);
    }
    for (const cardId of addition.sourceCardIds) {
      if (!state.cards[cardId]) violations.push(`${label} cites unknown source note ${cardId}`);
    }
    for (const artifactId of addition.sourceArtifactIds) {
      if (!state.artifacts[artifactId]) violations.push(`${label} cites unknown source write-up ${artifactId}`);
    }
    for (const cardId of addition.supersedesCardIds) {
      const card = state.cards[cardId];
      if (!addition.sourceCardIds.includes(cardId)) {
        violations.push(`${label} supersedes ${cardId} without citing it as a source`);
      }
      if (!card) {
        violations.push(`${label} supersedes unknown card ${cardId}`);
      } else if (card.status !== "PROPOSED") {
        violations.push(
          `${label} may supersede only an active PROPOSED card; ${cardId} is ${card.status}`,
        );
      }
      if (retired.has(cardId)) violations.push(`${cardId} is retired more than once in one assessment`);
      retired.add(cardId);
    }
  });

  for (const retirement of out.libraryRetirements) {
    const card = state.cards[retirement.cardId];
    if (!card) violations.push(`libraryRetirements references unknown card ${retirement.cardId}`);
    else if (card.status !== "PROPOSED") {
      violations.push(
        `libraryRetirements may retire only an active PROPOSED card; ${retirement.cardId} is ${card.status}`,
      );
    }
    if (retired.has(retirement.cardId)) {
      violations.push(`${retirement.cardId} is retired more than once in one assessment`);
    }
    retired.add(retirement.cardId);
  }
  return violations;
}

function normalizeClaimStatement(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
}

function claimComesFromTask(claim: ProjectState["claims"][string], taskId: string): boolean {
  return claim.sourceTaskId === taskId || claim.provenance.includes(`(from ${taskId})`);
}

function validateClaimUpdates(
  state: ProjectState,
  out: CurationResult,
  outcomes: TaskOutcome[],
): string[] {
  const byTask = new Map(outcomes.map((outcome) => [outcome.taskId, outcome]));
  const seen = new Set<string>();
  const violations: string[] = [];
  for (const update of out.claimUpdates) {
    const claim = state.claims[update.claimId];
    if (!claim) {
      violations.push(`claimUpdates references unknown claim ${update.claimId}`);
      continue;
    }
    if (seen.has(update.claimId)) violations.push(`claimUpdates repeats ${update.claimId}`);
    seen.add(update.claimId);
    if (claim.status === update.status) {
      violations.push(`${update.claimId} is already ${update.status}`);
    }
    const originTask = claim.sourceTaskId ?? claim.provenance.match(/\(from (T\d+)\)/)?.[1] ?? null;
    const evidence = [...new Set(update.evidenceTaskIds)];
    if (evidence.length !== update.evidenceTaskIds.length) {
      violations.push(`${update.claimId} repeats a checking assignment`);
    }
    let hasIndependentConclusiveCheck = false;
    for (const taskId of evidence) {
      const outcome = byTask.get(taskId);
      if (!outcome) {
        violations.push(`${update.claimId} cites ${taskId}, which is not an assignment in this research round`);
        continue;
      }
      if (outcome.status !== "completed") {
        violations.push(`${update.claimId} cites ${taskId}, which did not complete`);
      }
      const conclusive =
        outcome.headline === "PROVED" ||
        outcome.headline === "DISPROVED" ||
        outcome.headline === "PASS" ||
        outcome.headline === "FAIL";
      let checksThisClaim = true;
      if (outcome.role === "reviewer") {
        const reviewedId = state.tasks[taskId]?.reviewOf ?? null;
        const candidate = reviewedId === null ? null : (state.candidates[reviewedId] ?? null);
        const candidateSourceTask = candidate
          ? (state.artifacts[candidate.fromArtifact]?.taskId ?? null)
          : null;
        checksThisClaim =
          candidate !== null &&
          (candidateSourceTask === originTask || candidate.usedClaimIds.includes(update.claimId));
        if (!checksThisClaim) {
          violations.push(
            `${update.claimId} cites reviewer ${taskId}, but that reviewer did not check its source write-up or receive it as a candidate dependency`,
          );
        }
        if (
          (update.status === "VERIFIED" && outcome.headline !== "PASS") ||
          (update.status === "REFUTED" && outcome.headline !== "FAIL")
        ) {
          checksThisClaim = false;
          violations.push(
            `${update.claimId} update to ${update.status} is inconsistent with reviewer ${taskId} verdict ${outcome.headline ?? "(none)"}`,
          );
        }
      }
      if (taskId !== originTask && conclusive && checksThisClaim) {
        hasIndependentConclusiveCheck = true;
      }
    }
    if (!hasIndependentConclusiveCheck) {
      violations.push(
        `${update.claimId} needs a completed conclusive check by a current-round task other than its original proposer`,
      );
    }
  }
  return violations;
}

function renderTaskDispositions(out: CurationResult): string {
  const labels = {
    carry_forward: "build on this result",
    needs_precise_unblock: "ask one focused follow-up",
    set_aside: "set aside",
  } as const;
  const lines = ["## Recommended use of each attempt", ""];
  for (const item of out.taskDispositions) {
    lines.push(`- **${item.taskId} — ${labels[item.disposition]}:** ${item.reason}`);
    if (item.unblock !== null) lines.push(`  - Exact follow-up: ${item.unblock}`);
  }
  return lines.join("\n");
}

/**
 * ProjectEngine: the per-project Conductor (DESIGN §6). One logical thread:
 * the main loop runs the protocol sequentially; external calls land as
 * events and wake it. The event log is the only mutation path.
 */
export class ProjectEngine extends EventEmitter {
  readonly slug: string;
  readonly paths: ProjectPaths;
  readonly state: ProjectState;
  private log: EventLog;
  private deps: EngineDeps;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private wakeWaiters: (() => void)[] = [];
  private killHandles = new Map<string, (reason: InterruptReason) => void>();
  private taskOutputs = new Map<string, AnyWorkerOutput>();
  private lastProgressAt = new Map<string, number>();
  private intakeRefreshInFlight = false;
  private interruptedIntakeChecked = false;
  private legacyComputationsChecked = false;

  private constructor(slug: string, deps: EngineDeps, log: EventLog, state: ProjectState) {
    super();
    this.slug = slug;
    this.deps = deps;
    this.paths = projectPaths(deps.root, slug);
    this.log = log;
    this.state = state;
  }

  static create(
    deps: EngineDeps,
    args: { slug: string; title: string; statement: string; contextMarkdown?: string; config: ProjectConfig },
  ): ProjectEngine {
    const paths = projectPaths(deps.root, args.slug);
    if (existsSync(paths.projectFile)) throw new Error(`project ${args.slug} already exists`);
    createProjectDirs(paths);
    writeProjectFile(paths, defaultProjectFile(args.slug, args.title, args.config));
    const log = EventLog.open(paths.eventsFile);
    const engine = new ProjectEngine(args.slug, deps, log, initialState());
    engine.emitEvent({
      type: "project.created",
      slug: args.slug,
      title: args.title,
      statement: args.statement,
      contextMarkdown: args.contextMarkdown ?? "",
      config: args.config,
    });
    return engine;
  }

  static load(deps: EngineDeps, slug: string): ProjectEngine {
    const paths = projectPaths(deps.root, slug);
    readProjectFile(paths); // validates presence
    const log = EventLog.open(paths.eventsFile);
    const state = initialState();
    for (const e of log.events) applyEvent(state, e);
    return new ProjectEngine(slug, deps, log, state);
  }

  // ------------------------------------------------------------------ core

  private emitEvent(partial: NewEvent): Event {
    const event = this.log.append(partial);
    applyEvent(this.state, event);
    this.emit("event", event);
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const w of waiters) w();
    return event;
  }

  private wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.wakeWaiters.push(resolve));
  }

  private async until(cond: () => boolean): Promise<void> {
    while (!this.stopped && !cond()) await this.wake();
  }

  private allocId(kind: IdKind): string {
    return makeId(kind, (this.state.counters[kind] ?? 0) + 1);
  }

  private remainingBudget(): number {
    return (
      this.state.budget.totalTokens -
      this.state.budget.spentTokens -
      this.state.budget.plannerSpentTokens
    );
  }

  private phaseTo(to: Phase, reason: string): void {
    if (this.state.phase !== to) {
      this.emitEvent({ type: "phase.changed", from: this.state.phase, to, reason });
    }
  }

  start(): void {
    if (this.loopPromise) return;
    const running = this.loop().catch((err) => {
      if (this.stopped) return;
      // The loop must never die silently: surface as a blocking question.
      try {
        this.emitEvent({
          type: "question.raised",
          id: this.allocId("question"),
          text: `The conductor stopped on an internal error: ${String(err).slice(0, 500)}. No mathematical answer is required; retry after correcting the runtime problem.`,
          blocking: true,
          context: "Operational recovery\nEffect: the current mathematical record is unchanged.",
          raisedBy: "conductor",
          interaction: "retry",
        });
      } catch {
        console.error("engine crashed and could not record it:", err);
      }
    });
    this.loopPromise = running;
    void running.finally(() => {
      if (this.loopPromise !== running) return;
      this.loopPromise = null;
      // A terminal loop can finish just as the owner authorizes a
      // continuation. If terminal state was cleared in that narrow window,
      // make sure the newly active project gets a fresh loop.
      if (!this.stopped && this.state.terminal === null) this.start();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const kill of this.killHandles.values()) kill("killed");
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const w of waiters) w();
    await this.loopPromise?.catch(() => undefined);
    this.log.close();
  }

  private blocked(): boolean {
    return (
      this.state.paused ||
      Object.values(this.state.questions).some((q) => q.status === "open" && q.blocking)
    );
  }

  private openWaveId(): string | null {
    for (const wid of this.state.waveOrder) {
      if (this.state.waves[wid]!.status !== "closed") return wid;
    }
    return null;
  }

  /** A round closes before its reconciliation call, so replay can resume it. */
  private pendingCurationWaveId(): string | null {
    for (const wid of this.state.waveOrder) {
      const wave = this.state.waves[wid]!;
      if (wave.status === "closed" && wave.resolutionPath === null) return wid;
    }
    return null;
  }

  private async loop(): Promise<void> {
    if (!this.interruptedIntakeChecked) {
      this.interruptedIntakeChecked = true;
      const interrupted = pendingIntakeDecision(this.state);
      if (interrupted && !this.intakeRefreshInFlight) {
        this.emitEvent({
          type: "decision.rejected",
          decisionId: interrupted.id,
          violations: [
            "The W000 reading was interrupted when the server stopped; the previous W000 was preserved and can be regenerated again.",
          ],
        });
      }
    }
    if (!this.legacyComputationsChecked) {
      this.legacyComputationsChecked = true;
      this.repairLegacyComputationBaselines();
    }
    while (!this.stopped) {
      if (this.state.terminal) return;
      if (this.blocked()) {
        await this.wake();
        continue;
      }
      const phase = this.state.phase;
      if (phase === "CREATED" || phase === "INTAKE") {
        await this.runIntake();
        continue;
      }
      if (phase === "AWAITING_CONFIRMATION") {
        if (this.state.problem.confirmedMarkdown !== null) {
          this.seedIntakeMemories(this.state.problem.rawMemories);
          this.phaseTo("DISCOVERY", "recovered confirmed problem");
          continue;
        }
        await this.wake();
        continue;
      }
      if (pendingContinuationRevision(this.state)) {
        await this.prepareContinuationRevision();
        continue;
      }
      const pendingCuration = this.pendingCurationWaveId();
      if (pendingCuration) {
        const wave = this.state.waves[pendingCuration]!;
        if (wave.docketMarkdown === null) throw new Error(`closed round ${pendingCuration} has no durable summary`);
        await this.runCuration(pendingCuration, wave.docketMarkdown, this.collectWaveOutcomes(pendingCuration));
        if (!this.stopped) await this.evaluateReviewWave(pendingCuration);
        continue;
      }
      const wid = this.openWaveId();
      if (wid) {
        await this.runWave(wid);
        continue;
      }
      await this.decisionPoint();
    }
  }

  // ----------------------------------------------- Research Manager process

  private async runResearchManagerCall<T>(
    decisionId: string,
    files: Record<string, string>,
    prompt: string,
    schema: z.ZodType<T>,
    options: {
      model?: ModelChoice;
      isolatedTask?: boolean;
      memoryAccess?: boolean;
      intakeSources?: IntakeSource[];
    } = {},
  ): Promise<{
    output: T | null;
    usage: Usage | null;
    error: string | null;
    status: "completed" | "interrupted" | "failed";
    interruptReason: string | null;
  }> {
    const dir = path.join(this.paths.decisionsDir, decisionId);
    const packetDir = path.join(dir, "packet");
    mkdirSync(packetDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(packetDir, name), content);
    }
    if (options.intakeSources) {
      copyIntakeSourcesToPacket(this.paths, options.intakeSources, packetDir);
    }
    const model = options.model ?? this.state.config.models.researchManager;
    const useMemory = options.memoryAccess ?? true;
    const decisionWaveId = this.state.decisions[decisionId]?.waveId;
    const token =
      useMemory && this.deps.memory
        ? this.deps.memory.mintToken({
            slug: this.slug,
            taskId: decisionId,
            role: "research_manager",
            waveId: decisionWaveId ?? "between-rounds",
          })
        : null;
    const killKey = `research-manager:${decisionId}`;
    let result;
    try {
      result = await runStructured(
        {
          bin: this.deps.codexBin,
          cwd: packetDir,
          prompt,
          sandbox: "read-only",
          eventsArchiveFile: path.join(dir, "codex-events.jsonl"),
          model: model.model,
          effort: model.effort,
          isolatedTask: options.isolatedTask ?? true,
          ...(this.deps.memory && token
            ? {
                mcp: {
                  serverName: "memory",
                  url: this.deps.memory.url,
                  tokenEnvVar: "INVENTIO_TASK_TOKEN",
                  token,
                },
              }
            : {}),
          outputSchemaFile: path.join(dir, "output-schema.json"),
          outputLastMessageFile: path.join(dir, "last-message.json"),
          wallClockMs: this.deps.plannerWallClockMsOverride ?? 20 * 60_000,
          killGraceMs: this.deps.killGraceMs ?? 10_000,
          registerKill: (kill) => this.killHandles.set(killKey, kill),
        },
        schema,
      );
    } finally {
      this.killHandles.delete(killKey);
      if (token) this.deps.memory?.revokeToken(token);
    }
    const usage = result.usage;
    if (result.status === "completed" && result.output !== null) {
      return {
        output: result.output,
        usage,
        error: null,
        status: result.status,
        interruptReason: result.interruptReason,
      };
    }
    const interruption =
      result.status === "interrupted"
        ? result.interruptReason === "timeout"
          ? "Research Manager timed out"
          : result.interruptReason === "killed"
            ? "Research Manager was stopped"
            : `Research Manager interrupted${result.interruptReason ? ` (${result.interruptReason})` : ""}`
        : null;
    return {
      output: null,
      usage,
      error:
        result.errorDetail ??
        (result.validationErrors
          ? `invalid Research Manager output: ${result.validationErrors.join("; ")}`
          : interruption ?? `Research Manager ${result.status}`),
      status: result.status,
      interruptReason: result.interruptReason,
    };
  }

  private fallbackContinuationRevision(): string {
    const continuation = this.state.continuations.at(-1);
    const previous = this.state.researchManagerNotes.at(-1)?.markdown.trim();
    return [
      "## Current mathematical view",
      "",
      "The previous stopping report remains an honest account of what had been established and what had failed. Renewed work is governed by the owner's direction below; any categorical recommendation in the preceding view is retained only where it is compatible with this broader instruction.",
      "",
      "## Direction for renewed research",
      "",
      continuation?.note.trim() ?? "Continue from the preceding report with a materially revised direction.",
      ...(previous ? ["", "## Earlier view retained for mathematical context", "", previous] : []),
    ].join("\n");
  }

  /** Revise recurrent context once, before the first decision of a resumed run. */
  private async prepareContinuationRevision(): Promise<void> {
    const continuation = pendingContinuationRevision(this.state);
    if (!continuation) return;

    const revisionId = nextContinuationRevisionId(this.state);
    const decisionId = this.allocId("decision");
    const previousWaveId = this.state.waveOrder.at(-1) ?? null;
    this.emitEvent({
      type: "decision.requested",
      decisionId,
      kind: "continuation_revision",
      waveId: previousWaveId,
    });

    const reportFile = path.join(this.paths.dir, continuation.previousFinalPath);
    const previousReport = existsSync(reportFile)
      ? readFileSync(reportFile, "utf8")
      : `The saved stopping report was expected at ${continuation.previousFinalPath}, but its text is unavailable.`;
    const previousView = this.state.researchManagerNotes.at(-1)?.markdown ?? null;
    const files = continuationRevisionPacketFiles(
      this.state,
      revisionId,
      previousView,
      previousReport,
    );
    const call = await this.runResearchManagerCall(
      decisionId,
      files,
      CONTINUATION_REVISION_PROMPT,
      ContinuationRevisionOutput,
    );
    if (this.stopped) return;

    this.emitEvent({
      type: "decision.proposed",
      decisionId,
      action: call.output,
      usage: call.usage,
    });
    if (call.output) {
      this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
      this.recordResearchManagerNote(
        revisionId,
        call.output.managerNoteMarkdown,
        "research_manager",
        call.output.managerAbstract,
      );
      return;
    }

    const failure = call.error ?? call.status;
    this.emitEvent({ type: "decision.rejected", decisionId, violations: [failure] });
    this.recordResearchManagerNote(
      revisionId,
      this.fallbackContinuationRevision(),
      "fallback",
      "Research resumes under the owner's new direction; the preceding view is retained only where compatible.",
    );
  }

  private raiseBlocking(
    text: string,
    context: string,
    interaction: "answer" | "retry" = "answer",
  ): void {
    this.emitEvent({
      type: "question.raised",
      id: this.allocId("question"),
      text,
      blocking: true,
      context,
      raisedBy: "conductor",
      interaction,
    });
  }

  // ---------------------------------------------------------------- intake

  /** Raw intake may change only before the owner accepts W000. */
  canReviseRawIntake(): boolean {
    return (
      !this.intakeRefreshInFlight &&
      pendingIntakeDecision(this.state) === null &&
      this.state.problem.confirmedMarkdown === null &&
      (this.state.phase === "CREATED" || this.state.phase === "AWAITING_CONFIRMATION")
    );
  }

  /** Used by the upload boundary to prevent source changes during a model read. */
  isRefreshingIntake(): boolean {
    return (
      this.intakeRefreshInFlight ||
      pendingIntakeDecision(this.state) !== null ||
      this.state.phase === "INTAKE"
    );
  }

  /**
   * Save an explicit owner revision and refresh the source index without
   * discarding the current W000. The following regeneration replaces W000 only
   * if the Research Manager returns a valid result, so a failed call loses no
   * human or model work. Calling this with unchanged text is still meaningful:
   * it incorporates upload additions, replacements, and removals into the
   * indexed raw materials.
   */
  updateRawIntake(statement: string, contextMarkdown: string): void {
    if (!this.canReviseRawIntake()) {
      throw new Error(`cannot revise raw intake in phase ${this.state.phase}`);
    }
    if (statement.trim() === "") throw new Error("the raw objective cannot be empty");
    if (statement !== this.state.statement || contextMarkdown !== this.state.contextMarkdown) {
      this.emitEvent({
        type: "intake.rawUpdated",
        statement,
        contextMarkdown,
        by: "human",
      });
    }
    this.refreshRawIntakeSources();
  }

  /** Re-index file changes made through the upload API before W000 is accepted. */
  refreshRawIntakeSources(): void {
    if (!this.canReviseRawIntake()) {
      throw new Error(`cannot revise raw intake in phase ${this.state.phase}`);
    }
    const sources = indexIntakeSources(this.paths, this.state.statement, this.state.contextMarkdown);
    this.emitEvent({ type: "intake.sourcesUpdated", sources });
  }

  private async generateIntake(): Promise<{ ok: boolean; error: string | null }> {
    const indexedSources = indexIntakeSources(
      this.paths,
      this.state.statement,
      this.state.contextMarkdown,
    );
    this.emitEvent({ type: "intake.sourcesUpdated", sources: indexedSources });
    const decisionId = this.allocId("decision");
    this.emitEvent({ type: "decision.requested", decisionId, kind: "intake", waveId: null });
    const call = await this.runResearchManagerCall(
      decisionId,
      intakePacketFiles(this.state.statement, this.state.contextMarkdown),
      intakePrompt(false),
      IntakeOutput,
      {
        model: this.state.config.models.researchManager,
        isolatedTask: true,
        memoryAccess: true,
        intakeSources: indexedSources,
      },
    );
    if (this.stopped) return { ok: false, error: "conductor stopping" };
    this.emitEvent({ type: "decision.proposed", decisionId, action: call.output, usage: call.usage });
    if (call.output) {
      this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
      const sources = applyIntakeSourceSummaries(
        this.paths,
        indexedSources,
        call.output.sourceSummaries,
      );
      this.emitEvent({ type: "intake.sourcesUpdated", sources });
      this.emitEvent({
        type: "intake.completed",
        problemMarkdown: call.output.problemMarkdown,
        contextDigestMarkdown: call.output.contextDigestMarkdown,
        rawMemories: call.output.rawMemories,
        ambiguities: call.output.ambiguities.map((a) => ({ ...a })),
        clarifications: call.output.clarifications,
      });
      const managerNote = call.output.managerNoteMarkdown.trim();
      this.recordResearchManagerNote(
        "W000",
        managerNote || this.fallbackInitialView(),
        managerNote ? "research_manager" : "fallback",
        call.output.managerAbstract.trim() || this.fallbackInitialAbstract(),
      );
      return { ok: true, error: null };
    }
    const error = call.error ?? "intake failed";
    this.emitEvent({ type: "decision.rejected", decisionId, violations: [error] });
    return { ok: false, error };
  }

  private async runIntake(): Promise<void> {
    if (this.state.phase === "CREATED") this.phaseTo("INTAKE", "project start");
    if (this.state.problem.normalizedMarkdown !== null) {
      this.phaseTo("AWAITING_CONFIRMATION", "intake already complete (recovery)");
      return;
    }
    const result = await this.generateIntake();
    if (this.stopped) return;
    if (!result.ok) {
      const rawContext = this.state.contextMarkdown.trim();
      const fallbackDigest =
        rawContext.length > 6_000
          ? `${rawContext.slice(0, 5_970)}\n\n(truncated; full notes remain in the original submission)`
          : rawContext;
      this.emitEvent({
        type: "intake.completed",
        problemMarkdown: this.state.statement,
        contextDigestMarkdown: fallbackDigest,
        rawMemories: [],
        ambiguities: [
          { text: "Automatic normalization failed; review and edit the statement manually.", material: true },
        ],
        clarifications: [],
      });
      this.recordResearchManagerNote(
        "W000",
        this.fallbackInitialView(),
        "fallback",
        this.fallbackInitialAbstract(),
      );
    }
    this.phaseTo("AWAITING_CONFIRMATION", "intake complete");
  }

  private fallbackInitialAbstract(): string {
    return "The Research Manager's initial reading did not complete; the original objective and materials remain available for another attempt.";
  }

  private fallbackInitialView(): string {
    return [
      "# Current mathematical view",
      "",
      "The initial Research Manager reading did not complete. No interpretation has been substituted for the owner's submission.",
      "",
      "Use the original objective and materials below, then regenerate or edit W000 before beginning research.",
    ].join("\n");
  }

  /**
   * Record the owner's answers to the intake questions and rewrite the
   * normalized statement against them. The owner still reads, edits and
   * confirms the result — this only saves them from doing the incorporation
   * by hand. Safe to call repeatedly while the project awaits confirmation.
   */
  async answerClarifications(answers: { id: string; answer: string }[]): Promise<void> {
    if (this.state.phase !== "AWAITING_CONFIRMATION") {
      throw new Error(`cannot answer clarifications in phase ${this.state.phase}`);
    }
    this.emitEvent({ type: "intake.answered", answers });

    const normalized = this.state.problem.normalizedMarkdown ?? this.state.statement;
    const qa = this.state.problem.clarifications.map((c) => ({
      question: c.question,
      why: c.why,
      suggested: c.suggested,
      answer: this.state.problem.answers[c.id] ?? null,
    }));
    if (qa.length === 0) return;

    const decisionId = this.allocId("decision");
    this.emitEvent({ type: "decision.requested", decisionId, kind: "intake", waveId: null });
    const call = await this.runResearchManagerCall(
      decisionId,
      revisionPacketFiles(this.state.statement, normalized, qa),
      REVISION_PROMPT,
      IntakeRevision,
      { model: this.state.config.models.intake, isolatedTask: true, memoryAccess: false },
    );
    this.emitEvent({ type: "decision.proposed", decisionId, action: call.output, usage: call.usage });
    if (call.output) {
      this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
      this.emitEvent({
        type: "intake.revised",
        problemMarkdown: call.output.problemMarkdown,
        notes: call.output.notes,
      });
    } else {
      // The owner can still edit and confirm by hand; nothing is lost.
      this.emitEvent({ type: "decision.rejected", decisionId, violations: [call.error ?? "revision failed"] });
    }
  }

  confirmProblem(
    problemMarkdown: string,
    contextDigestMarkdown?: string,
    rawMemories?: IntakeMemory[],
    managerAbstract?: string,
    managerNoteMarkdown?: string,
  ): void {
    if (this.state.phase !== "AWAITING_CONFIRMATION") {
      throw new Error(`cannot confirm problem in phase ${this.state.phase}`);
    }
    if (this.intakeRefreshInFlight || pendingIntakeDecision(this.state)) {
      throw new Error("W000 is still being regenerated; wait for the Research Manager reading to finish");
    }
    const currentW000 = this.state.researchManagerNotes.find((entry) => entry.waveId === "W000");
    if (
      this.state.problem.rawUpdatedAtSeq > 0 &&
      (!currentW000 || currentW000.recordedAtSeq < this.state.problem.rawUpdatedAtSeq)
    ) {
      throw new Error("cannot confirm an outdated W000; regenerate it from the revised raw intake first");
    }
    const confirmedDigest = contextDigestMarkdown ?? this.state.problem.contextDigestMarkdown;
    const confirmedMemories = rawMemories ?? this.state.problem.rawMemories;
    writeFileAtomic(this.paths.problemFile, problemMarkdown);
    if (confirmedDigest.trim()) {
      writeFileAtomic(path.join(this.paths.memoryDir, "intake-digest.md"), confirmedDigest);
    }
    if (managerNoteMarkdown !== undefined) {
      const note = managerNoteMarkdown.trim();
      if (note === "") throw new Error("W000 cannot be empty");
      const abstract = managerAbstract?.trim() ?? "";
      const current = this.state.researchManagerNotes.find((entry) => entry.waveId === "W000");
      if (!current || current.markdown.trim() !== note || current.abstract.trim() !== abstract) {
        this.recordResearchManagerNote("W000", note, "human_edited", abstract);
      }
    }
    this.emitEvent({
      type: "problem.confirmed",
      problemMarkdown,
      contextDigestMarkdown: confirmedDigest,
      rawMemories: confirmedMemories,
    });
    this.seedIntakeMemories(confirmedMemories);
    this.phaseTo("DISCOVERY", "problem confirmed by human");
  }

  /** Idempotent so replay can finish a confirmation interrupted between writes. */
  private seedIntakeMemories(memories: IntakeMemory[]): void {
    const existing = Object.values(this.state.cards).filter((card) => card.proposedBy === "human:intake");
    for (const [index, memory] of memories.entries()) {
      let stored = existing[index];
      if (!stored) {
        const cardId = this.allocId("card");
        this.emitEvent({
          type: "memory.cardProposed",
          cardId,
          by: "human:intake",
          card: {
            ...memory,
            provenance: "human intake context",
            sourceArtifact: null,
            dependsOn: [],
          },
        });
        stored = this.state.cards[cardId]!;
      }
      if (stored.status === "PENDING") {
        this.emitEvent({
          type: "memory.cardAdmitted",
          cardId: stored.id,
          status: "PROPOSED",
          reason: "Human-approved intake context; retained as an unverified lead.",
        });
      }
      if (this.state.cards[stored.id]!.status === "PROPOSED") {
        const card = this.state.cards[stored.id]!.card;
        const memoryCard: MemoryCard = { id: stored.id, status: "PROPOSED", ...card };
        writeFileAtomic(path.join(this.paths.cardsDir, `${stored.id}.md`), serializeCard(memoryCard));
      }
    }
  }

  /**
   * Prepare a newly created project from another project's human-reviewed
   * intake, without importing later research state or spending an intake model
   * call. The clone stops at confirmation so the owner can edit it before a
   * fresh research run begins.
   */
  initializeFromIntakeClone(
    problemMarkdown: string,
    managerAbstract: string,
    managerNoteMarkdown: string,
    sourceSummaries: IntakeSource[],
  ): void {
    if (this.state.phase !== "CREATED" || this.state.problem.normalizedMarkdown !== null) {
      throw new Error(`cannot initialize an intake clone in phase ${this.state.phase}`);
    }
    this.phaseTo("INTAKE", "starting from copied raw intake materials");
    const indexed = indexIntakeSources(this.paths, this.state.statement, this.state.contextMarkdown);
    const previousByContent = new Map(
      sourceSummaries.map((source) => [`${source.kind}:${source.sha256}`, source]),
    );
    const sources = applyIntakeSourceSummaries(
      this.paths,
      indexed,
      indexed.flatMap((source) => {
        const previous = previousByContent.get(`${source.kind}:${source.sha256}`);
        return previous
          ? [{ sourceId: source.id, abstract: previous.abstract, excerptMarkdown: previous.excerptMarkdown }]
          : [];
      }),
    );
    this.emitEvent({ type: "intake.sourcesUpdated", sources });
    this.emitEvent({
      type: "intake.completed",
      problemMarkdown,
      contextDigestMarkdown: "",
      rawMemories: [],
      ambiguities: [],
      clarifications: [],
    });
    this.recordResearchManagerNote(
      "W000",
      managerNoteMarkdown,
      "human_edited",
      managerAbstract,
    );
    this.phaseTo("AWAITING_CONFIRMATION", "copied W000 ready for owner review");
  }

  /** Re-run the single strong intake call while preserving the current summary on failure. */
  async regenerateIntake(): Promise<void> {
    if (this.state.phase !== "AWAITING_CONFIRMATION") {
      throw new Error(`cannot regenerate intake in phase ${this.state.phase}`);
    }
    if (this.intakeRefreshInFlight || pendingIntakeDecision(this.state)) {
      throw new Error("W000 regeneration is already running");
    }
    this.intakeRefreshInFlight = true;
    try {
      const result = await this.generateIntake();
      if (!result.ok) {
        throw new Error(`intake regeneration failed; the current summary was preserved: ${result.error}`);
      }
    } catch (error) {
      // `runStructured` normally returns a failed result, but filesystem or
      // process-boundary failures may throw. Do not leave every client showing
      // an intake request as permanently active until the next server restart.
      const pending = pendingIntakeDecision(this.state);
      if (pending && !this.stopped) {
        this.emitEvent({
          type: "decision.rejected",
          decisionId: pending.id,
          violations: [
            `W000 regeneration ended before a new reading was ready: ${error instanceof Error ? error.message : String(error)}`,
          ],
        });
      }
      throw error;
    } finally {
      this.intakeRefreshInFlight = false;
    }
  }

  // --------------------------------------------------------------- decision

  private async decisionPoint(): Promise<void> {
    if (this.remainingBudget() <= 0) {
      await this.finalize("UNCERTAIN", "token budget exhausted", null);
      return;
    }
    const decisionId = this.allocId("decision");
    this.emitEvent({ type: "decision.requested", decisionId, kind: "next_move", waveId: null });

    const digest = existsSync(this.paths.digestFile) ? readFileSync(this.paths.digestFile, "utf8") : null;
    const lastClosed = [...this.state.waveOrder]
      .reverse()
      .map((w) => this.state.waves[w]!)
      .find((w) => w.status === "closed");
    const resolutionFile = lastClosed?.resolutionPath
      ? path.join(this.paths.dir, lastClosed.resolutionPath)
      : null;
    const resolution = resolutionFile && existsSync(resolutionFile)
      ? readFileSync(resolutionFile, "utf8")
      : null;
    const previousTerminal = this.state.terminalHistory.at(-1);
    const previousReportFile = previousTerminal
      ? path.join(this.paths.dir, previousTerminal.finalPath)
      : null;
    const previousReport =
      previousReportFile && existsSync(previousReportFile)
        ? readFileSync(previousReportFile, "utf8")
        : null;
    const files = decisionPacketFiles(this.state, {
      digest,
      docket: lastClosed?.docketMarkdown ?? null,
      resolution,
      previousReport,
    });
    const activeCid = this.activeCandidateId();
    if (activeCid) {
      const artifact = this.state.artifacts[activeCid];
      if (artifact) files["candidate.md"] = readFileSync(path.join(this.paths.dir, artifact.path), "utf8");
    }

    // Consumption is recorded only after the packet has been composed: the
    // ledger lists *pending* directives, so consuming first would hide every
    // directive from the very decision that is meant to act on it (§6.2).
    for (const did of this.state.directiveOrder) {
      if (this.state.directives[did]!.status === "pending") {
        this.emitEvent({ type: "directive.consumed", id: did, decisionId });
      }
    }

    // A correction can expose a different validation error (for example, a
    // mathematically premature candidate followed by a mistyped reference).
    // Give the Research Manager enough turns to see and repair that second error before
    // asking the owner to intervene in an operational matter.
    const maxAttempts = 3;
    let envelope: ActionEnvelope | null = null;
    for (let attempt = 1; attempt <= maxAttempts && !this.stopped; attempt++) {
      const call = await this.runResearchManagerCall(decisionId, files, DECISION_PROMPT, ActionEnvelope);
      if (this.stopped) return;
      if (!call.output) {
        this.emitEvent({ type: "decision.proposed", decisionId, action: null, usage: call.usage });
        const failure = call.error ?? call.status;
        this.emitEvent({
          type: "decision.rejected",
          decisionId,
          violations: [`next-move call ${attempt} did not complete: ${failure}`],
        });
        if (attempt < maxAttempts) {
          files["retry-note.md"] = nextMoveCallRetryNote(failure);
          continue;
        }
        this.raiseBlocking(
          `The Research Manager did not complete after ${maxAttempts} automatic attempts: ${failure}. No mathematical answer is required; retry to continue from the unchanged record.`,
          `Operational recovery\nDecision: ${decisionId}\nEffect: no action was accepted and no research round was started.`,
          "retry",
        );
        return;
      }
      this.emitEvent({ type: "decision.proposed", decisionId, action: call.output, usage: call.usage });
      const structural = validateActionEnvelope(call.output);
      const violations = structural.ok
        ? validateAction(this.state, structural.envelope)
        : structural.errors;
      if (violations.length === 0) {
        envelope = structural.ok ? structural.envelope : null;
        break;
      }
      this.emitEvent({ type: "decision.rejected", decisionId, violations });
      if (attempt === maxAttempts) {
        this.raiseBlocking(
          `The Research Manager proposed an invalid move ${maxAttempts} times. Last violations: ${violations.join("; ")}. No mathematical answer is required; retry to choose from the unchanged record.`,
          `Operational recovery\nDecision: ${decisionId}\nEffect: no action was accepted and no research round was started.`,
          "retry",
        );
        return;
      }
      files["violations.md"] = rejectedNextMoveNote(violations);
    }
    if (!envelope) return;

    if (this.state.config.autonomy === "gated") {
      this.emitEvent({ type: "gate.opened", decisionId });
      await this.until(() => this.state.decisions[decisionId]!.status !== "gated");
      if (this.stopped) return;
      const d = this.state.decisions[decisionId]!;
      if (d.gateResolution === "reject") return; // note handled by resolveGate as a directive
      if (d.gateResolution === "edit") {
        const structural = validateActionEnvelope(d.action);
        const violations = structural.ok ? validateAction(this.state, structural.envelope) : structural.errors;
        if (violations.length > 0) {
          this.emitEvent({ type: "decision.rejected", decisionId, violations });
          this.raiseBlocking(
            `Your edited action for ${decisionId} is illegal: ${violations.join("; ")}`,
            `owner review of proposed move ${decisionId}`,
          );
          return;
        }
        envelope = structural.ok ? structural.envelope : envelope;
      }
    }

    this.emitEvent({ type: "decision.accepted", decisionId, action: envelope });
    await this.executeAction(decisionId, envelope);
  }

  private activeCandidateId(): string | null {
    const lid = this.state.activeLineageId;
    if (!lid) return null;
    return this.state.lineages[lid]!.versionIds.at(-1) ?? null;
  }

  private async executeAction(decisionId: string, envelope: ActionEnvelope): Promise<void> {
    switch (envelope.action) {
      case "plan_wave": {
        const plan = envelope.plan_wave!;
        const waveId = this.allocId("wave");
        const roster: RosterEntry[] = plan.tasks.map((t, i) => ({
          taskId: makeId("task", (this.state.counters.task ?? 0) + 1 + i),
          role: t.role,
          methodTag: t.methodTag,
          direction: t.direction,
          briefMarkdown: t.briefMarkdown,
          tokenBudget: t.tokenBudget,
          computation: t.computation,
          webSearch: t.webSearch,
          reviewOf: t.reviewOf,
          grants: t.grants,
        }));
        this.emitEvent({
          type: "wave.planned",
          waveId,
          title: plan.title,
          decisionId,
          roster,
          reserveTokens: plan.reserveTokens,
          rationale: plan.rationale,
        });
        const hasReviewer = roster.some((r) => r.role === "reviewer");
        const hasSynth = roster.some((r) => r.role === "synthesizer");
        const activeCid = this.activeCandidateId();
        const openIssues = activeCid
          ? this.state.candidates[activeCid]!.issueIds.some((i) => this.state.issues[i]!.status === "open")
          : false;
        this.phaseTo(
          hasReviewer ? "REVIEW" : hasSynth ? "SYNTHESIS" : openIssues ? "REPAIR" : "DISCOVERY",
          `wave ${waveId} planned`,
        );
        return;
      }
      case "cross_examine": {
        for (const item of envelope.cross_examine!.items) {
          await this.crossExamine(decisionId, item.taskId, item.refIds, item.questionMarkdown);
        }
        return;
      }
      case "freeze_candidate": {
        const f = envelope.freeze_candidate!;
        let lineageId = f.lineageId;
        if (!lineageId) {
          lineageId = this.allocId("lineage");
          this.emitEvent({ type: "lineage.created", lineageId, title: f.newLineageTitle ?? lineageId });
        }
        const version = nextCandidateVersion(this.state, lineageId);
        const cid = makeCandidateId(lineageId, version);
        const source = this.state.artifacts[f.fromArtifactId]!;
        const content = repairLegacyArtifactControls(
          readFileSync(path.join(this.paths.dir, source.path), "utf8"),
        );
        const relPath = path.join("artifacts", "candidates", `${cid}.md`);
        writeFileAtomic(path.join(this.paths.dir, relPath), content);
        this.emitEvent({
          type: "artifact.recorded",
          artifactId: cid,
          kind: "candidate",
          taskId: source.taskId,
          path: relPath,
          conclusion: source.conclusion,
        });
        this.emitEvent({
          type: "candidate.frozen",
          candidateId: cid,
          lineageId,
          version,
          fromArtifact: f.fromArtifactId,
          obligations: f.obligations,
          reviewQuestions: f.reviewQuestions,
          usedClaimIds: f.usedClaimIds,
          scopeMarkdown: f.scopeMarkdown,
        });
        this.phaseTo("REVIEW", `candidate ${cid} frozen`);
        return;
      }
      case "assess_results": {
        for (const item of envelope.assess_results!.items) {
          const task = this.state.tasks[item.taskId]!;
          this.emitEvent({
            type: "task.dispositioned",
            taskId: task.id,
            waveId: task.waveId,
            disposition: item.disposition,
            reason: item.reason,
            unblock: item.unblock,
          });
          if (item.disposition === "set_aside") {
            this.supersedeUnverifiedClaimsFromTask(task.id, item.reason, "planner");
          }
        }
        return;
      }
      case "record_dispositions": {
        const touched = new Set<string>();
        for (const item of envelope.record_dispositions!.items) {
          if (item.disposition === "rejected") {
            this.emitEvent({
              type: "issue.resolved",
              issueId: item.issueId,
              disposition: "rejected",
              reason: item.reason,
              by: "planner",
            });
          }
          touched.add(this.state.issues[item.issueId]!.candidateId);
        }
        // DESIGN §6.1(4): a disposition can clear the last blocking condition,
        // so the predicate must be able to terminate the project here too.
        for (const cid of touched) {
          if (this.evaluateAndMaybeFinalize(cid)) {
            await this.finalize(this.acceptedResult(cid), `acceptance predicate passed for ${cid}`, cid);
            return;
          }
          this.maybeEstablishScopedPartial(cid);
        }
        return;
      }
      case "abandon_lineage": {
        const lid = envelope.abandon_lineage!.lineageId;
        for (const cid of this.state.lineages[lid]!.versionIds) {
          for (const iid of this.state.candidates[cid]!.issueIds) {
            if (this.state.issues[iid]!.status === "open") {
              this.emitEvent({
                type: "issue.resolved",
                issueId: iid,
                disposition: "stale",
                reason: `lineage ${lid} abandoned`,
                by: "conductor",
              });
            }
          }
        }
        this.emitEvent({ type: "lineage.abandoned", lineageId: lid, reason: envelope.abandon_lineage!.reason });
        this.phaseTo("DISCOVERY", `lineage ${lid} abandoned`);
        return;
      }
      case "raise_question": {
        const q = envelope.raise_question!;
        this.emitEvent({
          type: "question.raised",
          id: this.allocId("question"),
          text: q.text,
          blocking: q.blocking,
          context: q.context,
          raisedBy: "planner",
        });
        return;
      }
      case "terminate": {
        await this.finalize("UNCERTAIN", envelope.terminate!.rationale, null);
        return;
      }
    }
  }

  private async crossExamine(
    decisionId: string,
    taskId: string,
    refIds: string[],
    questionMarkdown: string,
  ): Promise<void> {
    const task = this.state.tasks[taskId]!;
    const model = effectiveWorkerModel(this.state.config, task.role);
    this.emitEvent({ type: "crossexam.sent", taskId, decisionId, refIds, questionMarkdown });
    const dir = path.join(this.paths.tasksDir, taskId);
    const killKey = `crossexam:${taskId}`;
    let result;
    try {
      result = await runStructured(
        {
          bin: this.deps.codexBin,
          cwd: path.join(dir, "packet"),
          prompt: focusedFollowUpPrompt(refIds, questionMarkdown),
          sandbox: "read-only",
          resumeThreadId: task.threadId!,
          eventsArchiveFile: path.join(dir, "codex-events.jsonl"),
          model: model.model,
          effort: model.effort,
          outputSchemaFile: path.join(dir, "crossexam-schema.json"),
          outputLastMessageFile: path.join(dir, "crossexam-answer.json"),
          wallClockMs: this.deps.plannerWallClockMsOverride ?? 10 * 60_000,
          killGraceMs: this.deps.killGraceMs ?? 10_000,
          registerKill: (kill) => this.killHandles.set(killKey, kill),
        },
        CrossExamAnswer,
      );
    } finally {
      this.killHandles.delete(killKey);
    }
    // usage on the event meters cross-exam tokens as worker spend (reducer).
    this.emitEvent({
      type: "crossexam.answered",
      taskId,
      answerMarkdown:
        result.output?.answerMarkdown ?? `(no answer: ${result.errorDetail ?? result.status})`,
      usage: result.usage ?? null,
    });
  }

  // ------------------------------------------------------------------ waves

  private async runWave(waveId: string): Promise<void> {
    const wave = this.state.waves[waveId]!;
    const jobs = wave.roster.map((entry) =>
      this.deps.pool.run(() => this.executeTask(waveId, entry)),
    );
    await Promise.all(jobs);
    if (this.stopped) return;

    const outcomes = this.collectWaveOutcomes(waveId);
    const docket = buildDocket(waveId, wave.title, outcomes);
    this.emitEvent({ type: "wave.closed", waveId, docketMarkdown: docket });

    await this.runCuration(waveId, docket, outcomes);
    if (this.stopped) return;
    await this.evaluateReviewWave(waveId);
  }

  /** Reconstructible from state and validated task outputs for crash recovery. */
  private collectWaveOutcomes(waveId: string): TaskOutcome[] {
    const wave = this.state.waves[waveId]!;
    return wave.roster.map((entry) => {
      const t = this.state.tasks[entry.taskId]!;
      const output = this.taskOutputs.get(entry.taskId) ?? this.readTaskOutput(entry.taskId);
      const headline =
        output && "conclusion" in output ? output.conclusion : output && "verdict" in output ? output.verdict : null;
      const salvageFile = path.join(this.paths.tasksDir, entry.taskId, "salvage.md");
      const salvageExcerpt =
        t.status === "interrupted" && !output && existsSync(salvageFile)
          ? readFileSync(salvageFile, "utf8").slice(0, 1200)
          : undefined;
      return {
        taskId: t.id,
        role: t.role,
        methodTag: t.methodTag,
        status: t.status === "completed" ? "completed" : t.status === "failed" ? "failed" : "interrupted",
        headline,
        memo: output?.memo ?? null,
        interruptReason: t.interruptReason,
        error: t.error,
        ...(salvageExcerpt !== undefined ? { salvageExcerpt } : {}),
      };
    });
  }

  private async evaluateReviewWave(waveId: string): Promise<void> {
    const wave = this.state.waves[waveId]!;
    // Review waves: evaluate acceptance once per reviewed candidate.
    const reviewed = new Set(
      wave.roster.filter((r) => r.role === "reviewer" && r.reviewOf).map((r) => r.reviewOf!),
    );
    for (const cid of reviewed) {
      if (this.evaluateAndMaybeFinalize(cid)) {
        await this.finalize(
          this.state.candidates[cid]!.acceptance ? this.acceptedResult(cid) : "UNCERTAIN",
          `acceptance predicate passed for ${cid}`,
          cid,
        );
        return;
      }
      this.maybeEstablishScopedPartial(cid);
    }
  }

  private acceptedResult(cid: string): Result {
    const conclusion = this.state.artifacts[this.state.candidates[cid]!.fromArtifact]?.conclusion;
    return conclusion === "DISPROVED" ? "DISPROVED" : "PROVED";
  }

  private readTaskOutput(taskId: string): AnyWorkerOutput | null {
    const f = path.join(this.paths.tasksDir, taskId, "output.json");
    if (!existsSync(f)) return null;
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      const role = this.state.tasks[taskId]!.role;
      const parsed = workerOutputSchema(role).safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async executeTask(waveId: string, entry: RosterEntry): Promise<void> {
    if (this.stopped) return;
    const task = this.state.tasks[entry.taskId]!;
    if (task.status === "completed" || task.status === "failed" || task.status === "interrupted") return;

    const wave = this.state.waves[waveId]!;
    const resuming = task.status === "running"; // stale from a crash
    if (resuming && task.threadId === null) {
      this.emitEvent({ type: "task.interrupted", taskId: task.id, reason: "conductor-restart", usage: null });
      return;
    }
    if (!resuming && wave.status === "softInterrupted") {
      this.emitEvent({ type: "task.interrupted", taskId: task.id, reason: "wave-soft-interrupt", usage: null });
      return;
    }

    const taskDir = path.join(this.paths.tasksDir, entry.taskId);
    let packetDir: string;
    let manifest: string[] = [];
    try {
      if (resuming) {
        packetDir = path.join(taskDir, "packet");
      } else {
        const composed = this.composeTaskPacket(waveId, entry);
        packetDir = composed.packetDir;
        manifest = composed.manifest;
        this.emitEvent({
          type: "task.dispatched",
          taskId: entry.taskId,
          waveId,
          role: entry.role,
          methodTag: entry.methodTag,
          direction: entry.direction,
          packetManifest: manifest,
          budgetTokens: entry.tokenBudget,
        });
      }
    } catch (err) {
      this.emitEvent({ type: "task.failed", taskId: entry.taskId, error: `packet composition: ${String(err)}` });
      return;
    }

    const token = this.deps.memory?.mintToken({
      slug: this.slug,
      taskId: entry.taskId,
      role: entry.role,
      waveId,
    });
    const model = effectiveWorkerModel(this.state.config, entry.role);
    const packetSize = manifest.reduce((acc, rel) => {
      try {
        return acc + statSync(path.join(packetDir, rel)).size;
      } catch {
        return acc;
      }
    }, 0);
    // Packets created by current Inventio use research-question.md. Keep the
    // assignment.md fallback solely so an in-flight task from an older project
    // can resume after an upgrade; no current prompt composer writes that name.
    const questionFile = existsSync(path.join(packetDir, "research-question.md"))
      ? "research-question.md"
      : "assignment.md";

    try {
      let accumulatedUsage: Usage = ZERO_USAGE;
      const runOptions: RunCodexOptions = {
        bin: this.deps.codexBin,
        cwd: packetDir,
        prompt: resuming
          ? workerRestartPrompt(questionFile)
          : workerLaunchPrompt(questionFile),
        sandbox: (entry.computation ? "workspace-write" : "read-only") as SandboxMode,
        webSearch: entry.webSearch && this.state.config.allowWebSearch,
        eventsArchiveFile: path.join(taskDir, "codex-events.jsonl"),
        model: model.model,
        effort: model.effort,
        outputSchemaFile: path.join(taskDir, "output-schema.json"),
        outputLastMessageFile: path.join(taskDir, "last-message.json"),
        ...(resuming ? { resumeThreadId: task.threadId! } : {}),
        ...(this.deps.memory && token
          ? {
              mcp: {
                serverName: "memory",
                url: this.deps.memory.url,
                tokenEnvVar: "INVENTIO_TASK_TOKEN",
                token,
              },
            }
          : {}),
        maxEstimatedTokens: () =>
          Math.max(
            1,
            this.state.tasks[entry.taskId]!.budgetTokens * 1.1 - usageSpend(accumulatedUsage),
          ),
        baseEstimatedTokens: CODEX_TURN_BASE_TOKENS + Math.ceil(packetSize / 4),
        wallClockMs:
          this.deps.taskWallClockMsOverride ?? this.state.config.budget.taskWallClockMinutes * 60_000,
        killGraceMs: this.deps.killGraceMs ?? 10_000,
        onThread: (threadId) => {
          if (this.state.tasks[entry.taskId]!.threadId !== threadId) {
            this.emitEvent({ type: "task.session", taskId: entry.taskId, threadId });
          }
        },
        registerKill: (kill) => this.killHandles.set(entry.taskId, kill),
        onProgress: ({ estimatedTokens, lastItem }) => {
          const now = Date.now();
          const last = this.lastProgressAt.get(entry.taskId) ?? 0;
          if (now - last >= (this.deps.progressThrottleMs ?? 2000)) {
            this.lastProgressAt.set(entry.taskId, now);
            this.emitEvent({ type: "task.progress", taskId: entry.taskId, estimatedTokens, lastItem });
          }
        },
      };
      const runWorker = async (options: RunCodexOptions) => {
        const next = await runStructured<AnyWorkerOutput>(
          options,
          workerOutputSchema(entry.role),
          {
            onInvalidOutput: (errors) =>
              this.emitEvent({ type: "task.outputInvalid", taskId: entry.taskId, errors }),
          },
        );
        accumulatedUsage = addUsage(accumulatedUsage, next.usage);
        return next;
      };

      let result = await runWorker(runOptions);
      let usabilityProblems =
        result.status === "completed" && result.output
          ? returnedWorkProblems(entry.role, result.output)
          : [];

      if (usabilityProblems.length > 0) {
        this.emitEvent({
          type: "task.outputInvalid",
          taskId: entry.taskId,
          errors: usabilityProblems.map((problem) => `unusable returned work: ${problem}`),
        });

        // One short follow-up to the same researcher preserves any genuine work
        // hidden behind the derailment. It is never surfaced as a human gate.
        const resumeThreadId = result.threadId ?? this.state.tasks[entry.taskId]!.threadId;
        if (resumeThreadId) {
          result = await runWorker({
            ...runOptions,
            resumeThreadId,
            prompt: unusableWorkCorrectionPrompt(usabilityProblems),
          });
          usabilityProblems =
            result.status === "completed" && result.output
              ? returnedWorkProblems(entry.role, result.output)
              : [];
          if (usabilityProblems.length > 0) {
            this.emitEvent({
              type: "task.outputInvalid",
              taskId: entry.taskId,
              errors: usabilityProblems.map((problem) => `unusable after one unblock: ${problem}`),
            });
          }
        }

        const needsFreshWorker =
          result.status === "failed" ||
          (result.status === "completed" && result.output !== null && usabilityProblems.length > 0);
        if (needsFreshWorker) {
          const freshOptions: RunCodexOptions = {
            ...runOptions,
            prompt: freshWorkerReplacementPrompt(questionFile),
          };
          delete freshOptions.resumeThreadId;
          result = await runWorker(freshOptions);
          usabilityProblems =
            result.status === "completed" && result.output
              ? returnedWorkProblems(entry.role, result.output)
              : [];
          if (usabilityProblems.length > 0) {
            this.emitEvent({
              type: "task.outputInvalid",
              taskId: entry.taskId,
              errors: usabilityProblems.map((problem) => `fresh replacement also unusable: ${problem}`),
            });
          }
        }
      }

      writeFileAtomic(
        path.join(taskDir, "meta.json"),
        JSON.stringify(
          {
            threadId: result.threadId,
            status: result.status,
            model: model.model,
            effort: model.effort,
            usage: accumulatedUsage,
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      if (result.status === "completed" && result.output && usabilityProblems.length === 0) {
        writeFileAtomic(path.join(taskDir, "output.json"), JSON.stringify(result.output, null, 2));
        this.taskOutputs.set(entry.taskId, result.output);
        this.emitEvent({ type: "task.completed", taskId: entry.taskId, usage: accumulatedUsage });
        this.materializeTaskReturn(waveId, entry, result.output, packetDir);
      } else if (result.status === "interrupted") {
        if (result.lastAgentMessage) {
          writeFileAtomic(path.join(taskDir, "salvage.md"), result.lastAgentMessage);
        }
        this.emitEvent({
          type: "task.interrupted",
          taskId: entry.taskId,
          reason: result.interruptReason ?? "interrupted",
          usage: accumulatedUsage,
        });
      } else {
        this.emitEvent({
          type: "task.failed",
          taskId: entry.taskId,
          error:
            (usabilityProblems.length > 0
              ? `returned work unusable after unblock and fresh replacement: ${usabilityProblems.join("; ")}`
              : null) ??
            (result.validationErrors ? `output invalid after repair: ${result.validationErrors.join("; ")}` : null) ??
            result.errorDetail ??
            "unknown failure",
        });
      }
    } finally {
      this.killHandles.delete(entry.taskId);
      if (token) this.deps.memory?.revokeToken(token);
    }
  }

  private composeTaskPacket(waveId: string, entry: RosterEntry): { packetDir: string; manifest: string[] } {
    const wave = this.state.waves[waveId]!;
    const sealed = new Set<string>(
      Object.values(this.state.artifacts)
        .filter((a) => a.taskId !== null && wave.taskIds.includes(a.taskId))
        .map((a) => a.id),
    );
    const capsulePath = path.join(this.paths.capsulesDir, `${entry.role}.md`);
    const capsule =
      entry.role !== "synthesizer" && existsSync(capsulePath) ? readFileSync(capsulePath, "utf8") : null;
    const claimLedger =
      entry.role === "reviewer"
        ? this.state.claimOrder.length === 0
          ? "# Relevant recorded claims\n\n(none)"
          : [
              "# Relevant recorded claims",
              "",
              "| ID | Status | Statement | Source |",
              "|---|---|---|---|",
              ...this.state.claimOrder.map((kid) => {
                const k = this.state.claims[kid]!;
                return `| ${k.id} | ${k.status} | ${k.statement.replace(/\|/g, "/")} | ${k.provenance.replace(/\|/g, "/")} |`;
              }),
            ].join("\n")
        : null;
    return composePacket({
      tasksDir: this.paths.tasksDir,
      taskId: entry.taskId,
      role: entry.role,
      methodTag: entry.methodTag,
      direction: entry.direction,
      briefMarkdown: entry.briefMarkdown,
      tokenBudget: entry.tokenBudget,
      computation: entry.computation,
      webSearch: entry.webSearch && this.state.config.allowWebSearch,
      reviewOf: entry.reviewOf,
      reviewScope: entry.reviewOf ? (this.state.candidates[entry.reviewOf]?.scope ?? null) : null,
      reviewQuestions: entry.reviewOf
        ? (this.state.candidates[entry.reviewOf]?.reviewQuestions ?? [])
        : [],
      problemMarkdown: this.state.problem.confirmedMarkdown ?? this.state.statement,
      intakeContextMarkdown: entry.role === "reviewer" ? null : intakeContextMarkdown(this.state),
      capsuleMarkdown: capsule,
      grantedArtifacts: entry.grants.artifactIds.map((id) => ({
        id,
        sourcePath: path.join(this.paths.dir, this.state.artifacts[id]!.path),
      })),
      grantedCards: entry.grants.cardIds.flatMap((id) => {
        const f = path.join(this.paths.cardsDir, `${id}.md`);
        return existsSync(f) ? [{ id, markdown: readFileSync(f, "utf8") }] : [];
      }),
      sourceMounts: entry.grants.sourceMounts.map((name) => ({
        name,
        sourcePath: this.state.config.sourceMounts.find((m) => m.name === name)!.path,
      })),
      claimLedgerMarkdown: claimLedger,
      memoryIndexMarkdown: this.memoryIndexFor(entry.role),
      memoryToolsAvailable: this.deps.memory !== null,
      sealedArtifactIds: sealed,
    });
  }

  /**
   * The memory catalog as a packet file, filtered by role (PROTOCOL §7).
   * Reviewers see only VERIFIED records; everyone else sees admitted records
   * plus QUARANTINED ones rendered as explicit warnings. Cards still PENDING
   * admission are current-wave material and never appear.
   */
  private memoryIndexFor(role: WorkerRole): string | null {
    const rows = Object.values(this.state.cards)
      .filter((c) => {
        if (role === "reviewer") return c.status === "VERIFIED";
        return c.status === "PROPOSED" || c.status === "VERIFIED" || c.status === "QUARANTINED";
      })
      .sort((a, b) => {
        const ap = a.card.tags.includes("promising") ? 1 : 0;
        const bp = b.card.tags.includes("promising") ? 1 : 0;
        return bp - ap || a.id.localeCompare(b.id);
      });
    if (rows.length === 0) return null;

    const lines: string[] = [
      "# Earlier research notes",
      "",
      "Short descriptions of useful earlier work. Full text supplied for this assignment is under",
      "`references/library-notes/`; this file contains abstracts only.",
      "",
    ];
    const quarantined = rows.filter((c) => c.status === "QUARANTINED");
    for (const card of rows.filter((c) => c.status !== "QUARANTINED")) {
      lines.push(
        `- **${card.id}** [${card.status}] ${card.card.type} — ${card.card.title}` +
          `\n  ${card.card.abstract}` +
          `\n  source: ${card.card.provenance}` +
          (card.card.tags.length ? `; tags: ${card.card.tags.join(", ")}` : ""),
      );
    }
    if (quarantined.length > 0) {
      lines.push(
        "",
        "## Warnings — never use these as facts",
        "",
      );
      for (const card of quarantined) {
        lines.push(`- ⚠ **${card.id}** ${card.card.title} — ${card.card.abstract} (${card.admissionReason ?? "flagged as unreliable"})`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  private materializeTaskReturn(
    waveId: string,
    entry: RosterEntry,
    output: AnyWorkerOutput,
    packetDir: string,
  ): void {
    // Artifact
    const kind = entry.role === "explorer" ? "exploration" : entry.role === "reviewer" ? "review" : "attempt";
    const idKind: IdKind = entry.role === "explorer" ? "exploration" : entry.role === "reviewer" ? "review" : "attempt";
    const artifactId = this.allocId(idKind);
    const relPath = path.join(
      "artifacts",
      kind === "attempt" ? "attempts" : kind === "exploration" ? "explorations" : "reviews",
      `${artifactId}.md`,
    );
    writeFileAtomic(path.join(this.paths.dir, relPath), output.artifactMarkdown);
    const conclusion = "conclusion" in output ? output.conclusion : output.verdict;
    this.emitEvent({
      type: "artifact.recorded",
      artifactId,
      kind,
      taskId: entry.taskId,
      path: relPath,
      conclusion,
    });

    // Reviewer: issues + review record
    if (entry.role === "reviewer" && "verdict" in output && entry.reviewOf) {
      const issueIds: string[] = [];
      for (const issue of output.memo.issues) {
        const issueId = this.allocId("issue");
        issueIds.push(issueId);
        this.emitEvent({
          type: "issue.raised",
          issueId,
          candidateId: entry.reviewOf,
          severity: issue.severity,
          location: issue.location,
          summary: `${issue.summary}${issue.repairHint ? ` — smallest repair: ${issue.repairHint}` : ""}`,
          by: artifactId,
        });
      }
      this.emitEvent({
        type: "review.recorded",
        reviewId: artifactId,
        candidateId: entry.reviewOf,
        verdict: output.verdict,
        issueIds,
        taskId: entry.taskId,
      });
    }

    // Proposed memory cards (admission happens at curation)
    for (const card of output.memo.proposedCards) {
      const cardId = this.allocId("card");
      this.emitEvent({
        type: "memory.cardProposed",
        cardId,
        by: entry.taskId,
        card: { ...card, sourceArtifact: artifactId, dependsOn: [] },
      });
    }

    // Computations
    if (entry.computation && output.memo.computations.length > 0) {
      const scratch = path.join(packetDir, "scratch");
      if (existsSync(scratch)) {
        for (const comp of output.memo.computations) {
          const compId = this.allocId("computation");
          try {
            const rec = recordComputation(this.paths.computationsDir, compId, scratch, comp.entry);
            this.emitEvent({
              type: "computation.recorded",
              compId,
              taskId: entry.taskId,
              entry: comp.entry,
              inputsHash: rec.inputsHash,
              outputHash: rec.outputHash,
              exitCode: rec.exitCode,
              stderr: rec.stderr,
            });
            const rep = reproduceComputation(this.paths.computationsDir, compId);
            this.emitEvent({
              type: "computation.reproduced",
              compId,
              match: rep.match,
              outputHash: rep.outputHash,
              exitCode: rep.exitCode,
              stderr: rep.stderr,
            });
          } catch (err) {
            this.emitEvent({
              type: "question.raised",
              id: this.allocId("question"),
              text: `Computation ${comp.entry} from ${entry.taskId} could not be recorded: ${String(err).slice(0, 300)}`,
              blocking: false,
              context: `computation ${entry.taskId}`,
              raisedBy: "conductor",
            });
          }
        }
      }
    }
  }

  /**
   * Repair only the precisely identifiable v0.1 path-layout failure. We do
   * not reinterpret genuine mismatches: the old baseline must have failed,
   * the entry must be packet-relative through `scratch/`, and the snapshot
   * must have the legacy flat shape. The broken baseline is retained on disk.
   */
  private repairLegacyComputationBaselines(): void {
    for (const computation of Object.values(this.state.computations)) {
      if (computation.reproduced?.match === true || computation.repairedReason !== null) continue;
      const dest = path.join(this.paths.computationsDir, computation.id);
      const recordFile = path.join(dest, "record.json");
      const inputsDir = path.join(dest, "inputs");
      const scratchDir = path.join(this.paths.tasksDir, computation.taskId, "packet", "scratch");
      if (
        !existsSync(recordFile) ||
        !existsSync(inputsDir) ||
        existsSync(path.join(inputsDir, "scratch")) ||
        !existsSync(scratchDir) ||
        !/(^|[\s'\"]|\/)scratch\//.test(computation.entry)
      ) {
        continue;
      }
      let legacy: { exitCode?: number | null; outputHash?: string };
      try {
        legacy = JSON.parse(readFileSync(recordFile, "utf8")) as typeof legacy;
      } catch {
        continue;
      }
      if (legacy.exitCode === 0) continue;

      try {
        const rec = repairComputationBaseline(
          this.paths.computationsDir,
          computation.id,
          scratchDir,
          computation.entry,
        );
        this.emitEvent({
          type: "computation.baselineRepaired",
          compId: computation.id,
          inputsHash: rec.inputsHash,
          outputHash: rec.outputHash,
          exitCode: rec.exitCode,
          stderr: rec.stderr,
          reason:
            "repaired legacy packet/scratch working-directory layout; original broken baseline preserved on disk",
        });
        const rep = reproduceComputation(this.paths.computationsDir, computation.id);
        this.emitEvent({
          type: "computation.reproduced",
          compId: computation.id,
          match: rep.match,
          outputHash: rep.outputHash,
          exitCode: rep.exitCode,
          stderr: rep.stderr,
        });
      } catch (error) {
        // Leave the truthful mismatch visible to the Research Manager and UI. A repair
        // failure is operational evidence, not a mathematical question for
        // the project owner.
        console.warn(`could not repair legacy computation ${computation.id}:`, error);
      }
    }
  }

  /** Retire leads whose entire source attempt was deliberately set aside. */
  private supersedeUnverifiedClaimsFromTask(taskId: string, reason: string, by: string): void {
    for (const claim of Object.values(this.state.claims)) {
      if (claim.status !== "UNVERIFIED" || !claimComesFromTask(claim, taskId)) continue;
      this.emitEvent({
        type: "claim.status",
        claimId: claim.id,
        from: "UNVERIFIED",
        to: "SUPERSEDED",
        justification: `source attempt ${taskId} was set aside: ${reason}`,
        by,
      });
    }
  }

  // --------------------------------------------------------------- curation

  private recordResearchManagerNote(
    waveId: string,
    markdown: string,
    source: "research_manager" | "human_edited" | "fallback",
    abstract = "",
  ): void {
    const relPath = path.join("artifacts", "manager-notes", `${waveId}.md`);
    const text = markdown.trim() + "\n";
    writeFileAtomic(path.join(this.paths.managerNotesDir, `${waveId}.md`), text);
    this.emitEvent({
      type: "manager.noteRecorded",
      waveId,
      path: relPath,
      abstract: abstract.trim(),
      markdown: text,
      source,
    });
  }

  private fallbackResearchManagerNote(waveId: string, reason: string): string {
    const previous = this.state.researchManagerNotes.at(-1)?.markdown.trim();
    return [
      `# Research Manager's current view after ${waveId}`,
      "",
      `No new mathematical judgment was returned for this round (${reason}).`,
      "The findings remain in the research record and the preceding view is retained below without alteration.",
      ...(previous ? ["", "## Previous view retained", "", previous] : []),
    ].join("\n");
  }

  private async runCuration(waveId: string, docket: string, outcomes: TaskOutcome[]): Promise<void> {
    const decisionId = this.allocId("decision");
    this.emitEvent({ type: "decision.requested", decisionId, kind: "curation", waveId });

    const capsule = (role: "solver" | "explorer" | "reviewer") => {
      const f = path.join(this.paths.capsulesDir, `${role}.md`);
      return existsSync(f) ? readFileSync(f, "utf8") : "(none yet)";
    };
    const digest = existsSync(this.paths.digestFile) ? readFileSync(this.paths.digestFile, "utf8") : null;
    const pendingCards = Object.values(this.state.cards)
      .filter((c) => c.status === "PENDING")
      .map((c) => ({ id: c.id, proposedBy: c.proposedBy, ...c.card }));
    const files = curationPacketFiles(
      this.state,
      waveId,
      docket,
      JSON.stringify({ outcomes, proposedCards: pendingCards }, null, 2),
      { solver: capsule("solver"), explorer: capsule("explorer"), reviewer: capsule("reviewer") },
      digest,
    );
    const resolutionPath = path.join("artifacts", "resolutions", `${waveId}.md`);
    let out: CurationResult | null = null;
    let failure = "the round assessment did not complete";
    for (let attempt = 1; attempt <= 2 && !this.stopped; attempt++) {
      const call = await this.runResearchManagerCall(decisionId, files, CURATION_PROMPT, CurationOutput);
      // A graceful shutdown leaves the closed round unresolved so replay can
      // resume reconciliation instead of recording a false failure.
      if (this.stopped) return;
      this.emitEvent({ type: "decision.proposed", decisionId, action: call.output, usage: call.usage });
      const violations = call.output
        ? [
            ...validateTaskDispositions(call.output, outcomes),
            ...validateLibraryEdits(this.state, call.output),
            ...validateClaimUpdates(this.state, call.output, outcomes),
          ]
        : [call.error ?? call.status];
      if (call.output && violations.length === 0) {
        out = call.output;
        break;
      }
      failure = violations.join("; ");
      this.emitEvent({ type: "decision.rejected", decisionId, violations });
      if (attempt < 2) {
        files["retry-note.md"] = curationRetryNote(violations);
      }
    }

    if (!out) {
      this.recordResearchManagerNote(
        waveId,
        this.fallbackResearchManagerNote(waveId, failure),
        "fallback",
      );
      writeFileAtomic(
        path.join(this.paths.dir, resolutionPath),
        `# Research round ${waveId} — notes preserved\n\n` +
          `An automatic assessment of this round did not complete after two attempts (${failure}). ` +
          "The mathematical findings below remain available, but no new library notes or " +
          "claim-status changes were made. No response from the owner is required.\n\n" +
          docket,
      );
      this.emitEvent({ type: "resolution.recorded", waveId, path: resolutionPath });
      return;
    }
    this.emitEvent({ type: "decision.accepted", decisionId, action: out });

    const managerNote = out.managerNoteMarkdown.trim();
    this.recordResearchManagerNote(
      waveId,
      managerNote || this.fallbackResearchManagerNote(waveId, "the response used the earlier schema"),
      managerNote ? "research_manager" : "fallback",
    );

    writeFileAtomic(
      path.join(this.paths.dir, resolutionPath),
      `${out.resolutionMarkdown.trim()}\n\n${renderTaskDispositions(out)}\n`,
    );
    this.emitEvent({ type: "resolution.recorded", waveId, path: resolutionPath });

    // Independent evidence takes precedence over setting an attempt aside:
    // a checked lemma remains checked even when the rest of its source note
    // is not worth carrying.
    for (const update of out.claimUpdates) {
      const claim = this.state.claims[update.claimId];
      if (!claim || claim.status === update.status) continue;
      this.emitEvent({
        type: "claim.status",
        claimId: update.claimId,
        from: claim.status,
        to: update.status,
        justification: `${update.reason} (independently checked in ${update.evidenceTaskIds.join(", ")})`,
        by: "conductor",
      });
    }

    for (const item of out.taskDispositions) {
      this.emitEvent({
        type: "task.dispositioned",
        taskId: item.taskId,
        waveId,
        disposition: item.disposition,
        reason: item.reason,
        unblock: item.unblock,
      });
      if (item.disposition === "set_aside") {
        this.supersedeUnverifiedClaimsFromTask(item.taskId, item.reason, "conductor");
      }
    }

    const knownClaims = new Set(
      Object.values(this.state.claims).map((claim) => normalizeClaimStatement(claim.statement)),
    );
    for (const claim of out.claimExtractions) {
      const normalized = normalizeClaimStatement(claim.statement);
      if (knownClaims.has(normalized)) continue;
      const claimId = this.allocId("claim");
      this.emitEvent({
        type: "claim.added",
        claimId,
        statement: claim.statement,
        status: "UNVERIFIED",
        provenance: `${claim.provenance} (from ${claim.fromTaskId})`,
        sourceTaskId: claim.fromTaskId,
        dependsOn: claim.dependsOn.filter((d) => this.state.claims[d] !== undefined),
      });
      knownClaims.add(normalized);
    }

    for (const decision of out.cardDecisions) {
      const card = this.state.cards[decision.cardId];
      if (!card || card.status !== "PENDING") continue;
      let status: CardStatus = decision.admit ? decision.status : "SUPERSEDED";
      let reason = decision.admit ? decision.reason : `not retained in the active library: ${decision.reason}`;
      if (decision.admit && decision.status === "VERIFIED" && !this.verifiedAdmissionAllowed(card.card.type)) {
        status = "PROPOSED";
        reason += " (kept PROPOSED because VERIFIED requires independent evidence)";
      }
      this.emitEvent({ type: "memory.cardAdmitted", cardId: decision.cardId, status, reason });
      // Rejected proposals are archived as SUPERSEDED cards too: they stay
      // out of ordinary recall, but an explicit archive search can recover
      // the exact note and provenance.
      this.persistMemoryCard(decision.cardId);
    }

    // The curator may condense overlapping active notes into a few short,
    // provenance-bearing cards. These are organizational syntheses, never
    // self-verifying mathematical evidence.
    for (const addition of out.libraryAdditions) {
      const cardId = this.allocId("card");
      const sourceRefs = [...addition.sourceCardIds, ...addition.sourceArtifactIds];
      const tags = [
        ...new Set([...addition.tags, ...(addition.promising ? ["promising"] : [])]),
      ];
      this.emitEvent({
        type: "memory.cardProposed",
        cardId,
        by: "planner:librarian",
        card: {
          type: addition.type,
          title: addition.title,
          content: addition.conclusionsMarkdown,
          abstract: addition.abstract,
          tags,
          provenance: `combined after research round ${waveId}; sources: ${sourceRefs.join(", ")}`,
          sourceArtifact:
            addition.sourceArtifactIds.length === 1 ? addition.sourceArtifactIds[0]! : null,
          dependsOn: addition.sourceCardIds,
        },
      });
      this.emitEvent({
        type: "memory.cardAdmitted",
        cardId,
        status: "PROPOSED",
        reason: `concise combination of ${sourceRefs.join(", ")} after ${waveId}; not independently verified`,
      });
      this.persistMemoryCard(cardId);

      for (const sourceId of addition.supersedesCardIds) {
        const source = this.state.cards[sourceId]!;
        this.emitEvent({
          type: "memory.cardStatus",
          cardId: sourceId,
          from: source.status as CardStatus,
          to: "SUPERSEDED",
          reason: `condensed into ${cardId} after ${waveId}`,
          by: "planner:librarian",
        });
        this.persistMemoryCard(sourceId);
      }
    }

    for (const retirement of out.libraryRetirements) {
      const card = this.state.cards[retirement.cardId]!;
      this.emitEvent({
        type: "memory.cardStatus",
        cardId: retirement.cardId,
        from: card.status as CardStatus,
        to: "SUPERSEDED",
        reason: retirement.reason,
        by: "planner:librarian",
      });
      this.persistMemoryCard(retirement.cardId);
    }

    for (const role of ["solver", "explorer", "reviewer"] as const) {
      const text = out.capsules[role];
      const capped =
        text.length > CAPSULE_CHAR_CAPS[role]
          ? text.slice(0, CAPSULE_CHAR_CAPS[role]) + "\n\n(truncated to keep these research notes concise)"
          : text;
      const relPath = path.join("memory", "capsules", `${role}.md`);
      writeFileAtomic(path.join(this.paths.dir, relPath), capped);
      this.emitEvent({ type: "capsule.updated", role, waveId, path: relPath });
    }

    const digestText =
      out.digestMarkdown.length > DIGEST_CHAR_CAP
        ? out.digestMarkdown.slice(0, DIGEST_CHAR_CAP) + "\n\n(truncated to keep the project summary concise)"
        : out.digestMarkdown;
    writeFileAtomic(this.paths.digestFile, digestText);
    this.emitEvent({ type: "digest.updated" });
  }

  private verifiedAdmissionAllowed(cardType: string): boolean {
    if (cardType !== "COMPUTATION") return false;
    return Object.values(this.state.computations).some((c) => c.reproduced?.match === true);
  }

  /** Keep the searchable card file synchronized with the event-sourced status. */
  private persistMemoryCard(cardId: string): void {
    const entry = this.state.cards[cardId];
    if (!entry || entry.status === "PENDING") return;
    const memoryCard: MemoryCard = {
      id: cardId,
      type: entry.card.type,
      status: entry.status,
      title: entry.card.title,
      abstract: entry.card.abstract,
      content: entry.card.content,
      tags: entry.card.tags,
      provenance: entry.card.provenance,
      sourceArtifact: entry.card.sourceArtifact,
      dependsOn: entry.card.dependsOn,
    };
    writeFileAtomic(path.join(this.paths.cardsDir, `${cardId}.md`), serializeCard(memoryCard));
  }

  // ------------------------------------------------------------- acceptance

  /**
   * Promote a candidate's ledger dependencies once two independent reviewers
   * have PASSed that exact version (PROTOCOL §6: "a check recorded by a
   * different agent").
   *
   * Reviewers receive the claim-ledger extract in their packet, and their
   * contract requires them to verify that every imported result says exactly
   * what the candidate uses, treating "not enough information to verify" as
   * FAIL. Two independent PASS verdicts on the frozen version are therefore
   * exactly the independent check the protocol demands.
   *
   * Without this, acceptance is unreachable by any legal Research Manager action: no
   * action promotes a claim, so a candidate with a non-empty `usedClaimIds`
   * would re-review itself until the budget ran out (observed in the first
   * real-quota run). Only UNVERIFIED claims move — a REFUTED or SUPERSEDED
   * claim, including one a human refuted, is never resurrected here.
   */
  private promoteClaimsVerifiedByReview(candidateId: string): void {
    const candidate = this.state.candidates[candidateId];
    if (!candidate) return;
    const verdicts = candidate.reviewIds.map((rid) => this.state.reviews[rid]!.verdict);
    const passes = verdicts.filter((v) => v === "PASS");
    if (passes.length < 2 || verdicts.some((v) => v === "FAIL")) return;

    const reviewList = candidate.reviewIds
      .filter((rid) => this.state.reviews[rid]!.verdict === "PASS")
      .join(", ");
    for (const claimId of candidate.usedClaimIds) {
      const claim = this.state.claims[claimId];
      if (!claim || claim.status !== "UNVERIFIED") continue;
      this.emitEvent({
        type: "claim.status",
        claimId,
        from: "UNVERIFIED",
        to: "VERIFIED",
        justification:
          `checked by independent reviews ${reviewList}, which PASSed ${candidateId} with this claim ` +
          `included among the candidate's stated dependencies`,
        by: "conductor",
      });
    }
  }

  private evaluateAndMaybeFinalize(candidateId: string): boolean {
    this.promoteClaimsVerifiedByReview(candidateId);
    const res = evaluateAcceptance(this.state, candidateId);
    this.emitEvent({ type: "acceptance.evaluated", candidateId, passed: res.passed, failing: res.failing });
    return res.passed;
  }

  /**
   * Two clean independent reports can establish a genuine partial theorem
   * without pretending it solves problem.md. Archive that lineage as a
   * verified result and return to discovery, so later partial results are not
   * trapped behind a permanently active candidate.
   */
  private maybeEstablishScopedPartial(candidateId: string): boolean {
    const candidate = this.state.candidates[candidateId];
    if (!candidate?.scope || !candidate.acceptance) return false;
    const lineage = this.state.lineages[candidate.lineageId];
    if (!lineage || lineage.status !== "active") return false;
    if (
      candidate.acceptance.failing.length !== 1 ||
      !candidate.acceptance.failing[0]!.startsWith("candidate is scoped to a partial result")
    ) {
      return false;
    }
    this.emitEvent({
      type: "lineage.established",
      lineageId: lineage.id,
      candidateId,
    });
    this.phaseTo("DISCOVERY", `independent reviews established scoped result ${candidateId}`);
    return true;
  }

  private async finalize(result: Result, reason: string, candidateId: string | null): Promise<void> {
    if (this.state.terminal) return;
    let body: string | null = null;
    if (this.remainingBudget() > 0) {
      const decisionId = this.allocId("decision");
      this.emitEvent({ type: "decision.requested", decisionId, kind: "final", waveId: null });
      const digest = existsSync(this.paths.digestFile) ? readFileSync(this.paths.digestFile, "utf8") : null;
      let candidateText: string | null = null;
      if (candidateId) {
        const a = this.state.artifacts[candidateId];
        if (a) candidateText = readFileSync(path.join(this.paths.dir, a.path), "utf8");
      }
      const call = await this.runResearchManagerCall(
        decisionId,
        finalPacketFiles(this.state, `${result} (${reason})`, candidateText, digest),
        FINAL_PROMPT,
        FinalOutput,
      );
      this.emitEvent({ type: "decision.proposed", decisionId, action: call.output, usage: call.usage });
      if (call.output) {
        this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
        body = call.output.finalMarkdown;
      } else {
        this.emitEvent({ type: "decision.rejected", decisionId, violations: [call.error ?? "final call failed"] });
      }
    }
    if (body === null) {
      body = `# Automatic fallback report\n\nReason for ending the run: ${reason}\n\n${ledgerSummary(this.state)}`;
    }
    body = body.replace(/^RESULT:.*\n+/i, "");
    const finalText = `RESULT: ${result}\n\n${body}`;
    const reportNumber = this.state.terminalHistory.length + 1;
    const firstReport = reportNumber === 1 && this.state.artifacts["final"] === undefined;
    const artifactId = firstReport ? "final" : `final-${reportNumber}`;
    const relPath = firstReport
      ? path.join("artifacts", "final.md")
      : path.join("artifacts", "finals", `${artifactId}.md`);
    writeFileAtomic(path.join(this.paths.dir, relPath), finalText);
    this.emitEvent({
      type: "artifact.recorded",
      artifactId,
      kind: "final",
      taskId: null,
      path: relPath,
      conclusion: result,
    });
    this.phaseTo("TERMINAL", reason);
    this.emitEvent({ type: "terminal.reached", result, finalPath: relPath });
  }

  // ------------------------------------------------------------ human API

  continueResearch(
    note: string,
    addTokens: number,
    addWaves: number,
    by = "human",
    humanRevisionMarkdown?: string,
  ): void {
    const terminal = this.state.terminal;
    if (!terminal) throw new Error("project is not currently at a stopping report");
    if (note.trim() === "") throw new Error("continuation needs a concrete research direction");
    if (!Number.isSafeInteger(addTokens) || addTokens < 0) {
      throw new Error("addTokens must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(addWaves) || addWaves < 0) {
      throw new Error("addWaves must be a non-negative safe integer");
    }
    if (humanRevisionMarkdown !== undefined) {
      if (humanRevisionMarkdown.trim() === "") {
        throw new Error("a human-written continuation view cannot be blank");
      }
      if (humanRevisionMarkdown.length > 16_000) {
        throw new Error("a human-written continuation view cannot exceed 16,000 characters");
      }
    }
    this.emitEvent({
      type: "project.continued",
      previousResult: terminal.result,
      previousFinalPath: terminal.finalPath,
      note: note.trim(),
      addTokens,
      addWaves,
      by,
    });
    this.phaseTo("DISCOVERY", "owner continued research after a stopping report");
    if (humanRevisionMarkdown !== undefined) {
      this.recordResearchManagerNote(
        nextContinuationRevisionId(this.state),
        humanRevisionMarkdown,
        "human_edited",
      );
    }
    this.start();
  }

  pause(by = "human"): void {
    if (!this.state.paused) this.emitEvent({ type: "project.paused", by });
  }

  resume(by = "human"): void {
    if (this.state.paused) this.emitEvent({ type: "project.resumed", by });
  }

  setAutonomy(mode: "auto" | "gated", by = "human"): void {
    this.setProjectSettings({ ...this.getProjectSettings(), autonomy: mode }, by);
  }

  setWebSearch(enabled: boolean, by = "human"): void {
    this.setProjectSettings({ ...this.getProjectSettings(), allowWebSearch: enabled }, by);
  }

  setModelSettings(settings: ActiveModelSettings, by = "human"): void {
    this.setProjectSettings({ ...this.getProjectSettings(), models: settings }, by);
  }

  /** The one effective, user-editable project-settings projection. */
  getProjectSettings(): ProjectSettings {
    return projectSettingsFromConfig(this.state.config);
  }

  /**
   * Atomically replace the effective project settings. Old specialized event
   * types remain replayable, but every new UI/API update comes through this
   * single event so model choice, autonomy, and search permission cannot drift.
   */
  setProjectSettings(settings: ProjectSettings, by = "human"): void {
    const parsed = ProjectSettings.parse(settings);
    const clean = (choice: ModelChoice): ModelChoice => {
      const model = choice.model?.trim() || null;
      if (model !== null && (model.length > 200 || /\s/.test(model))) {
        throw new Error("model IDs must be at most 200 characters and contain no whitespace");
      }
      return { model, effort: choice.effort };
    };
    const models: ActiveModelSettings = {
      researchManager: clean(parsed.models.researchManager),
      solver: clean(parsed.models.solver),
      explorer: clean(parsed.models.explorer),
      reviewer: clean(parsed.models.reviewer),
      synthesizer: clean(parsed.models.synthesizer),
    };
    const next: ProjectSettings = {
      models,
      autonomy: parsed.autonomy,
      allowWebSearch: parsed.allowWebSearch,
      totalTokens: parsed.totalTokens,
      maxWaves: parsed.maxWaves,
    };
    const current = this.getProjectSettings();
    const spent = this.state.budget.spentTokens + this.state.budget.plannerSpentTokens;
    if (next.totalTokens < spent) {
      throw new Error(`token ceiling cannot be below the ${spent} tokens already spent`);
    }
    if (next.maxWaves < this.state.waveOrder.length) {
      throw new Error(
        `maximum research rounds cannot be below the ${this.state.waveOrder.length} already used`,
      );
    }
    if (
      this.openWaveId() !== null &&
      (next.totalTokens < current.totalTokens || next.maxWaves < current.maxWaves)
    ) {
      throw new Error("resource ceilings cannot be lowered while a research round is open");
    }
    const modelsUnchanged = (Object.keys(models) as (keyof ActiveModelSettings)[]).every(
      (role) =>
        current.models[role].model === models[role].model &&
        current.models[role].effort === models[role].effort,
    );
    if (
      modelsUnchanged &&
      current.autonomy === next.autonomy &&
      current.allowWebSearch === next.allowWebSearch &&
      current.totalTokens === next.totalTokens &&
      current.maxWaves === next.maxWaves
    ) {
      return;
    }
    this.emitEvent({ type: "project.settingsChanged", settings: next, by });
  }

  submitDirective(text: string, urgent: boolean): string {
    const id = this.allocId("directive");
    this.emitEvent({ type: "directive.submitted", id, text, urgent });
    if (urgent) {
      const wid = this.openWaveId();
      if (wid && this.state.waves[wid]!.status === "open") {
        this.emitEvent({ type: "wave.softInterrupted", waveId: wid, by: "human" });
      }
    }
    return id;
  }

  answerQuestion(id: string, answer: string): void {
    const q = this.state.questions[id];
    if (!q || q.status !== "open") throw new Error(`question ${id} is not open`);
    this.emitEvent({ type: "question.answered", id, answer });
  }

  dismissQuestion(id: string): void {
    const q = this.state.questions[id];
    if (!q || q.status !== "open") throw new Error(`question ${id} is not open`);
    this.emitEvent({ type: "question.dismissed", id });
  }

  resolveGate(decisionId: string, resolution: "approve" | "edit" | "reject", action?: unknown, note?: string): void {
    if (this.state.openGateDecisionId !== decisionId) throw new Error(`no proposed move is waiting for review at ${decisionId}`);
    this.emitEvent({ type: "gate.resolved", decisionId, resolution, ...(action !== undefined ? { action } : {}), ...(note !== undefined ? { note } : {}) });
    if (resolution === "reject" && note) {
      const id = this.allocId("directive");
      this.emitEvent({
        type: "directive.submitted",
        id,
        text: `The owner asked the research chair to reconsider ${decisionId}: ${note}`,
        urgent: false,
      });
    }
  }

  softInterruptWave(waveId: string, by = "human"): void {
    const w = this.state.waves[waveId];
    if (!w || w.status !== "open") throw new Error(`wave ${waveId} is not open`);
    this.emitEvent({ type: "wave.softInterrupted", waveId, by });
  }

  hardInterruptTask(taskId: string): void {
    const kill = this.killHandles.get(taskId);
    if (!kill) throw new Error(`task ${taskId} is not running`);
    kill("killed");
  }

  extendTask(taskId: string, addTokens: number, by = "human"): void {
    const t = this.state.tasks[taskId];
    if (!t) throw new Error(`unknown task ${taskId}`);
    this.emitEvent({ type: "task.extended", taskId, addTokens, by });
  }

  humanClaimStatus(claimId: string, to: "VERIFIED" | "REFUTED", note: string): void {
    const claim = this.state.claims[claimId];
    if (!claim) throw new Error(`unknown claim ${claimId}`);
    this.emitEvent({ type: "claim.status", claimId, from: claim.status, to, justification: note, by: "human" });
    for (const c of Object.values(this.state.candidates)) {
      if (c.usedClaimIds.includes(claimId) && c.reviewIds.length > 0) {
        this.evaluateAndMaybeFinalizeAsync(c.id);
      }
    }
  }

  humanRaiseIssue(candidateId: string, severity: "CRITICAL" | "MAJOR" | "MINOR", location: string, text: string): string {
    if (!this.state.candidates[candidateId]) throw new Error(`unknown candidate ${candidateId}`);
    const issueId = this.allocId("issue");
    this.emitEvent({ type: "issue.raised", issueId, candidateId, severity, location, summary: text, by: "human" });
    return issueId;
  }

  quarantineCard(cardId: string, note: string): void {
    const card = this.state.cards[cardId];
    if (!card) throw new Error(`unknown card ${cardId}`);
    const from = card.status === "PENDING" ? "PROPOSED" : card.status;
    this.emitEvent({ type: "memory.cardStatus", cardId, from, to: "QUARANTINED", reason: note, by: "human" });
    this.persistMemoryCard(cardId);
  }

  private evaluateAndMaybeFinalizeAsync(candidateId: string): void {
    if (this.evaluateAndMaybeFinalize(candidateId)) {
      void this.finalize(this.acceptedResult(candidateId), `acceptance predicate passed for ${candidateId}`, candidateId);
    } else {
      this.maybeEstablishScopedPartial(candidateId);
    }
  }

  /** All events so far (for SSE snapshot/replay). Do not mutate. */
  get events(): readonly Event[] {
    return this.log.events;
  }

  /** Called by the memory service backend to ledger a recall. */
  recordRecall(rec: Omit<RecallRecord, "role"> & { role?: RecallRecord["role"] }): void {
    this.emitEvent({
      type: "memory.recall",
      taskId: rec.taskId,
      op: rec.op,
      args: rec.args,
      returnedIds: rec.returnedIds,
      refusedIds: rec.refusedIds,
    });
  }

  /** Convenience for HTTP/tests: expose one task's execution surfaces. */
  taskDetail(taskId: string): { task: TaskState; outputPath: string; packetDir: string; archive: string } {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`unknown task ${taskId}`);
    const dir = path.join(this.paths.tasksDir, taskId);
    return {
      task,
      outputPath: path.join(dir, "output.json"),
      packetDir: path.join(dir, "packet"),
      archive: path.join(dir, "codex-events.jsonl"),
    };
  }
}
