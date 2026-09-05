import type { ProjectState } from "./state.js";
import type { Graph, GraphNode } from "./graph.js";
import { auditCoverage, resultStatus } from "./research.js";

/** Pure semantic lineage: exact versions, author responses, checks and audits. */
export function deriveResearchGraph(state: ProjectState, options: { checks?: boolean; notes?: boolean } = {}): Graph {
  const s = state.research;
  const nodes: GraphNode[] = [{ id: "problem", type: "problem", label: state.title, data: { confirmed: state.problem.confirmedMarkdown !== null, phase: state.phase } }];
  const edges: Graph["edges"] = [];
  const node = (id: string, label: string, data: Record<string, unknown>) => nodes.push({ id, type: "research", label, data });
  for (const id of s.roundOrder) {
    const round = s.rounds[id]!;
    const coverage = auditCoverage(s, id);
    node(id, `Round ${round.number}`, { subtype: "round", roundId: id, title: `Round ${round.number}`, status: round.status, statement: round.audit ? `Audit ${coverage.assessed}/${coverage.total} · ${coverage.complete ? "complete" : "incomplete"}` : "Strong audit starts in round two, or before decisive stopping." });
    edges.push({ id: `round:${id}`, source: round.number === 1 ? "problem" : s.roundOrder[round.number - 2]!, target: id, type: "sequence" });
    for (const sessionId of round.sessionIds) {
      const session = s.sessions[sessionId]!;
      if (session.role === "verifier" || session.role === "writer" || session.role === "editor") continue;
      const latest = session.turnIds.at(-1);
      node(sessionId, session.role, { subtype: "session", roundId: id, role: session.role, title: session.role === "auditor" ? "Independent memory audit" : session.role === "solver" ? "Solver" : "Explorer", status: latest ? s.turns[latest]!.status : "waiting", statement: `${session.turnIds.length} turn${session.turnIds.length === 1 ? "" : "s"} · ${session.model.model ?? "configured default"}` });
      edges.push({ id: `session:${sessionId}`, source: id, target: sessionId, type: "produced" });
    }
    if (round.editorial) {
      node(`${id}:summary`, `Round ${round.number} summary`, { subtype: "summary", roundId: id, title: `Round ${round.number} summary`, status: round.editorial.fallback ? "fallback" : "written", statement: "Readable exposition and the next-round brief" });
      edges.push({ id: `summary:${id}`, source: id, target: `${id}:summary`, type: "relation" });
      for (const ref of round.editorial.referencedVersions) edges.push({ id: `summary:${id}:${ref}`, source: ref, target: `${id}:summary`, type: "uses" });
    }
  }
  for (const id of s.versionOrder) {
    const v = s.versions[id]!;
    node(id, v.title, { subtype: "result", roundId: v.roundId, sessionId: v.sessionId, title: v.title, statement: v.statement, status: resultStatus(s, id), contentKind: v.kind, relationToGoal: v.relationToGoal });
    edges.push({ id: `authored:${id}`, source: v.sessionId, target: id, type: "produced" });
    for (const dependency of v.dependencies) edges.push({ id: `premise:${id}:${dependency}`, source: id, target: dependency, type: "depends-on" });
    if (v.parentVersionId) edges.push({ id: `revision:${id}`, source: v.parentVersionId, target: id, type: "revision", label: "revised" });
  }
  for (const response of s.responses) {
    node(response.id, response.response.action, { subtype: "response", roundId: response.roundId, title: `Author: ${response.response.action.toLowerCase()}`, status: response.response.action, statement: response.response.reasonMarkdown, versionId: response.response.versionId });
    edges.push({ id: `response:${response.id}`, source: response.response.versionId, target: response.id, type: "relation", label: "response" });
    if (response.replacementVersionId) edges.push({ id: `response-revision:${response.id}`, source: response.id, target: response.replacementVersionId, type: "revision" });
  }
  if (options.checks !== false) for (const assessment of s.assessments) {
    node(assessment.id, assessment.mode, { subtype: "assessment", roundId: assessment.roundId, title: assessment.mode === "audit" ? "Strong audit" : "Independent check", status: assessment.assessment.verdict, statement: assessment.assessment.reasonMarkdown, versionId: assessment.assessment.versionId });
    edges.push({ id: `assessment:${assessment.id}`, source: assessment.assessment.versionId, target: assessment.id, type: "verifies", label: assessment.assessment.verdict === "CONFIRM" ? "PASS" : assessment.assessment.verdict === "UNABLE" ? "UNABLE" : "objection" });
    if (assessment.mode === "audit") edges.push({ id: `auditor:${assessment.id}`, source: assessment.sessionId, target: assessment.id, type: "produced" });
    for (const response of s.responses.filter(r => r.response.objectionIds.includes(assessment.id))) edges.push({ id: `objection:${assessment.id}:${response.id}`, source: assessment.id, target: response.id, type: "relation", label: "answered" });
  }
  if (options.notes) for (const note of Object.values(s.notes)) {
    node(note.id, note.name, { subtype: "note", roundId: note.roundId, title: note.name, status: "NOTE", statement: note.markdown });
    edges.push({ id: `note:${note.id}`, source: note.sessionId, target: note.id, type: "produced" });
  }
  if (s.final?.writing) {
    node("final", "Final report", { subtype: "final", roundId: s.final.roundId, title: "Final report", status: s.final.result, statement: s.final.reason });
    for (const id of s.final.writing.referencedVersions) edges.push({ id: `final:${id}`, source: id, target: "final", type: "uses" });
  }
  return { nodes, edges };
}
