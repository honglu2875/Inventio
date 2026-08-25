import { useMemo } from "react";
import type { Event } from "@inventio/schema";
import { formatClock } from "../../lib/format";
import { useSlot } from "../../store/hooks";

/**
 * Events tab (UI-SPEC §7.5): this node's slice of the applied event log,
 * oldest → newest, monospace, with seq and clock time. The filter is a plain
 * id match against the event's own string fields — the ledger names nodes by
 * id everywhere, so no per-type table is needed.
 */

function mentions(event: Event, nodeId: string): boolean {
  for (const value of Object.values(event as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value === nodeId) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) if (item === nodeId) return true;
    }
  }
  return false;
}

/** Payload without the event envelope, pretty-printed inside a contained card. */
function payload(event: Event): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (key === "seq" || key === "ts" || key === "type") continue;
    rest[key] = value;
  }
  return JSON.stringify(rest, null, 2);
}

export default function EventsTab({
  slug,
  nodeId,
}: {
  slug: string;
  nodeId: string;
}): JSX.Element {
  const slot = useSlot(slug);
  const events = slot?.events;

  const rows = useMemo(() => {
    const out: Event[] = [];
    for (const event of events ?? []) if (mentions(event, nodeId)) out.push(event);
    return out;
  }, [events, nodeId]);

  if (rows.length === 0) {
    return (
      <p className="muted">
        No events mentioning <code className="mono">{nodeId}</code> in the stream this client has
        seen. Events that predate the snapshot are not replayed.
      </p>
    );
  }

  return (
    <ol className="event-list">
      {rows.map((event) => (
        <li key={event.seq}>
          <div className="event-head">
            <span className="event-seq mono">#{event.seq}</span>
            <strong className="event-type mono">{event.type}</strong>
            <time dateTime={event.ts}>{formatClock(event.ts)}</time>
          </div>
          <pre>{payload(event)}</pre>
        </li>
      ))}
    </ol>
  );
}
