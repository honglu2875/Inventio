import {
  ActiveModelSettings,
  ClaimComparisonOutput,
  FinalOutput,
  IntakeOutput,
  ProjectSettings,
  PublicationOutput,
  SummaryRevisionOutput,
  TrajectoryOutput,
  Usage as UsageSchema,
  VerificationOutput,
  applyEvent,
  currentTerminalPublication,
  initialState,
  makeId,
  nextContinuationRevisionId,
  pendingIntakeDecision,
  projectSettingsFromConfig,
  repairLegacyArtifactControls,
  usageSpend,
  type ClaimState,
  type Event,
  type IdKind,
  type IntakeMemory,
  type IntakeSource,
  type ModelChoice,
  type Phase,
  type ProjectConfig,
  type ProjectState,
  type PublicationState,
  type Result,
  type RosterEntry,
  type TaskState,
  type TrajectoryOutput as TrajectoryOutputT,
  type Usage,
} from "@inventio/schema";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { parseModelJson } from "../codex/modelJson.js";
import {
  CODEX_TURN_BASE_TOKENS,
  ZERO_USAGE,
  addUsage,
  type InterruptReason,
} from "../codex/runner.js";
import { runStructured, type StructuredRunResult } from "../codex/structured.js";
import { readProjectWorkflow } from "../legacy/archive.js";
import type { RecallRecord, TaskScope } from "../memory/types.js";
import { PUBLICATION_PROMPT, publicationPacketFiles } from "../prompts/publication.js";
import { MODEL_TOOL_NAMES } from "../prompts/tools.js";
import {
  CLAIM_COMPARISON_PROMPT,
  SUMMARY_REVIEW_PROMPT,
  TRAJECTORY_FINAL_PROMPT,
  TRAJECTORY_INTAKE_PROMPT,
  TRAJECTORY_RESTART_PROMPT,
  TRAJECTORY_WORKER_PROMPT,
  VERIFICATION_PROMPT,
  claimComparisonFiles,
  latestMathematicalView,
  summaryReviewFiles,
  trajectoryFinalFiles,
  trajectoryIntakeFiles,
  trajectoryWorkerFiles,
  verificationFiles,
} from "../prompts/trajectories.js";
import {
  createTectonicCompiler,
  renderPublicationTex,
  validatePublicationManuscript,
  type PublicationCompiler,
} from "../publication/tex.js";
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
import {
  applyIntakeSourceSummaries,
  copyIntakeSourcesToPacket,
  indexIntakeSources,
} from "./intakeSources.js";
import { WorkerPool } from "./pool.js";

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
  /** Local TeX engine for owner-requested post-terminal PDFs. */
  publicationCompiler?: PublicationCompiler;
  /** test overrides */
  taskWallClockMsOverride?: number;
  plannerWallClockMsOverride?: number;
  killGraceMs?: number;
  progressThrottleMs?: number;
}

type TaskAccountingBasis = "reported" | "estimated" | "mixed";

interface TaskAccounting {
  /** Exact usage from every run that reached turn.completed, if any did. */
  reportedUsage: Usage | null;
  /** Exact spend plus conservative estimates for runs that never reported. */
  chargedTokens: number;
  basis: TaskAccountingBasis;
}

function taskAccountingBasis(hasReported: boolean, hasEstimated: boolean): TaskAccountingBasis {
  return hasReported && hasEstimated ? "mixed" : hasReported ? "reported" : "estimated";
}

/** Add one resumed model call to the cumulative charge already on the task. */
function resumedTaskAccounting(
  previousCharge: number,
  previousBasis: TaskAccountingBasis,
  current: TaskAccounting,
  cumulativeReportedUsage: Usage,
): TaskAccounting {
  const hasPrevious = previousCharge > 0;
  const hasReported =
    (hasPrevious && previousBasis !== "estimated") || current.basis !== "estimated";
  const hasEstimated =
    (hasPrevious && previousBasis !== "reported") || current.basis !== "reported";
  return {
    reportedUsage: hasReported ? cumulativeReportedUsage : null,
    chargedTokens: previousCharge + current.chargedTokens,
    basis: taskAccountingBasis(hasReported, hasEstimated),
  };
}

/**
 * A structured call may contain retries. Some can report exact usage while a
 * final timed-out run cannot, so account each constituent run independently.
 */
