import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ActiveModelSettings, ModelChoice, ReasoningEffort } from "@inventio/schema";
import { useProjectSlug } from "../components/ProjectContext";
import { api } from "../lib/api";
import {
  ACTIVE_MODEL_ROLES,
  KNOWN_MODEL_IDS,
  MODEL_ROLE_INFO,
  REASONING_EFFORTS,
  activeModelSettings,
  defaultActiveModelSettings,
  sameModelSettings,
  type ActiveModelRole,
} from "../lib/modelSettings";
import { useActionGuard, useApiAction, useProjectState } from "../store/hooks";

function effectiveModel(role: ActiveModelRole, choice: ModelChoice): string {
  if (choice.model !== null) return choice.model;
  return role === "synthesizer" ? "gpt-5.6-terra (synthesis fallback)" : "Codex CLI default";
}

export default function SettingsView(): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const storedModels = state?.config.models;
  const saved = useMemo(() => activeModelSettings(storedModels), [storedModels]);
  const savedWebSearch = state?.config.allowWebSearch ?? false;
  const [draft, setDraft] = useState<ActiveModelSettings>(saved);
  const [webSearch, setWebSearch] = useState(savedWebSearch);
  const [saving, setSaving] = useState(false);
  const [savingWebSearch, setSavingWebSearch] = useState(false);

  useEffect(() => {
    setDraft(saved);
  }, [slug, saved]);

  useEffect(() => {
    setWebSearch(savedWebSearch);
  }, [slug, savedWebSearch]);

  const update = (role: ActiveModelRole, patch: Partial<ModelChoice>): void => {
    setDraft((current) => ({
      ...current,
      [role]: { ...current[role], ...patch },
    }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (saving || guard.disabled || sameModelSettings(saved, draft)) return;
    setSaving(true);
    void run(() => api.setModelSettings(slug, draft), "Model settings saved")
      .then((result) => {
        if (result !== null) setDraft(result.models);
      })
      .finally(() => setSaving(false));
  };

  const saveWebSearch = (): void => {
    if (savingWebSearch || guard.disabled || webSearch === savedWebSearch) return;
    setSavingWebSearch(true);
    void run(
      () => api.setWebSearch(slug, webSearch),
      webSearch ? "Web search enabled for eligible future assignments" : "Web search disabled",
    ).finally(() => setSavingWebSearch(false));
  };

  if (state === null) {
    return (
      <div className="settings-view">
        <div className="skeleton-bar w90" aria-label="loading model settings" />
      </div>
    );
  }

  const runningTasks = Object.values(state.tasks).filter((task) => task.status === "running").length;
  const dirty = !sameModelSettings(saved, draft);
  const webSearchDirty = webSearch !== savedWebSearch;

  return (
    <div className="settings-view">
      <header className="settings-heading">
        <div>
          <span className="eyebrow">Project settings</span>
          <h1>Models and reasoning effort</h1>
        </div>
        <span className="badge">per project</span>
      </header>

      <p className="settings-intro">
        These choices are stored with this project. They apply when the next model process starts;
        already-running work keeps the model with which it was launched.
      </p>

      {runningTasks > 0 ? (
        <div className="settings-notice" role="status">
          {runningTasks} research {runningTasks === 1 ? "assignment is" : "assignments are"} running
          now. Saving will not change {runningTasks === 1 ? "that process" : "those processes"}.
        </div>
      ) : null}

      <section className="settings-panel web-search-panel" aria-labelledby="web-search-settings-title">
        <div className="web-search-heading">
          <div>
            <h2 id="web-search-settings-title">Web search</h2>
            <p>
              Allow the Research Manager to grant web search to individual future research
              assignments. Search is never automatic and anything found must be cited and checked.
            </p>
          </div>
          <label className="web-search-toggle">
            <input
              type="checkbox"
              checked={webSearch}
              disabled={guard.disabled || savingWebSearch}
              onChange={(event) => setWebSearch(event.target.checked)}
            />
            <span>{webSearch ? "Allowed" : "Not allowed"}</span>
          </label>
        </div>
        <div className="settings-help">
          Turning this off also removes search from assignments that are waiting to launch. A
          worker already running keeps its launch configuration. W000 remains an offline reading
          of the materials you supplied.
        </div>
        <footer className="settings-actions">
          <span className={`settings-dirty${webSearchDirty ? " changed" : ""}`}>
            {webSearchDirty ? "Unsaved change" : "Saved"}
          </span>
          <button
            type="button"
            className="button ghost"
            disabled={guard.disabled || savingWebSearch || !webSearchDirty}
            onClick={() => setWebSearch(savedWebSearch)}
          >
            Revert
          </button>
          <button
            type="button"
            className="button primary"
            disabled={guard.disabled || savingWebSearch || !webSearchDirty}
            {...(guard.title === undefined ? {} : { title: guard.title })}
            onClick={saveWebSearch}
          >
            {savingWebSearch ? "Saving…" : "Save search setting"}
          </button>
        </footer>
      </section>

      <form className="settings-panel" onSubmit={submit}>
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
            const choice = draft[role];
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
            onClick={() => setDraft(defaultActiveModelSettings())}
          >
            Restore defaults
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
            disabled={guard.disabled || saving || !dirty}
            {...(guard.title === undefined ? {} : { title: guard.title })}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </footer>
      </form>
    </div>
  );
}
