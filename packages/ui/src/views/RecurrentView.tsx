import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { auditCoverage, deriveResearchGraph, resultMathematics, resultStatus, type ProjectState } from "@inventio/schema";
import Markdown from "../components/Markdown";
import { EVIDENCE_NODE_TYPES } from "../components/nodes";
import { researchStatusColor } from "../components/nodes/ResearchNode";
import { buildEdges, buildNodes } from "../lib/rfGraph";
import { lineageEdges } from "../lib/lineage";
import { layoutResearch } from "../lib/researchLayout";
import { isProjectExport } from "../lib/projectExport";

export function ResearchMarkdown({ markdown, select }: { markdown: string; select: (id: string) => void }): JSX.Element {
  const text = markdown.replace(/\(result:(B\d{3,}\.v\d+)\)/g, "(#research:$1)");
  const click = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (href?.startsWith("#research:")) { event.preventDefault(); select(href.slice(10)); }
  };
  return <div onClick={click}><Markdown>{text}</Markdown></div>;
}
function Canvas({ state, checks, notes, selected, select }: { state: ProjectState; checks: boolean; notes: boolean; selected: string | null; select: (id: string) => void }): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);
  const flow = useReactFlow();
  const autoFit = useRef(true);
  const graph = useMemo(() => deriveResearchGraph(state, { checks, notes }), [state, checks, notes]);
  const layout = useMemo(() => layoutResearch(deriveResearchGraph(state, { checks: true, notes: true })), [state]);
  const nodes = useMemo(() => buildNodes(graph, layout, { selectedId: selected }), [graph, layout, selected]);
  const edges = useMemo(() => buildEdges(graph, { highlighted: new Set([...lineageEdges(graph, selected), ...lineageEdges(graph, hovered)]) }), [graph, hovered, selected]);
  useEffect(() => {
    if (!autoFit.current) return;
    const timer = setTimeout(() => { if (autoFit.current) void flow.fitView({ padding: 0.15, maxZoom: 0.95 }); }, 300);
    return () => clearTimeout(timer);
  }, [nodes.length, flow]);
  return <ReactFlow onMoveStart={event => { if (event) autoFit.current = false; }} nodes={nodes} edges={edges} nodeTypes={EVIDENCE_NODE_TYPES} nodesDraggable={false} nodesConnectable={false} minZoom={0.12} maxZoom={1.6} fitView proOptions={{ hideAttribution: true }} onNodeClick={(_, node) => { autoFit.current = false; select(node.id); }} onNodeMouseEnter={(_, node) => setHovered(node.id)} onNodeMouseLeave={() => setHovered(null)}>
    <Background gap={24} /><Controls showInteractive={false} /><MiniMap pannable zoomable />
  </ReactFlow>;
}
export default function RecurrentView({ state, mode = "map" }: { state: ProjectState; mode?: "map" | "summary" | "library" }): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const checks = params.get("checks") !== "0";
  const notes = params.get("notes") === "1";
  const select = (id: string) => setParams(p => { const next = new URLSearchParams(p); next.set("sel", id); return next; });
  const s = state.research;
  const last = s.rounds[s.roundOrder.at(-1) ?? ""];
  const coverage = last ? auditCoverage(s, last.id) : null;
  if (mode === "summary") return <div className="recurrent-reading">
    {s.final?.writing ? <article><h2>Final report · {s.final.result}</h2><ResearchMarkdown markdown={s.final.writing.markdown} select={select} /></article> : null}
    {[...s.roundOrder].reverse().map(id => <article key={id}>
      <h2>Round {s.rounds[id]!.number}</h2>
      {s.rounds[id]!.editorial ? <><ResearchMarkdown markdown={s.rounds[id]!.editorial!.summaryMarkdown} select={select} /><details><summary>Next-round brief</summary><ResearchMarkdown markdown={s.rounds[id]!.editorial!.briefMarkdown} select={select} /></details></> : <p>The round is {s.rounds[id]!.status}; its summary follows the closing checks and audit.</p>}
    </article>)}
    {!s.roundOrder.length ? <p>The first round summary will appear after research and checking finish.</p> : null}
  </div>;
  if (mode === "library") {
    const entries = [...s.versionOrder.map(id => { const v = s.versions[id]!; return { id, title: v.title, kind: v.kind, status: resultStatus(s, id), text: `${v.statement}\n${v.proofMarkdown}` }; }), ...Object.values(s.notes).map(n => ({ id: n.id, title: n.name, kind: "NOTE", status: "UNCHECKED", text: n.markdown }))];
    const visible = entries.filter(e => `${e.id}\n${e.title}\n${e.text}`.toLowerCase().includes(query.toLowerCase()));
    return <div className="recurrent-reading"><h2>Mathematical library</h2><p>Every saved note and exact result version remains accessible, including drafts, corrections and withdrawn results.</p><input className="input" aria-label="Search mathematical library" placeholder="Search notes, statements and proofs" value={query} onChange={e => setQuery(e.target.value)} /><table className="table"><thead><tr><th>Document</th><th>Kind</th><th>Checking</th><th>Title</th></tr></thead><tbody>{visible.map(e => <tr key={e.id}><td><button className="button ghost mono" onClick={() => select(e.id)}>{e.id}</button></td><td>{e.kind}</td><td style={{ color: researchStatusColor(e.status) }}>{e.status}</td><td>{e.title}</td></tr>)}</tbody></table></div>;
  }
  return <div className="evidence-view">
    <div className="evidence-toolbar trajectory-evidence-toolbar"><div className="research-map-summary"><div className="row wrap"><strong>Research lineage</strong><span className="chip">{s.roundOrder.length} rounds</span><span className="chip">{s.versionOrder.length} result versions</span>{coverage && last?.audit ? <span className={`chip ${coverage.complete ? "ok" : "warn"}`}>Audit {coverage.assessed}/{coverage.total} · {coverage.complete ? "complete" : "incomplete"}</span> : null}{state.terminal ? <button className="button small" onClick={() => select("final")}>Final report · {state.terminal.result}</button> : null}</div><p>One Solver and Explorer per round. Select a result to trace its premises, original session, checks, responses and audits.</p></div><div className="research-map-controls"><label><input type="checkbox" checked={checks} onChange={e => setParams(p => { const n = new URLSearchParams(p); n.set("checks", e.target.checked ? "1" : "0"); return n; })} /> Checks and audits</label><label><input type="checkbox" checked={notes} onChange={e => setParams(p => { const n = new URLSearchParams(p); n.set("notes", e.target.checked ? "1" : "0"); return n; })} /> Saved notes</label></div></div>
    <ReactFlowProvider><Canvas state={state} checks={checks} notes={notes} selected={params.get("sel")} select={select} /></ReactFlowProvider>
  </div>;
}
export function ResearchInspector({ state, id, onClose }: { state: ProjectState; id: string; onClose: () => void }): JSX.Element {
  const [, setParams] = useSearchParams();
  const [execution, setExecution] = useState<string | null>(null);
  const [width, setWidth] = useState(440);
  const dragging = useRef(false);
  const requestGeneration = useRef(0);
  useEffect(() => { setExecution(null); requestGeneration.current++; }, [id]);
  useEffect(() => {
    const move = (event: globalThis.MouseEvent) => { if (dragging.current) setWidth(Math.min(720, Math.max(360, window.innerWidth - event.clientX))); };
    const up = () => { dragging.current = false; document.body.classList.remove("resizing"); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.classList.remove("resizing"); };
  }, []);
  const select = (id: string) => { setExecution(null); setParams(p => { const next = new URLSearchParams(p); next.set("sel", id); return next; }); };
  const s = state.research;
  const version = s.versions[id]; const note = s.notes[id]; const session = s.sessions[id]; const turn = s.turns[id];
  const assessment = s.assessments.find(a => a.id === id); const response = s.responses.find(r => r.id === id);
  const round = s.rounds[id.replace(":summary", "")];
  let markdown = version ? `${resultStatus(s, id)}\n\n${resultMathematics(version)}` : note ? note.markdown : assessment ? `${assessment.mode.toUpperCase()}: ${assessment.assessment.verdict}\n\n${assessment.assessment.reasonMarkdown}\n\n${assessment.evidenceIssues.join("\n\n")}` : response ? `${response.response.action}\n\n${response.response.reasonMarkdown}` : round ? round.editorial?.summaryMarkdown ?? `Round ${round.number} is ${round.status}.` : id === "final" ? s.final?.writing?.markdown ?? "The final report has not been written." : "";
  if (session) markdown = `# ${session.role}\n\nModel: ${session.model.model ?? "configured default"}; reasoning: ${session.model.effort}.\n\n${session.turnIds.length} preserved turns. Research and repair share this originating conversation.`;
  if (turn) markdown = `# ${turn.purpose}\n\nStatus: ${turn.status}.\n\nCharged tokens: ${turn.completed?.chargedTokens ?? turn.estimatedTokens} (${turn.completed?.usage ? "reported usage plus any estimated interruptions" : "estimate"}).\n\n${turn.completed?.usage ? `Uncached input: ${Math.max(0, turn.completed.usage.input_tokens - turn.completed.usage.cached_input_tokens)}; cache reads: ${turn.completed.usage.cached_input_tokens}; output: ${turn.completed.usage.output_tokens}.` : "Exact usage unavailable."}\n\nElapsed: ${turn.completed?.elapsedMs ?? "in progress"} ms.\n\n${turn.completed?.error ?? ""}`;
  const links = [...(version ? [version.sessionId, ...version.dependencies, ...(version.parentVersionId ? [version.parentVersionId] : [])] : []), ...(session?.turnIds ?? []), ...(turn ? [turn.sessionId, ...turn.targets.map(t => t.versionId)] : []), ...(assessment ? [assessment.assessment.versionId, assessment.turnId] : []), ...(response ? [response.response.versionId, response.turnId, ...(response.replacementVersionId ? [response.replacementVersionId] : [])] : [])];
  return <aside className="inspector" style={{ width }} aria-label={`inspector for ${id}`}><div className="inspector-resize" role="separator" aria-orientation="vertical" aria-label="resize inspector" onMouseDown={() => { dragging.current = true; document.body.classList.add("resizing"); }} /><header className="inspector-head"><strong className="mono">{id}</strong><button className="icon-button" onClick={onClose} aria-label="close inspector">✕</button></header><div className="inspector-body"><div className="row wrap">{links.map(ref => <button key={ref} className="button ghost small mono" onClick={() => select(ref)}>{ref}</button>)}</div><ResearchMarkdown markdown={markdown} select={select} />{turn && !isProjectExport() ? <button className="button" onClick={() => { const generation = ++requestGeneration.current; void fetch(`/api/projects/${encodeURIComponent(state.slug)}/research/turns/${encodeURIComponent(id)}`).then(async r => { if (!r.ok) throw new Error(`Execution record unavailable (${r.status})`); return await r.json(); }).then(value => { if (generation === requestGeneration.current) setExecution(JSON.stringify(value, null, 2)); }).catch(error => { if (generation === requestGeneration.current) setExecution(String(error)); }); }}>Open execution record</button> : null}{execution ? <pre className="research-execution">{execution}</pre> : null}</div></aside>;
}
