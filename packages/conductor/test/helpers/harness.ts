import {
  applyEvent,
  defaultRecurrentConfig,
  initialState,
  type ClaimComparisonOutput,
  type Event,
  type FinalOutput,
  type IntakeOutput,
  type ProjectConfig,
  type ProjectState,
  type PublicationOutput,
  type SummaryRevisionOutput,
  type TrajectoryOutput,
  type VerificationOutput,
} from "@inventio/schema";
import { RESEARCH_PROMPT, EDITOR_PROMPT, FINAL_PROMPT } from "../../src/prompts/recurrent.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProjectEngine,
  type EngineDeps,
  type MemoryAccess,
} from "../../src/engine/engine.js";
import { WorkerPool } from "../../src/engine/pool.js";
import type {
  PublicationCompiler,
  TexCompileRequest,
  TexCompileResult,
} from "../../src/publication/tex.js";
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

/** Prompt discriminators — must match the active modules under src/prompts/. */
export const INTAKE_MATCH = "Read the complete raw intake materials";
export const PUBLICATION_MATCH = "Reassess the concluded mathematics";
export const TRAJECTORY_WORKER_MATCH = "Work on the original problem in problem.md";
export const VERIFICATION_MATCH = "Independently check claim.md";
export const CLAIM_COMPARISON_MATCH = "Compare only the mathematical statements";
export const SUMMARY_REVIEW_MATCH = "Consider whether the completed round materially changes";
export const TRAJECTORY_FINAL_MATCH = "Compose the self-contained final mathematical report";

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

/** A mathematical reader call (intake / comparison / summary / final / publication). */
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

// ---------------------------------------------------------------------------
// Reader / trajectory payload builders (schema-exact)
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

export function finalOutput(finalMarkdown: string): FinalOutput {
  return { finalMarkdown };
}

export function publicationOutput(
  over: Partial<PublicationOutput> = {},
): PublicationOutput {
  return {
    kind: "research_report",
    result: "UNCERTAIN",
    title: "A Research Report on Round Widgets",
    abstractTex:
      "We record a rigorous partial analysis of the roundness problem and isolate the remaining gap.",
    bodyTex:
      "\\section{Statement and setting}\nThe problem concerns round widgets.\n\n" +
      "\\section{Established results}\n\\begin{proposition}The planar reduction is valid.\\end{proposition}\n" +
      "\\begin{proof}This follows from the reduction proved below.\\end{proof}\n\n" +
      "\\section{Remaining question}\nThe final implication has not been established.",
    assessment: "The final implication remains open after an independent reading.",
    ...over,
  } as PublicationOutput;
}

export function trajectoryOutput(
  over: Partial<TrajectoryOutput> = {},
): TrajectoryOutput {
  return {
    conclusion: "UNCERTAIN",
    summaryMarkdown: "The trajectory established one useful reduction.",
    writeupMarkdown:
      "# Independent investigation\n\nA complete mathematical argument is recorded here.",
    claims: [],
    ...over,
  };
}

export function verificationOutput(
  verdict: VerificationOutput["verdict"],
  summaryMarkdown = "The supplied statement and proof are correct.",
  finding: VerificationOutput["finding"] = verdict === "PASS" ? "NONE" : "PROOF_GAP",
): VerificationOutput {
  return {
    verdict,
    finding,
    evidence: { basis: "derivation", supportingCommands: [] },
    summaryMarkdown,
    reportMarkdown: `# Independent verification\n\nVERDICT: ${verdict}\n\n${summaryMarkdown}`,
  };
}

export function summaryRevisionOutput(
  over: Partial<SummaryRevisionOutput> = {},
): SummaryRevisionOutput {
  return {
    changed: false,
    abstract: "The objective is to show that the widget is round.",
    markdown: "# Current mathematical view\n\nThe stated objective is to prove that the widget is round.",
    reason: "The round does not yet require an editorial change.",
    ...over,
  };
}

export function claimComparisonOutput(
  equivalentClaimGroups: string[][] = [],
): ClaimComparisonOutput {
  return { equivalentClaimGroups, conflicts: [] };
}

export function recurrentTestConfig(
  over: (c: ProjectConfig) => void = () => undefined,
): ProjectConfig {
  const c = defaultRecurrentConfig();
  c.budget.totalTokens = 10_000_000;
  c.budget.defaultTaskTokens = 500_000;
  c.limits.maxWaves = 1;
  c.limits.maxConcurrentWorkers = 1;

  over(c);
  return c;
}

/** One empty research round followed by exposition, for shared lifecycle tests. */
export function researchStopCalls(reportMarkdown: string): SimCall[] {
  const output = { writeupMarkdown: "No decisive theorem was established.", results: [], responses: [], questions: [] };
  return [plannerCall(RESEARCH_PROMPT, output), plannerCall(RESEARCH_PROMPT, output),
    plannerCall(EDITOR_PROMPT, { summaryMarkdown: "No decisive result.", briefMarkdown: "The original question remains open.", referencedVersions: [] }),
    plannerCall(FINAL_PROMPT, { reportMarkdown, referencedVersions: [] })];
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

/** Deterministic local compiler used by engine tests; no system TeX install is required. */
export class FakePublicationCompiler implements PublicationCompiler {
  available = true;
  failuresRemaining = 0;
  compileCalls = 0;

  info() {
    return this.available
      ? { bin: "fake-tectonic", ok: true, version: "fake-tectonic 1.0", detail: null }
      : { bin: "fake-tectonic", ok: false, version: null, detail: "compiler not installed" };
  }

  async compile(request: TexCompileRequest): Promise<TexCompileResult> {
    this.compileCalls += 1;
    request.registerKill?.(() => undefined);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw Object.assign(new Error("simulated TeX compilation failure"), {
        compileLog: "fake-tectonic: manuscript did not compile",
      });
    }
    mkdirSync(request.outputDir, { recursive: true });
    const pdfPath = path.join(request.outputDir, "manuscript.pdf");
    writeFileSync(pdfPath, "%PDF-1.4\n% deterministic test document\n");
    return {
      compiler: "fake-tectonic 1.0",
      pdfPath,
      log: "fake-tectonic: compilation succeeded",
    };
  }
}

export class Harness {
  readonly root: string;
  readonly slug = "e2e-project";
  readonly scenarioFile: string;
  readonly stateDir: string;
  readonly paths: ProjectPaths;
  readonly events: Event[] = [];
  engine: ProjectEngine;
  readonly publicationCompiler = new FakePublicationCompiler();
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
    config: ProjectConfig = recurrentTestConfig(),
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
      publicationCompiler: this.publicationCompiler,
    };
  }

  private attach(): void {
    this.engine.setMaxListeners(0);
    this.engine.on("event", (e: Event) => this.events.push(e));
  }

  get state(): ProjectState {
    return this.engine.state;
  }

  setConcurrency(n: number): void { this.pool.setMax(n); }

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
    const s = initialState();
    for (const event of EventLog.read(this.paths.eventsFile)) applyEvent(s, event);
    return s;
  }

  diskEvents(): Event[] {
    return EventLog.read(this.paths.eventsFile);
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
