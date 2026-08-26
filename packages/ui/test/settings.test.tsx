import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebSearchPermissionControl } from "../src/views/SettingsView";

describe("project settings", () => {
  it("visibly selects the saved Not allowed Web-search state", () => {
    const html = renderToStaticMarkup(
      <WebSearchPermissionControl enabled={false} disabled={false} onChange={() => {}} />,
    );
    const allowed = html.match(/<input[^>]*value="allowed"[^>]*>/)?.[0] ?? "";
    const notAllowed = html.match(/<input[^>]*value="not-allowed"[^>]*>/)?.[0] ?? "";

    expect(notAllowed).toContain('checked=""');
    expect(allowed).not.toContain('checked=""');
    expect(html).toContain("Not allowed");
  });

  it("visibly selects the saved Allowed Web-search state", () => {
    const html = renderToStaticMarkup(
      <WebSearchPermissionControl enabled={true} disabled={false} onChange={() => {}} />,
    );
    const allowed = html.match(/<input[^>]*value="allowed"[^>]*>/)?.[0] ?? "";
    const notAllowed = html.match(/<input[^>]*value="not-allowed"[^>]*>/)?.[0] ?? "";

    expect(allowed).toContain('checked=""');
    expect(notAllowed).not.toContain('checked=""');
  });
});
