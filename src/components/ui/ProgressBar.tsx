interface ProgressBarProps {
  value: number; // 0–100
  label?: string;
  graduated?: boolean;
  className?: string;
}

const spectral = "linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)";

export function ProgressBar({ value, label, graduated, className }: ProgressBarProps) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className={className}>
      {label && (
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>{label}</span>
          <span
            className="text-xs font-semibold tabular-nums"
            style={{ color: graduated ? "var(--success)" : "var(--ink)" }}
          >
            {graduated ? "Graduated" : `${pct.toFixed(1)}%`}
          </span>
        </div>
      )}
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: "rgba(18,45,69,0.08)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: graduated ? "var(--success)" : spectral,
          }}
        />
      </div>
    </div>
  );
}
