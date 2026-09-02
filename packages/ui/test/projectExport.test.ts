import { describe, expect, it } from "vitest";
import {
  PROJECT_EXPORT_FORMAT_VERSION,
  initialState,
  type ProjectExportSnapshot,
} from "@inventio/schema";
import { exportedText, parseProjectExport } from "../src/lib/projectExport";

function payload(): ProjectExportSnapshot {
  const state = initialState();
  state.slug = "sample";
  state.title = "Sample";
  return {
    formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    slug: "sample",
    exportedAt: "2026-09-02T00:00:00.000Z",
    lastEventSeq: 0,
    state,
    events: [],
    artifacts: {},
    tasks: {},
    sources: {},
    omissions: [],
  };
}

describe("project export bootstrap", () => {
  it("accepts the current portable format and rejects malformed data", () => {
    expect(parseProjectExport(JSON.stringify(payload()))?.slug).toBe("sample");
    expect(parseProjectExport("not JSON")).toBeNull();
    expect(parseProjectExport('{"formatVersion":999}')).toBeNull();
    expect(parseProjectExport(JSON.stringify({ ...payload(), sources: undefined }))).toBeNull();
    expect(parseProjectExport(JSON.stringify({ ...payload(), omissions: null }))).toBeNull();
  });

  it("returns included text and explains an omitted file", () => {
    expect(exportedText({ included: true, size: 4, mediaType: "text/plain", text: "test" }))
      .toBe("test");
    expect(() => exportedText({ included: false, size: 12, reason: "binary file" }))
      .toThrow("binary file");
  });
});
