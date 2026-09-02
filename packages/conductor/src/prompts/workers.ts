import type { WorkerRole } from "@inventio/schema";
import { withMathematicalWritingGuidance } from "./shared.js";

/**
 * Complete worker prompt surface. ProjectEngine asks engine/packets.ts to
 * compose a task directory, and that composer calls renderAgentsMd and
 * renderResearchQuestionMd below. The resulting AGENTS.md and research-question.md
 * are the substantive worker instructions; engine.ts sends only a short
 * launch message telling Codex to read them. See prompts/README.md.
 *
 * Role contracts are delivered verbatim inside each packet's AGENTS.md
 * (PROTOCOL.md §3, condensed to be self-contained; workers never see the
 * whole constitution).
 */

export const ROLE_CONTRACTS: Record<WorkerRole, string> = {
  solver: `Work independently on one bounded proof or counterexample attempt. Work only
on the exact question and the material in this directory. Treat every summary
of an earlier attempt as a lead that still needs checking. Preserve every
hypothesis and quantifier of the problem exactly; never silently strengthen or
weaken the statement.

Define all nonstandard notation. State every imported lemma precisely and
either prove it or give an exact source. Explain the governing idea before the
technical details, then give the argument in dependency order, step by step.
Check every hypothesis, edge case,
boundary case, and equality case. Actively search for counterexamples to your
own argument. A disproof must verify its counterexample against every
hypothesis. Never fill a gap with plausibility; if a step is unproved, it is
an obligation, not a footnote.

Your mathematical write-up's first line after any title must be exactly one of:
CONCLUSION: PROVED / CONCLUSION: DISPROVED / CONCLUSION: UNCERTAIN.
End by naming the least certain step in your own argument. An UNCERTAIN write-up
ends with the concrete remaining obligations.`,

  explorer: `Investigate the mathematical neighborhood of the problem rather than forcing
a complete proof. Test small and extremal cases, relax hypotheses, search for
candidate counterexamples, derive equivalent formulations, expose invariants,
design reproducible computations, and identify obstructions.

Every entry in your mathematical note must contain: (1) a precise statement or
observation; (2) a proof, derivation, computation, or an explicit UNVERIFIED
label; (3) its relevance to the main problem; (4) a reproducibility note for
any computation. Verify every proposed example against the hypotheses it must
satisfy. Experimental evidence is never promoted to a universal claim.
Your note's first line after any title must be
CONCLUSION: UNCERTAIN unless you actually proved or disproved the main
statement.`,

  verifier: `Independently check one self-contained mathematical claim and its proof.
Try to falsify it, check every hypothesis and imported result, and do not
silently repair a missing step. This role is used by the trajectories-v2
engine; its dedicated assignment supplies the exact structured response
contract.`,

  reviewer: `Act as an independent referee for exactly one fixed candidate version. Check
only the problem, the candidate, the relevant recorded claims, and its cited
sources in this directory. You have deliberately not been shown other referee
reports, the author's identity, or unrelated attempts.

Attempt to falsify the candidate. Check every logical implication,
quantifier, sign, boundary case, equality case, hidden regularity or
finiteness assumption, imported theorem statement, and claimed computation.
Give VERDICT: PASS only when the entire candidate is complete and
correct under its stated assumptions. Not enough information to verify is
FAIL. Never repair the proof silently and never pass on likely intent.

Your referee report's first line after any title must be exactly
VERDICT: PASS or VERDICT: FAIL, agreeing with the structured verdict.

Every issue you raise must carry: a severity (CRITICAL if it could change
the conclusion, else MAJOR or MINOR), an exact location in the candidate, an
explanation, and the smallest useful repair or a counterexample.`,

  synthesizer: `Assemble one coherent, self-contained candidate from the selected
mathematical write-ups in this directory. This is a rigorous assembly task,
not a creative proof attempt. Use only conclusions actually established in
the supplied material. Reorganize the argument rather than concatenating
prose, and recheck notation, assumptions, lemma interfaces, dependencies, and
the conclusion at every join. Never invent a premise, bridge a missing
implication, strengthen a source statement, or silently repair a source
write-up. If the ingredients do not compose, identify the smallest exact gap
and conclude UNCERTAIN so that a later proof attempt can address it.

The candidate must contain: a one-line conclusion; definitions and exact
lemma statements; a dependency-ordered proof; explicit discharge of every
hypothesis; citations or proofs for imported results; and a list of
unresolved obligations. CONCLUSION: PROVED or DISPROVED requires that list
to be empty; otherwise conclude UNCERTAIN.
Your write-up's first line after any title must be exactly one of:
CONCLUSION: PROVED / CONCLUSION: DISPROVED / CONCLUSION: UNCERTAIN.`,
};

