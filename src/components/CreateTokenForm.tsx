import { useState } from "react";
import { GlassCard, InnerField } from "./ui/GlassCard";
import { TokenAvatar } from "./ui/TokenAvatar";
import { api } from "../api";
import type { WalletState } from "../types";
import { toast } from "sonner";
import { Loader2, Rocket, Upload } from "lucide-react";
import { clsx } from "clsx";

interface CreateTokenFormProps {
  wallet: WalletState | null;
  onCreated: (tokenId: string) => void;
}

const spectral = "linear-gradient(90deg, #5fbeff, #af8ff4, #f05c6b, #ffcd83, #7ef1b3)";

export function CreateTokenForm({ wallet, onCreated }: CreateTokenFormProps) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0 && symbol.trim().length > 0;

  const handleCreate = async () => {
    if (!wallet) { toast.error("Connect a wallet first"); return; }
    if (!valid) { toast.error("Name and symbol are required"); return; }
    if (symbol.length > 10) { toast.error("Symbol max 10 characters"); return; }
    if (name.length > 32) { toast.error("Name max 32 characters"); return; }

    setLoading(true);
    setError(null);
    try {
      const result = await api.createToken({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim(),
        imageUrl: imageUrl.trim(),
        creator: wallet.pubkey,
      });
      toast.success(`${name} ($${symbol}) launched!`);
      onCreated(result.token.id);
    } catch (e: any) {
      setError(e.message);
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Preview card */}
      <GlassCard className="overflow-hidden">
        <div className="h-1" style={{ background: spectral }} />
        <div className="p-4">
          <div className="flex items-center gap-3">
            <TokenAvatar imageUrl={imageUrl} symbol={symbol || "?"} size={56} />
            <div>
              <p className="display text-lg font-bold" style={{ color: "var(--ink)", letterSpacing: "-0.02em" }}>
                {name || "Token Name"}
              </p>
              <p className="text-sm font-semibold" style={{ color: "var(--muted)" }}>
                ${symbol || "SYMBOL"}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--subtle)" }}>
                {description || "Token description appears here"}
              </p>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Form */}
      <GlassCard className="p-4 space-y-3">
        <h2 className="display text-base font-bold" style={{ color: "var(--ink)" }}>
          Launch Token
        </h2>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Token Name *</label>
          <InnerField>
            <input
              type="text"
              placeholder="e.g. Rialo Frog"
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-transparent px-4 py-3 text-sm font-medium outline-none"
              style={{ color: "var(--ink)" }}
            />
          </InnerField>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Symbol * <span style={{ color: "var(--subtle)" }}>(max 10 chars)</span></label>
          <InnerField>
            <input
              type="text"
              placeholder="e.g. RFROG"
              maxLength={10}
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full bg-transparent px-4 py-3 text-sm font-bold tracking-wider outline-none"
              style={{ color: "var(--ink)" }}
            />
          </InnerField>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Description</label>
          <InnerField>
            <textarea
              placeholder="Tell the world about your token…"
              maxLength={280}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-transparent px-4 py-3 text-sm outline-none resize-none"
              style={{ color: "var(--ink)" }}
            />
          </InnerField>
          <p className="text-xs text-right tabular-nums" style={{ color: "var(--subtle)" }}>
            {description.length}/280
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--muted)" }}>Image URL <span style={{ color: "var(--subtle)" }}>(optional)</span></label>
          <InnerField className="flex items-center gap-2 px-4 py-3">
            <Upload size={14} style={{ color: "var(--muted)" }} />
            <input
              type="url"
              placeholder="https://…"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: "var(--ink)" }}
            />
          </InnerField>
        </div>

        {/* Info box */}
        <div
          className="rounded-xl p-3 space-y-1"
          style={{ background: "rgba(18,45,69,0.04)", border: "1px solid var(--border)" }}
        >
          <p className="text-xs font-semibold" style={{ color: "var(--ink-2)" }}>How it works</p>
          <ul className="text-xs space-y-0.5" style={{ color: "var(--muted)" }}>
            <li>• 1B total supply with bonding curve pricing</li>
            <li>• Graduates to full DEX at 800M tokens sold</li>
            <li>• 1% platform fee on all trades</li>
            <li>• Powered by Rialo devnet (RLO gas)</li>
          </ul>
        </div>

        {error && (
          <div
            className="rounded-xl p-3 text-xs"
            style={{ background: "rgba(186,43,76,0.08)", color: "var(--danger)", border: "1px solid rgba(186,43,76,0.2)" }}
          >
            {error}
          </div>
        )}

        <button
          onClick={handleCreate}
          disabled={!valid || loading || !wallet}
          className={clsx(
            "w-full py-3.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 active:scale-[0.98]",
            (!valid || loading || !wallet) && "opacity-50 cursor-not-allowed"
          )}
          style={{ background: "var(--accent)", color: "white" }}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
          {loading ? "Launching…" : !wallet ? "Connect Wallet to Launch" : "Launch Token"}
        </button>
      </GlassCard>
    </div>
  );
}
