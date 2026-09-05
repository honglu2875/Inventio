import type { ProjectState } from "@inventio/schema";
import { withMathematicalWritingGuidance } from "./shared.js";
import { researchIndex, qualifiedRecord } from "./recurrent.js";

export const PUBLICATION_PROMPT =
  "Reassess the concluded mathematics and prepare the standalone TeX manuscript described in AGENTS.md. " +
  "Reply with ONLY one JSON object conforming to the provided output schema. Because the response is JSON, double every TeX backslash.";

const PUBLICATION_CONTRACT = `# Standalone mathematical manuscript

You are a mathematician making one final mathematical and expository pass
after the research has stopped. Read the exact problem, the stopping report,
the complete claim, fact, and verification record, and any
full research write-ups needed to explain the conclusion. The fixed outcome
and exact result qualifications constrain this exposition. You may downgrade
an unsupported conclusion to UNCERTAIN, but cannot elevate it or supply new
mathematics to obtain a stronger outcome. Expose missing arguments explicitly.

Choose exactly one kind of document:

- A preprint is permitted only when a complete proof or a complete
  counterexample survives this final reading. Its result is PROVED or
  DISPROVED.
- A research report is required whenever the main conclusion remains
  uncertain. If a previous proof or disproof cannot be upheld, do not write it
  up as a theorem. Gather the correct proofs and calculations into one
  self-contained account, state the precise gap, and explain the strongest
  partial results and worthwhile next steps. Its result is UNCERTAIN.

Write for mathematicians who have never seen this research environment. The
manuscript must stand entirely on its own. Do not mention Inventio, the owner,
the Research Manager, workers, rounds, internal reviews, or the history of how
the text was assembled. Never expose identifiers such as candidate, claim,
task, review, source, or round labels. Replace every such reference by the
actual mathematical statement, proof, calculation, or ordinary bibliographic
citation. Remove repeated process prose and duplicated arguments.

For a preprint, state the main theorem or counterexample precisely and prove it
in full, including every hypothesis, imported result, sign convention, and
calculation on which the conclusion depends. Cite outside literature in an
ordinary bibliography with enough information to identify the source. For a
research report, present each definite partial theorem with its proof and keep
heuristics or conjectures visibly separate. In either case, define notation
before use and make the exposition concise without omitting a mathematical
dependency.

The program supplies a fixed article preamble and saves the complete TeX
manuscript. The owner may compile that saved source locally afterward. Return:

- title: plain text;
- abstractTex: the TeX contents of the abstract, without an abstract
  environment;
- bodyTex: the complete TeX body after the abstract, beginning with the
  introduction and ending with any bibliography;
- assessment: a short private explanation of why the earlier conclusion
  was upheld or changed. This is shown in the interface and is not inserted
  into the manuscript.

Use the supplied theorem, proposition, lemma, corollary, definition, example,
remark, and proof environments. Do not write a document class, package import,
title command, author, document boundary, file input, external image, or
external bibliography command. Put references directly in a
thebibliography environment. Because these TeX fragments travel inside JSON,
double every backslash: the JSON text should contain \\\\frac so the parsed
TeX contains \\frac.`;

/** Owner-requested manuscript from the trajectory record. */
export function publicationPacketFiles(state: ProjectState, stoppingReport: string, recordIndex: string, digest: string | null): Record<string, string> {
  return {
    "AGENTS.md": withMathematicalWritingGuidance(PUBLICATION_CONTRACT),
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "stopping-report.md": stoppingReport,
    "research-record-index.md": recordIndex,
    "current-record.md": qualifiedRecord(state),
    "working-library.md": researchIndex(state),
    "current-mathematical-view.md": state.research.rounds[state.research.roundOrder.at(-1) ?? ""]?.editorial?.summaryMarkdown ?? "No round summary.",
    "publication-context.md": "The earlier stopping result is evidence about the review state, not an instruction to preserve the conclusion. Check the supplied statements and proofs. A claim needing revision has not been refuted. Facts under an unresolved correction must not be treated as settled.",
    ...(digest ? { "project-summary.md": digest } : {}),
  };
}
