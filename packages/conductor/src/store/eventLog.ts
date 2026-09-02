import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { EventSchema, type Event } from "@inventio/schema";

/** An event payload before the log assigns seq/ts. */
export type NewEvent = {
  [K in Event["type"]]: Omit<Extract<Event, { type: K }>, "seq" | "ts">;
}[Event["type"]];

interface LogLease {
  file: string;
  fd: number;
  token: string;
}

interface ParsedLog {
  events: Event[];
  needsRewrite: boolean;
  recoveryReason: string | null;
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  // Linux exposes existence without requiring signal permission. This also
  // works in restricted service/sandbox accounts where kill(pid, 0) returns
  // EPERM even after the target has exited from the visible PID namespace.
  if (process.platform === "linux") return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function releaseLease(lease: LogLease): void {
  try {
    closeSync(lease.fd);
  } catch {
    // Closing is best-effort during failed startup or shutdown.
  }
  try {
    const current = JSON.parse(readFileSync(lease.file, "utf8")) as { token?: unknown };
    if (current.token === lease.token) unlinkSync(lease.file);
  } catch {
    // Never remove a lock that may have been replaced by another process.
  }
}

function acquireLease(file: string): LogLease {
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }) + "\n",
      );
      fsyncSync(fd);
      return { file: lockFile, fd, token };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let owner: { pid?: unknown } | null = null;
      try {
        owner = JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown };
      } catch {
        throw new Error(
          `event log ${file} has an unreadable ownership lock ${lockFile}; ` +
            "make sure no Inventio process is running before removing it",
        );
      }
      const pid = typeof owner.pid === "number" ? owner.pid : 0;
      if (processExists(pid)) {
        throw new Error(
          `event log ${file} is already open by Inventio process ${pid || "unknown"}; ` +
            "stop that process before starting another server",
        );
      }
      // A crashed process cannot release its lock. Remove only a lock whose
      // recorded PID no longer exists, then compete normally for a fresh one.
      try {
        unlinkSync(lockFile);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`could not acquire ownership of event log ${file}`);
}

function sameTerminalResult(events: Event[]): boolean {
  const terminals = events.filter(
    (event): event is Extract<Event, { type: "terminal.reached" }> =>
      event.type === "terminal.reached",
  );
  if (terminals.length < 2) return false;
  return terminals.every(
    (event) =>
      event.result === terminals[0]!.result && event.finalPath === terminals[0]!.finalPath,
  );
}

/**
 * Recover the one historical shape produced when a hot-reload predecessor
 * returned after its replacement had begun finalizing the same project.
 * The original bytes are retained beside the log before canonicalization.
 * Any non-terminal fork, missing sequence, or conflicting result stays loud.
 */
function recoverConcurrentTerminalTail(events: Event[], file: string): Event[] | null {
  let conflictAt = -1;
  for (let index = 1; index < events.length; index += 1) {
    const expected = events[index - 1]!.seq + 1;
    if (events[index]!.seq === expected) continue;
    if (events[index]!.seq > expected) {
      throw new Error(
        `event log ${file} seq gap at line ${index + 1}: got ${events[index]!.seq}, expected ${expected}`,
      );
    }
    conflictAt = index;
    break;
  }
  if (conflictAt === -1) return null;

  const prefix = events.slice(0, conflictAt);
  const tail = events.slice(conflictAt);
  if (tail.length > 64 || !sameTerminalResult(tail)) {
    throw new Error(
      `event log ${file} contains overlapping writers near line ${conflictAt + 1}; ` +
        "automatic recovery is limited to a short tail with the same terminal result",
    );
  }

  const lastPrefixSeq = prefix.at(-1)?.seq ?? 0;
  const lastBySeq = new Map<number, Event>();
  for (const event of tail) {
    if (event.seq > lastPrefixSeq) lastBySeq.set(event.seq, event);
  }
  const maxSeq = Math.max(lastPrefixSeq, ...lastBySeq.keys());
  const recovered = [...prefix];
  for (let seq = lastPrefixSeq + 1; seq <= maxSeq; seq += 1) {
    const event = lastBySeq.get(seq);
    if (!event) {
      throw new Error(
        `event log ${file} has no unambiguous event ${seq} after concurrent finalization`,
      );
    }
    recovered.push(event);
  }
  const selectedTerminals = recovered
    .slice(prefix.length)
    .filter((event) => event.type === "terminal.reached");
  if (selectedTerminals.length !== 1) {
    throw new Error(
      `event log ${file} concurrent tail does not reduce to one terminal transition`,
    );
  }
  return recovered;
}

