import Markdown from "../components/Markdown";
import {
  nextContinuationRevisionId,
  pendingContinuationRevision,
} from "@inventio/schema";
import { useProjectSlug } from "../components/ProjectContext";
import { useProjectState } from "../store/hooks";

function formatRecordedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function ManagerView(): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);

  if (state === null) {
    return (
      <div className="manager-view">
        <div className="skeleton-bar w90" aria-label="loading mathematical summary" />
      </div>
    );
  }

  const isTrajectory = state.config.workflow === "trajectories-v2";
  const notes = isTrajectory ? state.mathematicalViews : state.researchManagerNotes;
  const latest = notes.at(-1);
  const previous = notes.slice(0, -1).reverse();
  const pendingRevision = isTrajectory ? null : pendingContinuationRevision(state);
  const pendingRevisionId = pendingRevision ? nextContinuationRevisionId(state) : null;

  return (
    <div className="manager-view">
      <header className="manager-heading">
        <div>
          <span className="eyebrow">{isTrajectory ? "Summary" : "Research Manager"}</span>
          <h1>Current mathematical view</h1>
        </div>
        {pendingRevisionId ? (
          <span className="manager-note-meta mono">{pendingRevisionId} · revising</span>
        ) : latest ? (
          <span className="manager-note-meta mono">
            {latest.waveId} · {formatRecordedAt(latest.recordedAt)}
          </span>
        ) : null}
      </header>

      {pendingRevisionId ? (
        <div className="manager-revision-pending" role="status">
          <strong>{pendingRevisionId}</strong> is being prepared from the preceding mathematical
          view, the stopping report, and the complete continuation direction. No new research
          round is planned until this revision is recorded.
        </div>
      ) : null}

      {latest ? (
        <article className={"manager-note latest" + (latest.source === "fallback" ? " fallback" : "")}>
          {latest.source === "fallback" ? (
            <p className="manager-note-warning">
              {latest.waveId === "W000"
                ? "The initial reading did not return a usable revision; the previous editable view is retained verbatim below."
                : "The round summary did not return a usable revision; the preceding view is retained verbatim below."}
            </p>
          ) : null}
          {latest.abstract ? <p className="manager-note-abstract">{latest.abstract}</p> : null}
          {"reason" in latest && latest.reason ? (
            <p className="muted small">{latest.reason}</p>
          ) : null}
          <Markdown>{latest.markdown}</Markdown>
        </article>
      ) : (
        <section className="manager-note empty">
          <p className="muted">
            {isTrajectory
              ? "W000 will appear after the initial materials have been read."
              : "The first Research Manager view will appear after the first completed research round."}
          </p>
        </section>
      )}

      {previous.length > 0 ? (
        <section className="manager-history">
          <h2>Earlier views</h2>
          {previous.map((note) => (
            <details className="manager-note-history" key={note.waveId + ":" + note.recordedAtSeq}>
              <summary>
                <span>{note.waveId}</span>
                <span className="mono muted">{formatRecordedAt(note.recordedAt)}</span>
                {note.source === "fallback" ? <span className="badge warn">retained</span> : null}
              </summary>
              <div className="manager-note-history-body">
                {note.abstract ? <p className="manager-note-abstract">{note.abstract}</p> : null}
                <Markdown>{note.markdown}</Markdown>
              </div>
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}
