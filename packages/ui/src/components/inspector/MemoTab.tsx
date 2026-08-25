import { useEffect, useState } from "react";
import type { Memo } from "@inventio/schema";
import Markdown from "../Markdown";
import MathText from "../MathText";
import { api, errorMessage } from "../../lib/api";
import { CARD_STATUS_COLOR, SEVERITY_COLOR, SEVERITY_LETTER } from "../../lib/visual";
import { useProjectState } from "../../store/hooks";

/**
 * Memo tab (UI-SPEC §7.3): the structured worker return. Empty sections are
 * omitted; proposed cards are joined to their admission outcome from
 * `state.cards`, which is the only place that outcome exists.
 */

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}): JSX.Element | null {
  if (count === 0) return null;
  return (
    <section className="memo-section">
      <h3 className="section-head">
        {title} <span className="muted small">({count})</span>
      </h3>
      {children}
    </section>
  );
}

export default function MemoTab({ slug, taskId }: { slug: string; taskId: string }): JSX.Element {
  const state = useProjectState(slug);
  const [memo, setMemo] = useState<Memo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void api
      .task(slug, taskId)
      .then((detail) => {
        if (!live) return;
        setMemo(detail.memo);
        setError(null);
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [slug, taskId]);

  if (error !== null) return <div className="banner danger">{error}</div>;
  if (loading) return <div className="skeleton-bar w90" />;
  if (memo === null) return <p className="muted">No memo yet — the task has not returned.</p>;

  /** Card admission outcome, matched on the proposal title (§7.3). */
  const admission = (title: string): { status: string; reason: string | null } | null => {
    if (!state) return null;
    const hit = Object.values(state.cards).find(
      (c) => c.proposedBy === taskId && c.card.title === title,
    );
    return hit ? { status: hit.status, reason: hit.admissionReason } : null;
  };

  return (
    <div className="memo">
      <Markdown>{memo.summary}</Markdown>

      <Section title="New claims" count={memo.newClaims.length}>
        <dl className="deflist">
          {memo.newClaims.map((claim, i) => (
            <div key={i} className="deflist-row">
              <dt>
                <MathText>{claim.statement}</MathText>
              </dt>
              <dd>
                <span className="chip">{claim.evidence}</span>
                <span className="mono small muted">{claim.where}</span>
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Issues" count={memo.issues.length}>
        <dl className="deflist">
          {memo.issues.map((issue, i) => (
            <div key={i} className="deflist-row">
              <dt>
                <span
                  className="chip"
                  style={{ color: SEVERITY_COLOR[issue.severity], borderColor: SEVERITY_COLOR[issue.severity] }}
                >
                  {SEVERITY_LETTER[issue.severity]} {issue.severity}
                </span>{" "}
                <MathText>{issue.summary}</MathText>
              </dt>
              <dd>
                <span className="mono small muted">{issue.location}</span>
                {issue.repairHint === "" ? null : (
                  <div className="small">
                    <MathText>{issue.repairHint}</MathText>
                  </div>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Obligations" count={memo.obligations.length}>
        <ul className="bullets">
          {memo.obligations.map((text, i) => (
            <li key={i}>
              <MathText>{text}</MathText>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Dead ends" count={memo.deadEnds.length}>
        <ul className="bullets">
          {memo.deadEnds.map((text, i) => (
            <li key={i}>
              <MathText>{text}</MathText>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Proposed cards" count={memo.proposedCards.length}>
        <dl className="deflist">
          {memo.proposedCards.map((card, i) => {
            const outcome = admission(card.title);
            const color = outcome ? CARD_STATUS_COLOR[outcome.status] ?? "var(--muted)" : "var(--muted)";
            return (
              <div key={i} className="deflist-row">
                <dt>
                  <span className="chip">{card.type}</span> <MathText>{card.title}</MathText>
                </dt>
                <dd>
                  <div className="small">
                    <MathText>{card.abstract}</MathText>
                  </div>
                  {outcome === null ? (
                    <span className="muted small">not admitted</span>
                  ) : (
                    <span className="chip" style={{ color, borderColor: color }} title={outcome.reason ?? ""}>
                      {outcome.status}
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </Section>

      <Section title="Computations" count={memo.computations.length}>
        <dl className="deflist">
          {memo.computations.map((comp, i) => (
            <div key={i} className="deflist-row">
              <dt className="mono">{comp.entry}</dt>
              <dd>
                <div className="small">{comp.inputs}</div>
                <div className="small muted">{comp.outputsDescription}</div>
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Budget report" count={memo.budgetReport === "" ? 0 : 1}>
        <p className="small">{memo.budgetReport}</p>
      </Section>
    </div>
  );
}
