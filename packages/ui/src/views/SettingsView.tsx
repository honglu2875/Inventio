import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  projectSettingsFromConfig,
  type ModelChoice,
  type ProjectState,
  type ProjectSettings,
  type ReasoningEffort,
} from "@inventio/schema";
import { useProjectSlug } from "../components/ProjectContext";
import { api } from "../lib/api";
import {
  ACTIVE_MODEL_ROLES,
  KNOWN_MODEL_IDS,
  MODEL_ROLE_INFO,
  REASONING_EFFORTS,
  TRAJECTORY_MODEL_ROLES,
  defaultActiveModelSettings,
  sameModelSettings,
  type ActiveModelRole,
} from "../lib/modelSettings";
import { useActionGuard, useApiAction, useProjectState } from "../store/hooks";

function effectiveModel(role: ActiveModelRole, choice: ModelChoice): string {
  if (choice.model !== null) return choice.model;
  return role === "synthesizer" ? "gpt-5.6-terra (synthesis fallback)" : "Codex CLI default";
}

function sameTrajectory(
  left: ProjectSettings["trajectory"],
  right: ProjectSettings["trajectory"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.solversPerWave === right.solversPerWave &&
    left.explorersPerWave === right.explorersPerWave &&
    left.verifiersPerClaim === right.verifiersPerClaim &&
    left.passesRequired === right.passesRequired
  );
}

export function parseIntegerDraft(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Keep the text being edited separate from the saved numeric value. Converting
 * an empty field with `Number("")` would immediately turn it into zero, which
 * makes replacing (for example) 2 with 4 feel like typing 04.
 */
function IntegerDraftInput({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}): JSX.Element {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  return (
    <input
      className="input mono"
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = parseIntegerDraft(next);
        if (parsed !== null) onChange(parsed);
      }}
      onBlur={() => {
        if (parseIntegerDraft(text) === null) setText(String(value));
      }}
    />
  );
}

export function WebSearchPermissionControl({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}): JSX.Element {
  return (
    <fieldset className="web-search-options" aria-label="Web search permission">
      <legend>Web search</legend>
      <label className="web-search-option">
        <input
          type="radio"
          name="web-search-permission"
          value="allowed"
          checked={enabled}
          disabled={disabled}
          onChange={() => onChange(true)}
        />
        <span>Allowed</span>
      </label>
      <label className="web-search-option">
        <input
          type="radio"
          name="web-search-permission"
          value="not-allowed"
          checked={!enabled}
          disabled={disabled}
          onChange={() => onChange(false)}
        />
        <span>Not allowed</span>
      </label>
    </fieldset>
  );
}

export default function SettingsView(): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);

  // Do not mount a draft initialized from defaults while the durable project
  // snapshot is still loading. The first editable render must already contain
  // the project's actual creation/current settings.
  if (state === null) {
    return (
      <div className="settings-view">
        <div className="skeleton-bar w90" aria-label="loading project settings" />
      </div>
    );
  }

  return <SettingsForm key={slug} slug={slug} state={state} />;
}

