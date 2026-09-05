import { describe, expect, it } from "vitest";
import { canonicalCommand, evidenceIssues, parseExecutionEvidence, sha256 } from "../src/verification/executionEvidence.js";

function archive(items: Record<string, unknown>[], end = true): string {
  return [
    { type: "thread.started", thread_id: "thread" }, { type: "turn.started" },
    ...items.map(item => ({ type: "item.completed", item })),
    ...(end ? [{ type: "turn.completed" }] : []),
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
}
const cmd = (exit: number, output = "") => ({ id: "item_0", type: "command_execution", command: "python scratch/check.py", aggregated_output: output, exit_code: exit, status: exit === 0 ? "completed" : "failed" });
const declaration = { basis: "computation" as const, supportingCommands: ["python scratch/check.py"] };

describe("authentic execution evidence", () => {
  it("rejects computational support from a failed command while allowing an explicit hand derivation", () => {
    const evidence = parseExecutionEvidence(archive([cmd(1, "Traceback")]));
    expect(evidence.capture).toBe("COMPLETE");
    expect(evidence.commands[0]!.status).toBe("FAILED");
    expect(evidenceIssues(declaration, true, evidence)).toHaveLength(1);
    expect(evidenceIssues({ basis: "derivation", supportingCommands: [] }, true, evidence)).toEqual([]);
  });
  it("records zero-output success, distinct retries, unfinished execution, and output hashes", () => {
    const text = archive([cmd(1, "failure")]) + archive([cmd(0)]);
    const evidence = parseExecutionEvidence(text);
    expect(evidence.commands.map(c => c.ref)).toEqual(["1:1:item_0", "2:1:item_0"]);
    expect(evidence.commands[1]!.outputSha256).toBe(sha256(""));
    expect(evidenceIssues(declaration, true, evidence)).toEqual([]);
    const unfinished = parseExecutionEvidence(archive([{ ...cmd(0), exit_code: null, status: "in_progress" }], false));
    expect(unfinished.capture).toBe("INCOMPLETE");
    expect(unfinished.commands[0]!.status).toBe("UNFINISHED");
    expect(evidenceIssues(declaration, true, unfinished)).not.toEqual([]);
  });
  it("does not turn missing declarations, malformed archives or unrelated successful commands into confirmation", () => {
    const evidence = parseExecutionEvidence(archive([{ ...cmd(0), command: "pwd" }]) + '{"type":');
    expect(evidence.capture).toBe("INCOMPLETE");
    expect(evidenceIssues(declaration, true, evidence)).toHaveLength(2);
    expect(evidenceIssues(null, true, evidence)).toHaveLength(1);
    expect(evidenceIssues(null, false, evidence)).toEqual([]); // historical frozen policy
  });
  it("decodes CLI shell quoting without running substitutions or accepting a changed command", () => {
    expect(canonicalCommand("/bin/bash -lc 'python scratch/check.py'")).toBe("python scratch/check.py");
    expect(canonicalCommand('/bin/bash -lc "echo \\$(whoami)"')).toBe("echo $(whoami)");
    expect(canonicalCommand("/bin/bash -lc 'echo '\"'\"'x'\"'\"''")).toBe("echo 'x'");
    expect(canonicalCommand("/bin/bash -lc 'python check.py' extra")).not.toBe("python check.py");
  });
});
