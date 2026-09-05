import { describe, expect, it } from "vitest";
import type { Graph, GraphEdge } from "@inventio/schema";
import { lineageEdges } from "../src/lib/lineage";

function graph(edges: [string, string, GraphEdge["type"]][]): Graph {
  return {
    nodes: [],
    edges: edges.map(([source, target, type]) => ({ id: `${source}:${target}`, source, target, type })),
  };
}

describe("selected result lineage", () => {
  it("traces premises and dependents without flooding sibling trajectories", () => {
    const g = graph([
      ["problem", "solver", "relation"], ["problem", "explorer", "relation"],
      ["solver", "claim", "produced"], ["solver", "sibling", "produced"],
      ["claim", "check-source", "verifies"], ["claim", "fact", "promotes"], ["later", "fact", "depends-on"],
      ["later", "later-fact", "promotes"], ["later", "check", "verifies"],
    ]);
    expect([...lineageEdges(g, "fact")].sort()).toEqual([
      "problem:solver", "solver:claim", "claim:fact", "claim:check-source", "later:fact", "later:later-fact", "later:check",
    ].sort());
    expect(lineageEdges(g, null).size).toBe(0);
  });

  it("shows direct disputes without treating them as derivations and terminates on cycles", () => {
    const g = graph([
      ["a", "b", "depends-on"], ["b", "a", "depends-on"],
      ["a", "objection", "conflicts"], ["objection", "unrelated", "produced"],
    ]);
    expect([...lineageEdges(g, "a")].sort()).toEqual(["a:b", "b:a", "a:objection"].sort());
  });
});
