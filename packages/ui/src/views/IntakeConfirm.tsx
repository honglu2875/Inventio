import { useEffect, useState } from "react";
import {
  INTAKE_ABSTRACT_MAX_CHARS,
  type IntakeSource,
  type ProjectState,
} from "@inventio/schema";
import Markdown from "../components/Markdown";
import SourceDropzone from "../components/SourceDropzone";
import { API_BASE, api } from "../lib/api";
import { useActionGuard, useApiAction } from "../store/hooks";

function sourceOriginal(state: ProjectState, source: IntakeSource): string | null {
  if (source.kind === "objective") return state.statement;
  if (source.kind === "background") return state.contextMarkdown;
  return null;
}

function SourceCatalog({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  if (state.problem.sources.length === 0) {
    return <p className="muted small">The original objective is retained with the project.</p>;
  }
  return (
    <div className="intake-source-catalog">
      {state.problem.sources.map((source) => {
        const original = sourceOriginal(state, source);
        const uploadName = source.kind === "upload" ? source.relativePath.split("/").at(-1) : null;
        const uploadUrl = uploadName
          ? `${API_BASE}/projects/${encodeURIComponent(slug)}/sources/${encodeURIComponent(uploadName)}`
          : null;
        return (
          <details className="intake-source-card" key={source.id}>
            <summary>
              <span className="mono">{source.id}</span>
              <span>
                <strong>{source.title}</strong>
                <small>{source.abstract}</small>
              </span>
            </summary>
            <div className="intake-source-body">
              {source.excerptMarkdown.trim() ? (
                <div className="intake-source-excerpt"><Markdown>{source.excerptMarkdown}</Markdown></div>
              ) : null}
              {original !== null ? (
                <details>
                  <summary>Open verbatim text</summary>
                  <pre className="statement-source">{original}</pre>
                </details>
              ) : uploadUrl !== null ? (
                <a className="button ghost" href={uploadUrl} target="_blank" rel="noreferrer">
                  Open original file
                </a>
              ) : null}
              <p className="mono muted small">sha256 {source.sha256}</p>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function DraftIntake({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const run = useApiAction();
  const guard = useActionGuard(slug);
  const [starting, setStarting] = useState(false);

  const start = async (): Promise<void> => {
    if (starting || guard.disabled) return;
    setStarting(true);
    try {
      await run(() => api.start(slug), "Research Manager is reading the submitted materials");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="intake-confirm" aria-labelledby="intake-draft-title">
      <header className="section-header intake-header">
        <div>
          <span className="eyebrow">Raw intake</span>
          <h1 id="intake-draft-title">Check the submitted materials</h1>
          <p>Everything here is stored before the Research Manager reads it. Add or correct files, then generate W000.</p>
        </div>
      </header>
      <div className="intake-raw-grid">
        <article className="intake-pane">
          <h2>Original objective</h2>
          <pre className="statement-source">{state.statement}</pre>
          {state.contextMarkdown ? (
            <>
              <h2>Background and ideas</h2>
              <pre className="statement-source">{state.contextMarkdown}</pre>
            </>
          ) : null}
        </article>
        <article className="intake-pane">
          <h2>Supplementary files</h2>
          <SourceDropzone slug={slug} />
        </article>
      </div>
      <footer className="intake-actions">
        <span className="muted small">No model has read or summarized these materials yet.</span>
        <button
          type="button"
          className="button primary"
          disabled={starting || guard.disabled}
          {...(guard.title === undefined ? {} : { title: guard.title })}
          onClick={() => void start()}
        >
          {starting ? "Starting…" : "Generate W000"}
        </button>
      </footer>
    </section>
  );
}

/** One Research Manager draft, directly editable before discovery begins. */
function W000Review({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const w000 = state.researchManagerNotes.find((note) => note.waveId === "W000");
  const legacyView = state.problem.contextDigestMarkdown.trim() || state.problem.normalizedMarkdown || state.statement;
  const initialAbstract = w000?.abstract ?? "";
  const initialMarkdown = w000?.markdown.trim() || legacyView;
  const version = `${w000?.recordedAtSeq ?? 0}:${initialAbstract}:${initialMarkdown}`;
  const [abstract, setAbstract] = useState(initialAbstract);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const managerModel = state.config.models.researchManager;
  const modelLabel = `${managerModel.model ?? "account default"} · ${managerModel.effort}`;
  const sourceCount = state.problem.sources.length;
  const problemMarkdown = state.problem.normalizedMarkdown ?? state.statement;
  const dirty = abstract.trim() !== initialAbstract.trim() || markdown.trim() !== initialMarkdown.trim();
  const abstractTooLong = abstract.length > INTAKE_ABSTRACT_MAX_CHARS;

  useEffect(() => {
    setAbstract(initialAbstract);
    setMarkdown(initialMarkdown);
    // A newly recorded W000 is the only external reseed; local edits remain local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const confirm = async (): Promise<void> => {
    if (abstractTooLong || markdown.trim() === "" || submitting || regenerating || guard.disabled) return;
    setSubmitting(true);
    try {
      await run(
        () => api.confirmProblem(
          slug,
          problemMarkdown,
          undefined,
          undefined,
          abstract.trim(),
          markdown.trim(),
        ),
        "W000 accepted — research beginning",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const regenerate = async (): Promise<void> => {
    if (submitting || regenerating || guard.disabled) return;
    setRegenerating(true);
    try {
      await run(() => api.regenerateIntake(slug), "W000 regenerated from the original materials");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <section className="intake-confirm w000-review" aria-labelledby="w000-title">
      <header className="section-header intake-header">
        <div>
          <span className="eyebrow">Research Manager · W000</span>
          <h1 id="w000-title">Current mathematical view</h1>
          <p>Edit this reading directly. It becomes the Manager's starting point for choosing and briefing researchers.</p>
        </div>
        <span className="chip ok" title="One Research Manager reading; no workers have been dispatched">{modelLabel}</span>
      </header>

      <div className="w000-editor-grid">
        <article className="intake-pane w000-editor">
          <label className="field">
            <span className="field-label w000-abstract-label">
              <span>Abstract <em>one or two complete sentences</em></span>
              <span className={abstractTooLong ? "char-count over" : "char-count"}>
                {abstract.length}/{INTAKE_ABSTRACT_MAX_CHARS}
              </span>
            </span>
            <textarea
              className="w000-abstract-editor"
              maxLength={INTAKE_ABSTRACT_MAX_CHARS}
              value={abstract}
              disabled={submitting || regenerating}
              onChange={(event) => setAbstract(event.target.value)}
              aria-label="W000 abstract"
              aria-invalid={abstractTooLong}
            />
            {abstractTooLong ? (
              <span className="field-error">
                Shorten this abstract before beginning research. Put details in W000.
              </span>
            ) : null}
          </label>
          <label className="field">
            <span className="field-label">W000</span>
            <textarea
              className="w000-markdown-editor"
              maxLength={16_000}
              value={markdown}
              disabled={submitting || regenerating}
              spellCheck={false}
              onChange={(event) => setMarkdown(event.target.value)}
              aria-label="W000 current mathematical view"
            />
          </label>
          {dirty ? <span className="muted small">Edited locally; changes are saved when research begins.</span> : null}
        </article>

        <article className="intake-pane w000-rendered">
          <div className="pane-heading"><h2>Preview</h2><span className="muted small">rendered mathematics</span></div>
          {abstract.trim() ? <p className="w000-abstract-preview">{abstract}</p> : null}
          <Markdown>{markdown}</Markdown>
        </article>
      </div>

      <section className="intake-materials">
        <div className="pane-heading">
          <div><h2>Original materials</h2><span className="muted small">{sourceCount} retained source{sourceCount === 1 ? "" : "s"}</span></div>
        </div>
        <SourceCatalog slug={slug} state={state} />
      </section>

      <footer className="intake-actions">
        <button
          type="button"
          className="button"
          disabled={submitting || regenerating || guard.disabled}
          title={dirty ? "Regeneration replaces your unsaved edits" : (guard.title ?? "Read the original materials again")}
          onClick={() => void regenerate()}
        >
          {regenerating ? "Regenerating…" : "Regenerate from originals"}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={abstractTooLong || markdown.trim() === "" || submitting || regenerating || guard.disabled}
          {...(guard.title === undefined ? {} : { title: guard.title })}
          onClick={() => void confirm()}
        >
          {submitting ? "Saving…" : "Accept W000 & begin research"}
        </button>
      </footer>
    </section>
  );
}

export default function IntakeConfirm(props: { slug: string; state: ProjectState }): JSX.Element {
  return props.state.phase === "CREATED" ? <DraftIntake {...props} /> : <W000Review {...props} />;
}
