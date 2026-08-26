import { describe, expect, it } from "vitest";
import type { PublicationState } from "@inventio/schema";
import { publicationStatusText } from "../src/components/steering/PublicationStatusBar.js";
import { publicationPdfUrl } from "../src/lib/api.js";

function publication(over: Partial<PublicationState> = {}): PublicationState {
  return {
    id: "P001",
    decisionId: "DEC021",
    status: "ready",
    terminalResult: "PROVED",
    terminalFinalPath: "artifacts/final.md",
    terminalReachedAtSeq: 120,
    requestedAtSeq: 121,
    requestedBy: "human",
    kind: "research_report",
    result: "UNCERTAIN",
    title: "A partial result",
    assessment: "The final implication is not justified.",
    texPath: "publications/P001/manuscript.tex",
    pdfPath: "publications/P001/manuscript.pdf",
    logPath: "publications/P001/compile.log",
    compiler: "tectonic 0.16.0",
    failureStage: null,
    error: null,
    completedAtSeq: 130,
    ...over,
  };
}

describe("publication presentation", () => {
  it("warns plainly when the final reading cannot uphold an earlier proof", () => {
    expect(publicationStatusText(publication())).toContain("could not uphold the earlier PROVED result");
    expect(publicationStatusText(publication())).toContain("research report");
  });

  it("distinguishes drafting, local compilation, and an upheld preprint", () => {
    expect(publicationStatusText(publication({ status: "drafting" }))).toContain("drafting");
    expect(publicationStatusText(publication({ status: "compiling" }))).toContain("compiled locally");
    expect(
      publicationStatusText(
        publication({ kind: "preprint", result: "DISPROVED", terminalResult: "DISPROVED" }),
      ),
    ).toBe("The final mathematical review upheld the DISPROVED result.");
  });

  it("uses the confined project publication endpoint for downloads", () => {
    expect(publicationPdfUrl("a project", "P001")).toBe(
      "/api/projects/a%20project/publications/P001/pdf",
    );
  });
});
