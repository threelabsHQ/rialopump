/**
 * useOnchainToken — polls /tokens/:id/state every 5 s and merges
 * the live onchain values into the token object returned by the parent.
 *
 * Returns { onchainState, syncing, lastSyncedAt } so callers can show
 * a live "synced from chain" indicator without re-fetching the whole token.
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export interface OnchainTokenState {
  tokensSold: number;
  realRloRaised: number;   // RLO float
  creatorEarnings: number; // kelvin
  tokenTaxBps: number;
  graduated: boolean;
}

export function useOnchainToken(tokenId: string | null) {
  const [onchainState, setOnchainState] = useState<OnchainTokenState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const sync = useCallback(async () => {
    if (!tokenId) return;
    setSyncing(true);
    try {
      // /tokens/:id/state calls syncOnchainState server-side before responding
      const data = await api.token(tokenId);
      setOnchainState({
        tokensSold: data.tokenSupply,
        realRloRaised: data.realRloRaised ?? 0,
        creatorEarnings: data.creatorEarnings ?? 0,
        tokenTaxBps: data.tokenTaxBps ?? 0,
        graduated: data.graduated,
      });
      setLastSyncedAt(Date.now());
    } catch {
      // Non-fatal — keep last known state
    } finally {
      setSyncing(false);
    }
  }, [tokenId]);

  // Initial sync
  // oxlint-disable-next-line react/set-state-in-effect -- data-fetching hook, initial load is intentional
  useEffect(() => { void sync(); }, [sync]);

  // Periodic sync every 5 s
  useEffect(() => {
    const id = setInterval(() => { void sync(); }, 5_000);
    return () => clearInterval(id);
  }, [sync]);

  return { onchainState, syncing, lastSyncedAt, refresh: sync };
}
