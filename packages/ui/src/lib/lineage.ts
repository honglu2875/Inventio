import type { Graph, GraphEdge } from "@inventio/schema";

/** Follow ancestors and descendants separately: a shared origin is not a
 * reason to highlight every sibling result. Dependencies point to premises
 * in the semantic graph, so reverse them for causal traversal. */
export function lineageEdges(graph: Graph, selectedId: string | null): Set<string> {
  const highlighted = new Set<string>();
  if (selectedId === null) return highlighted;
  const related = new Set<string>();
  const parents = new Map<string, { id: string; edge: GraphEdge }[]>();
  const children = new Map<string, { id: string; edge: GraphEdge }[]>();
  for (const edge of graph.edges) {
    if (edge.type === "conflicts" || edge.type === "equivalent" || edge.type === "attacks") {
      continue;
    }
    const [source, target] = edge.type === "depends-on"
      ? [edge.target, edge.source] : [edge.source, edge.target];
    const downstream = children.get(source) ?? [];
    downstream.push({ id: target, edge });
    children.set(source, downstream);
    const upstream = parents.get(target) ?? [];
    upstream.push({ id: source, edge });
    parents.set(target, upstream);
  }
  for (const adjacency of [parents, children]) {
    const seen = new Set<string>();
    const pending = [selectedId];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      related.add(id);
      for (const next of adjacency.get(id) ?? []) {
        highlighted.add(next.edge.id);
        pending.push(next.id);
      }
    }
  }
  // Checks and disputes explain the evidence along the selected path, but
  // are not routes into the other author's unrelated descendants.
  for (const edge of graph.edges) {
    if ((edge.type === "verifies" && related.has(edge.source)) ||
        ((edge.type === "conflicts" || edge.type === "attacks" || edge.type === "equivalent") &&
          (related.has(edge.source) || related.has(edge.target)))) highlighted.add(edge.id);
  }
  return highlighted;
}
