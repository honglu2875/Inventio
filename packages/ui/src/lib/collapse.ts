import type { ProjectState } from "@inventio/schema";

/**
 * Collapse-set policy (UI-SPEC §3): "default collapsed = all waves except the
 * last two and any wave containing a running task (recomputed only when a wave
 * is added — user choices win afterwards)".
 *
 * Pure functions; persistence lives in the store.
 */

/** Waves with at least one running task. */
export function runningWaveIds(state: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const task of Object.values(state.tasks)) {
    if (task.status === "running") out.add(task.waveId);
  }
  return out;
}

/** The last `n` entries of the wave order — always expanded by default. */
function keepOpen(waveIds: readonly string[], n = 2): Set<string> {
  return new Set(waveIds.slice(Math.max(0, waveIds.length - n)));
}

export function defaultCollapsed(
  waveIds: readonly string[],
  running: ReadonlySet<string> = new Set(),
): string[] {
  const open = keepOpen(waveIds);
  return waveIds.filter((id) => !open.has(id) && !running.has(id));
}

/**
 * Fold a new wave order into an existing (possibly user-edited) collapse set.
 *
 * - No wave added → the user's set is authoritative (minus vanished ids).
 * - A wave was added → newly appeared waves and waves that just fell out of
 *   the "newest two" window get the default treatment; every other explicit
 *   user choice is preserved.
 */
export function reconcileCollapse(
  prev: readonly string[],
  prevWaveIds: readonly string[],
  waveIds: readonly string[],
  running: ReadonlySet<string> = new Set(),
): string[] {
  const live = new Set(waveIds);
  const kept = prev.filter((id) => live.has(id));
  if (waveIds.length === prevWaveIds.length) return kept;

  const known = new Set(prevWaveIds);
  const wasOpen = keepOpen(prevWaveIds);
  const nowOpen = keepOpen(waveIds);
  const next = new Set(kept);
  for (const id of waveIds) {
    const isNew = !known.has(id);
    const fellOutOfWindow = known.has(id) && wasOpen.has(id) && !nowOpen.has(id);
    if (!isNew && !fellOutOfWindow) continue;
    if (!nowOpen.has(id) && !running.has(id)) next.add(id);
  }
  // Preserve wave order for a stable, diffable persisted value.
  return waveIds.filter((id) => next.has(id));
}
