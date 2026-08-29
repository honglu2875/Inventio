import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { Graph, GraphEdge } from "@inventio/schema";
import type { LayoutResult } from "./layout";
import { RF_TYPE_OF } from "../components/nodes";
import { deepEqual } from "./dataread";

/**
 * Graph + layout → React Flow elements (UI-SPEC §5, §8).
 *
 * Positions and sizes come ONLY from the layout engines. Expanded waves are
 * group nodes: children carry `parentId`, relative positions and
 * `extent: "parent"`, and the layout already emits parents before children.
 */

export type ExtraData = Record<string, Record<string, unknown>>;

export interface BuildNodesOptions {
  /** Per-node data merged over the derived graph data (roster, previews, …). */
  extras?: ExtraData;
  selectedId?: string | null;
  /** CSS position transition; disabled while panning. */
  animate?: boolean;
}

export function buildNodes(
  graph: Graph,
  layout: LayoutResult,
  options: BuildNodesOptions = {},
): Node[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const extras = options.extras ?? {};
  const nodes: Node[] = [];
  for (const placed of layout.nodes) {
    const graphNode = byId.get(placed.id);
    if (!graphNode) continue;
    const type = RF_TYPE_OF[graphNode.type];
    if (type === undefined) continue;
    const data: Record<string, unknown> = {
      ...graphNode.data,
      label: graphNode.label,
      ...(extras[placed.id] ?? {}),
    };
    nodes.push({
      id: placed.id,
      type,
      position: { x: placed.x, y: placed.y },
      width: placed.w,
      height: placed.h,
      data,
      selected: options.selectedId === placed.id,
      draggable: false,
      selectable: true,
      style: options.animate === false ? {} : { transition: "transform 200ms ease" },
      ...(placed.parentId === undefined
        ? {}
        : { parentId: placed.parentId, extent: "parent" as const }),
      ...(placed.hidden === true ? { hidden: true } : {}),
    });
  }
  return nodes;
}

const EDGE_BASE = { stroke: "var(--border)", strokeWidth: 1.5 };

function edgeStyle(edge: GraphEdge): {
  style: Record<string, string | number>;
  marker: boolean;
  markerColor: string;
  label?: string;
} {
  switch (edge.type) {
    case "sequence":
      return { style: { ...EDGE_BASE, strokeWidth: 2 }, marker: true, markerColor: "var(--border)" };
    case "frozen-from":
      return {
        style: { ...EDGE_BASE, stroke: "var(--seal)", strokeDasharray: "5 4" },
        marker: false,
        markerColor: "var(--seal)",
      };
    case "reviews": {
      const color = edge.label === "PASS" ? "var(--ok)" : "var(--danger)";
      return {
        style: { ...EDGE_BASE, stroke: color },
        marker: true,
        markerColor: color,
        ...(edge.label === undefined ? {} : { label: edge.label }),
      };
    }
    case "verifies": {
      const color = edge.label === "PASS" ? "var(--ok)" : edge.label === "FAIL" ? "var(--danger)" : "var(--muted)";
      return {
        style: { ...EDGE_BASE, stroke: color },
        marker: true,
        markerColor: color,
        ...(edge.label === undefined ? {} : { label: edge.label }),
      };
    }
    case "promotes":
      return {
        style: { ...EDGE_BASE, stroke: "var(--ok)", strokeWidth: 2 },
        marker: true,
        markerColor: "var(--ok)",
        ...(edge.label === undefined ? {} : { label: edge.label }),
      };
    case "equivalent":
      return {
        style: { ...EDGE_BASE, strokeDasharray: "4 4" },
        marker: false,
        markerColor: "var(--border)",
        ...(edge.label === undefined ? {} : { label: edge.label }),
      };
    case "relation":
      return {
        style: { ...EDGE_BASE },
        marker: true,
        markerColor: "var(--border)",
        ...(edge.label === undefined ? {} : { label: edge.label }),
      };
    case "revision":
      return {
        style: { ...EDGE_BASE, stroke: "var(--accent)" },
        marker: true,
        markerColor: "var(--accent)",
      };
    case "uses":
      return { style: { ...EDGE_BASE }, marker: false, markerColor: "var(--border)" };
    case "depends-on":
      return {
        style: { ...EDGE_BASE, strokeDasharray: "4 4" },
        marker: false,
        markerColor: "var(--border)",
      };
    case "attacks": {
      const severity = typeof edge.label === "string" ? edge.label : "";
      const color =
        severity === "CRITICAL"
          ? "var(--danger)"
          : severity === "MAJOR"
            ? "var(--warn)"
            : "var(--muted)";
      return { style: { ...EDGE_BASE, stroke: color }, marker: true, markerColor: color };
    }
    default:
      return { style: { ...EDGE_BASE }, marker: false, markerColor: "var(--border)" };
  }
}

export interface BuildEdgesOptions {
  /** Nodes hidden by a collapsed wave — their edges hide with them. */
  hidden?: ReadonlySet<string>;
  /** Highlighted (hover) edge ids get full opacity. */
  highlighted?: ReadonlySet<string>;
}

export function buildEdges(graph: Graph, options: BuildEdgesOptions = {}): Edge[] {
  const hidden = options.hidden ?? new Set<string>();
  const highlighted = options.highlighted ?? new Set<string>();
  const present = new Set(graph.nodes.map((n) => n.id));
  const edges: Edge[] = [];
  for (const edge of graph.edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    const { style, marker, markerColor, label } = edgeStyle(edge);
    const isHidden = hidden.has(edge.source) || hidden.has(edge.target);
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      style: { ...style, opacity: highlighted.has(edge.id) ? 1 : 0.75 },
      interactionWidth: 6,
      focusable: false,
      selectable: false,
      ...(highlighted.has(edge.id) ? { className: "edge-highlight" } : {}),
      ...(label === undefined ? {} : { label, labelStyle: { fontSize: 10 } }),
      ...(marker
        ? {
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 12,
              height: 12,
              color: markerColor,
            },
          }
        : {}),
      ...(isHidden ? { hidden: true } : {}),
    });
  }
  return edges;
}

/**
 * Reuse the previous node object whenever nothing observable changed, so React
 * Flow does not re-render nodes whose data is identical (UI-SPEC §13).
 */
export function stabilizeNodes(cache: Map<string, Node>, next: Node[]): Node[] {
  const out: Node[] = [];
  const live = new Set<string>();
  for (const node of next) {
    live.add(node.id);
    const prev = cache.get(node.id);
    if (
      prev &&
      prev.type === node.type &&
      prev.position.x === node.position.x &&
      prev.position.y === node.position.y &&
      prev.width === node.width &&
      prev.height === node.height &&
      prev.hidden === node.hidden &&
      prev.selected === node.selected &&
      prev.parentId === node.parentId &&
      deepEqual(prev.data, node.data)
    ) {
      out.push(prev);
      continue;
    }
    // Keep the data object itself stable when only the wrapper changed.
    const merged = prev && deepEqual(prev.data, node.data) ? { ...node, data: prev.data } : node;
    cache.set(node.id, merged);
    out.push(merged);
  }
  for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
  return out;
}

/** Ids hidden by the layout (children of collapsed waves). */
export function hiddenIds(layout: LayoutResult): Set<string> {
  const out = new Set<string>();
  for (const placed of layout.nodes) if (placed.hidden === true) out.add(placed.id);
  return out;
}
