import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { EventSchema, type Event } from "@inventio/schema";

/** An event payload before the log assigns seq/ts. */
export type NewEvent = {
  [K in Event["type"]]: Omit<Extract<Event, { type: K }>, "seq" | "ts">;
}[Event["type"]];

/**
 * Append-only JSONL event log (DESIGN §4/§5). Every append is fsynced.
 * A torn final line (crash mid-write) is tolerated and dropped on open;
 * corruption anywhere else throws — that is data loss and must be loud.
 */
export class EventLog {
  private fd: number;
  private lastSeq: number;
  readonly file: string;
  readonly events: Event[];

  private constructor(file: string, events: Event[], fd: number) {
    this.file = file;
    this.events = events;
    this.fd = fd;
    this.lastSeq = events.length ? events[events.length - 1]!.seq : 0;
  }

  static open(file: string): EventLog {
    mkdirSync(path.dirname(file), { recursive: true });
    const events: Event[] = [];
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          const isTail = lines.slice(i + 1).every((l) => !l.trim());
          if (isTail) break; // torn tail — dropped
          throw new Error(`corrupt event log ${file} at line ${i + 1}: ${String(err)}`);
        }
        const event = EventSchema.safeParse(parsed);
        if (!event.success) {
          throw new Error(
            `invalid event in ${file} at line ${i + 1}: ${event.error.issues[0]?.message ?? "?"}`,
          );
        }
        const expected = events.length ? events[events.length - 1]!.seq + 1 : event.data.seq;
        if (event.data.seq !== expected) {
          throw new Error(`event log ${file} seq gap at line ${i + 1}: got ${event.data.seq}, expected ${expected}`);
        }
        events.push(event.data);
      }
    }
    const fd = openSync(file, "a");
    return new EventLog(file, events, fd);
  }

  append(partial: NewEvent): Event {
    const event = { ...partial, seq: this.lastSeq + 1, ts: new Date().toISOString() } as Event;
    // Validate before writing so a buggy caller cannot poison the log.
    const checked = EventSchema.safeParse(event);
    if (!checked.success) {
      throw new Error(
        `refusing to append invalid ${partial.type}: ${checked.error.issues[0]?.path.join(".")} ${checked.error.issues[0]?.message}`,
      );
    }
    writeSync(this.fd, JSON.stringify(event) + "\n");
    fsyncSync(this.fd);
    this.lastSeq = event.seq;
    this.events.push(event);
    return event;
  }

  close(): void {
    closeSync(this.fd);
  }
}
