# Inventio UI — binding design specification

This document is the authoritative design for `@inventio/ui`. It refines
DESIGN.md §11 to implementation precision. Executors implement it as written;
deviations require a note in PLAN.md's deviation log and should be rare and
forced (e.g. a library limitation). The layout engines in `src/lib/layout.ts`
and `src/lib/evidenceLayout.ts` are already written and tested — use them
unchanged; do not introduce any force-directed or third-party layout.

## 0. Principles

1. **The graph is a projection, never a guess.** Everything rendered derives
   from `ProjectState` via `@inventio/schema` (`deriveOpsGraph`,
   `deriveEvidenceGraph`) and the layout engines. No component invents state.
2. **Position stability.** Node positions are a pure function of state +
   collapse set. Live updates must never cause unrelated nodes to move.
3. **Progress is legible at a glance.** The page answers "how far along, how
   healthy, what needs me" without opening anything: phase tracker, budget
   bar, issue burn-down, pulsing question nodes.
4. **Transcripts are archived, artifacts are the interface.** Full worker
   streams appear only in the inspector's Stream tab, lazily.
5. **Snappy**: no spinner longer than a skeleton; SSE applies in batches via
   one `requestAnimationFrame` flush; markdown/KaTeX render lazily per tab.

## 1. Stack and files

- Vite + React 18 + TypeScript strict, `react-router-dom` v7,
  `@xyflow/react` v12 (pan/zoom/selection ONLY — positions come from our
  layout), `zustand` v5 + `immer`, `react-markdown` v9 + `remark-math` +
  `rehype-katex` + `katex` (no `rehype-raw`: raw HTML stays disabled).
- Dev proxy: `/api` → `http://127.0.0.1:4700` (vite.config.ts).
- Build: `vite build` → `dist/` (served statically by the conductor).
- Every Markdown and short-label surface passes through `normalizeTex`. Besides
  delimiter and legacy-control repair, it changes a `\left` / `\right` pair
  to fixed-size `\Bigl` / `\Bigr` only when the pair provably crosses a row or
  cell boundary inside the same alignment environment. Delimiters surrounding
  an entire nested multiline environment are valid and remain unchanged.

```text
src/
├── main.tsx, App.tsx                  # router + theme bootstrap
├── store/
│   ├── store.ts                       # zustand store (shape in §3)
│   ├── connect.ts                     # snapshot fetch + SSE (EventSource)
│   └── fixtures.ts                    # ?fixture= replay dev mode
├── lib/
│   ├── layout.ts                      # ops layout (PROVIDED — do not edit)
│   ├── evidenceLayout.ts              # evidence layout (PROVIDED — do not edit)
│   ├── format.ts                      # tokens→"1.2M", durations, truncation
│   ├── modelSettings.ts               # editable roles, defaults, display metadata
│   └── api.ts                         # typed fetch helpers for POST routes
├── views/
│   ├── ProjectsPage.tsx               # L0
│   ├── ProjectLayout.tsx              # chrome: topbar, tabs, dock, toasts
│   ├── OpsView.tsx                    # L1 graph
│   ├── ManagerView.tsx                # current Research Manager view + history
│   ├── EvidenceView.tsx               # claim DAG
│   ├── LibraryView.tsx                # library tree + content
│   ├── SettingsView.tsx               # per-role model and reasoning effort
│   └── IntakeConfirm.tsx              # AWAITING_CONFIRMATION screen
├── components/
│   ├── nodes/                         # one file per node type (§5)
│   ├── inspector/                     # Inspector.tsx + one file per tab (§7)
│   ├── steering/                      # DirectiveDock, GateCard, QuestionsToast, fresh/continue dialogs
│   ├── TopStrip.tsx                   # phase, budget, burn-down (§6)
│   └── Markdown.tsx                   # the single markdown renderer
└── styles/
    ├── tokens.css                     # §2 design tokens (both themes)
    └── app.css
```

## 2. Visual language (tokens.css)

Dark is the default theme; light is supported. Theme = `data-theme` on
`<html>`: explicit `"dark"`/`"light"` chosen in the topbar (persisted in
localStorage `inventio.theme`), default follows `prefers-color-scheme`.

