import { z } from "zod";

export const VerificationEvidenceDeclaration = z.object({
  basis: z.enum(["derivation", "computation", "both"]),
  supportingCommands: z.array(z.string().min(1).max(20_000)).max(8),
});
export type VerificationEvidenceDeclaration = z.infer<typeof VerificationEvidenceDeclaration>;

export const CommandExecutionRecord = z.object({
  ref: z.string(),
  command: z.string(),
  commandTruncated: z.boolean(),
  exitCode: z.number().int().nullable(),
  status: z.enum(["SUCCEEDED", "FAILED", "UNFINISHED"]),
  outputSha256: z.string().nullable(),
  outputExcerpt: z.string(),
});
export type CommandExecutionRecord = z.infer<typeof CommandExecutionRecord>;

export const VerificationExecutionRecord = z.object({
  version: z.literal(1),
  capture: z.enum(["COMPLETE", "INCOMPLETE", "UNAVAILABLE"]),
  commands: z.array(CommandExecutionRecord),
});
export type VerificationExecutionRecord = z.infer<typeof VerificationExecutionRecord>;

export const VerificationEvidenceSummary = z.object({
  path: z.string(),
  sha256: z.string(),
  capture: VerificationExecutionRecord.shape.capture,
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unfinished: z.number().int().nonnegative(),
  declaredBasis: VerificationEvidenceDeclaration.shape.basis.nullable(),
  declaredVerdict: z.enum(["PASS", "FAIL"]),
  supportValidated: z.boolean().nullable(),
  issues: z.array(z.string()),
});
export type VerificationEvidenceSummary = z.infer<typeof VerificationEvidenceSummary>;
