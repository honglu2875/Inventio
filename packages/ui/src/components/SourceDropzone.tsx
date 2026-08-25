import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  MAX_SOURCE_BYTES,
  PACKET_SOURCE_LIMIT,
  api,
  errorMessage,
  type SourceFile,
} from "../lib/api";
import { useActionGuard } from "../store/hooks";

/**
 * Drag files in as project sources (DESIGN §12, §13).
 *
 * Two modes, because a file can only be stored once its project exists:
 *
 * - **live** (`slug` given) — every dropped file is uploaded immediately and
 *   the list reflects what the conductor actually holds.
 * - **staged** (`slug === null`) — used by the New Problem dialog: files are
 *   held in memory and handed to the caller, which uploads them as soon as the
 *   project has been created.
 *
 * Uploading is a mutating action, so fixture replay disables it like any other
 * (UI-SPEC §3).
 */

const KB = 1024;

function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

interface Progress {
  name: string;
  status: "uploading" | "error";
  detail: string;
}

export default function SourceDropzone({
  slug,
  staged,
  onStagedChange,
}: {
  /** Project to upload into, or null to stage files for a later upload. */
  slug: string | null;
  /** Staged mode: the files held so far (owned by the caller). */
  staged?: File[];
  onStagedChange?: (files: File[]) => void;
}): JSX.Element {
  const guard = useActionGuard(slug ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [dragging, setDragging] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const stagedFiles = staged ?? [];
  const live = slug !== null;

  const refresh = useCallback(() => {
    if (slug === null) return;
    void api
      .listSources(slug)
      .then((list) => {
        setFiles(list);
        setListError(null);
      })
      .catch((err: unknown) => setListError(errorMessage(err)));
  }, [slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const accept = useCallback(
    (incoming: FileList | null) => {
      if (incoming === null || incoming.length === 0 || guard.disabled) return;
      const list = [...incoming];

      if (slug === null) {
        const rejected = list.filter((f) => f.size > MAX_SOURCE_BYTES);
        const kept = list.filter((f) => f.size <= MAX_SOURCE_BYTES);
        setProgress(
          rejected.map((f) => ({
            name: f.name,
            status: "error" as const,
            detail: `larger than ${formatBytes(MAX_SOURCE_BYTES)}`,
          })),
        );
        if (kept.length > 0) {
          const byName = new Map(stagedFiles.map((f) => [f.name, f]));
          for (const f of kept) byName.set(f.name, f);
          onStagedChange?.([...byName.values()]);
        }
        return;
      }

      setProgress((prev) => [
        ...prev.filter((p) => !list.some((f) => f.name === p.name)),
        ...list.map((f) => ({ name: f.name, status: "uploading" as const, detail: formatBytes(f.size) })),
      ]);

      // Sequential: uploads are large bodies and the conductor is single-user.
      void (async () => {
        for (const file of list) {
          try {
            await api.uploadSource(slug, file);
            setProgress((prev) => prev.filter((p) => p.name !== file.name));
          } catch (err) {
            const detail = errorMessage(err);
            setProgress((prev) =>
              prev.map((p) => (p.name === file.name ? { ...p, status: "error", detail } : p)),
            );
          }
        }
        refresh();
      })();
    },
    [guard.disabled, slug, stagedFiles, onStagedChange, refresh],
  );

  const remove = (name: string): void => {
    if (guard.disabled) return;
    if (slug === null) {
      onStagedChange?.(stagedFiles.filter((f) => f.name !== name));
      return;
    }
    void api
      .deleteSource(slug, name)
      .then(() => refresh())
      .catch((err: unknown) => setListError(errorMessage(err)));
  };

  const rows = (live ? files : stagedFiles).map((f) => ({
    name: f.name,
    size: f.size,
    hint: f.size > PACKET_SOURCE_LIMIT ? "too large for a packet" : null,
  }));

  return (
    <div className="dropzone-wrap">
      <div
        className={`dropzone${dragging ? " dragging" : ""}${guard.disabled ? " disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!guard.disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files);
        }}
        {...(guard.title === undefined ? {} : { title: guard.title })}
      >
        <input
          ref={inputRef}
          id={inputId}
          className="visually-hidden"
          type="file"
          multiple
          disabled={guard.disabled}
          onChange={(e) => {
            accept(e.target.files);
            e.target.value = ""; // re-picking the same file must fire again
          }}
        />
        <label className="dropzone-label" htmlFor={inputId}>
          <span className="dropzone-glyph" aria-hidden="true">
            ⤓
          </span>
          <span>
            Drop files here or <span className="link-ish">browse</span>
          </span>
          <span className="muted small">
            up to {formatBytes(MAX_SOURCE_BYTES)} each · files over{" "}
            {formatBytes(PACKET_SOURCE_LIMIT)} are stored but skipped when packets are built
          </span>
        </label>
      </div>

      {listError === null ? null : <div className="banner danger">{listError}</div>}

      {progress.length === 0 ? null : (
        <ul className="source-list">
          {progress.map((p) => (
            <li key={`p:${p.name}`} className={`source-row ${p.status}`}>
              <span className="source-name mono">{p.name}</span>
              <span className={p.status === "error" ? "small danger-text" : "small muted"}>
                {p.status === "uploading" ? `uploading… ${p.detail}` : p.detail}
              </span>
              {p.status === "error" ? (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`dismiss ${p.name}`}
                  onClick={() => setProgress((prev) => prev.filter((q) => q.name !== p.name))}
                >
                  ✕
                </button>
              ) : (
                <span className="source-spinner" aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="muted small empty-note">
          {live ? "No files supplied yet." : "No files staged yet."}
        </p>
      ) : (
        <ul className="source-list">
          {rows.map((row) => (
            <li key={row.name} className="source-row">
              <span className="source-name mono">{row.name}</span>
              <span className="small muted">{formatBytes(row.size)}</span>
              {row.hint === null ? null : (
                <span className="chip" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
                  {row.hint}
                </span>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`remove ${row.name}`}
                disabled={guard.disabled}
                {...(guard.title === undefined ? {} : { title: guard.title })}
                onClick={() => remove(row.name)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