CSS custom properties (exact values):

| token | dark | light |
|---|---|---|
| `--bg` | `#0e1116` | `#f8f9fb` |
| `--panel` | `#161b22` | `#ffffff` |
| `--panel-2` | `#1c232d` | `#eff2f6` |
| `--border` | `#2a323e` | `#d5dbe3` |
| `--text` | `#e6edf3` | `#1f2430` |
| `--muted` | `#8b98a8` | `#5b6675` |
| `--accent` | `#4f8ef7` | `#2f6bdb` |
| `--running` | `#58a6ff` | `#2f6bdb` |
| `--ok` | `#3fb950` | `#1a7f37` |
| `--warn` | `#d29922` | `#9a6700` |
| `--danger` | `#f85149` | `#cf222e` |
| `--queued` | `#6e7681` | `#8b98a8` |
| `--seal` | `#a371f7` | `#8250df` |

Role glyphs and colors (used in node chrome, roster chips, legends):
Solver `◆ #a371f7`, Explorer `✦ #58d0d0`, Reviewer `▣ #d29922`,
Synthesizer `⬢ #4f8ef7`, Research Manager `● var(--muted)`. In light theme darken
each by using the same hue at ~70% lightness of the dark value — pick fixed
values and put them in tokens.css as `--role-solver` etc.

Status ring colors: queued `--queued`, running `--running` (with a 2s CSS
pulse animation on the ring), completed `--ok`, interrupted `--warn`,
failed `--danger`. Claim status: VERIFIED `--ok`, UNVERIFIED `--warn`,
REFUTED `--danger`, SUPERSEDED `--muted`. Issue severity: CRITICAL
`--danger`, MAJOR `--warn`, MINOR `--muted`. Review PASS `--ok` / FAIL
`--danger`.

Typography: `font-family: ui-sans-serif, system-ui, sans-serif` for UI;
`ui-monospace, SFMono-Regular, Menlo, monospace` for streams/IDs; KaTeX
defaults for math. Base size 14px; node labels 12px; IDs always monospace.
All text at zoom ≥ 0.5 must remain ≥ 10px effective; below zoom 0.5 node
bodies switch to compact mode (§5).

Accessibility: every status conveyed by color also carries a glyph or text
label (PASS/FAIL text, severity letters C/M/m, role glyphs). Contrast ≥ 4.5:1
for text on panels in both themes.

## 3. Store and data flow

```ts
interface ProjectSlot {
  state: ProjectState | null;         // reducer-folded
  connection: "connecting" | "live" | "reconnecting" | "fixture";
  lastError: string | null;
}
interface UiStore {
  projects: Record<string, ProjectSlot>;
  runtime: { codexOk: boolean; poolActive: number; poolQueued: number } | null;
  collapse: Record<string, string[]>;   // slug → collapsed wave ids (persisted)
  selection: { slug: string; nodeId: string } | null;
  theme: "dark" | "light" | "system";
  // actions...
}
```

- `connect.ts`: on project open, `GET /api/projects/:slug` → put `state`;
  then `new EventSource('/api/projects/:slug/events?since=' + state.seq)`.
  Incoming events are queued and flushed once per animation frame:
  `produce(state, draft => { for (e of batch) applyEvent(draft, e) })`.
  Events with `seq <= state.seq` are dropped (replay overlap). On SSE
  `error`, mark `reconnecting` (EventSource auto-reconnects with
  Last-Event-ID; the server also honors `?since=`).
- Collapse persistence: localStorage `inventio.collapse.<slug>`; default
  collapsed = all waves except the last two and any wave containing a
  running task (recomputed only when a wave is added — user choices win
  afterwards).
- Fixture mode: route query `?fixture=<name>` loads
  `src/fixtures/<name>.json` (an array of events) and replays it at 40
  events/second into the reducer, no backend needed. Ship at least
  `happy.json` (generate by copying a sim-run `events.jsonl` from the
  engine e2e tests, converted to a JSON array). The store slot is marked
  `connection: "fixture"` and all POST actions are disabled with tooltips.

## 4. Routes

