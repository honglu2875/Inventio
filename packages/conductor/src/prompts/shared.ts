/**
 * Shared TeX instruction inserted into every mathematical-authoring contract.
 *
 * researchManager.ts includes it in W000, decision, assessment, revision, and
 * final-report AGENTS.md files. workers.ts includes it in every worker
 * AGENTS.md. The rule prevents a known KaTeX failure when scalable delimiters
 * cross alignment cells or rows.
 */
export const TEX_LAYOUT_GUIDANCE =
  "Inside an aligned, array, or similar multiline environment, never let " +
  "\\left and \\right cross an & cell boundary or a \\\\ row boundary. " +
  "Use fixed-size \\Bigl … \\Bigr delimiters on separate rows, or put the " +
  "multiline body inside a nested gathered environment within one matching pair.";
