/**
 * useChain — live Rialo Devnet chain status hook.
 * Polls /chain every 15 s and exposes blockHeight, epoch, slot, and latency.
 */
import { useState, useEffect, useCallback } from "react";

export interface ChainStatus {
  connected: boolean;
  blockHeight: number | null;
  epoch: number | null;
  slot: number | null;
  latencyMs: number | null;
  lastCheckedAt: number | null;
}

const INITIAL: ChainStatus = {
  connected: false,
  blockHeight: null,
  epoch: null,
  slot: null,
  latencyMs: null,
  lastCheckedAt: null,
};

export function useChain(pollInterval = 15_000): ChainStatus {
  const [status, setStatus] = useState<ChainStatus>(INITIAL);

  const check = useCallback(async () => {
    const t0 = Date.now();
    try {
      const res = await fetch("/api/chain");
      const latencyMs = Date.now() - t0;
      if (!res.ok) { setStatus((s) => ({ ...s, connected: false, lastCheckedAt: Date.now() })); return; }
      const data = (await res.json()) as { blockHeight: string; epoch: string; slot: string };
      setStatus({
        connected: true,
        blockHeight: parseInt(data.blockHeight),
        epoch: parseInt(data.epoch),
        slot: parseInt(data.slot),
        latencyMs,
        lastCheckedAt: Date.now(),
      });
    } catch {
      setStatus((s) => ({ ...s, connected: false, lastCheckedAt: Date.now() }));
    }
  }, []);

  // oxlint-disable-next-line react/set-state-in-effect -- polling chain status is intentional external sync
  useEffect(() => {
    void check();
    const id = setInterval(() => { void check(); }, pollInterval);
    return () => clearInterval(id);
  }, [check, pollInterval]);

  return status;
}