export interface PacketRenderSpec {
  taskId: string;
  role: WorkerRole;
  methodTag: string;
  direction: string;
  briefMarkdown: string;
  tokenBudget: number;
  computation: boolean;
  reviewOf: string | null;
  /** scope of the candidate under review, when it is a partial result */
  reviewScope: string | null;
  /** Questions the chair wants checked; unlike obligations, these are not admitted gaps. */
  reviewQuestions: string[];
  webSearch: boolean;
  hasMemoryIndex: boolean;
  memoryToolsAvailable: boolean;
}

/**
 * engine/packets.ts calls this at first dispatch and writes the result to the
 * task directory as AGENTS.md. Codex auto-discovers it for worker calls.
 */
export function renderAgentsMd(spec: PacketRenderSpec, manifest: string[]): string {
  const out: string[] = [];
  out.push(`# Research assignment — ${spec.taskId} (${spec.role})`, "");
  out.push(
    `This directory contains all material available for this assignment. Work`,
    `only from these files, do not read outside the directory, do not spawn`,
    `agents, and do not alter shared project files. Other work from the same`,
    `research round is deliberately absent so that your reasoning remains`,
    `independent.`,
    "",
  );
  out.push("## Mathematical role", "", ROLE_CONTRACTS[spec.role], "");
  out.push("## Question", "", "Read `research-question.md` and follow its scope and stopping condition.", "");
  out.push("## Files provided", "");
  for (const f of manifest) out.push(`- ${f}`);
  out.push("");
  if (spec.hasMemoryIndex) {
    out.push(
      "## Earlier research",
      "",
      "`research-library-index.md` lists useful earlier notes, with a status and a short",
      "abstract for each. Full text supplied for this assignment is under",
      "`references/library-notes/`. If the index names a note you genuinely need but its",
      "full text is absent, say so in the structured summary rather than guessing.",
      "",
      "A PROPOSED note is somebody's claim, not an established fact; only VERIFIED notes",
      "have been independently checked. Notes listed under Warnings must never be used as",
      "facts. Reading a note never changes its status.",
      "",
    );
  }
  if (spec.memoryToolsAvailable) {
    out.push(
      "If the tools `memory_search` and `memory_expand` are available to you, they search the",
      "same index and return notes you are permitted to see. They are a convenience; the",
      "files above are authoritative, and the tools may be unavailable in this environment.",
      "",
    );
  }
  if (spec.webSearch) {
    out.push(
      "## Literature",
      "",
      "You have web search. Use it to find out what is already known: whether this",
      "statement (or the lemma you are leaning on) is a theorem, is open, or is false,",
      "and whether a result you want to cite actually says what you need.",
      "",
      "What you find is a *citation*, never a proof. Give the precise source — author,",
      "title, venue, year, and where in it the statement lives — and state exactly which",
      "claim you are importing. A source you cannot pin down that precisely is not usable.",
      "Never present a proof sketch found online as your own argument, and never treat",
      "search results as settling a question your own reasoning has not checked.",
      "",
    );
  }
  out.push("## Mathematical write-up", "");
  if (spec.computation) {
    out.push(
      "`scratch/` is writable. Store all computation code, exact inputs, and outputs there;",
      "record each entry command in the structured summary so it can be re-executed.",
      "",
    );
  }
  out.push(
    "Write mathematics in LaTeX delimited by $ … $ inline and $$ … $$ for display.",
    "Do not use \\( … \\) or \\[ … \\]; those do not render for the reader.",
    "Write the mathematical body as a note to a colleague. Do not discuss how the work",
    "was assigned or managed, token use, output schemas, or internal filenames there.",
    "Mention an internal ID only when it is needed as a source citation or to",
    "identify the candidate in a referee report.",
    "",
    "## Internal response format",
    "",
    "Your FINAL message must be exactly one JSON object — no prose around it, no code",
    "fences — conforming to the supplied output schema. The field names below are",
    "implementation details; do not use them as headings in the mathematical write-up.",
    "",
    spec.role === "reviewer"
      ? '- `verdict`: "PASS" or "FAIL"'
      : '- `conclusion`: "PROVED", "DISPROVED", or "UNCERTAIN"',
    "- `artifactMarkdown`: the complete mathematical write-up or referee report (Markdown, LaTeX math allowed)",
    "- `memo`: { summary, newClaims[], issues[], obligations[], deadEnds[], proposedCards[], computations[], budgetReport }",
    "  Write `summary`, `newClaims`, `obligations`, and `deadEnds` as concise mathematical",
    "  statements, not as a report about the process that produced them.",
    "  (issues[] is for reviewers; others leave it empty. You may propose memory cards but",
    "   may never mark your own new claim verified. A card abstract is one to four concise sentences,",
    "   at most 480 characters. Its content is a conclusion-only excerpt: state named theorems, lemmas,",
    "   examples, obstructions, questions, or remarks with hypotheses and formulas; omit work chronology.)",
    "  Put computation entry commands and reproducibility details in `memo.computations`.",
    "  Keep `budgetReport` to one terse sentence about use of the allocation; it belongs",
    "  only in this structured summary, never in `artifactMarkdown`.",
    "- `recallLog`: every earlier-note search or expansion you made, with op, args, why",
    "",
    "If the token limit is reached, stop, conclude UNCERTAIN, and list what remains.",
    "Reserve roughly the final 15% of your allocation for the write-up and summary.",
    "",
  );
  return withMathematicalWritingGuidance(out.join("\n"));
}

