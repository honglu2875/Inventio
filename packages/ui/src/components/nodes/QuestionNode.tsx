import type { NodeProps } from "@xyflow/react";
import { readBool, readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { NodeHandles } from "./parts";

/** UI-SPEC §5: `?` icon + truncated text; blocking questions pulse in danger. */
export default function QuestionNode({ id, data }: NodeProps): JSX.Element {
  const text = readString(data, "text");
  const blocking = readBool(data, "blocking");
  return (
    <div className={`node-card node-question${blocking ? " is-blocking" : ""}`} title={text}>
      <div className="question-top">
        <span className="question-mark" aria-hidden="true">
          ?
        </span>
        <span className="mono small">{id}</span>
        {blocking ? <span className="badge danger-badge">blocking</span> : null}
      </div>
      <div className="question-text node-detail">{truncate(text, 60)}</div>
      <NodeHandles />
    </div>
  );
}
