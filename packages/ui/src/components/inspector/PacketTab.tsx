import { useEffect, useMemo, useState } from "react";
import Markdown from "../Markdown";
import { ApiError, api, errorMessage } from "../../lib/api";
import { useProjectState } from "../../store/hooks";

/**
 * Packet tab (UI-SPEC §7.2): the task packet manifest as an indented tree;
 * clicking a file loads it from `/tasks/:id/packet/<path>` into a monospace
 * viewer (markdown renders, with a raw toggle).
 */

interface TreeRow {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
}

/** Manifest paths → an indented listing with synthetic directory rows. */
function toTree(manifest: readonly string[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const seenDirs = new Set<string>();
  for (const path of [...manifest].sort()) {
    const parts = path.split("/").filter((p) => p !== "");
    parts.forEach((part, i) => {
      const prefix = parts.slice(0, i + 1).join("/");
      const isDir = i < parts.length - 1;
      if (isDir) {
        if (seenDirs.has(prefix)) return;
        seenDirs.add(prefix);
      }
      rows.push({ path: prefix, name: part, depth: i, isDir });
    });
  }
  return rows;
}

export default function PacketTab({ slug, taskId }: { slug: string; taskId: string }): JSX.Element {
  const state = useProjectState(slug);
  const fromState = state?.tasks[taskId]?.packetManifest;
  const [manifest, setManifest] = useState<string[] | null>(fromState ?? null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [fileError, setFileError] = useState<{ message: string; omitted: boolean } | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    if (fromState && fromState.length > 0) {
      setManifest(fromState);
      return;
    }
    let live = true;
    void api
      .task(slug, taskId)
      .then((detail) => {
        if (live) setManifest(detail.packetManifest);
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [slug, taskId, fromState]);

  useEffect(() => {
    if (open === null) return;
    let live = true;
    setText(null);
    setFileError(null);
    void api
      .packetFile(slug, taskId, open)
      .then((body) => {
        if (live) setText(body);
      })
      .catch((err: unknown) => {
        if (live) {
          setFileError({
            message: errorMessage(err),
            omitted: err instanceof ApiError && err.status === 413,
          });
        }
      });
    return () => {
      live = false;
    };
  }, [slug, taskId, open]);

  const rows = useMemo(() => toTree(manifest ?? []), [manifest]);

  if (error !== null) return <div className="banner danger">{error}</div>;
  if (manifest === null) return <div className="skeleton-bar w60" />;
  if (manifest.length === 0) return <p className="muted">This task has no packet manifest.</p>;

  const isMarkdown = open !== null && /\.(md|markdown)$/i.test(open);

  return (
    <div className="packet">
      <ul className="packet-tree">
        {rows.map((row) => (
          <li key={`${row.depth}:${row.path}`} style={{ paddingLeft: row.depth * 14 }}>
            {row.isDir ? (
              <span className="mono muted">▾ {row.name}</span>
            ) : (
              <button
                type="button"
                className={`packet-file mono${open === row.path ? " on" : ""}`}
                onClick={() => setOpen(row.path)}
              >
                {row.name}
              </button>
            )}
          </li>
        ))}
      </ul>

      {open === null ? (
        <p className="muted small">Pick a file to view it.</p>
      ) : (
        <div className="packet-view">
          <div className="row between">
            <span className="mono small muted">{open}</span>
            {isMarkdown ? (
              <button type="button" className="button ghost small" onClick={() => setRaw((v) => !v)}>
                {raw ? "rendered" : "raw"}
              </button>
            ) : null}
          </div>
          {fileError !== null ? (
            <div className={`banner ${fileError.omitted ? "warn" : "danger"}`}>
              {fileError.message}
            </div>
          ) : text === null ? (
            <div className="skeleton-bar w90" />
          ) : isMarkdown && !raw ? (
            <Markdown>{text}</Markdown>
          ) : (
            <pre className="code-view mono">{text}</pre>
          )}
        </div>
      )}
    </div>
  );
}
