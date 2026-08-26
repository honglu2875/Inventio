import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEvent,
  defaultConfig,
  initialState,
  type ActionEnvelope,
  type ContinuationRevisionOutput,
  type CurationOutput,
  type Event,
  type FinalOutput,
  type IntakeOutput,
  type Memo,
  type PlannedTask,
  type ProjectConfig,
  type ProjectState,
  type ReviewerOutput,
  type WorkerOutput,
} from "@inventio/schema";
import {
  ProjectEngine,
  type EngineDeps,
  type MemoryAccess,
} from "../../src/engine/engine.js";
import { WorkerPool } from "../../src/engine/pool.js";
import { EventLog } from "../../src/store/eventLog.js";
import { projectPaths, type ProjectPaths } from "../../src/store/projectStore.js";

/**
 * Test harness for driving a real ProjectEngine against the codex-sim fake CLI.
 *
 * The sim is selected by absolute path (`codexBin`) and configured through the
 * *process* environment, because `runCodex` spawns with `process.env` inherited
 * and the engine exposes no `extraEnv` hook. Tests inside one file run
 * sequentially in vitest, so a per-test `process.env` mutation is safe.
 */

export const SIM_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../codex-sim/bin/codex-sim.mjs",
);

/** Prompt discriminators — must match packages/conductor/src/prompts/researchManager.ts. */
export const INTAKE_MATCH = "Read the complete raw intake materials";
export const CONTINUATION_REVISION_MATCH = "Revise your current mathematical view";
export const DECISION_MATCH = "choose one proportionate next step";
export const CURATION_MATCH = "Assess the completed research round";
export const FINAL_MATCH = "Compose the final report";
export const WORKER_MATCH = "Work on the question in research-question.md";

export const USAGE = {
  input_tokens: 1000,
  cached_input_tokens: 200,
  output_tokens: 300,
  reasoning_output_tokens: 50,
};

// ---------------------------------------------------------------------------
// Scenario construction
// ---------------------------------------------------------------------------

export interface SimCall {
  match?: { promptContains?: string; cwdContains?: string; resumeOf?: string };
  threadId?: string;
  behavior?: "ok" | "malformed-output" | "crash-mid-stream" | "hang" | "exit-nonzero";
  stubbornSigint?: boolean;
  exitCode?: number;
  delayMs?: number;
  items?: Record<string, unknown>[];
  finalMessage?: unknown;
  usage?: Record<string, number>;
}

let threadCounter = 0;
function nextThread(tag: string): string {
  threadCounter += 1;
  return `th-${tag}-${threadCounter}`;
}

/** A planner-mode call (intake / next-move / curation / final). */
export function plannerCall(
  promptContains: string,
  finalMessage: unknown,
  extra: SimCall = {},
): SimCall {
  return {
    match: { promptContains },
    threadId: nextThread("plan"),
    finalMessage,
    usage: USAGE,
    ...extra,
  };
}

/** A worker call, discriminated by the task id appearing in the packet cwd. */
export function workerCall(taskId: string, finalMessage: unknown, extra: SimCall = {}): SimCall {
  return {
    match: { promptContains: WORKER_MATCH, cwdContains: `/${taskId}/` },
    threadId: nextThread(taskId.toLowerCase()),
    finalMessage,
    usage: USAGE,
    ...extra,
  };
}

const EMPTY_ENVELOPE = {
  plan_wave: null,
  cross_examine: null,
  freeze_candidate: null,
  assess_results: null,
  record_dispositions: null,
  abandon_lineage: null,
  raise_question: null,
  terminate: null,
} as const;

export function envelope<K extends ActionEnvelope["action"]>(
  action: K,
  payload: NonNullable<ActionEnvelope[K]>,
): ActionEnvelope {
  return { ...EMPTY_ENVELOPE, action, [action]: payload } as unknown as ActionEnvelope;
}

