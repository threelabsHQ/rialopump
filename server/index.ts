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
const KELVIN_PER_RLO      = 1_000_000_000;
const TOTAL_SUPPLY        = 1_000_000_000;   // all tokens start on curve
/** Phantom reserve — sets opening price. virtual_rlo starts here. */
const PHANTOM_RLO         = 30 * KELVIN_PER_RLO;
/** Graduation threshold in kelvin (85 RLO on devnet). */
const GRADUATION_RLO_TARGET = 85 * KELVIN_PER_RLO;
const PLATFORM_FEE_BPS    = 100;
/** Creation fee (0.02 RLO) — for balance check at creation time. */
const CREATION_FEE_KELVIN = 20_000_000;

// ─── Bonding curve math ───────────────────────────────────────────────────────

/** Constant-product buy. Returns tokens_out using floating-point (server-side). */
function calcBuyTokens(rloIn: number, virtualRlo: number, virtualTokens: number) {
  const k = virtualRlo * virtualTokens;
  const newVr = virtualRlo + rloIn;
  const newVt = k / newVr;
  return { tokensOut: Math.floor(virtualTokens - newVt), newVr, newVt };
}

/** Constant-product sell. Returns rlo_out before fees. */
function calcSellRlo(tokensIn: number, virtualRlo: number, virtualTokens: number) {
  const k = virtualRlo * virtualTokens;
  const newVt = virtualTokens + tokensIn;
  const newVr = k / newVt;
  return { rloOut: Math.floor(virtualRlo - newVr), newVr, newVt };
}

/**
 * Reconstruct current virtual state by replaying trades.
 * virtual_rlo starts at PHANTOM_RLO; virtual_tokens starts at TOTAL_SUPPLY.
 * Also tracks realRloRaised for graduation progress.
 */
