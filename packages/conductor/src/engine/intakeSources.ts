import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { IntakeSource, type IntakeSource as IntakeSourceT } from "@inventio/schema";
import { writeFileAtomic, type ProjectPaths } from "../store/projectStore.js";

const TEXT_EXTENSIONS = new Set([
  ".bib", ".csv", ".htm", ".html", ".json", ".md", ".rst", ".tex",
  ".text", ".tsv", ".txt", ".xml", ".yaml", ".yml",
]);
const DEFAULT_OPEN_CHARS = 24_000;
const MAX_OPEN_CHARS = 80_000;

export interface IntakeSourceSummary {
  sourceId: string;
  abstract: string;
  excerptMarkdown: string;
}

function hash(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function relativeKey(kind: IntakeSourceT["kind"], relativePath: string): string {
  return `${kind}:${relativePath}`;
}

export function readIntakeSources(paths: Pick<ProjectPaths, "intakeSourcesFile">): IntakeSourceT[] {
  if (!existsSync(paths.intakeSourcesFile)) return [];
  try {
    return IntakeSource.array().parse(JSON.parse(readFileSync(paths.intakeSourcesFile, "utf8")));
  } catch {
    return [];
  }
}

export function writeIntakeSources(paths: Pick<ProjectPaths, "intakeSourcesFile">, sources: IntakeSourceT[]): void {
  writeFileAtomic(paths.intakeSourcesFile, JSON.stringify(sources, null, 2) + "\n");
}

/**
 * Materialize the owner's verbatim text and index every project-local upload.
 * Existing IDs and descriptions survive regeneration; newly added files are
 * appended instead of renumbering earlier references.
 */
export function indexIntakeSources(
  paths: ProjectPaths,
  statement: string,
  contextMarkdown: string,
): IntakeSourceT[] {
  mkdirSync(paths.intakeDir, { recursive: true });
  const objectivePath = path.join(paths.intakeDir, "original-objective.md");
  const backgroundPath = path.join(paths.intakeDir, "original-background.md");
  writeFileAtomic(objectivePath, statement);
  if (contextMarkdown !== "") writeFileAtomic(backgroundPath, contextMarkdown);

  const old = readIntakeSources(paths);
  const byKey = new Map(old.map((source) => [relativeKey(source.kind, source.relativePath), source]));
  let next = old.reduce((max, source) => Math.max(max, Number(source.id.slice(1)) || 0), 0) + 1;

  const add = (
    kind: IntakeSourceT["kind"],
    title: string,
    absolutePath: string,
    relativePath: string,
  ): IntakeSourceT => {
    const data = readFileSync(absolutePath);
    const previous = byKey.get(relativeKey(kind, relativePath));
    const id = previous?.id ?? `S${String(next++).padStart(3, "0")}`;
    return {
      id,
      kind,
      title,
      relativePath,
      size: data.length,
      sha256: hash(data),
      abstract:
        previous?.abstract ??
        (kind === "objective"
          ? "The owner's verbatim mathematical objective."
          : kind === "background"
            ? "The owner's verbatim background, literature notes, and proposed ideas."
            : `Owner-supplied document: ${title}.`),
      excerptMarkdown: previous?.excerptMarkdown ?? "",
    };
  };

  const sources: IntakeSourceT[] = [
    add("objective", "Original objective", objectivePath, "intake/original-objective.md"),
  ];
  if (contextMarkdown !== "") {
    sources.push(
      add("background", "Original background and ideas", backgroundPath, "intake/original-background.md"),
    );
  }

  const uploads = path.join(paths.dir, "sources");
  if (existsSync(uploads)) {
    for (const entry of readdirSync(uploads, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const absolutePath = path.join(uploads, entry.name);
      if (lstatSync(absolutePath).isSymbolicLink()) continue;
      sources.push(add("upload", entry.name, absolutePath, path.posix.join("sources", entry.name)));
    }
  }
  writeIntakeSources(paths, sources);
  return sources;
}

export function applyIntakeSourceSummaries(
  paths: ProjectPaths,
  sources: IntakeSourceT[],
  summaries: IntakeSourceSummary[],
): IntakeSourceT[] {
  const supplied = new Map(summaries.map((summary) => [summary.sourceId, summary]));
  const updated = sources.map((source) => {
    const summary = supplied.get(source.id);
    return summary
      ? {
          ...source,
          abstract: summary.abstract.trim() || source.abstract,
          excerptMarkdown: summary.excerptMarkdown.trim(),
        }
      : source;
  });
  writeIntakeSources(paths, updated);
  return updated;
}

export function resolveIntakeSource(paths: Pick<ProjectPaths, "dir">, source: IntakeSourceT): string {
  const absolute = path.resolve(paths.dir, source.relativePath);
  const root = path.resolve(paths.dir) + path.sep;
  if (!absolute.startsWith(root)) throw new Error(`intake source ${source.id} escapes its project`);
  return absolute;
}

/** Copy originals into an intake decision directory without decoding them. */
export function copyIntakeSourcesToPacket(
  paths: ProjectPaths,
  sources: IntakeSourceT[],
  packetDir: string,
): void {
  const target = path.join(packetDir, "raw-materials");
  mkdirSync(target, { recursive: true });
  const lines = [
    "# Raw intake materials",
    "",
    "These are the owner's original materials. Open the files themselves before forming W000.",
    "",
  ];
  for (const source of sources) {
    const input = resolveIntakeSource(paths, source);
    if (!existsSync(input) || !statSync(input).isFile()) {
      lines.push(`- ${source.id}: ${source.title} — SOURCE UNAVAILABLE`);
      continue;
    }
    const safeTitle = source.title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
    const relative = `${source.id}-${safeTitle}`;
    copyFileSync(input, path.join(target, relative));
    lines.push(`- ${source.id}: ${source.title} (${source.size} bytes; sha256 ${source.sha256}) → \`${relative}\``);
  }
  writeFileAtomic(path.join(target, "index.md"), lines.join("\n") + "\n");
}

export interface OpenedIntakeSource {
  source: IntakeSourceT;
  text: string;
  start: number;
  end: number;
  totalCharacters: number;
  truncated: boolean;
}

function readableText(file: string): string | null {
  const extension = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension) || extension === "") {
    return readFileSync(file, "utf8");
  }
  if (extension === ".pdf") {
    const result = spawnSync("pdftotext", ["-layout", file, "-"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status === 0 && result.stdout.trim() !== "") return result.stdout;
  }
  return null;
}

/** Bounded, chunkable expansion used by the Research Manager source tool. */
export function openIntakeSource(
  paths: Pick<ProjectPaths, "dir">,
  source: IntakeSourceT,
  start = 0,
  maxCharacters = DEFAULT_OPEN_CHARS,
): OpenedIntakeSource | null {
  const file = resolveIntakeSource(paths, source);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const full = readableText(file);
  if (full === null) return null;
  const from = Math.max(0, Math.min(Math.floor(start), full.length));
  const amount = Math.max(1, Math.min(Math.floor(maxCharacters), MAX_OPEN_CHARS));
  const text = full.slice(from, from + amount);
  return {
    source,
    text,
    start: from,
    end: from + text.length,
    totalCharacters: full.length,
    truncated: from + text.length < full.length,
  };
}
