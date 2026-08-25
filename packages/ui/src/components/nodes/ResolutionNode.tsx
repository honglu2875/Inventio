import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import { NodeHandles } from "./parts";

/** UI-SPEC §5: small document icon + "Resolution", muted. */
export default function ResolutionNode({ data }: NodeProps): JSX.Element {
  const path = readString(data, "path");
  return (
    <div className="node-card node-resolution" title={path}>
      <span className="doc-icon" aria-hidden="true">
        ▤
      </span>
      <span className="muted">Resolution</span>
      <NodeHandles />
    </div>
  );
}
