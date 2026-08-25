import { useEffect, useMemo, useState } from "react";
import type { ProjectState } from "@inventio/schema";
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
  const remaining =
    state.budget.totalTokens - state.budget.spentTokens - state.budget.plannerSpentTokens;
  const roundsRemaining = Math.max(0, state.config.limits.maxWaves - state.waveOrder.length);
  const suggestedTokens = remaining < state.config.budget.defaultTaskTokens * 2 ? 5_000_000 : 0;
  const suggestedWaves = roundsRemaining < 3 ? 5 : 0;
  const [note, setNote] = useState(DEFAULT_FOCUS);
  const [tokens, setTokens] = useState(String(suggestedTokens));
  const [waves, setWaves] = useState(String(suggestedWaves));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNote(DEFAULT_FOCUS);
    setTokens(String(suggestedTokens));
    setWaves(String(suggestedWaves));
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
      () => api.continueResearch(slug, note.trim(), parsed.addTokens, parsed.addWaves),
      "research continued from the saved checkpoint",
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
            readable. A new research decision will receive that report, the complete existing
            record, and your direction below.
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
            <span className="field-label">What should the research chair push further?</span>
            <textarea
              className="textarea"
              rows={7}
              autoFocus
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
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
            {busy ? "Continuing…" : "Continue from this report"}
          </button>
        </footer>
      </section>
    </div>
  );
}
