/**
 * server/app.ts — Express app factory
 *
 * Exports a configured Express `app` and a `createApp(kv?)` factory.
 *
 * - Local dev (server/index.ts):  call createApp() with no KV → falls back to fs tokens.json
 * - CF Worker (worker.ts):        call createApp(kvNamespace) → uses KV for persistence
 *
 * Static assets are NOT served here in Worker mode — Cloudflare Workers Assets handles that.
 */

import express from "express";
import cors from "cors";
import { createRialoClient, RIALO_DEVNET_CHAIN, Keypair, PublicKey } from "@rialo/ts-cdk";
import type { RialoClient } from "@rialo/ts-cdk";
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { deserializeTokenState, deriveTokenStatePda } from "./rialo-server.js";
import { makeAgentRouter } from "./routes/agent.js";

// ─── KV abstraction (CF KV or local fs fallback) ──────────────────────────────

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

class FsKV implements KVNamespace {
  private file: string;
  constructor(file: string) { this.file = file; }
  async get(_key: string): Promise<string | null> {
    try { return fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf-8") : null; }
    catch { return null; }
  }
  async put(_key: string, value: string): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, value);
    } catch (e) { console.error("FsKV.put error:", e); }
  }
}

// ─── Rialo client ─────────────────────────────────────────────────────────────
const RPC_URL        = process.env.RIALO_DEVNET_RPC    || "https://devnet.rialo.io:4101";
const PROGRAM_ID_STR = process.env.VITE_PROGRAM_ID     || "2PDinBj36DXxwXd9VR8vKes1c5MfP8QLEaVXDDAnNQ1s";
const RLO_USD_RATE   = parseFloat(process.env.RLO_USD_RATE ?? "0.10");
const client: RialoClient = createRialoClient({ chain: RIALO_DEVNET_CHAIN });

function sigToBase58(sig: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits: number[] = [0];
  for (const byte of sig) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = "";
  for (let k = 0; k < sig.length - 1 && sig[k] === 0; k++) result += "1";
  for (let k = digits.length - 1; k >= 0; k--) result += ALPHABET[digits[k]];
  return result;
}

async function pollConfirm(sigBytes: Uint8Array, maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const statuses = await client.getSignatureStatuses([sigBytes]);
      const s = statuses?.[0];
      if (s && !s.err) return;
      if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Transaction failed:")) throw e;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function sendAndConfirm(txBytes: Uint8Array | Buffer): Promise<string> {
  try {
    const confirmed = await client.sendAndConfirmTransaction(txBytes);
    return confirmed.signature;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timed out") || msg.includes("TRANSACTION_CONFIRMATION_TIMEOUT") || msg.includes("timeout")) {
      const sig = await client.sendTransaction(txBytes);
      await new Promise((r) => setTimeout(r, 5_000));
      return sig;
    }
    throw e;
  }
}