function buildVirtualState(t: TokenRecord) {
  let vRlo    = PHANTOM_RLO;
  let vTokens = TOTAL_SUPPLY;
  let realRloRaised = 0;
  for (const trade of t.trades) {
    const taxBps = t.tokenTaxBps || 0;
    if (trade.type === "buy") {
      const fee = Math.floor(trade.rloAmount * PLATFORM_FEE_BPS / 10_000);
      const tax = Math.floor(trade.rloAmount * taxBps / 10_000);
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
    const price   = vTokens > 0 ? vRlo / vTokens : 0;
    t.marketCap   = Math.round(price * t.tokenSupply);
    // Store real RLO raised for graduation progress (not tokens sold)
    t.realRloRaised = Number(state.realRloRaised);
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
    res.json({ blockHeight: height.toString(), epoch: epoch.epoch, slot: epoch.absoluteSlot.toString() });
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
    const confirmed = await client.requestAirdropAndConfirm(pk, kelvin);
    res.json({ success: true, signature: confirmed.signature });
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
      const rloRaised = t.realRloRaised || vs.realRloRaised;
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
        currentPrice: vs.currentPrice,
        marketCap: t.marketCap,
        progressPct: Math.min(100, (rloRaised / GRADUATION_RLO_TARGET) * 100),
        tokenTaxBps: t.tokenTaxBps || 0,
        creatorEarnings: t.creatorEarnings || 0,
        realRloRaised: rloRaised,
        graduationTarget: GRADUATION_RLO_TARGET,
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
    currentPrice: state.currentPrice,
    marketCap: t.marketCap,
    progressPct: Math.min(100, ((t.realRloRaised || state.realRloRaised) / GRADUATION_RLO_TARGET) * 100),
    virtualRlo: state.virtualRlo,
    realRloRaised: t.realRloRaised || state.realRloRaised,
    graduationTarget: GRADUATION_RLO_TARGET,
    tokenTaxBps: t.tokenTaxBps || 0,
    creatorEarnings: t.creatorEarnings || 0,
    onchain: t.onchain,
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

    const balance = await client.getBalance(pk);
    // Must cover creation fee (0.02 RLO) + rent for PDA + first buy overhead
    const minRequired = BigInt(CREATION_FEE_KELVIN + Math.round(0.05 * KELVIN_PER_RLO));
    if (balance < minRequired) {
      return res.status(400).json({ error: "Insufficient balance — need at least 0.07 RLO to launch." });
    }

    let txHash = "";
    let onchain = false;
    const idHex = tokenIdHex || uuidv4().replace(/-/g, "").slice(0, 16);

    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        const confirmed = await client.sendAndConfirmTransaction(txBytes);
        txHash = confirmed.signature;
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
app.post("/tokens/:id/quote-buy", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const { rloAmount } = req.body as { rloAmount?: number };
  if (!rloAmount || rloAmount <= 0) return res.status(400).json({ error: "rloAmount required (kelvin)" });

  const state = buildVirtualState(t);
  const taxBps = t.tokenTaxBps || 0;
  const platformFee = Math.floor(rloAmount * PLATFORM_FEE_BPS / 10_000);
  const creatorTax  = Math.floor(rloAmount * taxBps / 10_000);
  const rloAfter    = rloAmount - platformFee - creatorTax;

  const { tokensOut } = calcBuyTokens(rloAfter, state.virtualRlo, state.virtualTokens);
  const available = TOTAL_SUPPLY - t.tokenSupply;
  const limited = Math.min(tokensOut, available);
  res.json({
    tokensOut: limited,
    fee: platformFee,
    creatorTax,
    price: rloAmount / Math.max(limited, 1),
    currentPrice: state.currentPrice,
  });
});

// ─── Quote sell ───────────────────────────────────────────────────────────────
app.post("/tokens/:id/quote-sell", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const { tokenAmount } = req.body as { tokenAmount?: number };
  if (!tokenAmount || tokenAmount <= 0) return res.status(400).json({ error: "tokenAmount required" });

  const state = buildVirtualState(t);
  const taxBps = t.tokenTaxBps || 0;
  const { rloOut: rloGross } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
  const platformFee = Math.floor(rloGross * PLATFORM_FEE_BPS / 10_000);
  const creatorTax  = Math.floor(rloGross * taxBps / 10_000);
  const rloAfterFee = rloGross - platformFee - creatorTax;

  res.json({
    rloOut: rloAfterFee,
    fee: platformFee,
    creatorTax,
    price: rloAfterFee / Math.max(tokenAmount, 1),
    currentPrice: state.currentPrice,
  });
});

// ─── Execute buy ──────────────────────────────────────────────────────────────
app.post("/tokens/:id/buy", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });

    const { trader, rloAmount, signedTxBase64 } = req.body as {
      trader?: string; rloAmount?: number; signedTxBase64?: string;
    };
    if (!trader || !rloAmount) return res.status(400).json({ error: "trader and rloAmount required" });

    let txHash = "sim_" + uuidv4().replace(/-/g, "").slice(0, 16);
    let onchain = false;

    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        const confirmed = await client.sendAndConfirmTransaction(txBytes);
        txHash = confirmed.signature;
        onchain = true;
      } catch (e: unknown) {
        return res.status(400).json({ error: `Transaction failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      const pk = PublicKey.fromString(trader);
      const balance = await client.getBalance(pk);
      if (Number(balance) < rloAmount) {
        return res.status(400).json({ error: "Insufficient RLO balance" });
      }
    }

    if (onchain) await syncOnchainState(t);
    const state    = buildVirtualState(t);
    const taxBps   = t.tokenTaxBps || 0;
    const fee      = Math.floor(rloAmount * PLATFORM_FEE_BPS / 10_000);
    const tax      = Math.floor(rloAmount * taxBps / 10_000);
    const into     = rloAmount - fee - tax;
    const { tokensOut } = calcBuyTokens(into, state.virtualRlo, state.virtualTokens);
    const limitedTokens = Math.min(tokensOut, TOTAL_SUPPLY - t.tokenSupply);
    if (limitedTokens <= 0) return res.status(400).json({ error: "No tokens available" });

    const trade: TradeRecord = {
      id: uuidv4().replace(/-/g, "").slice(0, 16),
      type: "buy",
      trader,
      rloAmount,
      tokenAmount: limitedTokens,
      price: rloAmount / limitedTokens,
      timestamp: Date.now(),
      txHash,
      onchain,
    };

    t.trades.push(trade);
    if (!onchain) {
      t.tokenSupply += limitedTokens;
      t.realRloRaised = (t.realRloRaised || 0) + into;
      if (t.realRloRaised >= GRADUATION_RLO_TARGET) t.graduated = true;
    }
    const newState = buildVirtualState(t);
    t.marketCap = Math.round(newState.currentPrice * t.tokenSupply);
    tokens.set(t.id, t);
    saveTokens(tokens);

    res.json({
      success: true, trade,
      tokenSupply: t.tokenSupply, graduated: t.graduated,
      currentPrice: newState.currentPrice,
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
        const confirmed = await client.sendAndConfirmTransaction(txBytes);
        txHash = confirmed.signature;
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
    }
    const newState = buildVirtualState(t);
    t.marketCap = Math.round(newState.currentPrice * t.tokenSupply);
    tokens.set(t.id, t);
    saveTokens(tokens);

    res.json({
      success: true, trade,
      tokenSupply: t.tokenSupply, currentPrice: newState.currentPrice,
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
    const confirmed = await client.sendAndConfirmTransaction(txBytes);
    // Sync state from chain after claim
    await syncOnchainState(t);
    saveTokens(tokens);
    res.json({ success: true, signature: confirmed.signature });
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
    const confirmed = await client.sendAndConfirmTransaction(txBytes);
    // Optimistically update local cache, then sync from chain
    t.tokenTaxBps = newTaxBps;
    await syncOnchainState(t);
    saveTokens(tokens);
    res.json({ success: true, signature: confirmed.signature });
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
      const value = Math.round(state.currentPrice * tokenBal);
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
});