function structuredTaskAccounting<T>(result: StructuredRunResult<T>): TaskAccounting {
  const reportedRuns = result.runs.filter((run) => run.usage !== null);
  const estimatedTokens = result.runs
    .filter((run) => run.usage === null)
    .reduce((total, run) => total + Math.max(0, Math.floor(run.estimatedTokens)), 0);
  const reportedTokens = usageSpend(result.usage);
  return {
    reportedUsage: reportedRuns.length > 0 ? result.usage : null,
    chargedTokens: reportedTokens + estimatedTokens,
    basis:
      reportedRuns.length > 0 && estimatedTokens > 0
        ? "mixed"
        : reportedRuns.length > 0
          ? "reported"
          : "estimated",
  };
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

/**
 * Interrupted structured calls often leave their last draft as JSON. Keep it
 * unvalidated partial work, but show the mathematical prose rather than JSON
 * field names and escaping in the round summary and task inspector.
 */
function readablePartialWork(text: string): string {
  const raw = text.trim();
  if (raw === "") return "";
  try {
    const parsed = parseModelJson(stripJsonFence(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    const record = parsed as Record<string, unknown>;
    const parts = [record.summaryMarkdown, record.writeupMarkdown]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim())
      .filter((value, index, values) => values.indexOf(value) === index);
    return parts.length > 0 ? parts.join("\n\n") : raw;
  } catch {
    return raw;
  }
}

function abstractSentenceCount(text: string): number {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact === "") return 0;
  const marked = compact.match(/[.!?]+(?=\s|$)/g)?.length ?? 0;
  return Math.max(1, marked + (/[.!?]+$/.test(compact) ? 0 : 1));
}

function summaryAbstractViolations(text: string): string[] {
  const violations: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 480) violations.push("abstract exceeds 480 characters");
  if (abstractSentenceCount(trimmed) > 4) violations.push("abstract exceeds four sentences");
  if (/(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/m.test(trimmed)) {
    violations.push("abstract contains a heading, list, or outline");
  }
  const withoutClosingMarks = trimmed.replace(/[\s"'’”`*_)$\]}]+$/g, "");
  if (!/[.!?]$/.test(withoutClosingMarks)) {
    violations.push("abstract does not end with a complete sentence");
  }
  return violations;
}

function normalizeMathematicalViewMarkdown(waveId: string, markdown: string): string {
  const lines = markdown.trim().split("\n");
  const first = lines[0]?.trim() ?? "";
  if (
    /^#\s+(?:W\d+(?:\.\d+)?\b.*|(?:current\s+)?mathematical\s+view\b.*)$/i.test(first)
  ) {
    lines.shift();
    while (lines[0]?.trim() === "") lines.shift();
  }
  return [`# ${waveId} — Current mathematical view`, "", ...lines].join("\n").trim();
}

const VERIFIER_FILESYSTEM_ISOLATION = "packet-only-v1";
const MAX_VERIFICATION_PROCESS_REPLACEMENTS = 2;

/**
 * ProjectEngine: the per-project Conductor (DESIGN §6). One logical thread:
 * the main loop runs the protocol sequentially; external calls land as
 * events and wake it. The event log is the only mutation path.
 */
function normalizeClaimStatement(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
}

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
  private trajectoryOutputs = new Map<string, TrajectoryOutputT>();
  private lastProgressAt = new Map<string, number>();
  private intakeRefreshInFlight = false;
  private interruptedIntakeChecked = false;
  private interruptedPublicationChecked = false;
  private publicationPromise: Promise<void> | null = null;
  /** In-flight v2 verification calls; durable queued/completed state lives in events. */
  private verificationPromises = new Map<string, Promise<void>>();

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
    if (args.config.workflow !== "trajectories-v2") throw new Error("legacy council projects are view-only");
    const paths = projectPaths(deps.root, args.slug);
    if (existsSync(paths.projectFile)) throw new Error(`project ${args.slug} already exists`);
    createProjectDirs(paths);
    writeProjectFile(paths, defaultProjectFile(args.slug, args.title, args.config));
    const log = EventLog.open(paths.eventsFile);
    try {
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
    } catch (error) {
      log.close();
      throw error;
    }
  }

  static load(deps: EngineDeps, slug: string): ProjectEngine {
    const paths = projectPaths(deps.root, slug);
    readProjectFile(paths); // validates presence
    if (readProjectWorkflow(paths.eventsFile) !== "trajectories-v2") {
      throw new Error("legacy council projects must be opened through the view-only archive");
    }
    const log = EventLog.open(paths.eventsFile);
    try {
      const state = initialState();
      for (const e of log.events) applyEvent(state, e);
      const engine = new ProjectEngine(slug, deps, log, state);
      engine.repairCollidedTrajectoryWriteups();
      engine.recoverRejectedTrajectoryReturns();
      engine.repairCompletedTrajectoryReturns();
      engine.repairClosedTrajectoryDockets();
      engine.repairSavedTaskAccounting();
      engine.closeInterruptedTrajectoryDecisions();
      return engine;
    } catch (error) {
      log.close();
      throw error;
    }
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
    await Promise.all([
      this.loopPromise?.catch(() => undefined),
      this.publicationPromise?.catch(() => undefined),
      ...[...this.verificationPromises.values()].map((promise) =>
        promise.catch(() => undefined),
      ),
    ]);
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

  /**
   * Restore the durable draft if the process stopped after the TeX was written
   * but before its event reached the log. The accepted/proposed decision keeps
   * the small metadata record needed to reconstruct publication.drafted.
   */
  private recoverSavedPublicationDraft(publication: PublicationState): boolean {
    const canRecover =
      publication.status === "drafting" ||
      (publication.status === "failed" && publication.failureStage === "drafting");
    if (!canRecover) return false;
    const decision = this.state.decisions[publication.decisionId];
    const output = PublicationOutput.safeParse(decision?.action);
    const publicationDir = path.join(this.paths.publicationsDir, publication.id);
    const texPath = path.join(publicationDir, "manuscript.tex");
    if (!output.success || !existsSync(texPath)) return false;
    if (decision?.status !== "accepted") {
      this.emitEvent({
        type: "decision.accepted",
        decisionId: publication.decisionId,
        action: output.data,
      });
    }
    this.emitEvent({
      type: "publication.drafted",
      publicationId: publication.id,
      kind: output.data.kind,
      result: output.data.result,
      title: output.data.title,
      assessment: output.data.assessment,
      texPath: path.relative(this.paths.dir, texPath),
      logPath: path.relative(this.paths.dir, path.join(publicationDir, "compile.log")),
    });
    return true;
  }

  /** Close publication work that could not survive a server process restart. */
  private recoverInterruptedPublications(): void {
    const publicationDecisionIds = new Set(
      this.state.publications.map((publication) => publication.decisionId),
    );
    for (const decisionId of this.state.decisionOrder) {
      const decision = this.state.decisions[decisionId]!;
      if (
        decision.kind === "publication" &&
        decision.status === "requested" &&
        !publicationDecisionIds.has(decisionId)
      ) {
        this.emitEvent({
          type: "decision.rejected",
          decisionId,
          violations: ["The publication request was interrupted before drafting began."],
        });
      }
    }
    for (const publication of this.state.publications) {
      if (this.recoverSavedPublicationDraft(publication)) continue;
      if (publication.status !== "drafting" && publication.status !== "compiling") continue;
      const decision = this.state.decisions[publication.decisionId];
      if (decision?.status === "requested" || decision?.status === "proposed") {
        this.emitEvent({
          type: "decision.rejected",
          decisionId: decision.id,
          violations: ["The publication pass was interrupted when the server stopped."],
        });
      }
      this.emitEvent({
        type: "publication.failed",
        publicationId: publication.id,
        stage: publication.status === "compiling" ? "compilation" : "drafting",
        error:
          publication.status === "compiling"
            ? "PDF compilation was interrupted when the server stopped; the accepted TeX can be compiled again."
            : "The final mathematical reading was interrupted when the server stopped; retry to draft it again.",
      });
    }
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
    if (!this.interruptedPublicationChecked) {
      this.interruptedPublicationChecked = true;
      this.recoverInterruptedPublications();
    }
    await this.trajectoryLoop();
  }

  // ---------------------------------------------------- trajectories-v2 loop

  /**
   * Single-controller execution: code fixes the number of independent long
   * trajectories, while no model sits between the problem and those workers.
   */
  private async trajectoryLoop(): Promise<void> {
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
          this.phaseTo("DISCOVERY", "recovered confirmed problem");
          continue;
        }
        await this.wake();
        continue;
      }

      this.repairTrajectoryInvariants();
      this.launchPendingVerifications();

      const openWave = this.openWaveId();
      if (openWave) {
        await this.runTrajectoryWave(openWave);
        continue;
      }

      const needsSummary = this.state.waveOrder.find((waveId) => {
        const wave = this.state.waves[waveId]!;
        return wave.status === "closed" && !wave.summaryReviewed;
      });
      if (needsSummary) {
        if (!this.state.waves[needsSummary]!.claimsCompared) {
          await this.compareTrajectoryClaims(needsSummary);
          continue;
        }
        await this.drainVerifications();
        if (this.stopped) return;
        await this.reviewTrajectorySummary(needsSummary);
        continue;
      }

      const decisive = this.trajectoryDecisiveResult();
      if (decisive !== null) {
        await this.drainVerifications();
        const confirmed = this.trajectoryDecisiveResult();
        if (confirmed !== null) {
          await this.finalizeTrajectory(
            confirmed,
            `an independently verified result ${confirmed === "PROVED" ? "proves" : "disproves"} the stated problem`,
          );
          continue;
        }
      }

      if (this.state.waveOrder.length >= this.state.config.limits.maxWaves) {
        await this.drainVerifications();
        const result = this.trajectoryDecisiveResult() ?? "UNCERTAIN";
        await this.finalizeTrajectory(
          result,
          result === "UNCERTAIN"
            ? `completed ${this.state.waveOrder.length} research rounds without a verified proof or disproof of the whole problem`
            : `independent verification established a ${result.toLowerCase()} result`,
        );
        continue;
      }

      if (!this.planTrajectoryWave()) {
        await this.drainVerifications();
        await this.finalizeTrajectory(
          this.trajectoryDecisiveResult() ?? "UNCERTAIN",
          "the remaining token allowance is too small for another long research round",
        );
      }
    }
  }

  /**
   * Guidance accepted for one particular round. Directives are consumed as
   * soon as the round is planned, so packet construction must follow the
   * decision that consumed them rather than looking only for pending entries.
   * A continuation note belongs to the first round planned after that note.
   */
  private trajectoryOwnerGuidance(waveId: string): string {
    const parts: string[] = [];
    const wave = this.state.waves[waveId];
    if (!wave) return "";
    for (const id of this.state.directiveOrder) {
      const directive = this.state.directives[id]!;
      if (directive.consumedByDecision === wave.decisionId) parts.push(directive.text);
    }
    const continuation = this.state.continuations.at(-1);
    const waveIndex = this.state.waveOrder.indexOf(waveId);
    const previousPlannedAt =
      waveIndex > 0
        ? this.state.waves[this.state.waveOrder[waveIndex - 1]!]!.plannedAtSeq
        : 0;
    if (
      continuation &&
      continuation.atSeq > previousPlannedAt &&
      continuation.atSeq < wave.plannedAtSeq
    ) {
      parts.push(continuation.note);
    }
    return parts.join("\n\n");
  }

  /** Deterministically create N Solver and M Explorer trajectories. */
  private planTrajectoryWave(): boolean {
    const settings = this.state.config.trajectory;
    const count = settings.solversPerWave + settings.explorersPerWave;
    if (count < 1) return false;
    const availableForResearch = Math.floor(
      this.remainingBudget() * (1 - this.state.config.budget.reserveFraction),
    );
    const tokenBudget = Math.min(
      this.state.config.budget.defaultTaskTokens,
      Math.floor(availableForResearch / count),
    );
    if (tokenBudget < 60_000) return false;

    const waveId = this.allocId("wave");
    const decisionId = this.allocId("decision");
    const roster: RosterEntry[] = [];
    // allocId() derives its answer from replayed state. That state does not
    // advance until wave.planned is emitted, so calling allocId("task") several
    // times while constructing one event would repeat the same ID. Reserve the
    // whole contiguous range locally and let the event advance the counter.
    const firstTaskNumber = (this.state.counters.task ?? 0) + 1;
    let taskOffset = 0;
    const add = (role: "solver" | "explorer", ordinal: number): void => {
      const taskId = makeId("task", firstTaskNumber + taskOffset);
      taskOffset += 1;
      roster.push({
        taskId,
        role,
        methodTag: `${role}-trajectory-${ordinal}`,
        direction:
          role === "solver"
            ? `Independent sustained attack on the original problem (${ordinal})`
            : `Independent sustained exploration around the original problem (${ordinal})`,
        briefMarkdown:
          role === "solver"
            ? "Develop the strongest rigorous attack you can on the original problem, choosing and revising your own strategy."
            : "Explore mathematically useful nearby results, special cases, examples, computations, obstructions, or methods, following the most informative route you find.",
        tokenBudget,
        computation: true,
        webSearch: this.state.config.allowWebSearch,
        reviewOf: null,
        grants: { artifactIds: [], cardIds: [], sourceMounts: [] },
      });
    };
    for (let i = 1; i <= settings.solversPerWave; i += 1) add("solver", i);
    for (let i = 1; i <= settings.explorersPerWave; i += 1) add("explorer", i);
    if (new Set(roster.map((entry) => entry.taskId)).size !== roster.length) {
      throw new Error("internal error: a trajectory round contains duplicate task IDs");
    }

    this.emitEvent({ type: "decision.requested", decisionId, kind: "next_move", waveId: null });
    const action = {
      workflow: "trajectories-v2",
      round: waveId,
      solvers: settings.solversPerWave,
      explorers: settings.explorersPerWave,
    };
    this.emitEvent({ type: "decision.proposed", decisionId, action, usage: null });
    this.emitEvent({ type: "decision.accepted", decisionId, action });
    this.emitEvent({
      type: "wave.planned",
      waveId,
      title: `Research round ${this.state.waveOrder.length + 1}`,
      decisionId,
      roster,
      reserveTokens: Math.max(0, this.remainingBudget() - tokenBudget * count),
      rationale: "The configured independent Solver and Explorer trajectories begin from the shared current mathematical view.",
    });
    for (const id of this.state.directiveOrder) {
      if (this.state.directives[id]!.status === "pending") {
        this.emitEvent({ type: "directive.consumed", id, decisionId });
      }
    }
    return true;
  }

  private readTrajectoryOutput(taskId: string): TrajectoryOutputT | null {
    const cached = this.trajectoryOutputs.get(taskId);
    if (cached) return cached;
    const file = path.join(this.paths.tasksDir, taskId, "output.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = TrajectoryOutput.safeParse(parseModelJson(readFileSync(file, "utf8")));
      if (!parsed.success) return null;
      this.trajectoryOutputs.set(taskId, parsed.data);
      return parsed.data;
    } catch {
      return null;
    }
  }

  private readTaskMeta(taskId: string): Record<string, unknown> | null {
    const file = path.join(this.paths.tasksDir, taskId, "meta.json");
    if (!existsSync(file)) return null;
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * A narrow compatibility repair for returns rejected solely by an older
   * objective-preparation validator. The model's final JSON must validate
   * under the current full trajectory schema; otherwise nothing is changed.
   */
  private recoverRejectedTrajectoryReturns(): void {

    for (const task of Object.values(this.state.tasks)) {
      if (
        task.status !== "failed" ||
        task.invalidOutputErrors === null ||
        !task.error?.startsWith("output invalid after repair:") ||
        (task.role !== "solver" && task.role !== "explorer") ||
        task.artifactIds.length > 0
      ) {
        continue;
      }
      const taskDir = path.join(this.paths.tasksDir, task.id);
      const candidates = ["output.json", "last-message.json"];
      let recovered: TrajectoryOutputT | null = null;
      for (const name of candidates) {
        const file = path.join(taskDir, name);
        if (!existsSync(file)) continue;
        try {
          const parsed = TrajectoryOutput.safeParse(
            parseModelJson(stripJsonFence(readFileSync(file, "utf8"))),
          );
          if (parsed.success) {
            recovered = parsed.data;
            break;
          }
        } catch {
          // A malformed or still-invalid return remains failed and inspectable.
        }
      }
      if (!recovered) continue;

      writeFileAtomic(path.join(taskDir, "output.json"), JSON.stringify(recovered, null, 2));
      this.trajectoryOutputs.set(task.id, recovered);
      const meta = this.readTaskMeta(task.id) ?? {};
      writeFileAtomic(
        path.join(taskDir, "meta.json"),
        JSON.stringify(
          {
            ...meta,
            status: "completed",
            recoveredFromRejectedOutput: true,
            recoveredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      this.emitEvent({
        type: "task.completed",
        taskId: task.id,
        usage: this.readTrajectoryMetaUsage(task.id),
        clearInvalidOutput: true,
      });
    }
  }

  /** Finish the idempotent materialization half of any recovered completion. */
  private repairCompletedTrajectoryReturns(): void {

    for (const waveId of this.state.waveOrder) {
      const wave = this.state.waves[waveId]!;
      for (const entry of wave.roster) {
        const task = this.state.tasks[entry.taskId];
        if (
          task?.status !== "completed" ||
          (entry.role !== "solver" && entry.role !== "explorer")
        ) {
          continue;
        }
        const output = this.readTrajectoryOutput(entry.taskId);
        if (output) this.materializeTrajectoryReturn(waveId, entry, output);
      }
    }
  }

  private recordTaskAccounting(taskId: string, accounting: TaskAccounting): void {
    const task = this.state.tasks[taskId];
    if (!task || accounting.chargedTokens <= task.chargedTokens) return;
    this.emitEvent({
      type: "task.accounted",
      taskId,
      chargedTokens: accounting.chargedTokens,
      basis: accounting.basis,
    });
  }

  /**
   * Backfill terminal calls written before estimated fallback accounting was
   * durable. Exact meta usage wins; otherwise the last progress estimate is
   * recorded. No completed task is ever charged twice.
   */
  private repairSavedTaskAccounting(): void {
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === "queued") continue;
      const meta = this.readTaskMeta(task.id);
      const parsedUsage = UsageSchema.safeParse(meta?.usage);
      const reported = parsedUsage.success ? usageSpend(parsedUsage.data) : 0;
      const tokenAccounting =
        meta?.tokenAccounting !== null && typeof meta?.tokenAccounting === "object"
          ? (meta.tokenAccounting as Record<string, unknown>)
          : null;
      const savedCharge =
        typeof meta?.chargedTokens === "number" && Number.isFinite(meta.chargedTokens)
          ? Math.max(0, Math.floor(meta.chargedTokens))
          : typeof tokenAccounting?.actual === "number" &&
            Number.isFinite(tokenAccounting.actual) &&
            tokenAccounting.actual > 0
            ? Math.floor(tokenAccounting.actual)
            : null;
      const chargedTokens = savedCharge ?? (reported > 0 ? reported : Math.floor(task.estimatedTokens));
      const basis: TaskAccountingBasis =
        meta?.accountingBasis === "mixed" || meta?.accountingBasis === "estimated"
          ? meta.accountingBasis
          : reported > 0
            ? "reported"
            : "estimated";
      this.recordTaskAccounting(task.id, {
        reportedUsage: parsedUsage.success && reported > 0 ? parsedUsage.data : null,
        chargedTokens,
        basis,
      });
    }
  }

  /** A previous process cannot still own a model call after this engine loads. */
  private closeInterruptedTrajectoryDecisions(): void {

    for (const decisionId of [...this.state.decisionOrder]) {
      const decision = this.state.decisions[decisionId]!;
      if (
        decision.status !== "requested" ||
        (decision.kind !== "curation" &&
          decision.kind !== "final" &&
          decision.kind !== "next_move")
      ) {
        continue;
      }
      this.emitEvent({ type: "decision.proposed", decisionId, action: null, usage: null });
      this.emitEvent({
        type: "decision.rejected",
        decisionId,
        violations: [
          "The model call ended with the previous conductor process; Inventio will retry it automatically from the unchanged mathematical record.",
        ],
      });
    }
  }

  private trajectoryWaveDocket(waveId: string): string {
    const wave = this.state.waves[waveId]!;
    const lines = [`# Research round ${waveId}`, ""];
    for (const entry of wave.roster) {
      const task = this.state.tasks[entry.taskId]!;
      const output = this.readTrajectoryOutput(entry.taskId);
      const partialFile = path.join(this.paths.tasksDir, entry.taskId, "salvage.md");
      const partial =
        !output && existsSync(partialFile)
          ? readablePartialWork(readFileSync(partialFile, "utf8")).slice(0, 1_600)
          : "";
      lines.push(
        `## ${entry.taskId} — ${entry.role} (${task.status})`,
        "",
        output?.summaryMarkdown ??
        (partial !== ""
          ? [
            "Partial notes preserved when the research session ended before a structured return; they have not been independently checked:",
            "",
            partial,
          ].join("\n")
          : task.error ?? task.interruptReason ?? "No mathematical return was completed."),
        "",
      );
    }
    return lines.join("\n");
  }

  /** Refresh old closed-round summaries when a return or partial note was recovered. */
  private repairClosedTrajectoryDockets(): void {

    for (const waveId of this.state.waveOrder) {
      const wave = this.state.waves[waveId]!;
      if (wave.status !== "closed") continue;
      const docketMarkdown = this.trajectoryWaveDocket(waveId);
      if (docketMarkdown === wave.docketMarkdown) continue;
      this.emitEvent({ type: "wave.closed", waveId, docketMarkdown });
    }
  }

  /**
   * Repair projects written by the early trajectories-v2 allocator bug.
   *
   * Those logs reused A001 for every Solver and E001 for every Explorer. The
   * task-local structured returns are durable, so replay can reconstruct the
   * intended write-ups without rewriting history: each recovered file is
   * followed by a fresh artifact event, and affected claim source labels are
   * corrected by their own audit events. The historical first-record order is
   * used so recovered identifiers retain completion order. Once repaired,
   * repeated loads are byte- and event-idempotent.
   */
  private repairCollidedTrajectoryWriteups(): void {

    const owners = new Map<string, Set<string>>();
    const orderedTasks: Record<"solver" | "explorer", string[]> = {
      solver: [],
      explorer: [],
    };
    const seenTasks = new Set<string>();
    for (const event of this.log.events) {
      if (event.type !== "artifact.recorded" || event.kind !== "writeup" || !event.taskId) {
        continue;
      }
      const role = this.state.tasks[event.taskId]?.role;
      if (role !== "solver" && role !== "explorer") continue;
      const artifactOwners = owners.get(event.artifactId) ?? new Set<string>();
      artifactOwners.add(event.taskId);
      owners.set(event.artifactId, artifactOwners);
      if (!seenTasks.has(event.taskId)) {
        seenTasks.add(event.taskId);
        orderedTasks[role].push(event.taskId);
      }
    }
    if (![...owners.values()].some((artifactOwners) => artifactOwners.size > 1)) return;

    for (const role of ["solver", "explorer"] as const) {
      const idKind: IdKind = role === "solver" ? "attempt" : "exploration";
      for (const [index, taskId] of orderedTasks[role].entries()) {
        const task = this.state.tasks[taskId];
        const output = task?.status === "completed" ? this.readTrajectoryOutput(taskId) : null;
        if (!task || !output) continue;

        const artifactId = makeId(idKind, index + 1);
        const relPath = path.join("writeups", `${artifactId}.md`);
        const markdown = output.writeupMarkdown.trim() + "\n";
        const absolutePath = path.join(this.paths.dir, relPath);
        const current = this.state.artifacts[artifactId];
        const fileMatches =
          existsSync(absolutePath) && readFileSync(absolutePath, "utf8") === markdown;
        if (
          current?.kind !== "writeup" ||
          current.taskId !== taskId ||
          current.path !== relPath ||
          !fileMatches
        ) {
          writeFileAtomic(absolutePath, markdown);
          this.emitEvent({
            type: "artifact.recorded",
            artifactId,
            kind: "writeup",
            taskId,
            path: relPath,
            conclusion: output.conclusion,
          });
        }

        for (const claimId of this.state.claimOrder) {
          const claim = this.state.claims[claimId]!;
          if (claim.sourceTaskId !== taskId) continue;
          const suffix = claim.provenance.match(/, result \d+$/)?.[0];
          if (!suffix || !claim.provenance.includes(`(from ${taskId})`)) continue;
          const repaired = `${artifactId} (from ${taskId})${suffix}`;
          if (claim.provenance === repaired) continue;
          this.emitEvent({
            type: "claim.provenanceRepaired",
            claimId,
            from: claim.provenance,
            to: repaired,
          });
        }
      }
    }
  }

  /** Recover usage written immediately before a valid trajectory output. */
  private readTrajectoryMetaUsage(taskId: string): Usage {
    const file = path.join(this.paths.tasksDir, taskId, "meta.json");
    if (!existsSync(file)) return ZERO_USAGE;
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as { usage?: unknown };
      const parsed = UsageSchema.safeParse(value.usage);
      return parsed.success ? parsed.data : ZERO_USAGE;
    } catch {
      return ZERO_USAGE;
    }
  }

  private async runTrajectoryWave(waveId: string): Promise<void> {
    const wave = this.state.waves[waveId]!;
    const jobs = wave.roster.map((entry) =>
      this.deps.pool.run(() => this.executeTrajectoryTask(waveId, entry)),
    );
    await Promise.all(jobs);
    if (this.stopped || this.state.waves[waveId]!.status === "closed") return;
    this.emitEvent({
      type: "wave.closed",
      waveId,
      docketMarkdown: this.trajectoryWaveDocket(waveId),
    });
  }

  private async executeTrajectoryTask(waveId: string, entry: RosterEntry): Promise<void> {
    if (this.stopped || (entry.role !== "solver" && entry.role !== "explorer")) return;
    const task = this.state.tasks[entry.taskId]!;
    if (task.status === "completed") {
      const output = this.readTrajectoryOutput(task.id);
      if (output) this.materializeTrajectoryReturn(waveId, entry, output);
      return;
    }
    if (task.status === "failed" || task.status === "interrupted") return;

    // output.json is written before task.completed. If the server stopped in
    // that narrow interval, the validated mathematical return is already the
    // durable source of truth and must not be recomputed by resuming the model.
    const recoveredOutput = this.readTrajectoryOutput(task.id);
    if (recoveredOutput) {
      this.emitEvent({
        type: "task.completed",
        taskId: task.id,
        usage: this.readTrajectoryMetaUsage(task.id),
      });
      this.materializeTrajectoryReturn(waveId, entry, recoveredOutput);
      return;
    }

    const wave = this.state.waves[waveId]!;
    const resuming = task.status === "running";
    if (resuming && task.threadId === null) {
      this.emitEvent({
        type: "task.interrupted",
        taskId: task.id,
        reason: "conductor-restart",
        usage: null,
      });
      return;
    }
    if (!resuming && wave.status === "softInterrupted") {
      this.emitEvent({
        type: "task.interrupted",
        taskId: task.id,
        reason: "round-soft-interrupt",
        usage: null,
      });
      return;
    }

    const taskDir = path.join(this.paths.tasksDir, task.id);
    const packetDir = path.join(taskDir, "packet");
    const previousMeta = resuming ? this.readTaskMeta(task.id) : null;
    const previousUsageResult = UsageSchema.safeParse(previousMeta?.usage);
    const previousUsage = previousUsageResult.success ? previousUsageResult.data : ZERO_USAGE;
    const previousCharge = resuming ? task.chargedTokens : 0;
    const previousBasis: TaskAccountingBasis =
      previousMeta?.accountingBasis === "reported" ||
        previousMeta?.accountingBasis === "estimated" ||
        previousMeta?.accountingBasis === "mixed"
        ? previousMeta.accountingBasis
        : "estimated";
    let manifest = task.packetManifest;
    if (!resuming) {
      try {
        mkdirSync(packetDir, { recursive: true });
        mkdirSync(path.join(packetDir, "scratch"), { recursive: true });
        const sameRole = wave.roster.filter((candidate) => candidate.role === entry.role);
        const ordinal = sameRole.findIndex((candidate) => candidate.taskId === entry.taskId) + 1;
        const files = trajectoryWorkerFiles(
          this.state,
          waveId,
          entry.taskId,
          entry.role,
          ordinal,
          this.trajectoryOwnerGuidance(waveId),
          this.deps.memory !== null,
        );
        for (const [name, content] of Object.entries(files)) {
          writeFileAtomic(path.join(packetDir, name), content);
        }
        manifest = [...Object.keys(files), "scratch/"].sort();
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
      } catch (error) {
        this.emitEvent({
          type: "task.failed",
          taskId: entry.taskId,
          error: `research context could not be prepared: ${String(error)}`,
        });
        return;
      }
    }

    const token = this.deps.memory?.mintToken({
      slug: this.slug,
      taskId: entry.taskId,
      role: entry.role,
      waveId,
    });
    const model = this.state.config.models[entry.role];
    const packetSize = manifest.reduce((total, relative) => {
      try {
        return total + statSync(path.join(packetDir, relative)).size;
      } catch {
        return total;
      }
    }, 0);

    try {
      const result = await runStructured(
        {
          bin: this.deps.codexBin,
          cwd: packetDir,
          prompt: resuming ? TRAJECTORY_RESTART_PROMPT : TRAJECTORY_WORKER_PROMPT,
          sandbox: "workspace-write",
          webSearch: this.state.config.allowWebSearch,
          // Do not inherit the repository's legacy council AGENTS.md. The
          // trajectory reads its deliberately composed packet/AGENTS.md and
          // retains shell, scratch-space, memory, and Web-search access.
          isolatedTask: true,
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
                enabledTools: MODEL_TOOL_NAMES,
              },
            }
            : {}),
          // The configured number is a planning target, not an exact live
          // meter. Exact usage arrives only at turn completion; interrupt at
          // 150% as an emergency ceiling while preserving long trajectories.
          maxEstimatedTokens: () =>
            Math.max(
              1,
              this.state.tasks[entry.taskId]!.budgetTokens * 1.5 - previousCharge,
            ),
          baseEstimatedTokens: CODEX_TURN_BASE_TOKENS + Math.ceil(packetSize / 4),
          wallClockMs:
            this.deps.taskWallClockMsOverride ??
            this.state.config.budget.taskWallClockMinutes * 60_000,
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
            if (now - last >= (this.deps.progressThrottleMs ?? 2_000)) {
              this.lastProgressAt.set(entry.taskId, now);
              this.emitEvent({
                type: "task.progress",
                taskId: entry.taskId,
                estimatedTokens: previousCharge + estimatedTokens,
                lastItem,
              });
            }
          },
        },
        TrajectoryOutput,
        {
          onInvalidOutput: (errors) =>
            this.emitEvent({ type: "task.outputInvalid", taskId: entry.taskId, errors }),
        },
      );
      const currentAccounting = structuredTaskAccounting(result);
      const cumulativeUsage = addUsage(previousUsage, result.usage);
      const accounting = resumedTaskAccounting(
        previousCharge,
        previousBasis,
        currentAccounting,
        cumulativeUsage,
      );

      writeFileAtomic(
        path.join(taskDir, "meta.json"),
        JSON.stringify(
          {
            workflow: "trajectories-v2",
            threadId: result.threadId,
            status: result.status,
            model: model.model,
            effort: model.effort,
            usage: cumulativeUsage,
            usageReported: accounting.reportedUsage !== null,
            estimatedTokens: accounting.chargedTokens,
            chargedTokens: accounting.chargedTokens,
            accountingBasis: accounting.basis,
            tokenAccounting: {
              kind: "soft-target",
              target: this.state.tasks[entry.taskId]!.budgetTokens,
              actual: accounting.chargedTokens,
              exceededBy: Math.max(
                0,
                accounting.chargedTokens - this.state.tasks[entry.taskId]!.budgetTokens,
              ),
            },
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      if (result.status === "completed" && result.output) {
        writeFileAtomic(path.join(taskDir, "output.json"), JSON.stringify(result.output, null, 2));
        this.trajectoryOutputs.set(entry.taskId, result.output);
        this.emitEvent({ type: "task.completed", taskId: entry.taskId, usage: cumulativeUsage });
        this.recordTaskAccounting(entry.taskId, accounting);
        this.materializeTrajectoryReturn(waveId, entry, result.output);
      } else if (result.status === "interrupted") {
        if (result.lastAgentMessage) {
          writeFileAtomic(path.join(taskDir, "salvage.md"), result.lastAgentMessage);
        }
        this.recordTaskAccounting(entry.taskId, accounting);
        // A process reload is a pause, not a mathematical outcome. Keep the
        // durable task running so the next engine resumes the same Codex
        // thread; explicit user interrupts still become terminal below.
        if (this.stopped && result.interruptReason === "killed") return;
        this.emitEvent({
          type: "task.interrupted",
          taskId: entry.taskId,
          reason: result.interruptReason ?? "interrupted",
          usage: accounting.reportedUsage,
        });
      } else {
        this.emitEvent({
          type: "task.failed",
          taskId: entry.taskId,
          usage: accounting.reportedUsage,
          error:
            (result.validationErrors
              ? `output invalid after repair: ${result.validationErrors.join("; ")}`
              : null) ??
            result.errorDetail ??
            "research process failed",
        });
        this.recordTaskAccounting(entry.taskId, accounting);
      }
    } finally {
      this.killHandles.delete(entry.taskId);
      if (token) this.deps.memory?.revokeToken(token);
    }
  }

  private materializeTrajectoryReturn(
    waveId: string,
    entry: RosterEntry,
    output: TrajectoryOutputT,
  ): void {
    let artifact = Object.values(this.state.artifacts).find(
      (candidate) => candidate.taskId === entry.taskId && candidate.kind === "writeup",
    );
    if (!artifact) {
      const artifactId = this.allocId(entry.role === "explorer" ? "exploration" : "attempt");
      const relPath = path.join("writeups", `${artifactId}.md`);
      writeFileAtomic(path.join(this.paths.dir, relPath), output.writeupMarkdown.trim() + "\n");
      this.emitEvent({
        type: "artifact.recorded",
        artifactId,
        kind: "writeup",
        taskId: entry.taskId,
        path: relPath,
        conclusion: output.conclusion,
      });
      artifact = this.state.artifacts[artifactId]!;
    }

    for (const [index, proposed] of output.claims.entries()) {
      const provenance = `${artifact.id} (from ${entry.taskId}), result ${index + 1}`;
      let claim = Object.values(this.state.claims).find(
        (candidate) =>
          candidate.sourceTaskId === entry.taskId && candidate.provenance === provenance,
      );
      if (!claim) {
        const claimId = this.allocId("claim");
        const relPath = path.join("claims", `${claimId}.md`);
        const markdown = [
          `# ${proposed.title}`,
          "",
          `Relation to the original problem: **${proposed.relationToGoal}**`,
          "",
          "## Statement",
          "",
          proposed.statementMarkdown.trim(),
          "",
          "## Alleged proof",
          "",
          proposed.proofMarkdown.trim(),
          "",
        ].join("\n");
        writeFileAtomic(path.join(this.paths.dir, relPath), markdown);
        this.emitEvent({
          type: "claim.added",
          claimId,
          title: proposed.title.trim(),
          statement: proposed.statementMarkdown.trim(),
          proofMarkdown: proposed.proofMarkdown.trim(),
          status: "UNVERIFIED",
          provenance,
          sourceTaskId: entry.taskId,
          sourceWaveId: waveId,
          path: relPath,
          relationToGoal: proposed.relationToGoal,
          kind: "mathematical",
          targetFactId: null,
          verificationPolicy: {
            verifiersPerClaim: this.state.config.trajectory.verifiersPerClaim,
            passesRequired: this.state.config.trajectory.passesRequired,
          },
          dependsOn: [],
        });
        claim = this.state.claims[claimId]!;
        const normalized = normalizeClaimStatement(claim.statement);
        for (const olderId of this.state.claimOrder) {
          if (olderId === claim.id) continue;
          const older = this.state.claims[olderId]!;
          if (
            normalizeClaimStatement(older.statement) === normalized &&
            !older.equivalentIds.includes(claim.id)
          ) {
            this.emitEvent({
              type: "claim.equivalent",
              leftClaimId: older.id,
              rightClaimId: claim.id,
              reason: "The normalized mathematical statements are identical.",
              by: "conductor",
            });
          }
        }
      }
    }
  }

  /**
   * Compare statements once per round before any new proof is sent for
   * checking. This call cannot edit claims or steer research; it only records
   * conservative identity relations between exact mathematical statements.
   */
  private async compareTrajectoryClaims(waveId: string): Promise<void> {
    const wave = this.state.waves[waveId];
    if (!wave || wave.claimsCompared) return;
    const currentIds = this.state.claimOrder.filter(
      (claimId) => this.state.claims[claimId]?.sourceWaveId === waveId,
    );
    const comparable = currentIds.some((claimId) => {
      const claim = this.state.claims[claimId]!;
      return this.state.claimOrder.some((otherId) => {
        if (otherId === claimId) return false;
        const other = this.state.claims[otherId]!;
        return (
          other.kind === claim.kind &&
          other.targetFactId === claim.targetFactId &&
          other.relationToGoal === claim.relationToGoal &&
          !claim.equivalentIds.includes(otherId)
        );
      });
    });

    if (comparable) {
      const decisionId = this.allocId("decision");
      this.emitEvent({ type: "decision.requested", decisionId, kind: "curation", waveId });
      const call = await this.runReaderCall(
        decisionId,
        claimComparisonFiles(this.state, waveId),
        CLAIM_COMPARISON_PROMPT,
        ClaimComparisonOutput,
        {
          model: this.state.config.models.summaryReader,
          isolatedTask: true,
          memoryAccess: false,
          webSearch: false,
        },
      );
      if (this.stopped) return;
      this.emitEvent({
        type: "decision.proposed",
        decisionId,
        action: call.output,
        usage: call.usage,
      });

      if (call.output) {
        const current = new Set(currentIds);
        const groups: string[][] = [];
        for (const proposed of call.output.equivalentClaimGroups) {
          const ids = [...new Set(proposed.map((id) => id.trim()))].filter(
            (id) => this.state.claims[id] !== undefined,
          );
          if (ids.length < 2 || !ids.some((id) => current.has(id))) continue;
          const first = this.state.claims[ids[0]!]!;
          if (
            ids.some((id) => {
              const claim = this.state.claims[id]!;
              return (
                claim.kind !== first.kind ||
                claim.targetFactId !== first.targetFactId ||
                claim.relationToGoal !== first.relationToGoal
              );
            })
          ) {
            continue;
          }
          groups.push(ids);
        }
        const accepted = { equivalentClaimGroups: groups };
        this.emitEvent({ type: "decision.accepted", decisionId, action: accepted });
        for (const ids of groups) {
          for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
              const left = this.state.claims[ids[leftIndex]!]!;
              const right = this.state.claims[ids[rightIndex]!]!;
              if (left.equivalentIds.includes(right.id)) continue;
              this.emitEvent({
                type: "claim.equivalent",
                leftClaimId: left.id,
                rightClaimId: right.id,
                reason: `The pre-review comparison found the mathematical statements identical (${waveId}).`,
                by: "summary_reader",
              });
            }
          }
        }
      } else {
        this.emitEvent({
          type: "decision.rejected",
          decisionId,
          violations: [call.error ?? "claim comparison failed"],
        });
      }
    }

    this.emitEvent({ type: "wave.claimsCompared", waveId });
    this.repairTrajectoryInvariants();
  }

  /** Only one proof in an identical-statement group is checked at a time. */
  private claimVerificationRepresentative(claimId: string): string | null {
    const component = this.equivalentClaimComponent(claimId)
      .filter((id) => this.state.claims[id]?.status === "UNVERIFIED")
      .sort(
        (left, right) =>
          this.state.claimOrder.indexOf(left) - this.state.claimOrder.indexOf(right),
      );
    if (component.length === 0) return null;
    const alreadyStarted = component.find(
      (id) => (this.state.claims[id]?.verificationIds.length ?? 0) > 0,
    );
    return alreadyStarted ?? component[0]!;
  }

  private ensureClaimVerifications(claimId: string): void {
    const claim = this.state.claims[claimId];
    if (!claim || claim.status !== "UNVERIFIED") return;
    if (this.claimVerificationRepresentative(claimId) !== claimId) return;
    const target =
      claim.verificationPolicy?.verifiersPerClaim ??
      this.state.config.trajectory.verifiersPerClaim;
    const usefulOrPending = claim.verificationIds.filter((verificationId) => {
      const verification = this.state.verifications[verificationId];
      return verification?.status !== "completed" || verification.verdict !== "ERROR";
    }).length;
    const maxAttempts = target + MAX_VERIFICATION_PROCESS_REPLACEMENTS;
    const needed = Math.max(
      0,
      Math.min(target - usefulOrPending, maxAttempts - claim.verificationIds.length),
    );
    for (let offset = 0; offset < needed; offset += 1) {
      this.emitEvent({
        type: "verification.requested",
        verificationId: this.allocId("verification"),
        claimId,
        ordinal: claim.verificationIds.length + 1,
      });
    }
  }

  private launchPendingVerifications(): void {
    for (const verificationId of this.state.verificationOrder) {
      const verification = this.state.verifications[verificationId]!;
      if (
        verification.status === "completed" ||
        this.verificationPromises.has(verificationId)
      ) {
        continue;
      }
      const promise = this.deps.pool
        .run(() => this.executeVerification(verificationId))
        .catch((error) => {
          if (this.stopped || this.state.verifications[verificationId]?.status === "completed") return;
          this.emitEvent({
            type: "verification.completed",
            verificationId,
            verdict: "ERROR",
            finding: null,
            summaryMarkdown: `The verification process failed: ${String(error).slice(0, 1_500)}`,
            artifactPath: null,
            usage: null,
          });
        })
        .finally(() => {
          this.verificationPromises.delete(verificationId);
          this.wakeWaiters.splice(0).forEach((wake) => wake());
        });
      this.verificationPromises.set(verificationId, promise);
    }
  }

  private async executeVerification(verificationId: string): Promise<void> {
    const verification = this.state.verifications[verificationId];
    if (!verification || verification.status === "completed" || this.stopped) return;
    const claim = this.state.claims[verification.claimId];
    if (!claim) return;
    if (verification.status === "queued") {
      this.emitEvent({ type: "verification.started", verificationId });
    }

    const dir = path.join(this.paths.verificationsDir, verificationId);
    const packetDir = path.join(dir, "packet");
    const outputFile = path.join(dir, "output.json");
    const recoveredMeta = this.readVerificationMeta(dir);
    if (
      existsSync(outputFile) &&
      recoveredMeta.filesystemIsolation === VERIFIER_FILESYSTEM_ISOLATION
    ) {
      try {
        const recoveredJson = JSON.parse(readFileSync(outputFile, "utf8")) as unknown;
        // A check may have written output.json immediately before a server
        // upgrade added finding categories. Preserve that durable result.
        const compatible =
          recoveredJson !== null &&
            typeof recoveredJson === "object" &&
            !("finding" in recoveredJson) &&
            ((recoveredJson as { verdict?: unknown }).verdict === "PASS" ||
              (recoveredJson as { verdict?: unknown }).verdict === "FAIL")
            ? {
              ...recoveredJson,
              finding:
                (recoveredJson as { verdict: "PASS" | "FAIL" }).verdict === "PASS"
                  ? "NONE"
                  : "PROOF_GAP",
            }
            : recoveredJson;
        const recovered = VerificationOutput.safeParse(compatible);
        if (recovered.success) {
          const relPath = path.join("verifications", verificationId, "report.md");
          writeFileAtomic(
            path.join(this.paths.dir, relPath),
            recovered.data.reportMarkdown.trim() + "\n",
          );
          this.emitEvent({
            type: "verification.completed",
            verificationId,
            verdict: recovered.data.verdict,
            finding: recovered.data.finding,
            summaryMarkdown: recovered.data.summaryMarkdown,
            artifactPath: relPath,
            usage: recoveredMeta.usage,
          });
          this.evaluateTrajectoryClaim(claim.id);
          return;
        }
      } catch {
        // A partial or corrupt file is not durable evidence; run the check.
      }
    }
    mkdirSync(path.join(packetDir, "scratch"), { recursive: true });
    const claimMarkdown = claim.path && existsSync(path.join(this.paths.dir, claim.path))
      ? readFileSync(path.join(this.paths.dir, claim.path), "utf8")
      : [
        `# ${claim.title}`,
        "",
        `Relation to the original problem: **${claim.relationToGoal}**`,
        "",
        "## Statement",
        "",
        claim.statement,
        "",
        "## Alleged proof",
        "",
        claim.proofMarkdown,
      ].join("\n");
    const files = verificationFiles(
      this.state.problem.confirmedMarkdown ?? this.state.statement,
      claim.id,
      claimMarkdown,
      verification.ordinal,
    );
    for (const [name, content] of Object.entries(files)) {
      writeFileAtomic(path.join(packetDir, name), content);
    }
    const packetSize = Object.keys(files).reduce((total, name) => {
      try {
        return total + statSync(path.join(packetDir, name)).size;
      } catch {
        return total;
      }
    }, 0);
    const model = this.state.config.models.verifier;
    const killKey = `verification:${verificationId}`;
    const result = await runStructured(
      {
        bin: this.deps.codexBin,
        cwd: packetDir,
        prompt: VERIFICATION_PROMPT,
        sandbox: "workspace-write",
        permissionProfile: {
          name: "inventio_verifier",
          filesystem: {
            ":minimal": "read",
            [packetDir]: "write",
          },
        },
        webSearch: this.state.config.allowWebSearch,
        isolatedTask: true,
        eventsArchiveFile: path.join(dir, "codex-events.jsonl"),
        model: model.model,
        effort: model.effort,
        outputSchemaFile: path.join(dir, "output-schema.json"),
        outputLastMessageFile: path.join(dir, "last-message.json"),
        maxEstimatedTokens: Math.min(750_000, this.state.config.budget.defaultTaskTokens),
        baseEstimatedTokens: CODEX_TURN_BASE_TOKENS + Math.ceil(packetSize / 4),
        wallClockMs: this.deps.taskWallClockMsOverride ?? 60 * 60_000,
        killGraceMs: this.deps.killGraceMs ?? 10_000,
        registerKill: (kill) => this.killHandles.set(killKey, kill),
      },
      VerificationOutput,
    ).finally(() => this.killHandles.delete(killKey));
    if (this.stopped || this.state.verifications[verificationId]?.status === "completed") return;

    if (result.status === "completed" && result.output) {
      const relPath = path.join("verifications", verificationId, "report.md");
      writeFileAtomic(path.join(this.paths.dir, relPath), result.output.reportMarkdown.trim() + "\n");
      writeFileAtomic(
        path.join(dir, "meta.json"),
        JSON.stringify(
          {
            workflow: "trajectories-v2",
            filesystemIsolation: VERIFIER_FILESYSTEM_ISOLATION,
            status: result.status,
            model: model.model,
            effort: model.effort,
            usage: result.usage,
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      writeFileAtomic(
        outputFile,
        JSON.stringify(result.output, null, 2),
      );
      this.emitEvent({
        type: "verification.completed",
        verificationId,
        verdict: result.output.verdict,
        finding: result.output.finding,
        summaryMarkdown: result.output.summaryMarkdown,
        artifactPath: relPath,
        usage: result.usage,
      });
    } else {
      this.emitEvent({
        type: "verification.completed",
        verificationId,
        verdict: "ERROR",
        finding: null,
        summaryMarkdown:
          result.errorDetail ??
          result.validationErrors?.join("; ") ??
          result.interruptReason ??
          "The verification process did not return a verdict.",
        artifactPath: null,
        usage: result.usage,
      });
    }
    this.evaluateTrajectoryClaim(claim.id);
  }

  private readVerificationMeta(dir: string): {
    usage: Usage;
    filesystemIsolation: string | null;
  } {
    const file = path.join(dir, "meta.json");
    if (!existsSync(file)) {
      return { usage: ZERO_USAGE, filesystemIsolation: null };
    }
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        usage?: unknown;
        filesystemIsolation?: unknown;
      };
      const parsed = UsageSchema.safeParse(value.usage);
      return {
        usage: parsed.success ? parsed.data : ZERO_USAGE,
        filesystemIsolation:
          typeof value.filesystemIsolation === "string" ? value.filesystemIsolation : null,
      };
    } catch {
      return { usage: ZERO_USAGE, filesystemIsolation: null };
    }
  }

  private evaluateTrajectoryClaim(claimId: string): void {
    const claim = this.state.claims[claimId];
    if (!claim || claim.status !== "UNVERIFIED") return;
    // A crashed or malformed verifier is operational noise, not mathematical
    // evidence. Replace it with a fresh independent check before evaluating
    // the configured W-out-of-V rule.
    this.ensureClaimVerifications(claimId);
    const results = claim.verificationIds
      .map((id) => this.state.verifications[id]!)
      .filter((verification) => verification.status === "completed");
    const passes = results.filter((verification) => verification.verdict === "PASS").length;
    const failedChecks = results.filter((verification) => verification.verdict === "FAIL");
    const failures = failedChecks.length;
    const { passesRequired, verifiersPerClaim } =
      claim.verificationPolicy ?? this.state.config.trajectory;
    if (passes >= passesRequired) {
      this.promoteTrajectoryClaim(claim.id);
      return;
    }
    const pending = claim.verificationIds.some(
      (id) => this.state.verifications[id]?.status !== "completed",
    );
    const completedMathematicalChecks = passes + failures;
    if (!pending && completedMathematicalChecks >= verifiersPerClaim && passes < passesRequired) {
      const detail = [
        `${passes} PASS`,
        `${failures} FAIL`,
      ].join(", ");
      const mathematicalFailure = failedChecks.some(
        (verification) =>
          verification.finding === null ||
          verification.finding === "INCORRECT" ||
          verification.finding === "PROOF_GAP",
      );
      const nextStatus = mathematicalFailure ? "FAILED" : "NEEDS_REVISION";
      const findingDetail = [...new Set(failedChecks.map((verification) => verification.finding).filter(Boolean))]
        .join(", ");
      this.emitEvent({
        type: "claim.status",
        claimId: claim.id,
        from: "UNVERIFIED",
        to: nextStatus,
        justification:
          nextStatus === "NEEDS_REVISION"
            ? `the submitted text received ${detail} (${findingDetail || "incomplete presentation"}); revise the missing dependency or notation before checking it again`
            : `the submitted proof received ${detail}; ${passesRequired} passes out of ${verifiersPerClaim} independent checks are no longer possible. This does not assert that the statement itself is false`,
        by: "conductor",
      });
      if (nextStatus === "FAILED" && claim.kind === "correction" && claim.targetFactId) {
        this.emitEvent({
          type: "fact.suspicionCleared",
          factId: claim.targetFactId,
          correctionClaimId: claim.id,
          reason: "The proposed correction did not pass independent verification.",
        });
      }
    }
  }

  /**
   * Complete the second half of any multi-event mathematical transition that
   * was interrupted by a process crash. Files are written before their event,
   * and event IDs are allocated from replayed counters, so every repair is
   * idempotent across repeated restarts.
   */
  private repairTrajectoryInvariants(): void {
    for (const claimId of this.state.claimOrder) {
      const claim = this.state.claims[claimId]!;
      if (claim.status === "VERIFIED") {
        let factId = claim.promotedFactId;
        if (!factId || !this.state.facts[factId]) {
          const existing = this.equivalentClaimComponent(claim.id)
            .map((id) => this.state.claims[id]?.promotedFactId)
            .find((id): id is string => Boolean(id && this.state.facts[id]));
          factId = existing ?? this.recordTrajectoryFact(claim);
        }
        if (
          claim.kind === "correction" &&
          claim.targetFactId &&
          (this.state.facts[claim.targetFactId]?.status === "ACTIVE" ||
            this.state.facts[claim.targetFactId]?.status === "SUSPICIOUS")
        ) {
          this.emitEvent({
            type: "fact.retracted",
            factId: claim.targetFactId,
            correctionClaimId: claim.id,
            reason: "The concrete correction passed independent verification.",
          });
        }
        for (const siblingId of this.equivalentClaimComponent(claim.id)) {
          if (siblingId === claim.id) continue;
          const sibling = this.state.claims[siblingId]!;
          if (sibling.status !== "UNVERIFIED" && sibling.status !== "NEEDS_REVISION") continue;
          this.emitEvent({
            type: "claim.status",
            claimId: sibling.id,
            from: sibling.status,
            to: "SUPERSEDED",
            justification: `the identical statement was established as ${factId}; its distinct proof remains in ${sibling.path ?? sibling.provenance}`,
            by: "conductor",
          });
        }
      } else if (
        (claim.status === "FAILED" || claim.status === "REFUTED") &&
        claim.kind === "correction" &&
        claim.targetFactId &&
        this.state.facts[claim.targetFactId]?.status === "SUSPICIOUS"
      ) {
        this.emitEvent({
          type: "fact.suspicionCleared",
          factId: claim.targetFactId,
          correctionClaimId: claim.id,
          reason: "The proposed correction did not pass independent verification.",
        });
      }
    }
  }

  private equivalentClaimComponent(claimId: string): string[] {
    const seen = new Set<string>();
    const pending = [claimId];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (seen.has(next) || !this.state.claims[next]) continue;
      seen.add(next);
      pending.push(...this.state.claims[next]!.equivalentIds);
    }
    return [...seen];
  }

  private recordTrajectoryFact(claim: ClaimState): string {
    const factId = this.allocId("fact");
    const relPath = path.join("facts", `${factId}.md`);
    writeFileAtomic(
      path.join(this.paths.dir, relPath),
      [
        `# ${claim.title}`,
        "",
        "## Statement",
        "",
        claim.statement,
        "",
        "## Proof",
        "",
        claim.proofMarkdown,
        "",
      ].join("\n"),
    );
    this.emitEvent({ type: "fact.recorded", factId, claimId: claim.id, path: relPath });
    return factId;
  }

  private promoteTrajectoryClaim(claimId: string): void {
    const claim = this.state.claims[claimId];
    if (!claim || claim.status !== "UNVERIFIED") return;
    const component = this.equivalentClaimComponent(claimId);
    const existingFact = component
      .map((id) => this.state.claims[id]?.promotedFactId)
      .find((id): id is string =>
        Boolean(
          id &&
          (this.state.facts[id]?.status === "ACTIVE" ||
            this.state.facts[id]?.status === "SUSPICIOUS"),
        ),
      );

    this.emitEvent({
      type: "claim.status",
      claimId: claim.id,
      from: "UNVERIFIED",
      to: "VERIFIED",
      justification: `received at least ${claim.verificationPolicy?.passesRequired ?? this.state.config.trajectory.passesRequired
        } independent PASS verdicts`,
      by: "conductor",
    });

    let factId = existingFact;
    if (!factId) {
      factId = this.recordTrajectoryFact(claim);
    }

    if (claim.kind === "correction" && claim.targetFactId) {
      this.emitEvent({
        type: "fact.retracted",
        factId: claim.targetFactId,
        correctionClaimId: claim.id,
        reason: "The concrete correction passed independent verification.",
      });
    }

    for (const siblingId of component) {
      if (siblingId === claim.id) continue;
      const sibling = this.state.claims[siblingId]!;
      if (sibling.status !== "UNVERIFIED" && sibling.status !== "NEEDS_REVISION") continue;
      this.emitEvent({
        type: "claim.status",
        claimId: sibling.id,
        from: sibling.status,
        to: "SUPERSEDED",
        justification: `the identical statement was established as ${factId}; its distinct proof remains in ${sibling.path ?? sibling.provenance}`,
        by: "conductor",
      });
    }
  }

  private async drainVerifications(): Promise<void> {
    while (!this.stopped) {
      for (const claimId of this.state.claimOrder) this.evaluateTrajectoryClaim(claimId);
      for (const claimId of this.state.claimOrder) this.ensureClaimVerifications(claimId);
      this.launchPendingVerifications();
      const active = [...this.verificationPromises.values()];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  private trajectoryDecisiveResult(): "PROVED" | "DISPROVED" | null {
    let proves = false;
    let disproves = false;
    for (const factId of this.state.factOrder) {
      const fact = this.state.facts[factId]!;
      if (fact.status !== "ACTIVE") continue;
      const relation = this.state.claims[fact.claimId]?.relationToGoal;
      if (relation === "PROVES") proves = true;
      if (relation === "DISPROVES") disproves = true;
    }
    if (proves === disproves) return null;
    return proves ? "PROVED" : "DISPROVED";
  }

  private async reviewTrajectorySummary(waveId: string): Promise<void> {
    const wave = this.state.waves[waveId]!;
    if (wave.summaryReviewed) return;
    const current = latestMathematicalView(this.state);
    const decisionId = this.allocId("decision");
    this.emitEvent({ type: "decision.requested", decisionId, kind: "curation", waveId });
    const call = await this.runReaderCall(
      decisionId,
      summaryReviewFiles(
        this.state,
        waveId,
        wave.docketMarkdown ?? "No research summary was recovered.",
      ),
      SUMMARY_REVIEW_PROMPT,
      SummaryRevisionOutput,
      {
        model: this.state.config.models.summaryReader,
        isolatedTask: true,
        memoryAccess: false,
        webSearch: false,
      },
    );
    if (this.stopped) return;
    this.emitEvent({
      type: "decision.proposed",
      decisionId,
      action: call.output,
      usage: call.usage,
    });

    let markdown = current.markdown;
    let abstract = current.abstract;
    let changed = false;
    let reason = call.error ?? "The summary reader returned no revision; the preceding view is retained.";
    let source: "summary_reader" | "fallback" = "fallback";
    if (call.output) {
      const revisionViolations = [
        ...(call.output.markdown.length > 16_000
          ? ["mathematical view exceeds 16,000 characters"]
          : []),
        ...summaryAbstractViolations(call.output.abstract),
      ];
      const validRevision = revisionViolations.length === 0;
      if (validRevision) {
        this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
        source = "summary_reader";
        const abstractChanged = call.output.abstract.trim() !== current.abstract.trim();
        changed = call.output.changed || abstractChanged;
        reason = call.output.reason || (changed ? "The mathematical picture changed." : "No material change.");
        if (call.output.changed) {
          markdown = call.output.markdown;
        }
        abstract = call.output.abstract;
      } else {
        reason = `The proposed edit was not a complete concise mathematical view: ${revisionViolations.join("; ")}. The preceding view was retained.`;
        this.emitEvent({ type: "decision.rejected", decisionId, violations: revisionViolations });
      }
    } else {
      this.emitEvent({
        type: "decision.rejected",
        decisionId,
        violations: [call.error ?? "summary review failed"],
      });
    }

    this.recordMathematicalView(
      waveId,
      markdown,
      abstract,
      source,
      changed,
      reason,
      null,
    );
    this.emitEvent({ type: "wave.summaryReviewed", waveId });
    for (const claimId of this.state.claimOrder) this.evaluateTrajectoryClaim(claimId);
  }

  private async finalizeTrajectory(result: Result, reason: string): Promise<void> {
    if (this.state.terminal) return;
    let body: string | null = null;
    if (this.remainingBudget() > 0) {
      const decisionId = this.allocId("decision");
      this.emitEvent({ type: "decision.requested", decisionId, kind: "final", waveId: null });
      const call = await this.runReaderCall(
        decisionId,
        trajectoryFinalFiles(this.state, result, reason),
        TRAJECTORY_FINAL_PROMPT,
        FinalOutput,
        {
          model: this.state.config.models.summaryReader,
          isolatedTask: true,
          memoryAccess: false,
          webSearch: false,
        },
      );
      this.emitEvent({
        type: "decision.proposed",
        decisionId,
        action: call.output,
        usage: call.usage,
      });
      if (call.output) {
        this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
        body = call.output.finalMarkdown;
      } else {
        this.emitEvent({
          type: "decision.rejected",
          decisionId,
          violations: [call.error ?? "final report call failed"],
        });
      }
    }
    if (body === null) {
      const facts = this.state.factOrder
        .map((id) => this.state.facts[id]!)
        .filter((fact) => fact.status === "ACTIVE")
        .map((fact) => `## ${fact.title || fact.id}\n\n${fact.statement}\n\n### Proof\n\n${fact.proofMarkdown}`)
        .join("\n\n");
      const unsettled = this.state.factOrder
        .map((id) => this.state.facts[id]!)
        .filter((fact) => fact.status === "SUSPICIOUS")
        .map((fact) => `- ${fact.title || fact.id}: a concrete correction is still unresolved`)
        .join("\n");
      body = [
        "# Research report",
        "",
        `Research stopped because ${reason}.`,
        "",
        facts || "No new claim completed the configured independent verification process.",
        ...(unsettled ? ["", "## Results with unresolved challenges", "", unsettled] : []),
      ].join("\n");
    }
    body = body.replace(/^RESULT:.*\n+/i, "");
    const reportNumber = this.state.terminalHistory.length + 1;
    const firstReport = reportNumber === 1 && this.state.artifacts["final"] === undefined;
    const artifactId = firstReport ? "final" : `final-${reportNumber}`;
    const relPath = firstReport
      ? path.join("artifacts", "final.md")
      : path.join("artifacts", "finals", `${artifactId}.md`);
    writeFileAtomic(path.join(this.paths.dir, relPath), `RESULT: ${result}\n\n${body}`);
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

  // --------------------------------------------- mathematical reader process

  private async runReaderCall<T>(
    decisionId: string,
    files: Record<string, string>,
    prompt: string,
    schema: z.ZodType<T>,
    options: {
      model?: ModelChoice;
      isolatedTask?: boolean;
      memoryAccess?: boolean;
      intakeSources?: IntakeSource[];
      webSearch?: boolean;
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
      mkdirSync(path.dirname(path.join(packetDir, name)), { recursive: true });
      writeFileSync(path.join(packetDir, name), content);
    }
    if (options.intakeSources) {
      copyIntakeSourcesToPacket(this.paths, options.intakeSources, packetDir);
    }
    const model = options.model ?? this.state.config.models.summaryReader;
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
          webSearch: options.webSearch ?? false,
          ...(this.deps.memory && token
            ? {
              mcp: {
                serverName: "memory",
                url: this.deps.memory.url,
                tokenEnvVar: "INVENTIO_TASK_TOKEN",
                token,
                enabledTools: MODEL_TOOL_NAMES,
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
    const processLabel =
      "mathematical reader";
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
          ? `${processLabel} timed out`
          : result.interruptReason === "killed"
            ? `${processLabel} was stopped`
            : `${processLabel} interrupted${result.interruptReason ? ` (${result.interruptReason})` : ""}`
        : null;
    return {
      output: null,
      usage,
      error:
        result.errorDetail ??
        (result.validationErrors
          ? `invalid ${processLabel} output: ${result.validationErrors.join("; ")}`
          : interruption ?? `${processLabel} ${result.status}`),
      status: result.status,
      interruptReason: result.interruptReason,
    };
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
   * if the mathematical reader returns a valid result, so a failed call loses no
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
    const call = await this.runReaderCall(
      decisionId,
      trajectoryIntakeFiles(this.state.statement, this.state.contextMarkdown),
      TRAJECTORY_INTAKE_PROMPT,
      IntakeOutput,
      {
        model: this.state.config.models.summaryReader,
        isolatedTask: true,
        memoryAccess: true,
        intakeSources: indexedSources,
        webSearch: this.state.config.allowWebSearch,
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

      this.recordMathematicalView(
        "W000",
        managerNote || this.fallbackInitialView(),
        call.output.managerAbstract.trim() || this.fallbackInitialAbstract(),
        managerNote ? "intake" : "fallback",
        true,
        "Initial reading of the retained intake materials.",
        null,
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

      this.recordMathematicalView(
        "W000",
        this.fallbackInitialView(),
        this.fallbackInitialAbstract(),
        "fallback",
        true,
        "The automatic initial reading did not complete.",
        null,
      );
    }
    this.phaseTo("AWAITING_CONFIRMATION", "intake complete");
  }

  private fallbackInitialAbstract(): string {
    return "The initial mathematical reading did not complete; the original objective and materials remain available for another attempt.";
  }

  private fallbackInitialView(): string {
    return [
      "# Current mathematical view",
      "",
      "The initial mathematical reading did not complete. No interpretation has been substituted for the owner's submission.",
      "",
      "Use the original objective and materials below, then regenerate or edit W000 before beginning research.",
    ].join("\n");
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
      throw new Error("W000 is still being regenerated; wait for the mathematical reading to finish");
    }
    const currentW000 =
      this.state.mathematicalViews.find((entry) => entry.waveId === "W000");
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
      const current =
        this.state.mathematicalViews.find((entry) => entry.waveId === "W000");
      if (!current || current.markdown.trim() !== note || current.abstract.trim() !== abstract) {
        this.recordMathematicalView(
          "W000",
          note,
          abstract,
          "human_edited",
          true,
          "Edited by the owner before research began.",
          null,
        );
      }
    }
    this.emitEvent({
      type: "problem.confirmed",
      problemMarkdown,
      contextDigestMarkdown: confirmedDigest,
      rawMemories: confirmedMemories,
    });

    this.phaseTo("DISCOVERY", "problem confirmed by human");
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

    this.recordMathematicalView(
      "W000",
      managerNoteMarkdown,
      managerAbstract,
      "human_edited",
      true,
      "Copied from the owner-reviewed intake of the source project.",
      null,
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

  private recordMathematicalView(
    waveId: string,
    markdown: string,
    abstract: string,
    source: "intake" | "summary_reader" | "human_edited" | "fallback",
    changed: boolean,
    reason: string,
    usage: Usage | null,
  ): void {
    const relPath = path.join("artifacts", "mathematical-view", `${waveId}.md`);
    const text = normalizeMathematicalViewMarkdown(waveId, markdown) + "\n";
    writeFileAtomic(path.join(this.paths.mathematicalViewsDir, `${waveId}.md`), text);
    this.emitEvent({
      type: "summary.recorded",
      waveId,
      path: relPath,
      abstract: abstract.trim(),
      markdown: text,
      changed,
      reason,
      source,
      usage,
    });
  }

  // ----------------------------------------------------------- publication

  private getPublicationCompiler(): PublicationCompiler {
    return (
      this.deps.publicationCompiler ??
      createTectonicCompiler(process.env["INVENTIO_TEX_BIN"] ?? "tectonic")
    );
  }

  private publicationInternalIds(): string[] {
    const ids = [
      ...this.state.waveOrder,
      ...this.state.mathematicalViews.map((note) => note.waveId),
      ...this.state.factOrder,
      ...this.state.verificationOrder,
      ...Object.keys(this.state.tasks),
      ...Object.keys(this.state.artifacts),
      ...Object.keys(this.state.lineages),
      ...Object.keys(this.state.candidates),
      ...Object.keys(this.state.reviews),
      ...Object.keys(this.state.claims),
      ...Object.keys(this.state.issues),
      ...Object.keys(this.state.cards),
      ...Object.keys(this.state.questions),
      ...Object.keys(this.state.directives),
      ...Object.keys(this.state.decisions),
      ...Object.keys(this.state.computations),
      ...this.state.problem.sources.map((source) => source.id),
      ...this.state.publications.map((publication) => publication.id),
    ];
    // Some artifact keys (notably "final") are ordinary English words. Only
    // structural labels belong to the private research notation and should be
    // forbidden in the standalone manuscript.
    return [...new Set(ids.filter((id) => /^(?:DEC\d+|[WTAECRKIMQDXSPFV]\d+)(?:\.v\d+)?$/.test(id)))];
  }

  /**
   * Copy the complete text record into the read-only publication directory.
   * It is an on-demand library, not one giant injected prompt: the reader
   * chooses which full write-ups to open after reading the index.
   */
  private publicationRecordFiles(): {
    files: Record<string, string>;
    index: string;
  } {
    const files: Record<string, string> = {};
    const index = [
      "# Complete research record",
      "",
      "Open the full files below as needed for the final mathematical check. Internal labels are navigation aids in this private directory only and must not appear in the standalone manuscript.",
      "",
      "## Mathematical write-ups",
      "",
    ];
    let totalCharacters = 0;
    const totalCap = 50_000_000;
    const fileCap = 5_000_000;
    const add = (name: string, absolutePath: string, label: string): void => {
      if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        index.push("- " + label + ": file unavailable");
        return;
      }
      const size = statSync(absolutePath).size;
      if (size > fileCap || totalCharacters + size > totalCap) {
        index.push("- " + label + ": omitted from the copied reading directory because it exceeds the safety size limit");
        return;
      }
      const content = repairLegacyArtifactControls(readFileSync(absolutePath, "utf8"));
      files[name] = content;
      totalCharacters += content.length;
      index.push("- " + label + ": " + name);
    };

    const artifacts = Object.values(this.state.artifacts).sort(
      (a, b) => a.recordedAtSeq - b.recordedAtSeq,
    );
    for (const artifact of artifacts) {
      add(
        path.join("research-record", "write-ups", artifact.id + ".md"),
        path.join(this.paths.dir, artifact.path),
        artifact.id + " [" + artifact.kind + "; " + (artifact.conclusion ?? "no conclusion") + "]",
      );
    }

    index.push("", "## Submitted claims and proofs", "");
    for (const claim of Object.values(this.state.claims)) {
      if (claim.path) {
        add(
          path.join("research-record", "claims", claim.id + ".md"),
          path.join(this.paths.dir, claim.path),
          claim.id + " [" + claim.status + "; " + claim.relationToGoal + "]",
        );
      }
    }

    index.push("", "## Facts and their current standing", "");
    for (const fact of Object.values(this.state.facts)) {
      add(
        path.join("research-record", "facts", fact.id + ".md"),
        path.join(this.paths.dir, fact.path),
        fact.id + " [" + fact.status + "; from " + fact.claimId + "]",
      );
    }

    index.push("", "## Independent verification reports", "");
    for (const verification of Object.values(this.state.verifications)) {
      if (verification.artifactPath) {
        add(
          path.join("research-record", "verifications", verification.id + ".md"),
          path.join(this.paths.dir, verification.artifactPath),
          verification.id + " on " + verification.claimId + " [" +
          (verification.verdict ?? verification.status) + "; " +
          (verification.finding ?? "no finding") + "]",
        );
      }
    }

    index.push("", "## Structured assignment returns", "");
    for (const task of Object.values(this.state.tasks)) {
      const output = path.join(this.paths.tasksDir, task.id, "output.json");
      add(
        path.join("research-record", "assignment-returns", task.id + ".json"),
        output,
        task.id + " [" + task.role + "; " + task.status + "]",
      );
    }

    index.push("", "## Earlier mathematical views", "");
    for (const note of this.state.mathematicalViews) {
      const name = path.join("research-record", "mathematical-views", note.waveId + ".md");
      files[name] = note.markdown;
      index.push("- " + note.waveId + ": " + name);
    }

    return { files, index: index.join("\n") + "\n" };
  }

  private launchPublicationOperation(
    publicationId: string,
    operation: () => Promise<void>,
  ): void {
    const pending = operation().catch((error: unknown) => {
      if (this.stopped) return;
      const publication = this.state.publications.find((entry) => entry.id === publicationId);
      if (!publication || publication.status === "ready" || publication.status === "failed") return;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      const decision = this.state.decisions[publication.decisionId];
      if (decision?.status === "requested" || decision?.status === "proposed") {
        this.emitEvent({
          type: "decision.rejected",
          decisionId: decision.id,
          violations: [message],
        });
      }
      this.emitEvent({
        type: "publication.failed",
        publicationId,
        stage: publication.status === "compiling" ? "compilation" : "drafting",
        error: message,
      });
    });
    this.publicationPromise = pending;
    void pending.finally(() => {
      if (this.publicationPromise === pending) this.publicationPromise = null;
    });
  }

  private async draftPublication(publicationId: string, decisionId: string): Promise<void> {
    const publication = this.state.publications.find((entry) => entry.id === publicationId);
    if (!publication) throw new Error("unknown publication " + publicationId);
    const stoppingReportPath = path.join(this.paths.dir, publication.terminalFinalPath);
    if (!existsSync(stoppingReportPath)) {
      throw new Error("stopping report is missing: " + publication.terminalFinalPath);
    }
    const stoppingReport = readFileSync(stoppingReportPath, "utf8");
    const digest = existsSync(this.paths.digestFile)
      ? readFileSync(this.paths.digestFile, "utf8")
      : null;
    const record = this.publicationRecordFiles();
    const files = {
      ...publicationPacketFiles(this.state, stoppingReport, record.index, digest),
      ...record.files,
    };
    const internalIds = this.publicationInternalIds();
    const schema = PublicationOutput.superRefine((output, context) => {
      for (const message of validatePublicationManuscript(output, internalIds)) {
        context.addIssue({ code: "custom", message });
      }
    });
    const call = await this.runReaderCall(
      decisionId,
      files,
      PUBLICATION_PROMPT,
      schema,
      {
        memoryAccess: true,
        intakeSources: this.state.problem.sources,
        webSearch: this.state.config.allowWebSearch,
      },
    );
    if (this.stopped) return;

    this.emitEvent({
      type: "decision.proposed",
      decisionId,
      action: call.output,
      usage: call.usage,
    });
    if (!call.output) {
      const failure = call.error ?? "the publication pass did not return a manuscript";
      this.emitEvent({ type: "decision.rejected", decisionId, violations: [failure] });
      this.emitEvent({
        type: "publication.failed",
        publicationId,
        stage: /^invalid (?:Research Manager|mathematical reader) output:/.test(failure)
          ? "validation"
          : "drafting",
        error: failure.slice(0, 2_000),
      });
      return;
    }

    this.emitEvent({ type: "decision.accepted", decisionId, action: call.output });
    const publicationDir = path.join(this.paths.publicationsDir, publicationId);
    const texPath = path.join(publicationDir, "manuscript.tex");
    const logPath = path.join(publicationDir, "compile.log");
    writeFileAtomic(texPath, renderPublicationTex(call.output));
    this.emitEvent({
      type: "publication.drafted",
      publicationId,
      kind: call.output.kind,
      result: call.output.result,
      title: call.output.title,
      assessment: call.output.assessment,
      texPath: path.relative(this.paths.dir, texPath),
      logPath: path.relative(this.paths.dir, logPath),
    });
  }

  private async compilePublication(publicationId: string): Promise<void> {
    const publication = this.state.publications.find((entry) => entry.id === publicationId);
    if (!publication?.texPath || !publication.logPath) {
      throw new Error("publication " + publicationId + " has no accepted TeX source");
    }
    const publicationDir = path.join(this.paths.publicationsDir, publicationId);
    const texPath = path.join(this.paths.dir, publication.texPath);
    const logPath = path.join(this.paths.dir, publication.logPath);
    const killKey = "publication-compiler:" + publicationId;
    try {
      const result = await this.getPublicationCompiler().compile({
        texPath,
        outputDir: publicationDir,
        registerKill: (kill) => this.killHandles.set(killKey, () => kill()),
      });
      if (this.stopped) return;
      writeFileAtomic(logPath, result.log);
      const resolvedDir = path.resolve(publicationDir);
      const resolvedPdf = path.resolve(result.pdfPath);
      if (!resolvedPdf.startsWith(resolvedDir + path.sep)) {
        throw new Error("TeX compiler returned a PDF outside the publication directory");
      }
      this.emitEvent({
        type: "publication.completed",
        publicationId,
        pdfPath: path.relative(this.paths.dir, resolvedPdf),
        compiler: result.compiler,
      });
    } catch (error) {
      if (this.stopped) return;
      const compileLog =
        error !== null &&
          typeof error === "object" &&
          typeof (error as { compileLog?: unknown }).compileLog === "string"
          ? (error as { compileLog: string }).compileLog
          : "";
      writeFileAtomic(logPath, compileLog);
      const message = error instanceof Error ? error.message : String(error);
      const compilerTail = compileLog.trim().slice(-3_000);
      this.emitEvent({
        type: "publication.failed",
        publicationId,
        stage: "compilation",
        error: (
          message.slice(0, 1_000) +
          (compilerTail === "" ? "" : "\n\nCompiler output:\n" + compilerTail)
        ).slice(0, 4_500),
      });
    } finally {
      this.killHandles.delete(killKey);
    }
  }

  /** Start a mathematical publication reading whose durable result is TeX. */
  requestPublication(by = "human"): string {
    const terminal = this.state.terminal;
    const checkpoint = this.state.terminalHistory.at(-1);
    if (!terminal || !checkpoint) {
      throw new Error("a standalone paper can be prepared only from a stopping report");
    }
    let current = currentTerminalPublication(this.state);
    if (current && this.recoverSavedPublicationDraft(current)) {
      current = currentTerminalPublication(this.state);
    }
    if (
      current?.texPath !== null &&
      current?.texPath !== undefined &&
      existsSync(path.join(this.paths.dir, current.texPath))
    ) {
      return current.id;
    }
    if (current?.status === "drafting" || current?.status === "compiling") {
      throw new Error("a publication pass is already in progress");
    }
    if (this.remainingBudget() <= 0) {
      throw new Error(
        "no mathematical reader token allowance remains; increase the project token ceiling before preparing a paper",
      );
    }

    const publicationId = this.allocId("publication");
    const decisionId = this.allocId("decision");
    this.emitEvent({
      type: "decision.requested",
      decisionId,
      kind: "publication",
      waveId: null,
    });
    this.emitEvent({
      type: "publication.requested",
      publicationId,
      decisionId,
      terminalResult: terminal.result,
      terminalFinalPath: terminal.finalPath,
      terminalReachedAtSeq: checkpoint.reachedAtSeq,
      by,
    });
    this.launchPublicationOperation(publicationId, () =>
      this.draftPublication(publicationId, decisionId),
    );
    return publicationId;
  }

  /** Compile an already saved TeX manuscript without another model call. */
  requestPublicationCompilation(publicationId: string, by = "human"): string {
    const publication = this.state.publications.find((entry) => entry.id === publicationId);
    if (!publication) throw new Error("unknown publication " + publicationId);
    if (publication.status === "ready" && publication.pdfPath !== null) return publication.id;
    if (publication.status === "compiling") {
      throw new Error("PDF compilation is already in progress");
    }
    if (publication.status === "drafting") {
      throw new Error("the TeX manuscript is still being prepared");
    }
    if (publication.texPath === null || publication.logPath === null) {
      throw new Error("publication " + publicationId + " has no saved TeX manuscript");
    }

    this.emitEvent({
      type: "publication.compilationRequested",
      publicationId,
      by,
    });
    const texFile = path.join(this.paths.dir, publication.texPath);
    if (!existsSync(texFile)) {
      this.emitEvent({
        type: "publication.failed",
        publicationId,
        stage: "compilation",
        error: "The saved TeX file is missing: " + publication.texPath,
      });
      return publication.id;
    }
    const compiler = this.getPublicationCompiler().info();
    if (!compiler.ok) {
      const error =
        "Local TeX compiler unavailable (" +
        compiler.bin +
        "): " +
        (compiler.detail ?? "install Tectonic or set INVENTIO_TEX_BIN");
      writeFileAtomic(path.join(this.paths.dir, publication.logPath), error + "\n");
      this.emitEvent({
        type: "publication.failed",
        publicationId,
        stage: "compilation",
        error,
      });
      return publication.id;
    }
    this.launchPublicationOperation(publication.id, () =>
      this.compilePublication(publication.id),
    );
    return publication.id;
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
    const publication = currentTerminalPublication(this.state);
    if (publication?.status === "drafting" || publication?.status === "compiling") {
      throw new Error("wait for the active publication pass to finish before continuing research");
    }
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

      this.recordMathematicalView(
        nextContinuationRevisionId(this.state),
        humanRevisionMarkdown,
        this.state.mathematicalViews.at(-1)?.abstract ?? "",
        "human_edited",
        true,
        "The owner directly revised the current mathematical view when continuing research.",
        null,
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
      summaryReader: clean(
        parsed.models.summaryReader ?? this.state.config.models.summaryReader,
      ),
      solver: clean(parsed.models.solver),
      explorer: clean(parsed.models.explorer),
      verifier: clean(parsed.models.verifier ?? this.state.config.models.verifier),
      reviewer: clean(parsed.models.reviewer),
      synthesizer: clean(parsed.models.synthesizer),
    };
    const next: ProjectSettings = {
      models,
      autonomy: parsed.autonomy,
      allowWebSearch: parsed.allowWebSearch,
      totalTokens: parsed.totalTokens,
      workerTokenLimit:
        parsed.workerTokenLimit ?? this.state.config.budget.defaultTaskTokens,
      maxWaves: parsed.maxWaves,
      trajectory: parsed.trajectory ?? this.state.config.trajectory,
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
    const modelRoles = [
      "researchManager",
      "summaryReader",
      "solver",
      "explorer",
      "verifier",
      "reviewer",
      "synthesizer",
    ] as const;
    const modelsUnchanged = modelRoles.every((role) => {
      const before = current.models[role] ?? this.state.config.models[role];
      const after = models[role] ?? this.state.config.models[role];
      return before.model === after.model && before.effort === after.effort;
    });
    const currentTrajectory = current.trajectory ?? this.state.config.trajectory;
    const nextTrajectory = next.trajectory ?? this.state.config.trajectory;
    const trajectoryUnchanged =
      currentTrajectory.solversPerWave === nextTrajectory.solversPerWave &&
      currentTrajectory.explorersPerWave === nextTrajectory.explorersPerWave &&
      currentTrajectory.verifiersPerClaim === nextTrajectory.verifiersPerClaim &&
      currentTrajectory.passesRequired === nextTrajectory.passesRequired;
    if (
      modelsUnchanged &&
      current.autonomy === next.autonomy &&
      current.allowWebSearch === next.allowWebSearch &&
      current.totalTokens === next.totalTokens &&
      current.workerTokenLimit === next.workerTokenLimit &&
      current.maxWaves === next.maxWaves &&
      trajectoryUnchanged
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

  humanClaimStatus(
    claimId: string,
    to: "VERIFIED" | "FAILED" | "REFUTED",
    note: string,
  ): void {
    const claim = this.state.claims[claimId];
    if (!claim) throw new Error(`unknown claim ${claimId}`);
    this.emitEvent({ type: "claim.status", claimId, from: claim.status, to, justification: note, by: "human" });
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

  /** Project-scoped MCP callback for a sparse human-readable trajectory marker. */
  recordTrajectoryMilestone(
    taskId: string,
    title: string,
    markdown: string,
  ): { milestoneId: string } {

    const task = this.state.tasks[taskId];
    if (!task || task.status !== "running") throw new Error(`task ${taskId} is not running`);
    if (task.role !== "solver" && task.role !== "explorer") {
      throw new Error("only Solver and Explorer trajectories may record milestones");
    }
    if (task.milestoneIds.length >= 12) {
      throw new Error("this trajectory already has twelve milestones; reserve further detail for the final write-up");
    }
    const cleanTitle = title.trim();
    const cleanMarkdown = markdown.trim();
    if (!cleanTitle || !cleanMarkdown) throw new Error("milestone title and mathematics are required");
    const milestoneId = this.allocId("milestone");
    this.emitEvent({
      type: "task.milestone",
      milestoneId,
      taskId,
      title: cleanTitle.slice(0, 160),
      markdown: cleanMarkdown.slice(0, 4_000),
    });
    return { milestoneId };
  }

  /** Turn one concrete fact contradiction into a self-contained correction claim. */
  flagTrajectoryFact(
    taskId: string,
    factId: string,
    reason: string,
  ): { correctionClaimId: string } {

    const task = this.state.tasks[taskId];
    if (!task || task.status !== "running") throw new Error(`task ${taskId} is not running`);
    if (task.role !== "solver" && task.role !== "explorer") {
      throw new Error("only Solver and Explorer trajectories may flag a fact");
    }
    if (
      Object.values(this.state.claims).some(
        (claim) => claim.kind === "correction" && claim.sourceTaskId === taskId,
      )
    ) {
      throw new Error("this trajectory has already submitted its one fact correction");
    }
    const fact = this.state.facts[factId];
    if (!fact || (fact.status !== "ACTIVE" && fact.status !== "SUSPICIOUS")) {
      throw new Error(`active fact ${factId} does not exist`);
    }
    const cleanReason = reason.trim();
    if (cleanReason.length < 20 || cleanReason.length > 2_000) {
      throw new Error("a concrete 20–2000 character mathematical reason is required");
    }

    const correctionClaimId = this.allocId("claim");
    const title = `Correction to ${factId}`;
    const statement = `The following recorded statement is false or incomplete as stated:\n\n${fact.statement}`;
    const relPath = path.join("claims", `${correctionClaimId}.md`);
    const claimMarkdown = [
      `# ${title}`,
      "",
      "## Statement under challenge",
      "",
      fact.statement,
      "",
      "## Concrete contradiction or disproof",
      "",
      cleanReason,
      "",
    ].join("\n");
    writeFileAtomic(path.join(this.paths.dir, relPath), claimMarkdown);
    this.emitEvent({
      type: "claim.added",
      claimId: correctionClaimId,
      title,
      statement,
      proofMarkdown: cleanReason,
      status: "UNVERIFIED",
      provenance: `${taskId} correction of ${factId}`,
      sourceTaskId: taskId,
      sourceWaveId: task.waveId,
      path: relPath,
      relationToGoal: "RELATED",
      kind: "correction",
      targetFactId: factId,
      verificationPolicy: {
        verifiersPerClaim: this.state.config.trajectory.verifiersPerClaim,
        passesRequired: this.state.config.trajectory.passesRequired,
      },
      dependsOn: [],
    });
    this.emitEvent({
      type: "fact.suspicionRaised",
      factId,
      correctionClaimId,
      reason: cleanReason,
      by: taskId,
    });
    return { correctionClaimId };
  }

  /** Convenience for HTTP/tests: expose one task's execution surfaces. */
  taskDetail(taskId: string): {
    task: TaskState;
    outputPath: string;
    packetDir: string;
    archive: string;
    partialWorkMarkdown: string | null;
  } {
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`unknown task ${taskId}`);
    const dir = path.join(this.paths.tasksDir, taskId);
    const partialFile = path.join(dir, "salvage.md");
    return {
      task,
      outputPath: path.join(dir, "output.json"),
      packetDir: path.join(dir, "packet"),
      archive: path.join(dir, "codex-events.jsonl"),
      partialWorkMarkdown: existsSync(partialFile)
        ? readablePartialWork(readFileSync(partialFile, "utf8"))
        : null,
    };
  }
}
