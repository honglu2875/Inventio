import { create } from "zustand";
import { produce, setAutoFreeze } from "immer";
import {
  applyEvent,
  EVENT_TYPES,
  initialState,
  type Event,
  type ProjectState,
} from "@inventio/schema";
import { defaultCollapsed, reconcileCollapse, runningWaveIds } from "../lib/collapse";

/**
 * The UI store (UI-SPEC §3). One slot per project, folded by the shared
 * reducer. `applyEvent` mutates its argument, so every batch runs inside a
 * single immer `produce` — one structural copy per animation frame.
 */

// Applying ~1000 events per second must stay under the §13 budget; recursive
// auto-freezing of the whole state tree is the one avoidable cost. Nothing
// outside `produce` ever mutates state.
setAutoFreeze(false);

// Network messages are deliberately decoded as plain JSON in connect.ts. A
// server can briefly be newer than an already-open browser after a hot deploy,
// so reject an unknown discriminant before `applyEvent` advances the sequence.
const KNOWN_EVENT_TYPES = new Set<string>(EVENT_TYPES);

export type ConnectionState = "connecting" | "live" | "reconnecting" | "fixture" | "static";

export interface ProjectSlot {
  state: ProjectState | null;
  connection: ConnectionState;
  lastError: string | null;
  /**
   * Events observed by this client (snapshot resume point onward, or the whole
   * fixture). The Timeline and Earlier work inspector tabs (§7.4, §7.5) filter this
   * client-side.
   */
  events: Event[];
  /** Wave order at the last collapse reconciliation. */
  waveIds: string[];
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "ok";
}

export type ThemeChoice = "dark" | "light" | "system";

export interface Selection {
  slug: string;
  nodeId: string;
}

/** Cap on the retained client-side event log (memory, not correctness). */
export const MAX_RETAINED_EVENTS = 5000;

export interface UiStore {
  projects: Record<string, ProjectSlot>;
  runtime: {
    codexOk: boolean;
    texOk: boolean;
    texDetail: string | null;
    poolActive: number;
    poolQueued: number;
  } | null;
  collapse: Record<string, string[]>;
  selection: Selection | null;
  theme: ThemeChoice;
  /** Render TeX in short labels (§5, §8, §10). Persisted; default on. */
  renderMath: boolean;
  toasts: Toast[];

  ensureSlot: (slug: string) => void;
  setSnapshot: (slug: string, state: ProjectState) => void;
  setStaticSnapshot: (slug: string, state: ProjectState, events: Event[]) => void;
  /**
   * Fold a streamed batch. Returns false when the local reducer cannot
   * understand an event so the connection layer can replace this possibly
   * stale client state with a fresh server snapshot.
   */
  applyEvents: (slug: string, batch: Event[]) => boolean;
  setConnection: (slug: string, connection: ConnectionState) => void;
  setSlotError: (slug: string, error: string | null) => void;
  resetSlot: (slug: string) => void;

  setRuntime: (runtime: UiStore["runtime"]) => void;

  setCollapsed: (slug: string, waveIds: string[]) => void;
  toggleWave: (slug: string, waveId: string) => void;

