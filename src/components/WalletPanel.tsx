import { useState } from "react";
import { GlassCard } from "./ui/GlassCard";
import { shortenAddress } from "../utils/crypto";
import { Wallet, Copy, ExternalLink, Droplets, LogOut, ChevronDown, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import type { WalletState } from "../types";
import { toast } from "sonner";
import { clsx } from "clsx";
import { api } from "../api";

interface WalletPanelProps {
  wallet: WalletState | null;
  loading: boolean;
  onGenerate: () => void;
  onImport: (secretHex: string) => void;
  onAirdrop: () => void | Promise<void>;
  onDisconnect: () => void;
  onRefreshBalance: () => void | Promise<void>;
}

// Drip 1 RLO up to 3 times (max allowed per session, avoids hammering the faucet)
const DRIP_CALLS = 3;
const DRIP_RLO_PER_CALL = 1;

export function WalletPanel({
  wallet, loading, onGenerate, onImport, onDisconnect, onRefreshBalance
}: WalletPanelProps) {
  const [showImport, setShowImport] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [open, setOpen] = useState(false);
  const [dripState, setDripState] = useState<"idle" | "dripping" | "done">("idle");
  const [dripProgress, setDripProgress] = useState(0);

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`));
  };

  const handleImport = () => {
    if (importValue.trim().length !== 64) {
      toast.error("Secret key must be 64 hex characters");
      return;
    }
    onImport(importValue.trim());
    setImportValue("");
    setShowImport(false);
  };

  const handleDrip = async () => {
    if (!wallet || dripState === "dripping") return;
    setDripState("dripping");
    setDripProgress(0);

    let successCount = 0;
    for (let i = 0; i < DRIP_CALLS; i++) {
      try {
        await api.airdrop(wallet.pubkey, DRIP_RLO_PER_CALL);
        successCount++;
        setDripProgress(i + 1);
      } catch {
        // If one call fails, stop trying
        break;
      }
    }

    if (successCount > 0) {
      toast.success(`Dripped ${successCount} RLO — refreshing balance…`);
      await Promise.resolve(onRefreshBalance());
    } else {
      toast.error("Airdrop failed — try again later");
    }
    setDripState("done");
    setTimeout(() => setDripState("idle"), 4_000);
  };

  if (!wallet) {
    return (
      <GlassCard className="p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(18,45,69,0.08)" }}>
            <Wallet size={18} style={{ color: "var(--ink)" }} />
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>No wallet connected</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>Rialo devnet wallet</p>
          </div>
        </div>
        <div className="space-y-2">
          <button
            onClick={onGenerate}
            disabled={loading}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-[0.98]"
            style={{ background: "var(--accent)", color: "white" }}
          >
            {loading ? "Generating…" : "Generate Wallet"}
          </button>
          <button
            onClick={() => setShowImport(!showImport)}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{ background: "rgba(18,45,69,0.06)", color: "var(--ink-2)" }}
          >
            Import Secret Key
          </button>
        </div>
        {showImport && (
          <div className="mt-3 space-y-2">
            <input
              type="password"
              placeholder="64-char hex secret key"
              value={importValue}
              onChange={(e) => setImportValue(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-xs font-mono outline-none"
              style={{ background: "rgba(18,45,69,0.06)", border: "1px solid var(--border)", color: "var(--ink)" }}
            />
            <button
              onClick={handleImport}
              className="w-full py-2 rounded-xl text-sm font-semibold"
              style={{ background: "var(--accent)", color: "white" }}
            >
              Import
            </button>
          </div>
        )}
      </GlassCard>
    );
  }

  return (
    <GlassCard className="overflow-hidden">
      {/* Header row */}
      <button
        className="w-full flex items-center justify-between p-4 cursor-pointer"
        onClick={() => { setOpen(!open); void onRefreshBalance(); }}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(18,45,69,0.08)" }}>
            <Wallet size={16} style={{ color: "var(--ink)" }} />
          </div>
          <div className="text-left">
            <p className="text-xs font-medium mono" style={{ color: "var(--muted)" }}>
              {shortenAddress(wallet.pubkey, 6)}
            </p>
            <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
              {wallet.balance.toFixed(4)} RLO
            </p>
          </div>
        </div>
        <ChevronDown
          size={16}
          className="transition-transform duration-200"
          style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {open && (
        <div className="border-t px-4 pb-4 space-y-3" style={{ borderColor: "var(--border)" }}>
          {/* Address */}
          <div className="flex items-center justify-between pt-3">
            <span className="text-xs" style={{ color: "var(--muted)" }}>Address</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium mono" style={{ color: "var(--ink-2)" }}>
                {shortenAddress(wallet.pubkey, 8)}
              </span>
              <button onClick={() => copy(wallet.pubkey, "Address")} className="p-1 rounded-md hover:opacity-70">
                <Copy size={12} style={{ color: "var(--muted)" }} />
              </button>
            </div>
          </div>

          {/* Secret key */}
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--muted)" }}>Secret Key</span>
            <div className="flex items-center gap-2">
              <span className="text-xs mono" style={{ color: "var(--ink-2)" }}>
                {showSecret ? wallet.secretHex.slice(0, 12) + "…" : "••••••••••••"}
              </span>
              <button onClick={() => setShowSecret(!showSecret)} className="p-1 rounded-md hover:opacity-70">
                {showSecret ? <EyeOff size={12} style={{ color: "var(--muted)" }} /> : <Eye size={12} style={{ color: "var(--muted)" }} />}
              </button>
              <button onClick={() => copy(wallet.secretHex, "Secret key")} className="p-1 rounded-md hover:opacity-70">
                <Copy size={12} style={{ color: "var(--muted)" }} />
              </button>
            </div>
          </div>

          {/* Drip button */}
          <div className="space-y-1.5">
            <button
              onClick={() => { void handleDrip(); }}
              disabled={dripState === "dripping"}
              className={clsx(
                "w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all active:scale-[0.97]",
                dripState === "dripping" && "opacity-70 cursor-not-allowed"
              )}
              style={{ background: "rgba(26,128,71,0.12)", color: "var(--success)" }}
            >
              {dripState === "done"
                ? <><CheckCircle2 size={14} /> Got RLO</>
                : dripState === "dripping"
                  ? <><Droplets size={14} /> Dripping {dripProgress}/{DRIP_CALLS}…</>
                  : <><Droplets size={14} /> Get {DRIP_CALLS} RLO (devnet)</>
              }
            </button>
            {dripState === "dripping" && (
              <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: "rgba(18,45,69,0.08)" }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${(dripProgress / DRIP_CALLS) * 100}%`, background: "var(--success)" }}
                />
              </div>
            )}
            <p className="text-xs text-center" style={{ color: "var(--subtle)" }}>
              Max 1 RLO/call × {DRIP_CALLS} calls · testnet only
            </p>
          </div>

          {/* Disconnect */}
          <button
            onClick={onDisconnect}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all active:scale-[0.97]"
            style={{ background: "rgba(186,43,76,0.09)", color: "var(--danger)" }}
          >
            <LogOut size={14} />
            Disconnect
          </button>

          <a
            href={`https://rialo-explorer-devnet-direct.vercel.app/accounts/${wallet.pubkey}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs justify-center py-1"
            style={{ color: "var(--muted)" }}
          >
            <ExternalLink size={11} />
            View on explorer
          </a>
        </div>
      )}
    </GlassCard>
  );
}
