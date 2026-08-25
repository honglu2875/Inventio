import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router-dom";
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
  const target = resolveNodeRoute(slug, nodeId);
  return <Navigate to={target.to} replace />;
}

export default function App(): JSX.Element {
  useThemeBootstrap();
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/p/:slug/node/:nodeId" element={<NodeResolver />} />
        <Route path="/p/:slug" element={<ProjectLayout />}>
          <Route index element={<OpsView />} />
          <Route path="manager" element={<ManagerView />} />
          <Route path="evidence" element={<EvidenceView />} />
          <Route path="library" element={<LibraryView />} />
          <Route path="library/:section" element={<LibraryView />} />
          <Route path="library/:section/:id" element={<LibraryView />} />
          <Route path="settings" element={<SettingsView />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
