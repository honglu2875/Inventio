import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { currentTerminalPublication, type ProjectState } from "@inventio/schema";
import { api, errorMessage, type ProjectSummary } from "../lib/api";
import { formatExact, formatTokens } from "../lib/format";
import { PHASES, burnDownChips, resultColor } from "../lib/visual";
import { useStore } from "../store/store";
import { useActionGuard, useApiAction, useConnection } from "../store/hooks";
import ContinueResearchDialog from "./steering/ContinueResearchDialog";
import FreshStartDialog from "./steering/FreshStartDialog";
import PublicationDialog from "./steering/PublicationDialog";

/** Top strip (UI-SPEC §6): phase, budget, burn-down, steering toggles. */

function PhaseTracker({ state }: { state: ProjectState }): JSX.Element {
  const awaiting = state.phase === "AWAITING_CONFIRMATION";
  const current = awaiting ? "INTAKE" : state.phase;
  return (
    <div className="phase-tracker" title={`phase: ${state.phase}`}>
      {PHASES.map((phase) => {
        const lit = phase === current;
        const terminalColor = phase === "TERMINAL" ? resultColor(state.terminal?.result) : null;
        return (
          <span key={phase} className="phase-step">
            <span
              className={`phase-dot${lit ? " lit" : ""}`}
              style={
                phase === "TERMINAL" && state.terminal
                  ? { background: terminalColor ?? "var(--accent)" }
                  : undefined
              }
            />
            <span className={`phase-label${lit ? " lit" : ""}`}>{phase}</span>
          </span>
        );
      })}
      {awaiting ? <span className="badge warn confirm-badge">confirm</span> : null}
    </div>
  );
}

function BudgetBar({ state }: { state: ProjectState }): JSX.Element {
  const total = Math.max(1, state.budget.totalTokens);
  const worker = state.budget.spentTokens;
  const planner = state.budget.plannerSpentTokens;
  const workerPct = Math.min(100, (worker / total) * 100);
  const plannerPct = Math.min(100 - workerPct, (planner / total) * 100);
  const title = `research workers ${formatExact(worker)} + Research Manager ${formatExact(planner)} of ${formatExact(total)} tokens`;
  return (
    <div className="budget" title={title}>
      <div className="budget-bar" role="img" aria-label={title}>
        <div className="budget-worker" style={{ width: `${workerPct}%` }} />
        <div className="budget-planner" style={{ width: `${plannerPct}%` }} />
      </div>
      <span className="budget-label mono">
        {formatTokens(worker + planner)} / {formatTokens(total)}
      </span>
    </div>
  );
}

function Sparkline({ counts }: { counts: number[] }): JSX.Element | null {
  if (counts.length < 2) return null;
  const max = Math.max(1, ...counts);
  const w = 28;
  const h = 14;
  const points = counts
    .map((c, i) => {
      const x = (i / (counts.length - 1)) * (w - 2) + 1;
      const y = h - 1 - (c / max) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img"
      aria-label={`open issues per version: ${counts.join(", ")}`}>
      <polyline points={points} fill="none" stroke="var(--muted)" strokeWidth={1} />
    </svg>
  );
}

function BurnDown({ state }: { state: ProjectState }): JSX.Element | null {
  const lineage = state.activeLineageId ? state.lineages[state.activeLineageId] : undefined;
  const versions = lineage?.versionIds ?? [];
  const latestId = versions[versions.length - 1];
  const latest = latestId ? state.candidates[latestId] : undefined;
  if (!latest) return null;

  const burn = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  for (const id of latest.issueIds) {
    const issue = state.issues[id];
    if (issue && issue.status === "open") burn[issue.severity] += 1;
  }
  const history = versions.map((vid) => {
    const cand = state.candidates[vid];
    if (!cand) return 0;
    return cand.issueIds.filter((iid) => state.issues[iid]?.status === "open").length;
  });

  return (
    <div className="burn-down" title={`${latestId ?? ""} open issues`}>
      <span className="mono small">{latestId}</span>
      {burnDownChips(burn).map((chip) => (
        <span key={chip.text} className="chip" style={{ color: chip.color, borderColor: chip.color }}>
          {chip.text}
        </span>
      ))}
      <Sparkline counts={history} />
    </div>
  );
}

function ProjectSwitcher({ slug }: { slug: string }): JSX.Element {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let live = true;
    void api
      .listProjects()
      .then((list) => {
        if (live) setProjects(list);
      })
      .catch(() => {
        /* offline / fixture mode: the switcher just stays empty */
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="switcher">
      <select
        className="select"
        value={slug}
        onChange={(e) => {
          if (e.target.value === "__new") navigate("/?new=1");
          else navigate(`/p/${e.target.value}`);
        }}
        aria-label="switch project"
      >
        {projects.some((p) => p.slug === slug) ? null : <option value={slug}>{slug}</option>}
        {projects.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.title}
          </option>
        ))}
        <option value="__new">＋ New problem</option>
      </select>
    </div>
  );
}

function ConnectionDot({ slug }: { slug: string }): JSX.Element {
  const connection = useConnection(slug);
  const label =
    connection === "live"
      ? "live"
      : connection === "fixture"
        ? "fixture replay"
        : connection === "reconnecting"
          ? "reconnecting…"
          : "connecting…";
  return (
    <span className={`conn conn-${connection}`} title={label}>
      <span className="conn-dot" />
      <span className="small">{label}</span>
    </span>
  );
}

function ThemeToggle(): JSX.Element {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  const glyph = theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐";
  return (
    <button
      type="button"
      className="icon-button"
      onClick={() => setTheme(next)}
      title={`theme: ${theme} (click for ${next})`}
      aria-label={`theme: ${theme}`}
    >
      {glyph}
    </button>
  );
}

