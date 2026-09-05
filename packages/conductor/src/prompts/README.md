# Inventio prompt architecture

All deliberate model-facing instructions live here. Calls combine a short
stdin prompt, composed files, structured output schema and project-scoped MCP.
Repository/user agent configuration and other workers' directories are excluded.
Only `recurrent-v3` executes; older projects retain their original saved packets
through the view-only archive.

| Module | Calls and authority |
| --- | --- |
| `intake.ts` | Initial reading and owner-requested W000 regeneration; preserves originals and asks genuine clarifications. |
| `recurrent.ts` | Solver/Explorer, originating-session repair, independent verification/audit, round editing, final writing, interrupted-turn continuation. |
| `publication.ts` | Owner-requested standalone TeX exposition, followed by separately requested local compilation. |
| `shared.ts` | Academic prose and TeX guidance appended to every AGENTS.md. |
| `operational.ts` | Bounded process recovery and structured-output repair messages. |
| `tools.ts` | Authorized mathematical-library, checkpoint, audit and original-source tools. Historical tool definitions serve archive-related tests only. |
| `diagnostics.ts` | Explicit manual diagnostics; never automatic research calls. |

## Lifecycle and context

`ProjectEngine` handles intake, owner controls and publication; `RecurrentResearch`
handles recurrence. There is no model planner or statement-comparison controller.

- **Intake:** `generateIntake` uses `intakeFiles` and `INTAKE_PROMPT`, with the
  support model, complete original materials and source tools. Owner confirmation
  fixes the problem. An intake clone requires no model call.
- **Research:** one research-model Solver and Explorer per round use
  `authorFiles` / `RESEARCH_PROMPT`. New rounds start fresh from the original
  problem, compact mathematical brief, library index and owner guidance.
  They save mathematical notes under `notes/`; `research_checkpoint` shares
  immutable snapshots and self-contained versions at natural pauses. Closing
  write-ups and all saved notes are retained, without importing raw traces
  into future researchers' packets. Researchers choose methods and pacing.
- **Verification:** each proof version gets one fresh support-model conversation,
  `independentFiles` / `CHECK_PROMPT`, with exact mathematical premises and
  original sources. Status, author identity, old notes and prior verdicts are
  absent from both packet and server-enforced tool view. Missing/failed command
  evidence becomes operational inability, never a mathematical disproof.
- **Author response:** a substantive objection appends `objections.md` to the
  originating session and uses `REPAIR_PROMPT` with the same author envelope,
  model and provider thread. The original packet remains stable. REVISE creates
  an unchecked immutable version; WITHDRAW retracts it; DEFEND supplies additional
  mathematics for independent audit; UNRESOLVED preserves the dispute. At most
  two responses per result per round are admitted. Older repairs serialize with
  the current researcher of that role. A missing conversation is not silently
  replaced by a different author context.
- **Strong audit:** from round two, a fresh research-model auditor runs alongside
  research. `AUDIT_PROMPT` starts full-memory inspection; `AUDIT_TAIL_PROMPT`
  continues in that same audit conversation for newly submitted versions or
  mathematical defenses. Only mathematics, exact premises and original sources
  are available; prior editorial opinions/verdicts cannot be fetched through
  old tools. `audit_assess` allows immediate quarantine/downgrade/retraction,
  with exact version/hash validation. Computational confirmations wait for the
  complete parent-owned execution archive. The audit cannot author and certify
  its own correction. Every required target needs a substantive assessment;
  UNABLE leaves coverage incomplete. Round-one decisive stopping also requires
  this strong audit.
- **Round writing:** after author responses/checks/audit settle, the record is
  sealed. `editorialFiles` / `EDITOR_PROMPT` use the support model for readable
  summary and compact next-round brief. Current-round notes and complete result
  records are files; older notes remain accessible on demand. Exact mathematics
  and current qualifications are inserted by code, not inferred from prose.
  Missing/invalid exposition uses a deterministic fallback.
- **Final writing:** code first fixes the outcome, eligible versions and audit
  coverage. `FINAL_PROMPT` uses the research model once for coherent exposition.
  Unknown references cause fallback; writing cannot change the fixed outcome.
  Opposing unresolved conclusions and incomplete audit prevent decisive stopping.
- **Publication:** explicit owner requests use `publicationPacketFiles` /
  `PUBLICATION_PROMPT` with the research model and full versioned record.
  Exposition may downgrade but cannot elevate or reverse the fixed outcome.
  TeX validation and local compilation retain their existing boundaries.

## Recovery, tools and cost

Every recurrent turn saves a pinned model, session/thread identity, exact targets,
parent-owned execution archive and atomic return before completion events.
Recovery reuses validated saved output without another call or double charge;
interrupted author turns resume their saved conversation. Every structured
attempt is charged, with estimates when usage is absent. Reported uncached
input, cache reads and output remain separate. Infrastructure retries remain
bounded by `runStructured`; this is not a claim of measured monetary savings.
Research admission leaves audit/writing capacity; failed or incomplete audits
remain explicit rather than being silently sampled away.

`research_search` / `research_open` expose all saved mathematics to researchers,
and only authorized exact versions/premises to verifiers and auditors.
`research_checkpoint` is available only to research authors; `audit_assess`
only to the active auditor. `source_list` / `source_open` expose original
sources; the blind view also excludes model-written source abstracts.
The server rejects old memory/knowledge/write-up tools for recurrent sessions.
Workers never write shared state or run their scripts in the conductor process.

Simulator tests establish orchestration, replay and isolation behavior.
Expert-labelled mathematical reliability and whole-run cost evaluation still
require separately authorized live runs. See [the prompt audit](../../../../docs/PROMPT-AUDIT.md)
and [the validity roadmap](../../../../docs/VALIDITY-ROADMAP.md).
