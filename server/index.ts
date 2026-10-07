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

// ─── Rialo client ────────────────────────────────────────────────────────────
const RPC_URL = process.env.RIALO_DEVNET_RPC || "https://devnet.rialo.io:4101";
const PROGRAM_ID_STR = process.env.VITE_PROGRAM_ID || "AqSikYubk5DEygNhAZh1rSuVvrtNyHTUveLrze1QHn3R";
const client: RialoClient = createRialoClient({ chain: RIALO_DEVNET_CHAIN });

// ─── Deployer keypair ─────────────────────────────────────────────────────────
let deployerKeypair: Keypair | null = null;
const secretHex = process.env.RIALO_DEPLOYER_SECRET_HEX;
if (secretHex) {
  const secretBytes = Buffer.from(secretHex, "hex");
  deployerKeypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
  console.log("[deployer] pubkey:", deployerKeypair.publicKey.toBase58());
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
  // Canonical state comes from chain; these are cached/fallback values
  tokenSupply: number;
  totalSupply: number;
  graduated: boolean;
  trades: TradeRecord[];
  marketCap: number;
  // Onchain: true means CreateToken was submitted onchain
  onchain: boolean;
  // token_id bytes as hex (16 chars = 16 ascii bytes)
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

// ─── Constants ────────────────────────────────────────────────────────────────
const KELVIN_PER_RLO = 1_000_000_000;
const MAX_TOKEN_SUPPLY = 1_000_000_000;
const GRADUATION_SUPPLY = 800_000_000;
const INITIAL_VIRTUAL_RLO = 30 * KELVIN_PER_RLO;
const INITIAL_VIRTUAL_TOKENS = 1_073_000_191;
const PLATFORM_FEE_BPS = 100;

// ─── Bonding curve math ───────────────────────────────────────────────────────
function calcBuyTokens(rloIn: number, virtualRlo: number, virtualTokens: number) {
  const k = virtualRlo * virtualTokens;
  const newVirtualRlo = virtualRlo + rloIn;
  const newVirtualTokens = k / newVirtualRlo;
  const tokensOut = virtualTokens - newVirtualTokens;
  return { tokensOut: Math.floor(tokensOut), newVirtualRlo, newVirtualTokens };
}

function calcSellRlo(tokensIn: number, virtualRlo: number, virtualTokens: number) {
  const k = virtualRlo * virtualTokens;
  const newVirtualTokens = virtualTokens + tokensIn;
  const newVirtualRlo = k / newVirtualTokens;
  const rloOut = virtualRlo - newVirtualRlo;
  return { rloOut: Math.floor(rloOut), newVirtualRlo, newVirtualTokens };
}

function buildVirtualState(t: TokenRecord) {
  let vRlo = INITIAL_VIRTUAL_RLO;
  let vTokens = INITIAL_VIRTUAL_TOKENS;
  for (const trade of t.trades) {
    if (trade.type === "buy") {
      const fee = Math.floor(trade.rloAmount * PLATFORM_FEE_BPS / 10000);
      const r = calcBuyTokens(trade.rloAmount - fee, vRlo, vTokens);
      vRlo = r.newVirtualRlo; vTokens = r.newVirtualTokens;
    } else {
      const r = calcSellRlo(trade.tokenAmount, vRlo, vTokens);
      vRlo = r.newVirtualRlo; vTokens = r.newVirtualTokens;
    }
  }
  return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice: vRlo / vTokens };
}

// ─── Fetch live onchain state and merge into token record ────────────────────
async function syncOnchainState(t: TokenRecord): Promise<void> {
  if (!t.onchain) return;
  try {
    const tokenIdBytes = tokenIdToBytes(t.tokenIdHex);
    const { pda } = deriveTokenStatePda(tokenIdBytes, PublicKey.fromString(PROGRAM_ID_STR));
    const info = await client.getAccountInfo(pda);
    if (!info?.data) return;
    // RPC returns data as [base64String, "base64"] tuple
    const raw = Array.isArray(info.data) ? (info.data as [string, string])[0] : info.data as string;
    const data = info.data instanceof Uint8Array
      ? info.data
      : new Uint8Array(Buffer.from(raw, "base64"));
    const state = deserializeTokenState(data);
    t.tokenSupply = Number(state.tokenSupply);
    t.graduated = state.graduated;
    const vRlo = Number(state.virtualRlo);
    const vTokens = Number(state.virtualTokens);
    const price = vTokens > 0 ? vRlo / vTokens : 0;
    t.marketCap = Math.round(price * t.tokenSupply);
  } catch {
    // keep cached values if chain read fails
  }
}