| route | view |
|---|---|
| `/` | ProjectsPage (L0) |
| `/p/:slug` | ProjectLayout → OpsView |
| `/p/:slug/manager` | ManagerView (latest mathematical view open; earlier views collapsed) |
| `/p/:slug/evidence` | EvidenceView (`?version=C001.v2` selects a version) |
| `/p/:slug/library` and `/p/:slug/library/:section/:id?` | LibraryView |
| `/p/:slug/settings` | SettingsView (model and reasoning effort for each active role) |
| `/p/:slug/node/:nodeId` | resolver: waves/tasks/candidates/reviews/questions → OpsView with inspector open + node centered; claims/issues/obligations → EvidenceView with inspector open; cards/artifacts → LibraryView |

The inspector's open target is part of the URL (`/node/:nodeId` or a
`?sel=` param on the view routes — use `?sel=` so view + selection compose).
Back/forward must work.

## 5. Ops view (L1)

`OpsView` renders React Flow with `nodesDraggable={false}`,
`nodesConnectable={false}`, `zoomOnDoubleClick={false}`, fitView on first
load, `minZoom 0.15`, `maxZoom 1.6`. Positions and sizes come from
`layoutOps(graph, collapsedSet)` (src/lib/layout.ts). Expanded waves are
React Flow **group** nodes (children carry `parentId` + relative positions,
`extent: "parent"`). Collapse/expand toggles by clicking the wave header
chevron (or double-clicking the wave header); animate with CSS transition
on transform (React Flow nodes animate when positions change — set
`style.transition = "transform 200ms ease"` on nodes, disabled during pan).

Node components (all in `components/nodes/`, custom React Flow node types):

- **ProblemNode**: title, phase badge, confirmed check. Click → inspector
  (Artifact tab shows problem.md).
- **WaveNode** (collapsed): header row = wave id + title (truncated), right
  chevron; body = roster glyph row (one role glyph per task, colored by
  task status), token spend `formatTokens(spend)`, status ring around the
  id. SoftInterrupted shows a `⏸` badge; closed waves dim to 80% opacity.
- **WaveNode** (expanded): same header; children rendered by React Flow.
- **TaskNode**: left = role glyph + method tag; right = status ring (SVG
  circle, stroke = status color, pulsing when running); token gauge = thin
  arc under the ring showing `min(1, estimatedOrUsed / budget)` (color →
  `--warn` above 0.8, `--danger` above 1.0); bottom line = conclusion chip
  (PROVED green / DISPROVED red / UNCERTAIN amber / PASS / FAIL) when done,
  else last item preview (muted, truncated, monospace) while running.
  Compact mode (zoom < 0.5): glyph + ring only. PROVED/DISPROVED here is
  the contributor's conclusion about that assignment, not an independently
  accepted candidate result.
- **ResolutionNode**: small document icon + "Resolution", muted; click →
  inspector Artifact tab with the resolution markdown.
- **LineageNode**: lane label: lineage id + title. An active direction whose
  latest candidate failed review says `REVISION NEEDED`; ACTIVE never means
  mathematically accepted.
- **CandidateNode**: candidate id (mono, larger), obligations count chip,
  burn-down chip `2C 5M 1m` colored per severity (only non-zero shown; all
  zero → `clean` in `--ok`), and a deterministic review-status chip such as
  `FAILED REVIEW`, `SUPERSEDED · UNREVIEWED`, `UNDER REVIEW`, or `ACCEPTED`.
  Review status takes precedence over the source author's conclusion.
  Abandoned lineage members render at 50% opacity.
- **ReviewNode**: `R001 PASS`/`FAIL` pill in verdict color + issue count.
- **MemoryHubNode**: "Memory" + per-status count chips; click → Library
  memory section.
- **QuestionNode**: `?` icon + truncated text; blocking ones pulse
  (`--danger` ring) and sort first; click → inspector with answer/dismiss
  actions inline.
- **FinalNode**: large pill `RESULT: PROVED/DISPROVED/UNCERTAIN` in
  ok/danger/warn color; click → final.md in inspector.

