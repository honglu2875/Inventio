import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../../lib/api";
import { truncate } from "../../lib/format";
import { useConnection } from "../../store/hooks";

/**
 * Stream tab (UI-SPEC §7.6): the codex item tail for one task. The
 * `EventSource` exists only while this tab is mounted — Inspector mounts the
 * active tab only — and at most 500 rows stay in the DOM (§13).
 */

const MAX_ROWS = 500;

interface Row {
  key: number;
  kind: string;
  preview: string;
  full: string;
}

/** One archived codex JSONL line → a renderable row. */
function toRow(key: number, line: string): Row {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { key, kind: "raw", preview: truncate(line, 120), full: line };
  }
  const event = (parsed ?? {}) as Record<string, unknown>;
  const type = typeof event["type"] === "string" ? (event["type"] as string) : "event";
  const item = (event["item"] ?? null) as Record<string, unknown> | null;
  const itemType = item && typeof item["type"] === "string" ? (item["type"] as string) : null;
  const text =
    item && typeof item["text"] === "string"
      ? (item["text"] as string)
      : item && typeof item["command"] === "string"
        ? (item["command"] as string)
        : typeof event["text"] === "string"
          ? (event["text"] as string)
          : "";
  const full = text === "" ? JSON.stringify(event, null, 2) : text;
  return {
    key,
    kind: itemType ?? type,
    preview: text === "" ? truncate(JSON.stringify(event), 120) : truncate(text, 120),
    full,
  };
}

export default function StreamTab({ slug, taskId }: { slug: string; taskId: string }): JSX.Element {
  const connection = useConnection(slug);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    if (connection === "fixture") return;
    setRows([]);
    setError(null);
    counter.current = 0;
    const url = `${API_BASE}/projects/${encodeURIComponent(slug)}/tasks/${encodeURIComponent(taskId)}/stream`;
    const source = new EventSource(url);
    source.onmessage = (message: MessageEvent<string>): void => {
      counter.current += 1;
      const row = toRow(counter.current, message.data);
      setRows((prev) => (prev.length >= MAX_ROWS ? [...prev.slice(1 - MAX_ROWS), row] : [...prev, row]));
    };
    source.onerror = (): void => {
      setError("stream disconnected — retrying");
    };
    source.onopen = (): void => {
      setError(null);
    };
    return () => {
      source.close();
    };
  }, [slug, taskId, connection]);

  useEffect(() => {
    if (!follow) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [rows, follow]);

  if (connection === "fixture") {
    return <p className="muted">Fixture replay has no worker transcripts.</p>;
  }

  return (
    <div className="stream">
      <div className="row between stream-head">
        <label className="checkbox small">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          auto-follow
        </label>
        <span className="muted small mono">
          {rows.length}
          {rows.length >= MAX_ROWS ? `/${MAX_ROWS} (trimmed)` : ""}
        </span>
      </div>
      {error === null ? null : <div className="banner warn">{error}</div>}
      {rows.length === 0 ? (
        <p className="muted small">Waiting for output…</p>
      ) : (
        <ol className="stream-list">
          {rows.map((row) => (
            <li key={row.key} className="stream-row">
              <button
                type="button"
                className="stream-line"
                onClick={() => setExpanded((prev) => (prev === row.key ? null : row.key))}
              >
                <span className="chip stream-kind">{row.kind}</span>
                <span className="mono small stream-preview">{row.preview}</span>
              </button>
              {expanded === row.key ? <pre className="code-view mono">{row.full}</pre> : null}
            </li>
          ))}
        </ol>
      )}
      <div ref={bottom} />
    </div>
  );
}
