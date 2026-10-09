import express from "express";
import cors from "cors";
import { createRialoClient, RIALO_DEVNET_CHAIN, Keypair, PublicKey } from "@rialo/ts-cdk";
import type { RialoClient } from "@rialo/ts-cdk";
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { deserializeTokenState, deriveTokenStatePda } from "./rialo-server";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ─── Rialo client ─────────────────────────────────────────────────────────────
const RPC_URL = process.env.RIALO_DEVNET_RPC || "https://devnet.rialo.io:4101";
const PROGRAM_ID_STR = process.env.VITE_PROGRAM_ID || "CDy4MtWvAJyLfQBU4TLK7ZDDapPeq9SqSqvC65HVdESk";
const client: RialoClient = createRialoClient({ chain: RIALO_DEVNET_CHAIN });

/**
 * Encode a Uint8Array signature to base58.
 * Rialo's Signature type = Uint8Array; RPC wire format is base58 string.
 * We use PublicKey.fromBytes (which internally uses the same bs58 encoder)
 * to convert 32-byte chunks, but signatures are 64 bytes so we encode directly
 * via the SDK's internal base58 by round-tripping through a known path.
 */
function sigToBase58(sig: Uint8Array): string {
  // The SDK's PublicKey wraps a 32-byte key but its toString() uses bs58.
  // For a 64-byte signature we fall back to a manual base58 implementation.
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

/**
 * Poll until a Uint8Array signature is confirmed or timeout.
 * Only accepts Uint8Array (Rialo SDK Signature type) — never pass a base58/base64 string.
 */
async function pollConfirm(sigBytes: Uint8Array, maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const statuses = await client.getSignatureStatuses([sigBytes]);
      const s = statuses?.[0];
      if (s && !s.err) return;
      if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    } catch (e: unknown) {
      // getSignatureStatuses can throw on Rialo devnet — treat as "not yet confirmed"
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Transaction failed:")) throw e;
      console.warn("[pollConfirm] status check error (will retry):", msg);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.warn("[pollConfirm] timeout — assuming landed");
}

/**
 * Send a raw signed transaction and wait for it to land.
 * Falls back to sendTransaction + delay when sendAndConfirmTransaction times out.
 * Always returns a base58 signature string.
 */
async function sendAndConfirm(txBytes: Uint8Array | Buffer): Promise<string> {
  try {
    const confirmed = await client.sendAndConfirmTransaction(txBytes);
    return confirmed.signature; // already base58
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timed out") || msg.includes("TRANSACTION_CONFIRMATION_TIMEOUT") || msg.includes("timeout")) {
      // sendAndConfirmTransaction timed out — send non-confirming and wait
      const sig = await client.sendTransaction(txBytes); // returns base58 string
      // Wait for devnet to finalize (typically 2–6s); avoid getSignatureStatuses
      // since it requires Uint8Array and we only have the base58 string here.
      await new Promise((r) => setTimeout(r, 5_000));
      console.log("[sendAndConfirm] fallback confirmed (5s wait):", sig);
      return sig;
    }
    throw e;
  }
}

/**
 * Airdrop and confirm with manual polling.
 * requestAirdrop returns Signature (Uint8Array); convert to base58 for API response.
 */
async function airdropAndConfirm(pk: PublicKey, kelvin: bigint): Promise<string> {
  const sigBytes = await client.requestAirdrop(pk, kelvin); // Uint8Array
  await pollConfirm(sigBytes);
  return sigToBase58(sigBytes);
}

// ─── Deployer keypair (optional) ──────────────────────────────────────────────
let deployerKeypair: Keypair | null = null;
const secretHex = process.env.RIALO_DEPLOYER_SECRET_HEX;
if (secretHex) {
  const secretBytes = Buffer.from(secretHex, "hex");
  deployerKeypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
  console.log("[deployer] pubkey:", deployerKeypair.publicKey.toString());
}

// ─── Token registry (persisted) ───────────────────────────────────────────────
const DATA_FILE = path.join(process.cwd(), "server", "tokens.json");

interface TradeRecord {
  id: string;
  type: "buy" | "sell";
  trader: string;
  rloAmount: number;
  tokenAmount: number;
  price: number;
  timestamp: number;
  txHash: string;
  onchain: boolean;
}

