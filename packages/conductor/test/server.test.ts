import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { connect, type AddressInfo } from "node:net";
import { WorkerPool } from "../src/engine/pool.js";
import { MemoryService } from "../src/memory/service.js";
import { buildApp, taskMemoFromOutput } from "../src/server/http.js";
import { EngineManager, mergeConfig, slugify } from "../src/server/manager.js";
import { tailJsonl } from "../src/server/sse.js";

/**
 * HTTP/SSE control-server tests (DESIGN §12), driven against real engines on
 * codex-sim. Routes that do not need a running protocol loop simply park the
 * project at the intake confirmation gate.
 */

const SIM_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../codex-sim/bin/codex-sim.mjs",
);

const INTAKE_OUTPUT = { problemMarkdown: "# Normalized\n\nProve X.", ambiguities: [], clarifications: [], notes: "" };

const TASK_MEMO = {
  summary: "A concise mathematical summary.",
  newClaims: [],
  issues: [],
  obligations: [],
  deadEnds: [],
  proposedCards: [],
  computations: [],
  budgetReport: "Within budget.",
};

interface Harness {
  manager: EngineManager;
  app: FastifyInstance;
  root: string;
}

const open: Harness[] = [];

/** Scenario: `n` intake calls, so `n` projects can pass intake in one test. */
function harness(intakeCalls = 4): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collq-server-"));
  const scenario = path.join(dir, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      calls: Array.from({ length: intakeCalls }, () => ({
        match: { promptContains: "Read the complete raw intake materials" },
        finalMessage: INTAKE_OUTPUT,
        usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 },
      })),
    }),
  );
  process.env["INVENTIO_SIM_SCENARIO"] = scenario;
  process.env["INVENTIO_SIM_STATE_DIR"] = path.join(dir, "state");

  const root = path.join(dir, "projects");
  const manager = new EngineManager({
    root,
    codexBin: SIM_BIN,
    pool: new WorkerPool(2),
    memoryService: null,
    engineOverrides: { plannerWallClockMsOverride: 5000, killGraceMs: 200 },
  });
  const app = buildApp(manager, { uiDir: null, heartbeatMs: 500, tailPollMs: 50 });
  const h: Harness = { manager, app, root };
  open.push(h);
  return h;
}

afterEach(async () => {
  for (const h of open.splice(0)) {
    await h.app.close();
    await h.manager.shutdown();
  }
});

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function createProject(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({ method: "POST", url: "/api/projects", payload: body });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

/** Park a project at the confirmation gate with the loop idle. */
async function parked(h: Harness, title: string, slug?: string): Promise<string> {
  const { status, json } = await createProject(h.app, {
    title,
    statement: "Prove that every X is a Y.",
    ...(slug ? { slug } : {}),
  });
  expect(status).toBe(201);
  const created = json["slug"] as string;
  const engine = h.manager.get(created)!;
  await waitFor(() => engine.state.phase === "AWAITING_CONFIRMATION");
  await h.app.inject({ method: "POST", url: `/api/projects/${created}/pause` });
  return created;
}

// ---------------------------------------------------------------------------

describe("memory wiring", () => {
  it("registers a per-project backend and unregisters on shutdown", async () => {
    const memory = new MemoryService({ host: "127.0.0.1", port: 0 });
    await memory.start();
    const h = harness();
    const withMemory = new EngineManager({
      root: path.join(h.root, "..", "memprojects"),
      codexBin: SIM_BIN,
      pool: new WorkerPool(1),
      memoryService: memory,
    });
    try {
      expect(memory.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const engine = withMemory.createProject({
        title: "Memory wiring",
        statement: "Prove that memory is reachable.",
      });
      await waitFor(() => engine.state.phase === "AWAITING_CONFIRMATION");
      // recalls recorded through the backend land in the project's event log
      engine.recordRecall({
        taskId: "T001",
        op: "search",
        args: '{"query":"x"}',
        returnedIds: ["M001"],
        refusedIds: [],
      });
      expect(engine.events.at(-1)).toMatchObject({ type: "memory.recall", taskId: "T001" });
    } finally {
      await withMemory.shutdown();
      await memory.stop();
    }
  }, 20_000);
});

describe("diagnostics", () => {
  it("health and runtime respond", async () => {
    const h = harness();
    const health = await h.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, version: "0.1.0", root: h.root, codexBin: SIM_BIN });

    const runtime = await h.app.inject({ method: "GET", url: "/api/runtime" });
    expect(runtime.statusCode).toBe(200);
    const body = runtime.json() as {
      codex: { bin: string; version: string | null; ok: boolean };
      pool: { active: number; queued: number };
      projects: number;
    };
    expect(body.codex.bin).toBe(SIM_BIN);
    expect(typeof body.codex.ok).toBe("boolean");
    expect(body.pool).toEqual({ active: 0, queued: 0 });
    expect(body.projects).toBe(0);
  });

  it("serves a UI build with an SPA fallback when one exists", async () => {
    const uiDir = mkdtempSync(path.join(os.tmpdir(), "collq-ui-"));
    mkdirSync(path.join(uiDir, "assets"), { recursive: true });
    writeFileSync(path.join(uiDir, "index.html"), "<div id=root></div>");
    writeFileSync(path.join(uiDir, "assets", "app.js"), "export const x = 1;\n");
    const app = buildApp(
      new EngineManager({
        root: mkdtempSync(path.join(os.tmpdir(), "collq-uiroot-")),
        codexBin: SIM_BIN,
        pool: new WorkerPool(1),
        memoryService: null,
      }),
      { uiDir },
    );

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("id=root");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");

    const deepLink = await app.inject({ method: "GET", url: "/p/some-slug/ops" });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.body).toContain("id=root"); // SPA fallback, not a 404

    const escape = await app.inject({ method: "GET", url: "/..%2F..%2Fetc%2Fpasswd" });
    expect(escape.body).toContain("id=root"); // confined: falls back, never leaks

    const api = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: "not_found" });
    await app.close();
  });

  it("serves a JSON 404 when no UI build exists", async () => {
    const h = buildApp(
      new EngineManager({
        root: mkdtempSync(path.join(os.tmpdir(), "collq-noui-")),
        codexBin: SIM_BIN,
        pool: new WorkerPool(1),
        memoryService: null,
      }),
      { uiDir: path.join(os.tmpdir(), "definitely-not-a-ui-dir-xyz") },
    );
    const res = await h.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
    const api = await h.inject({ method: "GET", url: "/api/nope" });
    expect(api.statusCode).toBe(404);
    await h.close();
  });
});

