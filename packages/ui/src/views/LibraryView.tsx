import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  candidateLifecycle,
  type CandidateLifecycle,
  type ArtifactKind,
  type ArtifactMeta,
  type ClaimStatus,
  type ComputationState,
  type ProjectState,
} from "@inventio/schema";
import Markdown from "../components/Markdown";
import MathText from "../components/MathText";
import { useProjectSlug } from "../components/ProjectContext";
import { API_BASE, api, errorMessage, loadArtifact, type ArtifactBody } from "../lib/api";
import { formatExact } from "../lib/format";
import { resolveNodeRoute } from "../lib/selection";
import {
  CARD_STATUS_COLOR,
  CLAIM_STATUS_COLOR,
  CLAIM_STATUS_GLYPH,
  candidateStageColor,
  claimStatusMeaning,
  conclusionColor,
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
  | "claims"
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
};

/** Inverse of ARTIFACT_SECTIONS: which section owns an artifact of this kind. */
const SECTION_FOR_KIND: Record<ArtifactKind, Section> = {
  candidate: "candidate",
  attempt: "attempts",
  exploration: "explorations",
  review: "reviews",
  resolution: "resolutions",
  final: "final",
};

const SECTION_LABEL: Record<Section, string> = {
  problem: "Problem",
  sources: "Original materials",
  candidate: "Candidate",
  attempts: "Attempts",
  explorations: "Explorations",
  reviews: "Reviews",
  claims: "Claims",
  memory: "Memory",
  resolutions: "Resolutions",
  computations: "Computations",
  final: "Reports",
};

const ORDER: Section[] = [
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

function isSection(value: string | undefined): value is Section {
  return value !== undefined && (ORDER as string[]).includes(value);
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
    claims: Object.values(state.claims).filter(
      (claim) => claim.status === "VERIFIED" || claim.status === "UNVERIFIED",
    ).length,
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
            ) : uploadName ? (
              <a
                className="button ghost"
                href={`${API_BASE}/projects/${encodeURIComponent(slug)}/sources/${encodeURIComponent(uploadName)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open original file
              </a>
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

const CLAIM_STATUSES: ClaimStatus[] = ["VERIFIED", "UNVERIFIED", "REFUTED", "SUPERSEDED"];

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
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [statuses, setStatuses] = useState<ClaimStatus[]>(["VERIFIED", "UNVERIFIED"]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const statusCounts = useMemo(
    () =>
      Object.values(state.claims).reduce<Record<ClaimStatus, number>>(
        (counts, claim) => {
          counts[claim.status] += 1;
          return counts;
        },
        { VERIFIED: 0, UNVERIFIED: 0, REFUTED: 0, SUPERSEDED: 0 },
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
        are carried toward review, and {queueBreakdown.other} are background/reference leads. {statusCounts.VERIFIED}{" "}
        exact statements independently checked, {statusCounts.REFUTED} refuted, {statusCounts.SUPERSEDED} retired.
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
                                () => api.setClaimStatus(slug, claim.id, "REFUTED", note.trim()),
                                `${claim.id} marked REFUTED`,
                              ).then((ok) => {
                                if (ok) setNote("");
                              });
                            }}
                          >
                            Mark REFUTED
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

  if (state === null || tree === null) {
    return (
      <div className="centered-state">
        <p className="muted">Loading project…</p>
      </div>
    );
  }

  const artifactKind = ARTIFACT_SECTIONS[section];
  const activeLatest =
    state.activeLineageId === null
      ? null
      : state.lineages[state.activeLineageId]?.versionIds.at(-1) ?? null;

  return (
    <div className="library">
      <nav className="library-tree" aria-label="library sections">
        {ORDER.map((key) => {
          if (key === "final" && tree.final === 0) return null;
          const count = tree[key];
          const bold = key === "candidate";
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
        {activeLatest === null ? null : (
          <div className="tree-note mono small muted">latest {activeLatest}</div>
        )}
      </nav>

      <section className="library-content">
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

        {artifactKind === undefined ? null : (
          <ArtifactSection
            slug={slug}
            state={state}
            kind={artifactKind}
            selectedId={id}
            onSelect={onSelect}
          />
        )}

        {section === "claims" ? (
          <ClaimsSection slug={slug} state={state} selectedId={id} onSelect={onSelect} />
        ) : null}

        {section === "memory" ? (
          <MemorySection slug={slug} state={state} selectedId={id} onSelect={onSelect} />
        ) : null}

        {section === "computations" ? <ComputationsSection slug={slug} state={state} /> : null}
      </section>
    </div>
  );
}
