import type { CardStatus, CardType, IntakeSource, WorkerRole } from "@inventio/schema";
import type { OpenedIntakeSource } from "../engine/intakeSources.js";

/**
 * Memory service types (DESIGN.md §9, PROTOCOL.md §7).
 *
 * Memory is the *catalog* (searchable card index) plus the *deep record*
 * (full cards and the artifact each cites). Access is asymmetric by role and
 * by card status; every recall is logged.
 */

export interface MemoryCard {
  id: string; // M###
  type: CardType;
  status: CardStatus;
  title: string;
  abstract: string;
  content: string; // markdown body
  tags: string[];
  provenance: string;
  sourceArtifact: string | null; // artifact id, e.g. "A001"
  dependsOn: string[];
}

/** One row of the catalog, as returned by search. */
export interface CardRow {
  id: string;
  type: CardType;
  status: CardStatus;
  title: string;
  abstract: string;
  provenance: string;
  tags: string[];
}

export interface SearchQuery {
  query: string;
  types?: CardType[];
  statuses?: CardStatus[];
  tags?: string[];
  limit?: number; // default 5, max 20
}

export interface RecallRecord {
  taskId: string;
  role: WorkerRole | "research_manager";
  op: "search" | "expand" | "source_list" | "source_open";
  args: string; // JSON.stringify of the tool arguments
  returnedIds: string[];
  refusedIds: string[];
}

export interface MemoryBackend {
  searchCards(q: SearchQuery): CardRow[];
  getCards(ids: string[]): MemoryCard[]; // missing ids silently absent
  /** artifact excerpt a card cites; null if none/unreadable */
  readLinkedArtifact(card: MemoryCard): string | null;
  listIntakeSources(query: string): IntakeSource[];
  openIntakeSource(id: string, start?: number, maxCharacters?: number): OpenedIntakeSource | null;
  recordRecall(rec: RecallRecord): void;
}

/** What a bearer token stands for: never taken from tool arguments. */
export interface TaskScope {
  slug: string;
  taskId: string;
  role: WorkerRole | "research_manager";
  waveId: string;
}
