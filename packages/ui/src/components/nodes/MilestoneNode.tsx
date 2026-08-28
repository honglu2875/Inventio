import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { NodeCard } from "./parts";

/** One worker-marked mathematical turning point inside a long trajectory. */
export default function MilestoneNode({ id, data }: NodeProps): JSX.Element {
  const title = readString(data, "title", readString(data, "label", id));
  const markdown = readString(data, "markdown");
  return (
    <NodeCard kind="milestone" title={markdown || title}>
      <div className="milestone-top"><span aria-hidden="true">◇</span><span className="mono">{id}</span></div>
      <div className="milestone-title">{truncate(title, 48)}</div>
    </NodeCard>
  );
}
