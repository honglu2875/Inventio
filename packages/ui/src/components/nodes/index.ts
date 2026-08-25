import type { NodeTypes } from "@xyflow/react";
import CandidateNode from "./CandidateNode";
import ClaimNode from "./ClaimNode";
import FinalNode from "./FinalNode";
import IssueNode from "./IssueNode";
import LineageNode from "./LineageNode";
import MemoryHubNode from "./MemoryHubNode";
import ObligationNode from "./ObligationNode";
import ProblemNode from "./ProblemNode";
import QuestionNode from "./QuestionNode";
import ResolutionNode from "./ResolutionNode";
import ReviewNode from "./ReviewNode";
import TaskNode from "./TaskNode";
import WaveNode from "./WaveNode";

/**
 * React Flow node type registries. Defined once at module scope — recreating
 * them per render forces React Flow to remount every node.
 */

export const OPS_NODE_TYPES: NodeTypes = {
  problemNode: ProblemNode,
  waveNode: WaveNode,
  taskNode: TaskNode,
  resolutionNode: ResolutionNode,
  lineageNode: LineageNode,
  candidateNode: CandidateNode,
  reviewNode: ReviewNode,
  memoryHubNode: MemoryHubNode,
  questionNode: QuestionNode,
  finalNode: FinalNode,
};

export const EVIDENCE_NODE_TYPES: NodeTypes = {
  candidateNode: CandidateNode,
  claimNode: ClaimNode,
  obligationNode: ObligationNode,
  issueNode: IssueNode,
};

/** Graph node `type` (schema) → React Flow node type name. */
export const RF_TYPE_OF: Record<string, string> = {
  problem: "problemNode",
  wave: "waveNode",
  task: "taskNode",
  resolution: "resolutionNode",
  lineage: "lineageNode",
  candidate: "candidateNode",
  review: "reviewNode",
  memoryHub: "memoryHubNode",
  question: "questionNode",
  final: "finalNode",
  claim: "claimNode",
  issue: "issueNode",
  obligation: "obligationNode",
};
