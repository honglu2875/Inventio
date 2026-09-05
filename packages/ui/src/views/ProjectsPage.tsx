import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { defaultRecurrentConfig } from "@inventio/schema";
import SourceDropzone from "../components/SourceDropzone";
import Toasts from "../components/Toasts";
import { api, errorMessage, type ProjectSummary } from "../lib/api";
import { formatAgo, formatExact, formatTokens } from "../lib/format";
import { PHASES, resultColor } from "../lib/visual";
import { refreshRuntime } from "../store/connect";
import { useApiAction } from "../store/hooks";
import { useStore } from "../store/store";

/** ProjectsPage (UI-SPEC §11): the L0 list, the runtime strip, project creation. */

const POLL_MS = 5000;
const NEW_PROJECT_DEFAULTS = defaultRecurrentConfig();

function MiniPhases({ project }: { project: ProjectSummary }): JSX.Element {
  const current = project.phase === "AWAITING_CONFIRMATION" ? "INTAKE" : project.phase;
  return (
    <div className="phase-tracker mini" title={`phase: ${project.phase}`}>
      {PHASES.map((phase) => (
        <span
          key={phase}
          className={`phase-dot${phase === current ? " lit" : ""}`}
          style={
            phase === "TERMINAL" && project.terminal
              ? { background: resultColor(project.terminal.result) }
              : undefined
          }
          title={phase}
        />
      ))}
    </div>
  );
}

function MiniBudget({ project }: { project: ProjectSummary }): JSX.Element {
  const total = Math.max(1, project.budget.totalTokens);
  const worker = project.budget.spentTokens;
  const planner = project.budget.plannerSpentTokens;
  const workerPct = Math.min(100, (worker / total) * 100);
  const plannerPct = Math.min(100 - workerPct, (planner / total) * 100);
  const readerLabel =
    project.workflow === "recurrent-v3" ? "intake" : project.workflow === "trajectories-v2" ? "summary and final readings" : "Research Manager";
  const title = `research workers ${formatExact(worker)} + ${readerLabel} ${formatExact(planner)} of ${formatExact(total)}`;
  return (
    <div className="budget mini" title={title}>
      <div className="budget-bar" role="img" aria-label={title}>
        <div className="budget-worker" style={{ width: `${workerPct}%` }} />
        <div className="budget-planner" style={{ width: `${plannerPct}%` }} />
      </div>
      <span className="budget-label mono small">
        {formatTokens(worker + planner)} / {formatTokens(total)}
      </span>
    </div>
  );
}

/** blocked first, then running, then terminal (§11). */
function rank(project: ProjectSummary): number {
  if (project.openBlockingQuestions > 0 || project.phase === "AWAITING_CONFIRMATION") return 0;
  if (project.terminal) return 2;
  return 1;
}

