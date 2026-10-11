import { useState, useEffect, useCallback, useRef } from "react";
import { GlassCard, InnerField } from "./ui/GlassCard";
import { api } from "../api";
import type { Token, WalletState } from "../types";
import { TrendingUp, TrendingDown, Loader2, AlertCircle, CheckCircle2, ExternalLink, Wallet } from "lucide-react";
import { toast } from "sonner";
import { clsx } from "clsx";
import { tokenIdToBytes } from "../rialo/chain";
import { buildBuyIx, buildSellIx } from "../rialo/program";
import { fmtPumpPrice } from "../utils/crypto";
import type { RialoInstruction } from "../rialo/program";

interface QuoteResult {
  tokensOut?: number;
  rloOut?: number;
  fee: number;
  creatorTax?: number;
  price: number;
  currentPrice: number;
}

interface TradePanelProps {
  token: Token;
  wallet: WalletState | null;
  signTx: (instructions: RialoInstruction[]) => Promise<string>;
  onTrade: () => void | Promise<void>;
}

type TxState = "idle" | "quoting" | "signing" | "confirming" | "success" | "error";

const EXPLORER_BASE = "https://rialo-explorer-devnet-direct.vercel.app";
const KELVIN = 1_000_000_000;

export function TradePanel({ token, wallet, signTx, onTrade }: TradePanelProps) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [txState, setTxState] = useState<TxState>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [rloBalance, setRloBalance] = useState<number>(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load balances when wallet or token changes
  const loadBalances = useCallback(async () => {
    if (!wallet?.pubkey) return;
    try {
      // RLO balance
      const bal = await api.balance(wallet.pubkey);
      setRloBalance(parseFloat(bal.rlo));
      // Token balance from portfolio
      const port = await api.portfolio(wallet.pubkey);
      const holding = port.find((h) => h.token.id === token.id);
      setTokenBalance(holding?.balance ?? 0);
    } catch { /* ignore */ }
  }, [wallet, token.id]);

  // oxlint-disable-next-line react/set-state-in-effect -- async balance fetch on wallet/token change is intentional
  useEffect(() => { void loadBalances(); }, [loadBalances]);

  // Re-fetch balances after a successful trade
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- refresh after confirmed trade is intentional
    if (txState === "success") void loadBalances();
  }, [txState, loadBalances]);

  const fetchQuote = useCallback(async (val: string) => {
    if (!val || parseFloat(val) <= 0) { setQuote(null); return; }
    setTxState("quoting");
    try {
      if (tab === "buy") {
        const q = await api.quoteBuy(token.id, parseFloat(val));
        setQuote(q);
      } else {
        const q = await api.quoteSell(token.id, parseFloat(val));
        setQuote(q);
      }
    } catch { /* ignore quote errors */ }
    setTxState("idle");
  }, [tab, token.id]);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { void fetchQuote(amount); }, 400);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [amount, tab, fetchQuote]);

  // % sell shortcuts
  const sellPct = (pct: number) => {
    const tokens = Math.floor(tokenBalance * pct / 100);
    if (tokens > 0) setAmount(tokens.toString());
  };

  const handleTrade = async () => {
    if (!wallet) { toast.error("Connect wallet first"); return; }
    if (!amount || parseFloat(amount) <= 0) { toast.error("Enter an amount"); return; }

    setTxState("signing");
    setErrorMsg(null);
    setTxHash(null);

    try {
      const tokenIdBytes = tokenIdToBytes(token.id);
      const { PublicKey } = await import("@rialo/ts-cdk");
      const traderPk = PublicKey.fromString(wallet.pubkey);

      if (tab === "buy") {
        const rloFloat = parseFloat(amount);
        if (rloFloat > rloBalance) { throw new Error(`Insufficient balance. You have ${rloBalance.toFixed(4)} RLO`); }
        const kelvin = BigInt(Math.round(rloFloat * KELVIN));
        const minTokensOut = quote?.tokensOut ? BigInt(Math.floor(quote.tokensOut * 0.95)) : 0n;
        const ix = buildBuyIx({ tokenId: tokenIdBytes, buyer: traderPk, rloAmount: kelvin, minTokensOut });
        const signedTxBase64 = await signTx([ix]);
        setTxState("confirming");
        const result = await api.buy(token.id, wallet.pubkey, rloFloat, signedTxBase64);
        toast.success(`Bought ${result.trade.tokenAmount.toLocaleString()} $${token.symbol}`);
        setTxHash(result.trade.txHash);
      } else {
        const tokenAmt = Math.round(parseFloat(amount));
        if (tokenAmt > tokenBalance) { throw new Error(`Insufficient balance. You hold ${tokenBalance.toLocaleString()} $${token.symbol}`); }
        const minRloOut = quote?.rloOut ? BigInt(Math.floor(quote.rloOut * 0.95 * KELVIN)) : 0n;
        const ix = buildSellIx({ tokenId: tokenIdBytes, seller: traderPk, tokenAmount: BigInt(tokenAmt), minRloOut });
        const signedTxBase64 = await signTx([ix]);
        setTxState("confirming");
        const result = await api.sell(token.id, wallet.pubkey, tokenAmt, signedTxBase64);
        toast.success(`Sold ${tokenAmt.toLocaleString()} $${token.symbol}`);
        setTxHash(result.trade.txHash);
      }

      setTxState("success");
      setAmount("");
      setQuote(null);
      void onTrade();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setTxState("error");
    }
  };

  const isBusy = txState === "quoting" || txState === "signing" || txState === "confirming";
  const isReal = txHash && !txHash.startsWith("sim_") && !txHash.startsWith("111111");

  return (
    <GlassCard className="p-4 space-y-4">
      {/* Tab row */}
      <div className="flex rounded-xl p-1" style={{ background: "var(--surface-muted)" }}>
        {(["buy", "sell"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setAmount(""); setQuote(null); setTxState("idle"); setErrorMsg(null); }}
            className={clsx(
              "flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2",
              tab === t && "shadow-sm"
            )}
            style={tab === t
              ? { background: "var(--surface-strong)", color: t === "buy" ? "var(--success)" : "var(--danger)" }
              : { color: "var(--muted)" }}
          >
            {t === "buy" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {t === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      {/* Balance row */}
      {wallet && (
        <div className="flex items-center justify-between text-xs px-1">
          <div className="flex items-center gap-1.5" style={{ color: "var(--muted)" }}>
            <Wallet size={11} />
            <span>Balance:</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
              {rloBalance >= 0.001 ? rloBalance.toFixed(4) : rloBalance.toExponential(2)} RLO
            </span>
            {tokenBalance > 0 && (
              <span className="font-semibold tabular-nums" style={{ color: "var(--ink-2)" }}>
                {tokenBalance.toLocaleString()} ${token.symbol}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Quick amounts */}
      {tab === "buy" ? (
        <div className="flex gap-2 flex-wrap">
          {[0.1, 0.5, 1, 5].map((q) => (
            <button
              key={q}
              onClick={() => setAmount(q.toString())}
              className="px-3 py-1 rounded-lg text-xs font-semibold transition-all active:scale-95"
              style={{ background: "var(--surface-strong)", border: "1px solid var(--border)", color: "var(--ink-2)" }}
            >
              {q} RLO
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              onClick={() => sellPct(pct)}
              disabled={tokenBalance <= 0}
              className="flex-1 py-1 rounded-lg text-xs font-semibold transition-all active:scale-95 disabled:opacity-40"
              style={{ background: "var(--surface-strong)", border: "1px solid var(--border)", color: "var(--ink-2)" }}
            >
              {pct}%
            </button>
          ))}
        </div>
      )}

      {/* Amount input */}
      <InnerField className="flex items-center gap-2 px-4 py-3">
        <input
          type="number"
          placeholder={tab === "buy" ? "RLO amount" : "Token amount"}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent outline-none text-lg font-bold tabular-nums"
          style={{ color: "var(--ink)" }}
          min="0"
          step={tab === "buy" ? "0.01" : "1"}
        />
        <span className="text-sm font-semibold" style={{ color: "var(--muted)" }}>
          {tab === "buy" ? "RLO" : `$${token.symbol}`}
        </span>
      </InnerField>

      {/* Token balance hint on sell */}
      {tab === "sell" && tokenBalance === 0 && wallet && (
        <p className="text-xs text-center" style={{ color: "var(--muted)" }}>
          You hold 0 ${token.symbol}
        </p>
      )}

      {/* Quote */}
      {quote && (
        <div className="rounded-xl p-3 space-y-1.5" style={{ background: "var(--surface-muted)", border: "1px solid var(--border)" }}>
          <div className="flex justify-between text-xs">
            <span style={{ color: "var(--muted)" }}>{tab === "buy" ? "Tokens received" : "RLO received"}</span>
            <span className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
              {tab === "buy"
                ? `~${(quote.tokensOut || 0).toLocaleString()} $${token.symbol}`
                : `~${(quote.rloOut || 0) >= 0.0001 ? (quote.rloOut || 0).toFixed(4) : (quote.rloOut || 0).toExponential(2)} RLO`}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span style={{ color: "var(--muted)" }}>Platform fee (1%)</span>
            <span className="font-medium tabular-nums" style={{ color: "var(--muted)" }}>
              {(quote.fee ?? 0) >= 0.0001 ? (quote.fee ?? 0).toFixed(4) : (quote.fee ?? 0).toExponential(2)} RLO
            </span>
          </div>
          {(quote.creatorTax ?? 0) > 0 && (
            <div className="flex justify-between text-xs">
              <span style={{ color: "var(--muted)" }}>
                Creator tax ({((token.tokenTaxBps ?? 0) / 100).toFixed(1)}%)
              </span>
              <span className="font-medium tabular-nums" style={{ color: "var(--muted)" }}>
                {(quote.creatorTax ?? 0) >= 0.0001 ? (quote.creatorTax ?? 0).toFixed(4) : (quote.creatorTax ?? 0).toExponential(2)} RLO
              </span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span style={{ color: "var(--muted)" }}>Price per token</span>
            <span className="font-medium tabular-nums" style={{ color: "var(--ink)" }}>
              {fmtPumpPrice(quote.currentPrice || 0, 4)} RLO
            </span>
          </div>
        </div>
      )}

      {/* Success */}
      {txState === "success" && txHash && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: "rgba(26,128,71,0.08)" }}>
          <CheckCircle2 size={16} style={{ color: "var(--success)" }} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold" style={{ color: "var(--success)" }}>
              {isReal ? "Confirmed onchain" : "Submitted to devnet"}
            </p>
            {isReal ? (
              <a
                href={`${EXPLORER_BASE}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs mono truncate flex items-center gap-1 hover:opacity-70"
                style={{ color: "var(--muted)" }}
              >
                {txHash.slice(0, 20)}… <ExternalLink size={10} />
              </a>
            ) : (
              <p className="text-xs mono truncate" style={{ color: "var(--muted)" }}>{txHash.slice(0, 24)}…</p>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {txState === "error" && errorMsg && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl" style={{ background: "rgba(186,43,76,0.08)" }}>
          <AlertCircle size={16} className="mt-0.5 shrink-0" style={{ color: "var(--danger)" }} />
          <p className="text-xs" style={{ color: "var(--danger)" }}>{errorMsg}</p>
        </div>
      )}

      {/* CTA */}
      <button
        onClick={() => { void handleTrade(); }}
        disabled={isBusy || !amount || parseFloat(amount) <= 0 || txState === "success"}
        className={clsx(
          "w-full py-3.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] flex items-center justify-center gap-2",
          (isBusy || !amount) && "opacity-50 cursor-not-allowed"
        )}
        style={{
          background: txState === "success" ? "var(--success)"
            : tab === "buy" ? "rgba(26,128,71,0.85)" : "rgba(186,43,76,0.85)",
          color: "white",
        }}
      >
        {(txState === "signing" || txState === "confirming") && <Loader2 size={16} className="animate-spin" />}
        {txState === "signing" ? "Signing…"
          : txState === "confirming" ? "Confirming…"
          : txState === "success" ? "Trade complete"
          : tab === "buy" ? `Buy $${token.symbol}` : `Sell $${token.symbol}`}
      </button>

      {!wallet && (
        <p className="text-center text-xs" style={{ color: "var(--muted)" }}>Connect a wallet to trade</p>
      )}
    </GlassCard>
  );
}
