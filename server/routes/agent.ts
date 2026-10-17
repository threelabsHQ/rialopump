/**
 * AI agent routes — powered by oh-my-fable (Fable 5 plan→execute→reflect loop).
 * Exported as a Hono instance so it mounts cleanly in both CF Workers and local dev.
 *
 * POST /agent/analyze          { tokenId }  — start async AI run, returns runId
 * GET  /agent/analyze/:runId               — poll run status + result
 * GET  /agent/analyze-sync/:tokenId        — instant heuristic (no API key needed)
 */
import { Hono } from "hono";
import { run, AnthropicProvider, OpenAICompatProvider, MemoryStore, defineTool } from "oh-my-fable";
import type { TokenRecord } from "../store.js";

type TokenStore = Map<string, TokenRecord>;

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
  sentimentScore: number;
  graduationOdds: number;
  summary: string;
  signals: string[];
  graduationEta: string;
  riskLevel: "low" | "medium" | "high";
  generatedAt: number;
  source: "ai" | "heuristic";
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────

function heuristicAnalysis(t: TokenRecord, kelvinToRlo: (k: number) => number): AnalysisResult {
  const GRADUATION_RLO_TARGET = 85;
  const raisedRlo = kelvinToRlo(t.realRloRaised);
  const progressPct = Math.min(100, (raisedRlo / GRADUATION_RLO_TARGET) * 100);
  const recentTrades = t.trades.slice(-20);
  const buys  = recentTrades.filter(tr => tr.type === "buy").length;
  const sells = recentTrades.filter(tr => tr.type === "sell").length;
  const buyRatio = recentTrades.length > 0 ? buys / recentTrades.length : 0.5;
  const last10 = t.trades.slice(-10);
  const rloVelocity = kelvinToRlo(last10.filter(tr => tr.type === "buy").reduce((s, tr) => s + tr.rloAmount, 0));
  const sentiment: AnalysisResult["sentiment"] = buyRatio > 0.65 ? "bullish" : buyRatio < 0.35 ? "bearish" : "neutral";
  const remaining = GRADUATION_RLO_TARGET - raisedRlo;
  const etaMin = rloVelocity > 0.001 ? Math.round(remaining / (rloVelocity / 10)) : null;
  const graduationEta = t.graduated ? "Graduated" : etaMin && etaMin < 10_000 ? `~${etaMin} min at current pace` : "Pace too slow to estimate";
  const signals: string[] = [];
  if (buyRatio > 0.65) signals.push(`${Math.round(buyRatio * 100)}% of recent trades are buys`);
  if (sells > buys)    signals.push("Sell pressure in recent activity");
  if (progressPct > 50) signals.push(`Bonding curve ${progressPct.toFixed(0)}% filled`);
  if (raisedRlo < 1)  signals.push("Early-stage token — high volatility expected");
  if (t.tokenTaxBps > 0) signals.push(`Creator tax ${(t.tokenTaxBps / 100).toFixed(1)}% per trade`);
  if (signals.length === 0) signals.push("Insufficient trade history for strong signals");
  return {
    sentiment, sentimentScore: Math.round(buyRatio * 100),
    graduationOdds: Math.min(99, Math.round(progressPct * 0.6 + buyRatio * 40)),
    summary: `${t.name} ($${t.symbol}) has raised ${raisedRlo.toFixed(2)} / ${GRADUATION_RLO_TARGET} RLO (${progressPct.toFixed(0)}% progress). ${sentiment === "bullish" ? "Buy momentum is strong." : sentiment === "bearish" ? "Sell pressure dominates." : "Trading activity is balanced."}`,
    signals: signals.slice(0, 4), graduationEta,
    riskLevel: progressPct > 70 ? "low" : progressPct > 30 ? "medium" : "high",
    generatedAt: Date.now(), source: "heuristic",
  };
}

// ─── AI-powered analysis ──────────────────────────────────────────────────────

