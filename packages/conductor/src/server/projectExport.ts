import { sha256 } from "../verification/executionEvidence.js";
import {
  Memo as MemoSchema,
  PROJECT_EXPORT_FORMAT_VERSION,
  type ArtifactKind,
  type Event,
  type Memo,
  type ProjectExportArtifact,
  type ProjectExportSnapshot,
  type ProjectExportTextFile,
  type ProjectState,
} from "@inventio/schema";
import { isUtf8 } from "node:buffer";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { ProjectReader } from "../legacy/archive.js";

/** Keep the portable copy bounded and consistent with the ordinary UI. */
export const EXPORT_TRANSCRIPT_LINES = 200;
export const EXPORT_TEXT_FILE_LIMIT = 1_000_000;

interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  conclusion: string | null;
  path: string;
}

/** Extract the structured memo from a saved worker return. */
export function taskMemoFromOutput(raw: unknown): Memo | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = MemoSchema.safeParse((raw as Record<string, unknown>)["memo"]);
  return parsed.success ? parsed.data : null;
}

function confined(baseDir: string, rel: string): string {
  if (rel.includes("\0")) throw new Error("invalid path");
  const base = path.resolve(baseDir);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes ${path.basename(base)}`);
  }
  return target;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function mediaType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".tex":
      return "application/x-tex";
    case ".csv":
      return "text/csv";
    default:
      return "text/plain";
  }
}

function omittedTextFile(size: number, reason: string): ProjectExportTextFile {
  return { included: false, size, reason };
}

function portableTextFile(
  file: string,
  label: string,
  omissions: string[],
): ProjectExportTextFile {
  if (!existsSync(file)) {
    const reason = "The referenced file was missing when this snapshot was exported.";
    omissions.push(`${label}: ${reason}`);
    return omittedTextFile(0, reason);
  }
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) {
      const reason = "This entry is not a regular file.";
      omissions.push(`${label}: ${reason}`);
      return omittedTextFile(stat.size, reason);
    }
    size = stat.size;
  } catch {
    const reason = "The file could not be read while the snapshot was exported.";
    omissions.push(`${label}: ${reason}`);
    return omittedTextFile(0, reason);
  }
  if (size > EXPORT_TEXT_FILE_LIMIT) {
    const reason = `The file exceeds the ${EXPORT_TEXT_FILE_LIMIT.toLocaleString("en-US")}-byte text limit.`;
    omissions.push(`${label}: ${reason}`);
    return omittedTextFile(size, reason);
  }
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    const reason = "The file could not be read while the snapshot was exported.";
    omissions.push(`${label}: ${reason}`);
    return omittedTextFile(size, reason);
  }
  if (!isUtf8(body)) {
    const reason = "Binary content is not embedded in a portable HTML snapshot.";
    omissions.push(`${label}: ${reason}`);
    return omittedTextFile(size, reason);
  }
  return { included: true, size, mediaType: mediaType(file), text: body.toString("utf8") };
}

/** Read a JSONL tail without loading a long trajectory archive in full. */
export function readLastLines(file: string, limit: number): string[] {
  if (limit <= 0) return [];
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return [];
    size = stat.size;
  } catch {
    return [];
  }
  if (size === 0) return [];

  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  const chunks: Buffer[] = [];
  const chunkSize = 64 * 1024;
  let cursor = size;
  let newlineCount = 0;
  try {
    while (cursor > 0 && newlineCount <= limit) {
      const length = Math.min(chunkSize, cursor);
      cursor -= length;
      const chunk = Buffer.alloc(length);
      const bytes = readSync(fd, chunk, 0, length, cursor);
      const body = chunk.subarray(0, bytes);
      for (const byte of body) if (byte === 0x0a) newlineCount += 1;
      chunks.unshift(body);
    }
  } finally {
    closeSync(fd);
  }

  let lines = Buffer.concat(chunks).toString("utf8").split("\n");
  // The first chunk begins mid-line unless the read reached byte zero.
  if (cursor > 0) lines = lines.slice(1);
  return lines.filter((line) => line.trim() !== "").slice(-limit);
}

function redactTranscriptLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as unknown;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(record)) {
        if (key === "thread_id" || key === "threadId") record[key] = "[not included]";
        else visit(child);
      }
    };
    visit(parsed);
    return JSON.stringify(parsed);
  } catch {
    return line;
  }
}

function portableState(source: ProjectState): ProjectState {
  const state = structuredClone(source);
  state.config.sourceMounts = state.config.sourceMounts.map((mount) => ({
    ...mount,
    path: "[not included in HTML export]",
  }));
  for (const task of Object.values(state.tasks)) task.threadId = null;
  return state;
}

function portableEvents(source: readonly Event[]): Event[] {
  return source.map((event) => {
    const copy = structuredClone(event) as Event;
    if (copy.type === "task.session") copy.threadId = "[not included]";
    if (copy.type === "project.created") {
      copy.config.sourceMounts = copy.config.sourceMounts.map((mount) => ({
        ...mount,
        path: "[not included in HTML export]",
      }));
    }
    return copy;
  });
}

function artifactRefs(state: ProjectState): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const artifact of Object.values(state.artifacts)) refs.set(artifact.id, artifact);
  for (const verification of Object.values(state.verifications)) {
    if (verification.artifactPath === null || refs.has(verification.id)) continue;
    refs.set(verification.id, {
      id: verification.id,
      kind: "verification",
      conclusion: verification.verdict,
      path: verification.artifactPath,
    });
  }
  for (const fact of Object.values(state.facts)) {
    if (refs.has(fact.id)) continue;
    refs.set(fact.id, {
      id: fact.id,
      kind: "fact",
      conclusion: fact.status,
      path: fact.path,
    });
  }
  return [...refs.values()];
}

/** Collect the complete read surface while the engine owns a consistent state. */
export function buildProjectExportSnapshot(
  engine: ProjectReader,
  exportedAt = new Date().toISOString(),
): ProjectExportSnapshot {
  const state = portableState(engine.state);
  const omissions: string[] = [];
  const artifacts: Record<string, ProjectExportArtifact> = {};
  for (const ref of artifactRefs(state)) {
    let file: string;
    try {
      file = confined(engine.paths.dir, ref.path);
    } catch {
      omissions.push(`${ref.id}: its artifact path was invalid.`);
      continue;
    }
    let markdown: string;
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      markdown = readFileSync(file, "utf8");
    } catch {
      omissions.push(`${ref.id}: its artifact file was missing.`);
      continue;
    }
    artifacts[ref.id] = {
      id: ref.id,
      kind: ref.kind,
      conclusion: ref.conclusion,
      path: ref.path,
      markdown,
    };
  }

  const tasks: ProjectExportSnapshot["tasks"] = {};
  for (const taskId of Object.keys(state.tasks)) {
    const detail = engine.taskDetail(taskId);
    const packetFiles: Record<string, ProjectExportTextFile> = {};
    for (const rel of detail.task.packetManifest) {
      let file: string;
      try {
        file = confined(detail.packetDir, rel);
      } catch {
        const reason = "The brief path was invalid.";
        omissions.push(`${taskId}/${rel}: ${reason}`);
        packetFiles[rel] = omittedTextFile(0, reason);
        continue;
      }
      packetFiles[rel] = portableTextFile(file, `${taskId}/${rel}`, omissions);
    }
    const output = readJson(detail.outputPath);
    tasks[taskId] = {
      detail: {
        task: state.tasks[taskId]!,
        packetManifest: [...detail.task.packetManifest],
        memo: taskMemoFromOutput(output),
        meta: null,
        partialWorkMarkdown: detail.partialWorkMarkdown,
      },
      packetFiles,
      transcript: readLastLines(detail.archive, EXPORT_TRANSCRIPT_LINES).map(redactTranscriptLine),
    };
  }

  const verificationEvidence: Record<string, ProjectExportTextFile> = {};
  for (const verification of Object.values(state.verifications)) {
    if (!verification.executionEvidence) continue;
    const file = portableTextFile(
      confined(engine.paths.dir, verification.executionEvidence.path),
      `${verification.id} execution evidence`, omissions,
    );
    if (file.included && sha256(file.text) !== verification.executionEvidence.sha256) {
      const reason = "The execution record no longer matches its recorded hash.";
      omissions.push(`${verification.id}: ${reason}`);
      verificationEvidence[verification.id] = omittedTextFile(file.size, reason);
    } else verificationEvidence[verification.id] = file;
  }

  const sources: Record<string, ProjectExportTextFile> = {};
  for (const source of state.problem.sources) {
    if (source.kind !== "upload") continue;
    const name = source.relativePath.split("/").at(-1);
    if (!name) continue;
    let file: string;
    try {
      file = confined(engine.paths.dir, source.relativePath);
    } catch {
      const reason = "The source path was invalid.";
      omissions.push(`${source.id} (${name}): ${reason}`);
      sources[name] = omittedTextFile(0, reason);
      continue;
    }
    sources[name] = portableTextFile(file, `${source.id} (${name})`, omissions);
  }

  return {
    formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    slug: engine.slug,
    exportedAt,
    lastEventSeq: state.seq,
    state,
    events: portableEvents(engine.events),
    artifacts,
    tasks,
    sources,
    verificationEvidence,
    omissions,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeEmbeddedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function tagAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
  return match?.[2] ?? null;
}

function resolveUiAsset(uiDir: string, reference: string, fromDir = uiDir): string {
  const withoutSuffix = reference.split(/[?#]/, 1)[0] ?? "";
  if (/^(?:data:|https?:|#)/i.test(withoutSuffix)) {
    throw new Error(`external UI asset cannot be embedded: ${reference}`);
  }
  const decoded = decodeURIComponent(withoutSuffix);
  const target = decoded.startsWith("/")
    ? confined(uiDir, decoded.replace(/^\/+/, ""))
    : confined(uiDir, path.relative(uiDir, path.resolve(fromDir, decoded)));
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`UI asset is missing: ${reference}`);
  }
  return target;
}

function assetMediaType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".ttf":
      return "font/ttf";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

function inlineCssAssets(css: string, stylesheet: string, uiDir: string): string {
  return css.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi,
    (whole, _quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const reference = (quoted ?? bare ?? "").trim();
      if (reference === "" || /^(?:data:|https?:|#)/i.test(reference)) return whole;
      const asset = resolveUiAsset(uiDir, reference, path.dirname(stylesheet));
      const encoded = readFileSync(asset).toString("base64");
      return `url("data:${assetMediaType(asset)};base64,${encoded}")`;
    },
  );
}

function stripSourceMapComment(source: string): string {
  return source.replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, "");
}

function inlineDynamicModules(source: string, script: string, uiDir: string): string {
  return source.replace(/(["'])\.\/([^"'\\]+\.js)\1/g, (whole, quote: string, rel: string) => {
    const moduleFile = resolveUiAsset(uiDir, rel, path.dirname(script));
    const moduleSource = inlineDynamicModules(
      stripSourceMapComment(readFileSync(moduleFile, "utf8")),
      moduleFile,
      uiDir,
    );
    const data = Buffer.from(moduleSource, "utf8").toString("base64");
    return `${quote}data:text/javascript;base64,${data}${quote}`;
  });
}

/** Turn the ordinary Vite build into one offline HTML document. */
export function renderStandaloneProjectHtml(
  uiDir: string,
  snapshot: ProjectExportSnapshot,
): string {
  const indexFile = path.join(uiDir, "index.html");
  if (!existsSync(indexFile)) throw new Error("the Inventio UI build is unavailable");
  let html = readFileSync(indexFile, "utf8");

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if ((tagAttribute(tag, "rel") ?? "").toLowerCase() !== "stylesheet") return tag;
    const href = tagAttribute(tag, "href");
    if (href === null) return tag;
    const stylesheet = resolveUiAsset(uiDir, href);
    const css = inlineCssAssets(readFileSync(stylesheet, "utf8"), stylesheet, uiDir)
      .replace(/<\/style/gi, "<\\/style");
    return `<style data-inventio-inline>${css}</style>`;
  });

  let inlinedScripts = 0;
  html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*><\/script>/gi, (tag, _quote, src) => {
    const script = resolveUiAsset(uiDir, String(src));
    const body = inlineDynamicModules(
      stripSourceMapComment(readFileSync(script, "utf8")),
      script,
      uiDir,
    ).replace(/<\/script/gi, "<\\/script");
    inlinedScripts += 1;
    return `<script type="module" data-inventio-inline>${body}</script>`;
  });
  if (inlinedScripts === 0) throw new Error("the Inventio UI build has no application script");

  const title = `${snapshot.state.title} — Inventio snapshot`;
  // Always use replacement callbacks for project-derived text. A replacement
  // string interprets dollar-sign sequences for matched text, prefix, and
  // suffix as special tokens and can silently splice index.html into JSON.
  html = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/<html\b/i, '<html data-inventio-export="true"');
  const data = `<script id="inventio-project-export" type="application/json">${safeEmbeddedJson(snapshot)}</script>`;
  html = html.replace(/<\/head>/i, () => `${data}\n  </head>`);
  return html;
}
