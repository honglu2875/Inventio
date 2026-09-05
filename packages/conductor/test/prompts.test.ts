import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "src", "prompts");

const MODEL_CALL_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function modelCallSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...modelCallSourceFiles(absolute));
    else if (entry.isFile() && MODEL_CALL_SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

describe("prompt architecture", () => {
  it("keeps deliberate production prompt literals inside src/prompts", () => {
    const files = [
      ...modelCallSourceFiles(path.join(PACKAGE_ROOT, "src")),
      ...modelCallSourceFiles(path.join(PACKAGE_ROOT, "scripts")),
    ].filter((file) => !file.startsWith(PROMPTS_DIR + path.sep));

    const directLiteral = /\b(?:prompt|input)\s*:\s*["'`]/;
    const characteristicInstruction =
      /Reply with ONLY|following AGENTS\.md|Follow AGENTS\.md|You are the Research Manager|Your previous process ended|Your previous return did not/;
    const offenders = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return directLiteral.test(source) || characteristicInstruction.test(source)
        ? [path.relative(PACKAGE_ROOT, file)]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it("documents every prompt module and removes the legacy locations", () => {
    const guide = readFileSync(path.join(PROMPTS_DIR, "README.md"), "utf8");
    for (const name of [
      "intake.ts",
      "recurrent.ts",
      "publication.ts",
      "shared.ts",
      "operational.ts",
      "tools.ts",
      "diagnostics.ts",
    ]) {
      expect(guide).toContain(`\`${name}\``);
    }

    for (const oldPath of [
      path.join(PACKAGE_ROOT, "src", "engine", "planner.ts"),
      path.join(PACKAGE_ROOT, "src", "engine", "contracts.ts"),
      path.join(PACKAGE_ROOT, "src", "engine", "managerExamples.ts"),
    ]) {
      expect(existsSync(oldPath)).toBe(false);
    }
  });

  it("appends the shared writing contract to every generated project AGENTS.md", () => {
    for (const name of ["intake.ts",
      "recurrent.ts", "publication.ts"]) {
      const source = readFileSync(path.join(PROMPTS_DIR, name), "utf8");
      const assignments = source
        .split("\n")
        .filter((line) => line.includes('"AGENTS.md":'));

      expect(assignments.length).toBeGreaterThan(0);
      for (const assignment of assignments) {
        expect(assignment).toContain('"AGENTS.md": withMathematicalWritingGuidance(');
      }
    }

  });
});
