import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CardStatus, CardType } from "@inventio/schema";
import type { CardRow, MemoryBackend, MemoryCard, RecallRecord, SearchQuery } from "./types.js";
import {
  openIntakeSource as openRawIntakeSource,
  readIntakeSources,
  type OpenedIntakeSource,
} from "../engine/intakeSources.js";

/**
 * File-backed memory cards (DESIGN.md §9.4): one Markdown file per card,
 * `<project>/memory/cards/M###.md`, frontmatter + body.
 *
 * The frontmatter is a deliberately tiny hand-rolled dialect — no YAML
 * dependency. Values are either single-line strings or a one-line JSON array;
 * nothing else is escaped. Parsing is tolerant: a malformed file is warned
 * about and skipped, never thrown from, so one bad card cannot take down a
 * worker's memory access mid-wave.
 */

const FRONTMATTER_KEYS = [
  "id",
  "type",
  "status",
  "title",
  "tags",
  "provenance",
  "sourceArtifact",
  "dependsOn",
  "abstract",
] as const;

const DELIM = "---";

/** Collapse newlines so a single-line frontmatter value stays single-line. */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

function jsonArray(values: string[]): string {
  return JSON.stringify(values);
}

function parseJsonArray(raw: string, where: string): string[] {
  if (raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed as string[];
    }
  } catch {
    /* fall through */
  }
  console.warn(`[memory] ${where}: expected a JSON string array, got ${JSON.stringify(raw)}`);
  return [];
}

export function serializeCard(card: MemoryCard): string {
  const lines = [
    DELIM,
    `id: ${oneLine(card.id)}`,
    `type: ${card.type}`,
    `status: ${card.status}`,
    `title: ${oneLine(card.title)}`,
    `tags: ${jsonArray(card.tags)}`,
    `provenance: ${oneLine(card.provenance)}`,
    `sourceArtifact: ${card.sourceArtifact === null ? "" : oneLine(card.sourceArtifact)}`,
    `dependsOn: ${jsonArray(card.dependsOn)}`,
    `abstract: ${oneLine(card.abstract)}`,
    DELIM,
  ];
  return `${lines.join("\n")}\n${card.content}`;
}

/** Returns null (with a warning) rather than throwing on malformed input. */
export function parseCard(text: string, where: string): MemoryCard | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== DELIM) {
    console.warn(`[memory] ${where}: missing opening '---' frontmatter delimiter; skipped`);
    return null;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === DELIM) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    console.warn(`[memory] ${where}: unterminated frontmatter; skipped`);
    return null;
  }

  const fields = new Map<string, string>();
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      console.warn(`[memory] ${where}: frontmatter line without ':' ignored: ${JSON.stringify(line)}`);
      continue;
    }
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  for (const key of FRONTMATTER_KEYS) {
    if (!fields.has(key)) {
      console.warn(`[memory] ${where}: frontmatter is missing '${key}'; skipped`);
      return null;
    }
  }

  const id = fields.get("id") ?? "";
  if (id === "") {
    console.warn(`[memory] ${where}: empty card id; skipped`);
    return null;
  }
  const type = CardType.safeParse(fields.get("type"));
  if (!type.success) {
    console.warn(`[memory] ${where}: unknown card type ${JSON.stringify(fields.get("type"))}; skipped`);
    return null;
  }
  const status = CardStatus.safeParse(fields.get("status"));
  if (!status.success) {
    console.warn(
      `[memory] ${where}: unknown card status ${JSON.stringify(fields.get("status"))}; skipped`,
    );
    return null;
  }

  const sourceArtifact = fields.get("sourceArtifact") ?? "";
  const body = lines.slice(end + 1).join("\n");

  return {
    id,
    type: type.data,
    status: status.data,
    title: fields.get("title") ?? "",
    abstract: fields.get("abstract") ?? "",
    content: body,
    tags: parseJsonArray(fields.get("tags") ?? "", `${where} tags`),
    provenance: fields.get("provenance") ?? "",
    sourceArtifact: sourceArtifact === "" ? null : sourceArtifact,
    dependsOn: parseJsonArray(fields.get("dependsOn") ?? "", `${where} dependsOn`),
  };
}

export class CardStore {
  constructor(private readonly cardsDir: string) {}

  get dir(): string {
    return this.cardsDir;
  }

