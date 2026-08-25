import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Viewport,
} from "@xyflow/react";
import {
  deriveOpsGraph,
  usageSpend,
  type ProjectState,
  type TaskState,
  type TaskStatus,
  type WorkerRole,
} from "@inventio/schema";
import { OPS_NODE_TYPES } from "../components/nodes";
import { useProjectSlug } from "../components/ProjectContext";
import { layoutOps } from "../lib/layout";
import { buildEdges, buildNodes, hiddenIds, stabilizeNodes, type ExtraData } from "../lib/rfGraph";
import { useProjectState } from "../store/hooks";
import { useStore } from "../store/store";
import IntakeConfirm from "./IntakeConfirm";

/**
 * Ops view (UI-SPEC §5). React Flow is pan/zoom/selection only: every position
 * comes from `layoutOps`, so a live update never moves an unrelated node.
 */

const EMPTY_IDS: string[] = [];
const NO_EDGES: ReadonlySet<string> = new Set<string>();
const PRO_OPTIONS = { hideAttribution: true } as const;

/** The §6.5 spend metric, per task: real usage once reported, estimate before. */
function taskSpend(task: TaskState): number {
  return task.usage ? usageSpend(task.usage) : task.estimatedTokens;
}

interface RosterGlyph {
  taskId: string;
  role: WorkerRole;
  status: TaskStatus;
}

/**
 * Node data the derived graph does not carry: the collapse flag and roster for
 * waves, method tag / spend / live preview for tasks, lineage status for
 * candidates. Everything else already comes from `deriveOpsGraph`.
 */
function opsExtras(state: ProjectState, collapsed: ReadonlySet<string>): ExtraData {
  const extras: ExtraData = {};

  for (const waveId of state.waveOrder) {
    const wave = state.waves[waveId];
    if (!wave) continue;
    const roster: RosterGlyph[] = [];
    for (const taskId of wave.taskIds) {
      const task = state.tasks[taskId];
      if (!task) continue;
      roster.push({ taskId, role: task.role, status: task.status });
    }
    extras[waveId] = { collapsed: collapsed.has(waveId), roster };
  }

  for (const task of Object.values(state.tasks)) {
    extras[task.id] = {
      methodTag: task.methodTag,
      spend: taskSpend(task),
      lastItemPreview: task.lastItem?.preview ?? "",
    };
  }

  for (const candidate of Object.values(state.candidates)) {
    const lineage = state.lineages[candidate.lineageId];
    extras[candidate.id] = { abandoned: lineage?.status === "abandoned" };
  }

  return extras;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function OpsCanvas({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const sel = params.get("sel");
  const collapse = useStore((s) => s.collapse[slug]) ?? EMPTY_IDS;
  const { setCenter } = useReactFlow();

  const [compact, setCompact] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const cache = useRef<Map<string, Node>>(new Map());
  const lastCenteredSelection = useRef<string | null>(null);

  const graph = useMemo(() => deriveOpsGraph(state), [state]);
  const collapsedSet = useMemo(() => new Set(collapse), [collapse]);
  const layout = useMemo(() => layoutOps(graph, collapsedSet), [graph, collapsedSet]);
  const extras = useMemo(() => opsExtras(state, collapsedSet), [state, collapsedSet]);

  const nodes = useMemo(
    () => stabilizeNodes(cache.current, buildNodes(graph, layout, { extras, selectedId: sel })),
    [graph, layout, extras, sel],
  );

  const hidden = useMemo(() => hiddenIds(layout), [layout]);
  const highlighted = useMemo(() => {
    if (hovered === null) return NO_EDGES;
    const ids = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.source === hovered || edge.target === hovered) ids.add(edge.id);
    }
    return ids;
  }, [graph, hovered]);
  const edges = useMemo(
    () => buildEdges(graph, { hidden, highlighted }),
    [graph, hidden, highlighted],
  );

  /** Children of expanded waves carry relative positions; centering needs absolute. */
  const boxes = useMemo(() => {
    const map = new Map<string, Box>();
    for (const placed of layout.nodes) {
      const parent = placed.parentId === undefined ? undefined : map.get(placed.parentId);
      map.set(placed.id, {
        x: placed.x + (parent?.x ?? 0),
        y: placed.y + (parent?.y ?? 0),
        w: placed.w,
        h: placed.h,
      });
    }
    return map;
  }, [layout]);

  const select = useCallback(
    (nodeId: string) => {
      // The memory hub is a shortcut into the Library, not an inspectable node (§5).
      if (nodeId === "memory") {
        const carried = new URLSearchParams(params);
        carried.delete("sel");
        const query = carried.toString();
        navigate(`/p/${slug}/library/memory${query === "" ? "" : `?${query}`}`);
        return;
      }
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sel", nodeId);
          return next;
        },
        { replace: false },
      );
    },
    [setParams, navigate, slug, params],
  );

  const onMove = useCallback((_event: unknown, viewport: Viewport) => {
    setCompact(viewport.zoom < 0.5);
  }, []);

  // Center a newly selected node once, after the inspector column has settled.
  // The selection guard is intentionally independent of viewport state so a
  // later pan or zoom can never snap back to this programmatic center.
  useEffect(() => {
    if (sel === null) {
      lastCenteredSelection.current = null;
      return;
    }
    if (lastCenteredSelection.current === sel) return;
    const box = boxes.get(sel);
    if (!box) return;
    lastCenteredSelection.current = sel;
    const timer = window.setTimeout(() => {
      void setCenter(box.x + box.w / 2, box.y + box.h / 2, { duration: 180 });
    }, 170);
    return () => window.clearTimeout(timer);
  }, [boxes, sel, setCenter]);

  return (
    <div className={`canvas ops-canvas${compact ? " is-compact" : ""}${panning ? " is-panning" : ""}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={OPS_NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnDoubleClick={false}
        minZoom={0.15}
        maxZoom={1.6}
        fitView
        proOptions={PRO_OPTIONS}
        onMove={onMove}
        onMoveStart={() => setPanning(true)}
        onMoveEnd={() => setPanning(false)}
        onNodeClick={(_event, node) => select(node.id)}
        onNodeDoubleClick={(_event, node) => {
          const box = boxes.get(node.id);
          if (!box) return;
          void setCenter(box.x + box.w / 2, box.y + box.h / 2, { zoom: 1, duration: 300 });
        }}
        onNodeMouseEnter={(_event, node) => setHovered(node.id)}
        onNodeMouseLeave={() => setHovered(null)}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
      </ReactFlow>
    </div>
  );
}

function Skeleton({ text }: { text: string }): JSX.Element {
  return (
    <div className="centered-state">
      <div className="skeleton-stack" aria-hidden="true">
        <span className="skeleton-bar w60" />
        <span className="skeleton-bar w90" />
        <span className="skeleton-bar w40" />
      </div>
      <p className="muted">{text}</p>
    </div>
  );
}

export default function OpsView(): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);

  if (state === null) return <Skeleton text="Loading project…" />;
  if (state.phase === "CREATED" || state.phase === "AWAITING_CONFIRMATION") {
    return <IntakeConfirm slug={slug} state={state} />;
  }
  if (state.phase === "INTAKE") return <Skeleton text="Research Manager is reading the submitted materials and drafting W000…" />;

  return (
    <ReactFlowProvider>
      <OpsCanvas slug={slug} state={state} />
    </ReactFlowProvider>
  );
}
