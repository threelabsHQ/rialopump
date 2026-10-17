/**
 * AIInsight — market analysis panel for a token.
 *
 * Shows immediately with heuristic data, then silently upgrades to
 * AI-powered analysis when the Fable-5 run completes.
 * Never shows a placeholder — always has real chain-derived data.
 */
import { useAnalysis } from "../hooks/useAnalysis";
import type { AnalysisResult } from "../api";
import { Brain, TrendingUp, TrendingDown, Minus, RefreshCw, Loader2, Shield, Zap } from "lucide-react";
import { clsx } from "clsx";

interface AIInsightProps {
  tokenId: string;
}

const SENTIMENT_COLOR: Record<AnalysisResult["sentiment"], string> = {
  bullish: "var(--success)",
  bearish: "var(--danger)",
  neutral: "var(--warn)",
};

const SENTIMENT_ICON: Record<AnalysisResult["sentiment"], React.ReactNode> = {
  bullish: <TrendingUp size={14} />,
  bearish: <TrendingDown size={14} />,
  neutral: <Minus size={14} />,
};

const RISK_COLOR: Record<AnalysisResult["riskLevel"], string> = {
  low:    "var(--success)",
  medium: "var(--warn)",
  high:   "var(--danger)",
};

function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--surface-strong)" }}>
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }}
      />
    </div>
  );
}

export function AIInsight({ tokenId }: AIInsightProps) {
  const { analysis, loading, upgrading, refresh } = useAnalysis(tokenId);

  if (loading && !analysis) {
    return (
      <div
        className="rounded-2xl p-4"
        style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Brain size={16} style={{ color: "var(--accent)" }} />
          <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Market Analysis</span>
        </div>
        <div className="flex items-center gap-2 py-4 justify-center">
          <Loader2 size={16} className="animate-spin" style={{ color: "var(--muted)" }} />
          <span className="text-xs" style={{ color: "var(--muted)" }}>Analysing chain data…</span>
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const sentColor = SENTIMENT_COLOR[analysis.sentiment];
  const sentIcon  = SENTIMENT_ICON[analysis.sentiment];

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", boxShadow: "var(--shadow-card)" }}
    >
      {/* Header bar */}
      <div className="h-[3px]" style={{ background: "linear-gradient(90deg,#4f9eff,#af8ff4,#f05c6b)" }} />

      <div className="p-4 space-y-4">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain size={16} style={{ color: "var(--accent)" }} />
            <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Market Analysis</span>
            {upgrading && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                style={{ background: "rgba(79,158,255,0.12)", color: "var(--accent)" }}>
                <Loader2 size={10} className="animate-spin" /> upgrading
              </span>
            )}
            {analysis.source === "ai" && !upgrading && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                style={{ background: "rgba(52,210,122,0.12)", color: "var(--success)" }}>
                <Zap size={10} /> AI
              </span>
            )}
          </div>
          <button
            onClick={refresh}
            className="w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:opacity-70"
            style={{ background: "var(--surface)" }}
            title="Refresh analysis"
          >
            <RefreshCw size={12} style={{ color: "var(--muted)" }} />
          </button>
        </div>

        {/* Summary */}
        <p className="text-sm leading-relaxed" style={{ color: "var(--ink-2)" }}>
          {analysis.summary}
        </p>

        {/* Score grid */}
        <div className="grid grid-cols-3 gap-3">
          {/* Sentiment */}
          <div className="rounded-xl p-3 space-y-1.5" style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
            <p className="text-[10px] font-medium" style={{ color: "var(--muted)" }}>Sentiment</p>
            <div className="flex items-center gap-1.5">
              <span style={{ color: sentColor }}>{sentIcon}</span>
              <span className="text-xs font-bold capitalize" style={{ color: sentColor }}>{analysis.sentiment}</span>
            </div>
            <ScoreBar value={analysis.sentimentScore} color={sentColor} />
          </div>

          {/* Graduation odds */}
          <div className="rounded-xl p-3 space-y-1.5" style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
            <p className="text-[10px] font-medium" style={{ color: "var(--muted)" }}>Grad Odds</p>
            <p className="text-xs font-bold tabular-nums" style={{ color: "var(--accent)" }}>
              {analysis.graduationOdds}%
            </p>
            <ScoreBar value={analysis.graduationOdds} color="var(--accent)" />
          </div>

          {/* Risk */}
          <div className="rounded-xl p-3 space-y-1.5" style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
            <p className="text-[10px] font-medium" style={{ color: "var(--muted)" }}>Risk</p>
            <div className="flex items-center gap-1">
              <Shield size={11} style={{ color: RISK_COLOR[analysis.riskLevel] }} />
              <span className="text-xs font-bold capitalize" style={{ color: RISK_COLOR[analysis.riskLevel] }}>
                {analysis.riskLevel}
              </span>
            </div>
            <ScoreBar
              value={analysis.riskLevel === "low" ? 33 : analysis.riskLevel === "medium" ? 66 : 100}
              color={RISK_COLOR[analysis.riskLevel]}
            />
          </div>
        </div>

        {/* Signals */}
        {analysis.signals.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Signals</p>
            <ul className="space-y-1.5">
              {analysis.signals.map((sig, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: "var(--ink-2)" }}>
                  <span className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--accent)" }} />
                  {sig}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ETA */}
        <div className="flex items-center justify-between text-xs pt-1 border-t" style={{ borderColor: "var(--border)" }}>
          <span style={{ color: "var(--muted)" }}>Graduation ETA: <strong style={{ color: "var(--ink-2)" }}>{analysis.graduationEta}</strong></span>
          <span className={clsx("text-[10px]", analysis.source === "ai" ? "" : "")} style={{ color: "var(--subtle)" }}>
            {analysis.source === "ai" ? "Fable 5 AI" : "Chain heuristic"} · {new Date(analysis.generatedAt).toLocaleTimeString()}
          </span>
        </div>
      </div>
    </div>
  );
}
