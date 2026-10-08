import { GlassCard } from "./ui/GlassCard";
import { ProgressBar } from "./ui/ProgressBar";
import { TokenAvatar } from "./ui/TokenAvatar";
import type { Token } from "../types";
import { formatRlo, timeAgo } from "../utils/crypto";


interface TokenCardProps {
  token: Token;
  onClick: () => void;
}

export function TokenCard({ token, onClick }: TokenCardProps) {
  const mcapRlo = token.marketCap / 1_000_000_000;

  return (
    <GlassCard
      onClick={onClick}
      hover
      className="p-4 flex flex-col gap-3"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <TokenAvatar imageUrl={token.imageUrl} symbol={token.symbol} size={48} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="display text-sm font-bold truncate" style={{ color: "var(--ink)" }}>
              {token.name}
            </span>
            <span
              className="px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{ background: "rgba(18,45,69,0.08)", color: "var(--ink-2)" }}
            >
              ${token.symbol}
            </span>
            {token.graduated && (
              <span
                className="px-2 py-0.5 rounded-full text-xs font-semibold"
                style={{ background: "rgba(26,128,71,0.12)", color: "var(--success)" }}
              >
                Graduated
              </span>
            )}
          </div>
          <p
            className="text-xs mt-0.5 line-clamp-2"
            style={{ color: "var(--muted)" }}
          >
            {token.description || "No description"}
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="text-center">
          <p className="text-xs" style={{ color: "var(--muted)" }}>Mkt Cap</p>
          <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
            {mcapRlo >= 0.001 ? mcapRlo.toFixed(2) : "0"} RLO
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs" style={{ color: "var(--muted)" }}>Price</p>
          <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
            {token.currentPrice > 0
              ? formatRlo(token.currentPrice * 1_000_000_000, 6)
              : "0"} RLO
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs" style={{ color: "var(--muted)" }}>Trades</p>
          <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
            {token.tradeCount}
          </p>
        </div>
      </div>

      {/* Bonding curve progress */}
      <ProgressBar
        value={token.progressPct}
        label="Bonding curve"
        graduated={token.graduated}
      />

      {/* Footer: RLO raised / graduation target */}
      <div className="flex items-center justify-between text-xs" style={{ color: "var(--subtle)" }}>
        <span>{timeAgo(token.createdAt)}</span>
        {token.graduated ? (
          <span style={{ color: "var(--success)" }}>Graduated</span>
        ) : (
          <span>
            {((token.realRloRaised ?? 0) / 1_000_000_000).toFixed(2)} / {((token.graduationTarget ?? 85_000_000_000) / 1_000_000_000).toFixed(0)} RLO
          </span>
        )}
      </div>
    </GlassCard>
  );
}
