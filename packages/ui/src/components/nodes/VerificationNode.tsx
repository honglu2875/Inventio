import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { NodeCard } from "./parts";

export default function VerificationNode({ id, data }: NodeProps): JSX.Element {
  const verdict = readString(
    data,
    "verdict",
    readString(data, "status", "queued") === "running" ? "RUNNING" : "QUEUED",
  );
  const summary = readString(data, "summary", "Independent check waiting");
  const color = verdict === "PASS" ? "var(--ok)" : verdict === "FAIL" || verdict === "ERROR" ? "var(--danger)" : verdict === "RUNNING" ? "var(--running)" : "var(--muted)";
  return (
    <NodeCard kind="verification" style={{ borderColor: color }} title={summary}>
      <div className="verification-top"><span className="mono">{id}</span><span style={{ color }}>{verdict}</span></div>
      <div className="small muted clamp-2">{truncate(summary, 100)}</div>
    </NodeCard>
  );
}
