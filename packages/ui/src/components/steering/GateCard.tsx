import { useEffect, useRef, useState } from "react";
import { validateActionEnvelope } from "@inventio/schema";
import { api } from "../../lib/api";
import { formatExact, truncate } from "../../lib/format";
import { ROLE_COLOR, ROLE_GLYPH } from "../../lib/visual";
import { useActionGuard, useApiAction, useProjectState } from "../../store/hooks";

/**
 * Proposed-move review (UI-SPEC §12). Non-dismissable while gated autonomy
 * waits for the owner, but
 * movable, because the proposed action usually needs checking against the
 * graph behind it. Edit hands you the raw envelope with client-side
 * validation, so a malformed edit never reaches the conductor.
 */

type Mode = "view" | "edit" | "reject";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function RosterTable({ plan }: { plan: Record<string, unknown> }): JSX.Element {
  const tasks = Array.isArray(plan["tasks"]) ? (plan["tasks"] as unknown[]) : [];
  return (
    <>
      <div className="field-row">
        <span className="field-label">Title</span>
        <span>{str(plan, "title")}</span>
      </div>
      <div className="field-row">
        <span className="field-label">Reserve</span>
        <span className="mono">{formatExact(num(plan, "reserveTokens"))}</span>
      </div>
      <div className="field-row">
        <span className="field-label">Rationale</span>
        <span>{str(plan, "rationale")}</span>
      </div>
      <table className="table roster-table">
        <thead>
          <tr>
            <th>role</th>
            <th>method</th>
            <th>direction</th>
            <th>budget</th>
            <th>reviews</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((raw, i) => {
            const task = isRecord(raw) ? raw : {};
            const role = str(task, "role");
            const glyph = ROLE_GLYPH[role as keyof typeof ROLE_GLYPH] ?? "•";
            const color = ROLE_COLOR[role as keyof typeof ROLE_COLOR] ?? "var(--muted)";
            return (
              <tr key={i}>
                <td>
                  <span style={{ color }}>{glyph}</span> {role}
                </td>
                <td className="mono">{str(task, "methodTag")}</td>
                <td title={str(task, "direction")}>{truncate(str(task, "direction"), 70)}</td>
                <td className="mono">{formatExact(num(task, "tokenBudget"))}</td>
                <td className="mono">{str(task, "reviewOf") || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function ActionSummary({ action }: { action: unknown }): JSX.Element {
  if (!isRecord(action)) return <pre className="code-view mono">{JSON.stringify(action, null, 2)}</pre>;
  const name = str(action, "action");
  const variant = action[name];
  if (name === "plan_wave" && isRecord(variant)) return <RosterTable plan={variant} />;
  if (!isRecord(variant)) {
    return <pre className="code-view mono">{JSON.stringify(action, null, 2)}</pre>;
  }
  return (
    <div className="field-list">
      {Object.entries(variant).map(([key, value]) => (
        <div key={key} className="field-row">
          <span className="field-label">{key}</span>
          <span className={typeof value === "string" ? "" : "mono"}>
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function GateCard({
  slug,
  decisionId,
}: {
  slug: string;
  decisionId: string;
}): JSX.Element | null {
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const decision = state?.decisions[decisionId];

  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setMode("view");
    setErrors([]);
    setNote("");
  }, [decisionId]);

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const start = drag.current;
      if (!start) return;
      setOffset({ x: event.clientX - start.x, y: event.clientY - start.y });
    };
    const onUp = (): void => {
      drag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!decision) return null;

  const resolve = (
    resolution: "approve" | "edit" | "reject",
    action?: unknown,
    reason?: string,
  ): void => {
    setBusy(true);
    void run(
      () => api.resolveGate(slug, decisionId, resolution, action, reason),
      resolution === "reject" ? "sent back for reconsideration" : "next move recorded",
    ).finally(() => setBusy(false));
  };

  const startEdit = (): void => {
    setDraft(JSON.stringify(decision.action, null, 2));
    setErrors([]);
    setMode("edit");
  };

  const submitEdit = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setErrors([`not valid JSON: ${err instanceof Error ? err.message : String(err)}`]);
      return;
    }
    const check = validateActionEnvelope(parsed);
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors([]);
    resolve("edit", check.envelope);
  };

  return (
    <div className="modal-backdrop gate-backdrop" role="presentation">
      <div
        className="modal gate-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`proposed next move ${decisionId}`}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <header
          className="modal-head draggable"
          onMouseDown={(event) => {
            drag.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
          }}
        >
          <h2>
            Proposed next move · <span className="mono">{decisionId}</span>
          </h2>
          <span className="chip">owner review</span>
          {decision.waveId === null ? null : <span className="mono small">{decision.waveId}</span>}
        </header>

        <div className="modal-body">
          {mode === "view" ? (
            <>
              <p className="muted small">
                The research chair proposes this next step. Let it proceed, edit its details, or
                explain what should be reconsidered.
              </p>
              <ActionSummary action={decision.action} />
              {decision.violations.length === 0 ? null : (
                <div className="banner warn">
                  An earlier draft could not be used: {decision.violations.flat().join("; ")}
                </div>
              )}
            </>
          ) : null}

          {mode === "edit" ? (
            <>
              <p className="muted small">
                Advanced edit: this structured description is checked before the move can proceed.
              </p>
              <textarea
                className="textarea mono gate-editor"
                rows={18}
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              {errors.length === 0 ? null : (
                <ul className="banner danger error-list">
                  {errors.map((message, i) => (
                    <li key={i}>{message}</li>
                  ))}
                </ul>
              )}
            </>
          ) : null}

          {mode === "reject" ? (
            <>
              <p className="muted small">
                What should the research chair reconsider? Your note is read before a different
                move is chosen.
              </p>
              <textarea
                className="textarea"
                rows={5}
                placeholder="For example: pursue the local lemma first, or avoid repeating the previous route…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          ) : null}
        </div>

        <footer className="modal-foot">
          {mode === "view" ? (
            <>
              <button
                type="button"
                className="button danger"
                disabled={busy || guard.disabled}
                {...(guard.title === undefined ? {} : { title: guard.title })}
                onClick={() => setMode("reject")}
              >
                Choose a different move
              </button>
              <button
                type="button"
                className="button"
                disabled={busy || guard.disabled}
                {...(guard.title === undefined ? {} : { title: guard.title })}
                onClick={startEdit}
              >
                Edit details
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || guard.disabled}
                {...(guard.title === undefined ? {} : { title: guard.title })}
                onClick={() => resolve("approve")}
              >
                Let it proceed
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button" onClick={() => setMode("view")}>
                Back
              </button>
              {mode === "edit" ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || guard.disabled}
                  {...(guard.title === undefined ? {} : { title: guard.title })}
                  onClick={submitEdit}
                >
                  Validate &amp; approve edit
                </button>
              ) : (
                <button
                  type="button"
                  className="button danger"
                  disabled={busy || guard.disabled || note.trim() === ""}
                  title={guard.title ?? "a note is required"}
                  onClick={() => resolve("reject", undefined, note.trim())}
                >
                  Send back for reconsideration
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
