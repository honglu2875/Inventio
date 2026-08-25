import type { NodeProps } from "@xyflow/react";
import { readRecord } from "../../lib/dataread";
import { CARD_STATUS_COLOR } from "../../lib/visual";
import { Chip, NodeHandles } from "./parts";

/** UI-SPEC §5: "Memory" + per-status count chips; click → Library memory. */
export default function MemoryHubNode({ data }: NodeProps): JSX.Element {
  const counts = readRecord(data, "counts") ?? {};
  const entries = Object.entries(counts).filter(([, n]) => typeof n === "number" && n > 0);
  return (
    <div className="node-card node-memory">
      <div className="node-title">Memory</div>
      <div className="node-row node-detail">
        {entries.length === 0 ? (
          <span className="muted small">no cards yet</span>
        ) : (
          entries.map(([status, n]) => (
            <Chip
              key={status}
              text={`${String(n)} ${status.toLowerCase()}`}
              color={CARD_STATUS_COLOR[status] ?? "var(--muted)"}
            />
          ))
        )}
      </div>
      <NodeHandles />
    </div>
  );
}
