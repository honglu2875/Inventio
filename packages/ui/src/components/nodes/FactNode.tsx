import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import { FACT_STATUS_COLOR } from "../../lib/visual";
import { truncate } from "../../lib/format";
import MathText from "../MathText";
import { NodeCard } from "./parts";

export default function FactNode({ id, data }: NodeProps): JSX.Element {
  const status = readString(data, "status", "ACTIVE");
  const statement = readString(data, "statement");
  const color = FACT_STATUS_COLOR[status] ?? "var(--warn)";
  const glyph = status === "ACTIVE" ? "✓" : status === "RETRACTED" ? "×"
    : status === "SUPERSEDED" ? "↪" : "?";
  return (
    <NodeCard kind="fact" style={{ borderColor: color }} title={statement}>
      <div className="claim-top"><span style={{ color }}>{glyph}</span><span className="mono claim-id">{id}</span><span className="claim-status" style={{ color }}>{status}</span></div>
      <div className="claim-statement clamp-3"><MathText>{truncate(statement, 150)}</MathText></div>
    </NodeCard>
  );
}
