import type { NodeProps } from "@xyflow/react";
import { readBool, readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { Chip, NodeCard } from "./parts";

/** UI-SPEC §5: title, phase badge, confirmed check. */
export default function ProblemNode({ data }: NodeProps): JSX.Element {
  const title = readString(data, "label", "Problem");
  const phase = readString(data, "phase", "CREATED");
  const confirmed = readBool(data, "confirmed");
  return (
    <NodeCard kind="problem" title={title}>
      <div className="node-title">{truncate(title, 44)}</div>
      <div className="node-row node-detail">
        <Chip text={phase} color="var(--accent)" />
        {confirmed ? (
          <span className="ok-check" title="problem statement confirmed">
            ✓ confirmed
          </span>
        ) : (
          <span className="muted small">awaiting confirmation</span>
        )}
      </div>
    </NodeCard>
  );
}
