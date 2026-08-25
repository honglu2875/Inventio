import type { ProjectState } from "./state.js";

/**
 * A candidate's mathematical lifecycle, derived from the event-sourced facts.
 * This is deliberately distinct from the source author's PROVED/DISPROVED
 * conclusion, which is only a submission claim until independent review.
 */
export type CandidateStage =
  | "ACCEPTED"
  | "FAILED_REVIEW"
  | "SUPERSEDED_UNREVIEWED"
  | "SUPERSEDED"
  | "SET_ASIDE"
  | "UNDER_REVIEW"
  | "PASSED_REVIEW"
  | "REVISION_NEEDED"
  | "AWAITING_REVIEW"
  | "UNKNOWN";

export interface CandidateLifecycle {
  stage: CandidateStage;
  label: string;
  detail: string;
  authorConclusion: string | null;
  passReviews: number;
  failReviews: number;
  newerCandidateId: string | null;
}

const LABEL: Record<CandidateStage, string> = {
  ACCEPTED: "ACCEPTED",
  FAILED_REVIEW: "FAILED REVIEW",
  SUPERSEDED_UNREVIEWED: "SUPERSEDED · UNREVIEWED",
  SUPERSEDED: "SUPERSEDED",
  SET_ASIDE: "SET ASIDE",
  UNDER_REVIEW: "UNDER REVIEW",
  PASSED_REVIEW: "PASSED REVIEW",
  REVISION_NEEDED: "REVISION NEEDED",
  AWAITING_REVIEW: "AWAITING REVIEW",
  UNKNOWN: "UNKNOWN",
};

function result(
  stage: CandidateStage,
  detail: string,
  facts: Omit<CandidateLifecycle, "stage" | "label" | "detail">,
): CandidateLifecycle {
  return { stage, label: LABEL[stage], detail, ...facts };
}

export function candidateLifecycle(
  state: ProjectState,
  candidateId: string,
): CandidateLifecycle {
  const candidate = state.candidates[candidateId];
  if (!candidate) {
    return result("UNKNOWN", `${candidateId} is absent from the candidate record.`, {
      authorConclusion: null,
      passReviews: 0,
      failReviews: 0,
      newerCandidateId: null,
    });
  }

  const lineage = state.lineages[candidate.lineageId];
  const versions = lineage?.versionIds ?? [candidateId];
  const index = versions.indexOf(candidateId);
  const newerCandidateId = index >= 0 ? (versions.at(-1) ?? null) : null;
  const genuinelyNewer = newerCandidateId === candidateId ? null : newerCandidateId;
  const reviews = candidate.reviewIds.flatMap((id) => {
    const review = state.reviews[id];
    return review ? [review] : [];
  });
  const passReviews = reviews.filter((review) => review.verdict === "PASS").length;
  const failReviews = reviews.filter((review) => review.verdict === "FAIL").length;
  const authorConclusion = state.artifacts[candidate.fromArtifact]?.conclusion ?? null;
  const facts = {
    authorConclusion,
    passReviews,
    failReviews,
    newerCandidateId: genuinelyNewer,
  };

  if (lineage?.establishedCandidateId === candidateId || candidate.acceptance?.passed === true) {
    return result("ACCEPTED", "The full acceptance requirements passed after independent review.", facts);
  }

  if (failReviews > 0) {
    const later = genuinelyNewer ? ` A later version, ${genuinelyNewer}, exists.` : " A revision is needed.";
    return result(
      "FAILED_REVIEW",
      `${failReviews} independent referee report${failReviews === 1 ? "" : "s"} returned FAIL; this version is not accepted.${later}`,
      facts,
    );
  }

  if (genuinelyNewer) {
    if (reviews.length === 0) {
      return result(
        "SUPERSEDED_UNREVIEWED",
        `This version was replaced by ${genuinelyNewer} before independent review.`,
        facts,
      );
    }
    return result("SUPERSEDED", `This version was replaced by ${genuinelyNewer}.`, facts);
  }

  if (lineage?.status === "abandoned") {
    return result("SET_ASIDE", "This research direction was set aside without acceptance.", facts);
  }

  const reviewRunning = Object.values(state.tasks).some(
    (task) =>
      task.reviewOf === candidateId && (task.status === "queued" || task.status === "running"),
  );
  if (reviewRunning) {
    return result("UNDER_REVIEW", "Independent referees are currently examining this version.", facts);
  }

  if (passReviews >= 2) {
    return result(
      "PASSED_REVIEW",
      candidate.acceptance?.passed === false
        ? "The referee requirement passed, but other acceptance requirements remain unmet."
        : "Two independent referee reports passed; the acceptance decision has not yet been recorded.",
      facts,
    );
  }

  if (candidate.acceptance?.passed === false) {
    return result(
      "REVISION_NEEDED",
      "The acceptance check found unmet requirements; this version is not accepted.",
      facts,
    );
  }

  return result(
    "AWAITING_REVIEW",
    passReviews === 1
      ? "One referee passed this version; another independent review is still required."
      : "This submitted version has not yet received the required independent reviews.",
    facts,
  );
}
