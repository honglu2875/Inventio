import { z } from "zod";
import { SLUG_RE } from "./ids.js";

export const WorkerRole = z.enum(["solver", "explorer", "reviewer", "synthesizer"]);
export type WorkerRole = z.infer<typeof WorkerRole>;

export const RoleName = z.enum([
  "planner",
  "research_manager",
  "solver",
  "explorer",
  "reviewer",
  "synthesizer",
]);
export type RoleName = z.infer<typeof RoleName>;

export const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ModelChoice = z.object({
  /** null = use the account/CLI default model */
  model: z.string().nullable(),
  effort: ReasoningEffort,
});
export type ModelChoice = z.infer<typeof ModelChoice>;

/** Complete stored model map, including the legacy planner compatibility key. */
export const ProjectModels = z.object({
  /** Legacy intake/revision choice retained only so older project files replay. */
  intake: ModelChoice.default({ model: "gpt-5.6-sol", effort: "max" }),
  /** The single intellectual controller. */
  researchManager: ModelChoice.default({ model: "gpt-5.6-sol", effort: "max" }),
  /** Retained so project logs created before the Research Manager rename replay. */
  planner: ModelChoice,
  solver: ModelChoice,
  explorer: ModelChoice,
  reviewer: ModelChoice,
  synthesizer: ModelChoice,
});
export type ProjectModels = z.infer<typeof ProjectModels>;

/** User-editable roles. The legacy intake and planner keys are not exposed. */
export const ActiveModelSettings = ProjectModels.pick({
  researchManager: true,
  solver: true,
  explorer: true,
  reviewer: true,
  synthesizer: true,
});
export type ActiveModelSettings = z.infer<typeof ActiveModelSettings>;

/**
 * Project-wide choices that the owner may revise while a project exists.
 *
 * Keep this projection smaller than ProjectConfig: owner source collections,
 * task-level limits, and protocol constants have their own audited lifecycles.
 * These are the effective choices exposed at project creation or in Settings,
 * so they move together through one event-sourced boundary.
 */
export const ProjectSettings = z.object({
  models: ActiveModelSettings,
  autonomy: z.enum(["auto", "gated"]),
  allowWebSearch: z.boolean(),
  totalTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxWaves: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const SourceMount = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  path: z.string().min(1),
  note: z.string().default(""),
});
export type SourceMount = z.infer<typeof SourceMount>;

export const ProjectConfig = z.object({
  budget: z.object({
    totalTokens: z.number().int().positive(),
    defaultTaskTokens: z.number().int().positive(),
    taskWallClockMinutes: z.number().positive(),
    reserveFraction: z.number().min(0).max(0.9),
  }),
  /**
   * Research Manager defaults keep old logs replayable; `planner` is retained
   * only for compatibility with older project files and accounting names.
   */
  models: ProjectModels,
  autonomy: z.enum(["auto", "gated"]),
  /**
   * Whether the Research Manager may grant workers Codex's native web_search tool.
   * Defaults OFF: PROTOCOL §8 keeps workers off the network so that the only
   * sources entering a project are the ones the owner supplied, which keeps a
   * run reproducible and uncontaminated. Turn it on for literature-driven
   * research where checking a citation or a problem's open status matters.
   * Defaulted (not required) so projects created before it existed still load.
   */
  allowWebSearch: z.boolean().default(false),
  limits: z.object({
    maxWaves: z.number().int().positive(),
    maxRepairRounds: z.number().int().min(0),
    maxConcurrentWorkers: z.number().int().positive(),
  }),
  sourceMounts: z.array(SourceMount),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Detached user-editable settings projected from the effective config. */
export function projectSettingsFromConfig(config: ProjectConfig): ProjectSettings {
  return ProjectSettings.parse({
    models: config.models,
    autonomy: config.autonomy,
    allowWebSearch: config.allowWebSearch,
    totalTokens: config.budget.totalTokens,
    maxWaves: config.limits.maxWaves,
  });
}

export function defaultConfig(): ProjectConfig {
  return {
    budget: {
      totalTokens: 40_000_000,
      defaultTaskTokens: 1_500_000,
      taskWallClockMinutes: 30,
      reserveFraction: 0.25,
    },
    models: {
      intake: { model: "gpt-5.6-sol", effort: "max" },
      researchManager: { model: "gpt-5.6-sol", effort: "max" },
      planner: { model: null, effort: "high" },
      solver: { model: null, effort: "high" },
      explorer: { model: null, effort: "medium" },
      reviewer: { model: null, effort: "high" },
      synthesizer: { model: "gpt-5.6-terra", effort: "high" },
    },
    autonomy: "auto",
    allowWebSearch: false,
    limits: { maxWaves: 20, maxRepairRounds: 2, maxConcurrentWorkers: 3 },
    sourceMounts: [],
  };
}

export const ProjectIdentity = z.object({
  slug: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(300),
  createdAt: z.string(),
});
export type ProjectIdentity = z.infer<typeof ProjectIdentity>;