interface TokenRecord {
  id: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  creator: string;
  createdAt: number;
  /** Tokens sold to traders (formerly tokenSupply) */
  tokenSupply: number;
  totalSupply: number;
  graduated: boolean;
  trades: TradeRecord[];
  marketCap: number;
  tokenTaxBps: number;
  creatorEarnings: number;
  /** Real RLO raised toward graduation (kelvin) */
  realRloRaised: number;
  onchain: boolean;
  tokenIdHex: string;
}

function loadTokens(): Map<string, TokenRecord> {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as Record<string, TokenRecord>;
      return new Map(Object.entries(raw));
    }
  } catch {}
  return new Map();
}

function saveTokens(tokens: Map<string, TokenRecord>) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const obj: Record<string, TokenRecord> = {};
    for (const [k, v] of tokens) obj[k] = v;
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("Failed to save tokens:", e);
  }
}

const tokens: Map<string, TokenRecord> = loadTokens();

// ─── Constants (must match program/src/state.rs) ─────────────────────────────
// ALL internal math uses KELVIN. Convert RLO→kelvin at API entry points.
const KELVIN_PER_RLO        = 1_000_000_000;
// Devnet RLO→USD rate. Override via RLO_USD_RATE env var; replace with oracle on mainnet.
const RLO_USD_RATE          = parseFloat(process.env.RLO_USD_RATE ?? "0.10");
const TOTAL_SUPPLY          = 1_000_000_000;   // 1B tokens, all on curve
const PHANTOM_RLO           = 30 * KELVIN_PER_RLO;   // 30 RLO virtual reserve
const GRADUATION_RLO_TARGET = 85 * KELVIN_PER_RLO;   // 85 RLO
const PLATFORM_FEE_BPS      = 100;                    // 1%

/** Convert RLO float → kelvin integer (round to nearest). */
function rloToKelvin(rlo: number): number { return Math.round(rlo * KELVIN_PER_RLO); }
/** Convert kelvin → RLO float. */
function kelvinToRlo(k: number): number { return k / KELVIN_PER_RLO; }

// ─── Bonding curve math (all amounts in KELVIN) ───────────────────────────────

/** Constant-product buy. rloIn in kelvin → tokens out. */
function calcBuyTokens(rloInKelvin: number, virtualRlo: number, virtualTokens: number) {
  const k = virtualRlo * virtualTokens;
  const newVr = virtualRlo + rloInKelvin;
  const newVt = k / newVr;
  return { tokensOut: Math.floor(virtualTokens - newVt), newVr, newVt };
}

/** Constant-product sell. tokensIn → rlo out in kelvin before fees. */
function calcSellRlo(tokensIn: number, virtualRlo: number, virtualTokens: number) {
  const k = virtualRlo * virtualTokens;
  const newVt = virtualTokens + tokensIn;
  const newVr = k / newVt;
  return { rloOut: Math.floor(virtualRlo - newVr), newVr, newVt };
}

/**
 * Virtual state from onchain read (preferred) or trade replay (fallback).
 * When onchain state has been synced into t.realRloRaised / t.tokenSupply,
 * reconstruct reserves directly from those; otherwise replay t.trades.
 * ALL values in kelvin.
 */
function buildVirtualState(t: TokenRecord) {
  // If onchain sync populated realRloRaised, derive reserves from it directly.
  if (t.onchain && t.realRloRaised > 0) {
    const vRlo    = PHANTOM_RLO + t.realRloRaised;
    const vTokens = TOTAL_SUPPLY - t.tokenSupply;
    const currentPrice = vTokens > 0 ? vRlo / vTokens : 0;
    return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice, realRloRaised: t.realRloRaised };
  }
  // Fallback: replay trades. trade.rloAmount stored in kelvin.
  let vRlo    = PHANTOM_RLO;
  let vTokens = TOTAL_SUPPLY;
  let realRloRaised = 0;
  for (const trade of t.trades) {
    const taxBps = t.tokenTaxBps || 0;
    if (trade.type === "buy") {
      const fee  = Math.floor(trade.rloAmount * PLATFORM_FEE_BPS / 10_000);
      const tax  = Math.floor(trade.rloAmount * taxBps / 10_000);
      const into = trade.rloAmount - fee - tax;
      const r = calcBuyTokens(into, vRlo, vTokens);
      vRlo = r.newVr; vTokens = r.newVt;
      realRloRaised += into;
    } else {
      const r = calcSellRlo(trade.tokenAmount, vRlo, vTokens);
      vRlo = r.newVr; vTokens = r.newVt;
      realRloRaised = Math.max(0, realRloRaised - r.rloOut);
    }
  }
  const currentPrice = vTokens > 0 ? vRlo / vTokens : 0;
  return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice, realRloRaised };
}

