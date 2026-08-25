/** Presentation helpers (UI-SPEC §1, §14). Pure — unit tested. */

/** Token counts: `999`, `1.2k`, `123k`, `1.2M`, `40M`. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k < 10 ? k.toFixed(1) : String(Math.round(k))}k`;
  }
  const m = v / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : String(Math.round(m))}M`;
}

/** Exact count with thousands separators (tooltips). */
export function formatExact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Durations: `820ms`, `4.2s`, `3m 04s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : String(Math.round(s))}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Middle-free truncation with an ellipsis; never returns more than `max`. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  if (max === 1) return "…";
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** `HH:MM:SS` in local time from an ISO timestamp. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

/** Relative time for project cards: `just now`, `4m ago`, `3h ago`, `2d ago`. */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
