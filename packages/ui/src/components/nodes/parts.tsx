import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";

/** Pieces shared by the custom node components (UI-SPEC §5). */

export function NodeHandles(): JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Left} className="cq-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="cq-handle" isConnectable={false} />
    </>
  );
}

export function StatusRing({
  color,
  pulsing = false,
  size = 20,
  label,
}: {
  color: string;
  pulsing?: boolean;
  size?: number;
  label: string;
}): JSX.Element {
  const r = size / 2 - 2;
  return (
    <svg
      className={`status-ring${pulsing ? " pulsing" : ""}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  );
}

/** Thin arc gauge under a status ring: `min(1, used/budget)` (§5 TaskNode). */
export function TokenGauge({
  frac,
  color,
  label,
  width = 34,
}: {
  frac: number;
  color: string;
  label: string;
  width?: number;
}): JSX.Element {
  return (
    <div className="token-gauge" title={label} aria-label={label}>
      <div className="token-gauge-track" style={{ width }}>
        <div
          className="token-gauge-fill"
          style={{ width: `${Math.round(frac * 100)}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function Chip({
  text,
  color,
  title,
  className,
}: {
  text: string;
  color?: string;
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={`chip${className ? ` ${className}` : ""}`}
      style={color ? { color, borderColor: color } : undefined}
      {...(title === undefined ? {} : { title })}
    >
      {text}
    </span>
  );
}

export function NodeCard({
  kind,
  children,
  style,
  title,
}: {
  kind: string;
  children: ReactNode;
  style?: React.CSSProperties;
  title?: string;
}): JSX.Element {
  return (
    <div
      className={`node-card node-${kind}`}
      {...(style === undefined ? {} : { style })}
      {...(title === undefined ? {} : { title })}
    >
      {children}
      <NodeHandles />
    </div>
  );
}