  setSelection: (selection: Selection | null) => void;
  setTheme: (theme: ThemeChoice) => void;
  setRenderMath: (renderMath: boolean) => void;
  pushToast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

export function emptySlot(): ProjectSlot {
  return { state: null, connection: "connecting", lastError: null, events: [], waveIds: [] };
}

// ------------------------------------------------------------- localStorage

const COLLAPSE_PREFIX = "inventio.collapse.";
const THEME_KEY = "inventio.theme";
const RENDER_MATH_KEY = "inventio.renderMath";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCollapse(slug: string): string[] | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(COLLAPSE_PREFIX + slug);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function writeCollapse(slug: string, ids: string[]): void {
  try {
    storage()?.setItem(COLLAPSE_PREFIX + slug, JSON.stringify(ids));
  } catch {
    /* private mode / quota: collapse state is a convenience, never load-bearing */
  }
}

export function readTheme(): ThemeChoice {
  const raw = storage()?.getItem(THEME_KEY);
  return raw === "dark" || raw === "light" || raw === "system" ? raw : "system";
}

function writeTheme(theme: ThemeChoice): void {
  try {
    storage()?.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** Math rendering defaults ON: these are mathematics projects (§2). */
export function readRenderMath(): boolean {
  const raw = storage()?.getItem(RENDER_MATH_KEY);
  return raw === "off" ? false : true;
}

function writeRenderMath(renderMath: boolean): void {
  try {
    storage()?.setItem(RENDER_MATH_KEY, renderMath ? "on" : "off");
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------- store

let toastSeq = 0;

export const useStore = create<UiStore>()((set, get) => ({
  projects: {},
  runtime: null,
  collapse: {},
  selection: null,
  theme: readTheme(),
  renderMath: readRenderMath(),
  toasts: [],

  ensureSlot: (slug) => {
    if (get().projects[slug]) return;
    set((s) => ({ projects: { ...s.projects, [slug]: emptySlot() } }));
  },

  setSnapshot: (slug, state) => {
    set((s) => {
      const prev = s.projects[slug] ?? emptySlot();
      const running = runningWaveIds(state);
      const persisted = s.collapse[slug] ?? readCollapse(slug);
      const collapsed =
        persisted === null || persisted === undefined
          ? defaultCollapsed(state.waveOrder, running)
          : reconcileCollapse(persisted, prev.waveIds, state.waveOrder, running);
      writeCollapse(slug, collapsed);
      return {
        projects: {
          ...s.projects,
          [slug]: { ...prev, state, lastError: null, waveIds: [...state.waveOrder] },
        },
        collapse: { ...s.collapse, [slug]: collapsed },
      };
    });
  },

  setStaticSnapshot: (slug, state, events) => {
    get().setSnapshot(slug, state);
    set((s) => {
      const prev = s.projects[slug] ?? emptySlot();
      return {
        projects: {
          ...s.projects,
          [slug]: {
            ...prev,
            state,
            connection: "static",
            lastError: null,
            events: [...events],
            waveIds: [...state.waveOrder],
          },
        },
      };
    });
  },

  applyEvents: (slug, batch) => {
    if (batch.length === 0) return true;
    const slot = get().projects[slug];
    if (!slot) return false;
    const base = slot.state ?? initialState();

    const outcome: { failure: string | null } = { failure: null };
    const applied: Event[] = [];
    const next = produce(base, (draft: ProjectState) => {
      for (const event of batch) {
        // Replay overlap after a reconnect: the server resends from `since`.
        if (event.seq <= draft.seq) continue;
        const eventType = (event as { type?: unknown }).type;
        if (typeof eventType !== "string" || !KNOWN_EVENT_TYPES.has(eventType)) {
          outcome.failure = `event ${event.seq} (${String(eventType)}): event type is not supported by this UI build`;
          break;
        }
        try {
          applyEvent(draft, event);
          applied.push(event);
        } catch (err) {
          outcome.failure = `event ${event.seq} (${event.type}): ${
            err instanceof Error ? err.message : String(err)
          }`;
          break;
        }
      }
    });
    const failure = outcome.failure;
    if (applied.length === 0 && failure === null) return true;

    const running = runningWaveIds(next);
    const prevCollapse = get().collapse[slug] ?? readCollapse(slug);
    const collapsed =
      prevCollapse === null || prevCollapse === undefined
        ? defaultCollapsed(next.waveOrder, running)
        : reconcileCollapse(prevCollapse, slot.waveIds, next.waveOrder, running);
    const collapseChanged =
      prevCollapse === null ||
      prevCollapse === undefined ||
      collapsed.length !== prevCollapse.length ||
      collapsed.some((id, i) => prevCollapse[i] !== id);
    if (collapseChanged) writeCollapse(slug, collapsed);

    const events = [...slot.events, ...applied];
    set((s) => ({
      projects: {
        ...s.projects,
        [slug]: {
          ...(s.projects[slug] ?? slot),
          state: next,
          events:
            events.length > MAX_RETAINED_EVENTS
              ? events.slice(events.length - MAX_RETAINED_EVENTS)
              : events,
          waveIds: [...next.waveOrder],
          lastError: failure ?? (s.projects[slug]?.lastError ?? null),
        },
      },
      ...(collapseChanged ? { collapse: { ...s.collapse, [slug]: collapsed } } : {}),
    }));
    return failure === null;
  },

  setConnection: (slug, connection) => {
    set((s) => {
      const prev = s.projects[slug] ?? emptySlot();
      if (prev.connection === connection) return {};
      return { projects: { ...s.projects, [slug]: { ...prev, connection } } };
    });
  },

  setSlotError: (slug, error) => {
    set((s) => {
      const prev = s.projects[slug] ?? emptySlot();
      return { projects: { ...s.projects, [slug]: { ...prev, lastError: error } } };
    });
  },

  resetSlot: (slug) => {
    set((s) => ({ projects: { ...s.projects, [slug]: emptySlot() } }));
  },

  setRuntime: (runtime) => set({ runtime }),

  setCollapsed: (slug, waveIds) => {
    writeCollapse(slug, waveIds);
    set((s) => ({ collapse: { ...s.collapse, [slug]: waveIds } }));
  },

  toggleWave: (slug, waveId) => {
    const current = get().collapse[slug] ?? [];
    const next = current.includes(waveId)
      ? current.filter((id) => id !== waveId)
      : [...current, waveId];
    get().setCollapsed(slug, next);
  },

  setSelection: (selection) => {
    const prev = get().selection;
    if (prev === selection) return;
    if (prev && selection && prev.slug === selection.slug && prev.nodeId === selection.nodeId) return;
    set({ selection });
  },

  setTheme: (theme) => {
    writeTheme(theme);
    set({ theme });
  },

  setRenderMath: (renderMath) => {
    writeRenderMath(renderMath);
    set({ renderMath });
  },

  pushToast: (text, kind = "info") => {
    toastSeq += 1;
    const toast: Toast = { id: toastSeq, text, kind };
    set((s) => ({ toasts: [...s.toasts, toast].slice(-5) }));
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        useStore.getState().dismissToast(toast.id);
      }, kind === "error" ? 9000 : 4500);
    }
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// ------------------------------------------------------------------ helpers

export function collapsedSet(slug: string, collapse: Record<string, string[]>): Set<string> {
  return new Set(collapse[slug] ?? []);
}

/** Portable snapshots and fixture replays forbid every mutating action. */
export const READ_ONLY_TOOLTIP = "read-only project view";

export function slotOf(state: UiStore, slug: string): ProjectSlot | undefined {
  return state.projects[slug];
}
