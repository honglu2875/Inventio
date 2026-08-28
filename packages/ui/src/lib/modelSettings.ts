import {
  defaultConfig,
  defaultTrajectoryConfig,
  type ActiveModelSettings,
  type ModelChoice,
  type ProjectModels,
  type ReasoningEffort,
} from "@inventio/schema";

export const ACTIVE_MODEL_ROLES = [
  "researchManager",
  "solver",
  "explorer",
  "reviewer",
  "synthesizer",
] as const satisfies readonly (keyof ActiveModelSettings)[];

export const TRAJECTORY_MODEL_ROLES = [
  "summaryReader",
  "solver",
  "explorer",
  "verifier",
] as const satisfies readonly (keyof ActiveModelSettings)[];

export type ActiveModelRole =
  | (typeof ACTIVE_MODEL_ROLES)[number]
  | (typeof TRAJECTORY_MODEL_ROLES)[number];

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningEffort[];

/** Suggestions only: the text field also accepts any model ID known to Codex. */
export const KNOWN_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
] as const;

export const MODEL_ROLE_INFO: Record<
  ActiveModelRole,
  { label: string; description: string }
> = {
  researchManager: {
    label: "Research Manager",
    description: "Chooses directions, assesses completed rounds, and maintains the current view.",
  },
  summaryReader: {
    label: "Summary reader",
    description: "Makes at most a small end-of-round edit to the current mathematical view.",
  },
  solver: {
    label: "Solver",
    description: "Develops an independent proof or counterexample attempt.",
  },
  explorer: {
    label: "Explorer",
    description: "Tests examples, searches nearby ideas, and identifies obstructions.",
  },
  verifier: {
    label: "Verifier",
    description: "Independently checks one self-contained claim and alleged proof.",
  },
  reviewer: {
    label: "Reviewer",
    description: "Checks a fixed candidate independently and adversarially.",
  },
  synthesizer: {
    label: "Synthesizer",
    description: "Assembles established ingredients without inventing a missing step.",
  },
};

function copyChoice(value: ModelChoice): ModelChoice {
  return { model: value.model, effort: value.effort };
}

/** Detached active settings using defaults for pre-settings project fixtures. */
export function activeModelSettings(
  models: Partial<ProjectModels> | null | undefined,
): ActiveModelSettings {
  const defaults = defaultConfig().models;
  return {
    researchManager: copyChoice(models?.researchManager ?? defaults.researchManager),
    summaryReader: copyChoice(models?.summaryReader ?? defaults.summaryReader),
    solver: copyChoice(models?.solver ?? defaults.solver),
    explorer: copyChoice(models?.explorer ?? defaults.explorer),
    verifier: copyChoice(models?.verifier ?? defaults.verifier),
    reviewer: copyChoice(models?.reviewer ?? defaults.reviewer),
    synthesizer: copyChoice(models?.synthesizer ?? defaults.synthesizer),
  };
}

export function defaultActiveModelSettings(
  workflow: "council-v1" | "trajectories-v2" = "council-v1",
): ActiveModelSettings {
  const defaults = workflow === "trajectories-v2" ? defaultTrajectoryConfig() : defaultConfig();
  return activeModelSettings(defaults.models);
}

export function sameModelSettings(a: ActiveModelSettings, b: ActiveModelSettings): boolean {
  const roles = [...new Set([...ACTIVE_MODEL_ROLES, ...TRAJECTORY_MODEL_ROLES])];
  const defaults = defaultConfig().models;
  return roles.every((role) => {
    const left = a[role] ?? defaults[role];
    const right = b[role] ?? defaults[role];
    return left.model === right.model && left.effort === right.effort;
  });
}
