/**
 * Trajectory real-quota smoke (TRAJECTORY-DESIGN.md).
 *
 * Drives one deliberately tiny problem through the entire protocol against the
 * real `codex` CLI: intake → confirm → independent research trajectories →
 * independent claim verification → facts → final. Asserts a terminal state, a
 * well-formed stamped final report, and that the event log replays to the same
 * state it ended with.
 *
 * This spends the operator's Codex quota. Everything else in the test suite
 * runs against packages/codex-sim.
 *
 *   npm run smoke                    # default: elementary inequality
 *   SMOKE_MEMORY=1 npm run smoke     # also exercise the MCP memory service
 *   SMOKE_KEEP=1 npm run smoke       # keep the project directory
 */
import { applyEvent, defaultTrajectoryConfig, initialState, type Event } from "@inventio/schema";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectEngine } from "../src/engine/engine.js";
import { WorkerPool } from "../src/engine/pool.js";
import { FileMemoryBackend } from "../src/memory/cardStore.js";
import { MemoryService } from "../src/memory/service.js";
import { EventLog } from "../src/store/eventLog.js";

const STATEMENT =
  process.env["SMOKE_STATEMENT"] ??
  "Prove that for every real number x, x^2 + 1 >= 2x. State the equality case.";

const SLUG = process.env["SMOKE_SLUG"] ?? "smoke-inequality";
const TIMEOUT_MS = Number(process.env["SMOKE_TIMEOUT_MS"] ?? 45 * 60_000);
const USE_MEMORY = process.env["SMOKE_MEMORY"] === "1";
const KEEP = process.env["SMOKE_KEEP"] === "1";

function log(...parts: unknown[]): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...parts);
}

