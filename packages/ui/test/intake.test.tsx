import { applyEvent, defaultTrajectoryConfig, initialState, type ProjectState } from "@inventio/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import TopStrip from "../src/components/TopStrip";
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
    config: defaultTrajectoryConfig(),
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
    type: "summary.recorded",
    changed: true,
    reason: "Initial reading",
    usage: null,
    waveId: "W000",
    path: "artifacts/mathematical-view/W000.md",
    markdown: "# Current mathematical view\n\nThe geometric route is plausible.",
    abstract: "The geometric route is the present starting point.",
    source: "intake",
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
  it("keeps an unfinished council intake view-only while allowing export and a fresh project", () => {
    const state = awaitingW000();
    state.config.workflow = "council-v1";
    const intake = renderToStaticMarkup(<IntakeConfirm slug={state.slug} state={state} />);
    expect(intake).toContain("Original objective");
    expect(intake).not.toContain("Edit raw input");
    expect(intake).not.toContain("Regenerate from originals");
    expect(intake).not.toContain("Accept W000");
    const strip = renderToStaticMarkup(
      <MemoryRouter><TopStrip slug={state.slug} state={state} /></MemoryRouter>,
    );
    expect(strip).toContain("Legacy archive · view-only");
    expect(strip).toContain("Export HTML");
    expect(strip).toContain("Fresh start");
    expect(strip).not.toMatch(/>(?:Pause|Resume|Continue research|Prepare paper)</);
  });

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

  it("keeps W000 controls locked from event state when regeneration outlives the page", () => {
    const state = awaitingW000();
    applyEvent(state, {
      seq: 7,
      ts: "regenerating",
      type: "decision.requested",
      decisionId: "DEC001",
      kind: "intake",
      waveId: null,
    });

    // Static rendering deliberately creates a fresh component. This is the
    // regression case: navigation, refresh, or another browser has no local
    // `regenerating` hook state and must still honor the server-side call.
    const html = renderToStaticMarkup(<IntakeConfirm slug="editable-intake" state={state} />);
    expect(html).toContain("The original materials are being read again to regenerate W000");
    expect(html).toContain("Regenerating…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Accept W000 &amp; begin research<\/button>/);
    expect(html).toMatch(/<textarea[^>]*disabled=""[^>]*aria-label="W000 abstract"/);
  });
});
