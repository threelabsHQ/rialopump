/**
 * useMultiWallet — unified wallet context for all three connection types:
 *
 *  "generated"  — in-browser Ed25519 keypair stored in localStorage (existing flow)
 *  "extension"  — Rialo browser extension via @rialo/frost
 *  "playground" — Rialo Playground OAuth-style return-URL flow (address only; txs signed via extension or rejected)
 *
 * Consumers get a single `activeWallet: ActiveWallet | null` and a
 * `signAndSendTx(txBytes)` helper that dispatches to the right signer.
 */

import { useState, useCallback, useEffect } from "react";
import { useActiveAccount, useSignTransaction, useFrostConfig } from "@rialo/frost";
import { api } from "../api";
import type { RialoInstruction } from "../rialo/program";
import { keypairFromHex } from "../rialo/chain";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WalletType = "generated" | "extension" | "playground";

export interface ActiveWallet {
  type: WalletType;
  pubkey: string;
  balance: number;        // RLO float
  balanceKelvin: number;
  /** Only present for generated wallet */
  secretHex?: string;
}

const GEN_KEY = "rialo_wallet_v1";
const PG_KEY  = "rialo_playground_wallet_v1";

// ─── Playground return-URL parsing ───────────────────────────────────────────

function parsePlaygroundReturn(): { pubkey: string; token: string } | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  const pubkey = p.get("pubkey");
  const token  = p.get("playground") ?? p.get("return_token");
  if (pubkey && pubkey.length > 20) return { pubkey, token: token ?? "" };
  return null;
}

interface StoredGenWallet { pubkey: string; secretHex: string; balance: number; balanceKelvin: number; }

// ─── Main hook ────────────────────────────────────────────────────────────────

