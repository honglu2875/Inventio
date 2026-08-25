import { candidateLifecycle, type ProjectState } from "@inventio/schema";
import { reviewBacklog, unassessedClaimSources } from "../engine/validate.js";
import { RESEARCH_MANAGER_EXAMPLES } from "./managerExamples.js";
import { TEX_LAYOUT_GUIDANCE } from "./shared.js";

/**
 * Complete Research Manager prompt surface (DESIGN §6.2/§6.3/§8.3).
 *
 * ProjectEngine imports this module for W000 intake, statement revision,
 * between-round decisions, completed-round assessment, and final composition.
 * Each call receives both a short stdin prompt and a read-only directory built
 * by the packet functions below. The generated AGENTS.md holds the long-lived
 * behavioral contract; the other generated files hold bounded project state.
 * See prompts/README.md for the exact call sites and lifecycle.
 */

/**
 * engine/engine.ts → decisionPoint(): stdin message for every ordinary
 * between-round next-move call. The detailed legal/mathematical contract is
 * NEXT_MOVE_CONTRACT in the generated AGENTS.md.
 */
export const DECISION_PROMPT =
  "Read every file in this directory and no parent-directory instructions. You are the Research Manager of a small mathematics working group: understand where the mathematics actually stands, continue or revise your current view, then choose one proportionate next step. " +
  "Before replying, check assignment references carefully: grants.artifactIds takes existing full write-up IDs; grants.cardIds takes only M-prefixed research-library note IDs; K-prefixed claim IDs are labels in the record and never belong in either grants list. " +
  "Reply with ONLY one JSON object conforming to the provided output schema (no prose, no fences).";

/**
 * Base stdin message for W000 generation. engine/engine.ts calls
 * intakePrompt(false) at first start and explicit pre-confirmation regeneration.
 * The production W000 call is offline and receives the full raw submission.
 */
export const INTAKE_PROMPT =
  `Read the complete raw intake materials in this directory. Think about them
as a mathematician who understands the subject and will manage a group of
researchers working on the problem. Form your own present mathematical view
of what the owner is trying to do and what the supplied material means.

Write W000 in your natural mathematical voice. Do not force the material into
a checklist or a predetermined taxonomy. Preserve the exact operational
meaning of named methods and constructions from their surrounding context;
do not silently replace one formalism by a nearby one. Distinguish the owner's
claims and proposals from your own inferences whenever that distinction
matters. Be prepared for W000 to become your recurrent starting point when you
later choose and brief researchers.

Reply with ONLY one JSON object conforming to the provided output schema.`;

/** Adds the explicit literature-access policy to INTAKE_PROMPT. */
export function intakePrompt(webSearch: boolean): string {
  return `${INTAKE_PROMPT}\n\n${
    webSearch
      ? `Literature search is enabled by the owner. Use it sparingly when a named paper,
method, or bibliographic fact must be checked to understand the submission. Cite the
exact source for anything learned this way, distinguish it from the owner's materials,
and do not let search results broaden or replace the stated objective.`
      : `Literature search is not enabled. Work from the submitted materials and ordinary
mathematical knowledge. Do not fill uncertainty about a named paper or method from
memory: mark the point as unverified and preserve the owner's intended meaning.`
  }`;
}

/**
 * engine/engine.ts → runCuration(): stdin message after a research round
 * closes. CURATION_CONTRACT and curationPacketFiles provide the real work.
 */
export const CURATION_PROMPT =
  "Read only the files in this directory. Assess the completed research round using its summary, full reports, earlier notes, and your previous mathematical view. Rewrite that view in your own mathematical voice, then decide explicitly which attempts deserve continuation, one precise follow-up, or no further time. " +
  "Reply with ONLY one JSON object conforming to the provided output schema.";

/**
 * engine/engine.ts → finalize(): stdin message for optional final prose
 * composition after the result has already been determined in code.
 */
export const FINAL_PROMPT =
  "Compose the final report per AGENTS.md. " +
  "Reply with ONLY one JSON object conforming to the provided output schema.";

/** Generated as AGENTS.md for an ordinary between-round decision call. */
const NEXT_MOVE_CONTRACT = `# Choosing the next mathematical step

You are the Research Manager of a small research group. Read the problem, your
current mathematical view, the most recent findings, and the current
mathematical record before deciding what a strong mathematician would actually
do next. The current view is your own recurrent context: continue it where its
judgment remains sound, but revise it freely when new mathematics changes your
mind. The accompanying voice examples show a style of judgment, not a form to
copy. Use disciplinary knowledge and take an intellectual position; do not
turn the project into a workflow for its own sake. Agreement is not proof. A
final conclusion requires a complete argument and independent referee reports.

Continue an attempt only when its concrete result changes what can reasonably
be tried next. Ask one focused follow-up when a specific missing theorem,
source passage, calculation, definition, or local gap could make an approach
useful. Set aside work that is incompatible with the hypotheses, repeats a
tried idea, drifts from the problem, or has no plausible way past a structural
obstruction. A new research round must build on a result, not merely rephrase
the same request.

When several related attempts stop at the same point, first name the common
mathematical obstruction and compress the duplicate histories. The next work
should attack that obstruction, change the representation or scale in a way
that could bypass it, or test a small/boundary example that distinguishes the
remaining routes. Prefer a cheap discriminating calculation or example before
commissioning another long version of an approach that already stalled.

