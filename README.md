# Inventio

[![CI](https://github.com/honglu2875/Inventio/actions/workflows/ci.yml/badge.svg)](https://github.com/honglu2875/Inventio/actions/workflows/ci.yml)

Inventio is a local research environment for difficult mathematics. It gives
strong Codex Solvers and Explorers long, independent sessions on one problem,
checks every proposed result independently, and preserves the evolving
mathematics through a live graph interface.

Each round has one long Solver session and one long Explorer session. Fresh
rounds retain refined mathematics and a compact brief; the complete note
library stays available through project-scoped search and open tools.

A support-model verifier checks each exact proof version. Concrete objections
return to its originating author conversation for revision, withdrawal or a
mathematical defense. From round two, a strong independent auditor checks all
established mathematics in parallel, without prior verdicts or author traces.
A decisive first-round result receives the same strong audit before stopping.

## Documents

| file | purpose |
|---|---|
| [SESSION-DESIGN.md](SESSION-DESIGN.md) | The implemented recurrent workflow and its validity/cost choices. |
| [TRAJECTORY-DESIGN.md](TRAJECTORY-DESIGN.md) | Historical trajectories-v2 semantics for archived runs. |
| [PROTOCOL.md](PROTOCOL.md), [DESIGN.md](DESIGN.md) | Historical council semantics and shared infrastructure. |
| [UI-SPEC.md](packages/ui/UI-SPEC.md) | Interface invariants. |
| [Prompt architecture](packages/conductor/src/prompts/README.md) | Model calls, context boundaries, and lifecycle conditions. |
| [Validity roadmap](docs/VALIDITY-ROADMAP.md) | Expert evaluation and remaining experiments. |

## How it works

- **Two model choices:** research for Solver, Explorer, audit and final writing;
  support for intake, routine verification and round editing. Conversations
  retain their chosen model. Researchers choose their mathematical methods.
- **One versioned record:** propositions, calculations, conjectures and notes
  keep distinct content kinds. Checking status and relation to the original
  goal are separate. Immutable dependencies refer to exact proof versions;
  quarantining a premise immediately disqualifies dependent arguments.
- **Bounded disagreement:** one routine check per proof version; at most two
  author responses per result per round. Repairs resume the originating
  conversation and serialize with the current researcher of that role.
  A defense needs independent assessment; confidence never counts as a vote.
- **Independent audit:** each later round audits the full established record,
  including unchanged facts. New versions enter the audit tail. Operational
  inability leaves coverage incomplete. Opposing unresolved conclusions block
  decisive stopping.
- **Readable outputs:** a support editor writes the round summary and compact
  brief after the record is sealed. The runtime inserts exact mathematics and
  qualifications. One strong final writer explains a previously fixed outcome,
  with a deterministic fallback if composition fails.
- **Graph and library:** select a result to follow its premises, author session,
  checks, objections, revisions and audits. Summaries and the final report link
  to the same versions. Every saved note remains accessible on demand.
- **Local persistence:** the append-only event log, original sources, Markdown
  notes and parent-owned execution archives remain on disk. Cache-read tokens,
  uncached input, output and estimates are recorded separately; the token
  allowance is a scheduling proxy, not a price estimate.

Only `recurrent-v3` executes. Earlier council and trajectory runs are view-only
archives with their original event meanings. Their files are never migrated or
repaired on opening. Cloning intake creates a fresh recurrent project.

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

Only one Inventio server may write an active project at a time. Each active project
has a process-owned event-log lock; a second server exits instead of risking
two writers assigning the same event number. Locks from a crashed process are
reclaimed automatically on the next start.

Legacy projects are read without acquiring writer leases or changing files.
They may also contain historical configured source mounts. New projects retain
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
  next round; guidance does not interrupt the current mathematical conversation;
- **pause and resume** — pausing prevents new work and does not silently resume
  on restart;
- **change project settings** — choose research/support models and effort,
  the total allowance, long-session target and maximum rounds. New model
  choices apply to new rounds; existing conversations keep their pinned model.
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
  partial results, calculations, precise gap, and next steps. This exposition may downgrade an unsupported conclusion, but cannot elevate
  or reverse the fixed research outcome. Inventio first saves the complete TeX and
  opens a persistent overview. **Generate PDF** is a separate action using
  Tectonic's untrusted mode. If compilation fails, the error is shown beside
  the still-downloadable TeX, and **Retry PDF** reuses it without another model
  call.
- **export an interactive HTML snapshot** — **Export HTML** downloads the
  Research, Summary, Research map, Library, and node inspectors as one
  read-only file. It opens offline, keeps graph and TeX interactions, and does
  not modify the project. Binary uploads are listed but not embedded; supported
  text sources and brief files are included up to 1,000,000 bytes per file.

## Safety notes

Bind stays on loopback: the API can start processes and spend tokens, so treat
port forwarding as privileged. Research processes ignore user-level Codex
configuration and can write only within their own working directory. New
projects enable native Web search by default because literature access is part
of the long-trajectory design; disable it per project when the submission must
remain offline. Shell escalation remains unavailable.

## License

Inventio is available under the [MIT License](LICENSE).
