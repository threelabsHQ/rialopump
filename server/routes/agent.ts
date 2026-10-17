/**
 * AI agent routes — powered by oh-my-fable (Fable 5 plan→execute→reflect loop).
 *
 * POST /agent/analyze   { tokenId }
 *   Runs a Fable 5 agent that reads live onchain state, recent trades, and
 *   bonding-curve math, then returns a structured market analysis.
 *   Uses oh-my-fable's AnthropicProvider (reads ANTHROPIC_API_KEY from env).
 *   If ANTHROPIC_API_KEY is absent, returns a chain-derived heuristic summary
 *   so the UI always has something to show — never a placeholder.
 *
 * GET  /agent/analyze/:runId   poll a running analysis
 */
import { Router } from "express";
import { run, AnthropicProvider, OpenAICompatProvider, MemoryStore, defineTool } from "oh-my-fable";
import type { TokenRecord } from "../store.js";

// ─── Type alias for the token store ──────────────────────────────────────────
type TokenStore = Map<string, TokenRecord>;

// ─── In-memory run registry (per-server-process) ─────────────────────────────
interface RunEntry {
  runId: string;
  status: "running" | "done" | "failed";
  result: AnalysisResult | null;
  error: string | null;
  startedAt: number;
}

const runs = new Map<string, RunEntry>();

export interface AnalysisResult {
  sentiment: "bullish" | "bearish" | "neutral";
  sentimentScore: number;       // 0–100
  graduationOdds: number;       // 0–100 percent
  summary: string;              // 1–2 sentences
  signals: string[];            // 2–4 bullet points
  graduationEta: string;        // e.g. "~12 min at current pace"
  riskLevel: "low" | "medium" | "high";
  generatedAt: number;
  source: "ai" | "heuristic";
}

// ─── Heuristic fallback (no API key needed) ───────────────────────────────────

function heuristicAnalysis(t: TokenRecord, kelvinToRlo: (k: number) => number): AnalysisResult {
  const GRADUATION_RLO_TARGET = 85;
  const raisedRlo = kelvinToRlo(t.realRloRaised);
  const progressPct = Math.min(100, (raisedRlo / GRADUATION_RLO_TARGET) * 100);
  const recentTrades = t.trades.slice(-20);
  const buys  = recentTrades.filter((tr) => tr.type === "buy").length;
  const sells = recentTrades.filter((tr) => tr.type === "sell").length;
  const buyRatio = recentTrades.length > 0 ? buys / recentTrades.length : 0.5;

  // Velocity: RLO raised in last 10 trades
  const last10 = t.trades.slice(-10);
  const rloVelocity = kelvinToRlo(
    last10.filter((tr) => tr.type === "buy").reduce((s, tr) => s + tr.rloAmount, 0)
  );

  const sentiment: AnalysisResult["sentiment"] =
    buyRatio > 0.65 ? "bullish" :
    buyRatio < 0.35 ? "bearish" :
    "neutral";
  const sentimentScore = Math.round(buyRatio * 100);

  // Simple graduation ETA
  const remaining = GRADUATION_RLO_TARGET - raisedRlo;
  const etaMin = rloVelocity > 0.001 ? Math.round(remaining / (rloVelocity / 10) * 1) : null;
  const graduationEta = t.graduated
    ? "Graduated"
    : etaMin && etaMin < 10_000
    ? `~${etaMin} min at current pace`
    : "Pace too slow to estimate";

  const graduationOdds = Math.min(99, Math.round(
    progressPct * 0.6 + buyRatio * 40
  ));

  const riskLevel: AnalysisResult["riskLevel"] =
    progressPct > 70 ? "low" :
    progressPct > 30 ? "medium" :
    "high";

  const signals: string[] = [];
  if (buyRatio > 0.65) signals.push(`${Math.round(buyRatio * 100)}% of recent trades are buys`);
  if (sells > buys)    signals.push("Sell pressure in recent activity");
  if (progressPct > 50) signals.push(`Bonding curve ${progressPct.toFixed(0)}% filled — approaching graduation`);
  if (raisedRlo < 1)  signals.push("Early-stage token — high volatility expected");
  if (t.tokenTaxBps > 0) signals.push(`Creator tax ${(t.tokenTaxBps / 100).toFixed(1)}% on each trade`);
  if (signals.length === 0) signals.push("Insufficient trade history for strong signals");

  return {
    sentiment,
    sentimentScore,
    graduationOdds,
    summary: `${t.name} ($${t.symbol}) has raised ${raisedRlo.toFixed(2)} / ${GRADUATION_RLO_TARGET} RLO (${progressPct.toFixed(0)}% progress). ${sentiment === "bullish" ? "Buy momentum is strong." : sentiment === "bearish" ? "Sell pressure dominates recent activity." : "Trading activity is balanced."}`,
    signals: signals.slice(0, 4),
    graduationEta,
    riskLevel,
    generatedAt: Date.now(),
    source: "heuristic",
  };
}

// ─── AI-powered analysis via oh-my-fable ─────────────────────────────────────

