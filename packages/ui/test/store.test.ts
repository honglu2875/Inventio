import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, projectSettingsFromConfig, type Event } from "@inventio/schema";
import { defaultCollapsed, reconcileCollapse, runningWaveIds } from "../src/lib/collapse.js";
import { collapsedSet, useStore } from "../src/store/store.js";

/**
 * Store-level tests (UI-SPEC §14): the reducer fold over a committed fixture,
 * replay-overlap suppression on reconnect, and the collapse-set policy.
 * DOM-free — the store is plain zustand + immer.
 */

// The fixture is a static asset; `import.meta.glob` keeps it out of the type
// graph (this package does not enable resolveJsonModule) while vite/vitest
// still bundles it.
const FIXTURES = import.meta.glob("../src/fixtures/happy.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

const HAPPY = Object.values(FIXTURES)[0] as Event[];

function fold(slug: string, batches: Event[][]): void {
  const store = useStore.getState();
  store.resetSlot(slug);
  for (const batch of batches) useStore.getState().applyEvents(slug, batch);
}

function slotOf(slug: string) {
  const slot = useStore.getState().projects[slug];
  if (!slot) throw new Error(`no slot for ${slug}`);
  return slot;
}

describe("fixture fold", () => {
  beforeEach(() => {
    useStore.setState({ projects: {}, collapse: {}, toasts: [] });
  });

  it("has a non-trivial fixture with contiguous seqs", () => {
    expect(HAPPY.length).toBeGreaterThan(20);
    HAPPY.forEach((event, i) => {
      expect(event.seq).toBe(i + 1);
    });
  });

  it("folds the whole lifecycle in one batch", () => {
    fold("one", [HAPPY]);
    const state = slotOf("one").state;
    expect(state).not.toBeNull();
    if (state === null) return;

    expect(state.slug).toBe("test-problem");
    expect(state.seq).toBe(HAPPY.length);
    expect(state.phase).toBe("TERMINAL");
    expect(state.terminal).toEqual({ result: "UNCERTAIN", finalPath: "artifacts/final.md" });

    expect(state.waveOrder).toEqual(["W001"]);
    expect(Object.keys(state.tasks).sort()).toEqual(["T001", "T002", "T003"]);
    expect(state.tasks["T001"]?.status).toBe("completed");
    expect(state.tasks["T002"]?.status).toBe("interrupted");
    expect(state.tasks["T003"]?.status).toBe("failed");

    expect(state.budget.totalTokens).toBe(40_000_000);
    expect(state.budget.spentTokens).toBeGreaterThan(0);
    expect(state.budget.plannerSpentTokens).toBeGreaterThan(0);

    expect(state.claimOrder).toEqual(["K001", "K002"]);
    expect(state.lineages["C001"]?.status).toBe("abandoned");
    expect(state.candidates["C001.v1"]).toBeDefined();
    expect(state.questions["Q001"]?.status).toBe("answered");
    expect(state.questions["Q002"]?.status).toBe("dismissed");
    expect(state.directives["D001"]?.status).toBe("consumed");
    expect(state.directives["D001"]?.consumedByDecision).toBe("DEC001");
    expect(state.openGateDecisionId).toBeNull();
    expect(slotOf("one").lastError).toBeNull();
  });

  it("is batch-size independent (rAF flushes are arbitrary)", () => {
    fold("whole", [HAPPY]);
    const chunks: Event[][] = [];
    for (let i = 0; i < HAPPY.length; i += 7) chunks.push(HAPPY.slice(i, i + 7));
    fold("chunked", chunks);
    expect(slotOf("chunked").state).toEqual(slotOf("whole").state);
  });

  it("records exactly the applied events", () => {
    fold("log", [HAPPY]);
    expect(slotOf("log").events.length).toBe(HAPPY.length);
    expect(slotOf("log").waveIds).toEqual(["W001"]);
  });
});

describe("project settings projection", () => {
  beforeEach(() => {
    useStore.setState({ projects: {}, collapse: {}, toasts: [] });
  });

  it("shows the creation value and folds one atomic later settings change", () => {
    const config = defaultConfig();
    config.allowWebSearch = true;
    config.autonomy = "gated";
    const created: Event = {
      seq: 1,
      ts: new Date(1).toISOString(),
      type: "project.created",
      slug: "settings-test",
      title: "Settings test",
      statement: "Prove P.",
      contextMarkdown: "",
      config,
    };
    fold("settings-test", [[created]]);
    expect(projectSettingsFromConfig(slotOf("settings-test").state!.config)).toMatchObject({
      allowWebSearch: true,
      autonomy: "gated",
    });

    const settings = projectSettingsFromConfig(config);
    settings.allowWebSearch = false;
    settings.autonomy = "auto";
    settings.totalTokens = 55_000_000;
    settings.maxWaves = 30;
    const changed: Event = {
      seq: 2,
      ts: new Date(2).toISOString(),
      type: "project.settingsChanged",
      settings,
      by: "human",
    };
    useStore.getState().applyEvents("settings-test", [changed]);
    const state = slotOf("settings-test").state!;
    expect(projectSettingsFromConfig(state.config)).toEqual(settings);
    expect(state.budget.totalTokens).toBe(55_000_000);
    expect(state.autonomy).toBe(state.config.autonomy);
    expect(slotOf("settings-test").lastError).toBeNull();
  });
});

describe("replay overlap", () => {
  beforeEach(() => {
    useStore.setState({ projects: {}, collapse: {}, toasts: [] });
  });

  it("drops a full re-send of an already applied batch", () => {
    fold("dup", [HAPPY]);
    const before = slotOf("dup").state;
    useStore.getState().applyEvents("dup", HAPPY);
    const after = slotOf("dup");
    // Nothing was applied, so the state object itself is untouched.
    expect(after.state).toBe(before);
    expect(after.events.length).toBe(HAPPY.length);
    expect(after.state?.seq).toBe(HAPPY.length);
  });

  it("drops only the overlapping prefix on a reconnect", () => {
    const head = HAPPY.slice(0, 30);
    const resumeWithOverlap = HAPPY.slice(10);
    fold("resume", [head, resumeWithOverlap]);

    fold("clean", [HAPPY]);
    expect(slotOf("resume").state).toEqual(slotOf("clean").state);
    // 30 applied, then 20 dropped as overlap and the remainder applied.
    expect(slotOf("resume").events.length).toBe(HAPPY.length);
    expect(slotOf("resume").events.map((e) => e.seq)).toEqual(HAPPY.map((e) => e.seq));
  });

  it("ignores an out-of-order stale event without touching the log", () => {
    fold("stale", [HAPPY]);
    const first = HAPPY[0];
    expect(first).toBeDefined();
    if (!first) return;
    useStore.getState().applyEvents("stale", [first]);
    expect(slotOf("stale").events.length).toBe(HAPPY.length);
    expect(slotOf("stale").state?.seq).toBe(HAPPY.length);
  });
});

describe("collapse policy", () => {
  beforeEach(() => {
    useStore.setState({ projects: {}, collapse: {}, toasts: [] });
  });

  const waves = ["W001", "W002", "W003", "W004", "W005"];

  it("collapses everything but the newest two", () => {
    expect(defaultCollapsed(waves)).toEqual(["W001", "W002", "W003"]);
    expect(defaultCollapsed(["W001"])).toEqual([]);
    expect(defaultCollapsed([])).toEqual([]);
  });

  it("keeps waves with a running task open", () => {
    expect(defaultCollapsed(waves, new Set(["W001"]))).toEqual(["W002", "W003"]);
  });

  it("derives the running set from task status", () => {
    fold("running", [HAPPY.slice(0, 20)]);
    const state = slotOf("running").state;
    expect(state).not.toBeNull();
    if (state === null) return;
    const running = runningWaveIds(state);
    for (const waveId of running) expect(state.waveOrder).toContain(waveId);
  });

  it("keeps user choices when no wave was added", () => {
    // The user expanded W001 and W002 by hand; nothing new arrived.
    expect(reconcileCollapse(["W003"], waves, waves)).toEqual(["W003"]);
    // Ids that no longer exist are dropped.
    expect(reconcileCollapse(["W001", "W009"], ["W001", "W002"], ["W001", "W002"])).toEqual([
      "W001",
    ]);
  });

  it("re-defaults only the waves the new wave displaced", () => {
    // Everything was expanded; W003 arrives, so W001 falls out of the window.
    expect(reconcileCollapse([], ["W001", "W002"], ["W001", "W002", "W003"])).toEqual(["W001"]);
    // An explicit collapse survives, and the displaced wave joins it in order.
    expect(reconcileCollapse(["W002"], ["W001", "W002"], ["W001", "W002", "W003"])).toEqual([
      "W001",
      "W002",
    ]);
    // A wave that is running is never auto-collapsed.
    expect(
      reconcileCollapse([], ["W001", "W002"], ["W001", "W002", "W003"], new Set(["W001"])),
    ).toEqual([]);
  });

  it("exposes the collapse set per slug", () => {
    expect(collapsedSet("a", { a: ["W001", "W002"] })).toEqual(new Set(["W001", "W002"]));
    expect(collapsedSet("b", { a: ["W001"] })).toEqual(new Set());
  });

  it("toggling a wave is idempotent in pairs", () => {
    const store = useStore.getState();
    store.setCollapsed("t", ["W001"]);
    store.toggleWave("t", "W002");
    expect(useStore.getState().collapse["t"]).toEqual(["W001", "W002"]);
    useStore.getState().toggleWave("t", "W002");
    expect(useStore.getState().collapse["t"]).toEqual(["W001"]);
  });
});