async function airdropAndConfirm(pk: PublicKey, kelvin: bigint): Promise<string> {
  const sigBytes = await client.requestAirdrop(pk, kelvin);
  await pollConfirm(sigBytes);
  return sigToBase58(sigBytes);
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
const PHANTOM_RLO           = 30 * KELVIN_PER_RLO;
const GRADUATION_RLO_TARGET = 85 * KELVIN_PER_RLO;
const PLATFORM_FEE_BPS      = 100;

export function kelvinToRlo(k: number): number { return k / KELVIN_PER_RLO; }
function rloToKelvin(rlo: number): number { return Math.round(rlo * KELVIN_PER_RLO); }

function calcBuyTokens(rloInKelvin: number, vRlo: number, vTokens: number) {
  const k = vRlo * vTokens;
  const newVr = vRlo + rloInKelvin;
  return { tokensOut: Math.floor(vTokens - k / newVr), newVr, newVt: k / newVr };
}

function calcSellRlo(tokensIn: number, vRlo: number, vTokens: number) {
  const k = vRlo * vTokens;
  const newVt = vTokens + tokensIn;
  const newVr = k / newVt;
  return { rloOut: Math.floor(vRlo - newVr), newVr, newVt };
}

function buildVirtualState(t: TokenRecord) {
  if (t.onchain && t.realRloRaised > 0) {
    const vRlo = PHANTOM_RLO + t.realRloRaised;
    const vTokens = TOTAL_SUPPLY - t.tokenSupply;
    return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice: vTokens > 0 ? vRlo / vTokens : 0, realRloRaised: t.realRloRaised };
  }
  let vRlo = PHANTOM_RLO, vTokens = TOTAL_SUPPLY, realRloRaised = 0;
  for (const trade of t.trades) {
    const taxBps = t.tokenTaxBps || 0;
    if (trade.type === "buy") {
      const fee = Math.floor(trade.rloAmount * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(trade.rloAmount * taxBps / 10_000);
      const r = calcBuyTokens(trade.rloAmount - fee - tax, vRlo, vTokens);
      vRlo = r.newVr; vTokens = r.newVt; realRloRaised += trade.rloAmount - fee - tax;
    } else {
      const r = calcSellRlo(trade.tokenAmount, vRlo, vTokens);
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

async function syncOnchainState(t: TokenRecord): Promise<void> {
  if (!t.onchain) return;
  try {
    const { pda } = deriveTokenStatePda(tokenIdToBytes(t.tokenIdHex), PublicKey.fromString(PROGRAM_ID_STR));
    const info = await client.getAccountInfo(pda);
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

// ─── App factory ─────────────────────────────────────────────────────────────

export function createApp(kv?: KVNamespace): express.Express {
  // Use provided KV (CF Workers) or fall back to fs-based KV for local dev
  const store: KVNamespace = kv ?? new FsKV(path.join(process.cwd(), "server", "tokens.json"));

  // Token registry (in-memory, hydrated from KV on first request)
  let tokens: Map<string, TokenRecord> = new Map();
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const raw = await store.get("tokens");
    if (raw) {
      try {
        const obj = JSON.parse(raw) as Record<string, TokenRecord>;
        tokens = new Map(Object.entries(obj));
      } catch { /* start empty */ }
    }
  }

  async function persist() {
    const obj: Record<string, TokenRecord> = {};
    for (const [k, v] of tokens) obj[k] = v;
    await store.put("tokens", JSON.stringify(obj));
  }

  // Deployer keypair (optional)
  let deployerKeypair: Keypair | null = null;
  const secretHex = process.env.RIALO_DEPLOYER_SECRET_HEX;
  if (secretHex) {
    deployerKeypair = Keypair.fromSecretKey(new Uint8Array(Buffer.from(secretHex, "hex")));
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  // Load tokens before every request
  app.use(async (_req, _res, next) => { await ensureLoaded(); next(); });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", rpc: RPC_URL, programId: PROGRAM_ID_STR });
  });

  app.get("/deployer", (_req, res) => {
    if (!deployerKeypair) return res.status(503).json({ error: "No deployer key" });
    res.json({ pubkey: deployerKeypair.publicKey.toString() });
  });

  app.get("/chain", async (_req, res) => {
    try {
      const [height, epoch] = await Promise.all([client.getBlockHeight(), client.getEpochInfo()]);
      res.json({ blockHeight: height.toString(), epoch: epoch.epoch.toString(), slot: epoch.absoluteSlot.toString() });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/rpc/config-hash", async (_req, res) => {
    try {
      const v = (await client.getConfigHashPrefix()).toString();
      res.json({ configHashPrefix: v, configHash: v });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/rpc/send-tx", async (req, res) => {
    try {
      const { txBase64 } = req.body as { txBase64?: string };
      if (!txBase64) return res.status(400).json({ error: "txBase64 required" });
      res.json({ signature: await sendAndConfirm(new Uint8Array(Buffer.from(txBase64, "base64"))) });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/airdrop", async (req, res) => {
    try {
      const { pubkey, amount } = req.body as { pubkey?: string; amount?: number };
      if (!pubkey) return res.status(400).json({ error: "pubkey required" });
      const rlo = Math.min(amount || 1, 1);
      res.json({ success: true, signature: await airdropAndConfirm(PublicKey.fromString(pubkey), BigInt(Math.round(rlo * KELVIN_PER_RLO))) });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.get("/balance/:pubkey", async (req, res) => {
    try {
      const bal = await client.getBalance(PublicKey.fromString(req.params.pubkey));
      res.json({ kelvin: bal.toString(), rlo: (Number(bal) / KELVIN_PER_RLO).toFixed(6) });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.get("/tokens", async (_req, res) => {
    const list = Array.from(tokens.values());
    await Promise.allSettled(list.map((t) => syncOnchainState(t)));
    res.json(list.sort((a, b) => b.marketCap - a.marketCap).map((t) => {
      const vs = buildVirtualState(t);
      const rloRaisedK = t.realRloRaised || vs.realRloRaised;
      return {
        id: t.id, name: t.name, symbol: t.symbol, description: t.description,
        imageUrl: t.imageUrl, creator: t.creator, createdAt: t.createdAt,
        tokenSupply: t.tokenSupply, totalSupply: t.totalSupply, graduated: t.graduated,
        tradeCount: t.trades.length, currentPrice: kelvinToRlo(vs.currentPrice),
        marketCap: t.marketCap, priceUsd: kelvinToRlo(vs.currentPrice) * RLO_USD_RATE,
        marketCapUsd: t.marketCap * RLO_USD_RATE,
        progressPct: Math.min(100, (rloRaisedK / GRADUATION_RLO_TARGET) * 100),
        tokenTaxBps: t.tokenTaxBps || 0, creatorEarnings: t.creatorEarnings || 0,
        realRloRaised: kelvinToRlo(rloRaisedK), graduationTarget: kelvinToRlo(GRADUATION_RLO_TARGET),
        onchain: t.onchain,
      };
    }));
  });

  app.get("/tokens/:id", async (req, res) => {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    await syncOnchainState(t);
    const state = buildVirtualState(t);
    res.json({
      id: t.id, name: t.name, symbol: t.symbol, description: t.description,
      imageUrl: t.imageUrl, creator: t.creator, createdAt: t.createdAt,
      tokenSupply: t.tokenSupply, totalSupply: t.totalSupply, graduated: t.graduated,
      tradeCount: t.trades.length, currentPrice: kelvinToRlo(state.currentPrice),
      marketCap: t.marketCap, priceUsd: kelvinToRlo(state.currentPrice) * RLO_USD_RATE,
      marketCapUsd: t.marketCap * RLO_USD_RATE,
      progressPct: Math.min(100, ((t.realRloRaised || state.realRloRaised) / GRADUATION_RLO_TARGET) * 100),
      virtualRlo: kelvinToRlo(state.virtualRlo), realRloRaised: kelvinToRlo(t.realRloRaised || state.realRloRaised),
      graduationTarget: kelvinToRlo(GRADUATION_RLO_TARGET), tokenTaxBps: t.tokenTaxBps || 0,
      creatorEarnings: t.creatorEarnings || 0, onchain: t.onchain,
    });
  });

  app.get("/tokens/:id/state", async (req, res) => {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json(null);
    await syncOnchainState(t);
    const state = buildVirtualState(t);
    res.json({
      tokensSold: t.tokenSupply,
      realRloRaised: kelvinToRlo(t.realRloRaised || state.realRloRaised),
      creatorEarnings: t.creatorEarnings || 0,
      tokenTaxBps: t.tokenTaxBps || 0,
      graduated: t.graduated,
    });
  });

  app.post("/tokens", async (req, res) => {
    try {
      const { name, symbol, description, imageUrl, creator, signedTxBase64, tokenIdHex, tokenTaxBps } =
        req.body as { name?: string; symbol?: string; description?: string; imageUrl?: string;
          creator?: string; signedTxBase64?: string; tokenIdHex?: string; tokenTaxBps?: number; };
      if (!name || !symbol || !creator) return res.status(400).json({ error: "name, symbol, creator required" });
      if (symbol.length > 10) return res.status(400).json({ error: "symbol max 10 chars" });
      if (name.length > 32)   return res.status(400).json({ error: "name max 32 chars" });

      let pk: PublicKey;
      try { pk = PublicKey.fromString(creator); } catch { return res.status(400).json({ error: "Invalid creator pubkey" }); }
      void pk;

      let txHash = "", onchain = false;
      const idHex = tokenIdHex || uuidv4().replace(/-/g, "").slice(0, 16);

      if (signedTxBase64) {
        try {
          txHash = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
          onchain = true;
        } catch (e: unknown) {
          return res.status(400).json({ error: `Onchain transaction failed: ${e instanceof Error ? e.message : String(e)}` });
        }
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
      res.json({ success: true, token: { ...token, txHash, trades: undefined } });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.get("/tokens/:id/quote-buy", handleQuoteBuy);
  app.post("/tokens/:id/quote-buy", express.json(), handleQuoteBuy);
  function handleQuoteBuy(req: express.Request, res: express.Response) {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });
    const rloFloat = Number((req.body as { rloAmount?: number })?.rloAmount ?? req.query.rloAmount);
    if (!rloFloat || rloFloat <= 0) return res.status(400).json({ error: "rloAmount required" });
    const rloKelvin = rloToKelvin(rloFloat);
    const state = buildVirtualState(t);
    const fee = Math.floor(rloKelvin * PLATFORM_FEE_BPS / 10_000);
    const tax = Math.floor(rloKelvin * (t.tokenTaxBps || 0) / 10_000);
    const { tokensOut } = calcBuyTokens(rloKelvin - fee - tax, state.virtualRlo, state.virtualTokens);
    const limited = Math.min(tokensOut, TOTAL_SUPPLY - t.tokenSupply);
    res.json({ tokensOut: limited, fee: kelvinToRlo(fee), creatorTax: kelvinToRlo(tax),
      price: limited > 0 ? rloFloat / limited : 0, currentPrice: kelvinToRlo(state.currentPrice) });
  }

  app.get("/tokens/:id/quote-sell", (req, res) => {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });
    const tokenAmount = Number(req.query.tokenAmount);
    if (!tokenAmount || tokenAmount <= 0) return res.status(400).json({ error: "tokenAmount required" });
    const state = buildVirtualState(t);
    const { rloOut: gross } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
    const fee = Math.floor(gross * PLATFORM_FEE_BPS / 10_000);
    const tax = Math.floor(gross * (t.tokenTaxBps || 0) / 10_000);
    res.json({ rloOut: kelvinToRlo(gross - fee - tax), fee: kelvinToRlo(fee), creatorTax: kelvinToRlo(tax),
      price: (gross - fee - tax) > 0 ? kelvinToRlo(gross - fee - tax) / tokenAmount : 0,
      currentPrice: kelvinToRlo(state.currentPrice) });
  });

  app.post("/tokens/:id/buy", async (req, res) => {
    try {
      const t = tokens.get(req.params.id);
      if (!t) return res.status(404).json({ error: "Token not found" });
      if (t.graduated) return res.status(400).json({ error: "Token graduated" });
      const { trader, rloAmount: rloFloat, signedTxBase64 } = req.body as { trader?: string; rloAmount?: number; signedTxBase64?: string; };
      if (!trader || !rloFloat) return res.status(400).json({ error: "trader and rloAmount required" });
      if (!signedTxBase64) return res.status(400).json({ error: "signedTxBase64 required" });

      const txHash = await sendAndConfirm(Buffer.from(signedTxBase64, "base64")).catch((e: unknown) => {
        throw new Error(`Transaction failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      const rloKelvin = rloToKelvin(rloFloat);
      await syncOnchainState(t);
      const state = buildVirtualState(t);
      const fee = Math.floor(rloKelvin * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(rloKelvin * (t.tokenTaxBps || 0) / 10_000);
      const { tokensOut } = calcBuyTokens(rloKelvin - fee - tax, state.virtualRlo, state.virtualTokens);
      const limited = Math.min(tokensOut, TOTAL_SUPPLY - t.tokenSupply);
      if (limited <= 0) return res.status(400).json({ error: "No tokens available" });

      const trade: TradeRecord = {
        id: uuidv4().replace(/-/g, "").slice(0, 16), type: "buy", trader,
        rloAmount: rloKelvin, tokenAmount: limited,
        price: kelvinToRlo(rloKelvin) / limited, timestamp: Date.now(), txHash, onchain: true,
      };
      t.trades.push(trade);
      await syncOnchainState(t);
      const ns = buildVirtualState(t);
      t.marketCap = kelvinToRlo(ns.currentPrice) * t.tokenSupply;
      tokens.set(t.id, t);
      await persist();
      res.json({ success: true, trade, tokenSupply: t.tokenSupply, graduated: t.graduated,
        currentPrice: kelvinToRlo(ns.currentPrice),
        progressPct: Math.min(100, ((t.realRloRaised || ns.realRloRaised) / GRADUATION_RLO_TARGET) * 100) });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/tokens/:id/sell", async (req, res) => {
    try {
      const t = tokens.get(req.params.id);
      if (!t) return res.status(404).json({ error: "Token not found" });
      if (t.graduated) return res.status(400).json({ error: "Token graduated" });
      const { trader, tokenAmount, signedTxBase64 } = req.body as { trader?: string; tokenAmount?: number; signedTxBase64?: string; };
      if (!trader || !tokenAmount) return res.status(400).json({ error: "trader and tokenAmount required" });
      if (!signedTxBase64) return res.status(400).json({ error: "signedTxBase64 required" });

      const txHash = await sendAndConfirm(Buffer.from(signedTxBase64, "base64")).catch((e: unknown) => {
        throw new Error(`Transaction failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      await syncOnchainState(t);
      const state = buildVirtualState(t);
      const { rloOut: gross } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
      const fee = Math.floor(gross * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(gross * (t.tokenTaxBps || 0) / 10_000);
      const rloAfter = gross - fee - tax;
      if (rloAfter <= 0) return res.status(400).json({ error: "Nothing to receive" });

      const trade: TradeRecord = {
        id: uuidv4().replace(/-/g, "").slice(0, 16), type: "sell", trader,
        rloAmount: rloAfter, tokenAmount,
        price: kelvinToRlo(rloAfter) / tokenAmount, timestamp: Date.now(), txHash, onchain: true,
      };
      t.trades.push(trade);
      await syncOnchainState(t);
      const ns = buildVirtualState(t);
      t.marketCap = kelvinToRlo(ns.currentPrice) * t.tokenSupply;
      tokens.set(t.id, t);
      await persist();
      res.json({ success: true, trade, tokenSupply: t.tokenSupply, currentPrice: kelvinToRlo(ns.currentPrice),
        progressPct: Math.min(100, ((t.realRloRaised || ns.realRloRaised) / GRADUATION_RLO_TARGET) * 100) });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/tokens/:id/claim-earnings", async (req, res) => {
    try {
      const t = tokens.get(req.params.id);
      if (!t) return res.status(404).json({ error: "Token not found" });
      const { signedTxBase64 } = req.body as { signedTxBase64?: string };
      if (!signedTxBase64) return res.status(400).json({ error: "signedTxBase64 required" });
      const sig = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
      await syncOnchainState(t);
      await persist();
      res.json({ success: true, signature: sig });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/tokens/:id/update-tax", async (req, res) => {
    try {
      const t = tokens.get(req.params.id);
      if (!t) return res.status(404).json({ error: "Token not found" });
      const { signedTxBase64, newTaxBps } = req.body as { signedTxBase64?: string; newTaxBps?: number };
      if (!signedTxBase64) return res.status(400).json({ error: "signedTxBase64 required" });
      if (newTaxBps === undefined || newTaxBps < 0 || newTaxBps > 1000) return res.status(400).json({ error: "newTaxBps 0–1000 required" });
      const sig = await sendAndConfirm(Buffer.from(signedTxBase64, "base64"));
      t.tokenTaxBps = newTaxBps;
      await syncOnchainState(t);
      await persist();
      res.json({ success: true, signature: sig });
    } catch (e: unknown) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.get("/tokens/:id/trades", (req, res) => {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    res.json([...t.trades].reverse().slice(0, 100));
  });

  app.get("/portfolio/:pubkey", (req, res) => {
    const { pubkey } = req.params;
    const holdings = [];
    for (const t of tokens.values()) {
      const bought = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "buy");
      const sold   = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "sell");
      const bal = bought.reduce((s, tr) => s + tr.tokenAmount, 0) - sold.reduce((s, tr) => s + tr.tokenAmount, 0);
      if (bal > 0) {
        const state = buildVirtualState(t);
        const value = kelvinToRlo(state.currentPrice) * bal;
        const { trades: _t, ...rest } = t; void _t;
        holdings.push({ token: rest, balance: bal, value,
          pnl: value + sold.reduce((s, tr) => s + tr.rloAmount, 0) - bought.reduce((s, tr) => s + tr.rloAmount, 0) });
      }
    }
    res.json(holdings);
  });

  app.post("/wallet/generate", (_req, res) => {
    const secret = randomBytes(32);
    res.json({ secretHex: secret.toString("hex"), note: "Store safely — this is your wallet key on Rialo devnet." });
  });

  // AI agent routes (Fable 5)
  app.use(makeAgentRouter(tokens as Map<string, import("./store.js").TokenRecord>, kelvinToRlo));

  return app;
}

// Default export for local dev convenience
export const app = createApp();