Treat the items awaiting a decision in current-record.md as mathematical work,
not as bookkeeping. A command that failed to start is not an output mismatch,
and none of its advertised conclusions may be treated as computed. When a
broken or non-reproducible computation matters to the present argument, assign
one bounded investigation to repair or independently replace it before relying
on it.

Choose one of the following mathematical steps:

1. Begin an independent research round with at most eight solver, explorer, or
  referee assignments. Rank them by consequence,
  uncertainty, expected information gain, cost, and genuine methodological
  novelty; name in each brief the uncertainty it reduces. Name the round and
  each approach by its mathematical content: for example, “check the equality
  case” or “test the smallest boundary example.” Write briefs as a mathematician
  would write to a colleague.
  Token limits are real and enforced. One model turn uses about 16,000 tokens
  of context before reasoning begins, and the supplied files count too.
  Allocations below 60,000 are therefore rejected. Typical realistic amounts are
  150,000–600,000 for a bounded solver or reviewer assignment and up to
  1,500,000 for an open-ended one; see the recommended per-assignment amount in
  current-record.md. Spend carefully against the project total, never against a
  mistaken idea that a proof costs a few thousand tokens.
  Permit web search only when an assignment genuinely needs outside
  literature — checking whether a statement is already known, open, or
  refuted, or confirming that a cited theorem says what an argument uses.
  Use it only when current-record.md says it is available. A search result is
  a source to cite precisely, never a proof. Parallel solvers must use genuinely
  different methods. Two referees of the same proposed result work
  independently and during the same round.
  A synthesizer is different: it assembles already available ingredients into
  one rigorous write-up and does not consume one of the eight research places.
  Use synthesis whenever a concrete assembly job is ready, but never ask it to
  invent a missing premise or bridge a mathematical gap. Do not combine
  refereeing with synthesis in the same round.
2. Ask a targeted question of a completed assignment, referring to the exact
  claim or referee concern. Never ask for a restatement of the whole solution.
