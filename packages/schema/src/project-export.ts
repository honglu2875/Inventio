import type { ArtifactKind, Event } from "./events.js";
import type { ProjectState, TaskState } from "./state.js";
import type { Memo } from "./worker-output.js";

/**
 * Portable, read-only projection used by the single-file HTML export.
 *
 * The export deliberately contains the data that the ordinary project UI can
 * open, not an executable copy of the project. It has no task credentials,
 * process handles, settings controls, or mutation endpoints.
 */
export const PROJECT_EXPORT_FORMAT_VERSION = 1 as const;

export interface ProjectExportArtifact {
  id: string;
  kind: ArtifactKind;
  conclusion: string | null;
  path: string;
  markdown: string;
}

export interface ProjectExportTaskDetail {
  task: TaskState;
  packetManifest: string[];
  memo: Memo | null;
  /** Runtime metadata is intentionally absent from portable exports. */
  meta: null;
  partialWorkMarkdown: string | null;
}

export type ProjectExportTextFile =
  | { included: true; size: number; mediaType: string; text: string }
  | { included: false; size: number; reason: string };

export interface ProjectExportTask {
  detail: ProjectExportTaskDetail;
  packetFiles: Record<string, ProjectExportTextFile>;
  /** The same bounded archive tail shown by the ordinary task inspector. */
  transcript: string[];
}

export interface ProjectExportSnapshot {
  formatVersion: typeof PROJECT_EXPORT_FORMAT_VERSION;
  slug: string;
  exportedAt: string;
  lastEventSeq: number;
  state: ProjectState;
  /** Complete project event history at export time. */
  events: Event[];
  artifacts: Record<string, ProjectExportArtifact>;
  tasks: Record<string, ProjectExportTask>;
  /** Optional for snapshots produced before execution evidence was recorded. */
  verificationEvidence?: Record<string, ProjectExportTextFile>;
  /** Owner uploads keyed by their stored filename. */
  sources: Record<string, ProjectExportTextFile>;
  /** Human-readable explanations of content that could not be embedded. */
  omissions: string[];
}
