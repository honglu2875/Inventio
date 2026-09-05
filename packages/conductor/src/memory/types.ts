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
  role: WorkerRole | "research_manager" | "auditor" | "editor" | "writer";
  op:
    | "search"
    | "expand"
    | "source_list"
    | "source_open"
    | "knowledge_search"
    | "knowledge_open"
    | "writeup_search"
    | "writeup_open"
    | "mark_milestone"
    | "flag_fact"
    | "research_search"
    | "research_open"
    | "research_checkpoint"
    | "audit_assess";
  args: string; // JSON.stringify of the tool arguments
  returnedIds: string[];
  refusedIds: string[];
}

export interface MemoryBackend {
  supportsRecurrentTools?(): boolean;
  searchResearch?(scope: TaskScope, query: string, limit: number): { id: string; title: string }[];
  openResearch?(scope: TaskScope, id: string, start: number, maxCharacters: number): { id: string; title: string; markdown: string; end: number; totalCharacters: number } | null;
  checkpointResearch?(scope: TaskScope, results: unknown[]): unknown;
  assessResearch?(scope: TaskScope, assessment: unknown): void;
  searchCards(q: SearchQuery): CardRow[];
  getCards(ids: string[]): MemoryCard[]; // missing ids silently absent
  /** artifact excerpt a card cites; null if none/unreadable */
  readLinkedArtifact(card: MemoryCard): string | null;
  listIntakeSources(query: string): IntakeSource[];
  openIntakeSource(id: string, start?: number, maxCharacters?: number): OpenedIntakeSource | null;
  recordRecall(rec: RecallRecord): void;
  /** trajectories-v2 methods are optional so legacy/test backends stay valid. */
  searchKnowledge?(query: string, limit?: number): KnowledgeRow[];
  openKnowledge?(ids: string[]): KnowledgeDocument[];
  searchWriteups?(query: string, limit?: number): WriteupRow[];
  openWriteups?(ids: string[], maxCharacters?: number): WriteupDocument[];
  recordMilestone?(taskId: string, title: string, markdown: string): { milestoneId: string };
  flagFact?(taskId: string, factId: string, reason: string): { correctionClaimId: string };
  supportsTrajectoryTools?(): boolean;
}

export interface KnowledgeRow {
  id: string;
  kind: "fact" | "claim";
  status: string;
  title: string;
  statement: string;
}

export interface KnowledgeDocument extends KnowledgeRow {
  markdown: string;
}

export interface WriteupRow {
  id: string;
  role: string;
  status: string;
  summary: string;
}

export interface WriteupDocument extends WriteupRow {
  markdown: string;
}

/** What a bearer token stands for: never taken from tool arguments. */
export interface TaskScope {
  turnId?: string;
  allowedVersionIds?: string[];
  slug: string;
  taskId: string;
  role: WorkerRole | "research_manager" | "auditor" | "editor" | "writer";
  waveId: string;
}