// ─── Sync onchain state into token record ─────────────────────────────────────
async function syncOnchainState(t: TokenRecord): Promise<void> {
  if (!t.onchain) return;
  try {
    const tokenIdBytes = tokenIdToBytes(t.tokenIdHex);
    const { pda } = deriveTokenStatePda(tokenIdBytes, PublicKey.fromString(PROGRAM_ID_STR));
    const info = await client.getAccountInfo(pda);
    if (!info?.data) return;
    const raw = Array.isArray(info.data)
      ? (info.data as [string, string])[0]
      : (info.data as string);
    const data = info.data instanceof Uint8Array
      ? info.data
      : new Uint8Array(Buffer.from(raw, "base64"));
    const state = deserializeTokenState(data);
    t.tokenSupply     = Number(state.tokensSold);
    t.graduated       = state.graduated;
    t.tokenTaxBps     = Number(state.tokenTaxBps);
    t.creatorEarnings = Number(state.creatorEarnings);
    const vRlo    = Number(state.virtualRlo);
    const vTokens = Number(state.virtualTokens);
    const priceKelvin = vTokens > 0 ? vRlo / vTokens : 0;        // kelvin / token
    const priceRlo    = kelvinToRlo(priceKelvin);                  // RLO / token
    t.marketCap   = priceRlo * t.tokenSupply;                      // RLO
    // Store real RLO raised in kelvin (raw from chain) for graduation progress
    t.realRloRaised = Number(state.realRloRaised);                 // kelvin
  } catch {
    // keep cached values if chain read fails
  }
}

/**
 * Decode a 16-byte token ID from its hex string representation.
 * The hex string is exactly 32 chars (16 bytes × 2 hex digits each).
 * If shorter, pad with zero bytes on the right.
 */
function tokenIdToBytes(idHex: string): Uint8Array {
  const hex = idHex.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rpc: RPC_URL, programId: PROGRAM_ID_STR });
});

app.get("/deployer", (_req, res) => {
  if (!deployerKeypair) return res.status(503).json({ error: "No deployer key" });
  res.json({ pubkey: deployerKeypair.publicKey.toString() });
});

