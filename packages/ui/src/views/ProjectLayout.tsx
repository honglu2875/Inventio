import { useCallback, useEffect } from "react";
import { NavLink, Outlet, useParams, useSearchParams } from "react-router-dom";
import TopStrip from "../components/TopStrip";
import Toasts from "../components/Toasts";
import Inspector from "../components/inspector/Inspector";
import DirectiveDock from "../components/steering/DirectiveDock";
import GateCard from "../components/steering/GateCard";
import QuestionsToast from "../components/steering/QuestionsToast";
import { ProjectSlugContext } from "../components/ProjectContext";
import { connectProject } from "../store/connect";
import { startFixture } from "../store/fixtures";
import { useProjectState, useSlot } from "../store/hooks";
import { useStore } from "../store/store";

/**
 * Project chrome (UI-SPEC §6, §7, §12): top strip, view tabs, the steering
 * dock, the inspector slide-over and the modal surfaces. The connection —
 * live SSE or fixture replay — is owned here.
 */
export default function ProjectLayout(): JSX.Element {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const fixture = params.get("fixture");
  const sel = params.get("sel");
  const state = useProjectState(slug);
  const slot = useSlot(slug);
  const setSelection = useStore((s) => s.setSelection);

  useEffect(() => {
    if (slug === "") return;
    return fixture === null ? connectProject(slug) : startFixture(slug, fixture);
  }, [slug, fixture]);

  useEffect(() => {
    setSelection(sel === null ? null : { slug, nodeId: sel });
  }, [slug, sel, setSelection]);

  const closeInspector = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("sel");
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  useEffect(() => {
    if (sel === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeInspector();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, closeInspector]);

  const query = fixture === null ? "" : `?fixture=${encodeURIComponent(fixture)}`;

  return (
    <ProjectSlugContext.Provider value={slug}>
      <div className={`app${sel === null ? "" : " with-inspector"}`}>
        <TopStrip slug={slug} state={state} />
        <nav className="view-tabs">
          <NavLink end to={`/p/${slug}${query}`} className="view-tab">
            Research
          </NavLink>
          <NavLink to={`/p/${slug}/manager${query}`} className="view-tab">
            {state?.config.workflow === "trajectories-v2" ? "Summary" : "Manager"}
          </NavLink>
          <NavLink to={`/p/${slug}/evidence${query}`} className="view-tab">
            Evidence
          </NavLink>
          <NavLink to={`/p/${slug}/library${query}`} className="view-tab">
            Library
          </NavLink>
          <NavLink to={`/p/${slug}/settings${query}`} className="view-tab">
            Settings
          </NavLink>
          {slot?.lastError ? <span className="strip-error">{slot.lastError}</span> : null}
        </nav>
        <main className="content">
          <QuestionsToast slug={slug} />
          <div className="content-view">
            <Outlet />
          </div>
        </main>
        <DirectiveDock slug={slug} />
        {sel === null ? null : <Inspector slug={slug} nodeId={sel} onClose={closeInspector} />}
        {state?.openGateDecisionId ? (
          <GateCard slug={slug} decisionId={state.openGateDecisionId} />
        ) : null}
        <Toasts />
      </div>
    </ProjectSlugContext.Provider>
  );
}
