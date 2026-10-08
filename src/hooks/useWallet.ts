import { useState, useCallback, useEffect } from "react";
import type { WalletState } from "../types";
import { api } from "../api";

const STORAGE_KEY = "rialo_wallet_v1";

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshBalance = useCallback(
    async (pubkey: string): Promise<{ rlo: number; kelvin: number } | null> => {
      try {
        const res = await api.balance(pubkey);
        return { rlo: parseFloat(res.rlo), kelvin: parseInt(res.kelvin) };
      } catch {
        return null;
      }
    },
    []
  );

  // Load from storage on mount and refresh balance asynchronously
  // oxlint-disable-next-line react/set-state-in-effect -- initial hydration from localStorage is intentional
  useEffect(() => {
    let cancelled = false;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as WalletState;
        if (!cancelled) setWallet(parsed);
        // Async balance refresh after hydration
        api.balance(parsed.pubkey)
          .then((res) => {
            if (!cancelled) {
              setWallet((w) =>
                w
                  ? { ...w, balance: parseFloat(res.rlo), balanceKelvin: parseInt(res.kelvin) }
                  : w
              );
            }
          })
          .catch(() => {});
      }
    } catch {
      // ignore localStorage / JSON parse errors
    }
    return () => { cancelled = true; };
  }, []); // intentionally empty — runs once on mount

  const generateWallet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const importWallet = useCallback(
    async (secretHex: string) => {
      setLoading(true);
      setError(null);
      try {
        const { generateKeypairFromSecret } = await import("../utils/crypto");
        const pubkey = await generateKeypairFromSecret(secretHex);
        const bal = await refreshBalance(pubkey);
        const w: WalletState = {
          pubkey,
          secretHex,
          balance: bal?.rlo ?? 0,
          balanceKelvin: bal?.kelvin ?? 0,
        };
        setWallet(w);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
        return w;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [refreshBalance]
  );

  const refreshWalletBalance = useCallback(async () => {
    if (!wallet) return;
    const bal = await refreshBalance(wallet.pubkey);
    if (bal) {
      const updated = {
        ...wallet,
        balance: bal.rlo,
        balanceKelvin: bal.kelvin,
      };
      setWallet(updated);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    }
  }, [wallet, refreshBalance]);

  const requestAirdrop = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      // Max 1 RLO per call — drip 3 times
      for (let i = 0; i < 3; i++) {
        await api.airdrop(wallet.pubkey, 1);
      }
      await refreshWalletBalance();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
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
