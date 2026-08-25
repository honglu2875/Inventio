import { useStore } from "../store/store";

/** Bottom-left toast stack; every API error surfaces here (§7). */
export default function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.text}</span>
          <button type="button" className="icon-button" onClick={() => dismiss(toast.id)} aria-label="dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
