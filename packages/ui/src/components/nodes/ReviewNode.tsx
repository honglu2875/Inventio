import type { NodeProps } from "@xyflow/react";
import { readNumber, readString } from "../../lib/dataread";
import { NodeHandles } from "./parts";

/** UI-SPEC §5: `R001 PASS` / `FAIL` pill in verdict color + issue count. */
export default function ReviewNode({ id, data }: NodeProps): JSX.Element {
  const verdict = readString(data, "verdict", "FAIL");
  const issues = readNumber(data, "issueCount");
  const color = verdict === "PASS" ? "var(--ok)" : "var(--danger)";
  return (
    <div className="node-card node-review">
      <span className="verdict-pill" style={{ color, borderColor: color }}>
        <span className="mono">{id}</span> {verdict}
      </span>
      <span className="muted small node-detail">
        {issues} issue{issues === 1 ? "" : "s"}
      </span>
      <NodeHandles />
    </div>
  );
}
