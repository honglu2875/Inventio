# Inventio repository guidance

Inventio is a local research application for difficult mathematics. New
projects use the `recurrent-v3` workflow described in `SESSION-DESIGN.md`:
one long Solver and Explorer per round, originating-session repairs,
independent weaker checks, and strong blind memory audit. There is no model
controller. Earlier council and trajectory workflows are view-only archives;
their event meanings remain replayable without reinterpretation or writes.

When changing this repository:

1. Read `SESSION-DESIGN.md` for the default workflow. Read `PROTOCOL.md` and
   `DESIGN.md` when changing the compatible council workflow or shared
   infrastructure, and `packages/ui/UI-SPEC.md` for relevant interface
   invariants.
2. Treat `projects/` as private runtime data. Never inspect or commit a user's
   project unless the user explicitly puts that project in scope.
3. Preserve append-only event compatibility. New durable behavior normally
   requires a schema event, reducer handling, replay coverage, and an HTTP/UI
   projection where applicable.
4. Preserve the worker boundary: a worker sees only its composed working
   directory and project-scoped tools. Do not weaken path confinement,
   source-copy limits, independent checking, or structured-output validation.
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

When implementation is explicitly delegated, name file ownership and ensure
workers do not modify shared runtime project data.
