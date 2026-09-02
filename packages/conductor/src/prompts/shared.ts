/**
 * Shared English contract for every model-authored mathematical document.
 *
 * This applies ASD-STE100 Simplified Technical English, Issue 9 (2025-01-15),
 * to Inventio's mathematical prose. The standard permits established technical
 * nouns and verbs. Thus, exact mathematical terminology remains available and
 * the controlled prose rules do not alter mathematical meaning.
 */
export const ASD_STE100_GUIDANCE = `## English style — ASD-STE100

Follow ASD-STE100 Simplified Technical English (STE), Issue 9, in every English
prose field that you write. Use your knowledge of the full ASD-STE100 standard.
The examples below emphasize rules that are especially useful in mathematical
writing. They are examples, not a replacement for the standard.

- For example, use common approved words when they preserve the exact meaning. Established
  mathematical nouns and verbs are permitted technical terms.
- For example, use one term for one concept. Do not vary terminology only for style.
- Use American English spelling, as ASD-STE100 specifies.
- For example, write short, direct sentences. Use the active voice when the actor is known.
  Use at most 25 words in a prose sentence when practical.
- For example, give information gradually. Put one main point in each sentence and one topic
  in each paragraph. Keep a paragraph to six sentences when practical.
- For example, use simple verb tenses. Avoid ambiguous “-ing” clauses, phrasal verbs, idioms,
  unnecessary jargon, long noun clusters, and semicolons.
- Do not omit necessary words. For example, give each pronoun a clear referent. Prefer “this
  lemma” or “this identity” to a bare “this.”
- For example, define each abbreviation and each nonstandard symbol before use. Use a list
  or a displayed formula for complex hypotheses.

For example, write “Lemma 2 applies. It gives the required bound.” Do not write
“Applying Lemma 2, it can be seen that the required bound follows.”

These rules apply to all prose. This includes abstracts, statements, proofs,
reports, notes, milestones, reasons, and private assessments. They do not
change literal quotations, source titles, proper names, code, JSON keys, or
mathematical notation.

Mathematical rigor and self-containedness have priority. Preserve every
hypothesis, quantifier, dependency, and logical distinction. Never weaken,
strengthen, or shorten a statement to satisfy a language rule. If exact
mathematics needs a complex sentence, split the prose around a displayed
formula or a clear list. Keep the tone natural and academic, not childish or
telegraphic. The role's required JSON format remains in force. Apply this
English contract inside its prose fields.`;

/** Prevent a known KaTeX failure in multiline mathematical displays. */
export const TEX_LAYOUT_GUIDANCE = `## TeX layout

Inside an aligned, array, or similar multiline environment, never let \\left
and \\right cross an & cell boundary or a \\\\ row boundary. Use fixed-size
\\Bigl … \\Bigr delimiters on separate rows. Alternatively, put the multiline
body inside a nested gathered environment within one matching pair.`;

export const MATHEMATICAL_WRITING_GUIDANCE =
  `${TEX_LAYOUT_GUIDANCE}\n\n${ASD_STE100_GUIDANCE}`;

/** Append the shared contract once, at the highest-priority end of AGENTS.md. */
export function withMathematicalWritingGuidance(contract: string): string {
  return `${contract.trimEnd()}\n\n${MATHEMATICAL_WRITING_GUIDANCE}\n`;
}
