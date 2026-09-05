import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  candidateLifecycle,
  deriveEvidenceGraph,
  deriveTrajectoryEvidenceGraph,
  factIsSettled,
  latestActiveCandidateId,
  type Graph,
  type ProjectState,
} from "@inventio/schema";
import { EVIDENCE_NODE_TYPES } from "../components/nodes";
import { useProjectSlug } from "../components/ProjectContext";
import { layoutEvidence } from "../lib/evidenceLayout";
import { layoutTrajectoryEvidence } from "../lib/trajectoryEvidenceLayout";
import { buildEdges, buildNodes, stabilizeNodes, type ExtraData } from "../lib/rfGraph";
import { lineageEdges } from "../lib/lineage";
import { candidateStageColor } from "../lib/visual";
import { useProjectState } from "../store/hooks";

/**
 * Evidence view (UI-SPEC §8): the claim/obligation/issue DAG for exactly one
 * frozen candidate version, chosen by `?version=` (default: latest of the
 * active lineage).
 */

const PRO_OPTIONS = { hideAttribution: true } as const;
const NO_HIGHLIGHTED_EDGES: ReadonlySet<string> = new Set<string>();

function TrajectoryEvidenceCanvas({ graph }: { graph: Graph }): JSX.Element {
  const [params, setParams] = useSearchParams();
  const sel = params.get("sel");
  const { setCenter } = useReactFlow();
  const cache = useRef<Map<string, Node>>(new Map());
  const [compact, setCompact] = useState(false);
  const [panning, setPanning] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => layoutTrajectoryEvidence(graph), [graph]);
  const nodes = useMemo(
    () => stabilizeNodes(cache.current, buildNodes(graph, layout, { selectedId: sel })),
    [graph, layout, sel],
  );
  const highlighted = useMemo(
    () => lineageEdges(graph, hovered ?? sel),
    [graph, hovered, sel],
  );
  const edges = useMemo(() => buildEdges(graph, { highlighted }), [graph, highlighted]);
  const boxes = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout],
  );
  const select = useCallback((nodeId: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("sel", nodeId);
      return next;
    }, { replace: false });
  }, [setParams]);
  const onMove = useCallback((_event: unknown, viewport: Viewport) => {
    setCompact(viewport.zoom < 0.5);
  }, []);
  return (
    <ReactFlow
      className={`research-map-flow${compact ? " is-compact" : ""}${panning ? " is-panning" : ""}`}
      nodes={nodes}
      edges={edges}
      nodeTypes={EVIDENCE_NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      zoomOnDoubleClick={false}
      minZoom={0.12}
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
  );
}

