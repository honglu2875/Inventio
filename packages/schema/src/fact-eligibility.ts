import type { ProjectState } from "./state.js";

/** Identity is transitive; distinct submitted proofs retain their own records. */
export function equivalentClaims(state: ProjectState, claimId: string): Set<string> {
  const seen = new Set<string>();
  const pending = [claimId];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id) || !state.claims[id]) continue;
    seen.add(id);
    pending.push(...state.claims[id]!.equivalentIds);
  }
  return seen;
}

/** Reasons a recorded fact cannot currently be used as settled mathematics. */
export function factConcerns(state: ProjectState, factId: string): string[] {
  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();
  const visit = (id: string): string[] => {
    const known = memo.get(id);
    if (known) return known;
    if (visiting.has(id)) return [`Circular dependency involving ${id}.`];
    const fact = state.facts[id];
    if (!fact) return [`Dependency ${id} is missing from the fact record.`];
    visiting.add(id);
    const concerns: string[] = [];
    if (fact.status === "SUPERSEDED" && fact.supersededByFactId) {
      concerns.push(...visit(fact.supersededByFactId));
    } else {
      if (fact.status !== "ACTIVE") concerns.push(`${id} is ${fact.status}.`);
      const component = equivalentClaims(state, fact.claimId);
      for (const conflict of state.claimConflicts ?? []) {
        if (conflict.status === "OPEN" && (component.has(conflict.leftClaimId) || component.has(conflict.rightClaimId))) {
          concerns.push(`Conflicting statements ${conflict.leftClaimId} and ${conflict.rightClaimId}: ${conflict.reason}`);
        }
      }
      const claim = state.claims[fact.claimId];
      if (!claim) concerns.push(`The source claim for ${id} is missing.`);
      if (state.config.workflow === "trajectories-v2" && claim && claim.status !== "VERIFIED") {
        concerns.push(`The source proof ${claim.id} is ${claim.status}, not currently verified.`);
      }
      for (const dependency of claim?.dependsOn ?? []) {
        // This selector serves v2. Historical council dependency strings are
        // never interpreted as v2 fact links.
        if (state.config.workflow === "trajectories-v2") {
          for (const reason of visit(dependency)) concerns.push(`${id} uses ${dependency}: ${reason}`);
        }
      }
    }
    visiting.delete(id);
    const result = [...new Set(concerns)].slice(0, 16);
    memo.set(id, result);
    return result;
  };
  return visit(factId);
}

export function factIsSettled(state: ProjectState, factId: string): boolean {
  return state.facts[factId]?.status === "ACTIVE" && factConcerns(state, factId).length === 0;
}

/** Presentation only; the saved acceptance status and verdicts are unchanged. */
export function factDisplayStatus(state: ProjectState, factId: string): string {
  const fact = state.facts[factId];
  return fact?.status === "ACTIVE" && factConcerns(state, factId).length > 0
    ? "UNSETTLED"
    : fact?.status ?? "MISSING";
}