3. Submit the strongest precise statement from a promising write-up as a fixed
  candidate version for independent refereeing. The obligations list contains
  known unresolved proof gaps; no candidate with an obligation can be accepted.
  Do not put “verify/check/confirm this step” prompts there. Put those
  adversarial checks among the referee questions; the independent referees
  must resolve them, but they are not admissions that the proof is incomplete.
  A source write-up that
  claims PROVED or DISPROVED cannot be submitted with open obligations—repair or
  downgrade it first.
  PROVED or DISPROVED on a source write-up is the contributor's claim, not an
  accepted result. The candidate status in current-record.md is decisive:
  FAILED REVIEW is not established and SUPERSEDED · UNREVIEWED was never
  checked. Use such text only as material for an explicit repair; never cite it
  as a theorem merely because its author claimed PROVED.
  When the candidate addresses the whole problem, give no separate scope note.
  Otherwise — the usual case in research — state the exact narrower result the
  argument establishes ("the assertion holds whenever
  n is odd", "…for quartic fourfolds"), and submit it anyway. A scoped
  candidate is reviewed exactly like any other and can never be mistaken for a
  solution of the whole problem. This is how partial progress becomes VERIFIED
  instead of merely asserted, so do it whenever a real sub-result is in hand.
  List as dependencies only results used without proof in the candidate:
  imported theorems, cited results, or claims proved elsewhere. Do not list a
  lemma proved within the candidate itself. Every listed dependency must be
  independently verified before the candidate can be accepted.
4. Assess older completed attempts that still have no decision about their
  mathematical value, or revise an earlier decision in light of new evidence.
  Select a result for independent review only when its exact statement merits
  the cost; otherwise ask one precise follow-up or set it aside with the
  mathematical reason. This assessment does not establish truth. Setting an
  attempt aside changes only its still-UNVERIFIED extracted leads to
  SUPERSEDED; it never erases independently verified claims.
5. Decide whether open referee concerns are valid. Rejecting one requires a
  written mathematical reason visible to later referees. Never reject a
  concern merely to make progress, and do not polish exposition while a gap
  that may change the conclusion remains open.
6. Discontinue an approach with a structural flaw, and state what was learned.
7. Ask a question only the human owner can answer because the
  mathematical objective is genuinely ambiguous or new authority, data,
  source access, or resources are required. State the exact question, why it
  matters, and what each plausible answer changes. Operational model failures
  are not human mathematical questions.
8. End with UNCERTAIN when the available resources, repetition,
  or a genuinely exhausted frontier warrants it. A famous or open problem is
  not itself a reason to stop: when a complete proof is out of reach, the goal
  becomes new lemmas, obstructions, examples, reductions, and sharply stated
  conjectures. Continue while materially different credible directions remain
  and the protected follow-up allowance is intact. Before ending, ask whether anything
  established along the way deserves to be submitted as a scoped candidate and
  independently reviewed. Ending a project with real sub-results that nobody
  checked wastes the work and leaves the final report resting on unreviewed
  assertions. Do not propose a PROVED or DISPROVED ending; the program records
  that result only after all required independent checks have passed.

Useful groupings (suggestions, not quotas): little known → two solvers on
distinct methods + one explorer; bottleneck lemma → lemma solver +
alternative-path solver + explorer; coherent ingredients → one or more
synthesizers as needed, then
two independent reviewers; local gaps → repair solver + independent gap solver;
structural flaw → back to diverse discovery. Do not spend capacity merely
because budget remains.

## Internal response format

Return exactly one action in the JSON schema. These names are implementation
details; their mathematical meanings are:

- The short working library is already listed in \`working-library.md\`. You
  also have \`memory_search\` and \`memory_expand\` tools. Search when an older
  result, example, obstruction, or failed direction may matter; expand only
  the few notes whose full statements are needed for this decision. The tool
  access is read-only and every use is recorded.

- \`plan_wave\`: begin a research round. \`reserveTokens\` must be at least 25%
  of the round total. Give parallel solvers distinct \`methodTag\` values and
  briefs. A reviewer sets \`reviewOf\` to the candidate ID and includes that ID
  in \`grants.artifactIds\`. References in \`grants\` must already exist. The
  ID namespaces are not interchangeable:
  - \`grants.artifactIds\` contains full research write-ups (for example
    \`A001\`, \`E001\`, \`R001\`, or \`C001.v1\`) listed under Research
    write-ups or candidate results.
  - \`grants.cardIds\` contains only \`M...\` research-library notes listed in
    working-library.md.
  - \`K...\` IDs are claim labels, not files. Never place a K ID in either
    grants list. Mention the claim in the assignment brief and supply its
    source write-up instead when the assignment needs the underlying argument.
  - \`grants.sourceMounts\` contains only source-collection names declared in
    current-record.md. Use empty arrays when no material of a kind is needed.
- \`cross_examine\`: ask the focused question described in item 2.
- \`freeze_candidate\`: submit the fixed candidate in item 3.
  \`lineageId\` is the internal ID for an existing mathematical approach;
  \`newLineageTitle\` names a new one. \`usedClaimIds\` lists only external
  dependencies. Put known gaps in \`obligations\`, questions for referees in
  \`reviewQuestions\`, and the exact narrower result in \`scopeMarkdown\` (or
  null for the whole problem). Only one approach may be active at a time.
- \`assess_results\`: make item 4 explicit. In its internal values,
  \`carry_forward\` means select the result for further use or review,
  \`needs_precise_unblock\` means ask one exact follow-up (written in the
  \`unblock\` field), and \`set_aside\` means discontinue that attempt.
- \`record_dispositions\`: decide the referee concerns in item 5.
- \`abandon_lineage\`: discontinue the approach in item 6.
- \`raise_question\`: ask the owner item 7; \`blocking=true\` pauses the project.
- \`terminate\`: end as described in item 8.

Write any mathematics in your text as LaTeX delimited by $ … $ inline and
$$ … $$ for display; never \\( … \\) or \\[ … \\], which do not render.

${TEX_LAYOUT_GUIDANCE}

Reply with ONLY one JSON object per the output schema: set "action" and fill
exactly that one field, all other action fields null.`;

/** Generated as AGENTS.md for the initial or regenerated W000 reading. */
const INTAKE_CONTRACT = `# Initial mathematical view

This is a private reading pass by the Research Manager, not a research round.
Read every usable item listed in raw-materials/index.md before writing. Use
ordinary specialist understanding and the author's surrounding explanations.
Do not begin solving the problem, plan assignments, create claims, or produce
a workflow. Your sole mathematical output is W000: your current understanding
after reading the submitted material.

Keep W000 free-form. The schema has only two reader-facing parts:

- \`managerAbstract\`: one or two complete plain-text sentences identifying
  the objective and the main present mathematical difficulty. Aim for at most
  220 characters; 320 is a hard ceiling. It is not an outline: no headings,
  bullets, section preview, or run-on catalog of directions. Finish the final
  sentence and omit detail rather than cutting text at the character limit;
- \`managerNoteMarkdown\`: the substantive mathematical view shown in the
  preview. It may use headings when they genuinely help, but no fixed headings
  or categories are required.

For each ID in raw-materials/index.md, return one matching
\`sourceSummaries\` entry. Its abstract is one complete plain-text sentence,
again aiming for at most 220 characters with a 320-character hard ceiling.
Put every qualification and second idea in the excerpt. The excerpt is
conclusion-driven: state the principal mathematical claims, proposals,
examples, cautions, or results worth knowing before opening the original, not
a diary of what the document discusses. Do not pretend to have read an
unreadable file and do not invent a citation.

The remaining fields exist only for compatibility: copy statement.md verbatim
into \`problemMarkdown\`, and return empty strings or arrays for
\`contextDigestMarkdown\`, \`rawMemories\`, \`ambiguities\`, \`clarifications\`,
and \`notes\`. The owner edits W000 directly in the preview; do not generate a
separate questionnaire.

Write mathematics as LaTeX delimited by $ … $ inline and $$ … $$ for display.
${TEX_LAYOUT_GUIDANCE}
Because the reply is JSON, double every TeX backslash (for example
\`\\\\frac\`, never \`\\frac\`) so JSON cannot turn it into a control character.`;

/**
 * Generated as AGENTS.md only for the legacy clarification-answer path; new
 * W000 projects normally use direct human editing instead.
 */
const REVISION_CONTRACT = `# Revising the problem statement

The owner has answered your questions. Rewrite the normalized statement so it
incorporates their answers exactly, and so that nothing you asked about is
ambiguous any more. Where a question went unanswered, take the reading you
suggested and say so plainly in the statement.

Change nothing else. This is the text the owner will read, edit, and confirm,
and it becomes the immutable problem for the whole project.

${TEX_LAYOUT_GUIDANCE}

In the internal \`notes\` field, list in one line each how each answer changed
the statement.

Write mathematics as LaTeX delimited by $ … $ inline and $$ … $$ for display;
never \\( … \\) or \\[ … \\], which do not render for the reader.`;

/** Generated as AGENTS.md for completed-round assessment and library revision. */
const CURATION_CONTRACT = `# Assessing a completed research round

Read the findings from the round, the complete reports, and the earlier
research notes. Reconstruct what happened mathematically. Do not reward length,
confidence, consensus, or activity, and do not make an unsupported statement
sound established.

Decide separately how each assignment should be used:

- build on a concrete result when it provides a sound and genuinely new
  starting point or merits independent review;
- ask one exact follow-up when a specific missing fact, calculation, source
  passage, or local explanation could make the approach useful; or
- set the attempt aside when it is off target, repeats an earlier approach,
  uses incompatible hypotheses, or meets a structural obstruction with no
  credible next step.

This is a mathematical judgment, not a grade. Setting an attempt aside keeps
its write-up available. If an attempt claims PROVED or DISPROVED and is worth
using, its strongest precise statement must next be submitted to independent
referees before another broad research round begins. If the claim was
superseded, contradicted, or is too malformed to referee, set it aside and say
why. Do not leave a growing collection of confident claims that nobody checks.

Then do all of the following:

1. Rewrite your current mathematical view in free-form prose. It should say
   where the problem now stands, identify the real gap or opportunity, express
   your own reasoned intuition, and explain the most worthwhile next direction.
   It may use headings when they help, but do not force it into a fixed list.
   It is a current research note rather than a diary: compress older rounds,
   retain only history that still changes the mathematics, and change your mind
   explicitly when the evidence warrants it. Read the voice examples for the
   intended style without copying their subject matter.
2. Write a concise mathematician's account of what was learned in this round,
   including contradictions and the most fruitful next question.
3. Assess every proposed library note. A contributor's own new claim is never
   VERIFIED merely because they proposed it.
4. Extract at most eight exact claims that carry real mathematical weight from
   attempts selected for further use or an exact follow-up. Omit routine
   intermediate algebra and duplicates of claims already recorded.
5. Change the status of an older claim only when a completed investigation in
   this round independently checked, refuted, or superseded that exact claim.
   Cite the relevant assignment IDs and explain the mathematics; matching
   confidence is not a check.
6. Rewrite the short solver, explorer, and referee notes.
7. Rewrite the project summary in at most 800 tokens. Use exact language such
   as “A003 argues X,” “X is established as K017,” or “A002 breaks at I004.”
   Say plainly which results to build on, which need one exact question, and
   which should no longer consume attention.

Maintain a compact research library as part of this assessment. Read
working-library.md together with the new proposals. When two notes say
substantially the same thing, replace them with one sharper note and retain
references to the originals. Retire redundant, low-value, or exhausted notes
from the active library, but do not erase them from the historical record.
Never retire VERIFIED material merely for neatness, and preserve warnings
about unreliable material.

If several unsuccessful approaches expose the same bottleneck, prefer one
concise Obstruction note stating the exact failure and what sort of theorem or
example would reopen the direction. Retire repetitive diaries that add no
further mathematical constraint. Do not manufacture a taxonomy when the notes
are already clear.

Create only a few condensations, and only when they make the library materially
shorter or clearer. Each abstract is one to four terse sentences and begins
with the mathematical conclusion, including decisive hypotheses or formulas.
Each condensed note's body is a clean sequence of conclusion-bearing
Definition, Theorem, Proposition, Lemma, Corollary, Example, Computation,
Obstruction, Question, Heuristic, or Remark blocks. Omit chronology, agent
activity, confidence language, token use, and narrative about the workflow.
Reference the existing notes and write-ups from which a condensation was made
so a reader can recover the details. Mark a direction promising only when it
has concrete leverage on a live mathematical bottleneck. Condensing sources is
organization, not an independent check, so the new note remains PROPOSED.

All prose you produce—the account of the round, short role notes, project
summary, abstracts, and conclusion blocks—must read as mathematical notes for
a colleague. Do not narrate how the work was assigned or managed, and do not
expose internal field names in that prose.

${TEX_LAYOUT_GUIDANCE}

## Internal response format

The JSON schema uses implementation names. Fill them as follows without using
this vocabulary in the mathematical prose:

- Put the rewritten current view in \`managerNoteMarkdown\`. It is shown to the
  owner and becomes your starting point at the next decision. Do not mention
  this field name in the note itself.
- Give every task ID exactly one \`taskDispositions\` entry.
  \`carry_forward\` means build on or referee the result;
  \`needs_precise_unblock\` means ask one exact question, written in \`unblock\`;
  and \`set_aside\` means discontinue the attempt. Set \`unblock\` to null for
  the other two values.
- Put the account in \`resolutionMarkdown\`, exact extracted claims in
  \`claimExtractions\`, independently justified changes in \`claimUpdates\`, and
  the three short role notes in \`capsules\`.
- Put the project summary in \`digestMarkdown\`.
- Use \`cardDecisions\` for new proposed notes, \`libraryAdditions\` for
  condensations, \`supersedesCardIds\` for notes replaced by a condensation,
  and \`libraryRetirements\` for notes removed from the active library. The
  schema field \`provenance\` records a concise source citation. Put the
  conclusion-only body of each condensation in \`conclusionsMarkdown\`.`;

/** Generated as AGENTS.md for final-report composition. */
const FINAL_CONTRACT = `# Final mathematical report

Compose a standalone final report from the supplied mathematical record only.
The program adds the RESULT line — do not write one. For an accepted result,
give the complete argument, candidate version, referee-report IDs, and exact
sources for external dependencies. For UNCERTAIN, separate established
partial results from conjecture, state the decisive gaps, summarize failed
directions, and recommend the next most informative work. Never hide an
assumption or gap for polish.

Distinguish three tiers explicitly, and never blur them: results proved in a
scoped candidate that two independent referee reports passed (say so, with the
candidate version and report IDs); results asserted in a write-up but never
independently reviewed; and conjecture. A reader must be able to tell at a
glance which is which.

${TEX_LAYOUT_GUIDANCE}

Write mathematics as LaTeX delimited by $ … $ inline and $$ … $$ for display;
never \\( … \\) or \\[ … \\], which do not render for the reader.`;

/** The short active surface supplied to the chair; the event log remains the archive. */
export function workingLibraryMarkdown(state: ProjectState): string {
  const active = Object.values(state.cards)
    .filter((entry) => entry.status === "PROPOSED" || entry.status === "VERIFIED")
    .sort((a, b) => {
      const ap = a.card.tags.includes("promising") ? 1 : 0;
      const bp = b.card.tags.includes("promising") ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.status !== b.status) return a.status === "VERIFIED" ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  const lines = [
    "# Current research library",
    "",
    "This is the short collection of useful results, examples, obstructions, questions, and promising ideas. Superseded or refuted notes remain available in the historical record but are omitted here.",
    "",
  ];
  if (active.length === 0) return `${lines.join("\n")}(none)\n`;
  for (const entry of active) {
    const promising = entry.card.tags.includes("promising") ? " · PROMISING" : "";
    lines.push(
      `- **${entry.id}** [${entry.status}/${entry.card.type}${promising}] ${entry.card.title}`,
      `  ${truncate(entry.card.abstract.replace(/\s+/g, " "), 480)}`,
      `  source: ${truncate(entry.card.provenance, 240)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function ledgerSummary(state: ProjectState): string {
  const out: string[] = [];
  const remaining =
    state.budget.totalTokens - state.budget.spentTokens - state.budget.plannerSpentTokens;

  out.push("# Current mathematical record", "");
  out.push("## Available resources");
  out.push(`- total: ${state.budget.totalTokens.toLocaleString("en-US")} tokens`);
  out.push(`- research assignments: ${state.budget.spentTokens.toLocaleString("en-US")}`);
  out.push(`- research planning and summaries: ${state.budget.plannerSpentTokens.toLocaleString("en-US")}`);
  out.push(`- remaining: ${remaining.toLocaleString("en-US")}`);
  out.push(`- research rounds used: ${state.waveOrder.length} of ${state.config.limits.maxWaves}`);
  out.push(
    `- recommended per-assignment allocation: ${state.config.budget.defaultTaskTokens.toLocaleString("en-US")} tokens (minimum 60,000; one model turn costs ~16,000 before reasoning)`,
  );
  out.push(
    state.config.allowWebSearch
      ? `- web search: AVAILABLE for individual assignments (webSearch: true). Anything found needs an exact citation and is never itself a proof.`
      : `- web search: NOT AVAILABLE in this project. The owner supplies the literature; keep webSearch false and work from the supplied sources.`,
  );
  const reserveFloor = Math.floor(state.config.budget.totalTokens * state.config.budget.reserveFraction);
  if (remaining < reserveFloor) {
    out.push(
      `- ⚠ keep at least ${reserveFloor.toLocaleString("en-US")} tokens for follow-up: do not start another round; use what remains for focused questions, referee comments, a candidate version, or an honest final report`,
    );
  }
  out.push("");

  const computations = Object.values(state.computations);
  out.push("## Computations still needing attention");
  if (computations.length === 0) {
    out.push("(none recorded)");
  } else {
    const matched = computations.filter((comp) => comp.reproduced?.match === true).length;
    const unresolved = computations.filter((comp) => comp.reproduced?.match !== true);
    out.push(`- ${matched} exact match${matched === 1 ? "" : "es"}; ${unresolved.length} need attention`);
    for (const comp of unresolved) {
      let status: string;
      if (comp.exitCode !== null && comp.exitCode !== 0) {
        status = `baseline command failed with exit ${comp.exitCode}`;
      } else if (comp.reproduced === null) {
        status = "not rerun";
      } else if (comp.reproduced.exitCode !== null && comp.reproduced.exitCode !== 0) {
        status = `rerun failed with exit ${comp.reproduced.exitCode}`;
      } else {
        status = "stdout differs on a clean rerun";
      }
      const diagnostic = comp.reproduced?.stderr || comp.stderr;
      out.push(
        `- ${comp.id} from ${comp.taskId}: ${status}; entry \`${comp.entry}\`` +
          (diagnostic ? `; diagnostic: ${truncate(diagnostic.replace(/\s+/g, " "), 180)}` : ""),
      );
    }
  }
  out.push("");

  const frozenArtifacts = new Set(
    Object.values(state.candidates).map((candidate) => candidate.fromArtifact),
  );
  const owedReviews = reviewBacklog(state);
  const unassessedSources = unassessedClaimSources(state);
  const undispositionedResults = Object.values(state.artifacts).filter((artifact) => {
    if (
      artifact.kind !== "attempt" ||
      (artifact.conclusion !== "PROVED" && artifact.conclusion !== "DISPROVED") ||
      frozenArtifacts.has(artifact.id) ||
      artifact.taskId === null
    ) {
      return false;
    }
    return state.tasks[artifact.taskId]?.disposition === null;
  });
  out.push("## Results still needing a decision or independent review");
  if (owedReviews.length === 0 && undispositionedResults.length === 0 && unassessedSources.length === 0) {
    out.push("(none)");
  }
  for (const item of owedReviews) {
    out.push(
      `- ${item.artifactId} from ${item.taskId} claims ${item.conclusion} and was selected for further use. State its strongest exact result (narrowed if necessary) as a candidate and send it to independent referees before another broad round.`,
    );
  }
  for (const artifact of undispositionedResults) {
    out.push(
      `- ${artifact.id} from ${artifact.taskId} claims ${artifact.conclusion} but has not yet been assessed for further use. Decide whether its exact result merits independent review, one focused follow-up, or no further attention.`,
    );
  }
  for (const item of unassessedSources.slice(0, 24)) {
    out.push(
      `- ${item.taskId} is the source of ${item.claimIds.length} UNVERIFIED lead${item.claimIds.length === 1 ? "" : "s"} (${item.claimIds.join(", ")}). Decide whether the precise result merits independent review, one exact follow-up, or should be set aside.`,
    );
  }
  if (unassessedSources.length > 24) {
    out.push(`- …and ${unassessedSources.length - 24} more claim-producing attempts; the internal assess_results action accepts 24 at a time.`);
  }
  out.push("");

  out.push("## Mathematical approaches and candidate results");
  out.push(
    "Candidate status labels are decisive. An author conclusion such as PROVED is only the submitted write-up's self-assessment; it never overrides independent review.",
  );
  if (Object.keys(state.lineages).length === 0) out.push("(none yet)");
  for (const l of Object.values(state.lineages)) {
    const active = state.activeLineageId === l.id ? " (ACTIVE)" : "";
    const status = l.status === "abandoned" ? "DISCONTINUED" : l.status.toUpperCase();
    out.push(
      `- ${l.id} "${l.title}" [${status}]${active}` +
        (l.abandonReason ? ` — discontinued: ${l.abandonReason}` : "") +
        (l.establishedCandidateId ? ` — independently established as ${l.establishedCandidateId}` : ""),
    );
    for (const cid of l.versionIds) {
      const c = state.candidates[cid]!;
      const lifecycle = candidateLifecycle(state, cid);
      const open = c.issueIds.filter((i) => state.issues[i]!.status === "open");
      const verdictBits = c.reviewIds.map((r) => `${r}:${state.reviews[r]!.verdict}`).join(", ") || "no reviews";
      const passes = c.reviewIds.filter((r) => state.reviews[r]!.verdict === "PASS").length;
      const fails = c.reviewIds.filter((r) => state.reviews[r]!.verdict === "FAIL").length;
      const scopeBit =
        c.scope === null
          ? "scope: the whole problem"
          : `scope: ${truncate(c.scope, 160)}${passes >= 2 && fails === 0 && open.length === 0 ? " — VERIFIED PARTIAL RESULT" : ""}`;
      out.push(
        `  - ${cid} [${lifecycle.label}] from ${c.fromArtifact} (source author conclusion: ${lifecycle.authorConclusion ?? "unknown"}); ${scopeBit}; obligations ${c.obligations.length}; reviews [${verdictBits}]; open issues ${open.length}${c.acceptance ? `; requirements ${c.acceptance.passed ? "PASSED" : `not met: ${c.acceptance.failing.join("; ")}`}` : ""}`,
      );
      out.push(`    status: ${lifecycle.detail}`);
      if (c.reviewQuestions.length > 0) {
        out.push(`    referee questions: ${c.reviewQuestions.map((q) => truncate(q, 180)).join(" | ")}`);
      }
    }
  }
  out.push("");

  out.push("## Claims");
  if (state.claimOrder.length === 0) out.push("(empty)");
  if (state.claimOrder.length > 0) {
    const claimCounts = Object.values(state.claims).reduce<Record<string, number>>((counts, claim) => {
      counts[claim.status] = (counts[claim.status] ?? 0) + 1;
      return counts;
    }, {});
    out.push(
      `Status: ${["VERIFIED", "UNVERIFIED", "REFUTED", "SUPERSEDED"]
        .map((status) => `${status} ${claimCounts[status] ?? 0}`)
        .join("; ")}. UNVERIFIED means not independently checked, not an established result; change a status only when another investigation actually checks the claim.`,
    );
  }
  for (const kid of state.claimOrder) {
    const k = state.claims[kid]!;
    out.push(`- ${k.id} [${k.status}] ${truncate(k.statement, 200)} — source: ${k.provenance}${k.dependsOn.length ? `; depends on ${k.dependsOn.join(", ")}` : ""}`);
  }
  out.push("");

  const openIssues = Object.values(state.issues).filter((i) => i.status === "open");
  out.push("## Open issues");
  if (openIssues.length === 0) out.push("(none)");
  for (const i of openIssues) {
    out.push(`- ${i.id} [${i.severity}] on ${i.candidateId} at ${i.location}: ${truncate(i.summary, 200)}`);
  }
  const resolved = Object.values(state.issues).filter((i) => i.status === "resolved" && i.disposition === "rejected");
  if (resolved.length > 0) {
    out.push("", "## Referee concerns not sustained");
    for (const i of resolved) out.push(`- ${i.id} on ${i.candidateId}: not sustained — ${i.dispositionReason}`);
  }
  out.push("");

  out.push("## Research library");
  const counts: Record<string, number> = {};
  for (const card of Object.values(state.cards)) counts[card.status] = (counts[card.status] ?? 0) + 1;
  const workingCards = Object.values(state.cards).filter(
    (card) => card.status === "PROPOSED" || card.status === "VERIFIED",
  );
  const promisingCards = workingCards.filter((card) => card.card.tags.includes("promising"));
  out.push(
    Object.keys(counts).length
      ? Object.entries(counts).map(([s, n]) => `${s}: ${n}`).join(", ")
      : "(none)",
  );
  if (workingCards.length > 0) {
    out.push(`- working library: ${workingCards.length}; promising directions: ${promisingCards.length}`);
  }
  out.push("");

  out.push("## Research write-ups");
  for (const a of Object.values(state.artifacts)) {
    out.push(`- ${a.id} (${a.kind}${a.conclusion ? `, ${a.conclusion}` : ""})${a.taskId ? ` from ${a.taskId}` : ""}`);
  }
  out.push("");

  out.push("## Research rounds");
  for (const wid of state.waveOrder) {
    const w = state.waves[wid]!;
    const tasks = w.taskIds
      .map((tid) => {
        const t = state.tasks[tid]!;
        return `${t.id} ${t.role}/${t.methodTag}:${t.status}`;
      })
      .join("; ");
    out.push(`- ${w.id} "${w.title}" [${w.status}] — ${tasks}`);
  }
  out.push("");

  if (state.terminalHistory.length > 0) {
    out.push("## Earlier reports (retained for reference)");
    for (const [index, report] of state.terminalHistory.entries()) {
      const continuation = state.continuations[index];
      out.push(
        `- report ${index + 1}: ${report.result} at ${report.finalPath}` +
          (continuation
            ? `; owner continued with ${continuation.addTokens.toLocaleString("en-US")} additional tokens and ${continuation.addWaves} additional rounds — ${truncate(continuation.note, 240)}`
            : ""),
      );
    }
    out.push("");
  }

  const pendingDirectives = state.directiveOrder
    .map((d) => state.directives[d]!)
    .filter((d) => d.status === "pending");
  out.push("## Guidance from the owner (weigh this heavily)");
  if (pendingDirectives.length === 0) out.push("(none)");
  for (const d of pendingDirectives) out.push(`- ${d.id}${d.urgent ? " [URGENT]" : ""}: ${d.text}`);
  out.push("");

  const answered = Object.values(state.questions).filter((q) => q.status === "answered");
  if (answered.length > 0) {
    out.push("## Answered questions");
    for (const q of answered) out.push(`- ${q.id}: ${truncate(q.text, 160)} → ${truncate(q.answer ?? "", 200)}`);
    out.push("");
  }

  // Cross-exam answers, most recent first, capped.
  const exams: string[] = [];
  for (const t of Object.values(state.tasks)) {
    for (const x of t.crossExams) {
      if (x.answerMarkdown) exams.push(`- ${t.id} (re ${x.refIds.join(", ") || "general"}): ${truncate(x.answerMarkdown, 400)}`);
    }
  }
  if (exams.length > 0) {
    out.push("## Focused follow-up answers");
    out.push(...exams.slice(-8));
    out.push("");
  }

  return out.join("\n");
}

/**
 * Builds the bounded file map written by runResearchManagerCall() for a
 * next-move decision. Called only when no research round is open.
 */
export function decisionPacketFiles(
  state: ProjectState,
  extras: {
    digest: string | null;
    docket: string | null;
    resolution?: string | null;
    previousReport?: string | null;
  },
): Record<string, string> {
  const files: Record<string, string> = {
    "AGENTS.md": NEXT_MOVE_CONTRACT,
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "current-record.md": ledgerSummary(state),
    "working-library.md": workingLibraryMarkdown(state),
    "research-manager-voice-examples.md": RESEARCH_MANAGER_EXAMPLES,
  };
  const currentNote = state.researchManagerNotes.at(-1);
  if (currentNote) files["research-manager-current-view.md"] = currentNote.markdown;
  if (extras.digest) files["project-summary.md"] = extras.digest;
  if (extras.docket) files["latest-round-findings.md"] = extras.docket;
  if (extras.resolution) files["previous-round-summary.md"] = extras.resolution;
  if (extras.previousReport) files["earlier-report.md"] = extras.previousReport;
  const intakeContext = intakeContextMarkdown(state);
  if (intakeContext) files["intake-context.md"] = intakeContext;

  // Active candidate verbatim (v1: no read_artifacts bounce).
  const lid = state.activeLineageId;
  const latest = lid ? state.lineages[lid]!.versionIds.at(-1) : undefined;
  if (latest) {
    const lifecycle = candidateLifecycle(state, latest);
    files["active-candidate.md"] =
      `Latest candidate version in the active research direction: ${latest}\n` +
      `Status: ${lifecycle.label}\n` +
      `Source author conclusion: ${lifecycle.authorConclusion ?? "unknown"}\n\n` +
      `${lifecycle.detail}\n\n` +
      "The full text is supplied separately in candidate.md. A failed, superseded, or unreviewed candidate is repair material, not an established theorem.";
  }
  return files;
}

/** Builds the initial W000 directory before raw source files are copied in. */
export function intakePacketFiles(statement: string, contextMarkdown: string): Record<string, string> {
  return {
    "AGENTS.md": INTAKE_CONTRACT,
    "statement.md": statement,
    "context.md": contextMarkdown.trim() || "(No separate background notes supplied.)",
  };
}

/** Stdin message for the legacy clarification-answer revision call. */
export const REVISION_PROMPT =
  "Rewrite the normalized statement to incorporate the owner's answers per AGENTS.md. " +
  "Reply with ONLY one JSON object conforming to the provided output schema.";

export function revisionPacketFiles(
  statement: string,
  normalized: string,
  qa: { question: string; why: string; suggested: string; answer: string | null }[],
): Record<string, string> {
  const lines = qa.map(
    (q) =>
      `### ${q.question}\n\n- why it matters: ${q.why}\n- your suggested reading: ${q.suggested}\n- owner's answer: ${q.answer === null || q.answer === "" ? "(no answer — use your suggested reading and say so)" : q.answer}`,
  );
  return {
    "AGENTS.md": REVISION_CONTRACT,
    "statement.md": statement,
    "normalized-previous.md": normalized,
    "answers.md": `# Clarifications\n\n${lines.join("\n\n")}\n`,
  };
}

/** Builds the file map for assessment immediately after a round closes. */
export function curationPacketFiles(
  state: ProjectState,
  waveId: string,
  docket: string,
  memosJson: string,
  priorCapsules: { solver: string; explorer: string; reviewer: string },
  digest: string | null,
): Record<string, string> {
  const files: Record<string, string> = {
    "AGENTS.md": CURATION_CONTRACT,
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "current-record.md": ledgerSummary(state),
    "working-library.md": workingLibraryMarkdown(state),
    "research-manager-voice-examples.md": RESEARCH_MANAGER_EXAMPLES,
    "round-findings.md": docket,
    "research-reports.json": memosJson,
    "solver-notes-previous.md": priorCapsules.solver,
    "explorer-notes-previous.md": priorCapsules.explorer,
    "referee-notes-previous.md": priorCapsules.reviewer,
  };
  const currentNote = state.researchManagerNotes.at(-1);
  if (currentNote) files["research-manager-previous-view.md"] = currentNote.markdown;
  const intakeContext = intakeContextMarkdown(state);
  if (intakeContext) files["intake-context.md"] = intakeContext;
  if (digest) files["project-summary-previous.md"] = digest;
  return files;
}

/** Compact human-approved background for planning and non-review research. */
export function intakeContextMarkdown(state: ProjectState): string | null {
  const digest = state.problem.contextDigestMarkdown.trim();
  const cards = Object.values(state.cards).filter((card) => card.proposedBy === "human:intake");
  if (!digest && cards.length === 0) return null;

  const out = [
    "# Background and starting leads",
    "",
    "This material was supplied or approved during intake. It is a map of possible starting points, not evidence; verify every mathematical claim before relying on it.",
  ];
  if (digest) out.push("", "## Background summary", "", digest);
  if (cards.length > 0) {
    out.push("", "## Supplied ideas and literature leads", "");
    for (const card of cards) {
      out.push(`- ${card.id} [${card.card.type}; ${card.status}] **${card.card.title}** — ${card.card.abstract}`);
    }
  }
  return out.join("\n");
}

/** Builds the final-composition file map after code has fixed the result. */
export function finalPacketFiles(
  state: ProjectState,
  resultHint: string,
  candidateText: string | null,
  digest: string | null,
): Record<string, string> {
  const files: Record<string, string> = {
    "AGENTS.md": FINAL_CONTRACT,
    "problem.md": state.problem.confirmedMarkdown ?? state.statement,
    "current-record.md": ledgerSummary(state),
    "result-context.md":
      `The result determined by the program is: ${resultHint}. Do not write a RESULT line; the program adds it.\n\n` +
      verifiedPartialsSection(state),
  };
  const currentNote = state.researchManagerNotes.at(-1);
  if (currentNote) files["research-manager-current-view.md"] = currentNote.markdown;
  if (candidateText) files["candidate.md"] = candidateText;
  if (digest) files["project-summary.md"] = digest;
  return files;
}

/**
 * Scoped candidates that two independent reviews passed with no open issues.
 * These are the project's *verified* partial results, and the final report
 * must present them differently from anything merely asserted by a worker.
 */
export function verifiedPartialsSection(state: ProjectState): string {
  const rows: string[] = [];
  for (const c of Object.values(state.candidates)) {
    if (c.scope === null) continue;
    const verdicts = c.reviewIds.map((r) => state.reviews[r]!.verdict);
    const open = c.issueIds.filter((i) => state.issues[i]!.status === "open");
    if (verdicts.filter((v) => v === "PASS").length < 2 || verdicts.includes("FAIL") || open.length > 0) continue;
    rows.push(`- **${c.id}** (reviews ${c.reviewIds.join(", ")}): ${c.scope}`);
  }
  if (rows.length === 0) {
    return (
      "## Verified partial results\n\n" +
      "None. No scoped candidate passed two independent reviews, so every partial\n" +
      "result in this project is asserted rather than verified — say so plainly.\n"
    );
  }
  return (
    "## Verified partial results\n\n" +
    "Each of these is a scoped candidate that two independent reviewers passed with\n" +
    "no open issues. Present them as established, with their candidate version and\n" +
    "review IDs, and keep them clearly separate from unreviewed claims.\n\n" +
    rows.join("\n") +
    "\n"
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
