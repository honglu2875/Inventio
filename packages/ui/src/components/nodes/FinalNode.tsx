import type { NodeProps } from "@xyflow/react";
import { readString } from "../../lib/dataread";
import { resultColor } from "../../lib/visual";
import { NodeHandles } from "./parts";

/** UI-SPEC §5: large `RESULT: …` pill in ok / danger / warn. */
export default function FinalNode({ data }: NodeProps): JSX.Element {
  const result = readString(data, "result", "UNCERTAIN");
  const color = resultColor(result);
  return (
    <div className="node-card node-final">
      <span className="final-pill" style={{ color, borderColor: color }}>
        RESULT: {result}
      </span>
      <NodeHandles />
    </div>
  );
}