function parseLog(raw: string, file: string): ParsedLog {
  const parsed: Event[] = [];
  const lines = raw.split("\n");
  let tornTail = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const isTail = lines.slice(index + 1).every((candidate) => !candidate.trim());
      if (isTail) {
        tornTail = true;
        break;
      }
      throw new Error(`corrupt event log ${file} at line ${index + 1}: ${String(error)}`);
    }
    const event = EventSchema.safeParse(value);
    if (!event.success) {
      throw new Error(
        `invalid event in ${file} at line ${index + 1}: ${event.error.issues[0]?.message ?? "?"}`,
      );
    }
    parsed.push(event.data);
  }

  const recovered = recoverConcurrentTerminalTail(parsed, file);
  return {
    events: recovered ?? parsed,
    needsRewrite: tornTail || recovered !== null,
    recoveryReason: recovered !== null ? "concurrent-terminal-tail" : tornTail ? "torn-tail" : null,
  };
}

function rewriteRecoveredLog(file: string, raw: string, parsed: ParsedLog): void {
  const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const backup = `${file}.${parsed.recoveryReason ?? "recovery"}-${suffix}.jsonl`;
  const temporary = `${file}.repair-${suffix}`;
  writeFileSync(backup, raw, { mode: 0o600 });
  const fd = openSync(temporary, "wx", 0o600);
  try {
    const body = parsed.events.map((event) => JSON.stringify(event)).join("\n");
    writeSync(fd, body === "" ? "" : body + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  console.warn(
    `[inventio] repaired ${parsed.recoveryReason} in ${file}; original retained at ${backup}`,
  );
}

/**
 * Append-only JSONL event log (DESIGN §4/§5). Every append is fsynced.
 * A torn final line (crash mid-write) is tolerated and dropped on open;
 * corruption anywhere else throws — that is data loss and must be loud.
 */
export class EventLog {
  private fd: number;
  private lastSeq: number;
  private expectedSize: number;
  private lease: LogLease;
  private closed = false;
  readonly file: string;
  readonly events: Event[];

  private constructor(file: string, events: Event[], fd: number, lease: LogLease) {
    this.file = file;
    this.events = events;
    this.fd = fd;
    this.lease = lease;
    this.expectedSize = fstatSync(fd).size;
    this.lastSeq = events.length ? events[events.length - 1]!.seq : 0;
  }

  static open(file: string): EventLog {
    mkdirSync(path.dirname(file), { recursive: true });
    const lease = acquireLease(file);
    try {
      const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
      const parsed = parseLog(raw, file);
      if (parsed.needsRewrite) rewriteRecoveredLog(file, raw, parsed);
      const fd = openSync(file, "a");
      return new EventLog(file, parsed.events, fd, lease);
    } catch (error) {
      releaseLease(lease);
      throw error;
    }
  }

  /** Read a stable snapshot without acquiring write ownership. */
  static read(file: string): Event[] {
    const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
    const parsed = parseLog(raw, file);
    if (parsed.needsRewrite) {
      throw new Error(
        `event log ${file} needs ${parsed.recoveryReason}; open it with write ownership first`,
      );
    }
    return parsed.events;
  }

  append(partial: NewEvent): Event {
    if (this.closed) throw new Error(`event log ${this.file} is closed`);
    let ownerToken: unknown = null;
    try {
      ownerToken = (JSON.parse(readFileSync(this.lease.file, "utf8")) as { token?: unknown }).token;
    } catch {
      // Report the same ownership failure below.
    }
    if (ownerToken !== this.lease.token) {
      throw new Error(`event log ${this.file} lost its process ownership lock`);
    }
    const actualSize = fstatSync(this.fd).size;
    if (actualSize !== this.expectedSize) {
      throw new Error(
        `event log ${this.file} changed outside its owning process; refusing a conflicting append`,
      );
    }
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
    this.expectedSize = fstatSync(this.fd).size;
    this.lastSeq = event.seq;
    this.events.push(event);
    return event;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
    releaseLease(this.lease);
  }
}
