import type {
  CandidateStage,
  ClaimStatus,
  IssueSeverity,
  TaskStatus,
  VerificationState,
  WorkerRole,
} from "@inventio/schema";

/**
 * Glyphs and color roles (UI-SPEC §2). Every status carries a glyph or a text
 * label as well as a color, so nothing is conveyed by hue alone.
 */

export const ROLE_GLYPH: Record<WorkerRole | "planner", string> = {
  solver: "◆",
  explorer: "✦",
  verifier: "✓",
  reviewer: "▣",
  synthesizer: "⬢",
  planner: "●",
};

export const ROLE_COLOR: Record<WorkerRole | "planner", string> = {
  solver: "var(--role-solver)",
  explorer: "var(--role-explorer)",
  verifier: "var(--ok)",
  reviewer: "var(--role-reviewer)",
  synthesizer: "var(--role-synthesizer)",
  planner: "var(--role-planner)",
};

export const TASK_STATUS_COLOR: Record<TaskStatus, string> = {
  queued: "var(--queued)",
  running: "var(--running)",
  completed: "var(--ok)",
  interrupted: "var(--warn)",
  failed: "var(--danger)",
};

export const CLAIM_STATUS_COLOR: Record<ClaimStatus, string> = {
  VERIFIED: "var(--ok)",
  UNVERIFIED: "var(--warn)",
  REFUTED: "var(--danger)",
  SUPERSEDED: "var(--muted)",
};

export const CLAIM_STATUS_GLYPH: Record<ClaimStatus, string> = {
  VERIFIED: "✓",
  UNVERIFIED: "?",
  REFUTED: "✗",
  SUPERSEDED: "≡",
};

export function verificationDisplayStatus(
  verification: Pick<VerificationState, "status" | "verdict">,
): "PASS" | "FAIL" | "ERROR" | "RUNNING" | "QUEUED" {
  return verification.verdict ?? (verification.status === "running" ? "RUNNING" : "QUEUED");
}

/** v2 treats a claim as statement + alleged proof; a failed proof need not refute the statement. */
export function trajectoryClaimStatusLabel(status: ClaimStatus): string {
  if (status === "REFUTED") return "FAILED";
  if (status === "SUPERSEDED") return "DUPLICATE";
  return status;
}

/** Plain-language scope of a claim label. Claim status never transfers to a candidate. */
export function claimStatusMeaning(status: ClaimStatus): string {
  switch (status) {
    case "VERIFIED":
      return "The exact statement was independently checked. This does not verify a candidate or any stronger result that uses it.";
    case "UNVERIFIED":
      return "This is a recorded lead, not an established fact. It still needs an independent check before it can support a proof.";
    case "REFUTED":
      return "The exact statement failed an independent check and must not be used as a valid premise.";
    case "SUPERSEDED":
      return "A later or more precise statement replaced this one; consult the recorded reason before reusing it.";
  }
}

export function candidateStageColor(stage: CandidateStage): string {
  switch (stage) {
    case "ACCEPTED":
    case "PASSED_REVIEW":
      return "var(--ok)";
    case "FAILED_REVIEW":
      return "var(--danger)";
    case "UNDER_REVIEW":
      return "var(--accent)";
    case "REVISION_NEEDED":
    case "AWAITING_REVIEW":
      return "var(--warn)";
    default:
      return "var(--muted)";
  }
}

export const SEVERITY_COLOR: Record<IssueSeverity, string> = {
  CRITICAL: "var(--danger)",
  MAJOR: "var(--warn)",
  MINOR: "var(--muted)",
};

/** Severity letters for the burn-down chips: `2C 5M 1m`. */
export const SEVERITY_LETTER: Record<IssueSeverity, string> = {
  CRITICAL: "C",
  MAJOR: "M",
  MINOR: "m",
};

export const CARD_STATUS_COLOR: Record<string, string> = {
  PROPOSED: "var(--muted)",
  VERIFIED: "var(--ok)",
  REFUTED: "var(--danger)",
  SUPERSEDED: "var(--muted)",
  QUARANTINED: "var(--warn)",
  PENDING: "var(--queued)",
};

export function conclusionColor(conclusion: string | null): string {
  switch (conclusion) {
    case "PROVED":
    case "PASS":
      return "var(--ok)";
    case "DISPROVED":
    case "FAIL":
      return "var(--danger)";
    case "UNCERTAIN":
      return "var(--warn)";
    default:
      return "var(--muted)";
  }
}

export function resultColor(result: string | null | undefined): string {
  return conclusionColor(result ?? null);
}

export interface BurnDown {
  CRITICAL: number;
  MAJOR: number;
  MINOR: number;
}

/** `2C 5M 1m` (non-zero only); all zero → `clean`. */
export function burnDownChips(b: BurnDown): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  (["CRITICAL", "MAJOR", "MINOR"] as const).forEach((sev) => {
    if (b[sev] > 0) out.push({ text: `${b[sev]}${SEVERITY_LETTER[sev]}`, color: SEVERITY_COLOR[sev] });
  });
  if (out.length === 0) out.push({ text: "clean", color: "var(--ok)" });
  return out;
}

/** Token gauge fraction and its color band (UI-SPEC §5 TaskNode). */
export function gauge(used: number, budget: number): { frac: number; color: string } {
  const raw = budget > 0 ? used / budget : 0;
  const frac = Math.min(1, Math.max(0, raw));
  const color = raw > 1 ? "var(--danger)" : raw > 0.8 ? "var(--warn)" : "var(--accent)";
  return { frac, color };
}

export const PHASES = [
  "INTAKE",
  "DISCOVERY",
  "SYNTHESIS",
  "REVIEW",
  "REPAIR",
  "TERMINAL",
] as const;
export type TrackedPhase = (typeof PHASES)[number];
