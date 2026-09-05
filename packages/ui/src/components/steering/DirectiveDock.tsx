import { useState } from "react";
import { api } from "../../lib/api";
import { truncate } from "../../lib/format";
import { useActionGuard, useApiAction, useProjectState } from "../../store/hooks";

/**
 * Steering dock (UI-SPEC §12): a bottom bar, not a sidebar. One line that
 * grows into a textarea on focus, an Urgent flag, and the recent directives
 * with their consumption status — "pending" until a decision picks them up.
 */
export default function DirectiveDock({ slug }: { slug: string }): JSX.Element {
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [text, setText] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [busy, setBusy] = useState(false);
  const terminal = state?.terminal !== null && state?.terminal !== undefined;

  const recent = (state?.directiveOrder ?? [])
    .slice(-8)
    .reverse()
    .map((id) => state?.directives[id])
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
  const pending = recent.filter((d) => d.status === "pending").length;

  const send = (): void => {
    const body = text.trim();
    if (body === "" || busy) return;
    setBusy(true);
    void run(() => api.submitDirective(slug, body, urgent), "directive queued")
      .then((result) => {
        if (result) {
          setText("");
          setUrgent(false);
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="dock">
      <div className="dock-row">
        <textarea
          className={`textarea dock-input${focused ? " expanded" : ""}`}
          rows={focused ? 3 : 1}
          placeholder={
            terminal
              ? "This run has a saved stopping report — use “Continue research” above to add a new direction."
              : "Direction for the research chair — e.g. “drop the spectral approach, focus on the combinatorial bound”"
          }
          disabled={terminal}
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {state?.config.workflow === "recurrent-v3" ? null : <label className="checkbox small" title="jump the queue at the next decision">
          <input type="checkbox" checked={urgent} disabled={terminal} onChange={(e) => setUrgent(e.target.checked)} />
          Urgent
        </label>}
        <button
          type="button"
          className="button primary"
          disabled={busy || terminal || text.trim() === "" || guard.disabled}
          {...(guard.title === undefined ? {} : { title: guard.title })}
          onClick={send}
        >
          Send
        </button>
        <button
          type="button"
          className="disclosure"
          aria-expanded={showRecent}
          onClick={() => setShowRecent((v) => !v)}
        >
          {showRecent ? "▾" : "▸"} Recent{pending > 0 ? ` · ${pending} pending` : ""}
        </button>
      </div>
      {showRecent ? (
        <ul className="directive-list">
          {recent.length === 0 ? (
            <li className="muted small">No directives yet.</li>
          ) : (
            recent.map((directive) => (
              <li key={directive.id} className="directive-row">
                <span className="mono small">{directive.id}</span>
                {directive.urgent ? <span className="badge warn">urgent</span> : null}
                <span className="directive-text" title={directive.text}>
                  {truncate(directive.text, 90)}
                </span>
                {directive.status === "pending" ? (
                  <span className="badge pending">pending</span>
                ) : (
                  <span className="badge muted-badge">
                    consumed by {directive.consumedByDecision ?? "—"}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
