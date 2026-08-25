import type { NodeProps } from "@xyflow/react";
import { readBool, readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { NodeHandles } from "./parts";

/** UI-SPEC §5: lane label — lineage id + title + lifecycle badge. */
export default function LineageNode({ id, data }: NodeProps): JSX.Element {
  const title = readString(data, "label", id);
  const status = readString(data, "status", "active");
  const active = readBool(data, "active");
  const latestCandidateStage = readString(data, "latestCandidateStage", "UNKNOWN");
  return (
    <div className={`node-card node-lineage ${status === "abandoned" ? "is-abandoned" : ""}`}>
      <span className="mono lineage-id">{id}</span>
      <span className="lineage-title" title={title}>
        {truncate(title, 18)}
      </span>
      {status === "abandoned" ? (
        <span className="badge muted-badge">abandoned</span>
      ) : status === "established" ? (
        <span className="badge ok-badge">established partial</span>
      ) : active ? (
        latestCandidateStage === "FAILED_REVIEW" || latestCandidateStage === "REVISION_NEEDED" ? (
          <span
            className="badge warn"
            title="The research direction remains active, but its latest candidate needs revision."
          >
            REVISION NEEDED
          </span>
        ) : (
          <span className="badge ok-badge" title="Active research direction; not an accepted result.">
            ACTIVE DIRECTION
          </span>
        )
      ) : null}
      <NodeHandles />
    </div>
  );
}
