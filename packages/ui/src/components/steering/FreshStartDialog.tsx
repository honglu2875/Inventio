import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectState } from "@inventio/schema";
import { api } from "../../lib/api";
import { useActionGuard, useApiAction } from "../../store/hooks";

function comparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export default function FreshStartDialog({
  slug,
  state,
  onClose,
}: {
  slug: string;
  state: ProjectState;
  onClose: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmedTitle = title.trim();
  const sameTitle = useMemo(
    () => trimmedTitle !== "" && comparable(trimmedTitle) === comparable(state.title),
    [state.title, trimmedTitle],
  );

  const submit = (): void => {
    if (busy || guard.disabled || trimmedTitle === "" || sameTitle) return;
    setBusy(true);
    void run(() => api.cloneIntake(slug, trimmedTitle), "fresh project created from the intake")
      .then((created) => {
        if (!created) return;
        // ProjectLayout is reused when only :slug changes, so close the local
        // modal before navigating or it would reappear over the new project.
        onClose();
        navigate(`/p/${created.slug}`);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <section
        className="modal continue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fresh-start-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <span className="eyebrow">Retry from intake only</span>
            <h2 id="fresh-start-title">Create a fresh project</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="close"
            disabled={busy}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="modal-body">
          <p>
            This copies the original objective, background, uploaded intake documents, W000, and
            research settings from <strong>{state.title}</strong>. The copy opens at the editable
            W000 preview before a new run begins.
          </p>
          <p className="muted small">
            Research rounds, claims, later library notes, write-ups, computations, events, and
            external filesystem mounts are not copied. The original project is not changed.
          </p>
          <label className="field">
            <span className="field-label">New project title</span>
            <input
              className="input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder={`${state.title} — fresh attempt`}
              aria-invalid={sameTitle}
            />
            <span className={sameTitle ? "field-error small" : "muted small"}>
              {sameTitle
                ? "Use a different title so the new project is unmistakable."
                : "A different title is required; its project ID is generated automatically."}
            </span>
          </label>
        </div>
        <footer className="modal-foot">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || guard.disabled || trimmedTitle === "" || sameTitle}
            {...(guard.title === undefined ? {} : { title: guard.title })}
            onClick={submit}
          >
            {busy ? "Creating…" : "Create fresh project"}
          </button>
        </footer>
      </section>
    </div>
  );
}
