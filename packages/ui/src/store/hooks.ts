import { useCallback } from "react";
import type { ProjectState } from "@inventio/schema";
import { errorMessage } from "../lib/api";
import { READ_ONLY_TOOLTIP, useStore, type ProjectSlot } from "./store";

/** Small selectors and the shared "POST then wait for SSE" action wrapper. */

export function useSlot(slug: string): ProjectSlot | undefined {
  return useStore((s) => s.projects[slug]);
}

export function useProjectState(slug: string): ProjectState | null {
  return useStore((s) => s.projects[slug]?.state ?? null);
}

export function useConnection(slug: string): ProjectSlot["connection"] {
  return useStore((s) => s.projects[slug]?.connection ?? "connecting");
}

export interface ActionGuard {
  disabled: boolean;
  /** Tooltip to attach to every disabled control. */
  title: string | undefined;
}

/** Fixture replay and portable HTML snapshots are read-only. */
export function useActionGuard(slug: string): ActionGuard {
  const readOnly = useStore((s) => {
    const connection = s.projects[slug]?.connection;
    return connection === "fixture" || connection === "static";
  });
  return readOnly
    ? { disabled: true, title: READ_ONLY_TOOLTIP }
    : { disabled: false, title: undefined };
}

/**
 * Run a mutating API call. Errors become toasts; success relies on the event
 * stream for the state change — optimistic UI is forbidden (§7).
 */
export function useApiAction(): <T>(fn: () => Promise<T>, okMessage?: string) => Promise<T | null> {
  const pushToast = useStore((s) => s.pushToast);
  return useCallback(
    async <T,>(fn: () => Promise<T>, okMessage?: string): Promise<T | null> => {
      try {
        const result = await fn();
        if (okMessage !== undefined) pushToast(okMessage, "ok");
        return result;
      } catch (err) {
        pushToast(errorMessage(err), "error");
        return null;
      }
    },
    [pushToast],
  );
}
