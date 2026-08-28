/**
 * Node-id classification and the `/p/:slug/node/:nodeId` resolver (UI-SPEC §4).
 *
 * Pure and DOM-free so it can be unit tested without a router:
 *   waves / tasks / candidates / reviews / questions → OpsView   (`?sel=`)
 *   claims / issues / obligations                    → Evidence  (`?sel=`)
 *   cards / artifacts / computations                 → Library
 */

export type NodeKind =
  | "problem"
  | "wave"
  | "task"
  | "resolution"
  | "lineage"
  | "candidate"
  | "obligation"
  | "review"
  | "question"
  | "claim"
  | "fact"
  | "verification"
  | "milestone"
  | "issue"
  | "card"
  | "artifact"
  | "computation"
  | "memory"
  | "final"
  | "unknown";

/** Obligation ids are minted by deriveEvidenceGraph as `C001.v1:ob3`. */
const OBLIGATION_RE = /^C\d{3}\.v\d+:ob\d+$/;
const CANDIDATE_RE = /^C\d{3}\.v\d+$/;
const RESOLUTION_RE = /^W\d{3}:resolution$/;

export function classifyNodeId(id: string): NodeKind {
  if (id === "problem") return "problem";
  if (id === "memory") return "memory";
  if (id === "final") return "final";
  if (OBLIGATION_RE.test(id)) return "obligation";
  if (CANDIDATE_RE.test(id)) return "candidate";
  if (RESOLUTION_RE.test(id)) return "resolution";
  if (/^W\d{3}$/.test(id)) return "wave";
  if (/^T\d{3}$/.test(id)) return "task";
  if (/^C\d{3}$/.test(id)) return "lineage";
  if (/^R\d{3}$/.test(id)) return "review";
  if (/^Q\d{3}$/.test(id)) return "question";
  if (/^MS\d{3}$/.test(id)) return "milestone";
  if (/^K\d{3}$/.test(id)) return "claim";
  if (/^F\d{3}$/.test(id)) return "fact";
  if (/^V\d{3}$/.test(id)) return "verification";
  if (/^I\d{3}$/.test(id)) return "issue";
  if (/^M\d{3}$/.test(id)) return "card";
  if (/^X\d{3}$/.test(id)) return "computation";
  if (/^[AE]\d{3}$/.test(id)) return "artifact";
  return "unknown";
}

export type ViewName = "ops" | "evidence" | "library";

export interface ResolvedTarget {
  view: ViewName;
  /** Path without the query string. */
  path: string;
  /** Full location including `?sel=` / library deep-link params. */
  to: string;
  kind: NodeKind;
}

/** Which of the three canvases owns a node id. */
export function viewForNodeId(id: string): ViewName {
  switch (classifyNodeId(id)) {
    case "claim":
    case "fact":
    case "verification":
    case "issue":
    case "obligation":
      return "evidence";
    case "card":
    case "artifact":
    case "computation":
    case "memory":
      return "library";
    default:
      return "ops";
  }
}

const LIBRARY_SECTION: Partial<Record<NodeKind, string>> = {
  card: "memory",
  memory: "memory",
  computation: "computations",
  artifact: "attempts",
};

/**
 * Resolve a deep link. `artifactKind` disambiguates artifact ids into the
 * right library section when the caller knows it (A → attempts, E →
 * explorations, R → reviews); the default is derived from the id prefix.
 */
export function resolveNodeRoute(
  slug: string,
  nodeId: string,
  artifactSection?: string,
): ResolvedTarget {
  const kind = classifyNodeId(nodeId);
  const view = viewForNodeId(nodeId);
  const sel = encodeURIComponent(nodeId);
  if (view === "library") {
    const section = artifactSection ?? LIBRARY_SECTION[kind] ?? "problem";
    const path = `/p/${slug}/library/${section}/${encodeURIComponent(nodeId)}`;
    return { view, path, to: path, kind };
  }
  if (view === "evidence") {
    const path = `/p/${slug}/evidence`;
    return { view, path, to: `${path}?sel=${sel}`, kind };
  }
  const path = `/p/${slug}`;
  return { view, path, to: `${path}?sel=${sel}`, kind };
}

/** Permalink for the "copy link" button in the inspector header. */
export function permalinkFor(slug: string, nodeId: string): string {
  return `/p/${slug}/node/${encodeURIComponent(nodeId)}`;
}
