import type { TradeRecord } from "../types";
import { shortenAddress, formatRlo, timeAgo } from "../utils/crypto";
import { TrendingUp, TrendingDown } from "lucide-react";
import { GlassCard } from "./ui/GlassCard";

interface TradesTableProps {
  trades: TradeRecord[];
}

export function TradesTable({ trades }: TradesTableProps) {
  if (!trades.length) {
    return (
      <GlassCard className="p-6 text-center">
        <p className="text-sm" style={{ color: "var(--muted)" }}>No trades yet</p>
        <p className="text-xs mt-1" style={{ color: "var(--subtle)" }}>Be the first to trade this token</p>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="overflow-hidden">
      <div className="px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Recent Trades</h3>
      </div>
      <div className="divide-y" style={{ ["--tw-divide-color" as string]: "var(--border)" }}>
        {trades.slice(0, 30).map((trade) => (
          <div key={trade.id} className="px-4 py-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                style={{
                  background: trade.type === "buy" ? "rgba(26,128,71,0.10)" : "rgba(186,43,76,0.10)",
                }}
              >
                {trade.type === "buy"
                  ? <TrendingUp size={12} style={{ color: "var(--success)" }} />
                  : <TrendingDown size={12} style={{ color: "var(--danger)" }} />}
              </div>
              <div>
                <p className="text-xs font-semibold mono" style={{ color: "var(--ink-2)" }}>
                  {shortenAddress(trade.trader, 4)}
                </p>
                <p className="text-xs" style={{ color: "var(--subtle)" }}>{timeAgo(trade.timestamp)}</p>
              </div>
            </div>
            <div className="text-right">
              <p
                className="text-xs font-bold tabular-nums"
                style={{ color: trade.type === "buy" ? "var(--success)" : "var(--danger)" }}
              >
                {trade.type === "buy"
                  ? `+${trade.tokenAmount.toLocaleString()}`
                  : `-${trade.tokenAmount.toLocaleString()}`}
              </p>
              <p className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                {formatRlo(trade.rloAmount)} RLO
              </p>
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
