import {
  defaultConfig,
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

export type ActiveModelRole = (typeof ACTIVE_MODEL_ROLES)[number];

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
  solver: {
    label: "Solver",
    description: "Develops an independent proof or counterexample attempt.",
  },
  explorer: {
    label: "Explorer",
    description: "Tests examples, searches nearby ideas, and identifies obstructions.",
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
    solver: copyChoice(models?.solver ?? defaults.solver),
    explorer: copyChoice(models?.explorer ?? defaults.explorer),
    reviewer: copyChoice(models?.reviewer ?? defaults.reviewer),
    synthesizer: copyChoice(models?.synthesizer ?? defaults.synthesizer),
  };
}

export function defaultActiveModelSettings(): ActiveModelSettings {
  return activeModelSettings(defaultConfig().models);
}

export function sameModelSettings(a: ActiveModelSettings, b: ActiveModelSettings): boolean {
  return ACTIVE_MODEL_ROLES.every(
    (role) => a[role].model === b[role].model && a[role].effort === b[role].effort,
  );
}
