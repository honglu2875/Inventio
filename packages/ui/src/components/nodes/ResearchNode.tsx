import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import MathText from "../MathText";
import { NodeHandles } from "./parts";
export function researchStatusColor(status: string): string {
  if (["AUDITED", "CONFIRM"].includes(status)) return "var(--ok)";
  if (["CHECKED", "running"].includes(status)) return "var(--accent)";
  if (status === "RETRACTED" || status === "RETRACT") return "var(--danger)";
  if (["DISPUTED", "NEEDS_REVISION", "QUARANTINE", "DOWNGRADE", "UNABLE"].includes(status)) return "var(--warn)";
  return "var(--muted)";
}
export default function ResearchNode({ id, data }: NodeProps): JSX.Element {
  const status = readString(data, "status");
  const title = readString(data, "title");
  const statement = readString(data, "statement");
  const kind = readString(data, "contentKind");
  const relation = readString(data, "relationToGoal");
  return <div className="node-card node-research" style={{ borderColor: researchStatusColor(status) }} title={`${title}\n\n${statement}`}>
    <div className="claim-top"><span className="mono claim-id">{id}</span><span className="claim-status" style={{ color: researchStatusColor(status) }}>{status}</span></div>
    <div className="research-node-title">{title}</div>
    <div className="claim-statement clamp-2"><MathText>{statement}</MathText></div>
    {kind ? <div className="research-node-kind muted">{kind} · {relation}</div> : null}
    <NodeHandles />
  </div>;
}
