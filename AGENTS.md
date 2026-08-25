# Inventio repository guidance

Inventio is a local research application for difficult mathematics. One
recurrent Research Manager chooses the mathematical direction; independent
Solver, Explorer, Reviewer, and Synthesizer processes carry out bounded
assignments; a deterministic Conductor owns persistence, isolation, budgets,
and acceptance rules.

When changing this repository:

1. Read `PROTOCOL.md` for epistemic rules, `DESIGN.md` for architecture, and
   `packages/ui/UI-SPEC.md` for user-interface invariants relevant to the task.
2. Treat `projects/` as private runtime data. Never inspect or commit a user's
   project unless the user explicitly puts that project in scope.
3. Preserve append-only event compatibility. New durable behavior normally
   requires a schema event, reducer handling, replay coverage, and an HTTP/UI
   projection where applicable.
4. Preserve the worker boundary: a worker sees only its composed assignment
   directory and explicitly granted material. Do not weaken path confinement,
   source-copy limits, independent review, or structured-output validation.
5. Keep mathematical artifacts in ordinary academic language. Internal code
   may use precise engineering terminology, but model prompts and generated
   research notes should speak like mathematicians rather than workflow tools.
   Keep deliberate model-facing instructions under
   `packages/conductor/src/prompts/`, and update that directory's `README.md`
   whenever a model call, prompt layer, or lifecycle condition changes.
6. Use `packages/codex-sim` for development and tests. Do not spend real model
   quota unless the user explicitly requests a live research run or smoke test.
7. Preserve unrelated working-tree changes and never commit generated
   dependencies, build output, or runtime projects.

Before handing off a code change, run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

The root agent may delegate independent implementation work when useful, but
the task packet must name file ownership and workers must not modify shared
runtime project data.
