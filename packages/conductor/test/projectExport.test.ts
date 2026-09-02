import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_EXPORT_FORMAT_VERSION,
  initialState,
  type ProjectExportSnapshot,
} from "@inventio/schema";
import {
  readLastLines,
  renderStandaloneProjectHtml,
} from "../src/server/projectExport.js";

function snapshot(): ProjectExportSnapshot {
  const state = initialState();
  state.slug = "portable-example";
  state.title = "A $& <portable> $' example";
  state.statement =
    "A payload can contain </script>, $&, $`, and $' without altering the document.";
  return {
    formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    slug: state.slug,
    exportedAt: "2026-09-02T12:34:56.000Z",
    lastEventSeq: 0,
    state,
    events: [],
    artifacts: {},
    tasks: {},
    sources: {},
    omissions: [],
  };
}

describe("portable project HTML", () => {
  it("inlines the application, dynamic chunks, styles, fonts, and inert project data", () => {
    const uiDir = mkdtempSync(path.join(os.tmpdir(), "inventio-export-ui-"));
    mkdirSync(path.join(uiDir, "assets"), { recursive: true });
    writeFileSync(
      path.join(uiDir, "index.html"),
      '<!doctype html><html><head><title>Inventio</title><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>',
    );
    writeFileSync(
      path.join(uiDir, "assets", "app.js"),
      'const unsafe = "</script>"; const load = () => import("./chunk.js"); window.example = { unsafe, load };\n//# sourceMappingURL=app.js.map\n',
    );
    writeFileSync(path.join(uiDir, "assets", "chunk.js"), "export default 7;\n");
    writeFileSync(
      path.join(uiDir, "assets", "app.css"),
      '@font-face{font-family:Example;src:url("/assets/example.woff2")} body{font-family:Example}',
    );
    writeFileSync(path.join(uiDir, "assets", "example.woff2"), Buffer.from([0, 1, 2, 3]));

    const html = renderStandaloneProjectHtml(uiDir, snapshot());
    expect(html).toContain("data-inventio-export=\"true\"");
    expect(html).toContain("A $&amp; &lt;portable&gt; $' example — Inventio snapshot");
    expect(html).toContain("data:font/woff2;base64,AAECAw==");
    expect(html).toContain("data:text/javascript;base64,");
    expect(html).not.toContain('src="/assets/');
    expect(html).not.toContain('href="/assets/');
    expect(html).not.toContain("sourceMappingURL");
    expect(html).not.toContain('const unsafe = "</script>"');
    expect(html.match(/<body>/g)).toHaveLength(1);
    expect(html.match(/<\/html>/g)).toHaveLength(1);

    const data = /<script id="inventio-project-export" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(data).toBeDefined();
    const parsed = JSON.parse(data!) as ProjectExportSnapshot;
    expect(parsed.slug).toBe("portable-example");
    expect(parsed.state.statement).toBe(
      "A payload can contain </script>, $&, $`, and $' without altering the document.",
    );
  });

  it("reads only the requested tail of a long JSONL archive", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "inventio-export-tail-"));
    const file = path.join(dir, "events.jsonl");
    const lines = Array.from({ length: 1000 }, (_, index) => `${index}:${"x".repeat(200)}`);
    writeFileSync(file, lines.join("\n") + "\n");
    expect(readLastLines(file, 3)).toEqual(lines.slice(-3));
    expect(readLastLines(file, 0)).toEqual([]);
    expect(readLastLines(path.join(dir, "missing.jsonl"), 3)).toEqual([]);
  });
});
