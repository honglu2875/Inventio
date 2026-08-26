import {
  currentTerminalPublication,
  type ProjectState,
  type PublicationState,
} from "@inventio/schema";
import { api, publicationPdfUrl } from "../../lib/api";
import { useActionGuard, useApiAction } from "../../store/hooks";

function readyHeading(publication: PublicationState): string {
  if (publication.kind === "research_report") {
    return publication.terminalResult === "UNCERTAIN"
      ? "Research report ready"
      : "Earlier conclusion not upheld";
  }
  if (publication.result === publication.terminalResult) {
    return "Preprint ready";
  }
  if (publication.terminalResult === "UNCERTAIN") {
    return "Final review reached a definite result";
  }
  return "Final review changed the conclusion";
}

export function publicationStatusText(publication: PublicationState): string {
  if (publication.status === "drafting") {
    return "The Research Manager is checking the complete argument and drafting the standalone manuscript in TeX.";
  }
  if (publication.status === "compiling") {
    return "The mathematical manuscript is complete and is being compiled locally into a PDF.";
  }
  if (publication.status === "failed") {
    return publication.error ?? "The publication pass did not complete.";
  }
  if (publication.kind === "research_report") {
    return publication.terminalResult === "UNCERTAIN"
      ? "The final mathematical review remains uncertain, so the standalone document is a research report."
      : "The final mathematical review could not uphold the earlier " +
          publication.terminalResult +
          " result. Inventio wrote a self-contained research report instead of presenting an unsupported preprint.";
  }
  if (publication.result === publication.terminalResult) {
    return "The final mathematical review upheld the " + publication.result + " result.";
  }
  return (
    "The final mathematical review changed the earlier " +
    publication.terminalResult +
    " assessment to " +
    String(publication.result) +
    "."
  );
}

export default function PublicationStatusBar({
  slug,
  state,
}: {
  slug: string;
  state: ProjectState;
}): JSX.Element | null {
  const publication = currentTerminalPublication(state);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  if (!publication) return null;

  const changed =
    publication.status === "ready" &&
    publication.result !== null &&
    publication.result !== publication.terminalResult;
  const tone =
    publication.status === "failed" || changed || publication.kind === "research_report"
      ? "warn"
      : publication.status === "ready"
        ? "ok"
        : "info";

  return (
    <section
      className={"publication-status " + tone}
      role={publication.status === "failed" || changed ? "alert" : "status"}
    >
      <div className="publication-status-copy">
        <strong>
          {publication.status === "ready"
            ? readyHeading(publication)
            : publication.status === "drafting"
              ? "Final mathematical review"
              : publication.status === "compiling"
                ? "Compiling standalone PDF"
                : "Publication needs attention"}
        </strong>
        <span>{publicationStatusText(publication)}</span>
        {publication.status === "ready" && publication.assessment ? (
          <small>{publication.assessment}</small>
        ) : null}
      </div>
      <div className="publication-status-actions">
        {publication.status === "ready" && publication.pdfPath ? (
          <a
            className="button primary"
            href={publicationPdfUrl(slug, publication.id)}
            download
          >
            Download PDF
          </a>
        ) : null}
        {publication.status === "failed" ? (
          <button
            type="button"
            className="button"
            disabled={guard.disabled}
            title={guard.title}
            onClick={() => {
              void run(
                () => api.preparePublication(slug),
                publication.failureStage === "compilation"
                  ? "PDF compilation restarted"
                  : "Publication review restarted",
              );
            }}
          >
            {publication.failureStage === "compilation"
              ? "Retry PDF compilation"
              : "Retry publication review"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

