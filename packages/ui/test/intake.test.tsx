import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyEvent, defaultConfig, initialState, type ProjectState } from "@inventio/schema";
import IntakeConfirm from "../src/views/IntakeConfirm";

function awaitingW000(): ProjectState {
  const state = initialState();
  applyEvent(state, {
    seq: 1,
    ts: "created",
    type: "project.created",
    slug: "editable-intake",
    title: "Editable intake",
    statement: "Prove P.",
    contextMarkdown: "Try the geometric route.",
    config: defaultConfig(),
  });
  applyEvent(state, {
    seq: 2,
    ts: "intake",
    type: "phase.changed",
    from: "CREATED",
    to: "INTAKE",
    reason: "start",
  });
  applyEvent(state, {
    seq: 3,
    ts: "indexed",
    type: "intake.sourcesUpdated",
    sources: [{
      id: "S001",
      kind: "objective",
      title: "Original objective",
      relativePath: "intake/original-objective.md",
      size: 8,
      sha256: "0".repeat(64),
      abstract: "The owner asks for a proof of P.",
      excerptMarkdown: "Prove $P$.",
    }],
  });
  applyEvent(state, {
    seq: 4,
    ts: "complete",
    type: "intake.completed",
    problemMarkdown: "Prove P.",
    contextDigestMarkdown: "",
    rawMemories: [],
    ambiguities: [],
    clarifications: [],
  });
  applyEvent(state, {
    seq: 5,
    ts: "w000",
    type: "manager.noteRecorded",
    waveId: "W000",
    path: "artifacts/manager-notes/W000.md",
    markdown: "# Current mathematical view\n\nThe geometric route is plausible.",
    abstract: "The geometric route is the present starting point.",
    source: "research_manager",
  });
  applyEvent(state, {
    seq: 6,
    ts: "awaiting",
    type: "phase.changed",
    from: "INTAKE",
    to: "AWAITING_CONFIRMATION",
    reason: "ready",
  });
  return state;
}

describe("intake revision journey", () => {
  it("offers raw-input editing beside ordinary W000 regeneration", () => {
    const html = renderToStaticMarkup(<IntakeConfirm slug="editable-intake" state={awaitingW000()} />);
    expect(html).toContain("Edit raw input");
    expect(html).toContain("Regenerate from originals");
    expect(html).not.toContain("changed after this W000 was written");
  });

  it("prevents accepting a W000 made stale by a later raw revision", () => {
    const state = awaitingW000();
    applyEvent(state, {
      seq: 7,
      ts: "revised",
      type: "intake.rawUpdated",
      statement: "Prove P under hypothesis H.",
      contextMarkdown: "Use the corrected geometric route.",
      by: "human",
    });
    const html = renderToStaticMarkup(<IntakeConfirm slug="editable-intake" state={state} />);
    expect(html).toContain("changed after this W000 was written");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Accept W000 &amp; begin research<\/button>/);
  });
});
