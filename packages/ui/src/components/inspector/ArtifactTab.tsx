import { useEffect, useState } from "react";
import { candidateLifecycle, type ArtifactMeta, type ProjectState } from "@inventio/schema";
import Markdown from "../Markdown";
import { api, errorMessage, loadArtifact, type ArtifactBody } from "../../lib/api";
import { formatExact } from "../../lib/format";
import type { NodeKind } from "../../lib/selection";
import {
  CARD_STATUS_COLOR,
  CLAIM_STATUS_COLOR,
  CLAIM_STATUS_GLYPH,
  SEVERITY_COLOR,
  SEVERITY_LETTER,
  candidateStageColor,
  claimStatusMeaning,
  conclusionColor,
  verificationDisplayStatus,
  trajectoryClaimStatusLabel,
} from "../../lib/visual";
import { useActionGuard, useApiAction, useProjectState } from "../../store/hooks";

/**
 * Artifact tab (UI-SPEC §7.1). Whatever "the text" of a node is: the task's
 * artifact, the candidate's frozen markdown, the wave's resolution, the
 * problem statement, or — for ledger nodes — the record itself plus its
 * human actions.
 */

/** Which artifact id (if any) is "the body" of this node. */
function artifactIdsFor(state: ProjectState, kind: NodeKind, nodeId: string): string[] {
  switch (kind) {
    case "artifact":
      return state.artifacts[nodeId] ? [nodeId] : [];
    case "task":
      return state.tasks[nodeId]?.artifactIds ?? [];
    case "candidate": {
      const candidate = state.candidates[nodeId];
      return candidate && state.artifacts[candidate.fromArtifact] ? [candidate.fromArtifact] : [];
    }
    case "review": {
      const review = state.reviews[nodeId];
      if (!review) return [];
      return Object.values(state.artifacts)
        .filter((a) => a.taskId === review.taskId && a.kind === "review")
        .map((a) => a.id);
    }
    case "wave":
    case "resolution": {
      const waveId = kind === "wave" ? nodeId : (nodeId.split(":")[0] ?? "");
      const wave = state.waves[waveId];
      if (!wave || wave.resolutionPath === null) return [];
      return Object.values(state.artifacts)
        .filter((a) => a.kind === "resolution" && a.path === wave.resolutionPath)
        .map((a) => a.id);
    }
    case "final":
      return Object.values(state.artifacts)
        .filter((a) => a.kind === "final")
        .map((a) => a.id);
    default:
      return [];
  }
}

