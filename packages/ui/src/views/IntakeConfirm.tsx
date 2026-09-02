import { useCallback, useEffect, useState } from "react";
import {
  INTAKE_ABSTRACT_MAX_CHARS,
  pendingIntakeDecision,
  type IntakeSource,
  type ProjectState,
} from "@inventio/schema";
import Markdown from "../components/Markdown";
import SourceDropzone from "../components/SourceDropzone";
import { api, projectSourceLink } from "../lib/api";
import { isProjectExport } from "../lib/projectExport";
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
        const upload = uploadName ? projectSourceLink(slug, uploadName) : null;
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
              ) : upload?.href ? (
                <a className="button ghost" href={upload.href} target="_blank" rel="noreferrer">
                  Open original file
                </a>
              ) : upload?.omittedReason ? (
                <p className="muted small">Original file omitted: {upload.omittedReason}</p>
              ) : null}
              <p className="mono muted small">sha256 {source.sha256}</p>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function RawIntakeEditor({
  slug,
  state,
  onBack,
  onGenerated,
}: {
  slug: string;
  state: ProjectState;
  onBack?: () => void;
  onGenerated?: () => void;
}): JSX.Element {
  const run = useApiAction();
  const guard = useActionGuard(slug);
  const [statement, setStatement] = useState(state.statement);
  const [contextMarkdown, setContextMarkdown] = useState(state.contextMarkdown);
  const [working, setWorking] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [filesChanged, setFilesChanged] = useState(false);
  const isFirstReading = state.phase === "CREATED";
  const textChanged = statement !== state.statement || contextMarkdown !== state.contextMarkdown;
  const valid = statement.trim() !== "";
  const markFilesChanged = useCallback(() => setFilesChanged(true), []);

  const saveAndGenerate = async (): Promise<void> => {
    if (!valid || working || sourceBusy || guard.disabled) return;
    setWorking(true);
    try {
      const result = await run(
        async () => {
          await api.updateRawIntake(slug, statement, contextMarkdown);
          return isFirstReading ? api.start(slug) : api.regenerateIntake(slug);
        },
        isFirstReading
          ? "Raw intake saved — drafting W000"
          : "Raw intake saved — W000 regenerated from the revised materials",
      );
      if (result !== null) onGenerated?.();
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="intake-confirm" aria-labelledby="intake-draft-title">
      <header className="section-header intake-header">
        <div>
          <span className="eyebrow">Raw intake</span>
          <h1 id="intake-draft-title">
            {isFirstReading ? "Check the submitted materials" : "Revise the original materials"}
          </h1>
          <p>
            {isFirstReading
              ? "Everything here is stored before the initial mathematical reading. Revise the text or files, then generate W000."
              : "Revise the original submission, then generate a fresh W000 from it."}
          </p>
        </div>
      </header>
      <div className="intake-raw-grid">
        <article className="intake-pane">
          <label className="field">
            <span className="field-label">Objective</span>
            <textarea
              className="raw-intake-textarea"
              maxLength={100_000}
              value={statement}
              disabled={working}
              spellCheck={false}
              onChange={(event) => setStatement(event.target.value)}
              aria-label="Raw mathematical objective"
            />
            {!valid ? <span className="field-error">The objective cannot be empty.</span> : null}
          </label>
          <label className="field">
            <span className="field-label">Background, literature, and existing ideas <em>(optional)</em></span>
            <textarea
              className="raw-intake-textarea background"
              maxLength={300_000}
              value={contextMarkdown}
              disabled={working}
              spellCheck={false}
              onChange={(event) => setContextMarkdown(event.target.value)}
              aria-label="Raw background, literature, and existing ideas"
            />
          </label>
        </article>
        <article className="intake-pane">
          <h2>Supplementary files</h2>
          <p className="muted small">
            Before W000 is accepted, retained files may be replaced under the same name or removed.
            File changes are saved immediately and recorded in the next source index.
          </p>
          <SourceDropzone
            slug={slug}
            disabled={working}
            disabledReason="Wait for W000 generation to finish"
            onBusyChange={setSourceBusy}
            onFilesChanged={markFilesChanged}
          />
        </article>
      </div>
      <footer className="intake-actions">
        <span className="muted small">
          {sourceBusy
            ? "Wait for the current file upload to finish."
            : textChanged || filesChanged
              ? "The revised materials will replace the current basis for W000."
              : isFirstReading
                ? "No model has read or summarized these materials yet."
                : "Nothing has been changed yet."}
        </span>
        <div className="intake-action-buttons">
          {onBack === undefined ? null : (
            <button
              type="button"
              className="button ghost"
              disabled={working || sourceBusy}
              onClick={onBack}
              title={filesChanged ? "File changes are already saved; regenerate W000 before accepting it" : "Return without saving text edits"}
            >
              Back to W000
            </button>
          )}
          <button
            type="button"
            className="button primary"
            disabled={!valid || working || sourceBusy || guard.disabled}
            {...(guard.title === undefined ? {} : { title: guard.title })}
            onClick={() => void saveAndGenerate()}
          >
            {working
              ? (isFirstReading ? "Generating…" : "Regenerating…")
              : (isFirstReading ? "Generate W000" : "Save & regenerate W000")}
          </button>
        </div>
      </footer>
    </section>
  );
}

function DraftIntake(props: { slug: string; state: ProjectState }): JSX.Element {
  return <RawIntakeEditor {...props} />;
}

function StaticIntake({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const views =
    state.config.workflow === "trajectories-v2"
      ? state.mathematicalViews
      : state.researchManagerNotes;
  const w000 = views.find((note) => note.waveId === "W000");
  return (
    <section className="intake-confirm w000-review" aria-labelledby="static-intake-title">
      <header className="section-header intake-header">
        <div>
          <span className="eyebrow">Project snapshot</span>
          <h1 id="static-intake-title">{w000 ? "Current mathematical view" : "Submitted materials"}</h1>
          <p>This is the project record at the time the portable HTML view was exported.</p>
        </div>
      </header>
      {w000 ? (
        <article className="intake-pane w000-rendered">
          {w000.abstract ? <p className="w000-abstract-preview">{w000.abstract}</p> : null}
          <Markdown>{w000.markdown}</Markdown>
        </article>
      ) : (
        <article className="intake-pane">
          <h2>Objective</h2>
          <pre className="statement-source">{state.statement}</pre>
          {state.contextMarkdown ? (
            <>
              <h2>Background, literature, and existing ideas</h2>
              <pre className="statement-source">{state.contextMarkdown}</pre>
            </>
          ) : null}
        </article>
      )}
      <section className="intake-materials">
        <div className="pane-heading">
          <div>
            <h2>Original materials</h2>
            <span className="muted small">{state.problem.sources.length} retained sources</span>
          </div>
        </div>
        <SourceCatalog slug={slug} state={state} />
      </section>
    </section>
  );
}

/** One initial mathematical reading, directly editable before discovery begins. */
function W000Review({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const isTrajectory = state.config.workflow === "trajectories-v2";
  const w000 = isTrajectory
    ? state.mathematicalViews.find((note) => note.waveId === "W000")
    : state.researchManagerNotes.find((note) => note.waveId === "W000");
  const legacyView = state.problem.contextDigestMarkdown.trim() || state.problem.normalizedMarkdown || state.statement;
  const initialAbstract = w000?.abstract ?? "";
  const initialMarkdown = w000?.markdown.trim() || legacyView;
  const version = `${w000?.recordedAtSeq ?? 0}:${initialAbstract}:${initialMarkdown}`;
  const [abstract, setAbstract] = useState(initialAbstract);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [submitting, setSubmitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [editingRaw, setEditingRaw] = useState(false);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const readingModel = isTrajectory
    ? state.config.models.summaryReader
    : state.config.models.researchManager;
  const modelLabel = `${readingModel.model ?? "account default"} · ${readingModel.effort}`;
  const sourceCount = state.problem.sources.length;
  const problemMarkdown = state.problem.normalizedMarkdown ?? state.statement;
  const dirty = abstract.trim() !== initialAbstract.trim() || markdown.trim() !== initialMarkdown.trim();
  const abstractTooLong = abstract.length > INTAKE_ABSTRACT_MAX_CHARS;
  const rawChangedAfterW000 = (w000?.recordedAtSeq ?? 0) < state.problem.rawUpdatedAtSeq;
  // Local state covers the click before SSE arrives. The event-derived state
  // survives tab changes, reloads, and a second browser while the Manager is
  // still reading the source material.
  const regenerationPending = pendingIntakeDecision(state) !== null;
  const w000Busy = regenerating || regenerationPending;

  useEffect(() => {
    setAbstract(initialAbstract);
    setMarkdown(initialMarkdown);
    // A newly recorded W000 is the only external reseed; local edits remain local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const confirm = async (): Promise<void> => {
    if (rawChangedAfterW000 || abstractTooLong || markdown.trim() === "" || submitting || w000Busy || guard.disabled) return;
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
    if (submitting || w000Busy || guard.disabled) return;
    setRegenerating(true);
    try {
      await run(() => api.regenerateIntake(slug), "W000 regenerated from the original materials");
    } finally {
      setRegenerating(false);
    }
  };

  if (editingRaw) {
    return (
      <RawIntakeEditor
        slug={slug}
        state={state}
        onBack={() => setEditingRaw(false)}
        onGenerated={() => setEditingRaw(false)}
      />
    );
  }

  return (
    <section className="intake-confirm w000-review" aria-labelledby="w000-title">
      <header className="section-header intake-header">
        <div>
          <span className="eyebrow">Initial mathematical reading · W000</span>
          <h1 id="w000-title">Current mathematical view</h1>
          <p>
            Edit this reading directly. It becomes the shared starting point cloned into the first
            independent research trajectories.
          </p>
        </div>
        <span className="chip ok" title="One initial reading; no research trajectories have been dispatched">{modelLabel}</span>
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
              disabled={submitting || w000Busy}
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
              disabled={submitting || w000Busy}
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

      {rawChangedAfterW000 ? (
        <div className="banner warn w000-stale-warning">
          The raw objective, background, or files changed after this W000 was written. Regenerate W000 before beginning research.
        </div>
      ) : null}

      {regenerationPending ? (
        <div className="banner info w000-regenerating" role="status">
          The original materials are being read again to regenerate W000. You can leave this page;
          these controls will unlock when the new reading is ready.
        </div>
      ) : null}

      <footer className="intake-actions">
        <div className="intake-action-buttons">
          <button
            type="button"
            className="button ghost"
            disabled={submitting || w000Busy || guard.disabled}
            title={dirty ? "Your local W000 edits remain until you regenerate" : "Revise the objective, background, or files"}
            onClick={() => setEditingRaw(true)}
          >
            Edit raw input
          </button>
          <button
            type="button"
            className="button"
            disabled={submitting || w000Busy || guard.disabled}
            title={dirty ? "Regeneration replaces your unsaved edits" : (guard.title ?? "Read the original materials again")}
            onClick={() => void regenerate()}
          >
            {w000Busy ? "Regenerating…" : "Regenerate from originals"}
          </button>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={rawChangedAfterW000 || abstractTooLong || markdown.trim() === "" || submitting || w000Busy || guard.disabled}
          title={regenerationPending ? "Wait for the regenerated W000 to finish" : guard.title}
          onClick={() => void confirm()}
        >
          {submitting ? "Saving…" : "Accept W000 & begin research"}
        </button>
      </footer>
    </section>
  );
}

export default function IntakeConfirm(props: { slug: string; state: ProjectState }): JSX.Element {
  if (isProjectExport()) return <StaticIntake {...props} />;
  return props.state.phase === "CREATED" ? <DraftIntake {...props} /> : <W000Review {...props} />;
}
