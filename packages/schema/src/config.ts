import { z } from "zod";
import { SLUG_RE } from "./ids.js";

export const WorkerRole = z.enum(["solver", "explorer", "verifier", "reviewer", "synthesizer"]);
export type WorkerRole = z.infer<typeof WorkerRole>;

/**
 * Workflow is explicit so an old event log is never reinterpreted by a newer
 * engine. Configurations written before this field existed parse as council-v1.
 */
export const WorkflowVersion = z.enum(["council-v1", "trajectories-v2", "recurrent-v3"]);
export type WorkflowVersion = z.infer<typeof WorkflowVersion>;

export const RoleName = z.enum([
  "planner",
  "research_manager",
  "summary_reader",
  "solver",
  "explorer",
  "verifier",
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
  /** End-of-round editor in trajectories-v2; it does not choose research work. */
  summaryReader: ModelChoice.default({ model: "gpt-5.6-sol", effort: "max" }),
  /** Retained so project logs created before the Research Manager rename replay. */
  planner: ModelChoice,
  solver: ModelChoice,
  explorer: ModelChoice,
  verifier: ModelChoice.default({ model: "gpt-5.6-sol", effort: "max" }),
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
}).extend({
  /** Optional on the wire so settings events written before v2 remain valid. */
  summaryReader: ModelChoice.optional(),
  verifier: ModelChoice.optional(),
});
export type ActiveModelSettings = z.infer<typeof ActiveModelSettings>;

/**
 * Project-wide choices that the owner may revise while a project exists.
 *
 * Keep this projection smaller than ProjectConfig: owner source collections
 * and protocol constants have their own audited lifecycles. These are the
 * effective choices exposed in Settings, so they move together through one
 * event-sourced boundary.
 */
export const ProjectSettings = z.object({
  researchModels: z.object({ research: ModelChoice, support: ModelChoice }).optional(),
  models: ActiveModelSettings,
  autonomy: z.enum(["auto", "gated"]),
  allowWebSearch: z.boolean(),
  totalTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Optional only so settings events written before this field existed replay. */
  workerTokenLimit: z.number().int().min(60_000).max(Number.MAX_SAFE_INTEGER).optional(),
  maxWaves: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  trajectory: z
    .object({
      solversPerWave: z.number().int().min(0).max(8),
      explorersPerWave: z.number().int().min(0).max(8),
      verifiersPerClaim: z.number().int().min(1).max(8),
      passesRequired: z.number().int().min(1).max(8),
    })
    .superRefine((value, ctx) => {
      if (value.solversPerWave + value.explorersPerWave < 1) {
        ctx.addIssue({ code: "custom", message: "at least one Solver or Explorer is required" });
      }
      if (value.solversPerWave + value.explorersPerWave > 8) {
        ctx.addIssue({ code: "custom", message: "at most eight research trajectories may start per round" });
      }
      if (value.passesRequired > value.verifiersPerClaim) {
        ctx.addIssue({ code: "custom", message: "passesRequired cannot exceed verifiersPerClaim" });
      }
    })
    .optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const SourceMount = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  path: z.string().min(1),
  note: z.string().default(""),
});
export type SourceMount = z.infer<typeof SourceMount>;

