/**
 * server/app.ts — Hono app factory
 *
 * Uses Hono instead of Express so the same code runs in:
 *   - Cloudflare Workers (worker.ts): zero Node.js deps at module parse time
 *   - Local dev (server/index.ts): via @hono/node-server
 *
 * Token state is backed by:
 *   - CF Workers: KV namespace passed in via createApp(kv)
 *   - Local dev:  FsKV writing to server/tokens.json
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRialoClient, RIALO_DEVNET_CHAIN, Keypair, PublicKey } from "@rialo/ts-cdk";
import type { RialoClient } from "@rialo/ts-cdk";
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { deserializeTokenState, deriveTokenStatePda } from "./rialo-server.js";
import { makeAgentHono } from "./routes/agent.js";

// ─── KV abstraction ───────────────────────────────────────────────────────────

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Local-dev fallback: persist tokens to a JSON file via fs (Node.js only). */
export class FsKV implements KVNamespace {
  private file: string;
  constructor(file: string) { this.file = file; }
  async get(_key: string): Promise<string | null> {
    try {
      const { default: fs } = await import("fs");
      return fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf-8") : null;
    } catch { return null; }
  }
  async put(_key: string, value: string): Promise<void> {
    try {
      const { default: fs } = await import("fs");
      const { default: path } = await import("path");
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, value);
    } catch (e) { console.error("FsKV.put:", e); }
  }
}

// ─── Rialo client (lazy) ──────────────────────────────────────────────────────

const getRpcUrl        = () => process.env.RIALO_DEVNET_RPC  || "https://devnet.rialo.io:4101";
const getProgramId     = () => process.env.VITE_PROGRAM_ID   || "2PDinBj36DXxwXd9VR8vKes1c5MfP8QLEaVXDDAnNQ1s";
const getRloUsdRate    = () => parseFloat(process.env.RLO_USD_RATE ?? "0.10");