export function plannedTask(o: {
  role: PlannedTask["role"];
  methodTag: string;
  brief: string;
  tokenBudget: number;
  direction?: string;
  computation?: boolean;
  webSearch?: boolean;
  reviewOf?: string | null;
  artifactIds?: string[];
  cardIds?: string[];
  sourceMounts?: string[];
}): PlannedTask {
  return {
    role: o.role,
    methodTag: o.methodTag,
    direction: o.direction ?? `direction:${o.methodTag}`,
    briefMarkdown: o.brief,
    tokenBudget: o.tokenBudget,
    computation: o.computation ?? false,
    webSearch: o.webSearch ?? false,
    reviewOf: o.reviewOf ?? null,
    grants: {
      artifactIds: o.artifactIds ?? [],
      cardIds: o.cardIds ?? [],
      sourceMounts: o.sourceMounts ?? [],
    },
  };
}

export function planWave(o: {
  title: string;
  reserveTokens: number;
  tasks: PlannedTask[];
  rationale?: string;
}): ActionEnvelope {
  return envelope("plan_wave", {
    title: o.title,
    rationale: o.rationale ?? `rationale for ${o.title}`,
    reserveTokens: o.reserveTokens,
    tasks: o.tasks,
  });
}

export function freezeCandidate(o: {
  fromArtifactId: string;
  lineageId?: string | null;
  newLineageTitle?: string | null;
  obligations?: string[];
  reviewQuestions?: string[];
  usedClaimIds?: string[];
  scopeMarkdown?: string | null;
}): ActionEnvelope {
  return envelope("freeze_candidate", {
    lineageId: o.lineageId ?? null,
    newLineageTitle: o.newLineageTitle ?? null,
    fromArtifactId: o.fromArtifactId,
    obligations: o.obligations ?? [],
    reviewQuestions: o.reviewQuestions ?? [],
    usedClaimIds: o.usedClaimIds ?? [],
    scopeMarkdown: o.scopeMarkdown ?? null,
    rationale: `freeze ${o.fromArtifactId}`,
  });
}

export function assessResults(
  items: NonNullable<ActionEnvelope["assess_results"]>["items"],
): ActionEnvelope {
  return envelope("assess_results", { items });
}

export function terminate(rationale = "the frontier is exhausted"): ActionEnvelope {
  return envelope("terminate", { rationale });
}

// ---------------------------------------------------------------------------
// Planner / worker payload builders (schema-exact)
// ---------------------------------------------------------------------------

export function intakeOutput(problemMarkdown = "# Problem\n\nShow that the widget is round."): IntakeOutput {
  return {
    problemMarkdown,
    contextDigestMarkdown: "",
    rawMemories: [],
    managerAbstract: "The objective is to show that the widget is round.",
    managerNoteMarkdown: "# Current mathematical view\n\nThe stated objective is to prove that the widget is round.",
    sourceSummaries: [],
    ambiguities: [],
    clarifications: [],
    notes: "",
  };
}

export function continuationRevisionOutput(
  over: Partial<ContinuationRevisionOutput> = {},
): ContinuationRevisionOutput {
  return {
    managerAbstract:
      "The renewed project broadens the earlier local approach while retaining its established conclusions.",
    managerNoteMarkdown:
      "## Current mathematical view\n\nThe earlier local reduction remains useful, but it is no longer the sole direction. The owner's continuation asks that genuinely different approaches remain active in the coming rounds.",
    ...over,
  };
}

export function curationOutput(
  over: Partial<CurationOutput> = {},
  taskIds: string[] = ["T001"],
): CurationOutput {
  return {
    managerNoteMarkdown:
      "The first round found a concrete reduction. The remaining question is whether the local lemma closes.",
    resolutionMarkdown: "# Resolution\n\nThe wave produced a candidate argument.",
    digestMarkdown: "# Digest\n\nThe project has one attempt on record.",
    taskDispositions: taskIds.map((taskId) => ({
      taskId,
      disposition: "carry_forward" as const,
      reason: "The note contains concrete mathematical work worth carrying into the next decision.",
      unblock: null,
    })),
    cardDecisions: [],
    libraryAdditions: [],
    libraryRetirements: [],
    claimExtractions: [],
    claimUpdates: [],
    capsules: { solver: "solver capsule", explorer: "explorer capsule", reviewer: "reviewer capsule" },
    ...over,
  };
}

