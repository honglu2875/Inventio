import { describe, expect, it } from "vitest";
import { applyEvent, defaultTrajectoryConfig, EventSchema, factConcerns, factDisplayStatus, factIsSettled, initialState, replay } from "../src/index.js";

function record() {
  const state = initialState();
  const events: ReturnType<typeof EventSchema.parse>[] = [];
  const emit = (fields: Record<string, unknown>) => {
    const event = EventSchema.parse({ seq: state.seq + 1, ts: "test", ...fields });
    applyEvent(state, event);
    events.push(event);
  };
  emit({ type: "project.created", slug: "validity-test", title: "Validity", statement: "P", config: defaultTrajectoryConfig() });
  const claim = (id: string, dependsOn: string[] = []) => emit({ type: "claim.added", claimId: id, statement: id, status: "UNVERIFIED", provenance: "test", dependsOn });
  const fact = (id: string, claimId: string) => {
    emit({ type: "claim.status", claimId, from: "UNVERIFIED", to: "VERIFIED", justification: "Verified synthetic proof.", by: "conductor" });
    emit({ type: "fact.recorded", factId: id, claimId, path: `facts/${id}.md` });
  };
  claim("K001"); fact("F001", "K001");
  claim("K002");
  claim("K003", ["F001"]); fact("F002", "K003");
  return { state, events, emit, claim, fact };
}

describe("settled mathematical premises", () => {
  it("preserves conflict evidence through a failed proof and transitive dependencies", () => {
    const { state, emit, events } = record();
    emit({ type: "claim.conflictRecorded", leftClaimId: "K002", rightClaimId: "K001", reason: "The same quantity is assigned incompatible values.", by: "summary_reader" });
    emit({ type: "claim.status", claimId: "K002", from: "UNVERIFIED", to: "NEEDS_REVISION", justification: "The TRR summand was not derived.", by: "conductor" });
    expect(factIsSettled(state, "F001")).toBe(false);
    expect(factDisplayStatus(state, "F001")).toBe("UNSETTLED");
    expect(factConcerns(state, "F002").join(" ")).toContain("uses F001");
    expect(state.facts.F001!.status).toBe("ACTIVE");
    expect(replay(initialState(), events)).toEqual(state);
    emit({ type: "claim.conflictResolved", leftClaimId: "K002", rightClaimId: "K001", reason: "The owner reconciled the conventions in the two calculations.", by: "human" });
    expect(factIsSettled(state, "F002")).toBe(true);
    expect(replay(initialState(), events)).toEqual(state);
  });

  it("does not block an independent proof because unrelated claims conflict", () => {
    const { state, emit, claim } = record();
    claim("K004");
    emit({ type: "claim.conflictRecorded", leftClaimId: "K002", rightClaimId: "K004", reason: "Incompatible boundary values.", by: "summary_reader" });
    expect(factIsSettled(state, "F001")).toBe(true);
    expect(factIsSettled(state, "F002")).toBe(true);
  });

  it("follows identical statements but retains distinct proof records", () => {
    const { state, emit, claim } = record();
    claim("K004");
    emit({ type: "claim.equivalent", leftClaimId: "K001", rightClaimId: "K004", reason: "Identical hypotheses and conclusion.", by: "summary_reader" });
    emit({ type: "claim.conflictRecorded", leftClaimId: "K004", rightClaimId: "K002", reason: "Opposing formula.", by: "summary_reader" });
    expect(factIsSettled(state, "F001")).toBe(false);
    expect(factConcerns(state, "F002").join(" ")).toContain("K004");
  });

  it("does not allow missing, circular or retracted premises to become settled", () => {
    const { state, claim, fact } = record();
    claim("K004", ["F999"]); fact("F003", "K004");
    expect(factConcerns(state, "F003").join(" ")).toContain("missing");
    state.claims.K001!.dependsOn = ["F002"];
    expect(factConcerns(state, "F002").join(" ")).toContain("Circular");
    state.claims.K001!.dependsOn = [];
    state.facts.F001!.status = "RETRACTED";
    expect(factIsSettled(state, "F002")).toBe(false);
    state.facts.F001!.status = "SUPERSEDED";
    state.facts.F001!.supersededByFactId = "F004";
    claim("K005"); fact("F004", "K005");
    expect(factIsSettled(state, "F002")).toBe(true);
  });

  it("rejects unknown, duplicate, self, and already resolved conflict mutations", () => {
    const { emit } = record();
    const conflict = { type: "claim.conflictRecorded", leftClaimId: "K001", rightClaimId: "K002", reason: "Incompatible conclusions.", by: "human" };
    expect(() => emit({ ...conflict, rightClaimId: "K999" })).toThrow();
    expect(() => emit({ ...conflict, rightClaimId: "K001" })).toThrow();
    emit(conflict);
    expect(() => emit({ ...conflict, leftClaimId: "K002", rightClaimId: "K001" })).toThrow();
    emit({ ...conflict, type: "claim.conflictResolved" });
    expect(() => emit({ ...conflict, type: "claim.conflictResolved" })).toThrow();
  });
});
