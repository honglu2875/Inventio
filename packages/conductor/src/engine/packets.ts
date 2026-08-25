import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repairLegacyArtifactControls, type WorkerRole } from "@inventio/schema";
import { renderAgentsMd, renderAssignmentMd } from "./contracts.js";

/**
 * Packet composer (DESIGN §7): the jail. Copies only — nothing in the packet
 * references outside it; symlinks are never followed; sealed current-wave
 * artifacts are refused loudly.
 */

export class SealViolationError extends Error {}

const MOUNT_EXCLUDES = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "target", ".DS_Store"]);
const MOUNT_TOTAL_LIMIT = 100 * 1024 * 1024;
const MOUNT_FILE_LIMIT = 5 * 1024 * 1024;

export interface PacketSpec {
  tasksDir: string; // <project>/tasks
  taskId: string;
  role: WorkerRole;
  methodTag: string;
  direction: string;
  briefMarkdown: string;
  tokenBudget: number;
  computation: boolean;
  webSearch: boolean;
  reviewOf: string | null;
  reviewScope: string | null;
  reviewQuestions: string[];
  problemMarkdown: string;
  /** Human-approved background; omitted from independent reviewer packets. */
  intakeContextMarkdown?: string | null;
  capsuleMarkdown: string | null;
  /** absolute source path per granted artifact */
  grantedArtifacts: { id: string; sourcePath: string }[];
  grantedCards: { id: string; markdown: string }[];
  /** absolute directory (or file) per granted mount */
  sourceMounts: { name: string; sourcePath: string }[];
  claimLedgerMarkdown: string | null;
  /**
   * Role-filtered memory catalog written into the packet (PROTOCOL §7 layer 3).
   * The MCP tools are unusable from non-interactive `codex exec` — every call
   * is refused with "MCP tool call requires approval, but approval policy is
   * never" — so the catalog travels with the packet instead of being fetched.
   */
  memoryIndexMarkdown: string | null;
  memoryToolsAvailable: boolean;
  /** artifact ids produced in the current (still-open) wave — sealed */
  sealedArtifactIds: ReadonlySet<string>;
}

export interface ComposedPacket {
  packetDir: string;
  manifest: string[]; // packet-relative file paths, sorted
}

export function composePacket(spec: PacketSpec): ComposedPacket {
  for (const g of spec.grantedArtifacts) {
    if (spec.sealedArtifactIds.has(g.id)) {
      throw new SealViolationError(
        `grant of ${g.id} to ${spec.taskId} violates the current-wave seal`,
      );
    }
  }

  const packetDir = path.join(spec.tasksDir, spec.taskId, "packet");
  mkdirSync(packetDir, { recursive: true });
  const files: string[] = [];

  const write = (rel: string, content: string) => {
    const abs = path.join(packetDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, repairLegacyArtifactControls(content));
    files.push(rel);
  };

  const renderSpec = { ...spec, hasMemoryIndex: spec.memoryIndexMarkdown !== null };

  write("problem.md", spec.problemMarkdown);
  write("research-question.md", renderAssignmentMd(renderSpec));
  if (spec.intakeContextMarkdown != null) write("intake-context.md", spec.intakeContextMarkdown);
  if (spec.capsuleMarkdown !== null) write("research-notes.md", spec.capsuleMarkdown);
  if (spec.claimLedgerMarkdown !== null) write(path.join("references", "relevant-claims.md"), spec.claimLedgerMarkdown);
  if (spec.memoryIndexMarkdown !== null) write("research-library-index.md", spec.memoryIndexMarkdown);

  for (const g of spec.grantedArtifacts) {
    if (!existsSync(g.sourcePath)) throw new Error(`granted artifact ${g.id} missing at ${g.sourcePath}`);
    const rel = path.join("references", "write-ups", `${g.id}.md`);
    // Artifacts are Markdown. Preserve the source evidence byte-for-byte, but
    // do not propagate pre-guard JSON control corruption into new workers.
    write(rel, readFileSync(g.sourcePath, "utf8"));
  }

  for (const c of spec.grantedCards) {
    const academicCopy = c.markdown
      .replace(/^provenance:/m, "source:")
      .replace(/^sourceArtifact:/m, "sourceWriteUp:");
    write(path.join("references", "library-notes", `${c.id}.md`), academicCopy);
  }

  let mountBudget = MOUNT_TOTAL_LIMIT;
  for (const m of spec.sourceMounts) {
    const destRoot = path.join(packetDir, "references", "sources", m.name);
    mountBudget = copyMount(m.sourcePath, destRoot, mountBudget, files, path.join("references", "sources", m.name));
  }

  if (spec.computation) {
    mkdirSync(path.join(packetDir, "scratch"), { recursive: true });
  }

  // AGENTS.md lists the complete manifest, itself included.
  const manifest = ["AGENTS.md", ...files].sort();
  write("AGENTS.md", renderAgentsMd(renderSpec, manifest));

  return { packetDir, manifest };
}

function copyMount(
  source: string,
  dest: string,
  budget: number,
  files: string[],
  relBase: string,
): number {
  const st = lstatSync(source);
  if (st.isSymbolicLink()) return budget; // never follow symlinks
  if (st.isFile()) {
    if (st.size > MOUNT_FILE_LIMIT) return budget; // skip oversized files
    if (st.size > budget) throw new Error(`source mount exceeds total size limit at ${source}`);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    files.push(relBase);
    return budget - st.size;
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (MOUNT_EXCLUDES.has(entry.name)) continue;
      budget = copyMount(
        path.join(source, entry.name),
        path.join(dest, entry.name),
        budget,
        files,
        path.join(relBase, entry.name),
      );
    }
  }
  return budget;
}
