import {
  defaultConfig
} from "@inventio/schema";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerPool } from "../src/engine/pool.js";
import { EventLog } from "../src/store/eventLog.js";
import { createProjectDirs, defaultProjectFile, listProjectSlugs, projectPaths, readProjectFile, writeFileAtomic, writeProjectFile } from "../src/store/projectStore.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "collq-core-"));

describe("EventLog", () => {
  it("appends with seq/ts, fsyncs, and replays identically after reopen", () => {
    const file = path.join(tmp(), "events.jsonl");
    const log = EventLog.open(file);
    const e1 = log.append({ type: "project.created", slug: "s-a", title: "T", statement: "P", config: defaultConfig() });
    const e2 = log.append({ type: "phase.changed", from: "CREATED", to: "INTAKE", reason: "start" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    log.close();

    const reopened = EventLog.open(file);
    expect(reopened.events.length).toBe(2);
    expect(reopened.events[1]!.type).toBe("phase.changed");
    const e3 = reopened.append({ type: "project.paused", by: "human" });
    expect(e3.seq).toBe(3);
    reopened.close();
  });

  it("drops a torn tail line but rejects mid-file corruption", () => {
    const dir = tmp();
    const file = path.join(dir, "events.jsonl");
    const log = EventLog.open(file);
    log.append({ type: "project.created", slug: "s-a", title: "T", statement: "P", config: defaultConfig() });
    log.close();
    appendFileSync(file, '{"seq":2,"ts":"x","type":"project.pau'); // torn
    const reopened = EventLog.open(file);
    expect(reopened.events.length).toBe(1);
    // appending after a torn tail keeps seq continuity
    const e = reopened.append({ type: "project.paused", by: "human" });
    expect(e.seq).toBe(2);
    reopened.close();

    const file2 = path.join(dir, "corrupt.jsonl");
    writeFileSync(file2, 'garbage\n{"seq":1}\n');
    expect(() => EventLog.open(file2)).toThrow(/corrupt/);
  });

  it("refuses invalid events and seq gaps", () => {
    const file = path.join(tmp(), "events.jsonl");
    const log = EventLog.open(file);
    expect(() => log.append({ type: "phase.changed", from: "NOPE", to: "INTAKE", reason: "" } as never)).toThrow(/invalid/);
    log.close();
    const file2 = path.join(tmp(), "gap.jsonl");
    writeFileSync(file2, '{"seq":1,"ts":"t","type":"project.paused","by":"h"}\n{"seq":3,"ts":"t","type":"project.resumed","by":"h"}\n');
    expect(() => EventLog.open(file2)).toThrow(/seq gap/);
    expect(existsSync(`${file2}.lock`)).toBe(false);
  });

  it("gives one process exclusive write ownership and detects an old external writer", () => {
    const file = path.join(tmp(), "events.jsonl");
    const log = EventLog.open(file);
    log.append({
      type: "project.created",
      slug: "one-writer",
      title: "One writer",
      statement: "P",
      config: defaultConfig(),
    });

    expect(() => EventLog.open(file)).toThrow(/already open by Inventio process/);
    appendFileSync(
      file,
      JSON.stringify({
        seq: 2,
        ts: "2026-08-30T00:00:00.000Z",
        type: "project.paused",
        by: "human",
      }) + "\n",
    );
    expect(() => log.append({ type: "project.paused", by: "human" })).toThrow(
      /changed outside its owning process/,
    );
    log.close();
    expect(existsSync(`${file}.lock`)).toBe(false);

    const reopened = EventLog.open(file);
    expect(reopened.events.map((event) => event.seq)).toEqual([1, 2]);
    reopened.close();
  });

  it("reclaims a lock left by a process that no longer exists", () => {
    const file = path.join(tmp(), "events.jsonl");
    writeFileSync(
      `${file}.lock`,
      JSON.stringify({ pid: 2_147_483_647, token: "stale", startedAt: "earlier" }) + "\n",
    );
    const log = EventLog.open(file);
    expect(existsSync(`${file}.lock`)).toBe(true);
    log.close();
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("recovers an agreeing concurrent terminal tail and preserves the original bytes", () => {
    const dir = tmp();
    const file = path.join(dir, "events.jsonl");
    const ts = "2026-08-30T00:00:00.000Z";
    const config = defaultConfig();
    const final = { finalMarkdown: "# Final\n\nUncertain." };
    const events = [
      { seq: 1, ts, type: "project.created", slug: "fork", title: "Fork", statement: "P", config },
      { seq: 2, ts, type: "decision.requested", decisionId: "DEC001", kind: "final", waveId: null },
      { seq: 3, ts, type: "decision.proposed", decisionId: "DEC001", action: null, usage: null },
      { seq: 4, ts, type: "decision.rejected", decisionId: "DEC001", violations: ["restart"] },
      { seq: 5, ts, type: "decision.requested", decisionId: "DEC002", kind: "final", waveId: null },
      // Late predecessor branch, using sequence numbers from its stale view.
      { seq: 3, ts, type: "decision.proposed", decisionId: "DEC001", action: final, usage: null },
      { seq: 4, ts, type: "decision.accepted", decisionId: "DEC001", action: final },
      { seq: 5, ts, type: "artifact.recorded", artifactId: "final", kind: "final", taskId: null, path: "artifacts/final.md", conclusion: "UNCERTAIN" },
      { seq: 6, ts, type: "phase.changed", from: "DISCOVERY", to: "TERMINAL", reason: "done" },
      { seq: 7, ts, type: "terminal.reached", result: "UNCERTAIN", finalPath: "artifacts/final.md" },
      // Replacement branch. Its later occurrence wins for each overlapping
      // sequence and continues without a gap.
      { seq: 6, ts, type: "decision.proposed", decisionId: "DEC002", action: final, usage: null },
      { seq: 7, ts, type: "decision.accepted", decisionId: "DEC002", action: final },
      { seq: 8, ts, type: "artifact.recorded", artifactId: "final", kind: "final", taskId: null, path: "artifacts/final.md", conclusion: "UNCERTAIN" },
      { seq: 9, ts, type: "phase.changed", from: "DISCOVERY", to: "TERMINAL", reason: "done" },
      { seq: 10, ts, type: "terminal.reached", result: "UNCERTAIN", finalPath: "artifacts/final.md" },
    ];
    const original = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    writeFileSync(file, original);

    const log = EventLog.open(file);
    expect(log.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    expect(log.events[5]).toMatchObject({ type: "decision.proposed", decisionId: "DEC002" });
    expect(log.events.filter((event) => event.type === "terminal.reached")).toHaveLength(1);
    log.close();

    const backup = readdirSync(dir).find((name) => name.includes("concurrent-terminal-tail"));
    expect(backup).toBeDefined();
    expect(readFileSync(path.join(dir, backup!), "utf8")).toBe(original);
  });
});

describe("projectStore", () => {
  it("creates layout, writes project file atomically, lists slugs", () => {
    const root = tmp();
    const p = projectPaths(root, "my-problem");
    createProjectDirs(p);
    writeProjectFile(p, defaultProjectFile("my-problem", "My problem", defaultConfig()));
    expect(readProjectFile(p).title).toBe("My problem");
    expect(existsSync(path.join(p.artifactsDir, "attempts"))).toBe(true);
    expect(listProjectSlugs(root)).toEqual(["my-problem"]);
    // no temp droppings
    expect(readdirSync(p.dir).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
    expect(() => projectPaths(root, "Bad Slug")).toThrow(/slug/);
  });

  it("writeFileAtomic replaces content atomically", () => {
    const dir = tmp();
    const f = path.join(dir, "a", "x.md");
    writeFileAtomic(f, "one");
    writeFileAtomic(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
  });
});

describe("WorkerPool", () => {
  it("caps concurrency and drains the queue", async () => {
    const pool = new WorkerPool(2);
    let peak = 0;
    let current = 0;
    const job = () =>
      pool.run(async () => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 30));
        current -= 1;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });
});