/** Rendered math in node labels, cards and tables (§5, §8, §10) — on by default. */
function MathToggle(): JSX.Element {
  const renderMath = useStore((s) => s.renderMath);
  const setRenderMath = useStore((s) => s.setRenderMath);
  return (
    <button
      type="button"
      className={`icon-button${renderMath ? " on" : ""}`}
      onClick={() => setRenderMath(!renderMath)}
      title={`Render math (${renderMath ? "on" : "off"})`}
      aria-label="render math"
      aria-pressed={renderMath}
    >
      ∑
    </button>
  );
}

export default function TopStrip({ slug, state }: { slug: string; state: ProjectState | null }): JSX.Element {
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const pushToast = useStore((s) => s.pushToast);
  const [continueOpen, setContinueOpen] = useState(false);
  const [freshStartOpen, setFreshStartOpen] = useState(false);
  const [publicationOpen, setPublicationOpen] = useState(false);
  const [publicationStarting, setPublicationStarting] = useState(false);
  const [publicationStartError, setPublicationStartError] = useState<string | null>(null);
  useEffect(() => {
    // React Router keeps this component mounted between /p/:slug routes.
    // Project-specific dialogs must never carry over to the next project.
    setContinueOpen(false);
    setFreshStartOpen(false);
    setPublicationOpen(false);
    setPublicationStarting(false);
    setPublicationStartError(null);
  }, [slug]);
  const runningTasks = useMemo(
    () =>
      state === null
        ? 0
        : Object.values(state.tasks).filter((t) => t.status === "running").length,
    [state],
  );
  const publication = state === null ? null : currentTerminalPublication(state);
  const publicationBusy =
    publication?.status === "drafting" || publication?.status === "compiling";

  useEffect(() => {
    if (publication !== null) setPublicationStartError(null);
  }, [publication?.id]);

  const preparePublication = async (): Promise<void> => {
    if (publicationStarting || guard.disabled) return;
    setPublicationStarting(true);
    setPublicationStartError(null);
    try {
      await api.preparePublication(slug);
      pushToast("Manuscript preparation started", "ok");
    } catch (error) {
      const message = errorMessage(error);
      setPublicationStartError(message);
      pushToast(message, "error");
    } finally {
      setPublicationStarting(false);
    }
  };

  return (
    <>
      <header className="topstrip">
        <ProjectSwitcher slug={slug} />
        {state === null ? (
          <span className="muted small">loading…</span>
        ) : (
          <>
            <PhaseTracker state={state} />
            <BudgetBar state={state} />
            <BurnDown state={state} />
            {runningTasks > 0 ? (
              <span className="pool" title={`${runningTasks} running workers`}>
                ⚙ {runningTasks}
              </span>
            ) : null}
            <div className="spacer" />
            {state.problem.normalizedMarkdown !== null ? (
              <button
                type="button"
                className="button ghost"
                disabled={guard.disabled}
                title={guard.title ?? "Create a new project from this intake only"}
                onClick={() => setFreshStartOpen(true)}
              >
                Fresh start
              </button>
            ) : null}
            <button
              type="button"
              className={`toggle${state.config.autonomy === "gated" ? " on" : ""}`}
              disabled={guard.disabled}
              {...(guard.title === undefined ? {} : { title: guard.title })}
              onClick={() => {
                const mode = state.config.autonomy === "auto" ? "gated" : "auto";
                void run(() => api.setAutonomy(slug, mode));
              }}
            >
              {state.config.autonomy === "auto" ? "Auto" : "Gated"}
            </button>
            {state.terminal ? (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={publicationStarting || (publication === null && guard.disabled)}
                  title={
                    publication === null
                      ? guard.title ?? "Ask the Research Manager to prepare a standalone TeX manuscript"
                      : "Open the standalone manuscript"
                  }
                  onClick={() => {
                    setPublicationOpen(true);
                    setPublicationStartError(null);
                    if (publication === null) void preparePublication();
                  }}
                >
                  {publicationStarting
                    ? "Preparing manuscript…"
                    : publication?.status === "drafting"
                      ? "Preparing manuscript…"
                      : publication?.status === "compiling"
                        ? "Compiling PDF…"
                        : publication?.texPath
                          ? "Paper"
                          : publication?.status === "failed"
                            ? "Paper needs attention"
                            : "Prepare paper"}
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={guard.disabled || publicationBusy}
                  title={
                    guard.title ??
                    (publicationBusy
                      ? "Wait for the standalone publication pass to finish"
                      : undefined)
                  }
                  onClick={() => setContinueOpen(true)}
                >
                  Continue research
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button"
                disabled={guard.disabled}
                {...(guard.title === undefined ? {} : { title: guard.title })}
                onClick={() => {
                  void run(() => (state.paused ? api.resume(slug) : api.pause(slug)));
                }}
              >
                {state.paused ? "Resume" : "Pause"}
              </button>
            )}
          </>
        )}
        <MathToggle />
        <ThemeToggle />
        <ConnectionDot slug={slug} />
      </header>
      {continueOpen && state?.terminal ? (
        <ContinueResearchDialog slug={slug} state={state} onClose={() => setContinueOpen(false)} />
      ) : null}
      {publicationOpen && state?.terminal ? (
        <PublicationDialog
          slug={slug}
          publication={publication}
          starting={publicationStarting}
          startError={publicationStartError}
          onPrepare={() => void preparePublication()}
          onClose={() => setPublicationOpen(false)}
        />
      ) : null}
      {freshStartOpen && state !== null && state.problem.normalizedMarkdown !== null ? (
        <FreshStartDialog slug={slug} state={state} onClose={() => setFreshStartOpen(false)} />
      ) : null}
    </>
  );
}
