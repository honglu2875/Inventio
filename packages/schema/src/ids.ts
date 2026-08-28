/**
 * Stable identifier conventions (DESIGN.md §3).
 * Numeric IDs are zero-padded to 3 digits; the reducer tracks the highest
 * allocated number per kind so ID allocation is derivable from state.
 */

export const ID_PREFIXES = {
  wave: "W",
  task: "T",
  attempt: "A",
  exploration: "E",
  review: "R",
  lineage: "C",
  claim: "K",
  fact: "F",
  verification: "V",
  milestone: "MS",
  issue: "I",
  card: "M",
  question: "Q",
  directive: "D",
  decision: "DEC",
  computation: "X",
  publication: "P",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function makeId(kind: IdKind, n: number): string {
  return `${ID_PREFIXES[kind]}${String(n).padStart(3, "0")}`;
}

/** Candidate version id, e.g. candidateId("C001", 2) === "C001.v2". */
export function candidateId(lineageId: string, version: number): string {
  return `${lineageId}.v${version}`;
}

export function parseCandidateId(id: string): { lineageId: string; version: number } | null {
  const m = /^(C\d{3})\.v(\d+)$/.exec(id);
  if (!m) return null;
  return { lineageId: m[1]!, version: Number(m[2]!) };
}

/** Extract the numeric part of an id for a given kind; null if malformed. */
export function idNumber(kind: IdKind, id: string): number | null {
  const prefix = ID_PREFIXES[kind];
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  if (!/^\d{3,}$/.test(rest)) return null;
  return Number(rest);
}
