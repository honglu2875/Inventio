import { useEffect, useState } from "react";
import type { PublicationState } from "@inventio/schema";
import {
  api,
  errorMessage,
  publicationPdfUrl,
  publicationTexUrl,
} from "../../lib/api";
import { useActionGuard } from "../../store/hooks";
import { useStore } from "../../store/store";

function documentKind(publication: PublicationState): string {
  return publication.kind === "preprint" ? "Research preprint" : "Research report";
}

export function publicationStatusText(publication: PublicationState): string {
  if (publication.status === "drafting") {
    return "The final mathematical reader is checking the result and writing the standalone TeX manuscript.";
  }
  if (publication.status === "drafted") {
    return "The TeX manuscript is saved. PDF compilation has not been started.";
  }
  if (publication.status === "compiling") {
    return "The saved TeX manuscript is being compiled locally into a PDF.";
  }
  if (publication.status === "failed") {
    return publication.texPath === null
      ? "No TeX manuscript was saved. The drafting error is shown below."
      : "The TeX manuscript remains saved. The PDF error is shown below and compilation can be retried.";
  }
  if (publication.kind === "research_report") {
    return publication.terminalResult === "UNCERTAIN"
      ? "The final mathematical reading remains uncertain, so the document is a research report."
      : "The final mathematical reading could not uphold the earlier " +
          publication.terminalResult +
          " result, so the document is a research report rather than an unsupported preprint.";
  }
  if (publication.result === publication.terminalResult) {
    return "The final mathematical reading upheld the " + publication.result + " result.";
  }
  return (
    "The final mathematical reading changed the earlier " +
    publication.terminalResult +
    " assessment to " +
    String(publication.result) +
    "."
  );
}

function heading(publication: PublicationState): string {
  if (publication.status === "drafting") return "Preparing manuscript";
  if (publication.status === "drafted") return "Manuscript ready";
  if (publication.status === "compiling") return "Compiling PDF";
  if (publication.status === "failed") {
    return publication.texPath === null ? "Manuscript needs attention" : "PDF needs attention";
  }
  return publication.kind === "preprint" ? "Preprint ready" : "Research report ready";
}

export default function PublicationDialog({
  slug,
  publication,
  starting,
  startError,
  onPrepare,
  onClose,
}: {
  slug: string;
  publication: PublicationState | null;
  starting: boolean;
  startError: string | null;
  onPrepare: () => void;
  onClose: () => void;
}): JSX.Element {
  const guard = useActionGuard(slug);
  const pushToast = useStore((state) => state.pushToast);
  const [compileStarting, setCompileStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setActionError(null);
  }, [publication?.id, publication?.status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const compile = async (): Promise<void> => {
    if (!publication || compileStarting || guard.disabled) return;
    setCompileStarting(true);
    setActionError(null);
    try {
      const result = await api.compilePublication(slug, publication.id);
      pushToast(
        result.status === "failed" ? "PDF compilation needs attention" : "PDF compilation started",
        result.status === "failed" ? "error" : "ok",
      );
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      pushToast(message, "error");
    } finally {
      setCompileStarting(false);
    }
  };

  const savedTex = publication?.texPath !== null && publication?.texPath !== undefined;
  const canCompile =
    savedTex &&
    publication !== null &&
    (publication.status === "drafted" || publication.status === "failed");
  const visibleError = actionError ?? startError ?? publication?.error ?? null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal publication-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <span className="eyebrow">Standalone paper</span>
            <h2 id="publication-dialog-title">
              {publication ? heading(publication) : "Preparing manuscript"}
            </h2>
          </div>
          <button type="button" className="icon-button" aria-label="close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body publication-modal-body">
          {publication === null ? (
            <div className="publication-pending">
              <strong>{starting ? "The final mathematical reading is starting." : "No manuscript is available."}</strong>
              <p className="muted">
                The TeX source will be saved before any PDF compilation is attempted.
              </p>
            </div>
          ) : (
            <>
              <div className="publication-dialog-status">
                <span className={`chip publication-state ${publication.status}`}>
                  {publication.status.toUpperCase()}
                </span>
                {publication.kind ? <span className="chip">{documentKind(publication)}</span> : null}
                {publication.result ? <span className="chip">{publication.result}</span> : null}
              </div>
              <h3 className="publication-title">{publication.title ?? "Final mathematical reading"}</h3>
              <p className="publication-summary">{publicationStatusText(publication)}</p>

              {publication.title && publication.kind && publication.result ? (
                <dl className="publication-overview">
                  <div>
                    <dt>Document</dt>
                    <dd>{documentKind(publication)}</dd>
                  </div>
                  <div>
                    <dt>Earlier report</dt>
                    <dd>{publication.terminalResult}</dd>
                  </div>
                  <div>
                    <dt>Final reading</dt>
                    <dd>{publication.result}</dd>
                  </div>
                  <div>
                    <dt>TeX source</dt>
                    <dd className="mono">manuscript.tex</dd>
                  </div>
                </dl>
              ) : null}

              {publication.assessment ? (
                <section className="publication-assessment">
                  <strong>Final mathematical overview</strong>
                  <p>{publication.assessment}</p>
                </section>
              ) : null}
            </>
          )}

          {visibleError ? (
            <section className="publication-error" role="alert">
              <strong>{savedTex ? "PDF error" : "Manuscript error"}</strong>
              <pre>{visibleError}</pre>
            </section>
          ) : null}
        </div>
        <footer className="modal-foot publication-modal-foot">
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
          {publication && savedTex ? (
            <a className="button" href={publicationTexUrl(slug, publication.id)} download>
              Download TeX
            </a>
          ) : null}
          {publication?.status === "ready" && publication.pdfPath ? (
            <a className="button primary" href={publicationPdfUrl(slug, publication.id)} download>
              Download PDF
            </a>
          ) : null}
          {canCompile ? (
            <button
              type="button"
              className="button primary"
              disabled={compileStarting || guard.disabled}
              {...(guard.title === undefined ? {} : { title: guard.title })}
              onClick={() => void compile()}
            >
              {compileStarting
                ? "Starting compilation…"
                : publication?.failureStage === "compilation"
                  ? "Retry PDF"
                  : "Generate PDF"}
            </button>
          ) : null}
          {publication?.status === "failed" && !savedTex ? (
            <button
              type="button"
              className="button primary"
              disabled={starting || guard.disabled}
              {...(guard.title === undefined ? {} : { title: guard.title })}
              onClick={onPrepare}
            >
              {starting ? "Preparing manuscript…" : "Try manuscript again"}
            </button>
          ) : null}
          {publication === null && startError ? (
            <button
              type="button"
              className="button primary"
              disabled={starting || guard.disabled}
              {...(guard.title === undefined ? {} : { title: guard.title })}
              onClick={onPrepare}
            >
              {starting ? "Preparing manuscript…" : "Try manuscript again"}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
