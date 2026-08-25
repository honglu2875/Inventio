import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ManagerError } from "./manager.js";

/**
 * Owner-supplied source files (DESIGN §12, §13).
 *
 * Files dropped on the intake screen land in `projects/<slug>/sources/` and are
 * exposed to workers through the ordinary source-mount machinery: the manager
 * registers a mount named `uploads` pointing at that directory, so the Research Manager
 * grant of `sourceMounts: ["uploads"]` copies them into the task packet like any
 * other mount. Nothing here trusts the client: the filename is re-derived from
 * scratch, the write is confined to the project directory, and both a per-file
 * and a per-project size cap are enforced before anything touches the disk.
 */

/** The mount name reserved for UI uploads. */
export const UPLOADS_MOUNT = "uploads";
/** Directory (relative to the project dir) holding uploaded sources. */
export const UPLOADS_DIRNAME = "sources";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_PROJECT_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_NAME_LENGTH = 128;
/**
 * `engine/packets.ts` skips mount files larger than this when composing a
 * packet: bigger uploads are stored, but never reach a worker.
 */
export const PACKET_MOUNT_FILE_LIMIT = 5 * 1024 * 1024;

export interface UploadedSource {
  name: string;
  size: number;
  uploadedAt: string;
}

export function sourcesDir(projectDir: string): string {
  return path.join(projectDir, UPLOADS_DIRNAME);
}

/**
 * Re-derive a safe basename from a client-supplied filename, or throw a 400.
 * Percent-encoding is decoded first (HTTP headers are latin-1, so clients
 * encode non-ASCII names) — `%2e%2e%2f` must be rejected as `../`, not slip
 * through as harmless-looking text.
 */
export function sanitizeUploadName(raw: string): string {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw; // malformed escapes: validate the literal text below
  }
  name = name.trim();

  if (name === "") throw new ManagerError("filename is required", 400);
  if (name.includes("\0")) throw new ManagerError("invalid filename", 400);
  if (name.length > MAX_UPLOAD_NAME_LENGTH) {
    throw new ManagerError(`filename longer than ${MAX_UPLOAD_NAME_LENGTH} characters`, 400);
  }
  if (/[\\/]/.test(name)) throw new ManagerError("filename must not contain path separators", 400);
  if (name.includes("..")) throw new ManagerError("filename must not contain '..'", 400);
  if (name.startsWith(".")) throw new ManagerError("filename must not start with '.'", 400);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new ManagerError(
      "filename may contain only letters, digits, '.', '_' and '-'",
      400,
    );
  }
  if (path.basename(name) !== name) throw new ManagerError("filename must be a bare name", 400);
  return name;
}

/** Absolute path of an upload, refusing anything that escapes the sources dir. */
export function resolveUpload(projectDir: string, rawName: string): { name: string; file: string } {
  const name = sanitizeUploadName(rawName);
  const base = path.resolve(sourcesDir(projectDir));
  const file = path.resolve(base, name);
  if (path.dirname(file) !== base) throw new ManagerError("filename escapes the project", 400);
  return { name, file };
}

/** Hidden files (including interrupted `.upload-*.tmp` writes) are not sources. */
function isListable(name: string): boolean {
  return !name.startsWith(".");
}

export function listUploads(projectDir: string): UploadedSource[] {
  const dir = sourcesDir(projectDir);
  if (!existsSync(dir)) return [];
  const out: UploadedSource[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isListable(entry.name)) continue;
    const stat = statSync(path.join(dir, entry.name));
    out.push({ name: entry.name, size: stat.size, uploadedAt: stat.mtime.toISOString() });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function uploadedBytes(projectDir: string): number {
  return listUploads(projectDir).reduce((sum, f) => sum + f.size, 0);
}

/**
 * Store one file, enforcing both caps. Replacing a file of the same name frees
 * its bytes first, so re-uploading a corrected file never trips the total cap.
 */
export function writeUpload(
  projectDir: string,
  rawName: string,
  data: Buffer,
): UploadedSource {
  const { name, file } = resolveUpload(projectDir, rawName);
  if (data.length === 0) throw new ManagerError("empty file", 400);
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new ManagerError(
      `file is ${data.length} bytes; the limit is ${MAX_UPLOAD_BYTES} bytes per file`,
      413,
    );
  }

  const existing = listUploads(projectDir);
  const replaced = existing.find((f) => f.name === name)?.size ?? 0;
  const total = existing.reduce((sum, f) => sum + f.size, 0) - replaced + data.length;
  if (total > MAX_PROJECT_UPLOAD_BYTES) {
    throw new ManagerError(
      `project sources would total ${total} bytes; the limit is ${MAX_PROJECT_UPLOAD_BYTES} bytes`,
      413,
    );
  }

  const dir = sourcesDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
  return { name, size: data.length, uploadedAt: new Date().toISOString() };
}

export function deleteUpload(projectDir: string, rawName: string): void {
  const { name, file } = resolveUpload(projectDir, rawName);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new ManagerError(`unknown source file ${name}`, 404);
  }
  rmSync(file);
}
