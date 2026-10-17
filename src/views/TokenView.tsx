import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { Token, TradeRecord, WalletState } from "../types";
import type { RialoInstruction } from "../rialo/program";
import { TradePanel } from "../components/TradePanel";
import { BondingChart } from "../components/BondingChart";
import { TradesTable } from "../components/TradesTable";
import { CreatorPanel } from "../components/CreatorPanel";
import { TokenAvatar } from "../components/ui/TokenAvatar";
import { GlassCard } from "../components/ui/GlassCard";
import { ProgressBar } from "../components/ui/ProgressBar";
import { AIInsight } from "../components/AIInsight";
import { LiveBadge } from "../components/LiveBadge";
import { useOnchainToken } from "../hooks/useOnchainToken";
import { shortenAddress, formatLargeNumber, timeAgo, fmtPumpPrice, fmtUsd } from "../utils/crypto";
import { ArrowLeft, Copy, ExternalLink, Loader2, TrendingUp } from "lucide-react";
import { toast } from "sonner";

interface TokenViewProps {
  tokenId: string;
  wallet: WalletState | null;
  signTx: (instructions: RialoInstruction[]) => Promise<string>;
  onBack: () => void;
  isMobile: boolean;
}

export function TokenView({ tokenId, wallet, signTx, onBack, isMobile }: TokenViewProps) {
  const [token, setToken] = useState<Token | null>(null);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  // Live onchain state — separate polling so we always show chain-verified values
  const { onchainState, syncing, lastSyncedAt } = useOnchainToken(tokenId);

  const load = useCallback(async () => {
    try {
      const [t, trs] = await Promise.all([api.token(tokenId), api.trades(tokenId)]);
      setToken(t); setTrades(trs); setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [tokenId]);

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(id);
  }, [load]);

  // Merge live onchain values into the displayed token
  const liveToken: Token | null = token && onchainState ? {
    ...token,
    tokenSupply: onchainState.tokensSold,
    graduated: onchainState.graduated,
    tokenTaxBps: onchainState.tokenTaxBps,
    creatorEarnings: onchainState.creatorEarnings,
    realRloRaised: onchainState.realRloRaised,
    progressPct: Math.min(100, (onchainState.realRloRaised / (token.graduationTarget ?? 85)) * 100),
  } : token;

  if (loading) return (
    <div className="flex items-center justify-center py-24 gap-3">
      <Loader2 size={22} className="animate-spin" style={{ color: "var(--accent)" }} />
      <p className="text-sm" style={{ color: "var(--muted)" }}>Loading…</p>
    </div>
  );

  if (error || !token) return (
    <GlassCard className="p-8 text-center space-y-3">
      <p className="text-sm" style={{ color: "var(--danger)" }}>{error ?? "Token not found"}</p>
      <button onClick={onBack} className="btn-primary text-sm px-5 py-2 rounded-xl">Go back</button>
    </GlassCard>
  );

  const displayToken = liveToken ?? token;
  const isCreator = wallet?.pubkey === token.creator;

  return (
    <div className="space-y-4">

      {/* ── Token Header ── */}
      <div className="flex items-start gap-3">
        <button
          onClick={onBack}
          className="mt-1 w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all active:scale-95"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <ArrowLeft size={14} style={{ color: "var(--ink)" }} />
        </button>

        <div className="flex items-center gap-3 flex-1 min-w-0">
          <TokenAvatar imageUrl={displayToken.imageUrl} symbol={displayToken.symbol} size={44} />

          <div className="flex-1 min-w-0">
            {/* Name + badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="display font-bold text-base leading-tight" style={{ color: "var(--ink)" }}>
                {displayToken.name}
              </span>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold"
                style={{ background: "var(--surface-strong)", color: "var(--ink-2)" }}>
                ${displayToken.symbol}
              </span>
              {displayToken.graduated && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold"
                  style={{ background: "rgba(26,128,71,0.14)", color: "var(--success)" }}>
                  ✓ Graduated
                </span>
              )}
              <LiveBadge syncing={syncing} />
              {lastSyncedAt && (
                <span className="text-[10px]" style={{ color: "var(--subtle)" }}>
                  chain · {new Date(lastSyncedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            {/* Sub-line: price + meta */}
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              <span className="mono text-sm font-bold" style={{ color: "var(--accent)" }}>
                {fmtPumpPrice(displayToken.currentPrice ?? 0, 4)} RLO
              </span>
              {(displayToken.priceUsd ?? 0) > 0 && (
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {fmtUsd(displayToken.priceUsd ?? 0, 8)}
                </span>
              )}
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                by {shortenAddress(displayToken.creator, 5)} · {timeAgo(displayToken.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      {isMobile ? (
        <div className="space-y-4">
          <BondingChart token={displayToken} trades={trades} />
          <TradePanel token={displayToken} wallet={wallet} signTx={signTx} onTrade={() => { void load(); }} />
          {isCreator && <CreatorPanel token={displayToken} wallet={wallet} signTx={signTx} onRefresh={() => { void load(); }} />}
          <AIInsight tokenId={tokenId} />
          <TokenInfo token={displayToken} />
          <TradesTable trades={trades} />
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_360px] gap-4 items-start">
          <div className="space-y-4">
            <BondingChart token={displayToken} trades={trades} />
            <TokenInfo token={displayToken} />
            <TradesTable trades={trades} />
          </div>
          <div className="space-y-3">
            <TradePanel token={displayToken} wallet={wallet} signTx={signTx} onTrade={() => { void load(); }} />
            {isCreator && <CreatorPanel token={displayToken} wallet={wallet} signTx={signTx} onRefresh={() => { void load(); }} />}
            <AIInsight tokenId={tokenId} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Token Info Panel ──────────────────────────────────────────────────────────

function TokenInfo({ token }: { token: Token }) {
  const copy = (v: string) => void navigator.clipboard.writeText(v).then(() => toast.success("Copied"));

  const explorerUrl = `https://rialo-explorer-devnet-direct.vercel.app/accounts/${token.creator}`;

  return (
    <GlassCard className="p-4 space-y-4">

      {/* Description */}
      {token.description && (
        <p className="text-sm leading-relaxed" style={{ color: "var(--ink-2)" }}>{token.description}</p>
      )}

      {/* Compact stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {[
          { label: "Price",        value: `${fmtPumpPrice(token.currentPrice ?? 0, 4)} RLO` },
          { label: "Mkt Cap",      value: (token.tokenSupply ?? 0) > 0
            ? `${(token.marketCap ?? 0) >= 0.001 ? (token.marketCap ?? 0).toFixed(3) : fmtPumpPrice(token.marketCap ?? 0, 3)} RLO`
            : "—" },
          { label: "Tokens Sold",  value: formatLargeNumber(token.tokenSupply ?? 0) },
          { label: "Total Supply", value: formatLargeNumber(token.totalSupply ?? 1_000_000_000) },
          { label: "Trades",       value: (token.tradeCount ?? 0).toString() },
          { label: "Creator Tax",  value: `${((token.tokenTaxBps ?? 0) / 100).toFixed(1)}%` },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg p-2.5"
            style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{label}</p>
            <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: "var(--ink)" }}>{value}</p>
          </div>
        ))}
      </div>

      {/* Graduation progress */}
      <ProgressBar
        value={token.progressPct ?? 0}
        label={`${(token.realRloRaised ?? 0).toFixed(4)} / ${(token.graduationTarget ?? 85).toFixed(0)} RLO raised`}
        graduated={token.graduated}
      />

      {/* Creator row */}
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: "var(--muted)" }}>Creator</span>
        <div className="flex items-center gap-1.5">
          <span className="mono text-xs" style={{ color: "var(--ink-2)" }}>
            {shortenAddress(token.creator, 8)}
          </span>
          <button onClick={() => copy(token.creator)}
            className="p-1 rounded-md transition-opacity hover:opacity-60 active:scale-95">
            <Copy size={11} style={{ color: "var(--muted)" }} />
          </button>
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
            className="p-1 rounded-md transition-opacity hover:opacity-60">
            <ExternalLink size={11} style={{ color: "var(--muted)" }} />
          </a>
        </div>
      </div>

      {/* Devnet badge */}
      <div className="flex items-center gap-1.5">
        <TrendingUp size={11} style={{ color: "var(--accent)" }} />
        <span className="text-xs" style={{ color: "var(--muted)" }}>Rialo Devnet · Program {token.id.slice(0, 8)}…</span>
      </div>

    </GlassCard>
  );
}
