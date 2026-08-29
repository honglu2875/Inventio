import { useEffect, useMemo, useState } from "react";
import type { QuestionState } from "@inventio/schema";
import Markdown from "../Markdown";
import { api } from "../../lib/api";
import { useActionGuard, useApiAction, useProjectState } from "../../store/hooks";

function interactionTitle(question: QuestionState): string {
  if (question.interaction === "retry") return "Research process recovery needed";
  if (question.interaction === "acknowledge") return "Project notice";
  return question.blocking ? "Research waiting for your answer" : "Research question";
}

export function QuestionActions({
  slug,
  question,
}: {
  slug: string;
  question: QuestionState;
}): JSX.Element {
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (kind: "answer" | "dismiss"): Promise<void> => {
    if (busy || guard.disabled || (kind === "answer" && answer.trim() === "")) return;
    setBusy(true);
    try {
      await run(
        () =>
          kind === "answer"
            ? api.answerQuestion(slug, question.id, answer.trim())
            : api.dismissQuestion(slug, question.id),
        kind === "answer" ? "answer recorded" : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  if (question.interaction !== "answer") {
    const retry = question.interaction === "retry";
    return (
      <div className="question-actions operational-question-actions">
        <p className="muted small">
          {retry
            ? "This is an operational stop, not a request for mathematical input. Retrying keeps the mathematical record unchanged and repeats the failed operation."
            : "This notice does not need a prose answer and does not block the research."}
        </p>
        <div className="row end">
          <button
            type="button"
            className={`button${retry ? " primary" : ""}`}
            disabled={busy || guard.disabled}
            {...(guard.title === undefined ? {} : { title: guard.title })}
            onClick={() => void act("dismiss")}
          >
            {retry ? "Retry" : "Acknowledge"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="question-actions">
      <textarea
        className="textarea"
        value={answer}
        disabled={guard.disabled}
        {...(guard.title === undefined ? {} : { title: guard.title })}
        onChange={(event) => setAnswer(event.target.value)}
        rows={3}
        placeholder="Your answer…"
        aria-label={`answer ${question.id}`}
      />
      <div className="row end">
        <button
          type="button"
          className="button"
          disabled={busy || guard.disabled}
          onClick={() => void act("dismiss")}
        >
          Dismiss &amp; continue
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || guard.disabled || answer.trim() === ""}
          onClick={() => void act("answer")}
        >
          Answer &amp; continue
        </button>
      </div>
    </div>
  );
}

/**
 * Blocking questions live inside the normal project layout. The warning and
 * its exact question therefore remain visible without trapping navigation or
 * hiding the research record behind a modal.
 */
export default function QuestionsToast({ slug }: { slug: string }): JSX.Element | null {
  const state = useProjectState(slug);
  const [opened, setOpened] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const open = useMemo(
    () =>
      Object.values(state?.questions ?? {})
        .filter((question) => question.status === "open")
        .sort(
          (a, b) => Number(b.blocking) - Number(a.blocking) || a.id.localeCompare(b.id),
        ),
    [state],
  );
  const blocking = open.filter((question) => question.blocking);
  const notices = open.filter((question) => !question.blocking);
  const activeBlocking = blocking[0];
  const expanded = notices.find((question) => question.id === opened);
  const blockingKey = blocking.map((question) => question.id).join(",");

  useEffect(() => {
    if (blockingKey !== "") setCollapsed(false);
  }, [blockingKey]);

  if (open.length === 0) return null;

  return (
    <>
      {activeBlocking ? (
        <section
          className={`blocking-question-strip${collapsed ? " collapsed" : ""}`}
          role="region"
          aria-live="assertive"
          aria-labelledby="blocking-question-title"
        >
          <header className="blocking-question-header">
            <span className="blocking-warning" aria-hidden="true">
              !
            </span>
            <div className="blocking-question-heading">
              <span className="eyebrow danger-text">Research paused</span>
              <h2 id="blocking-question-title">
                {activeBlocking.id} · {interactionTitle(activeBlocking)}
              </h2>
            </div>
            {blocking.length > 1 ? (
              <span className="badge danger-badge">+{blocking.length - 1} more</span>
            ) : null}
            <button
              type="button"
              className="button small question-collapse"
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? "Show details" : "Collapse"}
            </button>
          </header>
          {collapsed ? null : (
            <div className="blocking-question-body">
              <div className="exact-question">
                <span className="eyebrow">
                  {activeBlocking.interaction === "retry" ? "Exact failure" : "Exact question"}
                </span>
                <div className="question-copy">
                  <Markdown>{activeBlocking.text}</Markdown>
                </div>
              </div>
              {activeBlocking.context ? (
                <div className="question-context-block">
                  <span className="eyebrow">Context and effect</span>
                  <div className="question-context">
                    <Markdown>{activeBlocking.context}</Markdown>
                  </div>
                </div>
              ) : null}
              <QuestionActions slug={slug} question={activeBlocking} />
            </div>
          )}
        </section>
      ) : null}

      {notices.length > 0 ? (
        <aside className="questions-stack" aria-label="questions inbox">
          {notices.map((question) => (
            <article className="question-toast" key={question.id}>
              <button
                type="button"
                className="question-toast-head"
                onClick={() => setOpened(opened === question.id ? null : question.id)}
              >
                <span className="question-mark" aria-hidden="true">
                  {question.interaction === "answer" ? "?" : "!"}
                </span>
                <span className="mono">{question.id}</span>
                <span>{interactionTitle(question)}</span>
                <span aria-hidden="true">{opened === question.id ? "▾" : "▸"}</span>
              </button>
              {expanded?.id === question.id ? (
                <>
                  <div className="question-toast-copy">
                    <Markdown>{question.text}</Markdown>
                  </div>
                  {question.context ? (
                    <div className="question-context">
                      <Markdown>{question.context}</Markdown>
                    </div>
                  ) : null}
                  <QuestionActions slug={slug} question={question} />
                </>
              ) : null}
            </article>
          ))}
        </aside>
      ) : null}
    </>
  );
}
