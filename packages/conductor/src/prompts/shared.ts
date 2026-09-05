/** Concise academic prose; mathematical evidence takes priority over style. */
export const MATHEMATICAL_ENGLISH_GUIDANCE = `## Mathematical exposition

Write for a mathematician. Explain the governing idea, then give the argument
in a logical order. Use clear sentences, stable terminology, and explicit
referents. Define nonstandard notation and keep hypotheses and quantifiers
exact. Use ordinary academic language and established mathematical terms.

Be concise by removing repetition, never by omitting a necessary calculation,
source hypothesis, or implication. Sentence length and stylistic preferences
must not constrain a complete proof or verification report. Distinguish what
is proved from what is assumed, conjectured, or supported only by experiments.
The required JSON format applies to the response; these instructions concern
its mathematical prose fields.`;

/** Prevent a known KaTeX failure in multiline mathematical displays. */
export const TEX_LAYOUT_GUIDANCE = `## TeX layout

Inside an aligned, array, or similar multiline environment, never let \\left
and \\right cross an & cell boundary or a \\\\ row boundary. Use fixed-size
\\Bigl … \\Bigr delimiters on separate rows. Alternatively, put the multiline
body inside a nested gathered environment within one matching pair.`;

export const MATHEMATICAL_WRITING_GUIDANCE =
  `${TEX_LAYOUT_GUIDANCE}\n\n${MATHEMATICAL_ENGLISH_GUIDANCE}`;

/** Append the shared contract once, at the highest-priority end of AGENTS.md. */
export function withMathematicalWritingGuidance(contract: string): string {
  return `${contract.trimEnd()}\n\n${MATHEMATICAL_WRITING_GUIDANCE}\n`;
}
