import { RecurrentResearch } from "./recurrent.js";
import { applyResearchChange, resultStatus, resultMathematics, usageSpend, type ResearchChange } from "@inventio/schema";
import { ActiveModelSettings, IntakeOutput, ProjectSettings, PublicationOutput, applyEvent, currentTerminalPublication, initialState, makeId, nextContinuationRevisionId, pendingIntakeDecision, projectSettingsFromConfig, type Event, type IdKind, type IntakeMemory, type IntakeSource, type ModelChoice, type Phase, type ProjectConfig, type ProjectState, type PublicationState, type TaskState, type Usage } from "@inventio/schema";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { parseModelJson } from "../codex/modelJson.js";
import { type InterruptReason } from "../codex/runner.js";
import { runStructured } from "../codex/structured.js";
import { readProjectWorkflow } from "../legacy/archive.js";
import type { RecallRecord, TaskScope } from "../memory/types.js";
import { PUBLICATION_PROMPT, publicationPacketFiles } from "../prompts/publication.js";
import { RESEARCH_TOOL_DEFINITIONS } from "../prompts/tools.js";
import { INTAKE_PROMPT, intakeFiles } from "../prompts/intake.js";
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

export class ProjectEngine extends EventEmitter {
  readonly slug: string;
  readonly paths: ProjectPaths;
  readonly state: ProjectState;
  readonly recurrent: RecurrentResearch;
  private log: EventLog;
  private deps: EngineDeps;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private wakeWaiters: (() => void)[] = [];
  private killHandles = new Map<string, (reason: InterruptReason) => void>();
  private intakeRefreshInFlight = false;
  private interruptedIntakeChecked = false;
  private interruptedPublicationChecked = false;
  private publicationPromise: Promise<void> | null = null;

  private constructor(slug: string, deps: EngineDeps, log: EventLog, state: ProjectState) {
    super();
    this.slug = slug;
    this.deps = deps;
    this.paths = projectPaths(deps.root, slug);
    this.log = log;
    this.state = state;
    this.recurrent = new RecurrentResearch({
      state, paths: this.paths, deps,
      emit: change => this.emitResearch(change),
      stopped: () => this.stopped,
      blocked: () => this.blocked(), wait: () => this.wake(),
      registerKill: (id, kill) => { if (kill) this.killHandles.set(id, kill); else this.killHandles.delete(id); },
      question: (text, context) => {
        if (Object.values(this.state.questions).some(q => q.text === text && q.status === "open")) return;
        this.emitEvent({ type: "question.raised", id: this.allocId("question"), text, context, blocking: true, raisedBy: "conductor" });
      },
      terminal: (result, markdown) => {
        const finalPath = `research/final-${this.state.research.roundOrder.length}.md`;
        writeFileAtomic(path.join(this.paths.dir, finalPath), `RESULT: ${result}\n\n${markdown}`);
        this.phaseTo("TERMINAL", "recurrent research stopped");
        this.emitEvent({ type: "terminal.reached", result, finalPath });
      },
    });
  }

  static create(
    deps: EngineDeps,
    args: { slug: string; title: string; statement: string; contextMarkdown?: string; config: ProjectConfig },
  ): ProjectEngine {
    if (args.config.workflow !== "recurrent-v3") throw new Error("unsupported workflow; create a recurrent-v3 project");
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
    if (readProjectWorkflow(paths.eventsFile) !== "recurrent-v3") {
      throw new Error("legacy projects must be opened through the view-only archive");
    }
    const log = EventLog.open(paths.eventsFile);
    try {
      const state = initialState();
      for (const e of log.events) applyEvent(state, e);
      const engine = new ProjectEngine(slug, deps, log, state);
      return engine;
    } catch (error) {
      log.close();
      throw error;
    }
  }

  // ------------------------------------------------------------------ core

