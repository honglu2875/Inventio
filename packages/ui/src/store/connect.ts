import type { Event } from "@inventio/schema";
import { api, errorMessage } from "../lib/api";
import { useStore } from "./store";

/**
 * Snapshot + SSE wiring (UI-SPEC §3). Cold load takes the full `ProjectState`,
 * then a native `EventSource` resumes from that seq. Incoming events are
 * queued and folded once per animation frame.
 */

const SNAPSHOT_RETRY_MS = 3000;

export function connectProject(slug: string): () => void {
  const store = useStore.getState();
  store.ensureSlot(slug);
  store.setConnection(slug, "connecting");

  let disposed = false;
  let source: EventSource | null = null;
  let retry: number | undefined;
  let frame = 0;
  let queue: Event[] = [];

  const flush = (): void => {
    frame = 0;
    if (disposed || queue.length === 0) return;
    const batch = queue;
    queue = [];
    useStore.getState().applyEvents(slug, batch);
  };

  const schedule = (): void => {
    if (frame !== 0 || disposed) return;
    frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 16) as unknown as number);
  };

  const openStream = (since: number): void => {
    if (disposed) return;
    const url = `/api/projects/${encodeURIComponent(slug)}/events?since=${since}`;
    const es = new EventSource(url);
    source = es;
    es.onopen = (): void => {
      if (!disposed) useStore.getState().setConnection(slug, "live");
    };
    es.onmessage = (message: MessageEvent<string>): void => {
      if (disposed) return;
      try {
        queue.push(JSON.parse(message.data) as Event);
      } catch {
        useStore.getState().setSlotError(slug, "malformed event on the stream");
        return;
      }
      schedule();
    };
    es.onerror = (): void => {
      // EventSource reconnects on its own with Last-Event-ID; the server also
      // honors `?since=`. Surface the state, do not tear the socket down.
      if (!disposed) useStore.getState().setConnection(slug, "reconnecting");
    };
  };

  const loadSnapshot = (): void => {
    void (async () => {
      try {
        const snapshot = await api.snapshot(slug);
        if (disposed) return;
        useStore.getState().setSnapshot(slug, snapshot.state);
        openStream(snapshot.seq);
      } catch (err) {
        if (disposed) return;
        useStore.getState().setSlotError(slug, errorMessage(err));
        useStore.getState().setConnection(slug, "reconnecting");
        retry = setTimeout(loadSnapshot, SNAPSHOT_RETRY_MS) as unknown as number;
      }
    })();
  };

  loadSnapshot();

  return (): void => {
    disposed = true;
    if (retry !== undefined) clearTimeout(retry);
    if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    source?.close();
    source = null;
  };
}

/** Runtime strip poller for the projects page (§11). */
export function refreshRuntime(): void {
  void (async () => {
    try {
      const runtime = await api.runtime();
      useStore.getState().setRuntime({
        codexOk: runtime.codex.ok,
        texOk: runtime.tex?.ok ?? false,
        texDetail:
          runtime.tex?.detail ??
          (runtime.tex === undefined ? "This backend does not report a TeX compiler." : null),
        poolActive: runtime.pool.active,
        poolQueued: runtime.pool.queued,
      });
    } catch {
      useStore.getState().setRuntime(null);
    }
  })();
}
