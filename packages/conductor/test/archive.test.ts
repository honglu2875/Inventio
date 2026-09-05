import { applyEvent, defaultConfig, initialState } from "@inventio/schema";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCanonicalEvents } from "../../schema/test/fixtures.js";
import { ProjectEngine } from "../src/engine/engine.js";
import { WorkerPool } from "../src/engine/pool.js";
import { ArchivedProject } from "../src/legacy/archive.js";
import { buildApp } from "../src/server/http.js";
import { EngineManager } from "../src/server/manager.js";
import { buildProjectExportSnapshot } from "../src/server/projectExport.js";
import { createProjectDirs, defaultProjectFile, projectPaths, writeProjectFile } from "../src/store/projectStore.js";
import { SIM_BIN } from "./helpers/harness.js";

const managers: EngineManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.shutdown(); });

function fixture(running = false, missingWorkflow = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "inventio-archive-"));
  const paths = projectPaths(root, "test-problem");
  createProjectDirs(paths);
  writeProjectFile(paths, defaultProjectFile("test-problem", "Test problem", defaultConfig()));
  let events = buildCanonicalEvents();
  if (running) events = events.slice(0, events.findIndex((e) => e.type === "task.dispatched") + 1);
  const serialized = JSON.parse(JSON.stringify(events)) as Record<string, any>[];
  if (missingWorkflow) delete serialized[0]!.config.workflow;
  writeFileSync(paths.eventsFile, serialized.map(e => JSON.stringify(e)).join("\n") + "\n");
  // Archives do not acquire or reclaim even a stale/unreadable writer lock.
  writeFileSync(paths.eventsFile + ".lock", "historical lock bytes");
  mkdirSync(path.join(paths.dir, "sources"), { recursive: true });
  writeFileSync(path.join(paths.dir, "sources", "note.md"), "Original source.");
  writeFileSync(path.join(paths.dir, "problem.md"), "Prove P.");
  const manager = new EngineManager({ root, codexBin: SIM_BIN, pool: new WorkerPool(1), memoryService: null });
  managers.push(manager);
  return { root, paths, events, manager };
}

function bytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(bytes(file))) out[`${entry.name}/${name}`] = value;
    else out[entry.name] = readFileSync(file).toString("base64");
  }
  return out;
}

describe("view-only legacy archive", () => {
  it.each([false, true])("replays historical state without recovery writes or workers (running=%s)", async running => {
    const { paths, events, manager } = fixture(running, true);
    const before = bytes(paths.dir);
    manager.openAll();
    const archive = manager.require("test-problem");
    expect(archive).toBeInstanceOf(ArchivedProject);
    const expected = initialState();
    for (const event of events) applyEvent(expected, event);
    expect(archive.state).toEqual(expected);
    expect(manager.pool.active).toBe(0);
    expect(manager.pool.queued).toBe(0);
    expect(() => manager.requireActive("test-problem")).toThrow(/view-only/);
    const snapshot = buildProjectExportSnapshot(archive);
    expect(snapshot.state.claims).toEqual(expected.claims);
    expect(snapshot.state.terminal).toEqual(expected.terminal);
    expect(archive.state).toEqual(expected); // Export redacts thread IDs in a detached copy.
    await manager.shutdown();
    expect(bytes(paths.dir)).toEqual(before);
  });

  it("serves evidence and rejects every legacy mutation without changing project bytes", async () => {
    const { paths, manager } = fixture();
    const before = bytes(paths.dir);
    manager.openAll();
    const app = buildApp(manager, { uiDir: null });
    try {
      expect((await app.inject({ method: "GET", url: "/api/projects/test-problem" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/projects/test-problem/settings" })).statusCode).toBe(200);
      const cases: [string, Record<string, unknown>][] = [
        ["start", {}], ["pause", {}], ["resume", {}],
        ["continue", { note: "Try another argument.", addTokens: 1000, addWaves: 1 }],
        ["raw-intake", { statement: "Changed", contextMarkdown: "" }],
        ["confirm-problem", { problemMarkdown: "Changed" }], ["regenerate-intake", {}],
        ["publication", {}], ["publications/P001/compile", {}],
        ["settings", {}], ["models", {}], ["web-search", { enabled: true }],
        ["autonomy", { mode: "auto" }], ["directives", { text: "Try a new proof." }],
        ["questions/Q001/answer", { answer: "yes" }], ["questions/Q001/dismiss", {}],
        ["gates/DEC001", { resolution: "approve" }], ["waves/W001/interrupt", {}],
        ["tasks/T001/interrupt", {}], ["tasks/T001/extend", { addTokens: 100 }],
        ["claims/K001/status", { to: "VERIFIED", note: "Reviewed." }],
        ["issues", {}], ["memory/M001/quarantine", { note: "Questionable." }],
      ];
      for (const [route, payload] of cases) {
        const response = await app.inject({ method: "POST", url: `/api/projects/test-problem/${route}`, payload });
        expect(response.statusCode, route).toBe(409);
        expect(response.body, route).toContain("view-only");
      }
      expect(() => manager.uploadSource("test-problem", "new.md", Buffer.from("x"))).toThrow(/view-only/);
      expect(() => manager.deleteSource("test-problem", "note.md")).toThrow(/view-only/);
      expect(bytes(paths.dir)).toEqual(before);
    } finally { await app.close(); }
  });

  it("copies an archive intake into a fresh trajectory project without altering the archive", async () => {
    const { paths, manager } = fixture();
    manager.openAll();
    const before = bytes(paths.dir);
    const clone = manager.cloneIntake("test-problem", { title: "New mathematical investigation" });
    expect(clone.state.config.workflow).toBe("trajectories-v2");
    expect(clone.state.phase).toBe("AWAITING_CONFIRMATION");
    expect(clone.state.claimOrder).toEqual([]);
    expect(clone.state.researchManagerNotes).toEqual([]);
    expect(bytes(paths.dir)).toEqual(before);
  });

  it("rejects legacy creation and direct execution before writing files", () => {
    const { root, paths, manager } = fixture();
    expect(() => manager.createProject({ title: "Retired workflow", statement: "P", config: defaultConfig() })).toThrow(/view-only/);
    const before = bytes(paths.dir);
    expect(() => ProjectEngine.load({ root, codexBin: SIM_BIN, pool: new WorkerPool(1), memory: null }, "test-problem")).toThrow(/view-only/);
    expect(bytes(paths.dir)).toEqual(before);
  });
});
