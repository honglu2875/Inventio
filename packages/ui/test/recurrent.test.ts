import { describe, expect, it } from "vitest";
import { applyResearchChange, defaultRecurrentConfig, deriveResearchGraph, initialState, type FrozenResult } from "@inventio/schema";
import { layoutResearch } from "../src/lib/researchLayout";
import { buildNodes } from "../src/lib/rfGraph";
import { lineageEdges } from "../src/lib/lineage";

function fixture() {
  const state = initialState(); state.config = defaultRecurrentConfig();
  const s = state.research; const model = state.config.researchModels!.research;
  applyResearchChange(s, { kind: "round.opened", id: "W001", number: 1, briefMarkdown: "Original question", researchModel: model, supportModel: model });
  applyResearchChange(s, { kind: "session.opened", id: "S001", roundId: "W001", role: "solver", model });
  const first: FrozenResult = { id: "B001.v1", resultId: "B001", version: 1, parentVersionId: null, sessionId: "S001", roundId: "W001", kind: "CALCULATION", title: "Boundary contribution", statement: "D = 10/3", proofMarkdown: "Alleged derivation", hash: "a".repeat(64), dependencies: [], sourceIds: [], attachments: [], relationToGoal: "PARTIAL" };
  applyResearchChange(s, { kind: "result.recorded", result: first });
  applyResearchChange(s, { kind: "result.recorded", result: { ...first, id: "B002.v1", resultId: "B002", dependencies: [first.id], title: "Dependent theorem" } });
  applyResearchChange(s, { kind: "note.recorded", id: "N001", sessionId: "S001", roundId: "W001", name: "notes/derivation.md", markdown: "Full notes", hash: "b".repeat(64) });
  return state;
}
describe("recurrent graph", () => {
  it("uses exact dependency edges and preserves selected result ancestry without unrelated notes", () => {
    const graph = deriveResearchGraph(fixture(), { notes: true });
    expect(graph.edges.find(e => e.type === "depends-on")).toMatchObject({ source: "B002.v1", target: "B001.v1" });
    const selected = lineageEdges(graph, "B002.v1");
    expect(selected.has("premise:B002.v1:B001.v1")).toBe(true);
    expect(selected.has("note:N001")).toBe(false);
    expect(graph.nodes.find(n => n.id === "B001.v1")?.data).toMatchObject({ contentKind: "CALCULATION", status: "UNCHECKED", relationToGoal: "PARTIAL" });
  });
  it("keeps positions and card sizes stable when detail nodes are hidden", () => {
    const state = fixture();
    const full = deriveResearchGraph(state, { notes: true, checks: true });
    const layout = layoutResearch(full);
    const all = buildNodes(full, layout);
    const reduced = buildNodes(deriveResearchGraph(state, { notes: false, checks: false }), layout);
    for (const node of reduced) expect(node.position).toEqual(all.find(n => n.id === node.id)?.position);
    expect(reduced.find(n => n.id === "B001.v1")?.height).toBeGreaterThanOrEqual(138);
    expect(reduced.some(n => n.id === "N001")).toBe(false);
  });
});
