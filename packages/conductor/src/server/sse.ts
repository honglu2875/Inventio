import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Server-sent events plumbing (DESIGN §11.2). Two streams exist: the project
 * event stream (resumable by `seq` — the server keeps no per-client state) and
 * the per-task codex archive tail.
 *
 * Fastify's reply is hijacked so nothing else touches the socket: SSE must not
 * be compressed, buffered or content-length'd.
 */

export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface SseChannel {
  /** `id: <id>\ndata: <payload>\n\n` (id omitted when null). */
  send(payload: string, id?: number | string | null): void;
  comment(text: string): void;
  readonly closed: boolean;
  /** Idempotent: clears the heartbeat, runs cleanups, ends the response. */
  close(): void;
  /** Registered cleanups run exactly once, on close or client disconnect. */
  onClose(fn: () => void): void;
}

export function openSse(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { heartbeatMs?: number } = {},
): SseChannel {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // belt and braces against any proxy or compression layer in front of us
    "content-encoding": "identity",
    "x-accel-buffering": "no",
  });
  raw.write(": open\n\n");
  if (typeof raw.flushHeaders === "function") raw.flushHeaders();

  let closed = false;
  const cleanups: (() => void)[] = [];

  const channel: SseChannel = {
    get closed() {
      return closed;
    },
    send(payload: string, id: number | string | null = null): void {
      if (closed || raw.writableEnded) return;
      const head = id === null ? "" : `id: ${String(id)}\n`;
      // A payload is always one line of JSON here, but be safe about newlines.
      const body = payload.split("\n").map((l) => `data: ${l}`).join("\n");
      raw.write(`${head}${body}\n\n`);
    },
    comment(text: string): void {
      if (closed || raw.writableEnded) return;
      raw.write(`: ${text}\n\n`);
    },
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* a failed cleanup must not break the others */
        }
      }
      if (!raw.writableEnded) raw.end();
    },
    onClose(fn: () => void): void {
      cleanups.push(fn);
    },
  };

  const heartbeat = setInterval(
    () => channel.comment("hb"),
    opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  );
  // never hold the process open on a heartbeat alone
  heartbeat.unref?.();

  request.raw.on("close", () => channel.close());
  raw.on("error", () => channel.close());

  return channel;
}

/** `?since=` with the `Last-Event-ID` header as the reconnect fallback. */
export function resumeCursor(sinceQuery: unknown, lastEventId: unknown): number {
  const raw =
    typeof sinceQuery === "string" && sinceQuery.trim() !== ""
      ? sinceQuery
      : typeof lastEventId === "string"
        ? lastEventId
        : null;
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Tail an append-only JSONL file: replay the last `tailLines` lines, then poll
 * for appended bytes. The file may not exist yet (a task that has not been
 * dispatched); it is picked up when it appears, and a truncation resets the
 * offset rather than emitting garbage.
 */
export function tailJsonl(
  file: string,
  emit: (line: string) => void,
  opts: { tailLines?: number; pollMs?: number } = {},
): { stop: () => void } {
  const tailLines = opts.tailLines ?? 200;
  let offset = 0;
  let carry = "";

  if (existsSync(file)) {
    const size = statSync(file).size;
    const text = readRange(file, 0, size);
    offset = size;
    const parts = text.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts.slice(-tailLines)) {
      if (line.trim() !== "") emit(line);
    }
  }

  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = 0;
      carry = "";
    }
    if (size === offset) return;
    const text = readRange(file, offset, size);
    offset = size;
    carry += text;
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim() !== "") emit(line);
    }
  }, opts.pollMs ?? 500);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}

function readRange(file: string, start: number, end: number): string {
  if (end <= start) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    const read = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
