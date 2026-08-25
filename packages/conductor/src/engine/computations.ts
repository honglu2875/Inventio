import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Computation recorder + reproducer (DESIGN §10, v1 semantics):
 * `record` snapshots the task's scratch dir per entry command and hashes the
 * entry's stdout on a first controlled run; `reproduce` re-runs the same
 * entry on a pristine copy and compares stdout hashes. This verifies
 * determinism of the recorded computation; OS-level network isolation is
 * inherited from the worker sandbox at produce time, and the reproduction
 * runs with a hard timeout.
 */

export interface RecordedComputation {
  compId: string;
  entry: string;
  inputsHash: string;
  outputHash: string;
  exitCode: number | null;
  stderr: string;
  ok: boolean; // entry ran with exit 0 at record time
}

export interface ReproducedComputation {
  match: boolean;
  outputHash: string;
  exitCode: number | null;
  stderr: string;
}

const RUN_TIMEOUT_MS = 120_000;

export function recordComputation(
  computationsDir: string,
  compId: string,
  scratchDir: string,
  entry: string,
): RecordedComputation {
  const dest = path.join(computationsDir, compId);
  mkdirSync(dest, { recursive: true });
  if (existsSync(path.join(dest, "record.json"))) {
    throw new Error(`computation ${compId} already has a baseline`);
  }
  return writeBaseline(dest, compId, scratchDir, entry);
}

/**
 * Replace a known-broken baseline without destroying it. This exists for the
 * v0.1 working-directory bug: the recorder copied `scratch/*` into `inputs/`
 * but executed packet-relative commands such as `python scratch/check.py`
 * from `inputs/`, so the command never ran. The old files are retained under
 * `legacy-broken-baseline/` for auditability.
 */
export function repairComputationBaseline(
  computationsDir: string,
  compId: string,
  scratchDir: string,
  entry: string,
): RecordedComputation {
  const dest = path.join(computationsDir, compId);
  const legacy = path.join(dest, "legacy-broken-baseline");
  if (existsSync(legacy)) throw new Error(`computation ${compId} already preserved a legacy baseline`);
  mkdirSync(legacy, { recursive: true });
  for (const name of ["inputs", "record.json", "stdout.txt", "stderr.txt"]) {
    const source = path.join(dest, name);
    if (existsSync(source)) renameSync(source, path.join(legacy, name));
  }
  return writeBaseline(dest, compId, scratchDir, entry);
}

export function reproduceComputation(
  computationsDir: string,
  compId: string,
): ReproducedComputation {
  const dest = path.join(computationsDir, compId);
  const record = JSON.parse(readFileSync(path.join(dest, "record.json"), "utf8")) as {
    entry: string;
    outputHash: string;
  };
  const work = mkdtempSync(path.join(os.tmpdir(), "collq-comp-"));
  try {
    cpSync(path.join(dest, "inputs"), work, { recursive: true });
    const run = runEntry(work, record.entry);
    return {
      match: run.exitCode === 0 && run.outputHash === record.outputHash,
      outputHash: run.outputHash,
      exitCode: run.exitCode,
      stderr: run.stderr,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writeBaseline(
  dest: string,
  compId: string,
  scratchDir: string,
  entry: string,
): RecordedComputation {
  // Worker entry commands are packet-relative (`python scratch/check.py`).
  // Recreate that packet shape and keep the pristine snapshot immutable: the
  // baseline run and every reproduction receive their own copy.
  const inputs = path.join(dest, "inputs");
  mkdirSync(inputs, { recursive: true });
  cpSync(scratchDir, path.join(inputs, "scratch"), { recursive: true });
  const inputsHash = hashDir(inputs);
  const work = mkdtempSync(path.join(os.tmpdir(), "collq-record-"));
  let run: ReturnType<typeof runEntry>;
  try {
    cpSync(inputs, work, { recursive: true });
    run = runEntry(work, entry);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(path.join(dest, "record.json"), JSON.stringify({ compId, entry, inputsHash, ...run }, null, 2));
  writeFileSync(path.join(dest, "stdout.txt"), run.stdout);
  writeFileSync(path.join(dest, "stderr.txt"), run.stderr);
  return {
    compId,
    entry,
    inputsHash,
    outputHash: run.outputHash,
    exitCode: run.exitCode,
    stderr: run.stderr,
    ok: run.exitCode === 0,
  };
}

function runEntry(cwd: string, entry: string): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputHash: string;
} {
  const res = spawnSync("bash", ["-c", entry], {
    cwd,
    timeout: RUN_TIMEOUT_MS,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, LANG: "C.UTF-8" },
  });
  const stdout = res.stdout ?? "";
  const stderr = `${res.stderr ?? ""}${res.error ? `${res.stderr ? "\n" : ""}${res.error.message}` : ""}`;
  return {
    exitCode: res.status,
    stdout,
    stderr,
    outputHash: crypto.createHash("sha256").update(stdout).digest("hex"),
  };
}

function hashDir(dir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        hash.update(path.relative(dir, p));
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}