function tokenIdToBytes(idHex: string): Uint8Array {
  const padded = idHex.slice(0, 16).padEnd(16, "\0");
  return new Uint8Array(padded.split("").map((c) => c.charCodeAt(0)));
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rpc: RPC_URL, programId: PROGRAM_ID_STR });
});

app.get("/deployer", (_req, res) => {
  if (!deployerKeypair) return res.status(503).json({ error: "No deployer key" });
  res.json({ pubkey: deployerKeypair.publicKey.toBase58() });
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

app.post("/airdrop", async (req, res) => {
  try {
    const { pubkey, amount } = req.body as { pubkey?: string; amount?: number };
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    const pk = PublicKey.fromString(pubkey);
    const kelvin = BigInt(Math.round((amount || 1) * KELVIN_PER_RLO));
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

// List tokens — sync onchain state in background
app.get("/tokens", async (_req, res) => {
  const list = Array.from(tokens.values());
  // Sync onchain states in parallel (best-effort, don't block response)
  await Promise.allSettled(list.map((t) => syncOnchainState(t)));

  const result = list
    .sort((a, b) => b.marketCap - a.marketCap)
    .map((t) => {
      const { currentPrice } = buildVirtualState(t);
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
        currentPrice,
        marketCap: t.marketCap,
        progressPct: Math.min(100, (t.tokenSupply / GRADUATION_SUPPLY) * 100),
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
    ...t,
    trades: undefined,
    currentPrice: state.currentPrice,
    marketCap: t.marketCap,
    progressPct: Math.min(100, (t.tokenSupply / GRADUATION_SUPPLY) * 100),
    virtualRlo: state.virtualRlo,
    tradeCount: t.trades.length,
    onchain: t.onchain,
  });
});

// Create token — accepts a signed transaction from the browser
app.post("/tokens", async (req, res) => {
  try {
    const { name, symbol, description, imageUrl, creator, signedTxBase64, tokenIdHex } = req.body as {
      name?: string;
      symbol?: string;
      description?: string;
      imageUrl?: string;
      creator?: string;
      signedTxBase64?: string;
      tokenIdHex?: string;
    };

    if (!name || !symbol || !creator) {
      return res.status(400).json({ error: "name, symbol, creator required" });
    }
    if (symbol.length > 10) return res.status(400).json({ error: "symbol max 10 chars" });
    if (name.length > 32) return res.status(400).json({ error: "name max 32 chars" });

    let pk: PublicKey;
    try { pk = PublicKey.fromString(creator); } catch {
      return res.status(400).json({ error: "Invalid creator pubkey" });
    }

    // Check balance
    const balance = await client.getBalance(pk);
    const minRequired = BigInt(Math.round(0.05 * KELVIN_PER_RLO));
    if (balance < minRequired) {
      return res.status(400).json({ error: "Insufficient balance. Need at least 0.05 RLO. Use /airdrop to get test RLO." });
    }

    // Broadcast the signed CreateToken tx
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
        console.warn("[create] tx failed:", e instanceof Error ? e.message : String(e));
        return res.status(400).json({ error: `Onchain transaction failed: ${e instanceof Error ? e.message : String(e)}` });
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
      totalSupply: MAX_TOKEN_SUPPLY,
      graduated: false,
      trades: [],
      marketCap: 0,
      onchain,
      tokenIdHex: idHex,
    };

    tokens.set(idHex, token);
    saveTokens(tokens);
    res.json({ success: true, token: { ...token, txHash }, trades: undefined });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Quote endpoints (pure math, no chain read needed)
app.post("/tokens/:id/quote-buy", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const { rloAmount } = req.body as { rloAmount?: number };
  if (!rloAmount || rloAmount <= 0) return res.status(400).json({ error: "rloAmount required (kelvin)" });
  const state = buildVirtualState(t);
  const fee = Math.floor(rloAmount * PLATFORM_FEE_BPS / 10000);
  const { tokensOut } = calcBuyTokens(rloAmount - fee, state.virtualRlo, state.virtualTokens);
  const limited = Math.min(tokensOut, GRADUATION_SUPPLY - t.tokenSupply);
  res.json({ tokensOut: limited, fee, price: rloAmount / Math.max(limited, 1), currentPrice: state.currentPrice });
});

app.post("/tokens/:id/quote-sell", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const { tokenAmount } = req.body as { tokenAmount?: number };
  if (!tokenAmount || tokenAmount <= 0) return res.status(400).json({ error: "tokenAmount required" });
  const state = buildVirtualState(t);
  const { rloOut } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
  const fee = Math.floor(rloOut * PLATFORM_FEE_BPS / 10000);
  res.json({ rloOut: rloOut - fee, fee, price: (rloOut - fee) / Math.max(tokenAmount, 1), currentPrice: state.currentPrice });
});

// Execute buy — receives signed tx from browser, broadcasts, records
app.post("/tokens/:id/buy", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });

    const { trader, rloAmount, signedTxBase64 } = req.body as {
      trader?: string;
      rloAmount?: number;
      signedTxBase64?: string;
    };
    if (!trader || !rloAmount) return res.status(400).json({ error: "trader and rloAmount required" });

    // Broadcast signed tx (required for real onchain trades)
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
      // No signed tx: verify balance at minimum
      const pk = PublicKey.fromString(trader);
      const balance = await client.getBalance(pk);
      if (Number(balance) < rloAmount) {
        return res.status(400).json({ error: "Insufficient RLO balance" });
      }
    }

    // Sync from chain if onchain, else use local math
    if (onchain) await syncOnchainState(t);
    const state = buildVirtualState(t);
    const fee = Math.floor(rloAmount * PLATFORM_FEE_BPS / 10000);
    const { tokensOut } = calcBuyTokens(rloAmount - fee, state.virtualRlo, state.virtualTokens);
    const limitedTokens = Math.min(tokensOut, GRADUATION_SUPPLY - t.tokenSupply);
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
      // Update local state only for sim trades
      t.tokenSupply += limitedTokens;
      if (t.tokenSupply >= GRADUATION_SUPPLY) t.graduated = true;
    }
    const newState = buildVirtualState(t);
    t.marketCap = Math.round(newState.currentPrice * t.tokenSupply);
    tokens.set(t.id, t);
    saveTokens(tokens);

    res.json({
      success: true,
      trade,
      tokenSupply: t.tokenSupply,
      graduated: t.graduated,
      currentPrice: newState.currentPrice,
      progressPct: Math.min(100, (t.tokenSupply / GRADUATION_SUPPLY) * 100),
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Execute sell
app.post("/tokens/:id/sell", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });

    const { trader, tokenAmount, signedTxBase64 } = req.body as {
      trader?: string;
      tokenAmount?: number;
      signedTxBase64?: string;
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
      // sim: check local balance
      const traderBal =
        t.trades.filter((tr) => tr.trader === trader && tr.type === "buy").reduce((s, tr) => s + tr.tokenAmount, 0) -
        t.trades.filter((tr) => tr.trader === trader && tr.type === "sell").reduce((s, tr) => s + tr.tokenAmount, 0);
      if (traderBal < tokenAmount) {
        return res.status(400).json({ error: `Insufficient token balance. You hold ${traderBal}.` });
      }
    }

    if (onchain) await syncOnchainState(t);
    const state = buildVirtualState(t);
    const { rloOut } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
    const fee = Math.floor(rloOut * PLATFORM_FEE_BPS / 10000);
    const rloAfterFee = rloOut - fee;
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
    }
    const newState = buildVirtualState(t);
    t.marketCap = Math.round(newState.currentPrice * t.tokenSupply);
    tokens.set(t.id, t);
    saveTokens(tokens);

    res.json({
      success: true,
      trade,
      tokenSupply: t.tokenSupply,
      currentPrice: newState.currentPrice,
      progressPct: Math.min(100, (t.tokenSupply / GRADUATION_SUPPLY) * 100),
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

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
    const sold = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "sell");
    const tokenBal = bought.reduce((s, tr) => s + tr.tokenAmount, 0) - sold.reduce((s, tr) => s + tr.tokenAmount, 0);
    if (tokenBal > 0) {
      const state = buildVirtualState(t);
      const value = Math.round(state.currentPrice * tokenBal);
      const spent = bought.reduce((s, tr) => s + tr.rloAmount, 0);
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