let _client: RialoClient | null = null;
function getClient(): RialoClient {
  if (!_client) _client = createRialoClient({ chain: RIALO_DEVNET_CHAIN });
  return _client;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TradeRecord {
  id: string; type: "buy" | "sell"; trader: string;
  rloAmount: number; tokenAmount: number; price: number;
  timestamp: number; txHash: string; onchain: boolean;
}

export interface TokenRecord {
  id: string; name: string; symbol: string; description: string;
  imageUrl: string; creator: string; createdAt: number;
  tokenSupply: number; totalSupply: number; graduated: boolean;
  trades: TradeRecord[]; marketCap: number; tokenTaxBps: number;
  creatorEarnings: number; realRloRaised: number; onchain: boolean; tokenIdHex: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const KELVIN_PER_RLO        = 1_000_000_000;
const TOTAL_SUPPLY          = 1_000_000_000;
const PHANTOM_RLO           = 30  * KELVIN_PER_RLO;
const GRADUATION_RLO_TARGET = 85  * KELVIN_PER_RLO;
const PLATFORM_FEE_BPS      = 100;

export function kelvinToRlo(k: number): number { return k / KELVIN_PER_RLO; }
function rloToKelvin(rlo: number): number { return Math.round(rlo * KELVIN_PER_RLO); }

// ─── Bonding curve math ───────────────────────────────────────────────────────

function calcBuyTokens(rloInK: number, vRlo: number, vTokens: number) {
  const k = vRlo * vTokens, newVr = vRlo + rloInK;
  return { tokensOut: Math.floor(vTokens - k / newVr), newVr, newVt: k / newVr };
}
function calcSellRlo(tokensIn: number, vRlo: number, vTokens: number) {
  const k = vRlo * vTokens, newVt = vTokens + tokensIn, newVr = k / newVt;
  return { rloOut: Math.floor(vRlo - newVr), newVr, newVt };
}
function buildVirtualState(t: TokenRecord) {
  if (t.onchain && t.realRloRaised > 0) {
    const vRlo = PHANTOM_RLO + t.realRloRaised, vTokens = TOTAL_SUPPLY - t.tokenSupply;
    return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice: vTokens > 0 ? vRlo / vTokens : 0, realRloRaised: t.realRloRaised };
  }
  let vRlo = PHANTOM_RLO, vTokens = TOTAL_SUPPLY, realRloRaised = 0;
  for (const tr of t.trades) {
    if (tr.type === "buy") {
      const fee = Math.floor(tr.rloAmount * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(tr.rloAmount * (t.tokenTaxBps || 0) / 10_000);
      const r = calcBuyTokens(tr.rloAmount - fee - tax, vRlo, vTokens);
      vRlo = r.newVr; vTokens = r.newVt; realRloRaised += tr.rloAmount - fee - tax;
    } else {
      const r = calcSellRlo(tr.tokenAmount, vRlo, vTokens);
      vRlo = r.newVr; vTokens = r.newVt;
      realRloRaised = Math.max(0, realRloRaised - r.rloOut);
    }
  }
  return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice: vTokens > 0 ? vRlo / vTokens : 0, realRloRaised };
}
function tokenIdToBytes(idHex: string): Uint8Array {
  const hex = idHex.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sigToBase58(sig: Uint8Array): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const d: number[] = [0];
  for (const b of sig) {
    let c = b;
    for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = Math.floor(c / 58); }
    while (c > 0) { d.push(c % 58); c = Math.floor(c / 58); }
  }
  let r = "";
  for (let k = 0; k < sig.length - 1 && sig[k] === 0; k++) r += "1";
  for (let k = d.length - 1; k >= 0; k--) r += A[d[k]];
  return r;
}
async function pollConfirm(sigBytes: Uint8Array, maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const s = (await getClient().getSignatureStatuses([sigBytes]))?.[0];
      if (s && !s.err) return;
      if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("Transaction failed:")) throw e;
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
}
async function sendAndConfirm(txBytes: Uint8Array | Buffer): Promise<string> {
  try {
    return (await getClient().sendAndConfirmTransaction(txBytes)).signature;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timed out") || msg.includes("timeout")) {
      const sig = await getClient().sendTransaction(txBytes);
      await new Promise(r => setTimeout(r, 5_000));
      return sig;
    }
    throw e;
  }
}
async function airdropAndConfirm(pk: PublicKey, kelvin: bigint): Promise<string> {
  const sigBytes = await getClient().requestAirdrop(pk, kelvin);
  await pollConfirm(sigBytes);
  return sigToBase58(sigBytes);
}
async function syncOnchainState(t: TokenRecord): Promise<void> {
  if (!t.onchain) return;
  try {
    const { pda } = deriveTokenStatePda(tokenIdToBytes(t.tokenIdHex), PublicKey.fromString(getProgramId()));
    const info = await getClient().getAccountInfo(pda);
    if (!info?.data) return;
    const raw = Array.isArray(info.data) ? (info.data as [string, string])[0] : (info.data as string);
    const data = info.data instanceof Uint8Array ? info.data : new Uint8Array(Buffer.from(raw, "base64"));
    const state = deserializeTokenState(data);
    t.tokenSupply = Number(state.tokensSold);
    t.graduated = state.graduated;
    t.tokenTaxBps = Number(state.tokenTaxBps);
    t.creatorEarnings = Number(state.creatorEarnings);
    const vRlo = Number(state.virtualRlo), vTokens = Number(state.virtualTokens);
    t.marketCap = kelvinToRlo(vTokens > 0 ? vRlo / vTokens : 0) * t.tokenSupply;
    t.realRloRaised = Number(state.realRloRaised);
  } catch { /* keep cached */ }
}

// ─── Token shape for API responses ───────────────────────────────────────────