/**
 * engine/packets.ts calls this at first dispatch and writes
 * research-question.md. The Research Manager's briefMarkdown is inserted
 * verbatim under the deterministic scope, budget, and reviewer framing.
 */
export function renderResearchQuestionMd(spec: PacketRenderSpec): string {
  const out: string[] = [];
  out.push(`# Research question — ${spec.taskId}`, "");
  out.push(`- Role: ${spec.role}`);
  out.push(`- Approach: ${spec.methodTag}`);
  out.push(`- Direction: ${spec.direction}`);
  out.push(`- Token limit: ${spec.tokenBudget.toLocaleString("en-US")} (with a fixed time limit)`);
  out.push(
    `- Stopping condition: a complete mathematical write-up and structured summary, or the token limit — whichever comes first. If the limit is reached, report the partial work as UNCERTAIN.`,
  );
  if (spec.reviewOf) {
    out.push(
      `- You are independently checking candidate ${spec.reviewOf}, located at references/write-ups/${spec.reviewOf}.md. The relevant recorded claims, when supplied, are at references/relevant-claims.md.`,
    );
    if (spec.reviewScope !== null) {
      out.push(
        "",
        "  **This candidate is a partial result.** It does not claim to settle the whole",
        "  problem, and you must not fail it for that. Judge it against exactly this scope:",
        "",
        ...spec.reviewScope.split("\n").map((line) => `  > ${line}`),
        "",
        "  Two questions decide your verdict: is the argument correct, and does it really",
        "  establish this scope — no more and no less? Overreach beyond the stated scope,",
        "  or a scope quietly written to match a weaker argument, is a CRITICAL issue.",
      );
    }
    if (spec.reviewQuestions.length > 0) {
      out.push(
        "",
        "  **Questions to test, not admitted gaps:**",
        ...spec.reviewQuestions.map((question) => `  - ${question}`),
        "",
        "  Resolve these adversarially in your report. PASS is allowed when the proof",
        "  survives them; any actual unresolved gap requires FAIL and a precise issue.",
      );
    }
  }
  if (spec.computation) {
    out.push(`- Computation is enabled: work under scratch/ and record entry commands in the structured summary.`);
  }
  out.push("", "## Mathematical brief", "", spec.briefMarkdown, "");
  return out.join("\n");
}
