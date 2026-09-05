/** Recovery messages shared by the active trajectory and reader calls. */

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