function fail(message: string): never {
  console.error(`\n✗ SMOKE FAILED: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const root = process.env["SMOKE_ROOT"] ?? mkdtempSync(path.join(os.tmpdir(), "inventio-smoke-"));
  log(`root: ${root}`);
  log(`statement: ${STATEMENT}`);

  const config = defaultTrajectoryConfig();
  // Small, real-money budget: enough for ~10 codex turns at this problem size.
  config.budget.totalTokens = Number(process.env["SMOKE_BUDGET"] ?? 3_000_000);
  config.budget.defaultTaskTokens = 400_000;
  config.budget.taskWallClockMinutes = 10;
  config.limits.maxWaves = 6;
  config.limits.maxConcurrentWorkers = 2;
  config.trajectory = { solversPerWave: 1, explorersPerWave: 1, verifiersPerClaim: 2, passesRequired: 2 };
  for (const role of ["summaryReader", "solver", "explorer", "verifier"] as const) {
    config.models[role].effort = "medium";
  }

  const pool = new WorkerPool(2);
  let memoryService: MemoryService | null = null;
  if (USE_MEMORY) {
    memoryService = new MemoryService({ port: Number(process.env["SMOKE_MEMORY_PORT"] ?? 4791) });
    await memoryService.start();
    log(`memory service: ${memoryService.url}`);
  }

  const engine = ProjectEngine.create(
    {
      root,
      codexBin: process.env["INVENTIO_CODEX_BIN"] ?? "codex",
      pool,
      memory:
        memoryService === null
          ? null
          : {
              url: memoryService.url,
              mintToken: (scope) => memoryService!.mintToken(scope),
              revokeToken: (token) => memoryService!.revokeToken(token),
            },
    },
    { slug: SLUG, title: "Smoke: elementary inequality", statement: STATEMENT, config },
  );
  if (memoryService) {
    memoryService.registerProject(
      SLUG,
      new FileMemoryBackend(engine.paths.dir, (rec) => engine.recordRecall(rec), {
        getState: () => engine.state,
        recordMilestone: (taskId, title, markdown) =>
          engine.recordTrajectoryMilestone(taskId, title, markdown),
        flagFact: (taskId, factId, reason) =>
          engine.flagTrajectoryFact(taskId, factId, reason),
      }),
    );
  }

  // Narrate the run so a human watching the terminal can see the protocol move.
  let confirmed = false;
  engine.on("event", (event: Event) => {
    switch (event.type) {
      case "phase.changed":
        log(`phase: ${event.from} → ${event.to} (${event.reason})`);
        break;
      case "intake.completed":
        log(`intake complete; ${event.ambiguities.length} ambiguity/ies noted`);
        break;
      case "wave.planned":
        log(
          `wave ${event.waveId} "${event.title}": ${event.roster
            .map((r) => `${r.taskId}=${r.role}/${r.methodTag}`)
            .join(", ")}`,
        );
        break;
      case "task.dispatched":
        log(`  ▶ ${event.taskId} dispatched (${event.role}, budget ${event.budgetTokens})`);
        break;
      case "task.completed":
        log(`  ✓ ${event.taskId} completed (${event.usage.input_tokens} in / ${event.usage.output_tokens} out)`);
        break;
      case "task.interrupted":
        log(`  ⏸ ${event.taskId} interrupted: ${event.reason}`);
        break;
      case "task.failed":
        log(`  ✗ ${event.taskId} failed: ${event.error.slice(0, 200)}`);
        break;
      case "task.outputInvalid":
        log(`  ! ${event.taskId} invalid output, repairing: ${event.errors.join("; ").slice(0, 200)}`);
        break;
      case "artifact.recorded":
        log(`  · artifact ${event.artifactId} (${event.kind}${event.conclusion ? `, ${event.conclusion}` : ""})`);
        break;
      case "decision.accepted": {
        const action = (event.action as { action?: string } | null)?.action;
        log(`decision ${event.decisionId} accepted${action ? `: ${action}` : ""}`);
        break;
      }
      case "decision.rejected":
        log(`decision ${event.decisionId} REJECTED: ${event.violations.join("; ").slice(0, 300)}`);
        break;
      case "verification.completed":
        log(`check ${event.verificationId}: ${event.verdict}`);
        break;
      case "fact.recorded":
        log(`fact ${event.factId} from ${event.claimId}`);
        break;
      case "terminal.reached":
        log(`TERMINAL: ${event.result}`);
        break;
      default:
        break;
    }

    // The intake gate is a human decision; the smoke stands in for the human
    // and accepts the normalized statement verbatim.
    if (event.type === "intake.completed" && !confirmed) {
      confirmed = true;
      setTimeout(() => {
        try {
          engine.confirmProblem(event.problemMarkdown);
          log("problem confirmed (smoke acting as the human gate)");
        } catch (err) {
          log(`confirm failed: ${String(err)}`);
        }
      }, 0);
    }
  });

  engine.start();

  const started = Date.now();
  const timedOut = await new Promise<boolean>((resolve) => {
    const timer = setInterval(() => {
      if (engine.state.terminal) {
        clearInterval(timer);
        resolve(false);
      } else if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(timer);
        resolve(true);
      }
    }, 1000);
  });

  await engine.stop();
  if (memoryService) await memoryService.stop();

  const state = engine.state;
  const spent = state.budget.spentTokens + state.budget.plannerSpentTokens;
  log(
    `finished in ${Math.round((Date.now() - started) / 1000)}s; spend ${spent.toLocaleString("en-US")} tokens ` +
      `(workers ${state.budget.spentTokens.toLocaleString("en-US")}, planner ${state.budget.plannerSpentTokens.toLocaleString("en-US")})`,
  );

  if (timedOut) fail(`no terminal state within ${Math.round(TIMEOUT_MS / 60000)} minutes`);

  // ---- assertions ---------------------------------------------------------
  const terminal = state.terminal;
  if (!terminal) fail("engine stopped without a terminal result");

  const finalPath = path.join(engine.paths.dir, terminal.finalPath);
  if (!existsSync(finalPath)) fail(`final report missing at ${finalPath}`);
  const finalText = readFileSync(finalPath, "utf8");
  const firstLine = finalText.split("\n")[0] ?? "";
  if (!/^RESULT: (PROVED|DISPROVED|UNCERTAIN)$/.test(firstLine)) {
    fail(`final report does not start with a stamped RESULT line: ${JSON.stringify(firstLine)}`);
  }
  if (!firstLine.endsWith(terminal.result)) {
    fail(`stamped result ${firstLine} disagrees with terminal.result ${terminal.result}`);
  }

  // Every recorded artifact must exist on disk.
  for (const artifact of Object.values(state.artifacts)) {
    if (!existsSync(path.join(engine.paths.dir, artifact.path))) {
      fail(`artifact ${artifact.id} recorded but missing at ${artifact.path}`);
    }
  }

  // The event log must replay to exactly the state the engine ended with.
  const log2 = EventLog.open(engine.paths.eventsFile);
  const replayed = initialState();
  for (const event of log2.events) applyEvent(replayed, event);
  log2.close();
  if (JSON.stringify(replayed) !== JSON.stringify(state)) {
    fail("event log replay does not reproduce the engine's final state");
  }

  // Protocol sanity: whatever the outcome, the run must have done real work.
  const completedTasks = Object.values(state.tasks).filter((t) => t.status === "completed").length;
  if (completedTasks === 0) fail("no task completed — the run did no mathematical work");

  const accepted = terminal.result === "PROVED" || terminal.result === "DISPROVED";
  if (accepted) {
    const relation = terminal.result === "PROVED" ? "PROVES" : "DISPROVES";
    const fact = Object.values(state.facts).find(f => f.status === "ACTIVE" && state.claims[f.claimId]?.relationToGoal === relation);
    if (!fact) fail(`terminal ${terminal.result} without a decisive active fact`);
    const claim = state.claims[fact.claimId]!;
    const passes = claim.verificationIds.filter(id => state.verifications[id]?.verdict === "PASS").length;
    if (passes < (claim.verificationPolicy?.passesRequired ?? config.trajectory.passesRequired)) fail("decisive fact lacks its required checks");
  }

  console.log(`\n✓ SMOKE PASSED — RESULT: ${terminal.result}`);
  console.log(`  waves ${state.waveOrder.length}, tasks completed ${completedTasks}, ` +
    `claims ${state.claimOrder.length}, facts ${state.factOrder.length}`);
  console.log(`  final report: ${finalPath}`);
  console.log(`\n--- final.md (first 40 lines) ---`);
  console.log(finalText.split("\n").slice(0, 40).join("\n"));

  if (!KEEP && process.env["SMOKE_ROOT"] === undefined) {
    rmSync(root, { recursive: true, force: true });
  } else {
    console.log(`\n(project kept at ${engine.paths.dir})`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  fail(String(err));
});
