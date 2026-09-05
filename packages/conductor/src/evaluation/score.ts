import { usageSpend, type VerificationState } from "@inventio/schema";
import { z } from "zod";

export const EvaluationManifest = z.object({
  version: z.literal(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    variant: z.string().min(1),
    eventsFile: z.string().min(1),
    verificationId: z.string().regex(/^V\d+$/),
    label: z.enum(["VALID_PROOF", "INVALID_PROOF", "INCOMPLETE_PROOF", "UNLABELLED"]),
  })).min(1),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  const records = new Set<string>();
  for (const entry of value.cases) {
    if (ids.has(entry.id)) context.addIssue({ code: "custom", message: `duplicate case id ${entry.id}` });
    ids.add(entry.id);
    const key = `${entry.eventsFile}\0${entry.verificationId}\0${entry.variant}`;
    if (records.has(key)) context.addIssue({ code: "custom", message: `duplicate verification in variant ${entry.variant}` });
    records.add(key);
  }
});
export type EvaluationManifest = z.infer<typeof EvaluationManifest>;
export type EvaluationRow = Pick<EvaluationManifest["cases"][number], "id" | "variant" | "label"> & { verification: VerificationState; };

export function scoreVerifications(rows: EvaluationRow[]) {
  const summarize = (entries: EvaluationRow[]) => {
    const invalid = entries.filter(row => row.label === "INVALID_PROOF" || row.label === "INCOMPLETE_PROOF");
    const valid = entries.filter(row => row.label === "VALID_PROOF");
    const decided = entries.filter(row => row.verification.verdict === "PASS" || row.verification.verdict === "FAIL");
    const falseAccepts = invalid.filter(row => row.verification.verdict === "PASS").length;
    const falseRejects = valid.filter(row => row.verification.verdict === "FAIL").length;
    const unknownUsage = entries.filter(row => row.verification.usage === null).length;
    const observedTokens = entries.reduce((sum, row) => sum + (row.verification.usage ? usageSpend(row.verification.usage) : 0), 0);
    return {
      checks: entries.length,
      labelledChecks: entries.filter(row => row.label !== "UNLABELLED").length,
      decided: decided.length,
      abstentions: entries.length - decided.length,
      falseAcceptance: { count: falseAccepts, denominator: invalid.length, rate: invalid.length ? falseAccepts / invalid.length : null },
      falseRejection: { count: falseRejects, denominator: valid.length, rate: valid.length ? falseRejects / valid.length : null },
      falseAcceptanceByLabel: Object.fromEntries(["INVALID_PROOF", "INCOMPLETE_PROOF"].map(label => {
        const cases = entries.filter(row => row.label === label);
        const count = cases.filter(row => row.verification.verdict === "PASS").length;
        return [label, { count, denominator: cases.length, rate: cases.length ? count / cases.length : null }];
      })),
      failedEvidenceChecks: entries.filter(row => row.verification.executionEvidence?.supportValidated === false).length,
      unauditedChecks: entries.filter(row => row.verification.executionEvidence?.supportValidated == null).length,
      observedTokens,
      missingUsage: unknownUsage,
      meanTokens: unknownUsage === 0 && entries.length ? observedTokens / entries.length : null,
      findings: Object.fromEntries([...new Set(entries.map(row => row.verification.finding ?? "UNRECORDED"))].sort().map(finding =>
        [finding, entries.filter(row => (row.verification.finding ?? "UNRECORDED") === finding).length],
      )),
    };
  };
  return {
    metric: "Verification decisions; labels assess the submitted proof, not merely whether its conclusion is true. Error/null verdicts are abstentions. Rate denominators include labelled abstentions; compare decision coverage alongside the rates. Usage is uncached input plus output, not dollar cost.",
    total: summarize(rows),
    variants: Object.fromEntries([...new Set(rows.map(row => row.variant))].sort().map(variant =>
      [variant, summarize(rows.filter(row => row.variant === variant))],
    )),
  };
}
