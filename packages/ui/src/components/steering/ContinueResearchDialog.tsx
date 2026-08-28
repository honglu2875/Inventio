import { useEffect, useMemo, useState } from "react";
import { nextContinuationRevisionId, type ProjectState } from "@inventio/schema";
import { api } from "../../lib/api";
import { formatExact, formatTokens } from "../../lib/format";
import { useActionGuard, useApiAction } from "../../store/hooks";

const DEFAULT_FOCUS =
  "Keep exploring materially different approaches. Prioritize concrete lemmas, obstructions, examples, reductions, and independently checked partial results before considering another stop.";

export default function ContinueResearchDialog({
  slug,
  state,
  onClose,
}: {
  slug: string;
  state: ProjectState;
  onClose: () => void;
}): JSX.Element {
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const isTrajectory = state.config.workflow === "trajectories-v2";
  const remaining =
    state.budget.totalTokens - state.budget.spentTokens - state.budget.plannerSpentTokens;
  const roundsRemaining = Math.max(0, state.config.limits.maxWaves - state.waveOrder.length);
  const suggestedTokens = remaining < state.config.budget.defaultTaskTokens * 2 ? 5_000_000 : 0;
  const suggestedWaves = roundsRemaining < 3 ? 5 : 0;
  const revisionId = nextContinuationRevisionId(state);
  const [note, setNote] = useState(DEFAULT_FOCUS);
  const [tokens, setTokens] = useState(String(suggestedTokens));
  const [waves, setWaves] = useState(String(suggestedWaves));
  const [useDirectView, setUseDirectView] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNote(DEFAULT_FOCUS);
    setTokens(String(suggestedTokens));
    setWaves(String(suggestedWaves));
    setUseDirectView(false);
  }, [state.terminal?.finalPath, suggestedTokens, suggestedWaves]);

  const parsed = useMemo(() => {
    const addTokens = Number(tokens);
    const addWaves = Number(waves);
    return {
      addTokens,
      addWaves,
      valid:
        Number.isSafeInteger(addTokens) &&
        addTokens >= 0 &&
        addTokens <= 100_000_000 &&
        Number.isSafeInteger(addWaves) &&
        addWaves >= 0 &&
        addWaves <= 100,
    };
  }, [tokens, waves]);

  const submit = (): void => {
    if (busy || guard.disabled || note.trim() === "" || !parsed.valid) return;
    setBusy(true);
    void run(
      () =>
        api.continueResearch(
          slug,
          note.trim(),
          parsed.addTokens,
          parsed.addWaves,
          !isTrajectory && useDirectView ? note.trim() : undefined,
        ),
      isTrajectory
        ? "Direction saved for the next independent research trajectories"
        : useDirectView
        ? `${revisionId} was recorded before the next research round`
        : `${revisionId} is being prepared before the next research round`,
    )
      .then((result) => {
        if (result) onClose();
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal continue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="continue-research-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <span className="eyebrow">Continue from a checkpoint</span>
            <h2 id="continue-research-title">Continue research</h2>
          </div>
          <button type="button" className="icon-button" aria-label="close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <p>
            The current <strong>{state.terminal?.result}</strong> report stays immutable and
            readable. {isTrajectory ? (
              <>
                Your direction below will be supplied verbatim to every Solver and Explorer in the
                next research round, together with the current mathematical view and library.
              </>
            ) : useDirectView ? (
              <>
                Your text will be recorded directly as <strong>{revisionId}</strong> before the
                next research round is chosen.
              </>
            ) : (
              <>
                The Research Manager will first revise its current mathematical view as
                <strong> {revisionId}</strong>, using that report, the preceding view, and your
                complete direction below. Only then will it choose the next research round.
              </>
            )}
          </p>
          <div className="continuation-summary">
            <span>
              <strong>{formatTokens(Math.max(0, remaining))}</strong>
              <small>tokens currently available</small>
            </span>
            <span>
              <strong>{roundsRemaining}</strong>
              <small>rounds currently available</small>
            </span>
            <span>
              <strong>{state.terminalHistory.length}</strong>
              <small>saved stopping report{state.terminalHistory.length === 1 ? "" : "s"}</small>
            </span>
          </div>
          <label className="field">
            <span className="field-label">
              {useDirectView
                ? `Write the complete revised mathematical view for ${revisionId}`
                : isTrajectory
                  ? "What should the next independent trajectories pursue or reconsider?"
                  : "What should the Research Manager reconsider or push further?"}
            </span>
            <textarea
              className="textarea"
              rows={7}
              autoFocus
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {!isTrajectory ? <label className="continuation-direct-view">
            <input
              type="checkbox"
              checked={useDirectView}
              disabled={busy}
              onChange={(event) => setUseDirectView(event.target.checked)}
            />
            <span>
              My text is already the complete revised mathematical view; record it directly
              instead of asking the Research Manager to rewrite it.
            </span>
          </label> : null}
          <div className="continuation-fields">
            <label className="field">
              <span className="field-label">Add to token ceiling</span>
              <input
                className="input mono"
                inputMode="numeric"
                value={tokens}
                onChange={(event) => setTokens(event.target.value)}
              />
              <span className="muted small">
                {parsed.valid ? `new ceiling: ${formatExact(state.budget.totalTokens + parsed.addTokens)}` : "enter 0–100,000,000"}
              </span>
            </label>
            <label className="field">
              <span className="field-label">Add research rounds</span>
              <input
                className="input mono"
                inputMode="numeric"
                value={waves}
                onChange={(event) => setWaves(event.target.value)}
              />
              <span className="muted small">
                {parsed.valid ? `new maximum: ${state.config.limits.maxWaves + parsed.addWaves}` : "enter 0–100"}
              </span>
            </label>
          </div>
          <p className="muted small">
            Enter zero for either extension when the existing allowance is enough. Continuing does
            not erase the earlier conclusion or automatically repeat discarded approaches.
          </p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || guard.disabled || note.trim() === "" || !parsed.valid}
            {...(guard.title === undefined ? {} : { title: guard.title })}
            onClick={submit}
          >
            {busy
              ? !isTrajectory && useDirectView
                ? "Recording revision…"
                : "Continuing…"
              : !isTrajectory && useDirectView
                ? `Record ${revisionId} and continue`
                : isTrajectory
                  ? "Continue with this direction"
                  : `Prepare ${revisionId} and continue`}
          </button>
        </footer>
      </section>
    </div>
  );
}
