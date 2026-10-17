/**
 * useAnalysis — fetches an AI/heuristic market analysis for a token.
 *
 * Strategy (Fable 5 verify-before-claim):
 *  1. Immediately fetch the sync heuristic (always available, no API key).
 *  2. Kick off the async AI run in parallel.
 *  3. Poll until done, then upgrade the result with the AI version.
 *  4. If AI fails or no key, keep the heuristic — never show placeholder.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api";
import type { AnalysisResult } from "../api";

export interface UseAnalysisReturn {
  analysis: AnalysisResult | null;
  loading: boolean;
  upgrading: boolean;   // true while AI run is in progress on top of heuristic
  refresh: () => void;
}

export function useAnalysis(tokenId: string | null): UseAnalysisReturn {
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const fetch_ = useCallback(async () => {
    if (!tokenId) return;
    clearPoll();
    setLoading(true);

    // Step 1: instant heuristic
    try {
      const heuristic = await api.analyzeSync(tokenId);
      setAnalysis(heuristic);
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }

    // Step 2: async AI run
    try {
      const { runId } = await api.startAnalysis(tokenId);
      runIdRef.current = runId;
      setUpgrading(true);

      pollRef.current = setInterval(() => {
        void (async () => {
          try {
            const poll = await api.pollAnalysis(runId);
            if (poll.status === "done" && poll.result) {
              setAnalysis(poll.result);
              setUpgrading(false);
              clearPoll();
            } else if (poll.status === "failed") {
              setUpgrading(false);
              clearPoll();
            }
          } catch {
            clearPoll();
            setUpgrading(false);
          }
        })();
      }, 2_000);
    } catch {
      setUpgrading(false);
    }
  }, [tokenId]);

  // oxlint-disable-next-line react/set-state-in-effect -- polling AI analysis is intentional async sync
  useEffect(() => {
    void fetch_();
    return () => clearPoll();
  }, [fetch_]);

  return { analysis, loading, upgrading, refresh: () => { void fetch_(); } };
}
