import VerificationEvidence from "../components/VerificationEvidence";
import { factConcerns, factDisplayStatus } from "@inventio/schema";
import ClaimConflicts from "../components/ClaimConflicts";
import {
  candidateLifecycle,
  type ArtifactKind,
  type ArtifactMeta,
  type CandidateLifecycle,
  type ClaimState,
  type ClaimStatus,
  type ComputationState,
  type FactState,
  type ProjectState,
  type VerificationState,
} from "@inventio/schema";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import Markdown from "../components/Markdown";
import MathText from "../components/MathText";
import { useProjectSlug } from "../components/ProjectContext";
import {
  api,
  errorMessage,
  loadArtifact,
  projectSourceLink,
  type ArtifactBody,
} from "../lib/api";
import { formatExact } from "../lib/format";
import { isProjectExport } from "../lib/projectExport";
import { resolveNodeRoute } from "../lib/selection";
import {
  CARD_STATUS_COLOR,
  FACT_STATUS_COLOR,
  CLAIM_STATUS_COLOR,
  CLAIM_STATUS_GLYPH,
  candidateStageColor,
  claimStatusMeaning,
  conclusionColor,
  trajectoryClaimStatusLabel,
  verificationDisplayStatus,
} from "../lib/visual";
import { useActionGuard, useApiAction, useProjectState } from "../store/hooks";

/**
 * Library (UI-SPEC §10): the tree on the left, one content pane on the right.
 * Everything renders from the store; artifact bodies are fetched on demand and
 * cached by `recordedAtSeq` in `lib/api.ts`.
 */

type Section =
  | "problem"
  | "sources"
  | "candidate"
  | "attempts"
  | "explorations"
  | "reviews"
  | "facts"
  | "claims"
  | "failed-claims"
  | "writeups"
  | "verifications"
  | "memory"
  | "resolutions"
  | "computations"
  | "final";

const ARTIFACT_SECTIONS: Partial<Record<Section, ArtifactKind>> = {
  candidate: "candidate",
  attempts: "attempt",
  explorations: "exploration",
  reviews: "review",
  resolutions: "resolution",
  final: "final",
  writeups: "writeup",
};

/** Inverse of ARTIFACT_SECTIONS: which section owns an artifact of this kind. */
const SECTION_FOR_KIND: Record<ArtifactKind, Section> = {
  candidate: "candidate",
  attempt: "attempts",
  exploration: "explorations",
  review: "reviews",
  resolution: "resolutions",
  final: "final",
  writeup: "writeups",
  fact: "facts",
  verification: "verifications",
};

const SECTION_LABEL: Record<Section, string> = {
  problem: "Problem",
  sources: "Original materials",
  candidate: "Candidate",
  attempts: "Attempts",
  explorations: "Explorations",
  reviews: "Reviews",
  facts: "Facts",
  claims: "Claims being checked",
  "failed-claims": "Failed & duplicate claims",
  writeups: "Research write-ups",
  verifications: "Independent checks",
  memory: "Memory",
  resolutions: "Resolutions",
  computations: "Computations",
  final: "Reports",
};

const LEGACY_ORDER: Section[] = [
  "problem",
  "sources",
  "candidate",
  "attempts",
  "explorations",
  "reviews",
  "claims",
  "memory",
  "resolutions",
  "computations",
  "final",
];

const TRAJECTORY_ORDER: Section[] = [
  "problem",
  "sources",
  "facts",
  "claims",
  "failed-claims",
  "writeups",
  "verifications",
  "final",
];

const ALL_SECTIONS = [...new Set([...LEGACY_ORDER, ...TRAJECTORY_ORDER])];

function isSection(value: string | undefined): value is Section {
  return value !== undefined && (ALL_SECTIONS as string[]).includes(value);
}

function artifactsOf(state: ProjectState, kind: ArtifactKind): ArtifactMeta[] {
  return Object.values(state.artifacts)
    .filter((a) => a.kind === kind)
    .sort((a, b) => a.recordedAtSeq - b.recordedAtSeq);
}

function isSetAsideArtifact(state: ProjectState, artifact: ArtifactMeta): boolean {
  return artifact.taskId !== null && state.tasks[artifact.taskId]?.disposition === "set_aside";
}

function counts(state: ProjectState): Record<Section, number> {
  return {
    problem: 0,
    sources: state.problem.sources.length,
    candidate: artifactsOf(state, "candidate").length,
    attempts: artifactsOf(state, "attempt").filter((a) => !isSetAsideArtifact(state, a)).length,
    explorations: artifactsOf(state, "exploration").filter((a) => !isSetAsideArtifact(state, a)).length,
    reviews: artifactsOf(state, "review").length,
    facts: state.factOrder.filter((id) => {
      const status = state.facts[id]?.status;
      return status === "ACTIVE" || status === "SUSPICIOUS";
    }).length,
    claims: Object.values(state.claims).filter(
      (claim) =>
        state.config.workflow === "trajectories-v2"
          ? claim.status === "UNVERIFIED" || claim.status === "NEEDS_REVISION"
          : claim.status === "VERIFIED" || claim.status === "UNVERIFIED",
    ).length,
    "failed-claims": Object.values(state.claims).filter(
      (claim) =>
        claim.status === "FAILED" ||
        claim.status === "REFUTED" ||
        claim.status === "SUPERSEDED",
    ).length,
    writeups: artifactsOf(state, "writeup").length,
    verifications: state.verificationOrder.length,
    memory: Object.values(state.cards).filter(
      (entry) => entry.status === "PROPOSED" || entry.status === "VERIFIED",
    ).length,
    resolutions: artifactsOf(state, "resolution").length,
    computations: Object.keys(state.computations).length,
    final: artifactsOf(state, "final").length,
  };
}

/** Wave that produced an artifact, via its task. */
function waveOf(state: ProjectState, taskId: string | null): string {
  if (taskId === null) return "—";
  return state.tasks[taskId]?.waveId ?? "—";
}

