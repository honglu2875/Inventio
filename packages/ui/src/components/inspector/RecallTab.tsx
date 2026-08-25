import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { EventOf } from "@inventio/schema";
import { formatClock } from "../../lib/format";
import { resolveNodeRoute } from "../../lib/selection";
import { useSlot } from "../../store/hooks";

/**
 * Earlier-work tab (UI-SPEC §7.4): the `memory.recall` events this task produced,
 * filtered client-side out of the applied event log. Returned ids link into
 * the Library; refused ids are called out in `--danger`.
 */
export default function RecallTab({ slug, taskId }: { slug: string; taskId: string }): JSX.Element {
  const slot = useSlot(slug);
  const events = slot?.events;

  const recalls = useMemo(() => {
    const out: EventOf<"memory.recall">[] = [];
    for (const event of events ?? []) {
      if (event.type === "memory.recall" && event.taskId === taskId) out.push(event);
    }
    return out;
  }, [events, taskId]);

  if (recalls.length === 0) {
    return (
      <p className="muted">
        This task did not look up any earlier project notes in the events this client has seen.
      </p>
    );
  }

  return (
    <ul className="recall-list">
      {recalls.map((event) => (
        <li key={event.seq} className="recall-row">
          <div className="row">
            <span className="chip">{event.op}</span>
            <span className="mono small muted">
              #{event.seq} · {formatClock(event.ts)}
            </span>
          </div>
          <div className="mono small recall-args">{event.args}</div>
          <div className="row wrap">
            {event.returnedIds.map((id) => (
              <Link key={id} className="chip link-chip mono" to={resolveNodeRoute(slug, id).to}>
                {id}
              </Link>
            ))}
            {event.refusedIds.map((id) => (
              <span
                key={id}
                className="chip mono"
                style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                title="refused by the memory service"
              >
                {id}
              </span>
            ))}
            {event.returnedIds.length === 0 && event.refusedIds.length === 0 ? (
              <span className="muted small">no cards returned</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
