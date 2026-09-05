import { applyEvent, initialState, replay } from "@inventio/schema";
import { describe, expect, it } from "vitest";
import { buildCanonicalEvents } from "../../schema/test/fixtures.js";
import { evaluateAcceptance } from "../src/legacy/acceptance.js";

describe("candidate computation dependencies", () => {
  it("blocks a candidate only on computations from its own source task", () => {
    const events = buildCanonicalEvents();
    const state = replay(initialState(), events);
    let seq = state.seq;

    // X001 belongs to T002, while C001.v1 freezes A001 from T001.
    applyEvent(state, {
      seq: ++seq,
      ts: "test",
      type: "computation.reproduced",
      compId: "X001",
      match: false,
      outputHash: "different",
      exitCode: 0,
      stderr: "",
    });
    expect(evaluateAcceptance(state, "C001.v1").failing.join(" ")).not.toContain("computation X001");

    applyEvent(state, {
      seq: ++seq,
      ts: "test",
      type: "computation.recorded",
      compId: "X002",
      taskId: "T001",
      entry: "node scratch/check.mjs",
      inputsHash: "inputs",
      outputHash: "first",
      exitCode: 0,
      stderr: "",
    });
    applyEvent(state, {
      seq: ++seq,
      ts: "test",
      type: "computation.reproduced",
      compId: "X002",
      match: false,
      outputHash: "second",
      exitCode: 0,
      stderr: "",
    });
    expect(evaluateAcceptance(state, "C001.v1").failing.join(" ")).toContain(
      "computation X002 failed reproduction",
    );
  });
});
