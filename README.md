# Inventio

[![CI](https://github.com/honglu2875/Inventio/actions/workflows/ci.yml/badge.svg)](https://github.com/honglu2875/Inventio/actions/workflows/ci.yml)

Inventio is a local research environment for difficult mathematics. It gives
strong Codex Solvers and Explorers long, independent sessions on one problem,
checks every proposed result independently, and preserves the evolving
mathematics through a live graph interface.

The premise is simple: sustained research trajectories should have room to
think, while a claimed proof should still survive independent scrutiny. A
deterministic runtime handles scheduling, isolation, persistence, budgets, and
state transitions; it does not tell the researchers which mathematics to try.
New projects use this long-trajectory workflow. Projects made under the earlier
Research Manager/council workflow remain fully replayable.

## Documents

| file | what it is |
|---|---|
| `TRAJECTORY-DESIGN.md` | The current default workflow: long trajectories, claims, facts, and independent checks. Read this first. |
| `PROTOCOL.md` | The preserved rules for legacy `council-v1` projects. |
| `DESIGN.md` | The compatible legacy architecture and shared event/runtime design. |
| `packages/ui/UI-SPEC.md` | The binding UI design: views, node chrome, tokens, interactions. |
| `packages/conductor/src/prompts/README.md` | Prompt architecture: every model-facing instruction, call site, and lifecycle condition. |
| `PLAN.md` | Milestone tracker and deviation log — the recovery point if work is interrupted. |

## How it works

```text
browser ── REST + SSE ──> deterministic runtime ──> long Solver/Explorer sessions
                              │                         │
                              │                         └── independent Verifiers
                              └── projects/<slug>/ (events + Markdown + transcripts)
```

- **Research trajectories are the main thinkers.** Every round starts the
  configured number of independent Solvers and Explorers (by default two of
  each). Solvers attack the exact problem; Explorers may pursue special cases,
  examples, computations, obstructions, neighboring theorems, or connections.
  Their default session limit is two hours, and Web search is available when
  the project permits it.
- **There is no model middle-manager in the default workflow.** Each trajectory
  starts from the same current mathematical view, active facts and claims,
  retained source catalog, and current human guidance. It chooses and revises
  its own strategy. Deterministic code starts the configured trajectories and
  never invents a mathematical direction.
- **Intake preserves the submission.** Your objective, long background notes,
  and uploaded documents are stored before any model runs. A strong initial
  reader drafts `W000 · Current mathematical view`; before accepting it, you
  may return to the raw input, revise text or files, and regenerate W000. The
  accepted files, hashes, abstracts, and excerpts remain available in Library
  throughout the project, while the event log retains the revision history.
- **Claims become facts only after independent checks.** A trajectory returns a
  complete write-up and a small list of worthwhile new mathematical statements,
  each with a self-contained alleged proof. Damaged or non-standalone claim text
  gets one repair turn in its originating trajectory. Identical statements are
  linked before review, and one proof at a time receives up to `V` independent
  checks; at least `W` passes are required to record it as a fact. A missing
  dependency or malformed presentation is kept as `NEEDS_REVISION`, distinct
  from a mathematical proof failure. Failed and duplicate claims remain
  inspectable.
  A later trajectory may raise one concrete correction to an accepted fact,
  which goes through the same process.
- **Long work stays inspectable.** Trajectories can mark sparse mathematical
  milestones, use a private writable calculation directory, search or open the
  project library and original sources, and leave both a readable final
  write-up and their complete Codex event archive.
- **Research prose uses controlled English.** Every model-authored abstract,
  claim, proof, note, report, and manuscript follows Inventio's mathematical
  application of ASD-STE100 Simplified Technical English. Exact mathematical
  terms, hypotheses, quantifiers, and proof dependencies always take priority.
- **The current view changes slowly.** After a round's checks settle, a strong
  summary reader may make a small edit to W000 only when the new results
  materially change the mathematical picture. It cannot choose work or brief
  the next round.
- **Everything is an event.** `projects/<slug>/events.jsonl` is the
  operational truth; Markdown artifacts are the mathematical evidence. The UI
  runs the same reducer as the backend, so the graph can't disagree with the
  state.

## Quickstart

Requirements: Node 20, 22, or 24+ and a logged-in `codex` CLI (`codex login`).
[Tectonic](https://tectonic-typesetting.github.io/book/latest/installation/) is
also required when you use **Prepare paper** to build a standalone PDF; ordinary
research runs do not require a TeX installation.

```bash
git clone git@github.com:honglu2875/Inventio.git
cd Inventio
npm ci
npm run build
npm run dev                       # app at http://127.0.0.1:4700
```

Open <http://127.0.0.1:4700>, create a problem, optionally add long notes and
files, revise or regenerate the W000 preview as needed, and begin research. For UI development with hot reload, run
`npm run dev:ui` in a second terminal (Vite proxies `/api` to 4700).

### Custom port and Tailscale

The built app and API share one port, so a custom local port is simply:

```bash
HOST=127.0.0.1 PORT=4800 npm run dev
```

For hot-reload UI development against that port:

```bash
# terminal 1
HOST=127.0.0.1 PORT=4800 npm run dev

# terminal 2
INVENTIO_API_TARGET=http://127.0.0.1:4800 npm run dev:ui
```

To expose only on your Tailscale interface, find this machine's Tailscale IPv4
address with `tailscale ip -4`, then bind the conductor to that literal address:

```bash
HOST=100.x.y.z PORT=4800 npm run dev
```

Open `http://100.x.y.z:4800` from another device on the tailnet. Binding
`HOST=0.0.0.0` also works, but exposes the control plane on every network
interface. There is no app-level authentication yet: anyone allowed to reach
this port can steer projects and spend model quota, so restrict it with your
Tailscale ACLs and do not expose it to the public internet.

### Developing without burning quota

Every test and most development runs against `packages/codex-sim`, a fake
`codex` CLI that replays scripted JSONL scenarios:

```bash
INVENTIO_CODEX_BIN=$PWD/packages/codex-sim/bin/codex-sim.mjs \
INVENTIO_SIM_SCENARIO=/path/to/scenario.json npm run dev
```

The UI also has a backend-free replay mode: `/p/test-problem?fixture=happy`.

```bash
npm test                 # all packages
npm run typecheck
npm run build
npm run smoke            # optional live-account test; spends model quota
```

### Project data

Runtime projects live under `projects/` and are deliberately ignored by Git:
they may contain private problem statements, uploaded papers, model transcripts,
and generated research. To keep projects elsewhere or reuse an existing
project directory, point Inventio at it explicitly:

```bash
INVENTIO_ROOT=/absolute/path/to/projects npm run dev
```

Only one Inventio server may use a given project root at a time. Each project
has a process-owned event-log lock; a second server exits instead of risking
two writers assigning the same event number. Locks from a crashed process are
reclaimed automatically on the next start.

Legacy projects may also contain configured source mounts. New projects retain
their original objective, notes, and uploads directly in the project and expose
them to trajectories through project-scoped read tools.

## Environment

| var | default | meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `4700` | app + API bind; use a literal Tailscale address for tailnet-only access |
| `INVENTIO_API_TARGET` | `http://127.0.0.1:4700` | Vite dev/preview proxy target (UI process only) |
| `MEMORY_PORT` | `4701` | MCP memory service for workers |
| `INVENTIO_ROOT` | `./projects` | project data directory |
| `INVENTIO_CODEX_BIN` | `codex` | codex binary (point at the sim for tests) |
| `INVENTIO_TEX_BIN` | `tectonic` | local Tectonic executable used to compile standalone papers |
| `INVENTIO_POOL` | `8` | max concurrent model processes across all projects |
| `INVENTIO_DISABLE_MEMORY` | — | set to `1` to skip the memory service |

## Steering a running project

The system runs to a terminal state on its own. You can always:

- **send a direction** — supplied verbatim to every Solver and Explorer in the
  next round; an urgent direction stops the current round first;
- **pause and resume** — pausing prevents new work and does not silently resume
  on restart;
- **change project settings** — one saved form controls the token ceiling,
  maximum research rounds, autonomy, Web-search permission, and the
  number and model/reasoning effort of Solvers, Explorers, Verifiers, and the
  summary reader. It also controls `V`, the independent checks requested for
  each claim, and `W`, the passes required. It shows the effective values stored
  with that project, including choices made at creation. A save affects future
  process launches; a process already in flight continues unchanged.
- **allow or deny Web search** — the same Settings form controls whether the
  initial reader and future trajectories and Verifiers receive native Web
  search. Turning it off affects future process launches; a process already
  running is unchanged.
- **continue from a stopping report** — the earlier report remains immutable.
  Your complete continuation direction is supplied to every trajectory in the
  first added round, together with the current mathematical view and library.
- **prepare a standalone paper** — after a stopping report, ask the Research
  final mathematical reader to reassess the complete record and draft TeX for the
  mathematical community. A complete proof or counterexample becomes a
  preprint; anything uncertain becomes a research report containing the sound
  partial results, calculations, precise gap, and next steps. This final reading
  may change the earlier assessment. Inventio first saves the complete TeX and
  opens a persistent overview. **Generate PDF** is a separate action using
  Tectonic's untrusted mode. If compilation fails, the error is shown beside
  the still-downloadable TeX, and **Retry PDF** reuses it without another model
  call.

## Safety notes

Bind stays on loopback: the API can start processes and spend tokens, so treat
port forwarding as privileged. Research processes ignore user-level Codex
configuration and can write only within their own working directory. New
projects enable native Web search by default because literature access is part
of the long-trajectory design; disable it per project when the submission must
remain offline. Shell escalation remains unavailable.

## License

Inventio is available under the [MIT License](LICENSE).