Edges: type `"smoothstep"`, 1.5px, `--border`; `sequence` edges 2px with
subtle arrowhead; `frozen-from` dashed `--seal`; `reviews` colored by
verdict; `revision` solid `--accent`. No edge labels except `reviews`
(PASS/FAIL, 10px). Edge hover raises opacity; edges never capture clicks.

Interaction: single click = select (React Flow selection ring, 2px
`--accent`) + open inspector (`?sel=`). Double-click = center + zoom to 1.0
on the node (React Flow `setCenter`). `Esc` closes the inspector. Hovering
a task highlights its produced artifacts' edges.

Empty states: phase INTAKE → centered “Research Manager is reading the
submitted materials and drafting W000…” skeleton;
AWAITING_CONFIRMATION → OpsView is replaced by IntakeConfirm (§9).

## 6. Top strip (inside ProjectLayout, always visible on project routes)

Left→right:
1. Project switcher (dropdown of projects + "＋ New problem").
2. **Phase tracker**: INTAKE → DISCOVERY → SYNTHESIS → REVIEW → REPAIR →
   TERMINAL as small connected dots; current phase lit `--accent`, TERMINAL
   lit in result color. (AWAITING_CONFIRMATION lights INTAKE with a "confirm"
   badge.)
3. **Budget bar**: horizontal 160px bar: research-worker spend (solid `--accent`),
   Research Manager/intake spend (hatched/lighter segment), remainder (`--panel-2`);
   label `spent / total` in `formatTokens`. Tooltip with exact numbers.
4. **Burn-down**: latest candidate's open issues as `2C 5M 1m` chips plus a
   tiny sparkline of open-issue count across its versions (SVG inline,
   28×14px). Hidden when no candidate.
5. Active workers count (`pool` glyph ⚙ n) when > 0.
6. Right side: **Fresh start** (once intake exists), autonomy toggle (Auto /
   Gated switch), Pause/Resume button, theme toggle, connection dot (live green
   / reconnecting amber pulse / fixture purple). Fresh start requires a
   different project title and creates a separate project at editable intake
   confirmation. It copies the raw objective and background, project-local
   uploaded documents, the latest W000, and research settings, but no later research
   state (rounds, tasks, claims, library entries, artifacts, computations, or
   external filesystem mounts. It does not change the source project or call a model.

Project navigation is **Research · Manager · Evidence · Library · Settings**. ManagerView
shows the newest Research Manager note in full. Earlier notes are newest-first
and collapsed by default, with the round and timestamp in each heading. A
fallback note is visibly marked and says that no new mathematical judgment was
returned; it must never look like an ordinary Manager conclusion.

SettingsView also has a project-level **Web search** permission. When enabled,
the Research Manager may grant native Web search to an individual future worker
assignment; it is not added to every worker automatically. Turning the setting
off removes search from assignments waiting to launch, while already-running
workers keep their launch configuration. W000 remains offline because it reads
the owner's potentially private raw submission.

The same view edits the model ID and reasoning effort for Research Manager,
Solver, Explorer, Reviewer, and Synthesizer. W000 uses the Research Manager
choice. Model fields accept known
choices as suggestions without preventing a custom CLI model ID; an empty field
means the Codex CLI account default. The legacy `planner` compatibility key is
never shown. Saving emits one project event and affects only model processes
launched after that event, including assignments waiting in the queue; an
already-running process keeps the command line with which it started. The view
states this boundary explicitly and shows a warning while tasks are running.
It also provides Revert and Restore defaults actions. Fixture mode is read-only.

## 7. Inspector (right slide-over, 440px, resizable 360–720px)

Opens for any selected node. Header: node type icon + id + title + "copy
link" (permalink) + close. Tabs (lazy-mounted, per §5 node type — only
relevant tabs shown):

1. **Artifact** — `GET /api/projects/:slug/artifacts/:id` → Markdown
   (KaTeX). Conclusion/verdict banner on top. For tasks: their artifact(s);
   for candidates: the frozen text; for waves: the resolution; questions:
   the question + answer form (answer/dismiss buttons POST and disable).
2. **Packet** (tasks) — manifest as an indented tree from
   `task.packetManifest`; clicking a file loads
   `/tasks/:id/packet/<path>` into a monospace viewer (markdown files
   render via Markdown component with a "raw" toggle).