function ArtifactBodyView({
  slug,
  meta,
  sourceClaim = false,
}: {
  slug: string;
  meta: ArtifactMeta;
  sourceClaim?: boolean;
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

  if (error !== null) return <div className="banner danger">{error}</div>;
  if (body === null) return <div className="skeleton-bar w90" aria-label="loading artifact" />;

  return (
    <>
      {body.conclusion === null ? null : (
        <div
          className="conclusion-banner"
          style={{ color: conclusionColor(body.conclusion), borderColor: conclusionColor(body.conclusion) }}
        >
          {sourceClaim ? `AUTHOR CLAIM · ${body.conclusion}` : body.conclusion}
        </div>
      )}
      <div className="artifact-meta mono small muted">
        {body.kind} · {body.path}
      </div>
      <Markdown>{body.markdown}</Markdown>
    </>
  );
}

function QuestionBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const question = state?.questions[nodeId];

  if (!question) return <p className="muted">This question is no longer in the ledger.</p>;
  const open = question.status === "open";

  return (
    <div className="detail">
      <div className="detail-row">
        {question.blocking ? <span className="badge danger-badge">blocking</span> : null}
        <span className="chip">{question.status}</span>
        <span className="muted small">raised by {question.raisedBy}</span>
      </div>
      <Markdown>{question.text}</Markdown>
      {question.context === "" ? null : (
        <>
          <h3 className="section-head">Context</h3>
          <div className="panel-inset">
            <Markdown>{question.context}</Markdown>
          </div>
        </>
      )}
      {question.answer === null ? null : (
        <>
          <h3 className="section-head">Answer</h3>
          <div className="panel-inset">
            <Markdown>{question.answer}</Markdown>
          </div>
        </>
      )}
      {!open ? null : (
        <div className="answer-form">
          <textarea
            className="textarea"
            rows={4}
            placeholder="answer…"
            value={answer}
            disabled={busy}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="row end">
            <button
              type="button"
              className="button"
              disabled={busy || guard.disabled}
              {...(guard.title === undefined ? {} : { title: guard.title })}
              onClick={() => {
                setBusy(true);
                void run(() => api.dismissQuestion(slug, nodeId), "question dismissed").finally(() =>
                  setBusy(false),
                );
              }}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || guard.disabled || answer.trim() === ""}
              {...(guard.title === undefined ? {} : { title: guard.title })}
              onClick={() => {
                setBusy(true);
                void run(() => api.answerQuestion(slug, nodeId, answer.trim()), "answer sent")
                  .finally(() => setBusy(false));
              }}
            >
              Answer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ClaimBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [note, setNote] = useState("");
  const claim = state?.claims[nodeId];
  if (!claim) return <p className="muted">Unknown claim.</p>;
  const color = CLAIM_STATUS_COLOR[claim.status];
  const latestChange = claim.history.at(-1);

  if (state?.config.workflow === "trajectories-v2") {
    const policy = claim.verificationPolicy ?? state.config.trajectory;
    const checks = claim.verificationIds
      .map((id) => state.verifications[id])
      .filter((value) => value !== undefined);
    const passes = checks.filter((check) => check?.verdict === "PASS").length;
    return (
      <div className="detail">
        <div className="detail-row">
          <span className="chip" style={{ color, borderColor: color }}>{trajectoryClaimStatusLabel(claim.status)}</span>
          <span className="chip">{claim.relationToGoal}</span>
          <span className="muted small">{claim.provenance}</span>
        </div>
        <h3 className="section-head">Statement</h3>
        <Markdown>{claim.statement}</Markdown>
        <h3 className="section-head">Alleged proof</h3>
        <Markdown>{claim.proofMarkdown}</Markdown>
        <h3 className="section-head">Independent checks</h3>
        <p className="small muted">{passes}/{policy.passesRequired} required passes · {checks.length}/{policy.verifiersPerClaim} requested</p>
        {checks.map((check) => (
          <div className="detail-row" key={check!.id}>
            <span className="mono">{check!.id}</span>
            <span className="chip">{verificationDisplayStatus(check!)}</span>
            <span className="small muted">{check!.summaryMarkdown}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="detail">
      <div className="detail-row">
        <span className="chip" style={{ color, borderColor: color }}>
          {CLAIM_STATUS_GLYPH[claim.status]} {claim.status}
        </span>
        <span className="muted small">{claim.provenance}</span>
      </div>
      <Markdown>{claim.statement}</Markdown>
      <div className="status-explanation">
        <strong>What {claim.status} means here</strong>
        <p>{claimStatusMeaning(claim.status)}</p>
        {latestChange === undefined ? null : (
          <>
            <strong>Why this label was recorded</strong>
            <p>{latestChange.justification}</p>
          </>
        )}
      </div>
      {claim.dependsOn.length === 0 ? null : (
        <p className="small muted mono">depends on: {claim.dependsOn.join(", ")}</p>
      )}
      <h3 className="section-head">History</h3>
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
      <div className="answer-form">
        <textarea
          className="textarea"
          rows={2}
          placeholder="note (required)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row end">
          <button
            type="button"
            className="button"
            disabled={guard.disabled || note.trim() === ""}
            title={guard.title ?? "a justification note is required"}
            onClick={() => {
              void run(
                () => api.setClaimStatus(slug, nodeId, "REFUTED", note.trim()),
                `${nodeId} marked REFUTED`,
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
                () => api.setClaimStatus(slug, nodeId, "VERIFIED", note.trim()),
                `${nodeId} marked VERIFIED`,
              ).then((ok) => {
                if (ok) setNote("");
              });
            }}
          >
            Mark VERIFIED
          </button>
        </div>
      </div>
    </div>
  );
}

function MilestoneBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const milestone = state?.milestones[nodeId];
  if (!milestone) return <p className="muted">Unknown milestone.</p>;
  return <div className="detail"><div className="detail-row"><span className="chip">milestone</span><span className="mono small muted">{milestone.taskId}</span></div><h3>{milestone.title}</h3><Markdown>{milestone.markdown}</Markdown></div>;
}

function FactBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const fact = state?.facts[nodeId];
  if (!fact) return <p className="muted">Unknown fact.</p>;
  return <div className="detail"><div className="detail-row"><span className="chip">{fact.status}</span><span className="mono small muted">from {fact.claimId}</span></div><h3 className="section-head">Statement</h3><Markdown>{fact.statement}</Markdown><h3 className="section-head">Verified proof</h3><Markdown>{fact.proofMarkdown}</Markdown></div>;
}

function VerificationBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const verification = state?.verifications[nodeId];
  if (!verification) return <p className="muted">Unknown independent check.</p>;
  if (verification.artifactPath === null || verification.completedAtSeq === null) {
    return <div className="detail"><div className="detail-row"><span className="chip">{verificationDisplayStatus(verification)}</span><span className="mono small muted">claim {verification.claimId}</span></div><Markdown>{verification.summaryMarkdown || (verification.status === "running" ? "This independent check is running." : "This independent check is waiting to run.")}</Markdown></div>;
  }
  const meta: ArtifactMeta = {
    id: verification.id,
    kind: "verification",
    taskId: null,
    path: verification.artifactPath,
    conclusion: verification.verdict,
    recordedAtSeq: verification.completedAtSeq,
  };
  return <ArtifactBodyView slug={slug} meta={meta} />;
}

function CardBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [note, setNote] = useState("");
  const entry = state?.cards[nodeId];
  if (!entry) return <p className="muted">Unknown memory card.</p>;
  const color = CARD_STATUS_COLOR[entry.status] ?? "var(--muted)";

  return (
    <div className="detail">
      <div className="detail-row">
        <span className="chip">{entry.card.type}</span>
        <span className="chip" style={{ color, borderColor: color }}>
          {entry.status}
        </span>
        <span className="muted small">by {entry.proposedBy}</span>
      </div>
      <h3 className="detail-title">{entry.card.title}</h3>
      <Markdown>{entry.card.content}</Markdown>
      <p className="small muted">{entry.card.provenance}</p>
      {entry.admissionReason === null ? null : (
        <p className="small muted">admission: {entry.admissionReason}</p>
      )}
      <div className="answer-form">
        <textarea
          className="textarea"
          rows={2}
          placeholder="quarantine note (required)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row end">
          <button
            type="button"
            className="button danger"
            disabled={guard.disabled || note.trim() === ""}
            title={guard.title ?? "a note is required"}
            onClick={() => {
              void run(() => api.quarantineCard(slug, nodeId, note.trim()), `${nodeId} quarantined`)
                .then((ok) => {
                  if (ok) setNote("");
                });
            }}
          >
            Quarantine
          </button>
        </div>
      </div>
    </div>
  );
}

function IssueBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const issue = state?.issues[nodeId];
  if (!issue) return <p className="muted">Unknown issue.</p>;
  const color = SEVERITY_COLOR[issue.severity];
  return (
    <div className="detail">
      <div className="detail-row">
        <span className="chip" style={{ color, borderColor: color }}>
          {SEVERITY_LETTER[issue.severity]} {issue.severity}
        </span>
        <span className="chip">{issue.status}</span>
        {issue.disposition === null ? null : <span className="chip">{issue.disposition}</span>}
        <span className="muted small">by {issue.by}</span>
      </div>
      <p className="mono small muted">{issue.location}</p>
      <Markdown>{issue.summary}</Markdown>
      {issue.dispositionReason === null ? null : (
        <>
          <h3 className="section-head">Disposition</h3>
          <p className="small">{issue.dispositionReason}</p>
        </>
      )}
    </div>
  );
}

function ObligationBody({ slug, nodeId }: { slug: string; nodeId: string }): JSX.Element {
  const state = useProjectState(slug);
  const [candidateId = "", tail = ""] = nodeId.split(":");
  const index = Number(tail.replace(/^ob/, "")) - 1;
  const candidate = state?.candidates[candidateId];
  const text = candidate?.obligations[index];
  if (text === undefined) return <p className="muted">Unknown obligation.</p>;
  return (
    <div className="detail">
      <div className="detail-row">
        <span className="chip">obligation</span>
        <span className="mono small">{candidateId}</span>
      </div>
      <Markdown>{text}</Markdown>
    </div>
  );
}

export default function ArtifactTab({
  slug,
  nodeId,
  kind,
}: {
  slug: string;
  nodeId: string;
  kind: NodeKind;
}): JSX.Element {
  const state = useProjectState(slug);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    setPick(0);
  }, [nodeId]);

  if (state === null) return <div className="skeleton-bar w90" />;

  if (kind === "question") return <QuestionBody slug={slug} nodeId={nodeId} />;
  if (kind === "claim") return <ClaimBody slug={slug} nodeId={nodeId} />;
  if (kind === "fact") return <FactBody slug={slug} nodeId={nodeId} />;
  if (kind === "verification") return <VerificationBody slug={slug} nodeId={nodeId} />;
  if (kind === "milestone") return <MilestoneBody slug={slug} nodeId={nodeId} />;
  if (kind === "issue") return <IssueBody slug={slug} nodeId={nodeId} />;
  if (kind === "obligation") return <ObligationBody slug={slug} nodeId={nodeId} />;
  if (kind === "card") return <CardBody slug={slug} nodeId={nodeId} />;

  if (kind === "problem") {
    const markdown =
      state.problem.confirmedMarkdown ?? state.problem.normalizedMarkdown ?? state.statement;
    return (
      <div className="detail">
        <div className="detail-row">
          <span className="chip">{state.phase}</span>
          {state.problem.confirmedMarkdown === null ? (
            <span className="muted small">not confirmed</span>
          ) : (
            <span className="ok-check">✓ confirmed</span>
          )}
        </div>
        <Markdown>{markdown}</Markdown>
      </div>
    );
  }

  const ids = artifactIdsFor(state, kind, nodeId);
  if (ids.length === 0) {
    const task = kind === "task" ? state.tasks[nodeId] : undefined;
    return (
      <p className="muted">
        {task && (task.status === "running" || task.status === "queued")
          ? "No artifact yet — the worker is still running."
          : "No artifact recorded for this node."}
      </p>
    );
  }

  const activeId = ids[Math.min(pick, ids.length - 1)] ?? ids[0] ?? "";
  const meta = state.artifacts[activeId];
  const lifecycle = kind === "candidate" ? candidateLifecycle(state, nodeId) : null;

  return (
    <div className="detail">
      {lifecycle === null ? null : (
        <div className="candidate-lifecycle-summary">
          <div className="detail-row">
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
              <span className="muted small">
                source author claimed {lifecycle.authorConclusion}
              </span>
            )}
          </div>
          <p>{lifecycle.detail}</p>
        </div>
      )}
      {ids.length > 1 ? (
        <div className="segmented small">
          {ids.map((id, i) => (
            <button
              key={id}
              type="button"
              className={`segment mono${i === pick ? " on" : ""}`}
              onClick={() => setPick(i)}
            >
              {id}
            </button>
          ))}
        </div>
      ) : null}
      {kind === "task" && state.tasks[nodeId] ? (
        <div className="detail-row muted small">
          budget {formatExact(state.tasks[nodeId]?.budgetTokens ?? 0)} tokens ·{" "}
          {state.tasks[nodeId]?.status}
        </div>
      ) : null}
      {meta ? (
        <ArtifactBodyView slug={slug} meta={meta} sourceClaim={kind === "candidate"} />
      ) : (
        <p className="muted">Unknown artifact.</p>
      )}
    </div>
  );
}
