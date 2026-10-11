import { useMemo } from "react";
import type { Token, TradeRecord } from "../types";

interface BondingChartProps {
  token: Token;
  trades?: TradeRecord[];
}

const spectral = "linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b)";

export function BondingChart({ token, trades = [] }: BondingChartProps) {
  // Build price history from trades.
  // trade.price is already in RLO/token from the server.
  const priceHistory = useMemo(() => {
    if (!trades.length) return [];
    return trades.slice().reverse().map((t, i) => ({
      i,
      // trade.price may be kelvin/token (legacy) or RLO/token (new).
      // Values > 1 are kelvin (pump.fun prices are always < 1 RLO/token).
      price: t.price > 1 ? t.price / 1_000_000_000 : t.price,
      type: t.type,
      time: t.timestamp,
    }));
  }, [trades]);

  // SVG line chart dimensions
  const width  = 320;
  const height = 80;
  const pad    = { top: 8, right: 8, bottom: 4, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const path = useMemo(() => {
    if (priceHistory.length < 2) return null;
    const prices = priceHistory.map((p) => p.price);
    const minP   = Math.min(...prices);
    const maxP   = Math.max(...prices);
    const range  = maxP - minP || 1;
    const xStep  = innerW / (priceHistory.length - 1);
    const pts    = priceHistory.map((p, i) => {
      const x = pad.left + i * xStep;
      const y = pad.top + innerH - ((p.price - minP) / range) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return "M" + pts.join(" L");
  }, [priceHistory, innerW, innerH, pad.left, pad.top]);

  // Current displayed price (RLO/token)
  const lastPrice = priceHistory.length
    ? priceHistory[priceHistory.length - 1].price
    : (token.currentPrice ?? 0);

  const isUp = priceHistory.length >= 2
    ? priceHistory[priceHistory.length - 1].price >= priceHistory[0].price
    : true;

  // Graduation progress
  const gradTarget = token.graduationTarget ?? 85;
  const rloRaised  = token.realRloRaised    ?? 0;
  const pct        = Math.min(100, token.progressPct ?? 0);
  const rloLeft    = Math.max(0, gradTarget - rloRaised);

  // Price display
  const priceStr = lastPrice === 0
    ? "0"
    : lastPrice < 0.000001
    ? lastPrice.toExponential(3)
    : lastPrice.toFixed(8);

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background:           "var(--card-bg)",
        backdropFilter:       "var(--glass-blur)",
        WebkitBackdropFilter: "var(--glass-blur)",
        border:               "1px solid var(--card-border)",
        boxShadow:            "var(--shadow-card)",
      }}
    >
      {/* Spectral accent strip */}
      <div className="h-1" style={{ background: spectral }} />

      <div className="p-4 space-y-3">
        {/* Price header */}
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs font-medium" style={{ color: "var(--muted)" }}>Current Price</p>
            <p className="display text-2xl font-bold tabular-nums" style={{ color: "var(--ink)", letterSpacing: "-0.03em" }}>
              {priceStr}
              <span className="text-sm ml-1 font-semibold" style={{ color: "var(--muted)" }}>RLO</span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div
              className="px-2 py-1 rounded-lg text-xs font-semibold"
              style={{
                background: isUp ? "rgba(26,128,71,0.12)" : "rgba(186,43,76,0.12)",
                color:      isUp ? "var(--success)"       : "var(--danger)",
              }}
            >
              {isUp ? "▲" : "▼"} {priceHistory.length >= 2 ? "trending" : "bonding"}
            </div>
            {token.priceUsd !== undefined && token.priceUsd > 0 && (
              <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                ≈ ${token.priceUsd < 0.000001
                  ? token.priceUsd.toExponential(2)
                  : token.priceUsd.toFixed(8)}
              </span>
            )}
          </div>
        </div>

        {/* Price chart */}
        {path ? (
          <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={isUp ? "#34d27a" : "#f05c6b"} stopOpacity="0.20" />
                <stop offset="100%" stopColor={isUp ? "#34d27a" : "#f05c6b"} stopOpacity="0.00" />
              </linearGradient>
            </defs>
            {/* Area fill */}
            <path
              d={path + ` L${pad.left + innerW},${pad.top + innerH} L${pad.left},${pad.top + innerH} Z`}
              fill="url(#chartGrad)"
            />
            {/* Line */}
            <path
              d={path}
              fill="none"
              stroke={isUp ? "#34d27a" : "#f05c6b"}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <div
            className="h-16 rounded-xl flex flex-col items-center justify-center gap-1"
            style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}
          >
            <span className="text-xs font-semibold" style={{ color: "var(--ink-2)" }}>No trades yet</span>
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>Be the first to buy</span>
          </div>
        )}

        {/* Bonding curve progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span style={{ color: "var(--muted)" }}>Bonding curve</span>
            <span className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
              {pct.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--surface-strong)" }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width:      `${Math.max(pct, pct > 0 ? 2 : 0)}%`,
                background: token.graduated ? "var(--success)" : spectral,
              }}
            />
          </div>
          <p className="text-[11px]" style={{ color: "var(--subtle)" }}>
            {token.graduated
              ? "🎓 Graduated — full DEX liquidity unlocked"
              : rloLeft < 0.001
              ? `${(rloRaised * 1000).toFixed(2)} mRLO raised of ${gradTarget} RLO target`
              : `${rloLeft.toFixed(2)} RLO remaining until graduation`}
          </p>
        </div>
      </div>
    </div>
  );
}
