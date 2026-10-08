/**
 * CreatorPanel — shown on TokenView when the connected wallet is the token creator.
 * Lets the creator:
 *  1. Claim accumulated creator earnings (from token tax on all trades)
 *  2. Update the creator tax rate (0–10%)
 */
import { useState } from "react";
import { GlassCard, InnerField } from "./ui/GlassCard";
import { api } from "../api";
import type { Token, WalletState } from "../types";
import { keypairFromHex, buildSignedTxBytes, tokenIdToBytes } from "../rialo/chain";
import { buildClaimCreatorEarningsIx, buildUpdateTokenTaxIx } from "../rialo/program";
import { Loader2, DollarSign, Percent, ExternalLink, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { clsx } from "clsx";
import { formatRlo } from "../utils/crypto";

interface CreatorPanelProps {
  token: Token;
  wallet: WalletState;
  onRefresh: () => void;
}

const EXPLORER_BASE = "https://rialo-explorer-devnet-direct.vercel.app";
const KELVIN_PER_RLO = 1_000_000_000;

export function CreatorPanel({ token, wallet, onRefresh }: CreatorPanelProps) {
  const [claimBusy, setClaimBusy] = useState(false);
  const [taxBusy, setTaxBusy] = useState(false);
  const [newTaxPct, setNewTaxPct] = useState<number>((token.tokenTaxBps ?? 0) / 100);
  const [lastSig, setLastSig] = useState<string | null>(null);

  const earningsKelvin = token.creatorEarnings ?? 0;
  const earningsRlo = earningsKelvin / KELVIN_PER_RLO;
  const currentTaxBps = token.tokenTaxBps ?? 0;

  const handleClaim = async () => {
    if (earningsKelvin === 0) { toast.error("Nothing to claim yet"); return; }
    setClaimBusy(true);
    try {
      const tokenIdBytes = tokenIdToBytes(token.id);
      const keypair = keypairFromHex(wallet.secretHex);
      const ix = buildClaimCreatorEarningsIx({ tokenId: tokenIdBytes, creator: keypair.publicKey });
      const signedTxBase64 = await buildSignedTxBytes([ix], keypair);
      const result = await api.claimCreatorEarnings(token.id, signedTxBase64);
      setLastSig(result.signature);
      toast.success(`Claimed ${formatRlo(earningsKelvin)} RLO!`);
      onRefresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setClaimBusy(false);
    }
  };

  const handleUpdateTax = async () => {
    const newBps = Math.round(newTaxPct * 100);
    if (newBps === currentTaxBps) { toast("Tax unchanged"); return; }
    if (newBps < 0 || newBps > 1000) { toast.error("Tax must be 0–10%"); return; }
    setTaxBusy(true);
    try {
      const tokenIdBytes = tokenIdToBytes(token.id);
      const keypair = keypairFromHex(wallet.secretHex);
      const ix = buildUpdateTokenTaxIx({ tokenId: tokenIdBytes, creator: keypair.publicKey, newTaxBps: BigInt(newBps) });
      const signedTxBase64 = await buildSignedTxBytes([ix], keypair);
      const result = await api.updateTokenTax(token.id, signedTxBase64, newBps);
      setLastSig(result.signature);
      toast.success(`Creator tax updated to ${(newBps / 100).toFixed(1)}%`);
      onRefresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTaxBusy(false);
    }
  };

  return (
    <GlassCard className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: "rgba(18,45,69,0.08)" }}
        >
          <TrendingUp size={14} style={{ color: "var(--accent)" }} />
        </div>
        <h3 className="text-sm font-bold" style={{ color: "var(--ink)" }}>Creator Dashboard</h3>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "rgba(18,45,69,0.07)", color: "var(--ink-2)" }}>
          Only you see this
        </span>
      </div>

      {/* Earnings */}
      <div className="rounded-xl p-3 space-y-2" style={{ background: "rgba(18,45,69,0.04)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>Unclaimed Earnings</span>
          <span className="text-sm font-bold tabular-nums" style={{ color: earningsKelvin > 0 ? "var(--success)" : "var(--muted)" }}>
            {earningsRlo >= 0.001
              ? `${earningsRlo.toFixed(4)} RLO`
              : earningsKelvin > 0
                ? `${earningsKelvin} kelvin`
                : "0 RLO"}
          </span>
        </div>
        <p className="text-xs" style={{ color: "var(--subtle)" }}>
          Accrues from {(currentTaxBps / 100).toFixed(1)}% creator tax on every buy &amp; sell.
        </p>
        <button
          onClick={() => { void handleClaim(); }}
          disabled={claimBusy || earningsKelvin === 0}
          className={clsx(
            "w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
            (claimBusy || earningsKelvin === 0) && "opacity-50 cursor-not-allowed"
          )}
          style={{ background: earningsKelvin > 0 ? "var(--success)" : "rgba(18,45,69,0.06)", color: earningsKelvin > 0 ? "white" : "var(--muted)" }}
        >
          {claimBusy ? <Loader2 size={14} className="animate-spin" /> : <DollarSign size={14} />}
          {claimBusy ? "Claiming…" : earningsKelvin === 0 ? "No earnings yet" : `Claim ${earningsRlo.toFixed(4)} RLO`}
        </button>
      </div>

      {/* Update tax */}
      <div className="space-y-2">
        <label className="text-xs font-medium flex items-center gap-1" style={{ color: "var(--muted)" }}>
          <Percent size={12} /> Creator Tax Rate
          <span className="ml-auto font-bold tabular-nums" style={{ color: "var(--ink)" }}>
            {(currentTaxBps / 100).toFixed(1)}% current
          </span>
        </label>
        <InnerField className="flex items-center gap-3 px-4 py-3">
          <input
            type="range"
            min={0}
            max={10}
            step={0.5}
            value={newTaxPct}
            onChange={(e) => setNewTaxPct(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-sm font-bold tabular-nums w-12 text-right" style={{ color: "var(--ink)" }}>
            {newTaxPct.toFixed(1)}%
          </span>
        </InnerField>
        <button
          onClick={() => { void handleUpdateTax(); }}
          disabled={taxBusy || Math.round(newTaxPct * 100) === currentTaxBps}
          className={clsx(
            "w-full py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all active:scale-[0.98]",
            (taxBusy || Math.round(newTaxPct * 100) === currentTaxBps) && "opacity-50 cursor-not-allowed"
          )}
          style={{ background: "var(--accent)", color: "white" }}
        >
          {taxBusy ? <Loader2 size={14} className="animate-spin" /> : <Percent size={14} />}
          {taxBusy ? "Updating…" : `Update tax to ${newTaxPct.toFixed(1)}%`}
        </button>
      </div>

      {/* Last tx link */}
      {lastSig && (
        <a
          href={`${EXPLORER_BASE}/tx/${lastSig}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs rounded-xl px-3 py-2"
          style={{ background: "rgba(26,128,71,0.08)", color: "var(--success)" }}
        >
          <ExternalLink size={11} />
          View last transaction
        </a>
      )}
    </GlassCard>
  );
}