export function finalOutput(finalMarkdown: string): FinalOutput {
  return { finalMarkdown };
}

export function memo(over: Partial<Memo> = {}): Memo {
  return {
    summary: "worked the assigned direction to a conclusion",
    newClaims: [],
    issues: [],
    obligations: [],
    deadEnds: [],
    proposedCards: [],
    computations: [],
    budgetReport: "used about half of the assigned budget",
    ...over,
  };
}

export function solverOutput(
  conclusion: WorkerOutput["conclusion"],
  artifactMarkdown: string,
  m: Memo = memo(),
): WorkerOutput {
  return { conclusion, artifactMarkdown: substantialTestArtifact(artifactMarkdown), memo: m, recallLog: [] };
}

export function reviewerOutput(
  verdict: ReviewerOutput["verdict"],
  artifactMarkdown: string,
  m: Memo = memo(),
): ReviewerOutput {
  return { verdict, artifactMarkdown: substantialTestArtifact(artifactMarkdown), memo: m, recallLog: [] };
}

function substantialTestArtifact(markdown: string): string {
  if (markdown.trim().length >= 240) return markdown;
  return (
    markdown +
    "\n\n## Supporting detail\n\n" +
    "This simulated artifact checks the stated hypotheses, records the logical route, and names what remains to be verified. ".repeat(3)
  );
}

