/**
 * LiveBadge — small "LIVE" indicator that pulses when syncing from chain.
 * Used in TokenView header and TokenCard to confirm data is onchain-fresh.
 */
import { clsx } from "clsx";

interface LiveBadgeProps {
  syncing?: boolean;
  className?: string;
}

export function LiveBadge({ syncing = false, className }: LiveBadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wide",
        className,
      )}
      style={{ background: "rgba(52,210,122,0.14)", color: "var(--success)" }}
    >
      <span
        className={clsx(
          "w-1.5 h-1.5 rounded-full",
          syncing ? "animate-pulse" : "",
        )}
        style={{ background: "var(--success)" }}
      />
      {syncing ? "SYNCING" : "LIVE"}
    </span>
  );
}