function SourcesSection({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  if (state.problem.sources.length === 0) {
    return (
      <article className="library-detail">
        <h3>Original objective</h3>
        <pre className="statement-source">{state.statement}</pre>
        {state.contextMarkdown ? <><h3>Background and ideas</h3><pre className="statement-source">{state.contextMarkdown}</pre></> : null}
      </article>
    );
  }
  return (
    <div className="card-grid">
      {state.problem.sources.map((source) => {
        const uploadName = source.kind === "upload" ? source.relativePath.split("/").at(-1) : null;
        const upload = uploadName ? projectSourceLink(slug, uploadName) : null;
        const original = source.kind === "objective"
          ? state.statement
          : source.kind === "background"
            ? state.contextMarkdown
            : null;
        return (
          <details className="memory-card intake-library-source" key={source.id}>
            <summary>
              <span className="mono small">{source.id}</span>
              <strong>{source.title}</strong>
            </summary>
            <p className="memory-abstract"><strong>Abstract.</strong> {source.abstract}</p>
            {source.excerptMarkdown.trim() ? <Markdown>{source.excerptMarkdown}</Markdown> : null}
            {original !== null ? (
              <details><summary>Open verbatim text</summary><pre className="statement-source">{original}</pre></details>
            ) : uploadName && upload?.href ? (
              <a
                className="button ghost"
                href={upload.href}
                target="_blank"
                rel="noreferrer"
              >
                Open original file
              </a>
            ) : upload?.omittedReason ? (
              <p className="muted small">Original file omitted: {upload.omittedReason}</p>
            ) : null}
          </details>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ artifacts

/**
 * The graph node that "owns" an artifact: its producing task, or — for
 * task-less resolutions — the wave whose resolution it is.
 */
function graphNodeForArtifact(state: ProjectState, meta: ArtifactMeta): string {
  if (meta.kind === "candidate" && state.candidates[meta.id]) return meta.id;
  if (meta.taskId !== null) return meta.taskId;
  if (meta.kind === "resolution") {
    const wave = Object.values(state.waves).find((w) => w.resolutionPath === meta.path);
    if (wave) return `${wave.id}:resolution`;
  }
  if (meta.kind === "final") return "final";
  return meta.id;
}

function ArtifactDetail({
  slug,
  state,
  meta,
}: {
  slug: string;
  state: ProjectState;
  meta: ArtifactMeta;
}): JSX.Element {
  const [body, setBody] = useState<ArtifactBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBody(null);
    setError(null);
    void loadArtifact(slug, meta.id, meta.recordedAtSeq)
      .then((loaded) => {
        if (live) setBody(loaded);
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [slug, meta.id, meta.recordedAtSeq]);

  const graphTarget = resolveNodeRoute(slug, graphNodeForArtifact(state, meta));
  const lifecycle =
    meta.kind === "candidate" && state.candidates[meta.id]
      ? candidateLifecycle(state, meta.id)
      : null;

  return (
    <article className="library-detail">
      <header className="detail-head">
        <span className="mono detail-id">{meta.id}</span>
        <span className="chip">{meta.kind}</span>
        {lifecycle === null && meta.conclusion !== null ? (
          <span
            className="chip"
            style={{ color: conclusionColor(meta.conclusion), borderColor: conclusionColor(meta.conclusion) }}
          >
            {meta.conclusion}
          </span>
        ) : null}
        {lifecycle === null ? null : (
          <>
            <span
              className="chip"
              style={{
                color: candidateStageColor(lifecycle.stage),
                borderColor: candidateStageColor(lifecycle.stage),
              }}
              title={lifecycle.detail}
            >
              {lifecycle.label}
            </span>
            {lifecycle.authorConclusion === null ? null : (
              <span className="small muted">source author claimed {lifecycle.authorConclusion}</span>
            )}
          </>
        )}
        <span className="mono small muted">{meta.path}</span>
        {meta.kind !== "final" || state.terminal?.finalPath === meta.path ? (
          <Link className="button ghost small" to={graphTarget.to}>
            show in graph
          </Link>
        ) : null}
      </header>
      {lifecycle === null ? null : (
        <div className="candidate-lifecycle-summary">
          <strong>{meta.id} is not labelled by its author’s conclusion.</strong>
          <p>{lifecycle.detail}</p>
        </div>
      )}
      {error !== null ? (
        <div className="banner danger">{error}</div>
      ) : body === null ? (
        <div className="skeleton-bar w90" />
      ) : (
        <Markdown>{body.markdown}</Markdown>
      )}
    </article>
  );
}

function ArtifactSection({
  slug,
  state,
  kind,
  selectedId,
  onSelect,
}: {
  slug: string;
  state: ProjectState;
  kind: ArtifactKind;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}): JSX.Element {
  const [showArchive, setShowArchive] = useState(false);
  const all = artifactsOf(state, kind);
  const archiveAware = kind === "attempt" || kind === "exploration";
  const archivedCount = archiveAware ? all.filter((meta) => isSetAsideArtifact(state, meta)).length : 0;
  const list = archiveAware && !showArchive
    ? all.filter((meta) => !isSetAsideArtifact(state, meta))
    : all;
  const selected = selectedId === undefined ? undefined : state.artifacts[selectedId];
  const candidateStatus = (meta: ArtifactMeta): CandidateLifecycle | null =>
    kind === "candidate" && state.candidates[meta.id]
      ? candidateLifecycle(state, meta.id)
      : null;

  if (all.length === 0) return <p className="muted empty-note">Nothing recorded yet.</p>;
  if (selected && selected.kind === kind) {
    return (
      <>
        <button type="button" className="button ghost small back" onClick={() => onSelect(undefined)}>
          ← all {kind}s
        </button>
        <ArtifactDetail slug={slug} state={state} meta={selected} />
      </>
    );
  }

  return (
    <>
      {archivedCount > 0 ? (
        <div className="row library-archive-toggle">
          <button
            type="button"
            className="button ghost small"
            onClick={() => setShowArchive((shown) => !shown)}
          >
            {showArchive ? "hide" : "show"} {archivedCount} set-aside {kind}{archivedCount === 1 ? "" : "s"}
          </button>
          <span className="small muted">Set-aside work remains in the archive.</span>
        </div>
      ) : null}
      {list.length === 0 ? (
        <p className="muted empty-note">No active {kind}s; set-aside work is archived above.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>id</th>
              <th>{kind === "candidate" ? "candidate status" : "conclusion"}</th>
              {kind === "candidate" ? <th>author claim</th> : null}
              <th>task</th>
              <th>wave</th>
            </tr>
          </thead>
          <tbody>
            {list.map((meta) => {
              const lifecycle = candidateStatus(meta);
              return (
                <tr key={meta.id} className="clickable" onClick={() => onSelect(meta.id)}>
                  <td className="mono">{meta.id}</td>
                  <td>
                    {lifecycle !== null ? (
                      <span
                        className="chip"
                        style={{
                          color: candidateStageColor(lifecycle.stage),
                          borderColor: candidateStageColor(lifecycle.stage),
                        }}
                        title={lifecycle.detail}
                      >
                        {lifecycle.label}
                      </span>
                    ) : meta.conclusion === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        className="chip"
                        style={{
                          color: conclusionColor(meta.conclusion),
                          borderColor: conclusionColor(meta.conclusion),
                        }}
                      >
                        {meta.conclusion}
                      </span>
                    )}
                  </td>
                  {kind === "candidate" ? (
                    <td className="muted">{meta.conclusion ?? "—"}</td>
                  ) : null}
                  <td className="mono">{meta.taskId ?? "—"}</td>
                  <td className="mono">{waveOf(state, meta.taskId)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

// --------------------------------------------------------------------- claims

const CLAIM_STATUSES: ClaimStatus[] = [
  "VERIFIED",
  "UNVERIFIED",
  "NEEDS_REVISION",
  "FAILED",
  "REFUTED",
  "SUPERSEDED",
];

function ClaimsSection({
  slug,
  state,
  selectedId,
  onSelect,
}: {
  slug: string;
  state: ProjectState;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}): JSX.Element {
  const exported = isProjectExport() || state.config.workflow === "council-v1";
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [statuses, setStatuses] = useState<ClaimStatus[]>([
    "VERIFIED",
    "UNVERIFIED",
    "NEEDS_REVISION",
  ]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const statusCounts = useMemo(
    () =>
      Object.values(state.claims).reduce<Record<ClaimStatus, number>>(
        (counts, claim) => {
          counts[claim.status] += 1;
          return counts;
        },
        {
          VERIFIED: 0,
          UNVERIFIED: 0,
          NEEDS_REVISION: 0,
          FAILED: 0,
          REFUTED: 0,
          SUPERSEDED: 0,
        },
      ),
    [state.claims],
  );
  const queueBreakdown = useMemo(() => {
    const counts = { untriaged: 0, focusedFollowup: 0, carried: 0, other: 0 };
    for (const claim of Object.values(state.claims)) {
      if (claim.status !== "UNVERIFIED") continue;
      const taskId = claim.sourceTaskId ?? /\(from (T\d+)\)/.exec(claim.provenance)?.[1] ?? null;
      const disposition = taskId === null ? null : state.tasks[taskId]?.disposition ?? null;
      if (taskId !== null && disposition === null) counts.untriaged += 1;
      else if (disposition === "needs_precise_unblock") counts.focusedFollowup += 1;
      else if (disposition === "carry_forward") counts.carried += 1;
      else counts.other += 1;
    }
    return counts;
  }, [state.claims, state.tasks]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.claimOrder
      .map((id) => state.claims[id])
      .filter((claim): claim is NonNullable<typeof claim> => claim !== undefined)
      .filter((claim) => statuses.includes(claim.status))
      .filter(
        (claim) =>
          needle === "" ||
          claim.id.toLowerCase().includes(needle) ||
          claim.statement.toLowerCase().includes(needle) ||
          claim.provenance.toLowerCase().includes(needle),
      );
  }, [state, statuses, query]);

  const toggle = (status: ClaimStatus): void => {
    setStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    );
  };

  return (
    <>
      <div className="queue-summary small">
        <strong>Claim ledger:</strong> {statusCounts.UNVERIFIED} unverified leads — {queueBreakdown.untriaged} still
        need source-attempt triage, {queueBreakdown.focusedFollowup} have a focused follow-up, {queueBreakdown.carried}
        are carried toward review, and {queueBreakdown.other} are background/reference leads. {statusCounts.NEEDS_REVISION}{" "}
        submissions need a clearer self-contained write-up. {statusCounts.VERIFIED}{" "}
        exact statements independently checked, {statusCounts.FAILED} submitted proofs failed, {statusCounts.REFUTED}{" "}
        statements refuted, and {statusCounts.SUPERSEDED} duplicates retired.
        A claim label applies only to its exact statement and never passes or fails a candidate. UNVERIFIED means
        “worth remembering,” not “probably true”; new broad work is held behind triage and independent review of
        concrete results.
      </div>
      <div className="filters">
        {CLAIM_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={`chip filter-chip${statuses.includes(status) ? " on" : ""}`}
            style={{ color: CLAIM_STATUS_COLOR[status], borderColor: CLAIM_STATUS_COLOR[status] }}
            onClick={() => toggle(status)}
          >
            {CLAIM_STATUS_GLYPH[status]} {status}
          </button>
        ))}
        <input
          className="input search"
          placeholder="search claims…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p className="muted empty-note">No claims match.</p>
      ) : (
        <table className="table claims-table">
          <thead>
            <tr>
              <th>id</th>
              <th>status</th>
              <th>statement</th>
              <th>provenance</th>
              <th>wave</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((claim) => {
              const color = CLAIM_STATUS_COLOR[claim.status];
              const taskRef = /\bT\d{3}\b/.exec(claim.provenance)?.[0] ?? null;
              const expanded = selectedId === claim.id;
              return (
                <Fragment key={claim.id}>
                  <tr
                    className="clickable"
                    onClick={() => onSelect(expanded ? undefined : claim.id)}
                  >
                    <td className="mono">{claim.id}</td>
                    <td style={{ color }}>
                      {CLAIM_STATUS_GLYPH[claim.status]} {claim.status}
                    </td>
                    <td>
                      <MathText>{claim.statement}</MathText>
                    </td>
                    <td className="small muted">{claim.provenance}</td>
                    <td className="mono">{waveOf(state, taskRef)}</td>
                  </tr>
                  {expanded ? (
                    <tr className="expansion">
                      <td colSpan={5}>
                        <div className="status-explanation">
                          <strong>What {claim.status} means here</strong>
                          <p>{claimStatusMeaning(claim.status)}</p>
                          {claim.history.at(-1) === undefined ? null : (
                            <>
                              <strong>Why this label was recorded</strong>
                              <p>{claim.history.at(-1)?.justification}</p>
                            </>
                          )}
                        </div>
                        <h4 className="section-head">History</h4>
                        {claim.history.length === 0 ? (
                          <p className="muted small">No status changes.</p>
                        ) : (
                          <ul className="history">
                            {claim.history.map((h, i) => (
                              <li key={i}>
                                <span className="mono small">#{h.seq}</span> {h.from} → {h.to}{" "}
                                <span className="muted">({h.by})</span>
                                <div className="small">{h.justification}</div>
                              </li>
                            ))}
                          </ul>
                        )}
                        {claim.dependsOn.length === 0 ? null : (
                          <p className="small mono muted">depends on: {claim.dependsOn.join(", ")}</p>
                        )}
                        <div className="row">
                          {exported ? null : (
                            <>
                              <input
                                className="input"
                                placeholder="note (required)"
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                              />
                              <button
                                type="button"
                                className="button"
                                disabled={guard.disabled || note.trim() === ""}
                                title={guard.title ?? "a justification note is required"}
                                onClick={() => {
                                  void run(
                                    () => api.setClaimStatus(slug, claim.id, "FAILED", note.trim()),
                                    `${claim.id} marked FAILED`,
                                  ).then((ok) => {
                                    if (ok) setNote("");
                                  });
                                }}
                              >
                                Mark proof failed
                              </button>
                              <button
                                type="button"
                                className="button primary"
                                disabled={guard.disabled || note.trim() === ""}
                                title={guard.title ?? "a justification note is required"}
                                onClick={() => {
                                  void run(
                                    () => api.setClaimStatus(slug, claim.id, "VERIFIED", note.trim()),
                                    `${claim.id} marked VERIFIED`,
                                  ).then((ok) => {
                                    if (ok) setNote("");
                                  });
                                }}
                              >
                                Mark VERIFIED
                              </button>
                            </>
                          )}
                          <Link className="button ghost small" to={resolveNodeRoute(slug, claim.id).to}>
                            show in graph
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

// --------------------------------------------------------------------- memory

function MemorySection({
  slug,
  state,
  selectedId,
  onSelect,
}: {
  slug: string;
  state: ProjectState;
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}): JSX.Element {
  const exported = isProjectExport() || state.config.workflow === "council-v1";
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [status, setStatus] = useState("active");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");

  const all = Object.values(state.cards);
  const types = [...new Set(all.map((c) => c.card.type))].sort();
  const statusValues = [...new Set(all.map((c) => c.status))].sort();

  const selected = selectedId === undefined ? undefined : state.cards[selectedId];

  if (selected) {
    const color = CARD_STATUS_COLOR[selected.status] ?? "var(--muted)";
    const sourceArtifact = selected.card.sourceArtifact;
    return (
      <>
        <button type="button" className="button ghost small back" onClick={() => onSelect(undefined)}>
          ← all cards
        </button>
        <article className="library-detail">
          <header className="detail-head">
            <span className="mono detail-id">{selected.id}</span>
            <span className="chip">{selected.card.type}</span>
            <span className="chip" style={{ color, borderColor: color }}>
              {selected.status}
            </span>
            {sourceArtifact === null ? null : (
              <Link className="button ghost small" to={resolveNodeRoute(slug, sourceArtifact).to}>
                linked artifact {sourceArtifact}
              </Link>
            )}
          </header>
          <h3 className="detail-title">
            <MathText>{selected.card.title}</MathText>
          </h3>
          <p className="memory-abstract">
            <strong>Abstract.</strong> <MathText>{selected.card.abstract}</MathText>
          </p>
          {selected.card.tags.length === 0 ? null : (
            <div className="row wrap memory-detail-tags">
              {selected.card.tags.map((tag) => (
                <span key={tag} className="chip tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <h4 className="section-head">Conclusions and excerpt</h4>
          <Markdown>{selected.card.content}</Markdown>
          <p className="small muted">
            proposed by {selected.proposedBy} · {selected.card.provenance}
          </p>
          {selected.admissionReason === null ? null : (
            <p className="small muted">admission: {selected.admissionReason}</p>
          )}
          {exported ? null : (
            <div className="row">
              <input
                className="input"
                placeholder="quarantine note (required)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="button danger"
                disabled={guard.disabled || note.trim() === ""}
                title={guard.title ?? "a note is required"}
                onClick={() => {
                  void run(
                    () => api.quarantineCard(slug, selected.id, note.trim()),
                    `${selected.id} quarantined`,
                  ).then((ok) => {
                    if (ok) setNote("");
                  });
                }}
              >
                Quarantine
              </button>
            </div>
          )}
        </article>
      </>
    );
  }

  const needle = query.trim().toLowerCase();
  const rows = all
    .filter(
      (entry) =>
        status === "" ||
        (status === "active"
          ? entry.status === "PROPOSED" || entry.status === "VERIFIED"
          : entry.status === status),
    )
    .filter((entry) => type === "" || entry.card.type === type)
    .filter(
      (entry) =>
        needle === "" ||
        entry.id.toLowerCase().includes(needle) ||
        entry.card.title.toLowerCase().includes(needle) ||
        entry.card.abstract.toLowerCase().includes(needle) ||
        entry.card.tags.some((tag) => tag.toLowerCase().includes(needle)),
    )
    .sort((a, b) => {
      const ap = a.card.tags.includes("promising") ? 1 : 0;
      const bp = b.card.tags.includes("promising") ? 1 : 0;
      return bp - ap || a.id.localeCompare(b.id);
    });

  return (
    <>
      <div className="filters">
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">working library</option>
          <option value="">entire archive</option>
          {statusValues.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all types</option>
          {types.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          className="input search"
          placeholder="search cards…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p className="muted empty-note">No cards match.</p>
      ) : (
        <div className="card-grid">
          {rows.map((entry) => {
            const color = CARD_STATUS_COLOR[entry.status] ?? "var(--muted)";
            return (
              <button
                key={entry.id}
                type="button"
                className="memory-card"
                onClick={() => onSelect(entry.id)}
              >
                <div className="row between">
                  <span className="mono small">{entry.id}</span>
                  <span className="chip" style={{ color, borderColor: color }}>
                    {entry.status}
                  </span>
                </div>
                <div className="memory-title">
                  <MathText>{entry.card.title}</MathText>
                </div>
                <div className="row">
                  <span className="chip">{entry.card.type}</span>
                </div>
                <p className="small muted clamp-3">
                  <MathText>{entry.card.abstract}</MathText>
                </p>
                <div className="row wrap">
                  {entry.card.tags.map((tag) => (
                    <span key={tag} className="chip tag">
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------- computations

function ComputationCheck({ comp }: { comp: ComputationState }): JSX.Element {
  if (comp.exitCode !== null && comp.exitCode !== 0) {
    return (
      <span style={{ color: "var(--danger)" }} title={comp.stderr || `baseline exit ${comp.exitCode}`}>
        ✗ command failed (exit {comp.exitCode})
      </span>
    );
  }
  if (comp.reproduced === null) {
    return (
      <span className="muted" title="not re-run yet">
        — awaiting rerun
      </span>
    );
  }
  if (comp.reproduced.exitCode !== null && comp.reproduced.exitCode !== 0) {
    return (
      <span
        style={{ color: "var(--danger)" }}
        title={comp.reproduced.stderr || `rerun exit ${comp.reproduced.exitCode}`}
      >
        ✗ rerun failed (exit {comp.reproduced.exitCode})
      </span>
    );
  }
  if (comp.reproduced.match) {
    return (
      <span
        style={{ color: "var(--ok)" }}
        title={`${comp.reproduced.outputHash}${comp.repairedReason ? ` — ${comp.repairedReason}` : ""}`}
      >
        ✓ exact match{comp.repairedReason ? " (legacy record repaired)" : ""}
      </span>
    );
  }
  return (
    <span style={{ color: "var(--danger)" }} title={comp.reproduced.outputHash}>
      ✗ output mismatch
    </span>
  );
}

function ComputationsSection({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const rows = Object.values(state.computations);
  if (rows.length === 0) return <p className="muted empty-note">No computations recorded.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>id</th>
          <th>entry</th>
          <th>check</th>
          <th>task</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((comp) => (
          <tr key={comp.id}>
            <td className="mono">{comp.id}</td>
            <td className="mono">{comp.entry}</td>
            <td><ComputationCheck comp={comp} /></td>
            <td>
              <Link className="mono" to={resolveNodeRoute(slug, comp.taskId).to}>
                {comp.taskId}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------- trajectories-v2 library

function claimSection(claim: ClaimState): Section {
  return claim.status === "FAILED" || claim.status === "REFUTED" || claim.status === "SUPERSEDED"
    ? "failed-claims"
    : "claims";
}

function VerificationList({ slug, state, claim }: { slug: string; state: ProjectState; claim: ClaimState }): JSX.Element {
  const checks = claim.verificationIds
    .map((id) => state.verifications[id])
    .filter((value): value is VerificationState => value !== undefined);
  const policy = claim.verificationPolicy ?? state.config.trajectory;
  const passes = checks.filter((check) => check.verdict === "PASS").length;
  return (
    <section className="trajectory-checks">
      <h4 className="section-head">Independent checks</h4>
      <p className="small muted">
        {passes} of {policy.passesRequired} required passes · {checks.length} of {policy.verifiersPerClaim} checks requested
      </p>
      {checks.length === 0 ? (
        <p className="muted small">No check has been requested.</p>
      ) : (
        <div className="trajectory-check-list">
          {checks.map((check) => (
            <Link
              key={check.id}
              className="trajectory-check-row"
              to={`/p/${encodeURIComponent(slug)}/library/verifications/${encodeURIComponent(check.id)}`}
            >
              <span className="mono">{check.id}</span>
              <span className={`chip${check.verdict === "PASS" ? " ok" : check.verdict === "FAIL" || check.verdict === "ERROR" ? " danger-badge" : ""}`}>
                {verificationDisplayStatus(check)}
              </span>
              {check.finding && check.finding !== "NONE" ? (
                <span className="chip">{check.finding.replaceAll("_", " ")}</span>
              ) : null}
              <span className="small muted">{check.summaryMarkdown || "Waiting for an independent reading."}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function TrajectoryClaimDetail({ slug, state, claim }: { slug: string; state: ProjectState; claim: ClaimState }): JSX.Element {
  const color = CLAIM_STATUS_COLOR[claim.status];
  return (
    <article className="library-detail trajectory-document">
      <header className="detail-head">
        <span className="mono detail-id">{claim.id}</span>
        <span className="chip" style={{ color, borderColor: color }}>{trajectoryClaimStatusLabel(claim.status)}</span>
        <span className="chip">{claim.relationToGoal}</span>
        {claim.kind === "correction" ? <span className="chip warn">correction</span> : null}
        {claim.sourceTaskId ? (
          <Link className="button ghost small" to={resolveNodeRoute(slug, claim.sourceTaskId).to}>
            source {claim.sourceTaskId}
          </Link>
        ) : null}
      </header>
      <h3>{claim.title || claim.id}</h3>
      <h4 className="section-head">Statement</h4>
      <Markdown>{claim.statement}</Markdown>
      <h4 className="section-head">Alleged proof</h4>
      <Markdown>{claim.proofMarkdown || "No proof text was retained."}</Markdown>
      {claim.dependsOn.length > 0 ? <p className="small">Uses project facts: {claim.dependsOn.map((id) => <Link key={id} className="mono" to={`/p/${encodeURIComponent(slug)}/library/facts/${id}`}>{id}{" "}</Link>)}</p> : null}
      <VerificationList slug={slug} state={state} claim={claim} />
      {claim.equivalentIds.length > 0 ? (
        <p className="small muted">
          Same statement as {claim.equivalentIds.map((id, index) => {
            const other = state.claims[id];
            return (
              <Fragment key={id}>
                {index > 0 ? ", " : ""}
                <Link to={`/p/${encodeURIComponent(slug)}/library/${other ? claimSection(other) : "claims"}/${encodeURIComponent(id)}`} className="mono">
                  {id}
                </Link>
              </Fragment>
            );
          })}. Distinct proofs remain separately inspectable.
        </p>
      ) : null}
      {claim.promotedFactId ? (
        <p className="small">
          Recorded as <Link className="mono" to={`/p/${encodeURIComponent(slug)}/library/facts/${encodeURIComponent(claim.promotedFactId)}`}>{claim.promotedFactId}</Link>.
        </p>
      ) : null}
      {claim.targetFactId ? (
        <p className="small">
          Challenges <Link className="mono" to={`/p/${encodeURIComponent(slug)}/library/facts/${encodeURIComponent(claim.targetFactId)}`}>{claim.targetFactId}</Link>.
        </p>
      ) : null}
      <p className="small muted">{claim.provenance}</p>
    </article>
  );
}

function TrajectoryClaimsSection({
  slug,
  state,
  selectedId,
  archived,
  onSelect,
}: {
  slug: string;
  state: ProjectState;
  selectedId: string | undefined;
  archived: boolean;
  onSelect: (id: string | undefined) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const selected = selectedId ? state.claims[selectedId] : undefined;
  if (selected) {
    return (
      <>
        <button type="button" className="button ghost small back" onClick={() => onSelect(undefined)}>
          ← all {archived ? "archived claims" : "claims being checked"}
        </button>
        <TrajectoryClaimDetail slug={slug} state={state} claim={selected} />
      </>
    );
  }
  const needle = query.trim().toLowerCase();
  const rows = state.claimOrder
    .map((id) => state.claims[id])
    .filter((claim): claim is ClaimState => claim !== undefined)
    .filter((claim) =>
      archived
        ? claim.status === "FAILED" || claim.status === "REFUTED" || claim.status === "SUPERSEDED"
        : claim.status === "UNVERIFIED",
    )
    .filter((claim) =>
      needle === "" ||
      claim.id.toLowerCase().includes(needle) ||
      claim.title.toLowerCase().includes(needle) ||
      claim.statement.toLowerCase().includes(needle),
    );
  return (
    <>
      <div className="queue-summary small">
        {archived
          ? "Claims whose alleged proof failed an independent check, or whose statement is already represented by an established fact, remain here for inspection. They are not supplied as active mathematical knowledge."
          : "Every item here is a self-contained proposed result with an alleged proof. It remains a claim until its frozen independent-check threshold is met."}
      </div>
      <div className="filters">
        <input className="input search" placeholder="search claims…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {rows.length === 0 ? <p className="muted empty-note">Nothing here yet.</p> : (
        <table className="table claims-table">
          <thead><tr><th>id</th><th>status</th><th>relation</th><th>statement</th><th>checks</th></tr></thead>
          <tbody>{rows.map((claim) => {
            const checks = claim.verificationIds.map((id) => state.verifications[id]).filter(Boolean);
            const passes = checks.filter((check) => check?.verdict === "PASS").length;
            const policy = claim.verificationPolicy ?? state.config.trajectory;
            return (
              <tr key={claim.id} className="clickable" onClick={() => onSelect(claim.id)}>
                <td className="mono">{claim.id}</td>
                <td style={{ color: CLAIM_STATUS_COLOR[claim.status] }}>{trajectoryClaimStatusLabel(claim.status)}</td>
                <td>{claim.relationToGoal}</td>
                <td><MathText>{claim.statement}</MathText></td>
                <td className="mono">{passes}/{policy.passesRequired} pass · {checks.length}/{policy.verifiersPerClaim}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
    </>
  );
}

function FactsSection({ slug, state, selectedId, onSelect }: { slug: string; state: ProjectState; selectedId: string | undefined; onSelect: (id: string | undefined) => void }): JSX.Element {
  const [showArchive, setShowArchive] = useState(false);
  const selected = selectedId ? state.facts[selectedId] : undefined;
  if (selected) {
    const sourceClaim = state.claims[selected.claimId];
    return (
      <>
        <button type="button" className="button ghost small back" onClick={() => onSelect(undefined)}>← all facts</button>
        <article className="library-detail trajectory-document">
          <header className="detail-head">
            <span className="mono detail-id">{selected.id}</span>
            <span className="chip" style={{ color: FACT_STATUS_COLOR[factDisplayStatus(state, selected.id)], borderColor: FACT_STATUS_COLOR[factDisplayStatus(state, selected.id)] }}>{factDisplayStatus(state, selected.id)}</span>
            {sourceClaim ? <span className="chip">{sourceClaim.relationToGoal}</span> : null}
          </header>
          <h3>{selected.title || selected.id}</h3>
          <h4 className="section-head">Statement</h4>
          <Markdown>{selected.statement}</Markdown>
          <h4 className="section-head">Recorded proof</h4>
          <Markdown>{selected.proofMarkdown}</Markdown>
          {factConcerns(state, selected.id).map((reason) => <div className="banner warn" key={reason}><Markdown>{reason}</Markdown></div>)}
          {selected.status === "RETRACTED" && selected.retractedByClaimId ? (
            <div className="banner danger">This statement was withdrawn after <Link className="mono" to={`/p/${encodeURIComponent(slug)}/library/claims/${encodeURIComponent(selected.retractedByClaimId)}`}>{selected.retractedByClaimId}</Link> passed independent checking.</div>
          ) : null}
          <p className="small">
            Established from <Link className="mono" to={`/p/${encodeURIComponent(slug)}/library/claims/${encodeURIComponent(selected.claimId)}`}>{selected.claimId}</Link>.
          </p>
          {selected.status === "SUPERSEDED" && selected.supersededByFactId ? (
            <p className="small">Same result retained as <Link className="mono" to={`/p/${encodeURIComponent(slug)}/library/facts/${encodeURIComponent(selected.supersededByFactId)}`}>{selected.supersededByFactId}</Link>.</p>
          ) : null}
          {selected.correctionClaimIds.length > 0 ? (
            <p className="small muted">Corrections considered: {selected.correctionClaimIds.map((id, index) => {
              const correction = state.claims[id];
              return <Fragment key={id}>{index > 0 ? ", " : ""}<Link className="mono" to={`/p/${encodeURIComponent(slug)}/library/${correction ? claimSection(correction) : "claims"}/${encodeURIComponent(id)}`}>{id}</Link></Fragment>;
            })}</p>
          ) : null}
          {sourceClaim ? <VerificationList slug={slug} state={state} claim={sourceClaim} /> : null}
        </article>
      </>
    );
  }
  const all = state.factOrder.map((id) => state.facts[id]).filter((fact): fact is FactState => fact !== undefined);
  const archived = all.filter((fact) => fact.status === "RETRACTED" || fact.status === "SUPERSEDED");
  const rows = showArchive ? all : all.filter((fact) => fact.status === "ACTIVE" || fact.status === "SUSPICIOUS");
  return (
    <>
      <div className="queue-summary small">Facts are claims whose alleged proofs met their frozen independent-check threshold. A suspicious fact remains visible but is not treated as settled until its concrete correction claim is resolved.</div>
      {archived.length > 0 ? <button type="button" className="button ghost small back" onClick={() => setShowArchive((value) => !value)}>{showArchive ? "Hide" : "Show"} {archived.length} retracted or duplicate fact{archived.length === 1 ? "" : "s"}</button> : null}
      {rows.length === 0 ? <p className="muted empty-note">No fact has passed independent checking yet.</p> : (
        <table className="table claims-table"><thead><tr><th>id</th><th>status</th><th>relation</th><th>statement</th><th>source claim</th></tr></thead>
          <tbody>{rows.map((fact) => {
            const claim = state.claims[fact.claimId];
            return <tr key={fact.id} className="clickable" onClick={() => onSelect(fact.id)}><td className="mono">{fact.id}</td><td style={{ color: FACT_STATUS_COLOR[factDisplayStatus(state, fact.id)] }}>{factDisplayStatus(state, fact.id)}</td><td>{claim?.relationToGoal ?? "RELATED"}</td><td><MathText>{fact.statement}</MathText></td><td className="mono">{fact.claimId}</td></tr>;
          })}</tbody>
        </table>
      )}
    </>
  );
}

function VerificationReport({ slug, verification }: { slug: string; verification: VerificationState }): JSX.Element {
  const [body, setBody] = useState<ArtifactBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (verification.artifactPath === null || verification.completedAtSeq === null) return;
    let live = true;
    void loadArtifact(slug, verification.id, verification.completedAtSeq)
      .then((value) => { if (live) setBody(value); })
      .catch((reason: unknown) => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, [slug, verification.id, verification.artifactPath, verification.completedAtSeq]);
  if (verification.artifactPath === null) return <Markdown>{verification.summaryMarkdown}</Markdown>;
  if (error) return <div className="banner danger">{error}</div>;
  if (!body) return <div className="skeleton-bar w90" />;
  return <Markdown>{body.markdown}</Markdown>;
}

function VerificationsSection({ slug, state, selectedId, onSelect }: { slug: string; state: ProjectState; selectedId: string | undefined; onSelect: (id: string | undefined) => void }): JSX.Element {
  const selected = selectedId ? state.verifications[selectedId] : undefined;
  if (selected) {
    return <><button type="button" className="button ghost small back" onClick={() => onSelect(undefined)}>← all independent checks</button><article className="library-detail trajectory-document"><header className="detail-head"><span className="mono detail-id">{selected.id}</span><span className="chip">{verificationDisplayStatus(selected)}</span><Link className="button ghost small" to={`/p/${encodeURIComponent(slug)}/library/claims/${encodeURIComponent(selected.claimId)}`}>claim {selected.claimId}</Link></header><VerificationEvidence key={selected.id} slug={slug} verification={selected} /><VerificationReport slug={slug} verification={selected} /></article></>;
  }
  const rows = state.verificationOrder.map((id) => state.verifications[id]).filter((value): value is VerificationState => value !== undefined);
  return rows.length === 0 ? <p className="muted empty-note">No independent checks have been requested yet.</p> : (
    <table className="table"><thead><tr><th>id</th><th>claim</th><th>check</th><th>verdict</th><th>summary</th></tr></thead><tbody>{rows.map((check) => <tr className="clickable" key={check.id} onClick={() => onSelect(check.id)}><td className="mono">{check.id}</td><td className="mono">{check.claimId}</td><td>{check.ordinal}</td><td>{verificationDisplayStatus(check)}</td><td className="small muted">{check.summaryMarkdown || (check.status === "running" ? "Checking now" : "Waiting")}</td></tr>)}</tbody></table>
  );
}

// ----------------------------------------------------------------------- view

export default function LibraryView(): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const section: Section = isSection(params["section"]) ? params["section"] : "problem";
  const id = params["id"];

  const go = useCallback(
    (nextSection: Section, nextId?: string) => {
      const tail = nextId === undefined ? "" : `/${encodeURIComponent(nextId)}`;
      navigate(`/p/${slug}/library/${nextSection}${tail}${location.search}`);
    },
    [navigate, slug, location.search],
  );

  const onSelect = useCallback(
    (nextId: string | undefined) => {
      go(section, nextId);
    },
    [go, section],
  );

  const tree = useMemo(() => (state === null ? null : counts(state)), [state]);

  // A deep link may name an artifact under the wrong section (`resolveNodeRoute`
  // guesses "attempts" from the id alone). Correct the URL from the ledger.
  useEffect(() => {
    if (state === null || id === undefined) return;
    if (ARTIFACT_SECTIONS[section] === undefined) return;
    const meta = state.artifacts[id];
    if (!meta) return;
    const want = SECTION_FOR_KIND[meta.kind];
    if (want !== section) {
      navigate(`/p/${slug}/library/${want}/${encodeURIComponent(id)}${location.search}`, {
        replace: true,
      });
    }
  }, [state, id, section, navigate, slug, location.search]);

  useEffect(() => {
    if (state?.config.workflow !== "trajectories-v2") return;
    if (TRAJECTORY_ORDER.includes(section)) return;
    navigate(`/p/${slug}/library/problem${location.search}`, { replace: true });
  }, [state, section, navigate, slug, location.search]);

  if (state === null || tree === null) {
    return (
      <div className="centered-state">
        <p className="muted">Loading project…</p>
      </div>
    );
  }

  const artifactKind = ARTIFACT_SECTIONS[section];
  const isTrajectory = state.config.workflow === "trajectories-v2";
  const order = isTrajectory ? TRAJECTORY_ORDER : LEGACY_ORDER;
  const activeLatest =
    state.activeLineageId === null
      ? null
      : state.lineages[state.activeLineageId]?.versionIds.at(-1) ?? null;

  return (
    <div className="library">
      <nav className="library-tree" aria-label="library sections">
        {order.map((key) => {
          if (key === "final" && tree.final === 0) return null;
          const count = tree[key];
          const bold = isTrajectory ? key === "facts" : key === "candidate";
          return (
            <button
              key={key}
              type="button"
              className={`tree-item${section === key ? " active" : ""}${bold ? " strong" : ""}`}
              onClick={() => go(key)}
            >
              <span>{SECTION_LABEL[key]}</span>
              {key === "problem" ? null : (
                <span className="muted small">{count}</span>
              )}
            </button>
          );
        })}
        {isTrajectory || activeLatest === null ? null : (
          <div className="tree-note mono small muted">latest {activeLatest}</div>
        )}
      </nav>

      <section className="library-content">
        {isTrajectory ? <ClaimConflicts slug={slug} state={state} /> : null}
        <h2 className="library-head">{SECTION_LABEL[section]}</h2>

        {section === "problem" ? (
          <article className="library-detail">
            <div className="detail-head">
              <span className="chip">{state.phase}</span>
              {state.problem.confirmedMarkdown === null ? (
                <span className="muted small">not confirmed</span>
              ) : (
                <span className="ok-check">✓ confirmed</span>
              )}
              <span className="muted small">
                budget {formatExact(state.budget.totalTokens)} tokens
              </span>
            </div>
            <Markdown>
              {state.problem.confirmedMarkdown ?? state.problem.normalizedMarkdown ?? state.statement}
            </Markdown>
          </article>
        ) : null}

        {section === "sources" ? <SourcesSection slug={slug} state={state} /> : null}

        {artifactKind === undefined || (isTrajectory && artifactKind !== "writeup" && artifactKind !== "final") ? null : (
          <ArtifactSection
            slug={slug}
            state={state}
            kind={artifactKind}
            selectedId={id}
            onSelect={onSelect}
          />
        )}

        {!isTrajectory && section === "claims" ? (
          <ClaimsSection slug={slug} state={state} selectedId={id} onSelect={onSelect} />
        ) : null}

        {isTrajectory && section === "facts" ? (
          <FactsSection slug={slug} state={state} selectedId={id} onSelect={onSelect} />
        ) : null}

        {isTrajectory && section === "claims" ? (
          <TrajectoryClaimsSection
            slug={slug}
            state={state}
            selectedId={id}
            archived={false}
            onSelect={onSelect}
          />
        ) : null}

        {isTrajectory && section === "failed-claims" ? (
          <TrajectoryClaimsSection
            slug={slug}
            state={state}
            selectedId={id}
            archived
            onSelect={onSelect}
          />
        ) : null}

        {isTrajectory && section === "verifications" ? (
          <VerificationsSection slug={slug} state={state} selectedId={id} onSelect={onSelect} />
        ) : null}

        {section === "memory" ? (
          <MemorySection slug={slug} state={state} selectedId={id} onSelect={onSelect} />
        ) : null}

        {section === "computations" ? <ComputationsSection slug={slug} state={state} /> : null}
      </section>
    </div>
  );
}
