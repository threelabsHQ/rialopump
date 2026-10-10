import { ProgressBar } from "./ui/ProgressBar";
import { TokenAvatar } from "./ui/TokenAvatar";
import type { Token } from "../types";
import { timeAgo } from "../utils/crypto";
import { Zap } from "lucide-react";

interface TokenCardProps {
  token: Token;
  onClick: () => void;
}

function fmtUsd(val: number): string {
  if (val === 0) return "$0";
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000)     return `$${(val / 1_000).toFixed(2)}K`;
  if (val >= 0.01)      return `$${val.toFixed(2)}`;
  if (val >= 0.000001)  return `$${val.toFixed(6)}`;
  return `$${val.toExponential(2)}`;
}

function fmtPriceUsd(val: number): string {
  if (val === 0) return "$0";
  if (val >= 0.01)     return `$${val.toFixed(4)}`;
  if (val >= 0.000001) return `$${val.toFixed(8)}`;
  return `$${val.toExponential(2)}`;
}

export function TokenCard({ token, onClick }: TokenCardProps) {
  const priceUsd   = token.priceUsd       ?? 0;
  const mcapUsd    = token.marketCapUsd   ?? 0;
  const rloRaised  = token.realRloRaised  ?? 0;
  const gradTarget = token.graduationTarget ?? 85;

  return (
    <div
      onClick={onClick}
      className="rounded-2xl cursor-pointer transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] overflow-hidden"
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--card-border)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {/* Top accent bar */}
      <div className="h-[3px] w-full" style={{ background: "linear-gradient(90deg,#4f9eff,#af8ff4,#f05c6b,#ffcd83)" }} />

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-3">
          <TokenAvatar imageUrl={token.imageUrl} symbol={token.symbol} size={46} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="display text-sm font-bold leading-tight" style={{ color: "var(--ink)" }}>
                {token.name}
              </span>
              <span className="px-1.5 py-0.5 rounded-md text-xs font-bold"
                style={{ background: "rgba(79,158,255,0.14)", color: "var(--accent)" }}>
                ${token.symbol}
              </span>
              {token.graduated && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-bold"
                  style={{ background: "rgba(52,210,122,0.14)", color: "var(--success)" }}>
                  <Zap size={9} /> Grad
                </span>
              )}
            </div>
            <p className="text-xs mt-0.5 line-clamp-1" style={{ color: "var(--muted)" }}>
              {token.description || "No description"}
            </p>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Mkt Cap", value: fmtUsd(mcapUsd) },
            { label: "Price",   value: fmtPriceUsd(priceUsd) },
            { label: "Trades",  value: String(token.tradeCount) },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl px-2 py-2 text-center"
              style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
              <p className="text-[10px] font-medium mb-0.5" style={{ color: "var(--muted)" }}>{label}</p>
              <p className="text-xs font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
            </div>
          ))}
        </div>

        {/* Bonding curve */}
        <ProgressBar value={token.progressPct} label="Bonding curve" graduated={token.graduated} />

        {/* Footer */}
        <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--subtle)" }}>
          <span>{timeAgo(token.createdAt)}</span>
          {token.graduated ? (
            <span className="font-semibold" style={{ color: "var(--success)" }}>Graduated 🎓</span>
          ) : (
            <span className="tabular-nums">
              {rloRaised >= 0.001 ? rloRaised.toFixed(2) : rloRaised.toExponential(1)} / {gradTarget.toFixed(0)} RLO
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
