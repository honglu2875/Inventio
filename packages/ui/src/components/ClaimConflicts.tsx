import type { ClaimConflictState, ProjectState } from "@inventio/schema";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { isProjectExport } from "../lib/projectExport";
import { useActionGuard, useApiAction } from "../store/hooks";
import Markdown from "./Markdown";

function Conflict({ slug, conflict }: { slug: string; conflict: ClaimConflictState; }): JSX.Element {
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <details className="banner warn">
      <summary>Conflicting statements: {conflict.leftClaimId} and {conflict.rightClaimId} · {conflict.status.toLowerCase()}</summary>
      <Markdown>{conflict.reason}</Markdown>
      <p>
        <Link to={`/p/${encodeURIComponent(slug)}/library/claims/${conflict.leftClaimId}`}>{conflict.leftClaimId}</Link>
        {" · "}
        <Link to={`/p/${encodeURIComponent(slug)}/library/claims/${conflict.rightClaimId}`}>{conflict.rightClaimId}</Link>
      </p>
      {conflict.status === "RESOLVED" ? <Markdown>{conflict.resolutionReason ?? ""}</Markdown> : (
        <>
          <p className="small">Neither statement is refuted merely because its proof failed review. Affected facts are not settled premises until this conflict is resolved.</p>
          {!isProjectExport() && !guard.disabled ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              if (!reason.trim() || saving) return;
              setSaving(true);
              void run(() => api.resolveClaimConflict(slug, conflict.leftClaimId, conflict.rightClaimId, reason.trim()))
                .finally(() => setSaving(false));
            }}>
              <label className="field">Mathematical reason the conflict is resolved
                <textarea value={reason} maxLength={4000} onChange={(event) => setReason(event.target.value)} />
              </label>
              <button className="button" type="submit" disabled={saving || !reason.trim()}>Record resolution</button>
              <p className="small muted">This records your assessment. Existing verifier reports and stopping reports remain historical evidence.</p>
            </form>
          ) : null}
        </>
      )}
    </details>
  );
}

export default function ClaimConflicts({ slug, state }: { slug: string; state: ProjectState; }): JSX.Element | null {
  if (!state.claimConflicts?.length) return null;
  return <div aria-label="Conflicting mathematical statements">{state.claimConflicts.map((conflict) =>
    <Conflict key={`${conflict.leftClaimId}:${conflict.rightClaimId}`} slug={slug} conflict={conflict} />,
  )}</div>;
}