function TrajectoryEvidence({ state }: { state: ProjectState }): JSX.Element {
  const [params, setParams] = useSearchParams();
  const allTrajectories = params.get("scope") === "all";
  const showMilestones = params.get("milestones") !== "0";
  const showChecks = params.get("checks") === "1";
  const graph = useMemo(
    () =>
      deriveTrajectoryEvidenceGraph(state, {
        includeAllTrajectories: allTrajectories,
        includeMilestones: showMilestones,
        includeVerifications: showChecks,
      }),
    [state, allTrajectories, showMilestones, showChecks],
  );
  const activeClaims = state.claimOrder.filter((id) => {
    const status = state.claims[id]?.status;
    return status === "UNVERIFIED" || status === "NEEDS_REVISION";
  }).length;
  const settledFacts = state.factOrder.filter((id) => factIsSettled(state, id)).length;
  const activeFacts = state.factOrder.filter((id) => {
    const status = state.facts[id]?.status;
    return status === "ACTIVE" || status === "SUSPICIOUS";
  }).length;
  const unsettledFacts = activeFacts - settledFacts;
  const queued = state.verificationOrder.filter((id) => state.verifications[id]?.status === "queued").length;
  const visibleTrajectories = graph.nodes.filter((node) => node.type === "task").length;
  const setOption = useCallback(
    (key: "scope" | "milestones" | "checks", value: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value === null) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const projectionKey = `${allTrajectories ? "all" : "focused"}:${showMilestones ? "steps" : "no-steps"}:${showChecks ? "checks" : "summary"}`;
  return (
    <div className="evidence-view">
      <div className="evidence-toolbar trajectory-evidence-toolbar">
        <div className="research-map-summary">
          <div className="row wrap">
            <strong>Research map</strong>
            <span className="chip">{visibleTrajectories} visible trajector{visibleTrajectories === 1 ? "y" : "ies"}</span>
            <span className="chip ok">{settledFacts} settled fact{settledFacts === 1 ? "" : "s"}</span>
            {unsettledFacts > 0 ? <span className="chip warn">{unsettledFacts} unsettled</span> : null}
            <span className="chip">{activeClaims} open claim{activeClaims === 1 ? "" : "s"}</span>
            {queued > 0 ? <span className="chip warn">{queued} checks waiting</span> : null}
          </div>
          <p>
            Read left to right: independent trajectories → mathematical turning points → claims →
            independent checks → recorded facts. Select a result to trace its origins and
            dependents. Dashed links show premises and open conflicts; historical premises stay visible.
          </p>
        </div>
        <div className="research-map-controls" aria-label="Research map display">
          <div className="segmented" role="group" aria-label="Trajectory scope">
            <button
              type="button"
              className={`segment${allTrajectories ? "" : " on"}`}
              aria-pressed={!allTrajectories}
              onClick={() => setOption("scope", null)}
            >
              Current paths
            </button>
            <button
              type="button"
              className={`segment${allTrajectories ? " on" : ""}`}
              aria-pressed={allTrajectories}
              onClick={() => setOption("scope", "all")}
            >
              All trajectories
            </button>
          </div>
          <label className="map-check-option">
            <input
              type="checkbox"
              checked={showMilestones}
              onChange={(event) => setOption("milestones", event.target.checked ? null : "0")}
            />
            Turning points
          </label>
          <label className="map-check-option">
            <input
              type="checkbox"
              checked={showChecks}
              onChange={(event) => setOption("checks", event.target.checked ? "1" : null)}
            />
            Individual checks
          </label>
        </div>
      </div>
      <div className="canvas evidence-canvas">
        <ReactFlowProvider key={projectionKey}><TrajectoryEvidenceCanvas graph={graph} /></ReactFlowProvider>
      </div>
    </div>
  );
}

function evidenceExtras(state: ProjectState, candidateId: string): ExtraData {
  const candidate = state.candidates[candidateId];
  if (!candidate) return {};
  const burnDown = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  for (const issueId of candidate.issueIds) {
    const issue = state.issues[issueId];
    if (issue && issue.status === "open") burnDown[issue.severity] += 1;
  }
  const lineage = state.lineages[candidate.lineageId];
  return {
    [candidateId]: {
      large: true,
      burnDown,
      abandoned: lineage?.status === "abandoned",
    },
  };
}

function EvidenceCanvas({
  state,
  candidateId,
}: {
  state: ProjectState;
  candidateId: string;
}): JSX.Element {
  const [params, setParams] = useSearchParams();
  const sel = params.get("sel");
  const { setCenter } = useReactFlow();
  const cache = useRef<Map<string, Node>>(new Map());

  const graph = useMemo(() => deriveEvidenceGraph(state, candidateId), [state, candidateId]);
  const layout = useMemo(() => layoutEvidence(graph), [graph]);
  const extras = useMemo(() => evidenceExtras(state, candidateId), [state, candidateId]);

  const nodes = useMemo(
    () => stabilizeNodes(cache.current, buildNodes(graph, layout, { extras, selectedId: sel })),
    [graph, layout, extras, sel],
  );
  const edges = useMemo(() => buildEdges(graph), [graph]);

  const boxes = useMemo(() => {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const placed of layout.nodes) map.set(placed.id, placed);
    return map;
  }, [layout]);

  const select = useCallback(
    (nodeId: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("sel", nodeId);
          return next;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={EVIDENCE_NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      zoomOnDoubleClick={false}
      minZoom={0.15}
      maxZoom={1.6}
      fitView
      proOptions={PRO_OPTIONS}
      onNodeClick={(_event, node) => select(node.id)}
      onNodeDoubleClick={(_event, node) => {
        const box = boxes.get(node.id);
        if (!box) return;
        void setCenter(box.x + box.w / 2, box.y + box.h / 2, { zoom: 1, duration: 300 });
      }}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} />
    </ReactFlow>
  );
}

export default function EvidenceView(): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);
  const [params, setParams] = useSearchParams();

  const setVersion = useCallback(
    (candidateId: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("version", candidateId);
          next.delete("sel");
          return next;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  const activeVersions = useMemo(() => {
    if (state === null || state.activeLineageId === null) return [];
    return state.lineages[state.activeLineageId]?.versionIds ?? [];
  }, [state]);

  const abandonedVersions = useMemo(() => {
    if (state === null) return [] as { lineageId: string; title: string; ids: string[] }[];
    return Object.values(state.lineages)
      .filter((l) => l.status === "abandoned")
      .map((l) => ({ lineageId: l.id, title: l.title, ids: [...l.versionIds] }));
  }, [state]);

  if (state === null) {
    return (
      <div className="centered-state">
        <p className="muted">Loading project…</p>
      </div>
    );
  }

  if (state.config.workflow === "trajectories-v2") {
    return <TrajectoryEvidence state={state} />;
  }

  const requested = params.get("version");
  const known = requested !== null && state.candidates[requested] !== undefined;
  const candidateId = known ? requested : latestActiveCandidateId(state);

  if (candidateId === null || state.candidates[candidateId] === undefined) {
    return (
      <div className="centered-state">
        <p className="muted">No candidate frozen yet — the evidence graph appears at first freeze.</p>
      </div>
    );
  }

  const abandonedSelected = abandonedVersions.some((l) => l.ids.includes(candidateId));
  const lifecycle = candidateLifecycle(state, candidateId);

  return (
    <div className="evidence-view">
      <div className="evidence-toolbar">
        <div className="version-picker">
          <div className="segmented" role="group" aria-label="candidate version">
            {activeVersions.length === 0 ? (
              <span className="muted small">no active lineage</span>
            ) : (
              activeVersions.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`segment mono${id === candidateId ? " on" : ""}`}
                  onClick={() => setVersion(id)}
                >
                  {id}
                </button>
              ))
            )}
          </div>
          {abandonedVersions.length === 0 ? null : (
            <select
              className="select small"
              aria-label="show abandoned lineage"
              value={abandonedSelected ? candidateId : ""}
              onChange={(e) => {
                if (e.target.value !== "") setVersion(e.target.value);
              }}
            >
              <option value="">show abandoned…</option>
              {abandonedVersions.map((lineage) => (
                <optgroup key={lineage.lineageId} label={`${lineage.lineageId} · ${lineage.title}`}>
                  {lineage.ids.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
          {abandonedSelected ? <span className="badge muted-badge">abandoned lineage</span> : null}
        </div>
        <div className="evidence-status-banner">
          <div className="row wrap">
            <strong className="mono">{candidateId}</strong>
            <span
              className="chip"
              style={{
                color: candidateStageColor(lifecycle.stage),
                borderColor: candidateStageColor(lifecycle.stage),
              }}
            >
              {lifecycle.label}
            </span>
            {lifecycle.authorConclusion === null ? null : (
              <span className="small muted">source author claimed {lifecycle.authorConclusion}</span>
            )}
          </div>
          <p>{lifecycle.detail}</p>
          <p className="small muted">
            VERIFIED, NEEDS REVISION, FAILED, and REFUTED labels below apply only to the exact individual statement. A
            VERIFIED supporting claim does not mean this candidate passed review.
          </p>
        </div>
      </div>
      <div className="canvas evidence-canvas">
        <ReactFlowProvider>
          <EvidenceCanvas state={state} candidateId={candidateId} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
