import type { NodeProps } from "@xyflow/react";
import type { ClaimStatus } from "@inventio/schema";
import { readNumber, readString } from "../../lib/dataread";
import { truncate } from "../../lib/format";
import { CLAIM_STATUS_COLOR, CLAIM_STATUS_GLYPH } from "../../lib/visual";
import MathText from "../MathText";
import { NodeHandles, StatusRing } from "./parts";

/** UI-SPEC §8: claim id + statement (≤ 3 lines) + status ring; border = status. */
export default function ClaimNode({ id, data }: NodeProps): JSX.Element {
  const status = readString(data, "status", "UNVERIFIED") as ClaimStatus;
  const statement = readString(data, "statement");
  const checks = readNumber(data, "checkCount", -1);
  const passes = readNumber(data, "passCount");
  const required = readNumber(data, "passesRequired");
  const color = CLAIM_STATUS_COLOR[status];
  return (
    <div className="node-card node-claim" style={{ borderColor: color }} title={statement}>
      <div className="claim-top">
        <StatusRing color={color} size={14} label={`claim ${status}`} />
        <span className="mono claim-id">{id}</span>
        <span className="claim-status" style={{ color }}>
          {CLAIM_STATUS_GLYPH[status]} {status}
        </span>
      </div>
      <div className="claim-statement clamp-3">
        <MathText>{truncate(statement, 150)}</MathText>
      </div>
      {checks >= 0 ? <div className="small muted">{passes}/{required} pass · {checks} checks</div> : null}
      <NodeHandles />
    </div>
  );
}
