import { useMemo } from "react";
import type { Token, TradeRecord } from "../types";

interface BondingChartProps {
  token: Token;
  trades?: TradeRecord[];
}

const spectral = "linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b)";

export function BondingChart({ token, trades = [] }: BondingChartProps) {
  const GRADUATION = 800_000_000;
  const KELVIN = 1_000_000_000;

  // Build price history from trades
  const priceHistory = useMemo(() => {
    if (!trades.length) return [];
    const points = trades.slice().reverse().map((t, i) => ({
      i,
      price: t.price * KELVIN, // convert to RLO per token
      type: t.type,
      time: t.timestamp,
    }));
    return points;
  }, [trades]);

  // SVG line chart
  const width = 320;
  const height = 80;
  const pad = { top: 8, right: 8, bottom: 20, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const path = useMemo(() => {
    if (priceHistory.length < 2) return null;
    const prices = priceHistory.map((p) => p.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const range = maxP - minP || 1;
    const xStep = innerW / (priceHistory.length - 1);
    const pts = priceHistory.map((p, i) => {
      const x = pad.left + i * xStep;
      const y = pad.top + innerH - ((p.price - minP) / range) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return "M" + pts.join(" L");
  }, [priceHistory, innerW, innerH, pad.left, pad.top]);

  const lastPrice = priceHistory.length
    ? priceHistory[priceHistory.length - 1].price
    : token.currentPrice * KELVIN;

  const isUp = priceHistory.length >= 2
    ? priceHistory[priceHistory.length - 1].price >= priceHistory[0].price
    : true;

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: "rgba(255,255,255,0.64)",
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: "1px solid rgba(255,255,255,0.68)",
        boxShadow: "0 8px 32px rgba(18,45,69,0.08)",
      }}
    >
      {/* Spectral strip */}
      <div className="h-1" style={{ background: spectral }} />

      <div className="p-4 space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs font-medium" style={{ color: "var(--muted)" }}>Current Price</p>
            <p className="display text-2xl font-bold tabular-nums" style={{ color: "var(--ink)", letterSpacing: "-0.03em" }}>
              {lastPrice < 0.000001 ? lastPrice.toExponential(3) : lastPrice.toFixed(8)}
              <span className="text-base ml-1 font-semibold" style={{ color: "var(--muted)" }}>RLO</span>
            </p>
          </div>
          <div
            className="px-2 py-1 rounded-lg text-xs font-semibold"
            style={{
              background: isUp ? "rgba(26,128,71,0.10)" : "rgba(186,43,76,0.10)",
              color: isUp ? "var(--success)" : "var(--danger)",
            }}
          >
            {isUp ? "▲" : "▼"} bonding
          </div>
        </div>

        {/* Chart */}
        {path ? (
          <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
            <defs>
              <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={isUp ? "#1a8047" : "#ba2b4c"} stopOpacity="0.18" />
                <stop offset="100%" stopColor={isUp ? "#1a8047" : "#ba2b4c"} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={path + ` L${pad.left + innerW},${pad.top + innerH} L${pad.left},${pad.top + innerH} Z`}
              fill="url(#chartGrad)"
            />
            <path
              d={path}
              fill="none"
              stroke={isUp ? "#1a8047" : "#ba2b4c"}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <div
            className="h-12 rounded-xl flex items-center justify-center text-xs"
            style={{ background: "rgba(18,45,69,0.04)", color: "var(--muted)" }}
          >
            No trades yet — be the first
          </div>
        )}

        {/* Progress to graduation */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span style={{ color: "var(--muted)" }}>
              Bonding curve progress
            </span>
            <span className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
              {token.progressPct.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(18,45,69,0.08)" }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${token.progressPct}%`,
                background: token.graduated ? "var(--success)" : spectral,
              }}
            />
          </div>
          <p className="text-xs" style={{ color: "var(--subtle)" }}>
            {token.graduated
              ? "Graduated to full DEX"
              : `${((GRADUATION - token.tokenSupply) / 1_000_000).toFixed(1)}M tokens until graduation`}
          </p>
        </div>
      </div>
    </div>
  );
}
