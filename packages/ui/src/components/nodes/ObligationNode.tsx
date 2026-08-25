import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import MathText from "../MathText";
import { NodeHandles } from "./parts";

/** UI-SPEC §8: amber-bordered card with the obligation text (≤ 3 lines). */
export default function ObligationNode({ data }: NodeProps): JSX.Element {
  const text = readString(data, "text");
  const label = readString(data, "label", "Obligation");
  return (
    <div className="node-card node-obligation" title={text}>
      <div className="obligation-label">{label}</div>
      <div className="obligation-text clamp-3">
        <MathText>{truncate(text, 130)}</MathText>
      </div>
      <NodeHandles />
    </div>
  );
}