async function runAiAnalysis(
  t: TokenRecord,
  kelvinToRlo: (k: number) => number,
): Promise<AnalysisResult> {
  const GRADUATION_RLO_TARGET = 85;
  const raisedRlo = kelvinToRlo(t.realRloRaised);
  const progressPct = Math.min(100, (raisedRlo / GRADUATION_RLO_TARGET) * 100);
  const recentTrades = t.trades.slice(-30);
  const buys  = recentTrades.filter((tr) => tr.type === "buy").length;
  const sells = recentTrades.filter((tr) => tr.type === "sell").length;

  // Serialise token state as a tool-readable fact sheet
  const tokenFacts = JSON.stringify({
    name: t.name,
    symbol: t.symbol,
    description: t.description,
    totalSupply: t.totalSupply,
    tokensSold: t.tokenSupply,
    realRloRaised_rlo: raisedRlo.toFixed(6),
    graduationTarget_rlo: GRADUATION_RLO_TARGET,
    progressPct: progressPct.toFixed(2),
    graduated: t.graduated,
    tokenTaxBps: t.tokenTaxBps,
    creatorEarnings_kelvin: t.creatorEarnings,
    tradeCount: t.trades.length,
    recentBuys: buys,
    recentSells: sells,
    recentTrades: recentTrades.slice(-10).map((tr) => ({
      type: tr.type,
      rlo: kelvinToRlo(tr.rloAmount).toFixed(4),
      tokens: tr.tokenAmount,
      timestamp: new Date(tr.timestamp).toISOString(),
    })),
  }, null, 2);

  // Read-only tool: expose the token fact sheet
  const getTokenData = defineTool(
    "get_token_data",
    "Returns full onchain state and recent trade history for the token being analysed.",
    { type: "object" as const, properties: {}, required: [] },
    async () => ({ ok: true, output: tokenFacts }),
    { readOnly: true },
  );

  // Determine provider
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  let provider;
  if (apiKey) {
    provider = new AnthropicProvider({ model: "claude-sonnet-5" });
  } else if (openaiKey) {
    provider = new OpenAICompatProvider({ baseUrl: "https://api.openai.com/v1", apiKey: openaiKey, model: "gpt-4o-mini" });
  } else {
    throw new Error("no_api_key");
  }

  const store = new MemoryStore();

  const result = await run(
    {
      description: `Analyse this Rialo meme-token launchpad token using the get_token_data tool, then produce a structured JSON market analysis.`,
      successCriteria: [
        "Called get_token_data to read live onchain state",
        "Returned a JSON object with: sentiment, sentimentScore (0-100), graduationOdds (0-100), summary (1-2 sentences), signals (array of 2-4 strings), graduationEta (string), riskLevel (low|medium|high)",
      ],
      constraints: [
        "Base every claim on the data returned by get_token_data — no fabrication",
        "Return ONLY raw JSON (no markdown fences) in the final step output",
        "Keep the summary under 50 words",
        "Use only English",
      ],
    },
    { provider, store, tools: [getTokenData], budget: { maxSteps: 6, maxTokens: 4000 } },
  );

  // Parse the JSON out of the last step's output
  const lastStep = result.ctx.plan.steps.findLast((s) => s.status === "done");
  const raw = lastStep?.output ?? result.ctx.plan.steps.at(-1)?.output ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Agent did not return parseable JSON");

  const parsed = JSON.parse(jsonMatch[0]) as Partial<AnalysisResult>;
  return {
    sentiment: (["bullish", "bearish", "neutral"].includes(parsed.sentiment ?? "") ? parsed.sentiment : "neutral") as AnalysisResult["sentiment"],
    sentimentScore: Math.min(100, Math.max(0, Number(parsed.sentimentScore ?? 50))),
    graduationOdds: Math.min(100, Math.max(0, Number(parsed.graduationOdds ?? 50))),
    summary: String(parsed.summary ?? "Analysis complete.").slice(0, 300),
    signals: Array.isArray(parsed.signals) ? (parsed.signals as string[]).slice(0, 4).map(String) : [],
    graduationEta: String(parsed.graduationEta ?? "Unknown"),
    riskLevel: (["low", "medium", "high"].includes(parsed.riskLevel ?? "") ? parsed.riskLevel : "medium") as AnalysisResult["riskLevel"],
    generatedAt: Date.now(),
    source: "ai",
  };
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function makeAgentRouter(
  tokens: TokenStore,
  kelvinToRlo: (k: number) => number,
) {
  const router = Router();

  // POST /agent/analyze — start analysis, return runId immediately
  router.post("/agent/analyze", (req, res) => {
    const { tokenId } = req.body as { tokenId?: string };
    if (!tokenId) return res.status(400).json({ error: "tokenId required" });
    const t = tokens.get(tokenId);
    if (!t) return res.status(404).json({ error: "Token not found" });

    const runId = `${tokenId}_${Date.now()}`;
    const entry: RunEntry = { runId, status: "running", result: null, error: null, startedAt: Date.now() };
    runs.set(runId, entry);

    // Kick off async — fallback to heuristic if no API key or AI fails
    void (async () => {
      try {
        const result = await runAiAnalysis(t, kelvinToRlo);
        entry.result = result;
        entry.status = "done";
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "no_api_key" || msg.includes("API key") || msg.includes("ANTHROPIC") || msg.includes("auth")) {
          // No key — use heuristic immediately, still mark as done
          entry.result = heuristicAnalysis(t, kelvinToRlo);
          entry.status = "done";
        } else {
          console.warn("[agent] AI failed, falling back to heuristic:", msg);
          entry.result = heuristicAnalysis(t, kelvinToRlo);
          entry.status = "done";
        }
      }
    })();

    res.json({ runId, status: "running" });
  });

  // GET /agent/analyze/:runId — poll result
  router.get("/agent/analyze/:runId", (req, res) => {
    const entry = runs.get(req.params.runId);
    if (!entry) return res.status(404).json({ error: "Run not found" });
    res.json({
      runId: entry.runId,
      status: entry.status,
      result: entry.result,
      error: entry.error,
    });
  });

  // GET /agent/analyze-sync/:tokenId — synchronous heuristic (no API key required, instant)
  router.get("/agent/analyze-sync/:tokenId", (req, res) => {
    const t = tokens.get(req.params.tokenId);
    if (!t) return res.status(404).json({ error: "Token not found" });
    res.json(heuristicAnalysis(t, kelvinToRlo));
  });

  return router;
}
