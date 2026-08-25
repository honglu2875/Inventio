import { describe, expect, it } from "vitest";
import { defaultConfig } from "@inventio/schema";
import {
  ACTIVE_MODEL_ROLES,
  activeModelSettings,
  defaultActiveModelSettings,
  sameModelSettings,
} from "../src/lib/modelSettings.js";

describe("project model settings", () => {
  it("exposes every user-selectable role but not legacy intake/planner keys", () => {
    expect(ACTIVE_MODEL_ROLES).toEqual([
      "researchManager",
      "solver",
      "explorer",
      "reviewer",
      "synthesizer",
    ]);
    expect(ACTIVE_MODEL_ROLES).not.toContain("intake");
    expect(ACTIVE_MODEL_ROLES).not.toContain("planner");
  });

  it("fills pre-settings project data from the current defaults", () => {
    const legacy = defaultConfig().models;
    const normalized = activeModelSettings({
      solver: legacy.solver,
      explorer: legacy.explorer,
      reviewer: legacy.reviewer,
      synthesizer: legacy.synthesizer,
      planner: legacy.planner,
    });
    expect(normalized.researchManager).toEqual({ model: "gpt-5.6-sol", effort: "max" });
  });

  it("returns detached defaults and detects changes by model or effort", () => {
    const a = defaultActiveModelSettings();
    const b = defaultActiveModelSettings();
    expect(a).not.toBe(b);
    expect(a.solver).not.toBe(b.solver);
    expect(sameModelSettings(a, b)).toBe(true);

    b.solver = { model: "gpt-5.6-sol", effort: "max" };
    expect(sameModelSettings(a, b)).toBe(false);
  });
});