function ProjectCard({ project }: { project: ProjectSummary }): JSX.Element {
  const blocking = project.openBlockingQuestions;
  return (
    <Link className="project-card" to={`/p/${project.slug}`}>
      <div className="project-card-head">
        <span className="project-title">{project.title || project.slug}</span>
        {blocking > 0 ? (
          <span className="badge danger-badge" title="open blocking questions">
            {blocking} blocking
          </span>
        ) : null}
        {project.paused ? <span className="badge warn">paused</span> : null}
      </div>
      <div className="project-slug mono small">{project.slug}</div>
      <MiniPhases project={project} />
      <MiniBudget project={project} />
      <div className="project-card-foot">
        {project.terminal ? (
          <span
            className="result-pill"
            style={{
              color: resultColor(project.terminal.result),
              borderColor: resultColor(project.terminal.result),
            }}
          >
            {project.terminal.result}
          </span>
        ) : (
          <span className="chip">{project.phase}</span>
        )}
        <span className="muted small">
          {project.waves} round{project.waves === 1 ? "" : "s"}
        </span>
        <span className="muted small">
          {project.workflow === "recurrent-v3" ? "recurrent research" : project.workflow === "trajectories-v2" ? "long trajectories" : project.autonomy}
        </span>
        {project.updatedAt === null ? null : (
          <span className="muted small">{formatAgo(project.updatedAt)}</span>
        )}
      </div>
    </Link>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const run = useApiAction();
  const [title, setTitle] = useState("");
  const [statement, setStatement] = useState("");
  const [contextMarkdown, setContextMarkdown] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [totalTokens, setTotalTokens] = useState(String(NEW_PROJECT_DEFAULTS.budget.totalTokens));
  const [maxWaves, setMaxWaves] = useState(String(NEW_PROJECT_DEFAULTS.limits.maxWaves));
  const [allowWebSearch, setAllowWebSearch] = useState(NEW_PROJECT_DEFAULTS.allowWebSearch);
  const [researchModel, setResearchModel] = useState(NEW_PROJECT_DEFAULTS.researchModels!.research.model ?? "");
  const [supportModel, setSupportModel] = useState(NEW_PROJECT_DEFAULTS.researchModels!.support.model ?? "");
  // Files cannot be stored before the project exists, so they are staged here
  // and uploaded the moment creation succeeds — before we navigate away.
  const [stagedSources, setStagedSources] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const settingsError = [researchModel, supportModel].some(m => !m.trim() || /\s/.test(m.trim()))
    ? "Enter a model ID without spaces for each role."
    : !Number.isSafeInteger(Number(totalTokens)) || Number(totalTokens) <= 0 || !Number.isSafeInteger(Number(maxWaves)) || Number(maxWaves) <= 0
      ? "Allowance and rounds must be positive whole numbers." : null;

  const submit = (): void => {
    if (busy || title.trim() === "" || statement.trim() === "" || settingsError !== null) return;
    const config: Record<string, unknown> = {};
    const tokens = Number(totalTokens);
    const waves = Number(maxWaves);
    if (Number.isFinite(tokens) && tokens > 0) config["budget"] = { totalTokens: Math.floor(tokens) };
    if (Number.isFinite(waves) && waves > 0) config["limits"] = { maxWaves: Math.floor(waves) };
    config["workflow"] = "recurrent-v3";
    config["autonomy"] = "auto";
    config["allowWebSearch"] = allowWebSearch;
    config["researchModels"] = {
      research: { ...NEW_PROJECT_DEFAULTS.researchModels!.research, model: researchModel.trim() },
      support: { ...NEW_PROJECT_DEFAULTS.researchModels!.support, model: supportModel.trim() },
    };

    setBusy(true);
    void run(() =>
      api.createProject({
        title: title.trim(),
        statement: statement.trim(),
        contextMarkdown: contextMarkdown.trim(),
        config,
        // W000 must not be generated until every staged file is durable.
        start: false,
      }),
    )
      .then(async (created) => {
        if (!created) return;
        let uploadFailed = false;
        for (const file of stagedSources) {
          try {
            await api.uploadSource(created.slug, file);
          } catch (err) {
            uploadFailed = true;
            pushToast(`${file.name}: ${errorMessage(err)}`, "error");
          }
        }
        if (!uploadFailed) {
          const started = await run(() => api.start(created.slug));
          if (!started) uploadFailed = true;
        }
        if (uploadFailed) {
          pushToast("The draft was saved. Fix the source list, then generate W000.", "error");
        }
        navigate(`/p/${created.slug}`);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="new problem">
        <header className="modal-head">
          <h2>New problem</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="close">
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Title</span>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bounding the spectral gap"
            />
          </label>
          <label className="field">
            <span className="field-label">Statement</span>
            <textarea
              className="textarea mono"
              rows={8}
              value={statement}
              spellCheck={false}
              onChange={(e) => setStatement(e.target.value)}
              placeholder="Prove or disprove: …"
            />
          </label>

          <label className="field">
            <span className="field-label">Background, literature, and existing ideas <em>(optional)</em></span>
            <textarea
              className="textarea mono"
              rows={10}
              value={contextMarkdown}
              spellCheck={false}
              onChange={(e) => setContextMarkdown(e.target.value)}
              placeholder="Paste long notes, references, partial attempts, intuitions, and possible obstructions. They will be read before W000 is drafted…"
            />
            <span className="muted small">
              Long paragraphs are welcome. Supplied claims remain unverified until the research process checks them.
            </span>
          </label>

          <div className="field">
            <span className="field-label">Supplementary files <em>(optional)</em></span>
            <SourceDropzone slug={null} staged={stagedSources} onStagedChange={setStagedSources} />
            <span className="muted small">
              Files are stored verbatim with the raw intake before W000 is drafted.
            </span>
          </div>

          <button
            type="button"
            className="disclosure"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            {advanced ? "▾" : "▸"} Advanced
          </button>
          {advanced ? (
            <div className="advanced">
              <label className="field inline">
                <span className="field-label">Total token budget</span>
                <input
                  className="input mono"
                  value={totalTokens}
                  inputMode="numeric"
                  onChange={(e) => setTotalTokens(e.target.value)}
                />
              </label>
              <label className="field inline">
                <span className="field-label">Maximum rounds</span>
                <input
                  className="input mono"
                  value={maxWaves}
                  inputMode="numeric"
                  onChange={(e) => setMaxWaves(e.target.value)}
                />
              </label>
              <label className="field inline">
                <span className="field-label">Web search</span>
                <span className="checkbox">
                  <input
                    type="checkbox"
                    checked={allowWebSearch}
                    onChange={(e) => setAllowWebSearch(e.target.checked)}
                  />
                  Allow research trajectories and verification to search the literature
                </span>
              </label>
              <p className="muted small">Each round has one Solver and one Explorer. Independent verification uses the support model; the research model audits memory from round two.</p>
              <label className="field inline"><span className="field-label">Research model</span><input className="input mono" value={researchModel} onChange={e => setResearchModel(e.target.value)} /></label>
              <label className="field inline"><span className="field-label">Support model</span><input className="input mono" value={supportModel} onChange={e => setSupportModel(e.target.value)} /></label>
              {settingsError === null ? null : (
                <div className="settings-help settings-error" role="alert">
                  {settingsError}
                </div>
              )}
            </div>
          ) : null}
        </div>
        <footer className="modal-foot">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={
              busy || title.trim() === "" || statement.trim() === "" || settingsError !== null
            }
            onClick={submit}
          >
            {busy ? (stagedSources.length > 0 ? "Saving materials…" : "Preparing…") : "Next"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function RuntimeStrip(): JSX.Element {
  const runtime = useStore((s) => s.runtime);
  return (
    <div className="runtime-strip">
      {runtime === null ? (
        <span className="muted small">conductor unreachable</span>
      ) : (
        <>
          <span className={`conn conn-${runtime.codexOk ? "live" : "reconnecting"}`}>
            <span className="conn-dot" />
            <span className="small">codex {runtime.codexOk ? "ok" : "unavailable"}</span>
          </span>
          <span
            className={`conn conn-${runtime.texOk ? "live" : "reconnecting"}`}
            title={runtime.texDetail ?? "Local TeX compiler is ready"}
          >
            <span className="conn-dot" />
            <span className="small">TeX {runtime.texOk ? "ok" : "unavailable"}</span>
          </span>
          <span className="pool" title="worker pool occupancy">
            ⚙ {runtime.poolActive} active · {runtime.poolQueued} queued
          </span>
        </>
      )}
    </div>
  );
}

export default function ProjectsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showDialog = params.get("new") === "1";

  const closeDialog = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  useEffect(() => {
    let live = true;
    const poll = (): void => {
      refreshRuntime();
      void api
        .listProjects()
        .then((list) => {
          if (!live) return;
          setProjects(list);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!live) return;
          setProjects((prev) => prev ?? []);
          setError(errorMessage(err));
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const sorted =
    projects === null
      ? []
      : [...projects].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));

  return (
    <div className="projects-page">
      <header className="projects-head">
        <h1>Inventio</h1>
        <RuntimeStrip />
      </header>
      {error === null ? null : <div className="banner danger">{error}</div>}
      <div className="project-grid">
        {sorted.map((project) => (
          <ProjectCard key={project.slug} project={project} />
        ))}
        <button
          type="button"
          className="project-card new-card"
          onClick={() =>
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                next.set("new", "1");
                return next;
              },
              { replace: false },
            )
          }
        >
          <span className="new-plus">＋</span>
          <span>New problem</span>
        </button>
      </div>
      {projects !== null && projects.length === 0 && error === null ? (
        <p className="muted empty-note">No projects yet — start one.</p>
      ) : null}
      {showDialog ? <NewProjectDialog onClose={closeDialog} /> : null}
      <Toasts />
    </div>
  );
}
