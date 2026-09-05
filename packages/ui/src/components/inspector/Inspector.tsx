import type { IssueSeverity, ProjectState } from "@inventio/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { formatExact, formatTokens, truncate } from "../../lib/format";
import { isProjectExport } from "../../lib/projectExport";
import { classifyNodeId, permalinkFor, type NodeKind } from "../../lib/selection";
import { verificationDisplayStatus } from "../../lib/visual";
import { useActionGuard, useApiAction, useProjectState } from "../../store/hooks";
import RenderBoundary from "../RenderBoundary";
import ArtifactTab from "./ArtifactTab";
import EventsTab from "./EventsTab";
import MemoTab from "./MemoTab";
import PacketTab from "./PacketTab";
import RecallTab from "./RecallTab";
import StreamTab from "./StreamTab";

/**
 * The right slide-over (UI-SPEC §7). 440px by default, resizable 360–720px.
 * Only the tabs relevant to the node type are offered and only the active one
 * is mounted, so markdown/KaTeX and the codex SSE tail stay lazy.
 */

const MIN_W = 360;
const MAX_W = 720;
const DEFAULT_W = 440;

export type TabKey = "artifact" | "packet" | "memo" | "recall" | "events" | "stream";

const TAB_LABEL: Record<TabKey, string> = {
  artifact: "Work",
  packet: "Brief",
  memo: "Notes",
  recall: "Earlier work",
  events: "Timeline",
  stream: "Live",
};

const KIND_ICON: Record<NodeKind, string> = {
  problem: "◇",
  wave: "▤",
  task: "◆",
  resolution: "▤",
  lineage: "❖",
  candidate: "⬢",
  obligation: "⚑",
  review: "▣",
  question: "?",
  claim: "✓",
  fact: "■",
  verification: "◉",
  milestone: "◇",
  issue: "▲",
  card: "▢",
  artifact: "▤",
  computation: "⌗",
  memory: "▢",
  final: "★",
  unknown: "•",
};

function tabsFor(kind: NodeKind): TabKey[] {
  switch (kind) {
    case "task":
      return ["artifact", "packet", "memo", "recall", "events", "stream"];
    case "lineage":
    case "memory":
      return ["events"];
    default:
      return ["artifact", "events"];
  }
}

function titleFor(state: ProjectState | null, kind: NodeKind, nodeId: string): string {
  if (state === null) return "";
  switch (kind) {
    case "problem":
      return state.title;
    case "wave":
      return state.waves[nodeId]?.title ?? "";
    case "resolution":
      return `resolution · ${nodeId.split(":")[0] ?? ""}`;
    case "task": {
      const task = state.tasks[nodeId];
      return task ? `${task.role} · ${task.methodTag}` : "";
    }
    case "lineage":
      return state.lineages[nodeId]?.title ?? "";
    case "candidate": {
      const candidate = state.candidates[nodeId];
      return candidate ? `${candidate.lineageId} v${candidate.version}` : "";
    }
    case "review": {
      const review = state.reviews[nodeId];
      return review ? `${review.verdict} · ${review.candidateId}` : "";
    }
    case "question":
      return truncate(state.questions[nodeId]?.text ?? "", 60);
    case "claim":
      return truncate(state.claims[nodeId]?.statement ?? "", 60);
    case "fact":
      return truncate(state.facts[nodeId]?.statement ?? "", 60);
    case "verification": {
      const verification = state.verifications[nodeId];
      return verification ? `${verificationDisplayStatus(verification)} · ${verification.claimId}` : "";
    }
    case "milestone":
      return state.milestones[nodeId]?.title ?? "";
    case "issue":
      return truncate(state.issues[nodeId]?.summary ?? "", 60);
    case "card":
      return truncate(state.cards[nodeId]?.card.title ?? "", 60);
    case "final":
      return state.terminal ? `RESULT: ${state.terminal.result}` : "final";
    case "memory":
      return "Memory";
    default:
      return "";
  }
}

/** §7: Interrupt (danger, confirmed) and Extend budget +25%. */
function TaskFooter({ slug, taskId }: { slug: string; taskId: string }): JSX.Element | null {
  const state = useProjectState(slug);
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const task = state?.tasks[taskId];
  if (!task) return null;
  const add = Math.ceil(task.budgetTokens * 0.25);
  const live = task.status === "running" || task.status === "queued";
  if (!live) return null;
  return (
    <footer className="inspector-foot">
      <button
        type="button"
        className="button danger"
        disabled={guard.disabled}
        {...(guard.title === undefined ? {} : { title: guard.title })}
        onClick={() => {
          if (!window.confirm(`Stop ${taskId}? Its latest partial work will be preserved when possible.`))
            return;
          void run(() => api.interruptTask(slug, taskId), `interrupt requested for ${taskId}`);
        }}
      >
        Stop now
      </button>
      <button
        type="button"
        className="button"
        disabled={guard.disabled}
        title={guard.title ?? `+${formatExact(add)} tokens`}
        onClick={() => {
          void run(() => api.extendTask(slug, taskId, add), `budget extended by ${formatTokens(add)}`);
        }}
      >
        Extend budget +25%
      </button>
    </footer>
  );
}