function tokenView(t: TokenRecord) {
  const vs = buildVirtualState(t);
  const rloRaisedK = t.realRloRaised || vs.realRloRaised;
  return {
    id: t.id, name: t.name, symbol: t.symbol, description: t.description,
    imageUrl: t.imageUrl, creator: t.creator, createdAt: t.createdAt,
    tokenSupply: t.tokenSupply, totalSupply: t.totalSupply, graduated: t.graduated,
    tradeCount: t.trades.length, currentPrice: kelvinToRlo(vs.currentPrice),
    marketCap: t.marketCap, priceUsd: kelvinToRlo(vs.currentPrice) * getRloUsdRate(),
    marketCapUsd: t.marketCap * getRloUsdRate(),
    progressPct: Math.min(100, (rloRaisedK / GRADUATION_RLO_TARGET) * 100),
    tokenTaxBps: t.tokenTaxBps || 0, creatorEarnings: t.creatorEarnings || 0,
    realRloRaised: kelvinToRlo(rloRaisedK),
    graduationTarget: kelvinToRlo(GRADUATION_RLO_TARGET), onchain: t.onchain,
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createApp(kv?: KVNamespace): Hono {
  const store: KVNamespace = kv ?? new FsKV(
    // Dynamic import of path so this module parses cleanly in CF Workers
    // (FsKV.get/put also use dynamic imports — they're only called in local dev)
    "./server/tokens.json"
  );

  let tokens: Map<string, TokenRecord> = new Map();
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const raw = await store.get("tokens");
    if (raw) {
      try { tokens = new Map(Object.entries(JSON.parse(raw) as Record<string, TokenRecord>)); }
      catch { /* start empty */ }
    }
  }
  async function persist() {
    const obj: Record<string, TokenRecord> = {};
    for (const [k, v] of tokens) obj[k] = v;
    await store.put("tokens", JSON.stringify(obj));
  }

  let deployerKeypair: Keypair | null = null;
  const secretHex = process.env.RIALO_DEPLOYER_SECRET_HEX;
  if (secretHex) deployerKeypair = Keypair.fromSecretKey(new Uint8Array(Buffer.from(secretHex, "hex")));

  // Outer app: serves static assets (Workers Assets) + mounts API under /api
  const app = new Hono();
  app.use("*", cors());

  // All API routes live on this sub-app, mounted at /api below.
  // This matches what the browser fetches: /api/tokens, /api/chain, etc.
  const api = new Hono();
  api.use("*", async (_c, next) => { await ensureLoaded(); await next(); });

  // ── Health ────────────────────────────────────────────────────────────────

  api.get("/health", (c) => c.json({ status: "ok", rpc: getRpcUrl(), programId: getProgramId() }));

  api.get("/deployer", (c) => {
    if (!deployerKeypair) return c.json({ error: "No deployer key" }, 503);
    return c.json({ pubkey: deployerKeypair.publicKey.toString() });
  });

  api.get("/chain", async (c) => {
    try {
      const [height, epoch] = await Promise.all([getClient().getBlockHeight(), getClient().getEpochInfo()]);
      return c.json({ blockHeight: height.toString(), epoch: epoch.epoch.toString(), slot: epoch.absoluteSlot.toString() });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── RPC proxy ─────────────────────────────────────────────────────────────

  api.post("/rpc/config-hash", async (c) => {
    try { const v = (await getClient().getConfigHashPrefix()).toString(); return c.json({ configHashPrefix: v, configHash: v }); }
    catch (e) { return c.json({ error: String(e) }, 500); }
  });

  api.post("/rpc/send-tx", async (c) => {
    try {
      const { txBase64 } = await c.req.json<{ txBase64?: string }>();
      if (!txBase64) return c.json({ error: "txBase64 required" }, 400);
      return c.json({ signature: await sendAndConfirm(new Uint8Array(Buffer.from(txBase64, "base64"))) });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  api.post("/airdrop", async (c) => {
    try {
      const { pubkey, amount } = await c.req.json<{ pubkey?: string; amount?: number }>();
      if (!pubkey) return c.json({ error: "pubkey required" }, 400);
      const rlo = Math.min(amount || 1, 1);
      return c.json({ success: true, signature: await airdropAndConfirm(PublicKey.fromString(pubkey), BigInt(Math.round(rlo * KELVIN_PER_RLO))) });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Balance ───────────────────────────────────────────────────────────────

  api.get("/balance/:pubkey", async (c) => {
    try {
      const bal = await getClient().getBalance(PublicKey.fromString(c.req.param("pubkey")));
      return c.json({ kelvin: bal.toString(), rlo: (Number(bal) / KELVIN_PER_RLO).toFixed(6) });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Token list ────────────────────────────────────────────────────────────

  api.get("/tokens", async (c) => {
    const list = Array.from(tokens.values());
    await Promise.allSettled(list.map(syncOnchainState));
    return c.json(list.sort((a, b) => b.marketCap - a.marketCap).map(tokenView));
  });

  // ── Single token ──────────────────────────────────────────────────────────

  api.get("/tokens/:id", async (c) => {
    const t = tokens.get(c.req.param("id"));
    if (!t) return c.json({ error: "Token not found" }, 404);
    await syncOnchainState(t);
    const state = buildVirtualState(t);
    return c.json({
      ...tokenView(t),
      virtualRlo: kelvinToRlo(state.virtualRlo),
      realRloRaised: kelvinToRlo(t.realRloRaised || state.realRloRaised),
    });
  });

  api.get("/tokens/:id/state", async (c) => {
    const t = tokens.get(c.req.param("id"));
    if (!t) return c.json(null, 404);
    await syncOnchainState(t);
    const state = buildVirtualState(t);
    return c.json({
      tokensSold: t.tokenSupply,
      realRloRaised: kelvinToRlo(t.realRloRaised || state.realRloRaised),
      creatorEarnings: t.creatorEarnings || 0,
      tokenTaxBps: t.tokenTaxBps || 0,
      graduated: t.graduated,
    });
  });

  // ── Create token ──────────────────────────────────────────────────────────

  api.post("/tokens", async (c) => {
    try {
      const body = await c.req.json<{
        name?: string; symbol?: string; description?: string; imageUrl?: string;
        creator?: string; signedTxBase64?: string; tokenIdHex?: string; tokenTaxBps?: number;
      }>();
      const { name, symbol, description, imageUrl, creator, signedTxBase64, tokenIdHex, tokenTaxBps } = body;
      if (!name || !symbol || !creator) return c.json({ error: "name, symbol, creator required" }, 400);
      if (symbol.length > 10) return c.json({ error: "symbol max 10 chars" }, 400);
      if (name.length > 32)   return c.json({ error: "name max 32 chars" }, 400);
      try { PublicKey.fromString(creator); } catch { return c.json({ error: "Invalid creator pubkey" }, 400); }

      let txHash = "", onchain = false;
      const idHex = tokenIdHex || uuidv4().replace(/-/g, "").slice(0, 16);
      if (signedTxBase64) {
        try { txHash = await sendAndConfirm(Buffer.from(signedTxBase64, "base64")); onchain = true; }
        catch (e) { return c.json({ error: `Onchain tx failed: ${String(e)}` }, 400); }
      }
      const token: TokenRecord = {
        id: idHex, name: name.trim(), symbol: symbol.trim().toUpperCase(),
        description: (description || "").trim(), imageUrl: imageUrl || "", creator,
        createdAt: Date.now(), tokenSupply: 0, totalSupply: TOTAL_SUPPLY, graduated: false,
        trades: [], marketCap: 0, tokenTaxBps: Math.min(Math.max(tokenTaxBps ?? 0, 0), 1000),
        creatorEarnings: 0, realRloRaised: 0, onchain, tokenIdHex: idHex,
      };
      tokens.set(idHex, token);
      await persist();
      return c.json({ success: true, token: { ...token, txHash, trades: undefined } });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Quote buy ─────────────────────────────────────────────────────────────

  const handleQuoteBuy = (id: string, rloFloat: number, c: Parameters<Parameters<Hono["get"]>[1]>[0]) => {
    const t = tokens.get(id);
    if (!t) return c.json({ error: "Token not found" }, 404);
    if (t.graduated) return c.json({ error: "Token graduated" }, 400);
    if (!rloFloat || rloFloat <= 0) return c.json({ error: "rloAmount required" }, 400);
    const rloK = rloToKelvin(rloFloat);
    const state = buildVirtualState(t);
    const fee = Math.floor(rloK * PLATFORM_FEE_BPS / 10_000);
    const tax = Math.floor(rloK * (t.tokenTaxBps || 0) / 10_000);
    const { tokensOut } = calcBuyTokens(rloK - fee - tax, state.virtualRlo, state.virtualTokens);
    const limited = Math.min(tokensOut, TOTAL_SUPPLY - t.tokenSupply);
    return c.json({ tokensOut: limited, fee: kelvinToRlo(fee), creatorTax: kelvinToRlo(tax),
      price: limited > 0 ? rloFloat / limited : 0, currentPrice: kelvinToRlo(state.currentPrice) });
  };

  api.get("/tokens/:id/quote-buy", (c) => handleQuoteBuy(c.req.param("id"), Number(c.req.query("rloAmount")), c));
  api.post("/tokens/:id/quote-buy", async (c) => {
    const { rloAmount } = await c.req.json<{ rloAmount?: number }>();
    return handleQuoteBuy(c.req.param("id"), Number(rloAmount), c);
  });

  // ── Quote sell ────────────────────────────────────────────────────────────

  api.get("/tokens/:id/quote-sell", (c) => {
    const t = tokens.get(c.req.param("id"));
    if (!t) return c.json({ error: "Token not found" }, 404);
    if (t.graduated) return c.json({ error: "Token graduated" }, 400);
    const tokenAmount = Number(c.req.query("tokenAmount"));
    if (!tokenAmount || tokenAmount <= 0) return c.json({ error: "tokenAmount required" }, 400);
    const state = buildVirtualState(t);
    const { rloOut: gross } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
    const fee = Math.floor(gross * PLATFORM_FEE_BPS / 10_000);
    const tax = Math.floor(gross * (t.tokenTaxBps || 0) / 10_000);
    return c.json({ rloOut: kelvinToRlo(gross - fee - tax), fee: kelvinToRlo(fee), creatorTax: kelvinToRlo(tax),
      price: (gross - fee - tax) > 0 ? kelvinToRlo(gross - fee - tax) / tokenAmount : 0,
      currentPrice: kelvinToRlo(state.currentPrice) });
  });

  // ── Execute buy ───────────────────────────────────────────────────────────

  api.post("/tokens/:id/buy", async (c) => {
    try {
      const t = tokens.get(c.req.param("id"));
      if (!t) return c.json({ error: "Token not found" }, 404);
      if (t.graduated) return c.json({ error: "Token graduated" }, 400);
      const { trader, rloAmount: rloFloat, signedTxBase64 } = await c.req.json<{ trader?: string; rloAmount?: number; signedTxBase64?: string }>();
      if (!trader || !rloFloat) return c.json({ error: "trader and rloAmount required" }, 400);
      if (!signedTxBase64) return c.json({ error: "signedTxBase64 required" }, 400);
      const txHash = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
      const rloK = rloToKelvin(rloFloat);
      await syncOnchainState(t);
      const state = buildVirtualState(t);
      const fee = Math.floor(rloK * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(rloK * (t.tokenTaxBps || 0) / 10_000);
      const { tokensOut } = calcBuyTokens(rloK - fee - tax, state.virtualRlo, state.virtualTokens);
      const limited = Math.min(tokensOut, TOTAL_SUPPLY - t.tokenSupply);
      if (limited <= 0) return c.json({ error: "No tokens available" }, 400);
      const trade: TradeRecord = { id: uuidv4().replace(/-/g, "").slice(0, 16), type: "buy", trader,
        rloAmount: rloK, tokenAmount: limited, price: kelvinToRlo(rloK) / limited, timestamp: Date.now(), txHash, onchain: true };
      t.trades.push(trade);
      await syncOnchainState(t);
      const ns = buildVirtualState(t);
      t.marketCap = kelvinToRlo(ns.currentPrice) * t.tokenSupply;
      tokens.set(t.id, t); await persist();
      return c.json({ success: true, trade, tokenSupply: t.tokenSupply, graduated: t.graduated,
        currentPrice: kelvinToRlo(ns.currentPrice),
        progressPct: Math.min(100, ((t.realRloRaised || ns.realRloRaised) / GRADUATION_RLO_TARGET) * 100) });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Execute sell ──────────────────────────────────────────────────────────

  api.post("/tokens/:id/sell", async (c) => {
    try {
      const t = tokens.get(c.req.param("id"));
      if (!t) return c.json({ error: "Token not found" }, 404);
      if (t.graduated) return c.json({ error: "Token graduated" }, 400);
      const { trader, tokenAmount, signedTxBase64 } = await c.req.json<{ trader?: string; tokenAmount?: number; signedTxBase64?: string }>();
      if (!trader || !tokenAmount) return c.json({ error: "trader and tokenAmount required" }, 400);
      if (!signedTxBase64) return c.json({ error: "signedTxBase64 required" }, 400);
      const txHash = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
      await syncOnchainState(t);
      const state = buildVirtualState(t);
      const { rloOut: gross } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
      const fee = Math.floor(gross * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(gross * (t.tokenTaxBps || 0) / 10_000);
      const rloAfter = gross - fee - tax;
      if (rloAfter <= 0) return c.json({ error: "Nothing to receive" }, 400);
      const trade: TradeRecord = { id: uuidv4().replace(/-/g, "").slice(0, 16), type: "sell", trader,
        rloAmount: rloAfter, tokenAmount, price: kelvinToRlo(rloAfter) / tokenAmount, timestamp: Date.now(), txHash, onchain: true };
      t.trades.push(trade);
      await syncOnchainState(t);
      const ns = buildVirtualState(t);
      t.marketCap = kelvinToRlo(ns.currentPrice) * t.tokenSupply;
      tokens.set(t.id, t); await persist();
      return c.json({ success: true, trade, tokenSupply: t.tokenSupply, currentPrice: kelvinToRlo(ns.currentPrice),
        progressPct: Math.min(100, ((t.realRloRaised || ns.realRloRaised) / GRADUATION_RLO_TARGET) * 100) });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Claim earnings ────────────────────────────────────────────────────────

  api.post("/tokens/:id/claim-earnings", async (c) => {
    try {
      const t = tokens.get(c.req.param("id"));
      if (!t) return c.json({ error: "Token not found" }, 404);
      const { signedTxBase64 } = await c.req.json<{ signedTxBase64?: string }>();
      if (!signedTxBase64) return c.json({ error: "signedTxBase64 required" }, 400);
      const sig = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
      await syncOnchainState(t); await persist();
      return c.json({ success: true, signature: sig });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Update tax ────────────────────────────────────────────────────────────

  api.post("/tokens/:id/update-tax", async (c) => {
    try {
      const t = tokens.get(c.req.param("id"));
      if (!t) return c.json({ error: "Token not found" }, 404);
      const { signedTxBase64, newTaxBps } = await c.req.json<{ signedTxBase64?: string; newTaxBps?: number }>();
      if (!signedTxBase64) return c.json({ error: "signedTxBase64 required" }, 400);
      if (newTaxBps === undefined || newTaxBps < 0 || newTaxBps > 1000) return c.json({ error: "newTaxBps 0–1000 required" }, 400);
      const sig = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
      t.tokenTaxBps = newTaxBps;
      await syncOnchainState(t); await persist();
      return c.json({ success: true, signature: sig });
    } catch (e) { return c.json({ error: String(e) }, 500); }
  });

  // ── Trades / Portfolio / Wallet ───────────────────────────────────────────

  api.get("/tokens/:id/trades", (c) => {
    const t = tokens.get(c.req.param("id"));
    if (!t) return c.json({ error: "Token not found" }, 404);
    return c.json([...t.trades].reverse().slice(0, 100));
  });

  api.get("/portfolio/:pubkey", (c) => {
    const pubkey = c.req.param("pubkey");
    const holdings = [];
    for (const t of tokens.values()) {
      const bought = t.trades.filter(tr => tr.trader === pubkey && tr.type === "buy");
      const sold   = t.trades.filter(tr => tr.trader === pubkey && tr.type === "sell");
      const bal = bought.reduce((s, tr) => s + tr.tokenAmount, 0) - sold.reduce((s, tr) => s + tr.tokenAmount, 0);
      if (bal > 0) {
        const state = buildVirtualState(t);
        const value = kelvinToRlo(state.currentPrice) * bal;
        const { trades: _t, ...rest } = t; void _t;
        holdings.push({ token: rest, balance: bal, value,
          pnl: value + sold.reduce((s, tr) => s + tr.rloAmount, 0) - bought.reduce((s, tr) => s + tr.rloAmount, 0) });
      }
    }
    return c.json(holdings);
  });

  api.post("/wallet/generate", (c) => {
    const secret = randomBytes(32);
    return c.json({ secretHex: secret.toString("hex"), note: "Store safely — this is your wallet key on Rialo devnet." });
  });

  // ── AI agent routes (Fable 5) ─────────────────────────────────────────────
  const agentHono = makeAgentHono(tokens, kelvinToRlo);
  api.route("/", agentHono);

  // Mount all API routes under /api — matches what the browser fetches
  app.route("/api", api);

  return app;
}