export const ProjectConfig = z.object({
  researchModels: z.object({ research: ModelChoice, support: ModelChoice }).optional(),
  workflow: WorkflowVersion.default("council-v1"),
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
  trajectory: z
    .object({
      solversPerWave: z.number().int().min(0).max(8),
      explorersPerWave: z.number().int().min(0).max(8),
      verifiersPerClaim: z.number().int().min(1).max(8),
      passesRequired: z.number().int().min(1).max(8),
    })
    .superRefine((value, ctx) => {
      if (value.solversPerWave + value.explorersPerWave < 1) {
        ctx.addIssue({ code: "custom", message: "at least one Solver or Explorer is required" });
      }
      if (value.solversPerWave + value.explorersPerWave > 8) {
        ctx.addIssue({ code: "custom", message: "at most eight research trajectories may start per round" });
      }
      if (value.passesRequired > value.verifiersPerClaim) {
        ctx.addIssue({ code: "custom", message: "passesRequired cannot exceed verifiersPerClaim" });
      }
    })
    .default({
      solversPerWave: 2,
      explorersPerWave: 2,
      verifiersPerClaim: 2,
      passesRequired: 2,
    }),
  sourceMounts: z.array(SourceMount),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Detached user-editable settings projected from the effective config. */
export function projectSettingsFromConfig(config: ProjectConfig): ProjectSettings {
  return ProjectSettings.parse({
    models: config.models,
    researchModels: config.researchModels,
    autonomy: config.autonomy,
    allowWebSearch: config.allowWebSearch,
    totalTokens: config.budget.totalTokens,
    workerTokenLimit: config.budget.defaultTaskTokens,
    maxWaves: config.limits.maxWaves,
    trajectory: config.trajectory,
  });
}

export function defaultConfig(): ProjectConfig {
  return {
    workflow: "council-v1",
    budget: {
      totalTokens: 40_000_000,
      defaultTaskTokens: 1_500_000,
      taskWallClockMinutes: 30,
      reserveFraction: 0.25,
    },
    models: {
      intake: { model: "gpt-5.6-sol", effort: "max" },
      researchManager: { model: "gpt-5.6-sol", effort: "max" },
      summaryReader: { model: "gpt-5.6-sol", effort: "max" },
      planner: { model: null, effort: "high" },
      solver: { model: null, effort: "high" },
      explorer: { model: null, effort: "medium" },
      verifier: { model: "gpt-5.6-sol", effort: "max" },
      reviewer: { model: null, effort: "high" },
      synthesizer: { model: "gpt-5.6-terra", effort: "high" },
    },
    autonomy: "auto",
    allowWebSearch: false,
    limits: { maxWaves: 20, maxRepairRounds: 2, maxConcurrentWorkers: 3 },
    trajectory: {
      solversPerWave: 2,
      explorersPerWave: 2,
      verifiersPerClaim: 2,
      passesRequired: 2,
    },
    sourceMounts: [],
  };
}

/** Historical trajectory defaults for archive fixtures; new runs use
 * defaultRecurrentConfig(). */
export function defaultTrajectoryConfig(): ProjectConfig {
  const legacy = defaultConfig();
  return ProjectConfig.parse({
    ...legacy,
    workflow: "trajectories-v2",
    budget: {
      ...legacy.budget,
      totalTokens: 80_000_000,
      defaultTaskTokens: 2_000_000,
      taskWallClockMinutes: 120,
      reserveFraction: 0.1,
    },
    models: {
      ...legacy.models,
      solver: { model: "gpt-5.6-sol", effort: "max" },
      explorer: { model: "gpt-5.6-sol", effort: "max" },
      verifier: { model: "gpt-5.6-sol", effort: "max" },
      summaryReader: { model: "gpt-5.6-sol", effort: "max" },
    },
    allowWebSearch: true,
    limits: { ...legacy.limits, maxWaves: 5, maxConcurrentWorkers: 8 },
  });
}

export const ProjectIdentity = z.object({
  slug: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(300),
  createdAt: z.string(),
});
export type ProjectIdentity = z.infer<typeof ProjectIdentity>;

/** New runs pin two choices; each round always has one Solver and Explorer. */
export function defaultRecurrentConfig(): ProjectConfig {
  const base = defaultTrajectoryConfig();
  return ProjectConfig.parse({
    ...base, workflow: "recurrent-v3",
    researchModels: { research: base.models.solver, support: { model: "gpt-5.6-terra", effort: "high" } },
    limits: { ...base.limits, maxConcurrentWorkers: 4 },
    trajectory: { solversPerWave: 1, explorersPerWave: 1, verifiersPerClaim: 1, passesRequired: 1 },
  });
}