/** §7: candidate footer — raise an issue against the frozen text. */
function CandidateFooter({ slug, candidateId }: { slug: string; candidateId: string }): JSX.Element {
  const guard = useActionGuard(slug);
  const run = useApiAction();
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<IssueSeverity>("MAJOR");
  const [location, setLocation] = useState("");
  const [text, setText] = useState("");

  if (!open) {
    return (
      <footer className="inspector-foot">
        <button
          type="button"
          className="button"
          disabled={guard.disabled}
          {...(guard.title === undefined ? {} : { title: guard.title })}
          onClick={() => setOpen(true)}
        >
          Raise issue
        </button>
      </footer>
    );
  }

  return (
    <footer className="inspector-foot column">
      <div className="row">
        <select
          className="select"
          value={severity}
          aria-label="severity"
          onChange={(e) => {
            const value = e.target.value;
            setSeverity(value === "CRITICAL" || value === "MINOR" ? value : "MAJOR");
          }}
        >
          <option value="CRITICAL">CRITICAL</option>
          <option value="MAJOR">MAJOR</option>
          <option value="MINOR">MINOR</option>
        </select>
        <input
          className="input"
          placeholder="location (e.g. §3, K012)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>
      <textarea
        className="textarea"
        rows={3}
        placeholder="what is wrong"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row end">
        <button type="button" className="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={guard.disabled || text.trim() === ""}
          {...(guard.title === undefined ? {} : { title: guard.title })}
          onClick={() => {
            void run(
              () => api.raiseIssue(slug, candidateId, severity, location, text.trim()),
              "issue raised",
            ).then((result) => {
              if (result) {
                setOpen(false);
                setText("");
                setLocation("");
              }
            });
          }}
        >
          Raise
        </button>
      </div>
    </footer>
  );
}

export default function Inspector({
  slug,
  nodeId,
  onClose,
}: {
  slug: string;
  nodeId: string;
  onClose: () => void;
}): JSX.Element {
  const state = useProjectState(slug);
  const kind = classifyNodeId(nodeId);
  const exported = isProjectExport();
  const readOnly = exported || state?.config.workflow === "council-v1";
  const tabs = useMemo(() => tabsFor(kind), [kind]);
  const [tab, setTab] = useState<TabKey>(() => tabs[0] ?? "events");
  const [width, setWidth] = useState(DEFAULT_W);
  const dragging = useRef(false);

  // A new selection resets to that node type's first tab. For tasks this is
  // always Work, whether the task is queued, running, or completed.
  useEffect(() => {
    setTab(tabs[0] ?? "events");
  }, [nodeId, tabs]);

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragging.current) return;
      event.preventDefault();
      const next = window.innerWidth - event.clientX;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, next)));
    };
    const onUp = (): void => {
      dragging.current = false;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const copyLink = useCallback(() => {
    const href = exported
      ? `${window.location.href.split("#")[0]}#${permalinkFor(slug, nodeId)}`
      : `${window.location.origin}${permalinkFor(slug, nodeId)}`;
    void navigator.clipboard?.writeText(href).catch(() => {
      /* clipboard blocked: the link is still in the URL bar after navigating */
    });
  }, [slug, nodeId, exported]);

  const title = titleFor(state, kind, nodeId);

  return (
    <aside className="inspector" style={{ width }} aria-label={`inspector for ${nodeId}`}>
      <div
        className="inspector-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="resize inspector"
        onMouseDown={() => {
          dragging.current = true;
          document.body.classList.add("resizing");
        }}
      />
      <header className="inspector-head">
        <span className="inspector-icon" aria-hidden="true">
          {KIND_ICON[kind]}
        </span>
        <span className="inspector-id mono">{nodeId}</span>
        <span className="inspector-title" title={title}>
          {truncate(title, 44)}
        </span>
        <button type="button" className="icon-button" onClick={copyLink} title="copy permalink">
          ⧉
        </button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="close inspector">
          ✕
        </button>
      </header>

      <nav className="inspector-tabs" role="tablist">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`inspector-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {exported && key === "stream" ? "Transcript" : TAB_LABEL[key]}
          </button>
        ))}
      </nav>

      <div className="inspector-body" role="tabpanel">
        <RenderBoundary
          key={`${nodeId}:${tab}`}
          label={`${exported && tab === "stream" ? "Transcript" : TAB_LABEL[tab]} for ${nodeId}`}
        >
          {tab === "artifact" ? <ArtifactTab slug={slug} nodeId={nodeId} kind={kind} /> : null}
          {tab === "packet" ? <PacketTab slug={slug} taskId={nodeId} /> : null}
          {tab === "memo" ? <MemoTab slug={slug} taskId={nodeId} /> : null}
          {tab === "recall" ? <RecallTab slug={slug} taskId={nodeId} /> : null}
          {tab === "events" ? <EventsTab slug={slug} nodeId={nodeId} /> : null}
          {tab === "stream" ? <StreamTab slug={slug} taskId={nodeId} /> : null}
        </RenderBoundary>
      </div>

      {!readOnly && kind === "task" ? <TaskFooter slug={slug} taskId={nodeId} /> : null}
      {!readOnly && kind === "candidate" ? <CandidateFooter slug={slug} candidateId={nodeId} /> : null}
    </aside>
  );
}
