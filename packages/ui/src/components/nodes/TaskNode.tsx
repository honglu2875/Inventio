import type { NodeProps } from "@xyflow/react";
import type { TaskStatus, WorkerRole } from "@inventio/schema";
import { readNumber, readString } from "../../lib/dataread";
import { formatExact, formatTokens, truncate } from "../../lib/format";
import {
  ROLE_COLOR,
  ROLE_GLYPH,
  TASK_STATUS_COLOR,
  conclusionColor,
  gauge,
} from "../../lib/visual";
import { Chip, NodeHandles, StatusRing, TokenGauge } from "./parts";

/**
 * UI-SPEC §5: role glyph + method tag, status ring (pulsing while running),
 * token gauge, and either the conclusion chip or the last-item preview.
 * Compact mode (zoom < 0.5, class on the canvas) leaves glyph + ring only.
 */
export default function TaskNode({ id, data }: NodeProps): JSX.Element {
  const role = readString(data, "role", "solver") as WorkerRole;
  const status = readString(data, "status", "queued") as TaskStatus;
  const methodTag = readString(data, "methodTag");
  const conclusion = readString(data, "conclusion");
  const preview = readString(data, "lastItemPreview");
  const budget = readNumber(data, "budgetTokens");
  const spend = readNumber(data, "spend");
  const { frac, color } = gauge(spend, budget);
  const ringColor = TASK_STATUS_COLOR[status];

  return (
    <div className={`node-card node-task status-${status}`}>
      <div className="task-top">
        <span className="role-glyph" style={{ color: ROLE_COLOR[role] }} title={role}>
          {ROLE_GLYPH[role]}
        </span>
        <span className="task-id mono">{id}</span>
        <span className="task-method node-detail" title={methodTag}>
          {truncate(methodTag, 16)}
        </span>
        <span className="task-ring">
          <StatusRing
            color={ringColor}
            pulsing={status === "running"}
            size={18}
            label={`${id} ${status}`}
          />
          <span className="node-detail">
            <TokenGauge
              frac={frac}
              color={color}
              label={`${formatExact(spend)} / ${formatExact(budget)} tokens`}
            />
          </span>
        </span>
      </div>
      <div className="task-bottom node-detail">
        {conclusion !== "" ? (
          <Chip text={conclusion} color={conclusionColor(conclusion)} />
        ) : status === "running" && preview !== "" ? (
          <span className="mono muted preview">{truncate(preview, 34)}</span>
        ) : (
          <span className="mono muted preview">
            {status} · {formatTokens(spend)}
          </span>
        )}
      </div>
      <NodeHandles />
    </div>
  );
}