function SettingsForm({ slug, state }: { slug: string; state: ProjectState }): JSX.Element {
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const saved = useMemo(() => projectSettingsFromConfig(state.config), [state.config]);
  const [draft, setDraft] = useState<ProjectSettings>(saved);
  const [saving, setSaving] = useState(false);
  const isTrajectory = state.config.workflow === "trajectories-v2";
  const modelRoles = isTrajectory ? TRAJECTORY_MODEL_ROLES : ACTIVE_MODEL_ROLES;
  const savedWorkerTokenLimit =
    saved.workerTokenLimit ?? state.config.budget.defaultTaskTokens;
  const draftWorkerTokenLimit =
    draft.workerTokenLimit ?? state.config.budget.defaultTaskTokens;

  useEffect(() => {
    setDraft(saved);
  }, [slug, saved]);

  const update = (role: ActiveModelRole, patch: Partial<ModelChoice>): void => {
    setDraft((current) => ({
      ...current,
      models: {
        ...current.models,
        [role]: { ...current.models[role], ...patch },
      },
    }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const unchanged =
      sameModelSettings(saved.models, draft.models) &&
      saved.autonomy === draft.autonomy &&
      saved.allowWebSearch === draft.allowWebSearch &&
      saved.totalTokens === draft.totalTokens &&
      savedWorkerTokenLimit === draftWorkerTokenLimit &&
      saved.maxWaves === draft.maxWaves &&
      sameTrajectory(saved.trajectory, draft.trajectory);
    if (saving || guard.disabled || unchanged || resourceError !== null) return;
    setSaving(true);
    void run(
      () => api.setProjectSettings(slug, draft),
      "Project settings saved",
    ).finally(() => setSaving(false));
  };

  const runningTasks = Object.values(state.tasks).filter((task) => task.status === "running").length;
  const dirty =
    !sameModelSettings(saved.models, draft.models) ||
    saved.autonomy !== draft.autonomy ||
    saved.allowWebSearch !== draft.allowWebSearch ||
    saved.totalTokens !== draft.totalTokens ||
    savedWorkerTokenLimit !== draftWorkerTokenLimit ||
    saved.maxWaves !== draft.maxWaves ||
    !sameTrajectory(saved.trajectory, draft.trajectory);
  const spentTokens = state.budget.spentTokens + state.budget.plannerSpentTokens;
  const hasOpenRound = Object.values(state.waves).some((wave) => wave.status !== "closed");
  const resourceError =
    !Number.isSafeInteger(draft.totalTokens) || draft.totalTokens <= 0
      ? "The token ceiling must be a positive whole number."
      : draft.totalTokens < spentTokens
        ? `The token ceiling cannot be below ${spentTokens.toLocaleString("en-US")} tokens already spent.`
        : !Number.isSafeInteger(draftWorkerTokenLimit) || draftWorkerTokenLimit < 60_000
          ? "The per-trajectory token limit must be a whole number of at least 60,000."
          : !Number.isSafeInteger(draft.maxWaves) || draft.maxWaves <= 0
            ? "The maximum number of rounds must be a positive whole number."
            : draft.maxWaves < state.waveOrder.length
              ? `The maximum cannot be below ${state.waveOrder.length} rounds already used.`
              : hasOpenRound &&
                  (draft.totalTokens < saved.totalTokens || draft.maxWaves < saved.maxWaves)
                ? "Resource ceilings cannot be lowered while a research round is open."
                : isTrajectory && draft.trajectory === undefined
                  ? "Trajectory settings are missing."
                  : isTrajectory &&
                      (!Number.isSafeInteger(draft.trajectory!.solversPerWave) ||
                        draft.trajectory!.solversPerWave < 0 ||
                        draft.trajectory!.solversPerWave > 8 ||
                        !Number.isSafeInteger(draft.trajectory!.explorersPerWave) ||
                        draft.trajectory!.explorersPerWave < 0 ||
                        draft.trajectory!.explorersPerWave > 8)
                    ? "Solver and Explorer counts must be whole numbers from 0 to 8."
                    : isTrajectory &&
                        draft.trajectory!.solversPerWave +
                          draft.trajectory!.explorersPerWave <
                          1
                      ? "At least one Solver or Explorer is required per round."
                      : isTrajectory &&
                          draft.trajectory!.solversPerWave +
                            draft.trajectory!.explorersPerWave >
                            8
                        ? "At most eight research trajectories may start per round."
                        : isTrajectory &&
                            (!Number.isSafeInteger(draft.trajectory!.verifiersPerClaim) ||
                              draft.trajectory!.verifiersPerClaim < 1 ||
                              draft.trajectory!.verifiersPerClaim > 8 ||
                              !Number.isSafeInteger(draft.trajectory!.passesRequired) ||
                              draft.trajectory!.passesRequired < 1 ||
                              draft.trajectory!.passesRequired > 8)
                          ? "Verification counts must be whole numbers from 1 to 8."
                          : isTrajectory &&
                              draft.trajectory!.passesRequired >
                                draft.trajectory!.verifiersPerClaim
                            ? "Required passes cannot exceed the number of independent checks."
                            : null;

  return (
    <div className="settings-view">
      <header className="settings-heading">
        <div>
          <span className="eyebrow">Project settings</span>
          <h1>Research configuration</h1>
        </div>
        <span className="badge">per project</span>
      </header>

      <p className="settings-intro">
        This is the project&apos;s effective saved configuration. One save records resource ceilings,
        {isTrajectory ? "trajectory counts" : "autonomy"}, Web search permission, and every model
        choice together. Process settings apply
        at the next launch; already-running work keeps its launch configuration.
      </p>

      {runningTasks > 0 ? (
        <div className="settings-notice" role="status">
          {runningTasks} research {runningTasks === 1 ? "assignment is" : "assignments are"} running
          now. Saving will not change {runningTasks === 1 ? "that process" : "those processes"}.
        </div>
      ) : null}

      <form className="settings-form" onSubmit={submit}>
        <section className="settings-panel" aria-labelledby="resource-settings-title">
          <div className="web-search-heading">
            <div>
              <h2 id="resource-settings-title">Research allowance</h2>
              <p>
                These are the effective project ceiling, per-trajectory limit, and maximum number
                of research rounds, including extensions made while continuing from an earlier
                report.
              </p>
            </div>
            <div className="resource-settings-grid">
              <label className="policy-choice">
                <span>Token ceiling</span>
                <input
                  className="input mono"
                  inputMode="numeric"
                  value={draft.totalTokens}
                  disabled={guard.disabled || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      totalTokens: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="policy-choice">
                <span>Solver/Explorer limit</span>
                <IntegerDraftInput
                  min={60_000}
                  max={Number.MAX_SAFE_INTEGER}
                  value={draftWorkerTokenLimit}
                  disabled={guard.disabled || saving}
                  onChange={(value) =>
                    setDraft((current) => ({ ...current, workerTokenLimit: value }))
                  }
                />
              </label>
              <label className="policy-choice">
                <span>Maximum rounds</span>
                <input
                  className="input mono"
                  inputMode="numeric"
                  value={draft.maxWaves}
                  disabled={guard.disabled || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      maxWaves: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </div>
          </div>
          <div className={`settings-help${resourceError === null ? "" : " settings-error"}`}>
            {resourceError ??
              `${spentTokens.toLocaleString("en-US")} tokens spent; each future Solver or Explorer may use up to ${draftWorkerTokenLimit.toLocaleString("en-US")} tokens, subject to the remaining project allowance; ${state.waveOrder.length} research rounds used.`}
          </div>
        </section>

        {isTrajectory && draft.trajectory !== undefined ? (
          <section className="settings-panel" aria-labelledby="trajectory-settings-title">
            <div className="web-search-heading">
              <div>
                <h2 id="trajectory-settings-title">Each research round</h2>
                <p>
                  Solvers pursue the stated problem; Explorers investigate useful nearby cases and
                  methods. A claim becomes a fact only after enough independent checks pass.
                </p>
              </div>
              <div className="resource-settings-grid">
                {(
                  [
                    ["solversPerWave", "Solvers (N)", 0],
                    ["explorersPerWave", "Explorers (M)", 0],
                    ["verifiersPerClaim", "Checks per claim (V)", 1],
                    ["passesRequired", "Passes required (W)", 1],
                  ] as const
                ).map(([key, label, min]) => (
                  <label className="policy-choice" key={key}>
                    <span>{label}</span>
                    <IntegerDraftInput
                      min={min}
                      max={8}
                      value={draft.trajectory![key]}
                      disabled={guard.disabled || saving}
                      onChange={(value) =>
                        setDraft((current) => ({
                          ...current,
                          trajectory: {
                            ...(current.trajectory ?? state.config.trajectory),
                            [key]: value,
                          },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-help">
              N + M may be at most 8. Verification runs independently while later research can
              continue; changing these values affects future rounds and newly proposed claims.
            </div>
          </section>
        ) : null}

        <section className="settings-panel web-search-panel" aria-labelledby="research-policy-title">
          <div className="web-search-heading">
            <div>
              <h2 id="research-policy-title">Research policy</h2>
              <p>
                {isTrajectory
                  ? "Choose whether future research trajectories and independent checks may search the literature."
                  : "Choose whether decisions execute automatically and whether the Research Manager may grant literature search to an individual future assignment."}
              </p>
            </div>
            <div className="project-policy-controls">
              {!isTrajectory ? <label className="policy-choice">
                <span>Autonomy</span>
                <select
                  className="select"
                  value={draft.autonomy}
                  disabled={guard.disabled || saving}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      autonomy: event.target.value === "gated" ? "gated" : "auto",
                    }))
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="gated">Gated</option>
                </select>
              </label> : null}
              <WebSearchPermissionControl
                enabled={draft.allowWebSearch}
                disabled={guard.disabled || saving}
                onChange={(enabled) =>
                  setDraft((current) => ({ ...current, allowWebSearch: enabled }))
                }
              />
            </div>
          </div>
          <div className="settings-help">
            {isTrajectory
              ? "When allowed, the initial W000 reader and each future Solver, Explorer, and Verifier may use Web search directly. Sources still need exact citations and mathematical checking. Turning it off does not alter work already running; the supplied materials remain W000's primary source."
              : "Search is not automatic: the Research Manager grants it assignment by assignment, and sources found that way still need exact citations and checking. Turning it off removes search from waiting assignments; running workers are unchanged. W000 remains an offline reading of the materials you supplied."}
          </div>
        </section>

        <section className="settings-panel">
          <datalist id="inventio-model-ids">
            {KNOWN_MODEL_IDS.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>

          <div className="model-settings-grid" role="table" aria-label="model settings">
          <div className="model-settings-header" role="row">
            <span role="columnheader">Role</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Reasoning</span>
          </div>

          {modelRoles.map((role) => {
            const info = MODEL_ROLE_INFO[role];
            const choice = draft.models[role] ?? state.config.models[role];
            return (
              <div className="model-settings-row" role="row" key={role}>
                <div className="model-role" role="rowheader">
                  <strong>{info.label}</strong>
                  <span>{info.description}</span>
                </div>
                <label className="model-choice" role="cell">
                  <span className="visually-hidden">{info.label} model</span>
                  <input
                    className="input mono"
                    list="inventio-model-ids"
                    value={choice.model ?? ""}
                    placeholder="Codex CLI default"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoComplete="off"
                    disabled={guard.disabled || saving}
                    onChange={(event) =>
                      update(role, { model: event.target.value === "" ? null : event.target.value })
                    }
                  />
                  <span className="model-effective">Effective: {effectiveModel(role, choice)}</span>
                </label>
                <label className="effort-choice" role="cell">
                  <span className="visually-hidden">{info.label} reasoning effort</span>
                  <select
                    className="select mono"
                    value={choice.effort}
                    disabled={guard.disabled || saving}
                    onChange={(event) =>
                      update(role, { effort: event.target.value as ReasoningEffort })
                    }
                  >
                    {REASONING_EFFORTS.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            );
          })}
          </div>

          <div className="settings-help">
            {isTrajectory
              ? "A blank model uses the Codex CLI default. The model field accepts custom Codex model IDs; availability and supported reasoning levels are checked when Codex launches."
              : <>A blank model uses the Codex CLI default, except Synthesizer, whose compatibility fallback is <code>gpt-5.6-terra</code>. The model field accepts custom Codex model IDs; availability and supported reasoning levels are checked when Codex launches.</>}
          </div>

          <footer className="settings-actions">
          <span className={`settings-dirty${dirty ? " changed" : ""}`}>
            {dirty ? "Unsaved changes" : "Saved"}
          </span>
          <button
            type="button"
            className="button ghost"
            disabled={guard.disabled || saving}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                models: defaultActiveModelSettings(state.config.workflow),
              }))
            }
          >
            Restore model defaults
          </button>
          <button
            type="button"
            className="button ghost"
            disabled={guard.disabled || saving || !dirty}
            onClick={() => setDraft(saved)}
          >
            Revert
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={guard.disabled || saving || !dirty || resourceError !== null}
            {...(guard.title === undefined ? {} : { title: guard.title })}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
          </footer>
        </section>
      </form>
    </div>
  );
}