  /** Every parseable `M*.md` in the cards directory, sorted by id. */
  readAll(): MemoryCard[] {
    let entries: string[];
    try {
      if (!existsSync(this.cardsDir)) return [];
      entries = readdirSync(this.cardsDir);
    } catch (err) {
      console.warn(`[memory] cannot read cards dir ${this.cardsDir}: ${String(err)}`);
      return [];
    }
    const cards: MemoryCard[] = [];
    for (const name of entries.sort()) {
      if (!name.startsWith("M") || !name.endsWith(".md")) continue;
      const file = path.join(this.cardsDir, name);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        console.warn(`[memory] cannot read card file ${file}: ${String(err)}`);
        continue;
      }
      const card = parseCard(text, file);
      if (card) cards.push(card);
    }
    cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return cards;
  }

  /** Atomic write (temp file + rename) so a card is never half-visible. */
  write(card: MemoryCard): void {
    mkdirSync(this.cardsDir, { recursive: true });
    const target = path.join(this.cardsDir, `${card.id}.md`);
    const tmp = path.join(this.cardsDir, `.${card.id}.md.${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, serializeCard(card), "utf8");
      renameSync(tmp, target);
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  get(id: string): MemoryCard | null {
    const file = path.join(this.cardsDir, `${id}.md`);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    return parseCard(text, file);
  }
}

const ARTIFACT_DIRS = ["attempts", "explorations", "reviews", "candidates"] as const;
const ARTIFACT_EXCERPT_CHARS = 8000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const DEFAULT_SEARCH_STATUSES: CardStatus[] = ["PROPOSED", "VERIFIED", "QUARANTINED"];

function scoreCard(card: MemoryCard, needle: string): number {
  const promising = card.tags.includes("promising") ? 3 : 0;
  if (needle === "") return 1 + promising;
  if (card.title.toLowerCase().includes(needle)) return 3 + promising;
  if (card.abstract.toLowerCase().includes(needle)) return 2 + promising;
  if (card.tags.some((t) => t.toLowerCase().includes(needle))) return 2 + promising;
  return 1 + promising;
}

function matches(card: MemoryCard, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [card.id, card.title, card.abstract, card.tags.join(" "), card.provenance]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Card store + artifact reader wired to one project directory.
 * `onRecall` is where the Conductor appends `memory.recall` to the event log
 * and to the task's recall log (DESIGN.md §9.3).
 */
export class FileMemoryBackend implements MemoryBackend {
  private readonly store: CardStore;

  constructor(
    private readonly projectDir: string,
    private readonly onRecall: (rec: RecallRecord) => void,
  ) {
    this.store = new CardStore(path.join(projectDir, "memory", "cards"));
  }

  get cards(): CardStore {
    return this.store;
  }

  searchCards(q: SearchQuery): CardRow[] {
    const needle = q.query.trim().toLowerCase();
    const wantTags = q.tags?.map((t) => t.toLowerCase()) ?? null;
    const statuses = q.statuses ?? DEFAULT_SEARCH_STATUSES;

    const hits: { card: MemoryCard; score: number }[] = [];
    for (const card of this.store.readAll()) {
      if (!matches(card, needle)) continue;
      if (q.types && !q.types.includes(card.type)) continue;
      if (!statuses.includes(card.status)) continue;
      if (wantTags && wantTags.length > 0) {
        const own = card.tags.map((t) => t.toLowerCase());
        if (!wantTags.some((t) => own.includes(t))) continue;
      }
      hits.push({ card, score: scoreCard(card, needle) });
    }

    hits.sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1));

    const raw = q.limit === undefined ? DEFAULT_LIMIT : Math.floor(q.limit);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(raw) ? raw : DEFAULT_LIMIT));

    return hits.slice(0, limit).map(({ card }) => ({
      id: card.id,
      type: card.type,
      status: card.status,
      title: card.title,
      abstract: card.abstract,
      provenance: card.provenance,
      tags: card.tags,
    }));
  }

  getCards(ids: string[]): MemoryCard[] {
    const found: MemoryCard[] = [];
    for (const id of ids) {
      const card = this.store.get(id);
      if (card) found.push(card);
    }
    return found;
  }

  listIntakeSources(query: string) {
    const needle = query.trim().toLowerCase();
    const paths = { intakeSourcesFile: path.join(this.projectDir, "intake", "sources.json") };
    return readIntakeSources(paths).filter((source) => {
      if (needle === "") return true;
      return [source.id, source.title, source.abstract, source.excerptMarkdown]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }

  openIntakeSource(id: string, start?: number, maxCharacters?: number): OpenedIntakeSource | null {
    const manifest = { intakeSourcesFile: path.join(this.projectDir, "intake", "sources.json") };
    const source = readIntakeSources(manifest).find((candidate) => candidate.id === id);
    if (!source) return null;
    return openRawIntakeSource({ dir: this.projectDir }, source, start, maxCharacters);
  }

  readLinkedArtifact(card: MemoryCard): string | null {
    const artifactId = card.sourceArtifact;
    if (!artifactId) return null;
    // Reject traversal: artifact ids are flat names (candidates carry dots, e.g. C001.v1).
    if (artifactId.includes("/") || artifactId.includes("\\") || artifactId.includes("..")) {
      return null;
    }
    for (const dir of ARTIFACT_DIRS) {
      const file = path.join(this.projectDir, "artifacts", dir, `${artifactId}.md`);
      try {
        const text = readFileSync(file, "utf8");
        return text.slice(0, ARTIFACT_EXCERPT_CHARS);
      } catch {
        continue;
      }
    }
    return null;
  }

  recordRecall(rec: RecallRecord): void {
    this.onRecall(rec);
  }
}