3. **Memo** (tasks) — from `/api/projects/:slug/tasks/:id` memo: summary
   paragraph; then definition lists: new claims (with evidence chips),
   issues (severity chips), obligations, dead ends, proposed cards (with
   admission outcome looked up from state.cards), computations, budget
   report. Empty sections omitted.
4. **Recall** (tasks) — memory.recall events for this task from the event
   log (filter client-side): op, args, returned ids (chips linking to
   Library), refused ids highlighted `--danger`.
5. **Events** — this node's event timeline (client-side filter of applied
   events by id match), newest last, monospace, with seq + time.
6. **Stream** (tasks) — SSE `/tasks/:id/stream`; render each JSONL line as
   a compact row: item type chip + text/command preview (agent_message and
   reasoning rows render full text on click). Auto-follow toggle (on while
   running). Connect only while tab visible; disconnect on tab change.

Task inspectors always open on **Work** by default. Notes remain one click away,
and a live status change never overrides a tab the reader selected.
The tab strip is non-shrinking; long Work content scrolls only inside the body
and cannot fold the tabs into a scrollbar.

Task inspector footer (running tasks): `Interrupt` (danger, confirm) and
`Extend budget +25%` buttons. Candidate footer: `Raise issue` (severity /
location / text form). Claim rows (in Evidence/Library): `Mark VERIFIED` /
`Mark REFUTED` with a required note dialog. Card rows: `Quarantine` with
note. All human actions POST, then rely on SSE for the state change
(optimistic UI is forbidden — the event stream is the truth).

## 8. Evidence view

The fixed header names the selected candidate and its review status. It also
states that VERIFIED or REFUTED on a K-node applies only to that individual
statement: a verified supporting lemma does not imply the candidate passed
review.

Layout from `layoutEvidence(graph)`. Nodes:
- CandidateNode (reused, larger, at left).
- ObligationNode: amber-bordered card, obligation text (wrapped, ≤ 3 lines).
- ClaimNode: claim id (mono) + statement (≤ 3 lines) + status ring; border
  color = status color. Its detail view explains the exact scope of the status
  and surfaces the recorded justification; claim status never transfers to a
  candidate or to a stronger statement that cites it.
- IssueNode: severity chip + summary (≤ 2 lines); resolved issues at 50%
  opacity with disposition label.
Edges: `uses` solid, `depends-on` dashed, `attacks` in severity color with
arrowhead. Version selector (top-left of canvas): segmented control of the
active lineage's versions (default latest; `?version=` param); switching
re-derives the graph for that candidate. Abandoned lineages selectable via
a small dropdown next to it ("show abandoned…").

Empty state: "No candidate frozen yet — the evidence graph appears at first
freeze."

## 9. IntakeConfirm

Project creation is deliberately two-stage. `POST /projects` first uses
`start:false`; the UI uploads every staged supplementary file before calling
`/start`, so the Research Manager never sees a partial submission. If an upload
fails, the saved project stays in CREATED and shows its raw objective,
background, and editable file dropzone. “Generate W000” starts the one Manager
reading.

While AWAITING_CONFIRMATION, a full-width panel replaces the graph. It shows
`W000 · Current mathematical view` with a directly editable abstract (one or
two sentences) and Markdown body, alongside a live rendered preview. Beneath
it, the S### catalog keeps each original source expandable: a short abstract,
conclusion-oriented excerpt, hash, and either verbatim text or a link to the
original uploaded bytes. “Edit raw input” returns to editable objective,
background, and supplementary files. Saving those changes regenerates W000;
until that succeeds, the older W000 is visibly stale and cannot be accepted.
Retained uploads may be replaced or removed in this pre-confirmation view, but
become immutable once research begins. “Regenerate from originals” reruns the
Manager without changing the raw input. Either regeneration path replaces the
draft only after a successful Manager reading; a failed call preserves both
the revised raw submission and the current W000 for retry. “Accept W000 & begin
research” saves any direct edits and enters DISCOVERY. There is no generated
questionnaire, taxonomy, or chat surface.

## 10. Library

