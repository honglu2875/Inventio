import { defaultConfig, initialState, type VerificationState } from "@inventio/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ArtifactTab from "../src/components/inspector/ArtifactTab";
import ClaimConflicts from "../src/components/ClaimConflicts";
import VerificationEvidence from "../src/components/VerificationEvidence";
import { useStore } from "../src/store/store";

// SSR uses Zustand's initial snapshot. Read the current store snapshot here
// so the real action guard can be exercised with both live and fixture state.
vi.mock("../src/store/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/store")>();
  return {
    ...actual,
    useStore: Object.assign(<T,>(selector: (state: ReturnType<typeof actual.useStore.getState>) => T) => selector(actual.useStore.getState()), actual.useStore),
  };
});

beforeEach(() => useStore.setState({ projects: {} }));
describe("mathematical evidence views", () => {
  it("shows unresolved disagreement and keeps fixture resolution controls read-only", () => {
    const state = initialState();
    state.claimConflicts.push({ leftClaimId: "K001", rightClaimId: "K002", reason: "The same residual is both zero and nonzero.", status: "OPEN", resolutionReason: null, recordedAtSeq: 1, resolvedAtSeq: null });
    const render = () => renderToStaticMarkup(<MemoryRouter><ClaimConflicts slug="test" state={state} /></MemoryRouter>);
    expect(render()).not.toContain("Record resolution");
    useStore.getState().resetSlot("test");
    useStore.getState().setConnection("test", "fixture");
    const html = render();
    expect(html).toContain("same residual");
    expect(html).toContain("Neither statement is refuted merely because its proof failed review");
    expect(html).not.toContain("Record resolution");
  });
  it("keeps a fact's current uncertainty visible when opening its graph inspector", () => {
    const state = initialState();
    state.config = defaultConfig();
    state.facts.F001 = {
      id: "F001", claimId: "K001", title: "A recorded value", statement: "D = 10/3",
      proofMarkdown: "Original derivation", path: "facts/F001.md", status: "ACTIVE",
      correctionClaimIds: [], retractedByClaimId: null, supersededByFactId: null, recordedAtSeq: 1,
    };
    state.factOrder.push("F001");
    // The recorded acceptance alone cannot replace its missing source proof.
    useStore.getState().setSnapshot("test", state);
    const html = renderToStaticMarkup(<ArtifactTab slug="test" nodeId="F001" kind="fact" />);
    expect(html).toContain("UNSETTLED");
    expect(html).toContain("source claim for F001 is missing");
    expect(html).toContain("Recorded proof");
    expect(html).not.toContain("Verified proof");
  });
  it("shows the original verdict and failed computational support independently", () => {
    const verification: VerificationState = {
      id: "V001", claimId: "K001", ordinal: 1, evidenceRequired: true, status: "completed", verdict: "FAIL", finding: "MISSING_DEPENDENCY", summaryMarkdown: "No computational confirmation.", artifactPath: null, usage: null, requestedAtSeq: 1, completedAtSeq: 3,
      executionEvidence: { path: "verifications/V001/execution-evidence.json", sha256: "0".repeat(64), capture: "COMPLETE", succeeded: 0, failed: 1, unfinished: 0, declaredBasis: "computation", declaredVerdict: "PASS", supportValidated: false, issues: ["The calculation did not finish successfully."] },
    };
    const html = renderToStaticMarkup(<VerificationEvidence slug="test" verification={verification} />);
    expect(html).toContain("0 succeeded, 1 failed");
    expect(html).toContain("original report declared PASS");
    expect(html).toContain("Successful execution alone does not establish mathematical correctness");
  });
});