export function useMultiWallet() {
  // ── Generated wallet state ──────────────────────────────────────────────────
  const [genWallet, setGenWallet] = useState<StoredGenWallet | null>(() => {
    try {
      const s = localStorage.getItem(GEN_KEY);
      return s ? (JSON.parse(s) as StoredGenWallet) : null;
    } catch { return null; }
  });

  // ── Playground wallet state ─────────────────────────────────────────────────
  const [pgWallet, setPgWallet] = useState<{ pubkey: string; token: string } | null>(() => {
    try {
      const s = localStorage.getItem(PG_KEY);
      return s ? (JSON.parse(s) as { pubkey: string; token: string }) : null;
    } catch { return null; }
  });

  // ── Extension wallet (via Frost) ────────────────────────────────────────────
  const extAccount = useActiveAccount();
  const { mutateAsync: frostSignTx } = useSignTransaction();
  const frostConfig = useFrostConfig();

  // ── Balance state ────────────────────────────────────────────────────────────
  const [balance, setBalance] = useState<{ rlo: number; kelvin: number }>({ rlo: 0, kelvin: 0 });

  // ── Active wallet type: extension > playground > generated ──────────────────
  const type: WalletType | null =
    extAccount ? "extension" :
    pgWallet   ? "playground" :
    genWallet  ? "generated"  :
    null;

  const pubkey =
    type === "extension"  ? (extAccount?.address ?? null) :
    type === "playground" ? pgWallet!.pubkey :
    type === "generated"  ? genWallet!.pubkey :
    null;

  // ── Parse playground return URL on mount ────────────────────────────────────
  // oxlint-disable-next-line react/set-state-in-effect -- one-time URL param parse on mount is intentional
  useEffect(() => {
    const pg = parsePlaygroundReturn();
    if (pg) {
      setPgWallet(pg);
      localStorage.setItem(PG_KEY, JSON.stringify(pg));
      // Clean the URL
      const clean = window.location.pathname;
      window.history.replaceState({}, "", clean);
    }
  }, []);

  // ── Balance refresh ──────────────────────────────────────────────────────────
  const refreshBalance = useCallback(async (pk?: string) => {
    const addr = pk ?? pubkey;
    if (!addr) return;
    try {
      const res = await api.balance(addr);
      const rlo = parseFloat(res.rlo);
      const kelvin = parseInt(res.kelvin);
      setBalance({ rlo, kelvin });
      if (type === "generated" && genWallet) {
        const updated = { ...genWallet, balance: rlo, balanceKelvin: kelvin };
        setGenWallet(updated);
        localStorage.setItem(GEN_KEY, JSON.stringify(updated));
      }
    } catch { /* ignore */ }
  }, [pubkey, type, genWallet]);

  // Auto-refresh balance when active address changes
  // oxlint-disable-next-line react/set-state-in-effect -- async balance fetch on address change is intentional
  useEffect(() => {
    if (pubkey) void refreshBalance(pubkey);
  }, [pubkey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Generated wallet actions ─────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateWallet = useCallback(async (): Promise<ActiveWallet | null> => {
    setLoading(true);
    setError(null);
    try {
      const { generateKeypairFromSecret } = await import("../utils/crypto");
      const secretHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const pk = await generateKeypairFromSecret(secretHex);
      const w: StoredGenWallet = { pubkey: pk, secretHex, balance: 0, balanceKelvin: 0 };
      setGenWallet(w);
      localStorage.setItem(GEN_KEY, JSON.stringify(w));
      return { type: "generated", pubkey: pk, secretHex, balance: 0, balanceKelvin: 0 };
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const importWallet = useCallback(async (secretHex: string): Promise<ActiveWallet | null> => {
    setLoading(true);
    setError(null);
    try {
      const { generateKeypairFromSecret } = await import("../utils/crypto");
      const pk = await generateKeypairFromSecret(secretHex);
      const res = await api.balance(pk).catch(() => ({ rlo: "0", kelvin: "0" }));
      const w: StoredGenWallet = { pubkey: pk, secretHex, balance: parseFloat(res.rlo), balanceKelvin: parseInt(res.kelvin) };
      setGenWallet(w);
      localStorage.setItem(GEN_KEY, JSON.stringify(w));
      return { type: "generated", pubkey: pk, secretHex, balance: w.balance, balanceKelvin: w.balanceKelvin };
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnectGenerated = useCallback(() => {
    setGenWallet(null);
    localStorage.removeItem(GEN_KEY);
  }, []);

  // ── Playground wallet actions ────────────────────────────────────────────────

  /**
   * Open the Rialo Playground in the same tab.
   * The playground will redirect back to our app with ?pubkey=<addr>&playground=<token>
   */
  const connectPlayground = useCallback(() => {
    const returnUrl = encodeURIComponent(window.location.href.split("?")[0]);
    window.location.href = `https://playground.rialo.io/?return=${returnUrl}&return_token=1`;
  }, []);

  const disconnectPlayground = useCallback(() => {
    setPgWallet(null);
    localStorage.removeItem(PG_KEY);
  }, []);

  // ── Disconnect all ────────────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (type === "extension" && frostConfig) {
      try {
        const { disconnect: frostDisconnect } = await import("@rialo/frost");
        void frostDisconnect(frostConfig);
      } catch { /* ignore */ }
    }
    if (type === "playground") disconnectPlayground();
    if (type === "generated") disconnectGenerated();
    setBalance({ rlo: 0, kelvin: 0 });
  }, [type, frostConfig, disconnectGenerated, disconnectPlayground]);

  // ── Transaction signing ───────────────────────────────────────────────────────

  /**
   * Build, sign, and return base64-encoded signed transaction bytes.
   * The caller POSTs them to the server which broadcasts via its RPC connection.
   *
   * - generated:  sign locally with in-browser Ed25519 keypair
   * - extension:  build tx, pop Frost wallet approval UI, get signed bytes back
   * - playground: NOT supported — throws (no private key available)
   */
  const buildAndSignTxBytes = useCallback(async (
    instructions: RialoInstruction[],
  ): Promise<string> => {
    // Get config hash via server proxy (browser can't call devnet RPC — CORS)
    const chpRes = await fetch("/api/rpc/config-hash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const chpData = (await chpRes.json()) as { configHashPrefix: string };
    const configHashPrefix = BigInt(chpData.configHashPrefix);

    const { buildTx } = await import("../rialo/program");
    const { PublicKey } = await import("@rialo/ts-cdk");

    if (type === "generated" && genWallet?.secretHex) {
      const kp = keypairFromHex(genWallet.secretHex);
      const tx = buildTx(instructions, kp.publicKey, configHashPrefix);
      tx.sign(kp);
      return btoa(String.fromCharCode(...tx.serialize()));
    }

    if (type === "extension" && extAccount) {
      const extPk = PublicKey.fromString(extAccount.address);
      const tx = buildTx(instructions, extPk, configHashPrefix);
      // Let the extension sign — pops wallet approval UI
      const result = await frostSignTx({ transaction: tx.serialize() });
      // result.signedTransaction is Uint8Array of the fully-signed tx
      return btoa(String.fromCharCode(...result.signedTransaction));
    }

    if (type === "playground") {
      throw new Error("Web Wallet is view-only — install the Rialo extension to trade.");
    }

    throw new Error("No wallet connected");
  }, [type, genWallet, extAccount, frostSignTx]);

  // ── Compose active wallet ─────────────────────────────────────────────────────
  const activeWallet: ActiveWallet | null = pubkey ? {
    type: type!,
    pubkey,
    secretHex: type === "generated" ? genWallet?.secretHex : undefined,
    balance: type === "generated" ? (genWallet?.balance ?? balance.rlo) : balance.rlo,
    balanceKelvin: type === "generated" ? (genWallet?.balanceKelvin ?? balance.kelvin) : balance.kelvin,
  } : null;

  return {
    activeWallet,
    loading,
    error,
    // Generated
    generateWallet,
    importWallet,
    disconnectGenerated,
    // Extension
    // (connect/disconnect handled by Frost hooks in WalletPanel)
    // Playground
    connectPlayground,
    disconnectPlayground,
    // Shared
    disconnect,
    refreshBalance,
    buildAndSignTxBytes,
  };
}
