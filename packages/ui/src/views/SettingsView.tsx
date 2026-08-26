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
  defaultActiveModelSettings,
  sameModelSettings,
  type ActiveModelRole,
} from "../lib/modelSettings";
import { useActionGuard, useApiAction, useProjectState } from "../store/hooks";

function effectiveModel(role: ActiveModelRole, choice: ModelChoice): string {
  if (choice.model !== null) return choice.model;
  return role === "synthesizer" ? "gpt-5.6-terra (synthesis fallback)" : "Codex CLI default";
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
      saved.maxWaves === draft.maxWaves;
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
    saved.maxWaves !== draft.maxWaves;
  const spentTokens = state.budget.spentTokens + state.budget.plannerSpentTokens;
  const hasOpenRound = Object.values(state.waves).some((wave) => wave.status !== "closed");
  const resourceError =
    !Number.isSafeInteger(draft.totalTokens) || draft.totalTokens <= 0
      ? "The token ceiling must be a positive whole number."
      : draft.totalTokens < spentTokens
        ? `The token ceiling cannot be below ${spentTokens.toLocaleString("en-US")} tokens already spent.`
        : !Number.isSafeInteger(draft.maxWaves) || draft.maxWaves <= 0
          ? "The maximum number of rounds must be a positive whole number."
          : draft.maxWaves < state.waveOrder.length
            ? `The maximum cannot be below ${state.waveOrder.length} rounds already used.`
            : hasOpenRound &&
                (draft.totalTokens < saved.totalTokens || draft.maxWaves < saved.maxWaves)
              ? "Resource ceilings cannot be lowered while a research round is open."
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
        autonomy, Web search permission, and every model choice together. Process settings apply
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
                These are the effective token ceiling and maximum number of research rounds,
                including any extensions made while continuing from an earlier report.
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
              `${spentTokens.toLocaleString("en-US")} tokens spent; ${state.waveOrder.length} research rounds used.`}
          </div>
        </section>

        <section className="settings-panel web-search-panel" aria-labelledby="research-policy-title">
          <div className="web-search-heading">
            <div>
              <h2 id="research-policy-title">Research policy</h2>
              <p>
                Choose whether decisions execute automatically and whether the Research Manager
                may grant literature search to an individual future assignment.
              </p>
            </div>
            <div className="project-policy-controls">
              <label className="policy-choice">
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
              </label>
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
            Search is not automatic: the Research Manager grants it assignment by assignment,
            and sources found that way still need exact citations and checking. Turning it off
            removes search from waiting assignments; running workers are unchanged. W000 remains
            an offline reading of the materials you supplied.
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

          {ACTIVE_MODEL_ROLES.map((role) => {
            const info = MODEL_ROLE_INFO[role];
            const choice = draft.models[role];
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
            A blank model uses the Codex CLI default, except Synthesizer, whose compatibility
            fallback is <code>gpt-5.6-terra</code>. The model field accepts custom Codex model IDs;
            availability and supported reasoning levels are checked when Codex launches.
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
              setDraft((current) => ({ ...current, models: defaultActiveModelSettings() }))
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
