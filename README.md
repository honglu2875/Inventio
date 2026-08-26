# Inventio

[![CI](https://github.com/honglu2875/Inventio/actions/workflows/ci.yml/badge.svg)](https://github.com/honglu2875/Inventio/actions/workflows/ci.yml)

Inventio is a local research environment for difficult mathematics. One
recurrent Research Manager develops the mathematical direction and delegates
bounded work to independent Codex solvers, explorers, reviewers, and
synthesizers. A deterministic runtime preserves the research record, enforces
isolation and budgets, and exposes the process through a live graph interface.

The premise is simple: a proof is not a consensus. Independent attempts remain
independent until completion, fixed candidate versions receive adversarial review,
and a result is called **PROVED**
only when a mechanical predicate — not a model's opinion — says every
condition holds. `UNCERTAIN` is a valid and often correct outcome.

## Documents

| file | what it is |
|---|---|
| `PROTOCOL.md` | The constitution: epistemic invariants, role contracts, acceptance rules. Read this first. |
| `DESIGN.md` | The engineering spec: architecture, event model, state machine, packets, API. |
| `packages/ui/UI-SPEC.md` | The binding UI design: views, node chrome, tokens, interactions. |
| `packages/conductor/src/prompts/README.md` | Prompt architecture: every model-facing instruction, call site, and lifecycle condition. |
| `PLAN.md` | Milestone tracker and deviation log — the recovery point if work is interrupted. |

## How it works

```text
browser ── REST + SSE ──> conductor (Node) ── codex exec --json ──> workers
                              │                (one process per task,
                              │                 jailed in a packet dir)
                              └── projects/<slug>/  (event log + artifacts)
```

- **The Conductor is code, not a prompt.** A deterministic state machine owns
  phases, wave lifecycle, ledgers, candidate versioning, budgets, and the
  acceptance predicate. Rules that used to be behavioral obligations on an
  LLM are now `if` statements.
- **One Research Manager owns the mathematics.** Its process calls are fresh,
  but after every round it rewrites a persistent current view: what has been
  learned, the real gap, its present intuition, and what is worth trying next.
  It chooses assignments, interprets reviews, reorganizes the research
  library, and may open older notes through read-only tools. The Conductor
  validates and executes its structured choices; it is not another layer of
  mathematical management.
- **Intake preserves the submission.** Your objective, long background notes,
  and uploaded documents are stored before any model runs. The Research
  Manager drafts `W000 · Current mathematical view`; before accepting it, you
  may return to the raw input, revise text or files, and regenerate W000. The
  accepted files, hashes, abstracts, and excerpts remain available in Library
  throughout the project, while the event log retains the revision history.
- **Workers are isolated by construction.** Each task runs in its own directory
  containing only what it was granted. A peer's attempt isn't hidden from a
  reviewer — it physically isn't there. Budgets are enforced by killing
  processes, not by asking nicely. A schema-valid refusal or placeholder gets
  one short correction request and then a fresh independent replacement; it never stalls
  the round or becomes a question for you.
- **Everything is an event.** `projects/<slug>/events.jsonl` is the
  operational truth; Markdown artifacts are the mathematical evidence. The UI
  runs the same reducer as the backend, so the graph can't disagree with the
  state.
- **Leads have a lifecycle.** Extracted claims begin as UNVERIFIED notes, not
  facts. Claim-producing attempts must be carried, given one exact follow-up,
  or set aside; concrete carried results are frozen and independently reviewed
  before broad exploration continues. Recorded computations preserve process
  diagnostics and must reproduce from a pristine packet-shaped snapshot.

## Quickstart

Requirements: Node 20, 22, or 24+ and a logged-in `codex` CLI (`codex login`).

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

Source mounts configured inside a project are local inputs and are copied only
into assignments that the Research Manager explicitly grants them to.

## Environment

| var | default | meaning |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `4700` | app + API bind; use a literal Tailscale address for tailnet-only access |
| `INVENTIO_API_TARGET` | `http://127.0.0.1:4700` | Vite dev/preview proxy target (UI process only) |
| `MEMORY_PORT` | `4701` | MCP memory service for workers |
| `INVENTIO_ROOT` | `./projects` | project data directory |
| `INVENTIO_CODEX_BIN` | `codex` | codex binary (point at the sim for tests) |
| `INVENTIO_POOL` | `3` | max concurrent workers across all projects |
| `INVENTIO_DISABLE_MEMORY` | — | set to `1` to skip the memory service |

## Steering a running project

The system runs to a terminal state on its own. You can always:

- **send a directive** — picked up at the next decision point; mark it urgent
  to stop new dispatch and reconvene the wave early;
- **switch to gated mode** — every proposed action waits for approve/edit/reject;
- **intervene in the ledger** — mark a claim verified or refuted, raise an
  issue against a candidate, quarantine a memory card. Every intervention is
  recorded with human provenance and shown to later agents as exactly what it
  is: a domain expert's recorded judgment.
- **change project settings** — one saved form controls the token ceiling,
  maximum research rounds, autonomy, Web-search permission, and the
  model/reasoning effort for Research Manager, Solver, Explorer, Reviewer, and
  Synthesizer. It shows the effective values stored with that project,
  including choices made at creation. W000 uses the Research Manager setting.
  A save affects future process launches; a worker already in flight continues
  with the settings it started with.
- **allow or deny Web search** — the same Settings form controls whether the
  Research Manager may grant native Web search to individual future worker
  assignments. Turning it off also removes search from queued work; an
  already-running worker is unchanged. W000 remains offline.
- **continue from a stopping report** — the earlier report remains immutable.
  Before any new assignment is chosen, Inventio combines the preceding
  Research Manager view, that report, and your complete continuation direction
  into a numbered revision such as `W020.2`. You may instead mark your text as
  the complete revised view and record it directly. The full direction remains
  available to later decisions throughout the continued run.

## Safety notes

Bind stays on loopback: the API can start processes and spend tokens, so treat
port forwarding as privileged. Workers run hermetically
(`--ignore-user-config`), sandboxed read-only (or workspace-write confined to
their own packet when a computation needs scratch space), with no approval
prompts. Network access is absent by default; a worker gets the native Web
search tool only when both the project setting and its individual assignment
permit it. Shell/network escalation remains impossible rather than deniable.

## License

Inventio is available under the [MIT License](LICENSE).
