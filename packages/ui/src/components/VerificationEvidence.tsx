import type { VerificationExecutionRecord, VerificationState } from "@inventio/schema";
import { useState } from "react";
import { api, errorMessage } from "../lib/api";

export default function VerificationEvidence({ slug, verification }: { slug: string; verification: VerificationState; }): JSX.Element {
  const [record, setRecord] = useState<VerificationExecutionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = verification.executionEvidence;
  if (!summary) return <p className="small muted">No execution audit was recorded for this check.</p>;
  return (
    <details className="banner" onToggle={(event) => {
      if (!event.currentTarget.open || record || error) return;
      void api.verificationEvidence(slug, verification.id).then(setRecord).catch((error: unknown) => setError(errorMessage(error)));
    }}>
      <summary>Recorded executions: {summary.succeeded} succeeded, {summary.failed} failed, {summary.unfinished} unfinished</summary>
      <p className="small">Basis: {summary.declaredBasis ?? "not recorded"}. Archive: {summary.capture.toLowerCase()}. Successful execution alone does not establish mathematical correctness.</p>
      {summary.supportValidated === false ? <p className="warn">The claimed support was not confirmed. The original report declared {summary.declaredVerdict}.</p> : null}
      {summary.issues.map((issue) => <p key={issue} className="small warn">{issue}</p>)}
      {error ? <p className="warn">{error}</p> : record?.commands.map((command) => (
        <details key={command.ref}>
          <summary>{command.ref}: {command.status.toLowerCase()} · exit {command.exitCode ?? "unknown"}</summary>
          <pre>{command.command}</pre>
          <pre>{command.outputExcerpt || "(No output excerpt.)"}</pre>
          <p className="small mono">Output SHA-256: {command.outputSha256 ?? "unavailable"}</p>
        </details>
      ))}
    </details>
  );
}