describe("projects", () => {
  it("slugifies titles and lists what it created", async () => {
    expect(slugify("Riemann Hypothesis: A Study!")).toBe("riemann-hypothesis-a-study");
    const h = harness();
    const slug = await parked(h, "Riemann Hypothesis: A Study!");
    expect(slug).toBe("riemann-hypothesis-a-study");

    const list = await h.app.inject({ method: "GET", url: "/api/projects" });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as {
      slug: string;
      title: string;
      phase: string;
      paused: boolean;
      waves: number;
      openBlockingQuestions: number;
      updatedAt: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug,
      title: "Riemann Hypothesis: A Study!",
      phase: "AWAITING_CONFIRMATION",
      paused: true,
      waves: 0,
      openBlockingQuestions: 0,
    });
    expect(rows[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const one = await h.app.inject({ method: "GET", url: `/api/projects/${slug}` });
    expect(one.statusCode).toBe(200);
    const snapshot = one.json() as { seq: number; state: { slug: string; seq: number; problem: { normalizedMarkdown: string | null } } };
    expect(snapshot.state.slug).toBe(slug);
    expect(snapshot.seq).toBe(snapshot.state.seq);
    expect(snapshot.seq).toBeGreaterThan(0);
    // the sim's intake landed
    expect(snapshot.state.problem.normalizedMarkdown).toContain("Normalized");

    const missing = await h.app.inject({ method: "GET", url: "/api/projects/no-such-project" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "not_found" });
  });

  it("prioritizes projects whose automatic planner recovery needs one click", async () => {
    const h = harness(1);
    const slug = await parked(h, "Recovery notice");
    const confirmed = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/confirm-problem`,
      payload: { problemMarkdown: "# Confirmed\n\nProve X." },
    });
    expect(confirmed.statusCode).toBe(200);
    await h.app.inject({ method: "POST", url: `/api/projects/${slug}/resume` });
    await waitFor(() =>
      Object.values(h.manager.get(slug)!.state.questions).some(
        (question) => question.status === "open" && question.blocking,
      ),
    );

    const list = await h.app.inject({ method: "GET", url: "/api/projects" });
    const row = (list.json() as {
      slug: string;
      openBlockingQuestions: number;
      updatedAt: string | null;
    }[]).find((project) => project.slug === slug);
    expect(row).toMatchObject({ slug, openBlockingQuestions: 1 });
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects a duplicate slug with 409 and a bad body with 400", async () => {
    const h = harness();
    await parked(h, "First project", "dup-slug");

    const dup = await createProject(h.app, {
      title: "Second project",
      slug: "dup-slug",
      statement: "Something else entirely.",
    });
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ error: "conflict" });

    const bad = await createProject(h.app, { title: "", statement: "x" });
    expect(bad.status).toBe(400);
    expect(bad.json["error"]).toBe("invalid_request");

    const noStatement = await createProject(h.app, { title: "Fine title" });
    expect(noStatement.status).toBe(400);

    const badSlug = await createProject(h.app, {
      title: "Fine title",
      slug: "Not A Slug",
      statement: "x",
    });
    expect(badSlug.status).toBe(400);
  });

  it("creates a fresh project from raw intake and W000 without copying research history or external mounts", async () => {
    const h = harness(1);
    const created = await createProject(h.app, {
      title: "Source problem",
      statement: "An early statement that intake will normalize.",
      contextMarkdown: "Long original notes that must remain available verbatim.",
      config: {
        budget: { totalTokens: 9_000_000 },
        allowWebSearch: true,
        sourceMounts: [
          { name: "private-notes", path: "/tmp/private-notes", note: "source project only" },
        ],
      },
      start: false,
    });
    expect(created.status).toBe(201);
    const sourceSlug = created.json["slug"] as string;
    const source = h.manager.get(sourceSlug)!;
    const supplied = await h.app.inject({
      method: "POST",
      url: `/api/projects/${sourceSlug}/sources`,
      headers: { "content-type": "application/octet-stream", "x-filename": "source-note.md" },
      payload: "# Original supplied note\n",
    });
    expect(supplied.statusCode).toBe(201);
    await h.app.inject({ method: "POST", url: `/api/projects/${sourceSlug}/start` });
    await waitFor(() => source.state.phase === "AWAITING_CONFIRMATION");
    await h.app.inject({ method: "POST", url: `/api/projects/${sourceSlug}/pause` });
    await h.app.inject({
      method: "POST",
      url: `/api/projects/${sourceSlug}/autonomy`,
      payload: { mode: "gated" },
    });

    const rawMemories = [
      {
        type: "ATTEMPT-SUMMARY",
        title: "Boundary reduction",
        abstract: "A proposed reduction isolates the boundary term.",
        content: "The reduction is only an intake lead and still needs an independent check.",
        tags: ["boundary", "reduction"],
      },
    ];
    const confirmedProblem = "# Confirmed source\n\nProve the precise statement P.";
    const contextDigest = "# Background\n\nThe useful literature and initial idea in concise form.";
    const confirmed = await h.app.inject({
      method: "POST",
      url: `/api/projects/${sourceSlug}/confirm-problem`,
      payload: {
        problemMarkdown: confirmedProblem,
        contextDigestMarkdown: contextDigest,
        rawMemories,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(Object.keys(source.state.cards)).toHaveLength(1);

    const sameTitle = await h.app.inject({
      method: "POST",
      url: `/api/projects/${sourceSlug}/clone-intake`,
      payload: { title: "  SOURCE   problem  " },
    });
    expect(sameTitle.statusCode).toBe(400);
    expect((sameTitle.json() as { detail: string }).detail).toContain("different title");

    const cloneResponse = await h.app.inject({
      method: "POST",
      url: `/api/projects/${sourceSlug}/clone-intake`,
      payload: { title: "Source problem — fresh attempt" },
    });
    expect(cloneResponse.statusCode).toBe(201);
    const cloneBody = cloneResponse.json() as { slug: string; phase: string };
    expect(cloneBody).toEqual({
      slug: "source-problem-fresh-attempt",
      phase: "AWAITING_CONFIRMATION",
    });

    const clone = h.manager.get(cloneBody.slug)!;
    expect(clone.state.title).toBe("Source problem — fresh attempt");
    expect(clone.state.phase).toBe("AWAITING_CONFIRMATION");
    expect(clone.state.problem).toMatchObject({
      normalizedMarkdown: confirmedProblem,
      confirmedMarkdown: null,
      contextDigestMarkdown: "",
      rawMemories: [],
      ambiguities: [],
      clarifications: [],
    });
    expect(clone.state.contextMarkdown).toBe("Long original notes that must remain available verbatim.");
    expect(clone.state.problem.sources.map((entry) => entry.kind)).toEqual(["objective", "background", "upload"]);
    expect(clone.state.researchManagerNotes.map((entry) => entry.waveId)).toEqual(["W000"]);
    expect(clone.state.config.allowWebSearch).toBe(true);
    expect(clone.state.autonomy).toBe("gated");
    expect(clone.state.config.autonomy).toBe("gated");
    expect(clone.state.config.budget.totalTokens).toBe(9_000_000);
    expect(clone.state.config.sourceMounts).toEqual([
      expect.objectContaining({ name: "uploads", path: path.join(h.root, cloneBody.slug, "sources") }),
    ]);
    expect(readFileSync(path.join(h.root, cloneBody.slug, "sources", "source-note.md"), "utf8"))
      .toBe("# Original supplied note\n");
    expect(clone.state.budget).toEqual({
      totalTokens: 9_000_000,
      spentTokens: 0,
      plannerSpentTokens: 0,
    });
    expect(clone.state.waveOrder).toEqual([]);
    expect(clone.state.tasks).toEqual({});
    expect(clone.state.artifacts).toEqual({});
    expect(clone.state.claims).toEqual({});
    expect(clone.state.cards).toEqual({});
    expect(clone.state.computations).toEqual({});
    expect(clone.events.map((event) => event.type)).toEqual([
      "project.created",
      "phase.changed",
      "intake.sourcesUpdated",
      "intake.completed",
      "manager.noteRecorded",
      "phase.changed",
    ]);

    // Creating the retry is non-destructive: the source remains paused with
    // its accepted intake memory and original filesystem access intact.
    expect(source.state.paused).toBe(true);
    expect(source.state.config.sourceMounts).toContainEqual({
      name: "private-notes",
      path: "/tmp/private-notes",
      note: "source project only",
    });
    expect(Object.keys(source.state.cards)).toHaveLength(1);
  });

  it("merges config over the defaults", () => {
    const merged = mergeConfig({ budget: { totalTokens: 1234 }, autonomy: "gated" });
    expect(merged.budget.totalTokens).toBe(1234);
    expect(merged.budget.defaultTaskTokens).toBe(1_500_000);
    expect(merged.autonomy).toBe("gated");
    expect(() => mergeConfig({ budget: { totalTokens: -1 } })).toThrow();
  });
});

describe("steering routes", () => {
  it("confirm-problem is 200 once and 409 in the wrong phase", async () => {
    const h = harness();
    const slug = await parked(h, "Confirm twice");

    const overlongAbstract = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/confirm-problem`,
      payload: {
        problemMarkdown: "# Confirmed\n\nProve X.",
        managerAbstract: "A".repeat(321),
        managerNoteMarkdown: "# Current mathematical view\n\nA direct proof may be possible.",
      },
    });
    expect(overlongAbstract.statusCode).toBe(400);
    expect(h.manager.get(slug)!.state.phase).toBe("AWAITING_CONFIRMATION");

    const ok = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/confirm-problem`,
      payload: { problemMarkdown: "# Confirmed\n\nProve X." },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { phase: string }).phase).toBe("DISCOVERY");

    const again = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/confirm-problem`,
      payload: { problemMarkdown: "# Confirmed again" },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { detail: string }).detail).toContain("cannot confirm problem in phase");
  });

  it("a directive shows up in the state snapshot", async () => {
    const h = harness();
    const slug = await parked(h, "Directive project");

    const res = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/directives`,
      payload: { text: "Try a spectral argument first.", urgent: false },
    });
    expect(res.statusCode).toBe(200);
    const id = (res.json() as { id: string }).id;
    expect(id).toMatch(/^D\d{3}$/);

    const snap = await h.app.inject({ method: "GET", url: `/api/projects/${slug}` });
    const state = (snap.json() as { state: { directives: Record<string, { text: string; status: string }> } }).state;
    expect(state.directives[id]).toMatchObject({
      text: "Try a spectral argument first.",
      status: "pending",
    });

    const bad = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/directives`,
      payload: { text: "" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("autonomy, pause and resume are reflected in state", async () => {
    const h = harness();
    const slug = await parked(h, "Toggle project");

    const auto = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/autonomy`,
      payload: { mode: "gated" },
    });
    expect(auto.statusCode).toBe(200);
    expect((auto.json() as { autonomy: string }).autonomy).toBe("gated");

    const badMode = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/autonomy`,
      payload: { mode: "sideways" },
    });
    expect(badMode.statusCode).toBe(400);

    const resumed = await h.app.inject({ method: "POST", url: `/api/projects/${slug}/resume` });
    expect((resumed.json() as { paused: boolean }).paused).toBe(false);
    await h.app.inject({ method: "POST", url: `/api/projects/${slug}/pause` });
    expect(h.manager.get(slug)!.state.paused).toBe(true);
  });

  it("updates project model settings durably and rejects malformed choices", async () => {
    const h = harness();
    const slug = await parked(h, "Model settings project");
    const models = {
      researchManager: { model: "gpt-5.6-sol", effort: "max" },
      solver: { model: "gpt-5.6-sol", effort: "max" },
      explorer: { model: "gpt-5.6-terra", effort: "high" },
      reviewer: { model: "gpt-5.6-sol", effort: "xhigh" },
      synthesizer: { model: "gpt-5.6-terra", effort: "high" },
    } as const;

    const saved = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/models`,
      payload: models,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ok: true, models });
    expect(h.manager.get(slug)!.state.config.models.solver).toEqual(models.solver);
    expect(h.manager.get(slug)!.events.at(-1)).toMatchObject({
      type: "models.changed",
      models,
      by: "human",
    });

    const beforeNoOp = h.manager.get(slug)!.state.seq;
    const noOp = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/models`,
      payload: models,
    });
    expect(noOp.statusCode).toBe(200);
    expect(h.manager.get(slug)!.state.seq).toBe(beforeNoOp);

    const malformed = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/models`,
      payload: { ...models, solver: { model: "not a model id", effort: "impossible" } },
    });
    expect(malformed.statusCode).toBe(400);

    await h.manager.shutdown();
    h.manager.openAll();
    expect(h.manager.get(slug)!.state.config.models.solver).toEqual(models.solver);
    expect(h.manager.get(slug)!.state.config.models.explorer).toEqual(models.explorer);
  });

  it("updates the project Web-search policy durably and avoids duplicate events", async () => {
    const h = harness();
    const slug = await parked(h, "Web search settings project");
    expect(h.manager.get(slug)!.state.config.allowWebSearch).toBe(false);

    const saved = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/web-search`,
      payload: { enabled: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ok: true, enabled: true });
    expect(h.manager.get(slug)!.events.at(-1)).toMatchObject({
      type: "webSearch.changed",
      enabled: true,
      by: "human",
    });

    const beforeNoOp = h.manager.get(slug)!.state.seq;
    const noOp = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/web-search`,
      payload: { enabled: true },
    });
    expect(noOp.statusCode).toBe(200);
    expect(h.manager.get(slug)!.state.seq).toBe(beforeNoOp);

    const malformed = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/web-search`,
      payload: { enabled: "yes" },
    });
    expect(malformed.statusCode).toBe(400);

    await h.manager.shutdown();
    h.manager.openAll();
    expect(h.manager.get(slug)!.state.config.allowWebSearch).toBe(true);
  });

  it("validates continue-research requests and rejects them before a stopping report", async () => {
    const h = harness();
    const slug = await parked(h, "Continue validation");

    const invalid = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/continue`,
      payload: { note: "", addTokens: -1, addWaves: 101 },
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: string }).error).toBe("invalid_request");

    const notTerminal = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/continue`,
      payload: { note: "Try a more local reduction.", addTokens: 0, addWaves: 0 },
    });
    expect(notTerminal.statusCode).toBe(409);
    expect((notTerminal.json() as { detail: string }).detail).toContain("not currently at a stopping report");
  });

  it("maps unknown ids to 404 and impossible steering to 409", async () => {
    const h = harness();
    const slug = await parked(h, "Error mapping");

    const extend = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/tasks/T009/extend`,
      payload: { addTokens: 1000 },
    });
    expect(extend.statusCode).toBe(404);

    const claim = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/claims/K001/status`,
      payload: { to: "VERIFIED", note: "checked by hand" },
    });
    expect(claim.statusCode).toBe(404);

    const issue = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/issues`,
      payload: { candidateId: "C001.v1", severity: "MAJOR", location: "§2", text: "gap" },
    });
    expect(issue.statusCode).toBe(404);

    const quarantine = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/memory/M001/quarantine`,
      payload: { note: "wrong" },
    });
    expect(quarantine.statusCode).toBe(404);

    const gate = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/gates/DEC001`,
      payload: { resolution: "approve" },
    });
    expect(gate.statusCode).toBe(409);

    const wave = await h.app.inject({ method: "POST", url: `/api/projects/${slug}/waves/W001/interrupt` });
    expect(wave.statusCode).toBe(409);

    const kill = await h.app.inject({ method: "POST", url: `/api/projects/${slug}/tasks/T001/interrupt` });
    expect(kill.statusCode).toBe(409);

    const question = await h.app.inject({
      method: "POST",
      url: `/api/projects/${slug}/questions/Q001/answer`,
      payload: { answer: "yes" },
    });
    expect(question.statusCode).toBe(409);
  });
});

describe("read surfaces", () => {
  it("projects the nested memo rather than returning the entire worker output", () => {
    const output = {
      conclusion: "UNCERTAIN",
      artifactMarkdown: "CONCLUSION: UNCERTAIN\n\nPartial work.",
      memo: TASK_MEMO,
      recallLog: [],
    };
    expect(taskMemoFromOutput(output)).toEqual(TASK_MEMO);
    expect(taskMemoFromOutput({ ...output, memo: { summary: "missing arrays" } })).toBeNull();
    expect(taskMemoFromOutput(null)).toBeNull();
  });

  it("404s unknown artifacts and tasks, 400s packet traversal", async () => {
    const h = harness();
    const slug = await parked(h, "Read surfaces");

    const artifact = await h.app.inject({ method: "GET", url: `/api/projects/${slug}/artifacts/A001` });
    expect(artifact.statusCode).toBe(404);
    expect((artifact.json() as { detail: string }).detail).toContain("unknown artifact");

    const task = await h.app.inject({ method: "GET", url: `/api/projects/${slug}/tasks/T001` });
    expect(task.statusCode).toBe(404);
    expect((task.json() as { detail: string }).detail).toContain("unknown task");

    for (const attempt of [
      `/api/projects/${slug}/tasks/T001/packet/..%2F..%2Fproject.json`,
      `/api/projects/${slug}/tasks/T001/packet/%2Fetc%2Fpasswd`,
      `/api/projects/${slug}/tasks/T001/packet/sub/..%2F..%2F..%2Fevents.jsonl`,
    ]) {
      const res = await h.app.inject({ method: "GET", url: attempt });
      expect(res.statusCode, attempt).toBe(400);
      expect((res.json() as { error: string }).error).toBe("invalid_request");
    }

    const missing = await h.app.inject({
      method: "GET",
      url: `/api/projects/${slug}/tasks/T001/packet/research-question.md`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects unencoded dot-segment traversal sent over a raw socket", async () => {
    // inject() and fetch() both normalize `/../` away client-side, so the only
    // way to prove the server-side check is to write the request by hand.
    const h = harness();
    const slug = await parked(h, "Raw traversal");
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /api/projects/${slug}/tasks/T001/packet/../../project.json HTTP/1.1\r\n` +
            "Host: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
      });
      let body = "";
      socket.on("data", (d) => (body += d.toString("utf8")));
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });
    expect(response.split("\r\n")[0]).toContain("400");
    expect(response).toContain("invalid_request");
  }, 20_000);
});

