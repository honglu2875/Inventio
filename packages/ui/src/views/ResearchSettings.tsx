import { useState } from "react";
import { defaultRecurrentConfig, projectSettingsFromConfig, type ProjectState, type ReasoningEffort } from "@inventio/schema";
import { api } from "../lib/api";
import { REASONING_EFFORTS } from "../lib/modelSettings";
import { useActionGuard, useApiAction } from "../store/hooks";
export default function ResearchSettings({ state }: { state: ProjectState }): JSX.Element {
  const [draft, setDraft] = useState(() => projectSettingsFromConfig(state.config));
  const [models, setModels] = useState(state.config.researchModels ?? defaultRecurrentConfig().researchModels!);
  const guard = useActionGuard(state.slug); const run = useApiAction();
  return <div className="recurrent-reading"><h2>Research settings</h2><p>Each round has one long Solver and Explorer. Support verification returns objections to the originating author; a strong independent audit checks all established mathematics from round two. Model choices are preserved for each conversation.</p><form onSubmit={e => { e.preventDefault(); if (!guard.disabled) void run(() => api.setProjectSettings(state.slug, { ...draft, researchModels: models })); }}>
    {(["research", "support"] as const).map(role => <fieldset key={role}><legend>{role === "research" ? "Research model · Solver, Explorer, audit, final report" : "Support model · verification and round summaries"}</legend><label className="field"><span>Model ID</span><input className="input" required value={models[role].model ?? ""} onChange={e => setModels(m => ({ ...m, [role]: { ...m[role], model: e.target.value } }))} /></label><label className="field"><span>Reasoning effort</span><select className="input" value={models[role].effort} onChange={e => setModels(m => ({ ...m, [role]: { ...m[role], effort: e.target.value as ReasoningEffort } }))}>{REASONING_EFFORTS.map(value => <option key={value}>{value}</option>)}</select></label></fieldset>)}
    {(["totalTokens", "workerTokenLimit", "maxWaves"] as const).map(key => <label className="field" key={key}><span>{key === "totalTokens" ? "Project token allowance" : key === "workerTokenLimit" ? "Long-session token target" : "Maximum rounds"}</span><input className="input mono" type="number" min={key === "workerTokenLimit" ? 60000 : 1} required value={draft[key] ?? state.config.budget.defaultTaskTokens} onChange={e => setDraft(d => ({ ...d, [key]: Number(e.target.value) }))} /></label>)}
    <label><input type="checkbox" checked={draft.allowWebSearch} onChange={e => setDraft(d => ({ ...d, allowWebSearch: e.target.checked }))} /> Allow web search</label><p><button className="button primary" disabled={guard.disabled}>Save settings</button></p>
  </form></div>;
}