async function runAiAnalysis(t: TokenRecord, kelvinToRlo: (k: number) => number): Promise<AnalysisResult> {
  const GRADUATION_RLO_TARGET = 85;
  const raisedRlo = kelvinToRlo(t.realRloRaised);
  const progressPct = Math.min(100, (raisedRlo / GRADUATION_RLO_TARGET) * 100);
  const recentTrades = t.trades.slice(-30);
  const buys  = recentTrades.filter(tr => tr.type === "buy").length;
  const sells = recentTrades.filter(tr => tr.type === "sell").length;
  const tokenFacts = JSON.stringify({
    name: t.name, symbol: t.symbol, description: t.description,
    totalSupply: t.totalSupply, tokensSold: t.tokenSupply,
    realRloRaised_rlo: raisedRlo.toFixed(6), graduationTarget_rlo: GRADUATION_RLO_TARGET,
    progressPct: progressPct.toFixed(2), graduated: t.graduated,
    tokenTaxBps: t.tokenTaxBps, tradeCount: t.trades.length,
    recentBuys: buys, recentSells: sells,
    recentTrades: recentTrades.slice(-10).map(tr => ({ type: tr.type, rlo: kelvinToRlo(tr.rloAmount).toFixed(4), tokens: tr.tokenAmount, ts: new Date(tr.timestamp).toISOString() })),
  }, null, 2);

  const getTokenData = defineTool("get_token_data", "Returns onchain state and recent trade history.", { type: "object" as const, properties: {}, required: [] }, async () => ({ ok: true, output: tokenFacts }), { readOnly: true });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !openaiKey) throw new Error("no_api_key");
  const provider = apiKey
    ? new AnthropicProvider({ model: "claude-sonnet-5" })
    : new OpenAICompatProvider({ baseUrl: "https://api.openai.com/v1", apiKey: openaiKey!, model: "gpt-4o-mini" });

  const result = await run(
    { description: "Analyse this Rialo meme-token and return a structured JSON market analysis.", successCriteria: ["Called get_token_data", "Returned JSON with sentiment, sentimentScore, graduationOdds, summary, signals, graduationEta, riskLevel"], constraints: ["Base claims on get_token_data only", "Return ONLY raw JSON, no markdown", "Summary under 50 words"] },
    { provider, store: new MemoryStore(), tools: [getTokenData], budget: { maxSteps: 6, maxTokens: 4000 } },
  );

  const lastStep = result.ctx.plan.steps.findLast(s => s.status === "done");
  const raw = lastStep?.output ?? result.ctx.plan.steps.at(-1)?.output ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Agent did not return parseable JSON");
  const parsed = JSON.parse(jsonMatch[0]) as Partial<AnalysisResult>;
  return {
    sentiment: (["bullish","bearish","neutral"].includes(parsed.sentiment ?? "") ? parsed.sentiment : "neutral") as AnalysisResult["sentiment"],
    sentimentScore: Math.min(100, Math.max(0, Number(parsed.sentimentScore ?? 50))),
    graduationOdds: Math.min(100, Math.max(0, Number(parsed.graduationOdds ?? 50))),
    summary: String(parsed.summary ?? "Analysis complete.").slice(0, 300),
    signals: Array.isArray(parsed.signals) ? (parsed.signals as string[]).slice(0, 4).map(String) : [],
    graduationEta: String(parsed.graduationEta ?? "Unknown"),
    riskLevel: (["low","medium","high"].includes(parsed.riskLevel ?? "") ? parsed.riskLevel : "medium") as AnalysisResult["riskLevel"],
    generatedAt: Date.now(), source: "ai",
  };
}

// ─── Hono router factory ──────────────────────────────────────────────────────

export function makeAgentHono(tokens: TokenStore, kelvinToRlo: (k: number) => number): Hono {
  const app = new Hono();

  app.post("/agent/analyze", async (c) => {
    const { tokenId } = await c.req.json<{ tokenId?: string }>();
    if (!tokenId) return c.json({ error: "tokenId required" }, 400);
    const t = tokens.get(tokenId);
    if (!t) return c.json({ error: "Token not found" }, 404);
    const runId = `${tokenId}_${Date.now()}`;
    const entry: RunEntry = { runId, status: "running", result: null, error: null, startedAt: Date.now() };
    runs.set(runId, entry);
    void (async () => {
      try {
        entry.result = await runAiAnalysis(t, kelvinToRlo);
        entry.status = "done";
      } catch (e: unknown) {
        entry.result = heuristicAnalysis(t, kelvinToRlo);
        entry.status = "done";
        if (!(e instanceof Error && e.message === "no_api_key")) console.warn("[agent] AI fallback:", e instanceof Error ? e.message : String(e));
      }
    })();
    return c.json({ runId, status: "running" });
  });

  app.get("/agent/analyze/:runId", (c) => {
    const entry = runs.get(c.req.param("runId"));
    if (!entry) return c.json({ error: "Run not found" }, 404);
    return c.json({ runId: entry.runId, status: entry.status, result: entry.result, error: entry.error });
  });

  app.get("/agent/analyze-sync/:tokenId", (c) => {
    const t = tokens.get(c.req.param("tokenId"));
    if (!t) return c.json({ error: "Token not found" }, 404);
    return c.json(heuristicAnalysis(t, kelvinToRlo));
  });

  return app;
}
