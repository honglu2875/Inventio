/**
 * Short operational prompts and transient instruction files.
 *
 * These messages do not define mathematical roles. They are sent by
 * engine/engine.ts or codex/structured.ts only after the substantive
 * Research Manager or worker packet has already been composed. Keeping them
 * here makes every instruction that can change a model's behavior reviewable
 * beside the long contracts. See README.md in this directory for the complete
 * call-site and lifecycle map.
 */

/**
 * engine/engine.ts → crossExamine(): resumes one completed worker thread when
 * the Research Manager chose `cross_examine`. The original task directory and
 * role contract remain in force; this narrows the resumed turn to one question.
 */
export function focusedFollowUpPrompt(refIds: string[], questionMarkdown: string): string {
  return (
    `Focused mathematical follow-up (answer only what is asked; refer to IDs ${refIds.join(", ") || "n/a"}):\n\n` +
    questionMarkdown +
    `\n\nReply with ONLY a JSON object {"answerMarkdown": "..."}.`
  );
}

/**
 * engine/engine.ts → executeTask(): initial worker launch. AGENTS.md and
 * research-question.md in the composed task directory carry the real contract.
 */
export function workerLaunchPrompt(questionFile: string): string {
  return `Work on the question in ${questionFile}, following AGENTS.md.`;
}

/**
 * engine/engine.ts → executeTask(): resumes a worker thread found running after
 * a Conductor restart. It asks only for completion; it must not alter scope.
 */
export function workerRestartPrompt(questionFile: string): string {
  return `The program restarted while you were working. Finish the question in ${questionFile} and reply with ONLY the required JSON object.`;
}

/**
 * engine/engine.ts → executeTask(): one same-thread correction when a
 * schema-valid response contains no usable mathematics (for example, a refusal
 * or a request for more instructions). This is automatic and never shown as a
 * mathematical question to the owner.
 */
export function unusableWorkCorrectionPrompt(problems: string[]): string {
  return (
    "Your previous return did not constitute usable mathematical work: " +
    problems.join("; ") +
    ". You have everything available for this assignment in the current directory. Proceed now: do the mathematics, state an honest conclusion, and reply with ONLY the required JSON object. Do not ask for permission or more instructions."
  );
}

/**
 * engine/engine.ts → executeTask(): starts one fresh independent replacement
 * after the original worker and its correction turn still fail to return usable
 * mathematics. The replacement sees the same packet but not the prior thread.
 */
export function freshWorkerReplacementPrompt(questionFile: string): string {
  return `Work on the question in ${questionFile}, following AGENTS.md. Earlier attempts did not produce usable mathematical work, so start independently from the files in this directory. Reply with ONLY the required JSON object; do not ask for permission or more instructions.`;
}

/**
 * codex/structured.ts → runStructured(): resumes a thread when the Codex
 * process failed after producing a thread id. Used for every model role.
 */
export const PROCESS_FAILURE_RESUME_PROMPT =
  "Your previous process ended unexpectedly. Finish the assignment now and reply with ONLY the required JSON object.";

/**
 * codex/structured.ts → runStructured(): one schema-repair turn after a
 * completed model response fails JSON parsing or Zod validation. The exact
 * validator messages are included so the model changes structure, not content.
 */
export function structuredOutputRepairPrompt(errors: string[]): string {
  return (
    `Your final message did not validate against the required output schema. ` +
    `Errors:\n${errors.map((error) => `- ${error}`).join("\n")}\n` +
    `Reply with ONLY the corrected JSON object, no prose, no code fences.`
  );
}

/**
 * engine/engine.ts → decisionPoint(): added to the unchanged Research Manager
 * directory before an automatic retry when the process itself did not finish.
 */
export function nextMoveCallRetryNote(failure: string): string {
  return (
    `# Automatic retry\n\nThe previous next-move call did not complete (${failure}). ` +
    "The mathematical record is unchanged. Read it afresh and choose the next move."
  );
}

/**
 * engine/engine.ts → decisionPoint(): added after deterministic validation
 * rejects a Research Manager action. It carries only validator output and does
 * not rewrite the mathematical record.
 */
export function rejectedNextMoveNote(violations: string[]): string {
  return (
    `# Your previous proposal was rejected\n\n${violations.map((violation) => `- ${violation}`).join("\n")}\n\n` +
    "Propose a corrected action."
  );
}

/**
 * engine/engine.ts → runCuration(): added for the second and final automatic
 * completed-round assessment attempt when its first structured result is
 * incomplete or violates deterministic curation rules.
 */
export function curationRetryNote(violations: string[]): string {
  return (
    "# Automatic retry\n\nThe previous assessment was incomplete:\n\n" +
    violations.map((violation) => `- ${violation}`).join("\n") +
    "\n\nRead the unchanged round record afresh and return a complete corrected result."
  );
}