  private emitResearch(change: ResearchChange): void {
    // Validate a detached projection before appending. A rejected model target
    // must never poison the append-only log. Mathematical bodies are immutable,
    // so shallow collection copies are sufficient and avoid copying proofs.
    const source = this.state.research;
    const draft = {
      ...source,
      rounds: Object.fromEntries(Object.entries(source.rounds).map(([id, r]) => [id, { ...r, sessionIds: [...r.sessionIds] }])),
      roundOrder: [...source.roundOrder],
      sessions: Object.fromEntries(Object.entries(source.sessions).map(([id, s]) => [id, { ...s, turnIds: [...s.turnIds] }])),
      turns: Object.fromEntries(Object.entries(source.turns).map(([id, t]) => [id, { ...t }])),
      versions: { ...source.versions }, versionOrder: [...source.versionOrder], notes: { ...source.notes },
      responses: [...source.responses], assessments: [...source.assessments], final: source.final ? { ...source.final } : null,
    };
    applyResearchChange(draft, change);
    this.emitEvent({ type: "research.updated", change });
  }

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
    ]);
    await this.recurrent.settle();
    this.log.close();
  }

  private blocked(): boolean {
    return (
      this.state.paused ||
      Object.values(this.state.questions).some((q) => q.status === "open" && q.blocking)
    );
  }

  private openWaveId(): string | null {
    return this.state.research.roundOrder.find(id => this.state.research.rounds[id]!.status !== "closed") ?? null;
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
    await this.researchLoop();
  }

  // ------------------------------------------------------ recurrent research

  /**
   * Single-controller execution: code fixes the number of independent long
   * trajectories, while no model sits between the problem and those workers.
   */
  private async researchLoop(): Promise<void> {
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

      await this.recurrent.run();
    }
  }


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
    chargedTokens: number;
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
    const model = options.model ?? this.state.config.researchModels!.support;
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
          permissionProfile: { name: "inventio_reader", filesystem: { ":minimal": "read", [packetDir]: "read" } },
          maxEstimatedTokens: Math.max(1, Math.min(500_000, this.remainingBudget())),
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
                enabledTools: RESEARCH_TOOL_DEFINITIONS.filter(t => t.name !== "research_checkpoint" && t.name !== "audit_assess").map(t => t.name),
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
    const usage = result.runs.some(r => r.usage) ? result.usage : null;
    const chargedTokens = result.runs.reduce((n, r) => n + (r.usage ? usageSpend(r.usage) : Math.max(4000, r.estimatedTokens)), 0);
    const processLabel =
      "mathematical reader";
    if (result.status === "completed" && result.output !== null) {
      return {
        output: result.output,
        usage, chargedTokens,
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
      usage, chargedTokens,
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
      intakeFiles(this.state.statement, this.state.contextMarkdown),
      INTAKE_PROMPT,
      IntakeOutput,
      {
        model: this.state.config.researchModels!.support,
        isolatedTask: true,
        memoryAccess: true,
        intakeSources: indexedSources,
        webSearch: this.state.config.allowWebSearch,
      },
    );
    if (this.stopped) return { ok: false, error: "conductor stopping" };
    this.emitEvent({ type: "decision.proposed", decisionId, action: call.output, usage: call.usage, chargedTokens: call.chargedTokens });
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
      ...this.state.research.roundOrder,
      ...this.state.research.versionOrder,
      ...Object.keys(this.state.research.sessions),
      ...Object.keys(this.state.research.notes),
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
    return [...new Set(ids.filter((id) => /^(?:DEC\d+|[WTAECRKIMQDXSPFVBN]\d+)(?:\.v\d+)?$/.test(id)))];
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
    const index: string[] = [];
    for (const id of this.state.research.versionOrder) {
      const version = this.state.research.versions[id]!;
      const file = `record/${id}.md`;
      files[file] = `Current qualification: ${resultStatus(this.state.research, id)}\n\n${resultMathematics(version)}`;
      index.push(`- ${id}: ${version.title} → ${file}`);
    }
    for (const note of Object.values(this.state.research.notes)) {
      const file = `record/${note.id}.md`; files[file] = note.markdown;
      index.push(`- ${note.id}: ${note.name} → ${file}`);
    }
    return { files, index: index.join("\n") };
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
      if (output.result !== "UNCERTAIN" && output.result !== publication.terminalResult) context.addIssue({ code: "custom", message: "Exposition cannot elevate or reverse the fixed research outcome" });
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
        model: this.state.config.researchModels!.research,
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
      chargedTokens: call.chargedTokens,
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
      ...((parsed.researchModels ?? this.state.config.researchModels) ? { researchModels: { research: clean((parsed.researchModels ?? this.state.config.researchModels)!.research), support: clean((parsed.researchModels ?? this.state.config.researchModels)!.support) } } : {}),
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
    const roundsUsed = this.state.config.workflow === "recurrent-v3" ? this.state.research.roundOrder.length : this.state.waveOrder.length;
    if (next.maxWaves < roundsUsed) {
      throw new Error(
        `maximum research rounds cannot be below the ${roundsUsed} already used`,
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
      JSON.stringify(current.researchModels) === JSON.stringify(next.researchModels) &&
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

  hardInterruptTask(taskId: string): void {
    const kill = this.killHandles.get(taskId);
    if (!kill) throw new Error(`task ${taskId} is not running`);
    kill("killed");
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
