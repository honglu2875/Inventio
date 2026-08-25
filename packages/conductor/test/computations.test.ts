import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  recordComputation,
  repairComputationBaseline,
  reproduceComputation,
} from "../src/engine/computations.js";

function fixture(): { root: string; computations: string; scratch: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "collq-computation-"));
  const computations = path.join(root, "computations");
  const scratch = path.join(root, "packet", "scratch");
  mkdirSync(computations, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(path.join(scratch, "counter.txt"), "0\n");
  writeFileSync(
    path.join(scratch, "check.mjs"),
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'const file = fileURLToPath(new URL("./counter.txt", import.meta.url));',
      'const next = Number(readFileSync(file, "utf8").trim()) + 1;',
      'writeFileSync(file, `${next}\\n`);',
      'console.log(`counter=${next}`);',
    ].join("\n"),
  );
  return { root, computations, scratch };
}

describe("reproducible computations", () => {
  it("runs packet-relative scratch commands twice from the same pristine snapshot", () => {
    const f = fixture();
    try {
      const record = recordComputation(f.computations, "X001", f.scratch, "node scratch/check.mjs");
      const rerun = reproduceComputation(f.computations, "X001");

      expect(record.exitCode).toBe(0);
      expect(record.ok).toBe(true);
      expect(rerun).toMatchObject({ match: true, exitCode: 0, outputHash: record.outputHash });
      // Neither controlled run mutates the worker's submitted scratch tree.
      expect(readFileSync(path.join(f.scratch, "counter.txt"), "utf8")).toBe("0\n");
      // The durable baseline has packet shape, rather than flattening scratch/.
      expect(existsSync(path.join(f.computations, "X001", "inputs", "scratch", "check.mjs"))).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("distinguishes a command that never ran from an output mismatch", () => {
    const f = fixture();
    try {
      const record = recordComputation(f.computations, "X001", f.scratch, "node scratch/missing.mjs");
      const rerun = reproduceComputation(f.computations, "X001");

      expect(record.exitCode).not.toBe(0);
      expect(record.stderr).toContain("missing.mjs");
      expect(rerun.exitCode).not.toBe(0);
      expect(rerun.match).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("preserves and repairs a legacy flat baseline", () => {
    const f = fixture();
    try {
      const dest = path.join(f.computations, "X001");
      mkdirSync(path.join(dest, "inputs"), { recursive: true });
      writeFileSync(path.join(dest, "inputs", "check.mjs"), "console.log('never reached');\n");
      writeFileSync(
        path.join(dest, "record.json"),
        JSON.stringify({
          compId: "X001",
          entry: "node scratch/check.mjs",
          inputsHash: "legacy",
          exitCode: 2,
          stdout: "",
          outputHash: "legacy-empty",
        }),
      );
      writeFileSync(path.join(dest, "stdout.txt"), "");

      const repaired = repairComputationBaseline(
        f.computations,
        "X001",
        f.scratch,
        "node scratch/check.mjs",
      );
      const rerun = reproduceComputation(f.computations, "X001");

      expect(repaired.exitCode).toBe(0);
      expect(rerun.match).toBe(true);
      expect(existsSync(path.join(dest, "legacy-broken-baseline", "record.json"))).toBe(true);
      expect(existsSync(path.join(dest, "inputs", "scratch", "check.mjs"))).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
