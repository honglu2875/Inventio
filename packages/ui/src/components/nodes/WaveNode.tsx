import type { MouseEvent } from "react";
import type { NodeProps } from "@xyflow/react";
import type { TaskStatus, WorkerRole } from "@inventio/schema";
import { readBool, readNumber, readString } from "../../lib/dataread";
import { formatExact, formatTokens, truncate } from "../../lib/format";
import { ROLE_GLYPH, TASK_STATUS_COLOR } from "../../lib/visual";
import { useStore } from "../../store/store";
import { useProjectSlug } from "../ProjectContext";
import { NodeHandles, StatusRing } from "./parts";

export interface RosterGlyph {
  role: WorkerRole;
  status: TaskStatus;
  taskId: string;
}

function waveRingColor(status: string, anyRunning: boolean): string {
  if (status === "softInterrupted") return "var(--warn)";
  if (status === "closed") return "var(--ok)";
  return anyRunning ? "var(--running)" : "var(--queued)";
}

/**
 * UI-SPEC §5. Collapsed: header + roster glyph row + spend + status ring.
 * Expanded: the same header; children are rendered by React Flow as a group.
 */
export default function WaveNode({ id, data }: NodeProps): JSX.Element {
  const slug = useProjectSlug();
  const toggleWave = useStore((s) => s.toggleWave);
  const collapsed = readBool(data, "collapsed");
  const title = readString(data, "label", id);
  const status = readString(data, "status", "open");
  const spend = readNumber(data, "spend");
  const rosterRaw = data["roster"];
  const roster: RosterGlyph[] = Array.isArray(rosterRaw) ? (rosterRaw as RosterGlyph[]) : [];
  const anyRunning = roster.some((r) => r.status === "running");

  const toggle = (event: MouseEvent): void => {
    event.stopPropagation();
    toggleWave(slug, id);
  };

  return (
    <div
      className={`node-card node-wave ${collapsed ? "is-collapsed" : "is-expanded"} status-${status}`}
    >
      <div className="wave-header" onDoubleClick={toggle}>
        <StatusRing
          color={waveRingColor(status, anyRunning)}
          pulsing={anyRunning}
          size={16}
          label={`wave ${status}`}
        />
        <span className="mono wave-id">{id}</span>
        <span className="wave-title" title={title}>
          {truncate(title, 22)}
        </span>
        {status === "softInterrupted" ? (
          <span className="badge warn" title="soft-interrupted">
            ⏸
          </span>
        ) : null}
        <button
          type="button"
          className="chevron"
          onClick={toggle}
          title={collapsed ? "expand wave" : "collapse wave"}
          aria-label={collapsed ? "expand wave" : "collapse wave"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>
      {collapsed ? (
        <div className="wave-body">
          <div className="roster-row">
            {roster.map((entry) => (
              <span
                key={entry.taskId}
                className="role-glyph"
                style={{ color: TASK_STATUS_COLOR[entry.status] }}
                title={`${entry.taskId} · ${entry.role} · ${entry.status}`}
              >
                {ROLE_GLYPH[entry.role]}
              </span>
            ))}
          </div>
          <div className="wave-spend mono" title={`${formatExact(spend)} tokens`}>
            {formatTokens(spend)}
          </div>
        </div>
      ) : null}
      <NodeHandles />
    </div>
  );
}