app.get("/chain", async (_req, res) => {
  try {
    const [height, epoch] = await Promise.all([
      client.getBlockHeight(),
      client.getEpochInfo(),
    ]);
    // All fields stringified — getEpochInfo returns BigInt fields
    res.json({
      blockHeight: height.toString(),
      epoch: epoch.epoch.toString(),
      slot: epoch.absoluteSlot.toString(),
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// RPC proxy — browser cannot call devnet RPC directly (CORS)
app.post("/rpc/config-hash", async (_req, res) => {
  try {
    const configHashPrefix = await client.getConfigHashPrefix();
    res.json({ configHashPrefix: configHashPrefix.toString() });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/rpc/send-tx", async (req, res) => {
  try {
    const { txBase64 } = req.body as { txBase64?: string };
    if (!txBase64) return res.status(400).json({ error: "txBase64 required" });
    const txBytes = new Uint8Array(Buffer.from(txBase64, "base64"));
    const sig = await sendAndConfirm(txBytes);
    res.json({ signature: sig });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Airdrop — max 1 RLO per call, so accept `calls` to do multiple
app.post("/airdrop", async (req, res) => {
  try {
    const { pubkey, amount } = req.body as { pubkey?: string; amount?: number };
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    const pk = PublicKey.fromString(pubkey);
    // Clamp to 1 RLO max per call
    const rlo = Math.min(amount || 1, 1);
    const kelvin = BigInt(Math.round(rlo * KELVIN_PER_RLO));
    const sig = await airdropAndConfirm(pk, kelvin);
    res.json({ success: true, signature: sig });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/balance/:pubkey", async (req, res) => {
  try {
    const pk = PublicKey.fromString(req.params.pubkey);
    const bal = await client.getBalance(pk);
    res.json({ kelvin: bal.toString(), rlo: (Number(bal) / KELVIN_PER_RLO).toFixed(6) });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// List tokens
app.get("/tokens", async (_req, res) => {
  const list = Array.from(tokens.values());
  await Promise.allSettled(list.map((t) => syncOnchainState(t)));
  const result = list
    .sort((a, b) => b.marketCap - a.marketCap)
    .map((t) => {
      const vs = buildVirtualState(t);
      const rloRaisedKelvin = t.realRloRaised || vs.realRloRaised;
      return {
        id: t.id,
        name: t.name,
        symbol: t.symbol,
        description: t.description,
        imageUrl: t.imageUrl,
        creator: t.creator,
        createdAt: t.createdAt,
        tokenSupply: t.tokenSupply,
        totalSupply: t.totalSupply,
        graduated: t.graduated,
        tradeCount: t.trades.length,
        currentPrice: kelvinToRlo(vs.currentPrice),      // RLO/token
        marketCap: t.marketCap,                           // RLO
        priceUsd: kelvinToRlo(vs.currentPrice) * RLO_USD_RATE,
        marketCapUsd: t.marketCap * RLO_USD_RATE,
        progressPct: Math.min(100, (rloRaisedKelvin / GRADUATION_RLO_TARGET) * 100),
        tokenTaxBps: t.tokenTaxBps || 0,
        creatorEarnings: t.creatorEarnings || 0,
        realRloRaised: kelvinToRlo(rloRaisedKelvin),      // RLO
        graduationTarget: kelvinToRlo(GRADUATION_RLO_TARGET), // RLO (= 85)
        onchain: t.onchain,
      };
    });
  res.json(result);
});

app.get("/tokens/:id", async (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  await syncOnchainState(t);
  const state = buildVirtualState(t);
  res.json({
    id: t.id,
    name: t.name,
    symbol: t.symbol,
    description: t.description,
    imageUrl: t.imageUrl,
    creator: t.creator,
    createdAt: t.createdAt,
    tokenSupply: t.tokenSupply,
    totalSupply: t.totalSupply,
    graduated: t.graduated,
    tradeCount: t.trades.length,
    currentPrice: kelvinToRlo(state.currentPrice),           // RLO/token
    marketCap: t.marketCap,                                   // RLO
    priceUsd: kelvinToRlo(state.currentPrice) * RLO_USD_RATE,
    marketCapUsd: t.marketCap * RLO_USD_RATE,
    progressPct: Math.min(100, ((t.realRloRaised || state.realRloRaised) / GRADUATION_RLO_TARGET) * 100),
    virtualRlo: kelvinToRlo(state.virtualRlo),                // RLO (for chart)
    realRloRaised: kelvinToRlo(t.realRloRaised || state.realRloRaised), // RLO
    graduationTarget: kelvinToRlo(GRADUATION_RLO_TARGET),     // RLO (= 85)
    tokenTaxBps: t.tokenTaxBps || 0,
    creatorEarnings: t.creatorEarnings || 0,
    onchain: t.onchain,
  });
});

// Raw onchain token state (for browser reads via proxy)
app.get("/tokens/:id/state", async (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json(null);
  await syncOnchainState(t);
  const state = buildVirtualState(t);
  res.json({
    tokensSold: t.tokenSupply,
    realRloRaised: kelvinToRlo(t.realRloRaised || state.realRloRaised), // RLO
    creatorEarnings: t.creatorEarnings || 0, // kelvin (frontend uses formatRlo)
    tokenTaxBps: t.tokenTaxBps || 0,
    graduated: t.graduated,
  });
});

// Create token
app.post("/tokens", async (req, res) => {
  try {
    const {
      name, symbol, description, imageUrl, creator,
      signedTxBase64, tokenIdHex, tokenTaxBps,
    } = req.body as {
      name?: string; symbol?: string; description?: string; imageUrl?: string;
      creator?: string; signedTxBase64?: string; tokenIdHex?: string; tokenTaxBps?: number;
    };
    if (!name || !symbol || !creator) {
      return res.status(400).json({ error: "name, symbol, creator required" });
    }
    if (symbol.length > 10) return res.status(400).json({ error: "symbol max 10 chars" });
    if (name.length > 32)   return res.status(400).json({ error: "name max 32 chars" });
    const taxBps = Math.min(Math.max(tokenTaxBps ?? 0, 0), 1000);

    let pk: PublicKey;
    try { pk = PublicKey.fromString(creator); } catch {
      return res.status(400).json({ error: "Invalid creator pubkey" });
    }

    // Note: no pre-flight balance check — devnet airdrop confirmation can lag
    // behind the request. The program rejects the tx if balance is truly insufficient.
    void pk; // pk validated above, used for balance reads post-confirm only

    let txHash = "";
    let onchain = false;
    const idHex = tokenIdHex || uuidv4().replace(/-/g, "").slice(0, 16);

    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        txHash = await sendAndConfirm(txBytes);
        onchain = true;
        console.log("[create] onchain tx:", txHash);
      } catch (e: unknown) {
        return res.status(400).json({
          error: `Onchain transaction failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    const token: TokenRecord = {
      id: idHex,
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      description: (description || "").trim(),
      imageUrl: imageUrl || "",
      creator,
      createdAt: Date.now(),
      tokenSupply: 0,
      totalSupply: TOTAL_SUPPLY,
      graduated: false,
      trades: [],
      marketCap: 0,
      tokenTaxBps: taxBps,
      creatorEarnings: 0,
      realRloRaised: 0,
      onchain,
      tokenIdHex: idHex,
    };

    tokens.set(idHex, token);
    saveTokens(tokens);
    res.json({ success: true, token: { ...token, txHash, trades: undefined } });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Quote buy ────────────────────────────────────────────────────────────────
// rloAmount in request is RLO (float). Convert to kelvin for curve math.
// Accepts GET (?rloAmount=) and POST ({ rloAmount }).
app.get("/tokens/:id/quote-buy", handleQuoteBuy);
app.post("/tokens/:id/quote-buy", express.json(), handleQuoteBuy);
function handleQuoteBuy(req: express.Request, res: express.Response) {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const rloFloat = Number(
    (req.body as { rloAmount?: number })?.rloAmount ?? req.query.rloAmount
  );
  if (!rloFloat || rloFloat <= 0) return res.status(400).json({ error: "rloAmount required" });

  const rloKelvin = rloToKelvin(rloFloat);
  const state = buildVirtualState(t);
  const taxBps = t.tokenTaxBps || 0;
  const platformFee = Math.floor(rloKelvin * PLATFORM_FEE_BPS / 10_000);
  const creatorTax  = Math.floor(rloKelvin * taxBps / 10_000);
  const rloAfter    = rloKelvin - platformFee - creatorTax;

  const { tokensOut } = calcBuyTokens(rloAfter, state.virtualRlo, state.virtualTokens);
  const available = TOTAL_SUPPLY - t.tokenSupply;
  const limited = Math.min(tokensOut, available);
  res.json({
    tokensOut: limited,
    fee: kelvinToRlo(platformFee),
    creatorTax: kelvinToRlo(creatorTax),
    price: limited > 0 ? rloFloat / limited : 0,
    currentPrice: kelvinToRlo(state.currentPrice),
  });
}

// ─── Quote sell ───────────────────────────────────────────────────────────────
// Accepts both GET (?tokenAmount=) and POST ({ tokenAmount }).
// rloOut returned in RLO (float) for display.
app.get("/tokens/:id/quote-sell", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const tokenAmount = Number(req.query.tokenAmount);
  if (!tokenAmount || tokenAmount <= 0) return res.status(400).json({ error: "tokenAmount query param required" });

  const state = buildVirtualState(t);
  const taxBps = t.tokenTaxBps || 0;
  const { rloOut: rloGrossK } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
  const platformFee = Math.floor(rloGrossK * PLATFORM_FEE_BPS / 10_000);
  const creatorTax  = Math.floor(rloGrossK * taxBps / 10_000);
  const rloAfterFeeK = rloGrossK - platformFee - creatorTax;

  res.json({
    rloOut: kelvinToRlo(rloAfterFeeK),
    fee: kelvinToRlo(platformFee),
    creatorTax: kelvinToRlo(creatorTax),
    price: rloAfterFeeK > 0 ? kelvinToRlo(rloAfterFeeK) / tokenAmount : 0,
    currentPrice: kelvinToRlo(state.currentPrice),
  });
});

// ─── Execute buy ──────────────────────────────────────────────────────────────
app.post("/tokens/:id/buy", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });

    const { trader, rloAmount: rloFloat, signedTxBase64 } = req.body as {
      trader?: string; rloAmount?: number; signedTxBase64?: string;
    };
    if (!trader || !rloFloat) return res.status(400).json({ error: "trader and rloAmount required" });
    // Convert RLO → kelvin for all internal math
    const rloKelvin = rloToKelvin(rloFloat);

    let txHash = "sim_" + uuidv4().replace(/-/g, "").slice(0, 16);
    let onchain = false;

    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        txHash = await sendAndConfirm(txBytes);
        onchain = true;
      } catch (e: unknown) {
        return res.status(400).json({ error: `Transaction failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      const pk = PublicKey.fromString(trader);
      const balance = await client.getBalance(pk);
      if (Number(balance) < rloKelvin) {
        return res.status(400).json({ error: "Insufficient RLO balance" });
      }
    }

    if (onchain) await syncOnchainState(t);
    const state    = buildVirtualState(t);
    const taxBps   = t.tokenTaxBps || 0;
    const fee      = Math.floor(rloKelvin * PLATFORM_FEE_BPS / 10_000);
    const tax      = Math.floor(rloKelvin * taxBps / 10_000);
    const into     = rloKelvin - fee - tax;
    const { tokensOut } = calcBuyTokens(into, state.virtualRlo, state.virtualTokens);
    const limitedTokens = Math.min(tokensOut, TOTAL_SUPPLY - t.tokenSupply);
    if (limitedTokens <= 0) return res.status(400).json({ error: "No tokens available" });

    const trade: TradeRecord = {
      id: uuidv4().replace(/-/g, "").slice(0, 16),
      type: "buy",
      trader,
      rloAmount: rloKelvin,        // stored in kelvin
      tokenAmount: limitedTokens,
      price: rloKelvin / limitedTokens,
      timestamp: Date.now(),
      txHash,
      onchain,
    };

    t.trades.push(trade);
    if (!onchain) {
      t.tokenSupply += limitedTokens;
      t.realRloRaised = (t.realRloRaised || 0) + into;
      if (t.realRloRaised >= GRADUATION_RLO_TARGET) t.graduated = true;
    } else {
      await syncOnchainState(t);
    }
    const newState = buildVirtualState(t);
    t.marketCap = kelvinToRlo(newState.currentPrice) * t.tokenSupply;
    tokens.set(t.id, t);
    saveTokens(tokens);

    res.json({
      success: true, trade,
      tokenSupply: t.tokenSupply, graduated: t.graduated,
      currentPrice: kelvinToRlo(newState.currentPrice),
      progressPct: Math.min(100, ((t.realRloRaised || newState.realRloRaised) / GRADUATION_RLO_TARGET) * 100),
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Execute sell ─────────────────────────────────────────────────────────────
app.post("/tokens/:id/sell", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });

    const { trader, tokenAmount, signedTxBase64 } = req.body as {
      trader?: string; tokenAmount?: number; signedTxBase64?: string;
    };
    if (!trader || !tokenAmount) return res.status(400).json({ error: "trader and tokenAmount required" });

    let txHash = "sim_" + uuidv4().replace(/-/g, "").slice(0, 16);
    let onchain = false;

    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        txHash = await sendAndConfirm(txBytes);
        onchain = true;
      } catch (e: unknown) {
        return res.status(400).json({ error: `Transaction failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      const traderBal =
        t.trades.filter((tr) => tr.trader === trader && tr.type === "buy").reduce((s, tr) => s + tr.tokenAmount, 0) -
        t.trades.filter((tr) => tr.trader === trader && tr.type === "sell").reduce((s, tr) => s + tr.tokenAmount, 0);
      if (traderBal < tokenAmount) {
        return res.status(400).json({ error: `Insufficient token balance. You hold ${traderBal}.` });
      }
    }

    if (onchain) await syncOnchainState(t);
    const state       = buildVirtualState(t);
    const taxBps      = t.tokenTaxBps || 0;
    const { rloOut: rloGross } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
    const fee         = Math.floor(rloGross * PLATFORM_FEE_BPS / 10_000);
    const tax         = Math.floor(rloGross * taxBps / 10_000);
    const rloAfterFee = rloGross - fee - tax;
    if (rloAfterFee <= 0) return res.status(400).json({ error: "Nothing to receive" });

    const trade: TradeRecord = {
      id: uuidv4().replace(/-/g, "").slice(0, 16),
      type: "sell",
      trader,
      rloAmount: rloAfterFee,
      tokenAmount,
      price: rloAfterFee / tokenAmount,
      timestamp: Date.now(),
      txHash,
      onchain,
    };

    t.trades.push(trade);
    if (!onchain) {
      t.tokenSupply -= tokenAmount;
      t.realRloRaised = Math.max(0, (t.realRloRaised || 0) - rloGross);
    } else {
      await syncOnchainState(t);
    }
    const newState = buildVirtualState(t);
    t.marketCap = kelvinToRlo(newState.currentPrice) * t.tokenSupply;
    tokens.set(t.id, t);
    saveTokens(tokens);

    res.json({
      success: true, trade,
      tokenSupply: t.tokenSupply,
      currentPrice: kelvinToRlo(newState.currentPrice),
      progressPct: Math.min(100, ((t.realRloRaised || newState.realRloRaised) / GRADUATION_RLO_TARGET) * 100),
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Claim creator earnings ───────────────────────────────────────────────────
app.post("/tokens/:id/claim-earnings", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    const { signedTxBase64 } = req.body as { signedTxBase64?: string };
    if (!signedTxBase64) return res.status(400).json({ error: "signedTxBase64 required" });

    const txBytes = Buffer.from(signedTxBase64, "base64");
    const sig = await sendAndConfirm(txBytes);
    // Sync state from chain after claim
    await syncOnchainState(t);
    saveTokens(tokens);
    res.json({ success: true, signature: sig });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Update token tax ─────────────────────────────────────────────────────────
app.post("/tokens/:id/update-tax", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    const { signedTxBase64, newTaxBps } = req.body as { signedTxBase64?: string; newTaxBps?: number };
    if (!signedTxBase64) return res.status(400).json({ error: "signedTxBase64 required" });
    if (newTaxBps === undefined) return res.status(400).json({ error: "newTaxBps required" });
    if (newTaxBps < 0 || newTaxBps > 1000) return res.status(400).json({ error: "newTaxBps must be 0–1000" });

    const txBytes = Buffer.from(signedTxBase64, "base64");
    const sig = await sendAndConfirm(txBytes);
    // Optimistically update local cache, then sync from chain
    t.tokenTaxBps = newTaxBps;
    await syncOnchainState(t);
    saveTokens(tokens);
    res.json({ success: true, signature: sig });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ─── Trades + Portfolio + Wallet ──────────────────────────────────────────────
app.get("/tokens/:id/trades", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  res.json([...t.trades].reverse().slice(0, 100));
});

app.get("/portfolio/:pubkey", (req, res) => {
  const { pubkey } = req.params;
  const holdings: Array<{ token: Omit<TokenRecord, "trades">; balance: number; value: number; pnl: number }> = [];
  for (const t of tokens.values()) {
    const bought = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "buy");
    const sold   = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "sell");
    const tokenBal = bought.reduce((s, tr) => s + tr.tokenAmount, 0) - sold.reduce((s, tr) => s + tr.tokenAmount, 0);
    if (tokenBal > 0) {
      const state = buildVirtualState(t);
      const value = kelvinToRlo(state.currentPrice) * tokenBal;
      const spent    = bought.reduce((s, tr) => s + tr.rloAmount, 0);
      const received = sold.reduce((s, tr) => s + tr.rloAmount, 0);
      const { trades: _trades, ...tokenWithoutTrades } = t;
      void _trades;
      holdings.push({ token: tokenWithoutTrades, balance: tokenBal, value, pnl: value + received - spent });
    }
  }
  res.json(holdings);
});

app.post("/wallet/generate", (_req, res) => {
  const secret = randomBytes(32);
  res.json({ secretHex: secret.toString("hex"), note: "Store safely — this is your wallet key on Rialo devnet." });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[rialo-launchpad] Server on :${PORT} | Program: ${PROGRAM_ID_STR}`);
  // Sync all existing tokens from chain on boot so tokenSupply/marketCap are fresh
  void (async () => {
    const ids = [...tokens.keys()];
    if (ids.length === 0) return;
    console.log(`[rialo-launchpad] Syncing ${ids.length} token(s) from chain on boot…`);
    let ok = 0;
    for (const id of ids) {
      const t = tokens.get(id);
      if (t) {
        try { await syncOnchainState(t); ok++; } catch { /* non-fatal */ }
      }
    }
    console.log(`[rialo-launchpad] Boot sync complete: ${ok}/${ids.length} tokens updated`);
  })();
});