describe("task stream", () => {
  it("404s for an unknown task before hijacking the socket", async () => {
    const h = harness();
    const slug = await parked(h, "Stream 404");
    const res = await h.app.inject({ method: "GET", url: `/api/projects/${slug}/tasks/T001/stream` });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("tailJsonl replays the last lines and picks up appends", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "collq-tail-"));
    const file = path.join(dir, "codex-events.jsonl");
    const seen: string[] = [];

    // file absent at open: the tailer must wait for it, not throw
    const missing = tailJsonl(file, (l) => seen.push(l), { pollMs: 20 });
    writeFileSync(file, `{"n":1}\n{"n":2}\n`);
    await waitFor(() => seen.length === 2, 2000);
    missing.stop();

    const replayed: string[] = [];
    const tail = tailJsonl(file, (l) => replayed.push(l), { tailLines: 1, pollMs: 20 });
    expect(replayed).toEqual(['{"n":2}']);
    appendFileSync(file, `{"n":3}\n{"n":4}`); // partial final line, no newline yet
    await waitFor(() => replayed.length === 2, 2000);
    expect(replayed[1]).toBe('{"n":3}');
    appendFileSync(file, `\n`);
    await waitFor(() => replayed.length === 3, 2000);
    expect(replayed[2]).toBe('{"n":4}');
    tail.stop();
  });
});

