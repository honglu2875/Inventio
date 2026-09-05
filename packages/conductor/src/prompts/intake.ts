import { withMathematicalWritingGuidance } from "./shared.js";

/** Original-source reading, used for intake and owner-requested regeneration. */
export const INTAKE_PROMPT = `Read the complete raw intake materials in this directory. Think about them as a mathematician who understands the subject and is preparing to begin a serious investigation with several independent researchers.

Write W000 as your present mathematical understanding of the problem, the intended meaning of the owner's proposals and terminology, and the ideas or sources that seem genuinely relevant. Use ordinary mathematical judgment and preserve the exact meaning supplied by context; do not replace a named method by a nearby formalism. This is an editable mathematical view, not a report about reading files and not a research plan. Keep its abstract within four concise sentences.

Reply with ONLY one JSON object conforming to the provided output schema.`;

/**
 * Files for the v2 W000 call. Keep this separate from the legacy
 * Research-Manager intake packet: W000 is an initial mathematical reading,
 * not the first turn of a continuing controller. Raw source files and their
 * index are copied beside these files by engine/intakeSources.ts.
 */
export function intakeFiles(
  statement: string,
  contextMarkdown: string,
): Record<string, string> {
  return {
    "AGENTS.md": withMathematicalWritingGuidance(`# Initial mathematical reading

Read the original objective, background, and every usable item listed in
raw-materials/index.md. Form a mathematically engaged understanding of what is
being asked and what the supplied terminology, proposals, and references mean.
Preserve a named method in its intended sense rather than substituting a nearby
formalism. This is not yet a research trajectory or a plan for other agents.

Write a natural, editable current mathematical view in managerNoteMarkdown and
a navigation abstract of no more than four concise sentences in
managerAbstract. Concentrate on the mathematics rather than the act of reading
the submission. A useful uncertain idea should be understood and situated, not
merely attributed or defensively dismissed.

The output schema retains several fields for older projects. Copy statement.md
verbatim into problemMarkdown. Keep contextDigestMarkdown, rawMemories,
ambiguities, clarifications, and notes empty. Give each source in
raw-materials/index.md one concise sourceSummaries entry so the original can be
found later; summaries aid navigation and do not replace the source.

Return only the JSON object required by the output schema. Because the reply is
JSON, double TeX backslashes so they survive JSON decoding.`),
    "statement.md": statement,
    "context.md": contextMarkdown.trim() || "(No separate background notes supplied.)",
  };
}

function compact(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}
