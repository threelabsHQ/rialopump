import { useState, useEffect } from "react";
import { api, type PortfolioHolding } from "../api";
import type { WalletState } from "../types";
import { GlassCard } from "../components/ui/GlassCard";
import { TokenAvatar } from "../components/ui/TokenAvatar";
import { formatLargeNumber } from "../utils/crypto";
import { Loader2, TrendingUp, TrendingDown, Briefcase } from "lucide-react";

interface PortfolioViewProps {
  wallet: WalletState | null;
  onSelectToken: (id: string) => void;
}

export function PortfolioView({ wallet, onSelectToken }: PortfolioViewProps) {
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [loading, setLoading] = useState(false);

  // oxlint-disable-next-line react/set-state-in-effect -- loading spinner before async fetch is intentional
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setLoading(true);
    api.portfolio(wallet.pubkey)
      .then((data) => { if (!cancelled) setHoldings(data); })
      .catch(() => { if (!cancelled) setHoldings([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [wallet]);

  if (!wallet) {
    return (
      <GlassCard className="p-8 text-center">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: "var(--surface)" }}>
          <Briefcase size={20} style={{ color: "var(--muted)" }} />
        </div>
        <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>No wallet connected</p>
        <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Connect a wallet to see your portfolio</p>
      </GlassCard>
    );
  }

  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  const totalPnl = holdings.reduce((s, h) => s + h.pnl, 0);

  const fmtRlo = (v: number) => v >= 0.0001 ? v.toFixed(4) : v.toExponential(2);

  return (
    <div className="space-y-4">
      {/* Summary */}
      <GlassCard className="p-4">
        <p className="text-xs font-medium" style={{ color: "var(--muted)" }}>Portfolio Value</p>
        <p className="display text-3xl font-bold tabular-nums mt-1" style={{ color: "var(--ink)", letterSpacing: "-0.03em" }}>
          {fmtRlo(totalValue)} <span className="text-lg" style={{ color: "var(--muted)" }}>RLO</span>
        </p>
        <div className="flex items-center gap-1 mt-1">
          {totalPnl >= 0
            ? <TrendingUp size={14} style={{ color: "var(--success)" }} />
            : <TrendingDown size={14} style={{ color: "var(--danger)" }} />}
          <span
            className="text-sm font-semibold tabular-nums"
            style={{ color: totalPnl >= 0 ? "var(--success)" : "var(--danger)" }}
          >
            {totalPnl >= 0 ? "+" : ""}{fmtRlo(totalPnl)} RLO
          </span>
        </div>
      </GlassCard>

      {/* Holdings */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={20} className="animate-spin" style={{ color: "var(--muted)" }} />
        </div>
      ) : holdings.length === 0 ? (
        <GlassCard className="p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>No positions yet</p>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Buy tokens to build your portfolio</p>
        </GlassCard>
      ) : (
        <div className="space-y-2">
          {holdings.map((h) => {
            const pct = (h.value / totalValue) * 100;
            return (
              <GlassCard
                key={h.token.id}
                hover
                onClick={() => onSelectToken(h.token.id)}
                className="p-4"
              >
                <div className="flex items-center gap-3">
                  <TokenAvatar imageUrl={h.token.imageUrl} symbol={h.token.symbol} size={44} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="display text-sm font-bold truncate" style={{ color: "var(--ink)" }}>
                        {h.token.name}
                      </span>
                      <span className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                        {fmtRlo(h.value)} RLO
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-xs" style={{ color: "var(--muted)" }}>
                        {formatLargeNumber(h.balance)} ${h.token.symbol}
                      </span>
                      <span
                        className="text-xs font-medium tabular-nums"
                        style={{ color: h.pnl >= 0 ? "var(--success)" : "var(--danger)" }}
                      >
                        {h.pnl >= 0 ? "+" : ""}{fmtRlo(h.pnl)} RLO
                      </span>
                    </div>
                    {/* Weight bar */}
                    <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: "var(--surface-strong)" }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: "var(--accent)" }}
                      />
                    </div>
                  </div>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
