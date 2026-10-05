import { useState, useCallback, useEffect } from "react";
import type { WalletState } from "../types";
import { api } from "../api";

const STORAGE_KEY = "rialo_wallet_v1";

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load from storage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as WalletState;
        setWallet(parsed);
        // Refresh balance
        refreshBalance(parsed.pubkey).then((bal) => {
          if (bal !== null) {
            setWallet((w) => w ? { ...w, balance: bal.rlo, balanceKelvin: bal.kelvin } : w);
          }
        }).catch(() => {});
      }
    } catch {}
  }, []);

  const refreshBalance = useCallback(async (pubkey: string): Promise<{ rlo: number; kelvin: number } | null> => {
    try {
      const res = await api.balance(pubkey);
      return { rlo: parseFloat(res.rlo), kelvin: parseInt(res.kelvin) };
    } catch {
      return null;
    }
  }, []);

  const generateWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // We'll derive the pubkey client-side using @noble libraries
      const { generateKeypairFromSecret } = await import("../utils/crypto");
      const secretHex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const pubkey = await generateKeypairFromSecret(secretHex);
      const newWallet: WalletState = {
        pubkey,
        secretHex,
        balance: 0,
        balanceKelvin: 0,
      };
      setWallet(newWallet);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newWallet));
      return newWallet;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const importWallet = useCallback(async (secretHex: string) => {
    setLoading(true);
    setError(null);
    try {
      const { generateKeypairFromSecret } = await import("../utils/crypto");
      const pubkey = await generateKeypairFromSecret(secretHex);
      const bal = await refreshBalance(pubkey);
      const w: WalletState = {
        pubkey,
        secretHex,
        balance: bal?.rlo || 0,
        balanceKelvin: bal?.kelvin || 0,
      };
      setWallet(w);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
      return w;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [refreshBalance]);

  const refreshWalletBalance = useCallback(async () => {
    if (!wallet) return;
    const bal = await refreshBalance(wallet.pubkey);
    if (bal) {
      const updated = { ...wallet, balance: bal.rlo, balanceKelvin: bal.kelvin };
      setWallet(updated);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    }
  }, [wallet, refreshBalance]);

  const requestAirdrop = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      await api.airdrop(wallet.pubkey, 100);
      await refreshWalletBalance();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [wallet, refreshWalletBalance]);

  const disconnect = useCallback(() => {
    setWallet(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return {
    wallet,
    loading,
    error,
    generateWallet,
    importWallet,
    refreshWalletBalance,
    requestAirdrop,
    disconnect,
  };
}