describe("SSE", () => {
  it("replays the backlog by seq and then streams live events", async () => {
    const h = harness();
    const slug = await parked(h, "Streaming project");
    const engine = h.manager.get(slug)!;
    const backlogLength = engine.events.length;
    expect(backlogLength).toBeGreaterThan(2);

    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/projects/${slug}/events?since=0`, {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: { id: string | null; data: string }[] = [];

    const pump = async (until: () => boolean, ms = 8000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!until() && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 500),
          ),
        ]);
        if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
        for (const block of buffer.split("\n\n").slice(0, -1)) {
          const id = /^id: (.+)$/m.exec(block)?.[1] ?? null;
          const data = /^data: (.+)$/m.exec(block)?.[1] ?? null;
          if (data !== null) frames.push({ id, data });
        }
        buffer = buffer.split("\n\n").slice(-1)[0] ?? "";
      }
    };

    await pump(() => frames.length >= backlogLength);
    expect(frames.length).toBeGreaterThanOrEqual(backlogLength);
    const seqs = frames.map((f) => Number(f.id));
    expect(seqs.slice(0, backlogLength)).toEqual(
      engine.events.slice(0, backlogLength).map((e) => e.seq),
    );
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const first = JSON.parse(frames[0]!.data) as { type: string; seq: number };
    expect(first).toMatchObject({ type: "project.created", seq: 1 });

    // live: a directive posted over the same server must arrive on the socket
    const post = await fetch(`${base}/api/projects/${slug}/directives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Live event please.", urgent: false }),
    });
    expect(post.status).toBe(200);

    await pump(() => frames.some((f) => f.data.includes("directive.submitted")));
    const live = frames.find((f) => f.data.includes("directive.submitted"))!;
    expect(live).toBeTruthy();
    const parsed = JSON.parse(live.data) as { type: string; seq: number; text: string };
    expect(parsed.text).toBe("Live event please.");
    expect(Number(live.id)).toBe(parsed.seq);
    expect(parsed.seq).toBeGreaterThan(backlogLength);

    await reader.cancel();
  }, 20_000);

  it("since= and Last-Event-ID skip what the client already has", async () => {
    const h = harness();
    const slug = await parked(h, "Resume project");
    const engine = h.manager.get(slug)!;
    const seq = engine.state.seq;

    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const readFirstFrame = async (url: string, headers: Record<string, string>): Promise<string> => {
      const res = await fetch(url, { headers });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
        const match = /^data: (.+)$/m.exec(buffer);
        if (match) {
          await reader.cancel();
          return match[1]!;
        }
      }
      await reader.cancel();
      throw new Error("no frame arrived");
    };

    // Nothing is replayed; the next live event is the first thing seen.
    const pending = readFirstFrame(`${base}/api/projects/${slug}/events?since=${seq}`, {
      accept: "text/event-stream",
    });
    await new Promise((r) => setTimeout(r, 200));
    engine.submitDirective("after the cursor", false);
    expect(JSON.parse(await pending)).toMatchObject({ type: "directive.submitted", seq: seq + 1 });

    const viaHeader = readFirstFrame(`${base}/api/projects/${slug}/events`, {
      accept: "text/event-stream",
      "last-event-id": String(engine.state.seq),
    });
    await new Promise((r) => setTimeout(r, 200));
    const nextSeq = engine.state.seq + 1;
    engine.submitDirective("after the header cursor", false);
    expect(JSON.parse(await viaHeader)).toMatchObject({ type: "directive.submitted", seq: nextSeq });
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe("source uploads", () => {
  const uploadUrl = (slug: string): string => `/api/projects/${slug}/sources`;

  const upload = (
    h: Harness,
    slug: string,
    filename: string | undefined,
    payload: string | Buffer,
  ) =>
    h.app.inject({
      method: "POST",
      url: uploadUrl(slug),
      headers: {
        "content-type": "application/octet-stream",
        ...(filename === undefined ? {} : { "x-filename": filename }),
      },
      payload,
    });

  it("parks creation until uploads finish, then gives retained originals to W000", async () => {
    const h = harness(1);
    const created = await createProject(h.app, {
      title: "Deferred intake",
      statement: "Understand the DNC localization argument.",
      start: false,
    });
    expect(created.status).toBe(201);
    const slug = created.json["slug"] as string;
    const engine = h.manager.get(slug)!;
    expect(engine.state.phase).toBe("CREATED");
    expect(engine.state.decisionOrder).toEqual([]);

    expect((await upload(h, slug, "dnc-notes.md", "# DNC master space\n")).statusCode).toBe(201);
    expect(engine.state.phase).toBe("CREATED");

    expect((await h.app.inject({ method: "POST", url: `/api/projects/${slug}/start` })).statusCode).toBe(200);
    await waitFor(() => engine.state.phase === "AWAITING_CONFIRMATION");
    expect(engine.state.problem.sources.map((source) => source.title)).toEqual([
      "Original objective",
      "dnc-notes.md",
    ]);
    expect(readFileSync(
      path.join(h.root, slug, "decisions", "DEC001", "packet", "raw-materials", "S002-dnc-notes.md"),
      "utf8",
    )).toBe("# DNC master space\n");

    const opened = await h.app.inject({ method: "GET", url: `${uploadUrl(slug)}/dnc-notes.md` });
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toBe("# DNC master space\n");
    expect((await upload(h, slug, "dnc-notes.md", "replacement")).statusCode).toBe(409);
    expect((await h.app.inject({ method: "DELETE", url: `${uploadUrl(slug)}/dnc-notes.md` })).statusCode).toBe(409);
  }, 20_000);

  it("round-trips upload, list and delete", async () => {
    const h = harness();
    const slug = await parked(h, "Upload round trip");

    const created = await upload(h, slug, "notes.md", "# hello\n");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "notes.md", size: 8, mount: "uploads" });

    const stored = path.join(h.root, slug, "sources", "notes.md");
    expect(readFileSync(stored, "utf8")).toBe("# hello\n");

    const listed = await h.app.inject({ method: "GET", url: uploadUrl(slug) });
    expect(listed.statusCode).toBe(200);
    const files = listed.json() as { name: string; size: number; uploadedAt: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("notes.md");
    expect(files[0]!.size).toBe(8);
    expect(Number.isNaN(Date.parse(files[0]!.uploadedAt))).toBe(false);

    // A second file with the same name replaces it rather than piling up.
    const replaced = await upload(h, slug, "notes.md", "# hello again\n");
    expect(replaced.statusCode).toBe(201);
    expect((replaced.json() as { size: number }).size).toBe(14);
    expect(((await h.app.inject({ method: "GET", url: uploadUrl(slug) })).json() as unknown[]))
      .toHaveLength(1);

    const removed = await h.app.inject({
      method: "DELETE",
      url: `${uploadUrl(slug)}/notes.md`,
    });
    expect(removed.statusCode).toBe(200);
    expect(existsSync(stored)).toBe(false);
    expect((await h.app.inject({ method: "GET", url: uploadUrl(slug) })).json()).toEqual([]);

    const again = await h.app.inject({ method: "DELETE", url: `${uploadUrl(slug)}/notes.md` });
    expect(again.statusCode).toBe(404);
  }, 20_000);

  it("registers the uploads mount in the live config and in project.json", async () => {
    const h = harness();
    const slug = await parked(h, "Upload mount");
    const engine = h.manager.get(slug)!;
    expect(engine.state.config.sourceMounts.some((m) => m.name === "uploads")).toBe(false);

    expect((await upload(h, slug, "lemma.tex", "\\section{x}")).statusCode).toBe(201);

    const expected = path.join(h.root, slug, "sources");
    const live = engine.state.config.sourceMounts.find((m) => m.name === "uploads");
    expect(live).toBeTruthy();
    expect(live!.path).toBe(expected);

    const onDisk = JSON.parse(
      readFileSync(path.join(h.root, slug, "project.json"), "utf8"),
    ) as { config: { sourceMounts: { name: string; path: string }[] } };
    expect(onDisk.config.sourceMounts).toContainEqual(
      expect.objectContaining({ name: "uploads", path: expected }),
    );

    // Re-uploading does not duplicate the mount.
    expect((await upload(h, slug, "second.md", "x")).statusCode).toBe(201);
    expect(engine.state.config.sourceMounts.filter((m) => m.name === "uploads")).toHaveLength(1);
  }, 20_000);

  it("rejects traversal, absolute and malformed filenames with 400", async () => {
    const h = harness();
    const slug = await parked(h, "Upload sanitation");

    const bad = [
      "../evil.md",
      "..%2Fevil.md",
      "%2e%2e%2fevil.md",
      "sub/evil.md",
      "..\\evil.md",
      "/etc/passwd",
      "..",
      ".hidden",
      "with space.md",
      "quote'.md",
      `${"a".repeat(130)}.md`,
    ];
    for (const filename of bad) {
      const res = await upload(h, slug, filename, "payload");
      expect(res.statusCode, filename).toBe(400);
      expect((res.json() as { error: string }).error).toBe("invalid_request");
    }

    const noHeader = await upload(h, slug, undefined, "payload");
    expect(noHeader.statusCode).toBe(400);

    // The delete route sanitizes identically.
    for (const name of ["..%2F..%2Fproject.json", "%2Fetc%2Fpasswd"]) {
      const res = await h.app.inject({ method: "DELETE", url: `${uploadUrl(slug)}/${name}` });
      expect(res.statusCode, name).toBe(400);
    }

    // Nothing escaped the project directory.
    expect(existsSync(path.join(h.root, slug, "sources"))).toBe(false);
    expect(existsSync(path.join(h.root, "evil.md"))).toBe(false);
  }, 20_000);

  it("rejects oversize uploads with 413", async () => {
    const h = harness();
    const slug = await parked(h, "Upload size cap");

    const overFileCap = await upload(h, slug, "big.bin", Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    expect(overFileCap.statusCode).toBe(413);
    expect((overFileCap.json() as { detail: string }).detail).toContain("per file");

    // Far beyond the cap the transport layer refuses it first — still a 413.
    const overTransport = await upload(h, slug, "huge.bin", Buffer.alloc(12 * 1024 * 1024, 1));
    expect(overTransport.statusCode).toBe(413);

    expect((await h.app.inject({ method: "GET", url: uploadUrl(slug) })).json()).toEqual([]);
  }, 30_000);

  it("404s unknown projects and 400s invalid slugs", async () => {
    const h = harness();
    await parked(h, "Upload unknown project");

    expect((await upload(h, "no-such-project", "a.md", "x")).statusCode).toBe(404);
    expect(
      (await h.app.inject({ method: "GET", url: uploadUrl("no-such-project") })).statusCode,
    ).toBe(404);
    expect((await upload(h, "Bad_Slug", "a.md", "x")).statusCode).toBe(400);
  }, 20_000);
});
