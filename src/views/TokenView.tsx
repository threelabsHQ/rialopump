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
import { shortenAddress, formatLargeNumber, timeAgo } from "../utils/crypto";
import { ArrowLeft, Copy, Loader2 } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, trs] = await Promise.all([
        api.token(tokenId),
        api.trades(tokenId),
      ]);
      setToken(t);
      setTrades(trs);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tokenId]);

  // eslint-disable-next-line react/set-state-in-effect -- load() updates state only after async fetch
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 gap-3">
        <Loader2 size={24} className="animate-spin" style={{ color: "var(--muted)" }} />
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading token…</p>
      </div>
    );
  }

  if (error || !token) {
    return (
      <GlassCard className="p-6 text-center">
        <p className="text-sm" style={{ color: "var(--danger)" }}>{error || "Token not found"}</p>
        <button onClick={onBack} className="mt-3 text-sm px-4 py-2 rounded-xl" style={{ background: "var(--accent)", color: "white" }}>
          Go back
        </button>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back + token header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-xl flex items-center justify-center transition-all active:scale-95"
          style={{ background: "var(--surface)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "1px solid var(--border)" }}
        >
          <ArrowLeft size={16} style={{ color: "var(--ink)" }} />
        </button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <TokenAvatar imageUrl={token.imageUrl} symbol={token.symbol} size={40} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="display text-base font-bold" style={{ color: "var(--ink)" }}>{token.name}</span>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: "var(--surface-strong)", color: "var(--ink-2)" }}>
                ${token.symbol}
              </span>
              {token.graduated && (
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: "rgba(26,128,71,0.12)", color: "var(--success)" }}>
                  Graduated
                </span>
              )}
            </div>
            <p className="text-xs truncate" style={{ color: "var(--muted)" }}>
              by {shortenAddress(token.creator, 6)} · {timeAgo(token.createdAt)}
            </p>
          </div>
        </div>
      </div>

      {isMobile ? (
        // Mobile layout: stacked
        <div className="space-y-4">
          <BondingChart token={token} trades={trades} />
          <TradePanel token={token} wallet={wallet} signTx={signTx} onTrade={() => { void load(); }} />
          {wallet && wallet.pubkey === token.creator && (
            <CreatorPanel token={token} wallet={wallet} signTx={signTx} onRefresh={() => { void load(); }} />
          )}
          <TokenInfo token={token} trades={trades} />
          <TradesTable trades={trades} />
        </div>
      ) : (
        // Desktop layout: 2-column
        <div className="grid grid-cols-[1fr_380px] gap-4">
          <div className="space-y-4">
            <BondingChart token={token} trades={trades} />
            <TokenInfo token={token} trades={trades} />
            <TradesTable trades={trades} />
          </div>
          <div className="space-y-4">
            <TradePanel token={token} wallet={wallet} signTx={signTx} onTrade={() => { void load(); }} />
            {wallet && wallet.pubkey === token.creator && (
              <CreatorPanel token={token} wallet={wallet} signTx={signTx} onRefresh={() => { void load(); }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TokenInfo({ token, trades }: { token: Token; trades: TradeRecord[] }) {
  const copy = (text: string) => { void navigator.clipboard.writeText(text).then(() => toast.success("Copied")); };

  const stats = [
    { label: "Total Supply", value: formatLargeNumber(token.totalSupply) },
    { label: "Tokens Sold", value: formatLargeNumber(token.tokenSupply) },
    { label: "Mkt Cap", value: `${token.marketCap >= 0.001 ? token.marketCap.toFixed(3) : token.marketCap.toExponential(2)} RLO` },
    { label: "Trades", value: token.tradeCount?.toString() || trades.length.toString() },
  ];

  return (
    <GlassCard className="p-4 space-y-3">
      <h3 className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Token Info</h3>
      {token.description && (
        <p className="text-sm" style={{ color: "var(--muted)" }}>{token.description}</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl p-3" style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{s.label}</p>
            <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>{s.value}</p>
          </div>
        ))}
      </div>
      <ProgressBar
        value={token.progressPct}
        label={`Graduation — ${(token.realRloRaised ?? 0).toFixed(2)} / ${(token.graduationTarget ?? 85).toFixed(0)} RLO raised`}
        graduated={token.graduated}
      />
      <div className="flex items-center justify-between text-xs pt-1">
        <span style={{ color: "var(--muted)" }}>Creator</span>
        <div className="flex items-center gap-2">
          <span className="mono" style={{ color: "var(--ink-2)" }}>{token.creator.slice(0, 12)}…</span>
          <button onClick={() => copy(token.creator)} className="p-1 rounded hover:opacity-70">
            <Copy size={11} style={{ color: "var(--muted)" }} />
          </button>
        </div>
      </div>
    </GlassCard>
  );
}
