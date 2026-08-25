import type { NodeProps } from "@xyflow/react";
import type { IssueSeverity } from "@inventio/schema";
import { readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { SEVERITY_COLOR, SEVERITY_LETTER } from "../../lib/visual";
import MathText from "../MathText";
import { Chip, NodeHandles } from "./parts";

/** UI-SPEC §8: severity chip + summary (≤ 2 lines); resolved at 50% opacity. */
export default function IssueNode({ id, data }: NodeProps): JSX.Element {
  const severity = readString(data, "severity", "MINOR") as IssueSeverity;
  const summary = readString(data, "summary");
  const status = readString(data, "status", "open");
  const disposition = readString(data, "disposition");
  const resolved = status === "resolved";
  return (
    <div className={`node-card node-issue${resolved ? " is-resolved" : ""}`} title={summary}>
      <div className="issue-top">
        <Chip text={`${SEVERITY_LETTER[severity]} ${severity}`} color={SEVERITY_COLOR[severity]} />
        <span className="mono small">{id}</span>
        {resolved ? <span className="badge muted-badge">{disposition || "resolved"}</span> : null}
      </div>
      <div className="issue-summary clamp-2">
        <MathText>{truncate(summary, 90)}</MathText>
      </div>
      <NodeHandles />
    </div>
  );
}
