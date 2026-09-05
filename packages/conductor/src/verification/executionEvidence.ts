import type { CommandExecutionRecord, VerificationEvidenceDeclaration, VerificationExecutionRecord } from "@inventio/schema";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Evidence comes from the parent-owned archive, outside the verifier packet. */
export function readExecutionEvidence(file: string): VerificationExecutionRecord {
  try {
    if (!existsSync(file)) return { version: 1, capture: "UNAVAILABLE", commands: [] };
    if (statSync(file).size > 32_000_000) return { version: 1, capture: "INCOMPLETE", commands: [] };
    return parseExecutionEvidence(readFileSync(file, "utf8"));
  } catch {
    return { version: 1, capture: "UNAVAILABLE", commands: [] };
  }
}

export function parseExecutionEvidence(text: string): VerificationExecutionRecord {
  const commands = new Map<string, CommandExecutionRecord>();
  let session = 0;
  let turn = 0;
  let complete = text.endsWith("\n");
  let sawEnd = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { complete = false; continue; }
      event = parsed as Record<string, unknown>;
    } catch { complete = false; continue; }
    if (event.type === "thread.started") { session++; turn = 0; sawEnd = false; }
    if (event.type === "turn.started") { turn++; sawEnd = false; }
    if (event.type === "turn.completed" || event.type === "turn.failed") sawEnd = true;
    const item = event.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "command_execution") continue;
    if (typeof item.id !== "string") { complete = false; continue; }
    const ref = `${session}:${turn}:${item.id}`;
    if (!commands.has(ref) && commands.size >= 256) { complete = false; continue; }
    const previous = commands.get(ref);
    const command = typeof item.command === "string" ? item.command : previous?.command ?? "";
    const finished = event.type === "item.completed";
    const exitCode = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : null;
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : null;
    commands.set(ref, {
      ref, command: command.slice(0, 20_000), commandTruncated: command.length > 20_000,
      exitCode,
      status: !finished || exitCode === null ? "UNFINISHED"
        : exitCode === 0 && item.status === "completed" ? "SUCCEEDED" : "FAILED",
      outputSha256: output === null ? null : sha256(output),
      outputExcerpt: (output ?? "").slice(0, 2_000),
    });
  }
  return { version: 1, capture: complete && sawEnd ? "COMPLETE" : "INCOMPLETE", commands: [...commands.values()] };
}

/** Decode one POSIX shell word, never evaluate it. Only CLI shell wrappers use this. */
function shellWord(text: string): string | null {
  let quote = "";
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote === "'") { if (char === "'") quote = ""; else out += char; continue; }
    if (char === '"') { quote = quote === '"' ? "" : '"'; continue; }
    if (!quote && char === "'") { quote = "'"; continue; }
    if (char === "\\") {
      const next = text[++i];
      if (next === undefined) return null;
      if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) out += "\\";
      if (next !== "\n") out += next;
    } else {
      if (!quote && /\s/.test(char)) return null;
      out += char;
    }
  }
  return quote ? null : out;
}

export function canonicalCommand(command: string): string {
  const trimmed = command.trim();
  const wrapper = /^(?:\/[^\s]+\/)?(?:bash|sh)\s+-(?:lc|c)\s+(.+)$/s.exec(trimmed);
  return wrapper ? shellWord(wrapper[1]!) ?? trimmed : trimmed;
}

/** This validates claimed execution, never the mathematics implemented by code. */
export function evidenceIssues(
  declaration: VerificationEvidenceDeclaration | null | undefined,
  required: boolean,
  record: VerificationExecutionRecord,
): string[] {
  if (!declaration) return required ? ["The verification did not state whether its decisive check was a derivation or a computation."] : [];
  if (declaration.basis === "derivation") {
    return declaration.supportingCommands.length ? ["A derivation-only report must not claim computational support."] : [];
  }
  const issues: string[] = [];
  if (record.capture !== "COMPLETE") issues.push("The execution archive is incomplete or unavailable; computational support could not be confirmed.");
  if (!declaration.supportingCommands.length) issues.push("No supporting computation command was identified.");
  for (const command of declaration.supportingCommands) {
    const matched = record.commands.some((entry) =>
      !entry.commandTruncated && entry.status === "SUCCEEDED" &&
      canonicalCommand(entry.command) === canonicalCommand(command),
    );
    if (!matched) issues.push(`No successful execution was recorded for: ${command.slice(0, 240)}`);
  }
  return issues;
}
