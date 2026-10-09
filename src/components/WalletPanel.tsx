import { useState } from "react";
import { GlassCard } from "./ui/GlassCard";
import { shortenAddress } from "../utils/crypto";
import {
  Wallet, Copy, ExternalLink, Droplets, LogOut, ChevronDown,
  Eye, EyeOff, CheckCircle2, Puzzle, Globe, KeyRound,
} from "lucide-react";
import type { ActiveWallet } from "../hooks/useMultiWallet";
import { toast } from "sonner";
import { clsx } from "clsx";
import { api } from "../api";
import { useWallets, useConnectWallet, useIsConnected, useDisconnectWallet } from "@rialo/frost";

interface WalletPanelProps {
  activeWallet: ActiveWallet | null;
  loading: boolean;
  onGenerate: () => void;
  onImport: (secretHex: string) => void;
  onConnectPlayground: () => void;
  onDisconnect: () => void;
  onRefreshBalance: () => void | Promise<void>;
}

const DRIP_CALLS = 3;
const DRIP_RLO_PER_CALL = 1;

// ─── Extension connection option ─────────────────────────────────────────────

function ExtensionOption({ onClose }: { onClose: () => void }) {
  const wallets = useWallets();
  const { mutate: connectWallet, isPending } = useConnectWallet();
  const isConnected = useIsConnected();
  const { mutate: disconnectWallet } = useDisconnectWallet();

  if (isConnected) {
    return (
      <button
        onClick={() => { disconnectWallet(); onClose(); }}
        className="w-full flex items-center gap-3 py-3 px-4 rounded-xl transition-all text-left"
        style={{ background: "rgba(240,92,107,0.08)", color: "var(--danger)" }}
      >
        <Puzzle size={16} />
        <span className="text-sm font-medium">Disconnect Extension</span>
      </button>
    );
  }

  if (wallets.length === 0) {
    return (
      <a
        href="https://chromewebstore.google.com/detail/rialo-wallet/dbmgekigjgnahdnfgfpdognodiegpmcg"
        target="_blank"
        rel="noopener noreferrer"
        className="w-full flex items-center gap-3 py-3 px-4 rounded-xl transition-all"
        style={{ background: "rgba(18,45,69,0.06)", color: "var(--ink-2)" }}
      >
        <Puzzle size={16} />
        <div className="flex-1 text-left">
          <p className="text-sm font-medium">Install Rialo Extension</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>Get the Chrome extension to continue</p>
        </div>
        <ExternalLink size={12} style={{ color: "var(--muted)" }} />
      </a>
    );
  }

  return (
    <div className="space-y-1.5">
      {wallets.map((w) => (
        <button
          key={w.name}
          onClick={() => {
            connectWallet({ walletName: w.name });
            onClose();
          }}
          disabled={isPending}
          className="w-full flex items-center gap-3 py-3 px-4 rounded-xl transition-all active:scale-[0.98]"
          style={{ background: "rgba(18,45,69,0.06)", color: "var(--ink)" }}
        >
          {w.icon
            ? <img src={w.icon} alt={w.name} width={20} height={20} className="rounded-md" />
            : <Puzzle size={16} />}
          <span className="text-sm font-semibold">{isPending ? "Connecting…" : `Connect ${w.name}`}</span>
        </button>
      ))}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function WalletPanel({
  activeWallet, loading, onGenerate, onImport,
  onConnectPlayground, onDisconnect, onRefreshBalance,
}: WalletPanelProps) {
  const [showOptions, setShowOptions] = useState(false);
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
    if (importValue.trim().length !== 64) { toast.error("Secret key must be 64 hex characters"); return; }
    onImport(importValue.trim());
    setImportValue("");
    setShowImport(false);
    setShowOptions(false);
  };

  const handleDrip = async () => {
    if (!activeWallet || dripState === "dripping") return;
    setDripState("dripping");
    setDripProgress(0);
    let ok = 0;
    for (let i = 0; i < DRIP_CALLS; i++) {
      try {
        await api.airdrop(activeWallet.pubkey, DRIP_RLO_PER_CALL);
        ok++;
        setDripProgress(i + 1);
      } catch { break; }
    }
    if (ok > 0) {
      toast.success(`Dripped ${ok} RLO — refreshing balance…`);
      await Promise.resolve(onRefreshBalance());
    } else {
      toast.error("Airdrop failed — try again later");
    }
    setDripState("done");
    setTimeout(() => setDripState("idle"), 4_000);
  };

  // ── Not connected — show connection options ───────────────────────────────

  if (!activeWallet) {
    return (
      <GlassCard className="p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(18,45,69,0.08)" }}>
            <Wallet size={18} style={{ color: "var(--ink)" }} />
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Connect wallet</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>Rialo devnet</p>
          </div>
        </div>

        <div className="space-y-2">
          {/* Option 1: Rialo Extension */}
          <div>
            <button
              onClick={() => setShowOptions(v => !v)}
              className="w-full flex items-center gap-3 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.98]"
              style={{ background: "var(--accent)", color: "white" }}
            >
              <Puzzle size={15} />
              Rialo Extension
            </button>
            {showOptions && (
              <div className="mt-2">
                <ExtensionOption onClose={() => setShowOptions(false)} />
              </div>
            )}
          </div>

          {/* Option 2: Web Wallet (Playground) */}
          <button
            onClick={onConnectPlayground}
            className="w-full flex items-center gap-3 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all active:scale-[0.98]"
            style={{ background: "rgba(18,45,69,0.08)", color: "var(--ink)" }}
          >
            <Globe size={15} />
            Web Wallet (Playground)
          </button>

          {/* Option 3: Generate / Import */}
          <div>
            <button
              onClick={() => { onGenerate(); setShowOptions(false); }}
              disabled={loading}
              className="w-full flex items-center gap-3 py-2.5 px-4 rounded-xl text-sm font-medium transition-all active:scale-[0.98]"
              style={{ background: "rgba(18,45,69,0.06)", color: "var(--ink-2)" }}
            >
              <KeyRound size={15} />
              {loading ? "Generating…" : "Generate In-Browser Wallet"}
            </button>
            <button
              onClick={() => setShowImport(!showImport)}
              className="w-full mt-1 py-2 rounded-xl text-xs font-medium transition-all"
              style={{ color: "var(--muted)" }}
            >
              Import secret key
            </button>
          </div>
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

        {/* Wallet type legend */}
        <div className="mt-4 space-y-1.5 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          <p className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>Wallet options</p>
          <div className="flex items-start gap-2">
            <Puzzle size={11} className="mt-0.5 shrink-0" style={{ color: "var(--muted)" }} />
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              <span className="font-semibold" style={{ color: "var(--ink-2)" }}>Extension</span> — full signing, best UX.{" "}
              <a href="https://chromewebstore.google.com/detail/rialo-wallet/dbmgekigjgnahdnfgfpdognodiegpmcg" target="_blank" rel="noopener noreferrer" className="underline">Install</a>
            </p>
          </div>
          <div className="flex items-start gap-2">
            <Globe size={11} className="mt-0.5 shrink-0" style={{ color: "var(--muted)" }} />
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              <span className="font-semibold" style={{ color: "var(--ink-2)" }}>Web Wallet</span> — connect via Rialo Playground (view only, no signing yet).
            </p>
          </div>
          <div className="flex items-start gap-2">
            <KeyRound size={11} className="mt-0.5 shrink-0" style={{ color: "var(--muted)" }} />
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              <span className="font-semibold" style={{ color: "var(--ink-2)" }}>In-browser</span> — keypair in localStorage. Good for quick testing.
            </p>
          </div>
        </div>
      </GlassCard>
    );
  }

  // ── Connected — wallet details ────────────────────────────────────────────

  const walletTypeLabel =
    activeWallet.type === "extension"  ? "Extension" :
    activeWallet.type === "playground" ? "Web Wallet" :
    "In-browser";

  const walletTypeIcon =
    activeWallet.type === "extension"  ? <Puzzle size={12} /> :
    activeWallet.type === "playground" ? <Globe size={12} /> :
    <KeyRound size={12} />;

  return (
    <GlassCard className="overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between p-4 cursor-pointer"
        onClick={() => { setOpen(!open); void onRefreshBalance(); }}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(18,45,69,0.08)" }}>
            <Wallet size={16} style={{ color: "var(--ink)" }} />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-1.5">
              <p className="text-xs font-medium mono" style={{ color: "var(--muted)" }}>
                {shortenAddress(activeWallet.pubkey, 6)}
              </p>
              <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full"
                style={{ background: "rgba(18,45,69,0.06)", color: "var(--muted)" }}>
                {walletTypeIcon}
                <span className="ml-0.5">{walletTypeLabel}</span>
              </span>
            </div>
            <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
              {activeWallet.balance.toFixed(4)} RLO
            </p>
          </div>
        </div>
        <ChevronDown size={16} className="transition-transform duration-200"
          style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
      </button>

      {open && (
        <div className="border-t px-4 pb-4 space-y-3" style={{ borderColor: "var(--border)" }}>
          {/* Address */}
          <div className="flex items-center justify-between pt-3">
            <span className="text-xs" style={{ color: "var(--muted)" }}>Address</span>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium mono" style={{ color: "var(--ink-2)" }}>{shortenAddress(activeWallet.pubkey, 8)}</span>
              <button onClick={() => copy(activeWallet.pubkey, "Address")} className="p-1 rounded-md hover:opacity-70">
                <Copy size={12} style={{ color: "var(--muted)" }} />
              </button>
              <a
                href={`https://rialo-explorer-devnet-direct.vercel.app/accounts/${activeWallet.pubkey}`}
                target="_blank" rel="noopener noreferrer"
                className="p-1 rounded-md hover:opacity-70"
              >
                <ExternalLink size={12} style={{ color: "var(--muted)" }} />
              </a>
            </div>
          </div>

          {/* Secret key — only for generated wallet */}
          {activeWallet.type === "generated" && activeWallet.secretHex && (
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: "var(--muted)" }}>Secret Key</span>
              <div className="flex items-center gap-2">
                <span className="text-xs mono" style={{ color: "var(--ink-2)" }}>
                  {showSecret ? activeWallet.secretHex.slice(0, 12) + "…" : "••••••••••••"}
                </span>
                <button onClick={() => setShowSecret(!showSecret)} className="p-1 rounded-md hover:opacity-70">
                  {showSecret ? <EyeOff size={12} style={{ color: "var(--muted)" }} /> : <Eye size={12} style={{ color: "var(--muted)" }} />}
                </button>
                <button onClick={() => copy(activeWallet.secretHex!, "Secret key")} className="p-1 rounded-md hover:opacity-70">
                  <Copy size={12} style={{ color: "var(--muted)" }} />
                </button>
              </div>
            </div>
          )}

          {/* Playground notice */}
          {activeWallet.type === "playground" && (
            <div className="rounded-lg p-2.5 text-xs" style={{ background: "rgba(255,205,131,0.15)", color: "var(--ink-2)" }}>
              Web Wallet is connected for identity only. Install the Rialo extension to buy, sell, and launch tokens.
            </div>
          )}

          {/* Drip button — for generated and playground wallets only */}
          {activeWallet.type !== "extension" && (
            <div className="space-y-1.5">
              <button
                onClick={() => { void handleDrip(); }}
                disabled={dripState === "dripping"}
                className={clsx(
                  "w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold transition-all active:scale-[0.97]",
                  dripState === "dripping" && "opacity-70 cursor-not-allowed",
                )}
                style={{ background: "rgba(26,128,71,0.12)", color: "var(--success)" }}
              >
                {dripState === "done"
                  ? <><CheckCircle2 size={14} /> Got RLO</>
                  : dripState === "dripping"
                    ? <><Droplets size={14} /> Dripping {dripProgress}/{DRIP_CALLS}…</>
                    : <><Droplets size={14} /> Get {DRIP_CALLS} RLO (devnet)</>}
              </button>
              {dripState === "dripping" && (
                <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: "rgba(26,128,71,0.1)" }}>
                  <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(dripProgress / DRIP_CALLS) * 100}%`, background: "var(--success)" }} />
                </div>
              )}
            </div>
          )}

          {/* Disconnect */}
          <button
            onClick={onDisconnect}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-medium transition-all"
            style={{ background: "rgba(18,45,69,0.05)", color: "var(--muted)" }}
          >
            <LogOut size={13} /> Disconnect
          </button>
        </div>
      )}
    </GlassCard>
  );
}
