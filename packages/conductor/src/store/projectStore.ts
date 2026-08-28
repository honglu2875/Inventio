import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProjectConfig, SLUG_RE, type ProjectConfig as ProjectConfigT } from "@inventio/schema";
import { z } from "zod";

/** Durable project layout helpers (DESIGN §4). */

export interface ProjectPaths {
  root: string;
  dir: string;
  projectFile: string;
  eventsFile: string;
  problemFile: string;
  digestFile: string;
  artifactsDir: string;
  tasksDir: string;
  decisionsDir: string;
  intakeDir: string;
  intakeSourcesFile: string;
  memoryDir: string;
  cardsDir: string;
  capsulesDir: string;
  managerNotesDir: string;
  mathematicalViewsDir: string;
  writeupsDir: string;
  claimsDir: string;
  factsDir: string;
  verificationsDir: string;
  computationsDir: string;
  publicationsDir: string;
}

export function projectPaths(root: string, slug: string): ProjectPaths {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${slug}`);
  const dir = path.join(root, slug);
  return {
    root,
    dir,
    projectFile: path.join(dir, "project.json"),
    eventsFile: path.join(dir, "events.jsonl"),
    problemFile: path.join(dir, "problem.md"),
    digestFile: path.join(dir, "digest.md"),
    artifactsDir: path.join(dir, "artifacts"),
    tasksDir: path.join(dir, "tasks"),
    decisionsDir: path.join(dir, "decisions"),
    intakeDir: path.join(dir, "intake"),
    intakeSourcesFile: path.join(dir, "intake", "sources.json"),
    memoryDir: path.join(dir, "memory"),
    cardsDir: path.join(dir, "memory", "cards"),
    capsulesDir: path.join(dir, "memory", "capsules"),
    managerNotesDir: path.join(dir, "artifacts", "manager-notes"),
    mathematicalViewsDir: path.join(dir, "artifacts", "mathematical-view"),
    writeupsDir: path.join(dir, "writeups"),
    claimsDir: path.join(dir, "claims"),
    factsDir: path.join(dir, "facts"),
    verificationsDir: path.join(dir, "verifications"),
    computationsDir: path.join(dir, "computations"),
    publicationsDir: path.join(dir, "publications"),
  };
}

export function createProjectDirs(p: ProjectPaths): void {
  for (const d of [
    p.dir,
    p.artifactsDir,
    path.join(p.artifactsDir, "attempts"),
    path.join(p.artifactsDir, "explorations"),
    path.join(p.artifactsDir, "reviews"),
    path.join(p.artifactsDir, "candidates"),
    path.join(p.artifactsDir, "resolutions"),
    p.tasksDir,
    p.decisionsDir,
    p.intakeDir,
    p.cardsDir,
    p.capsulesDir,
    p.managerNotesDir,
    p.mathematicalViewsDir,
    p.writeupsDir,
    p.claimsDir,
    p.factsDir,
    p.verificationsDir,
    p.computationsDir,
    p.publicationsDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeFileAtomic(absPath: string, content: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = path.join(
    path.dirname(absPath),
    `.tmp-${crypto.randomBytes(6).toString("hex")}`,
  );
  writeFileSync(tmp, content);
  renameSync(tmp, absPath);
}

const ProjectFile = z.object({
  slug: z.string(),
  title: z.string(),
  createdAt: z.string(),
  config: ProjectConfig,
});
export type ProjectFile = z.infer<typeof ProjectFile>;

export function writeProjectFile(p: ProjectPaths, data: ProjectFile): void {
  writeFileAtomic(p.projectFile, JSON.stringify(data, null, 2));
}

export function readProjectFile(p: ProjectPaths): ProjectFile {
  return ProjectFile.parse(JSON.parse(readFileSync(p.projectFile, "utf8")));
}

export function listProjectSlugs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name) && existsSync(path.join(root, d.name, "project.json")))
    .map((d) => d.name)
    .sort();
}

export function defaultProjectFile(slug: string, title: string, config: ProjectConfigT): ProjectFile {
  return { slug, title, createdAt: new Date().toISOString(), config };
}
