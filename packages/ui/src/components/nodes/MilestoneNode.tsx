import type { NodeProps } from "@xyflow/react";
import { readBool, readNumber, readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import MathText from "../MathText";
import { NodeCard } from "./parts";

/** One worker-marked mathematical turning point inside a long trajectory. */
export default function MilestoneNode({ id, data }: NodeProps): JSX.Element {
  const title = readString(data, "title", readString(data, "label", id));
  const markdown = readString(data, "markdown");
  const ordinal = readNumber(data, "ordinal");
  const total = readNumber(data, "total");
  const researchMap = readBool(data, "researchMap");
  return (
    <NodeCard kind="milestone" title={markdown || title}>
      <div className="milestone-top">
        <span aria-hidden="true">◇</span>
        <span className="mono">{id}</span>
        {researchMap && ordinal > 0 ? (
          <span className="muted milestone-step">step {ordinal}{total > 0 ? `/${total}` : ""}</span>
        ) : null}
      </div>
      <div className="milestone-title">{truncate(title, 48)}</div>
      {researchMap && markdown !== "" ? (
        <div className="milestone-excerpt node-detail muted clamp-2">
          <MathText>{truncate(markdown, 108)}</MathText>
        </div>
      ) : null}
    </NodeCard>
  );
}
