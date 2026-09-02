import {
  PROJECT_EXPORT_FORMAT_VERSION,
  type ProjectExportSnapshot,
  type ProjectExportTextFile,
} from "@inventio/schema";

/**
 * Browser entry to a portable project snapshot. The backend places one inert
 * JSON script before the ordinary application bundle; absence means this is
 * the live application.
 */

let cached: ProjectExportSnapshot | null | undefined;

export function parseProjectExport(raw: string): ProjectExportSnapshot | null {
  try {
    const value = JSON.parse(raw) as Partial<ProjectExportSnapshot>;
    if (
      value.formatVersion !== PROJECT_EXPORT_FORMAT_VERSION ||
      typeof value.slug !== "string" ||
      typeof value.exportedAt !== "string" ||
      value.state === null ||
      typeof value.state !== "object" ||
      !Array.isArray(value.events) ||
      value.artifacts === null ||
      typeof value.artifacts !== "object" ||
      value.tasks === null ||
      typeof value.tasks !== "object" ||
      value.sources === null ||
      typeof value.sources !== "object" ||
      typeof value.lastEventSeq !== "number" ||
      !Array.isArray(value.omissions)
    ) {
      return null;
    }
    return value as ProjectExportSnapshot;
  } catch {
    return null;
  }
}

export function projectExportSnapshot(): ProjectExportSnapshot | null {
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") {
    cached = null;
    return cached;
  }
  const node = document.getElementById("inventio-project-export");
  cached = node?.textContent ? parseProjectExport(node.textContent) : null;
  return cached;
}

export function isProjectExport(): boolean {
  return projectExportSnapshot() !== null;
}

/** Distinguish a malformed portable file from the ordinary live application. */
export function hasProjectExportPayload(): boolean {
  return (
    typeof document !== "undefined" &&
    document.getElementById("inventio-project-export") !== null
  );
}

export function projectExportFor(slug: string): ProjectExportSnapshot | null {
  const snapshot = projectExportSnapshot();
  return snapshot?.slug === slug ? snapshot : null;
}

export function exportedText(file: ProjectExportTextFile): string {
  if (file.included) return file.text;
  throw new Error(file.reason);
}

/** Tests exercise parsing without installing a browser-global payload. */
export function resetProjectExportCacheForTests(): void {
  cached = undefined;
}