Left tree (fixed 220px): Problem · Original materials · Candidate (active latest, bold) ·
Attempts (n) · Explorations (n) · Reviews (n) · Claims (n) · Memory (n) ·
Resolutions (n) · Computations (n) · Final (only when terminal). Right
content:
- Sections with markdown artifacts → artifact list (id, conclusion chip,
  producing task, wave) → click → full Markdown render with header
  metadata + "show in graph" (deep link).
- **Claims**: table (id | status ring+label | statement | provenance |
  wave), client-side filter chips by status + text search; row expand shows
  history + human action buttons (§7).
- **Memory**: card grid (title, type chip, status ring, abstract, tags);
  filter by status/type + search; card click → full card + provenance +
  linked artifact button + Quarantine action.
- **Computations**: id, entry command (mono), reproduced badge (✓ match
  green / ✗ mismatch red / — not yet), task link.
Everything updates live from the store; artifact bodies are fetched on
demand and cached in a `Map<artifactId, {seq, markdown}>` invalidated when
a newer `artifact.recorded` for that id arrives.

## 11. ProjectsPage (L0)

Grid of project cards: title, slug (mono), phase tracker (mini), budget
bar (mini), open blocking questions badge (`--danger`), terminal result
pill, waves count, updated-at. Cards sorted: blocked first, then running,
then terminal. `＋ New problem` card opens a dialog: title, statement, long
background/literature/idea notes, and supplementary files. Its collapsed
advanced section contains total token budget, autonomy, max waves, web search,
and source mounts. Next stores all materials and generates W000 only after
uploads finish. Top of page: runtime
strip (codex ok/version, pool occupancy, memory service state) from
`/api/runtime`.

## 12. Steering dock

Bottom bar on project routes (not a sidebar): directive input (single
line, expands to textarea on focus) + Urgent checkbox + Send. Below it a
collapsible list of recent directives with status ("pending" pulse /
"consumed by DEC014"). Gate flow: when `state.openGateDecisionId` is set,
a **GateCard** modal (non-dismissable, but movable) shows the decision's
proposed action rendered as a readable summary (wave plan → roster table;
other actions → labeled fields) + three buttons: Approve / Edit / Reject
(with note). Edit opens a JSON editor (plain textarea + client-side zod
validation via `validateActionEnvelope` with inline errors) prefilled with
the action. Blocking questions: **QuestionsToast** bottom-right stack;
blocking ones open a modal with answer textarea (answer/dismiss).

## 13. Performance budget

- Applying 1000 events into the reducer < 100ms (batch via rAF).
- Layout of 20 waves × 4 tasks + lanes < 10ms per call; memoize on
  `(state.seq, collapseSet identity)`.
- No React re-render of node components whose data didn't change: node
  `data` objects must be referentially stable via `useMemo` keyed by the
  underlying state slices (React Flow rerenders nodes on data identity).
- Markdown/KaTeX only renders in mounted inspector tabs and library pages.
- The Stream tab keeps at most the last 500 rows in DOM (windowing by
  slicing is fine; no virtualization library).

## 14. Testing (vitest; no browser automation in v1)

- `test/layout.test.ts` — PROVIDED with the layout engines; keep green.
- Store: reducer batch application (fold fixture events, spot-check state),
  collapse defaults logic, fixture replay determinism.
- URL resolver: `/p/x/node/T003` → ops+sel, `/p/x/node/K002` → evidence.
- Format helpers: token formatting, truncation.
- Model settings: user-selectable-role projection, legacy-project defaults, change detection.
- Components are NOT unit-tested in v1 (manual pass + fixture mode).

## 15. Acceptance checklist (executor: verify before reporting done)

- [ ] `npm run dev -w @inventio/ui` against a sim-backed conductor: create
      a project, confirm intake, watch a wave run live (task rings pulse,
      spend ticks), open a running task's Stream tab.
- [ ] `?fixture=happy` renders the full lifecycle with no backend and the
      graph is stable while stepping.
- [ ] Both themes pass a visual check on every view; no unreadable text.
- [ ] Deep link to a claim opens Evidence with the claim selected.
- [ ] Gate flow (gated project): approve and reject-with-note both work.
- [ ] `vite build` succeeds; conductor serves `dist/` at `/`.