export function testConfig(over: (c: ProjectConfig) => void = () => undefined): ProjectConfig {
  const c = defaultConfig();
  c.budget.totalTokens = 10_000_000;
  c.limits.maxConcurrentWorkers = 1;
  over(c);
  return c;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface SimLogRow {
  ts: string;
  index: number;
  argv: string[];
  cwd: string;
  prompt: string;
  resumeOf: string | null;
  taskToken: string | null;
}

const DEFAULT_TIMEOUT = 20_000;

export class Harness {
  readonly root: string;
  readonly slug = "e2e-project";
  readonly scenarioFile: string;
  readonly stateDir: string;
  readonly paths: ProjectPaths;
  readonly events: Event[] = [];
  engine: ProjectEngine;
  private pool = new WorkerPool(1);
  private stopped = false;
  private readonly memory: MemoryAccess | null;

  private constructor(
    root: string,
    scenarioFile: string,
    stateDir: string,
    config: ProjectConfig,
    memory: MemoryAccess | null,
  ) {
    this.root = root;
    this.scenarioFile = scenarioFile;
    this.stateDir = stateDir;
    this.memory = memory;
    this.paths = projectPaths(root, this.slug);
    this.engine = ProjectEngine.create(this.deps(), {
      slug: this.slug,
      title: "End-to-end project",
      statement: "Show that the widget is round.",
      config,
    });
    this.attach();
  }

  static create(
    name: string,
    calls: SimCall[],
    config: ProjectConfig = testConfig(),
    memory: MemoryAccess | null = null,
  ): Harness {
    const root = mkdtempSync(path.join(os.tmpdir(), `collq-eng-${name}-`));
    const scenarioFile = path.join(root, "scenario.json");
    writeFileSync(scenarioFile, JSON.stringify({ calls }, null, 2));
    const stateDir = path.join(root, "sim-state");
    process.env["INVENTIO_SIM_SCENARIO"] = scenarioFile;
    process.env["INVENTIO_SIM_STATE_DIR"] = stateDir;
    return new Harness(root, scenarioFile, stateDir, config, memory);
  }

  private deps(): EngineDeps {
    return {
      root: this.root,
      codexBin: SIM_BIN,
      pool: this.pool,
      memory: this.memory,
      taskWallClockMsOverride: 15_000,
      plannerWallClockMsOverride: 15_000,
      killGraceMs: 200,
      progressThrottleMs: 0,
    };
  }

  private attach(): void {
    this.engine.setMaxListeners(0);
    this.engine.on("event", (e: Event) => this.events.push(e));
  }

  get state(): ProjectState {
    return this.engine.state;
  }

  start(): void {
    this.engine.start();
  }

  /** Stop the current engine and boot a fresh one from the on-disk log. */
  async reload(): Promise<void> {
    if (!this.stopped) await this.stop();
    this.stopped = false;
    this.pool = new WorkerPool(1);
    this.engine = ProjectEngine.load(this.deps(), this.slug);
    this.attach();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.engine.stop();
  }

  confirm(markdown = "# Confirmed problem\n\nShow that the widget is round."): void {
    this.engine.confirmProblem(markdown);
  }

  /** Resolve when `pred(state)` holds; rejects with recent event types on timeout. */
  waitFor(pred: (s: ProjectState) => boolean, label: string, timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    const engine = this.engine;
    if (pred(engine.state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        engine.off("event", onEvent);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error(this.diagnostic(label))), timeoutMs);
      const onEvent = () => {
        if (pred(engine.state)) done();
      };
      engine.on("event", onEvent);
    });
  }

  /** Resolve on the first event matching `pred` (only events after this call). */
  waitForEvent(pred: (e: Event) => boolean, label: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Event> {
    const engine = this.engine;
    return new Promise((resolve, reject) => {
      const done = (err: Error | null, ev?: Event) => {
        clearTimeout(timer);
        engine.off("event", onEvent);
        if (err) reject(err);
        else resolve(ev!);
      };
      const timer = setTimeout(() => done(new Error(this.diagnostic(label))), timeoutMs);
      const onEvent = (e: Event) => {
        if (pred(e)) done(null, e);
      };
      engine.on("event", onEvent);
    });
  }

  waitForTerminal(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    return this.waitFor((s) => s.terminal !== null, "terminal state", timeoutMs);
  }

  private diagnostic(label: string): string {
    const recent = this.events.slice(-30).map((e) => e.type).join(", ");
    const s = this.engine.state;
    return (
      `timed out waiting for ${label}\n` +
      `  phase=${s.phase} paused=${s.paused} terminal=${JSON.stringify(s.terminal)}\n` +
      `  waves=${JSON.stringify(s.waveOrder)} tasks=${Object.values(s.tasks).map((t) => `${t.id}:${t.status}`).join(",")}\n` +
      `  questions=${Object.values(s.questions).map((q) => `${q.id}:${q.status}:${q.blocking}`).join(",")}\n` +
      `  recent events: ${recent}\n` +
      `  sim calls: ${JSON.stringify(this.simLog().map((r) => r.index))}`
    );
  }

  /** Replay the on-disk event log into a fresh state (DESIGN §5 fold). */
  diskState(): ProjectState {
    const log = EventLog.open(this.paths.eventsFile);
    try {
      const s = initialState();
      for (const e of log.events) applyEvent(s, e);
      return s;
    } finally {
      log.close();
    }
  }

  diskEvents(): Event[] {
    const log = EventLog.open(this.paths.eventsFile);
    try {
      return [...log.events];
    } finally {
      log.close();
    }
  }

  simLog(): SimLogRow[] {
    const f = path.join(this.stateDir, "calls.log.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SimLogRow);
  }

  read(rel: string): string {
    return readFileSync(path.join(this.paths.dir, rel), "utf8");
  }

  exists(rel: string): boolean {
    return existsSync(path.join(this.paths.dir, rel));
  }

  readDecisionPacket(decisionId: string, file: string): string {
    return readFileSync(path.join(this.paths.decisionsDir, decisionId, "packet", file), "utf8");
  }

  /**
   * Simulate a hard `kill -9` of the conductor: drop every log line from the
   * first event matching `pred` onwards, so the log ends exactly where the
   * process would have died.
   */
  truncateLogFrom(pred: (e: Event) => boolean): void {
    const events = this.diskEvents();
    const cut = events.findIndex(pred);
    if (cut < 0) throw new Error("truncateLogFrom: no event matched");
    const lines = readFileSync(this.paths.eventsFile, "utf8").split("\n").filter((l) => l.trim());
    writeFileSync(this.paths.eventsFile, lines.slice(0, cut).map((l) => `${l}\n`).join(""));
  }

  eventsOfType<T extends Event["type"]>(type: T): Extract<Event, { type: T }>[] {
    return this.events.filter((e): e is Extract<Event, { type: T }> => e.type === type);
  }
}
