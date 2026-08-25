import type { NodeProps } from "@xyflow/react";
import { readBool, readNumber, readRecord, readString } from "../../lib/dataread";
import { burnDownChips, candidateStageColor, type BurnDown } from "../../lib/visual";
import MathText from "../MathText";
import { Chip, NodeHandles } from "./parts";

function burnDownOf(data: Record<string, unknown>): BurnDown {
  const raw = readRecord(data, "burnDown");
  const read = (key: string): number => {
    const v = raw?.[key];
    return typeof v === "number" ? v : 0;
  };
  return { CRITICAL: read("CRITICAL"), MAJOR: read("MAJOR"), MINOR: read("MINOR") };
}

/**
 * UI-SPEC §5/§8: candidate id (mono, larger), obligations chip, burn-down
 * chips, acceptance badge. Abandoned lineage members render at 50% opacity.
 */
export default function CandidateNode({ id, data }: NodeProps): JSX.Element {
  const obligations = readNumber(data, "obligations");
  const reviewQuestions = readNumber(data, "reviewQuestions");
  const abandoned = readBool(data, "abandoned");
  const large = readBool(data, "large");
  const acceptance = readRecord(data, "acceptance");
  const lifecycleStage = readString(data, "lifecycleStage", "UNKNOWN");
  const lifecycleStatus = readString(data, "lifecycleStatus", "UNKNOWN");
  const lifecycleDetail = readString(data, "lifecycleDetail");
  // The derived label is the candidate id today; render it through MathText so a
  // titled candidate picks up math without another change here (§5).
  const label = readString(data, "label", id);
  const passed = acceptance === null ? null : acceptance["passed"] === true;
  const failing = Array.isArray(acceptance?.["failing"]) ? (acceptance["failing"] as unknown[]) : [];
  const lifecycleTitle =
    lifecycleDetail ||
    (passed === false
      ? failing.map(String).join("\n")
      : passed === true
        ? "accepted"
        : undefined);

  return (
    <div
      className={`node-card node-candidate${abandoned ? " is-abandoned" : ""}${large ? " is-large" : ""}`}
    >
      <div className="candidate-id mono">
        <MathText>{label}</MathText>
      </div>
      <div className="node-row node-detail">
        <Chip text={`${obligations} obl`} title="open obligations" />
        {reviewQuestions > 0 ? <Chip text={`${reviewQuestions} checks`} title="questions assigned to reviewers (not admitted gaps)" /> : null}
        {burnDownChips(burnDownOf(data)).map((chip) => (
          <Chip key={chip.text} text={chip.text} color={chip.color} />
        ))}
      </div>
      <div className="node-row node-detail">
        <Chip
          text={lifecycleStatus}
          color={candidateStageColor(lifecycleStage as Parameters<typeof candidateStageColor>[0])}
          {...(lifecycleTitle === undefined ? {} : { title: lifecycleTitle })}
        />
      </div>
      <NodeHandles />
    </div>
  );
}
