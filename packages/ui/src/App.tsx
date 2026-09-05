import RecurrentView from "./views/RecurrentView";
import ResearchSettings from "./views/ResearchSettings";
import { useProjectSlug } from "./components/ProjectContext";
import { useProjectState } from "./store/hooks";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
import { hasProjectExportPayload, projectExportSnapshot } from "./lib/projectExport";
import { resolveNodeRoute } from "./lib/selection";
import { useStore } from "./store/store";
import ProjectsPage from "./views/ProjectsPage";
import ProjectLayout from "./views/ProjectLayout";
import OpsView from "./views/OpsView";
import EvidenceView from "./views/EvidenceView";
import LibraryView from "./views/LibraryView";
import ManagerView from "./views/ManagerView";
import SettingsView from "./views/SettingsView";

/** `data-theme` on <html>; "system" follows prefers-color-scheme live (§2). */
function useThemeBootstrap(): void {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = (): void => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      root.setAttribute("data-theme", resolved);
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

/** `/p/:slug/node/:nodeId` → the owning view with the inspector open (§4). */
function NodeResolver(): JSX.Element {
  const { slug = "", nodeId = "" } = useParams();
  const state = useProjectState(slug);
  const target = state?.config.workflow === "recurrent-v3" ? { to: `/p/${encodeURIComponent(slug)}/evidence?sel=${encodeURIComponent(nodeId)}` } : resolveNodeRoute(slug, nodeId);
  return <Navigate to={target.to} replace />;
}

function WorkflowView({ mode, children }: { mode: "map" | "summary" | "library" | "settings"; children: ReactNode }): JSX.Element {
  const slug = useProjectSlug();
  const state = useProjectState(slug);
  if (state?.config.workflow !== "recurrent-v3") return <>{children}</>;
  if (mode === "settings") return <ResearchSettings key={slug} state={state} />;
  if (mode === "map" && ["CREATED", "INTAKE", "AWAITING_CONFIRMATION"].includes(state.phase)) return <OpsView />;
  return <RecurrentView state={state} mode={mode} />;
}

export default function App(): JSX.Element {
  useThemeBootstrap();
  const exported = projectExportSnapshot();
  if (exported === null && hasProjectExportPayload()) {
    return (
      <main className="projects-page">
        <section className="banner danger" role="alert">
          <h1>Snapshot could not be opened</h1>
          <p>
            The embedded project record is incomplete or damaged. Export the project again from
            the current Inventio application.
          </p>
        </section>
      </main>
    );
  }
  const Router = exported === null ? BrowserRouter : HashRouter;
  const projectRoot = exported === null ? "/" : `/p/${exported.slug}`;
  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={exported === null ? <ProjectsPage /> : <Navigate to={projectRoot} replace />}
        />
        <Route path="/p/:slug/node/:nodeId" element={<NodeResolver />} />
        <Route path="/p/:slug" element={<ProjectLayout />}>
          <Route index element={<WorkflowView mode="map"><OpsView /></WorkflowView>} />
          <Route path="manager" element={<WorkflowView mode="summary"><ManagerView /></WorkflowView>} />
          <Route path="evidence" element={<WorkflowView mode="map"><EvidenceView /></WorkflowView>} />
          <Route path="library" element={<WorkflowView mode="library"><LibraryView /></WorkflowView>} />
          <Route path="library/:section" element={<WorkflowView mode="library"><LibraryView /></WorkflowView>} />
          <Route path="library/:section/:id" element={<WorkflowView mode="library"><LibraryView /></WorkflowView>} />
          {exported === null ? <Route path="settings" element={<WorkflowView mode="settings"><SettingsView /></WorkflowView>} /> : null}
        </Route>
        <Route path="*" element={<Navigate to={projectRoot} replace />} />
      </Routes>
    </Router>
  );
}
