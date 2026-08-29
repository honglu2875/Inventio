import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from "@xyflow/react";
import {
  candidateLifecycle,
  deriveEvidenceGraph,
  deriveTrajectoryEvidenceGraph,
  latestActiveCandidateId,
  type ProjectState,
} from "@inventio/schema";
import { EVIDENCE_NODE_TYPES } from "../components/nodes";
import { useProjectSlug } from "../components/ProjectContext";
import { layoutEvidence } from "../lib/evidenceLayout";
import { layoutTrajectoryEvidence } from "../lib/trajectoryEvidenceLayout";
import { buildEdges, buildNodes, stabilizeNodes, type ExtraData } from "../lib/rfGraph";
import { candidateStageColor } from "../lib/visual";
import { useProjectState } from "../store/hooks";

/**
 * Evidence view (UI-SPEC §8): the claim/obligation/issue DAG for exactly one
 * frozen candidate version, chosen by `?version=` (default: latest of the
 * active lineage).
 */

const PRO_OPTIONS = { hideAttribution: true } as const;

function TrajectoryEvidenceCanvas({ state }: { state: ProjectState }): JSX.Element {
  const [params, setParams] = useSearchParams();
  const sel = params.get("sel");
  const { setCenter } = useReactFlow();
  const cache = useRef<Map<string, Node>>(new Map());
  const graph = useMemo(() => deriveTrajectoryEvidenceGraph(state), [state]);
  const layout = useMemo(() => layoutTrajectoryEvidence(graph), [graph]);
  const nodes = useMemo(
    () => stabilizeNodes(cache.current, buildNodes(graph, layout, { selectedId: sel })),
    [graph, layout, sel],
  );
  const edges = useMemo(() => buildEdges(graph), [graph]);
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
  return (
    <ReactFlow
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

function TrajectoryEvidence({ state }: { state: ProjectState }): JSX.Element {
  const activeClaims = state.claimOrder.filter((id) => state.claims[id]?.status === "UNVERIFIED").length;
  const activeFacts = state.factOrder.filter((id) => {
    const status = state.facts[id]?.status;
    return status === "ACTIVE" || status === "SUSPICIOUS";
  }).length;
  const queued = state.verificationOrder.filter((id) => state.verifications[id]?.status === "queued").length;
  return (
    <div className="evidence-view">
      <div className="evidence-toolbar trajectory-evidence-toolbar">
        <div className="evidence-status-banner">
          <div className="row wrap">
            <strong>Current mathematical evidence</strong>
            <span className="chip ok">{activeFacts} fact{activeFacts === 1 ? "" : "s"}</span>
            <span className="chip">{activeClaims} claim{activeClaims === 1 ? "" : "s"} being checked</span>
            {queued > 0 ? <span className="chip warn">{queued} checks waiting</span> : null}
          </div>
          <p>
            The graph follows each active claim through its independent checks to an established
            fact. Failed and duplicate claims remain inspectable in the Library without crowding
            this working view.
          </p>
        </div>
      </div>
      <div className="canvas evidence-canvas">
        <ReactFlowProvider><TrajectoryEvidenceCanvas state={state} /></ReactFlowProvider>
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
            VERIFIED and REFUTED labels below apply only to the exact individual statement. A
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
