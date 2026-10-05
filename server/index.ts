import express from "express";
import cors from "cors";
import { createRialoClient, RIALO_DEVNET_CHAIN, Keypair } from "@rialo/ts-cdk";
import type { RialoClient } from "@rialo/ts-cdk";
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ─── Rialo client ────────────────────────────────────────────────────────────
const RPC_URL = process.env.RIALO_DEVNET_RPC || "https://devnet.rialo.io:4101";
const client: RialoClient = createRialoClient({ chain: RIALO_DEVNET_CHAIN });

// ─── Deployer keypair ─────────────────────────────────────────────────────────
let deployerKeypair: Keypair | null = null;
const secretHex = process.env.RIALO_DEPLOYER_SECRET_HEX;
if (secretHex) {
  const secretBytes = Buffer.from(secretHex, "hex");
  deployerKeypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
  console.log("[deployer] pubkey:", deployerKeypair.publicKey.toBase58());
}

// ─── In-memory token registry (persisted to JSON file) ───────────────────────
const DATA_FILE = path.join(process.cwd(), "server", "tokens.json");

interface TokenRecord {
  id: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  creator: string;
  createdAt: number;
  // Bonding curve state
  rloSupply: number;      // RLO in the pool (in kelvin)
  tokenSupply: number;    // tokens minted so far
  totalSupply: number;    // max supply: 1_000_000_000
  graduated: boolean;     // reached 800M tokens = graduated
  trades: TradeRecord[];
  marketCap: number;      // in RLO (kelvin)
}

interface TradeRecord {
  id: string;
  type: "buy" | "sell";
  trader: string;
  rloAmount: number;    // kelvin
  tokenAmount: number;
  price: number;        // RLO per token
  timestamp: number;
  txHash: string;
}

// KELVIN_PER_RLO = 1_000_000_000
const KELVIN_PER_RLO = 1_000_000_000;
const MAX_TOKEN_SUPPLY = 1_000_000_000;
const GRADUATION_SUPPLY = 800_000_000; // 80% = graduated to full DEX
const INITIAL_VIRTUAL_RLO = 30 * KELVIN_PER_RLO; // 30 RLO virtual liquidity
const INITIAL_VIRTUAL_TOKENS = 1_073_000_191; // virtual token reserve (pump.fun style)
const PLATFORM_FEE_BPS = 100; // 1%

function loadTokens(): Map<string, TokenRecord> {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
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

// ─── Bonding curve math (constant-product AMM, pump.fun style) ───────────────
// Uses x * y = k with virtual reserves
function getPrice(virtualRlo: number, virtualTokens: number): number {
  // Price in kelvin per token
  return virtualRlo / virtualTokens;
}

function calcBuyTokens(
  rloIn: number,           // kelvin, after fee
  virtualRlo: number,
  virtualTokens: number
): { tokensOut: number; newVirtualRlo: number; newVirtualTokens: number } {
  // constant product: (virtualRlo + rloIn) * (virtualTokens - tokensOut) = k
  const k = virtualRlo * virtualTokens;
  const newVirtualRlo = virtualRlo + rloIn;
  const newVirtualTokens = k / newVirtualRlo;
  const tokensOut = virtualTokens - newVirtualTokens;
  return { tokensOut: Math.floor(tokensOut), newVirtualRlo, newVirtualTokens };
}

function calcSellRlo(
  tokensIn: number,
  virtualRlo: number,
  virtualTokens: number
): { rloOut: number; newVirtualRlo: number; newVirtualTokens: number } {
  // constant product: (virtualTokens + tokensIn) * (virtualRlo - rloOut) = k
  const k = virtualRlo * virtualTokens;
  const newVirtualTokens = virtualTokens + tokensIn;
  const newVirtualRlo = k / newVirtualTokens;
  const rloOut = virtualRlo - newVirtualRlo;
  return { rloOut: Math.floor(rloOut), newVirtualRlo, newVirtualTokens };
}

function buildTokenState(t: TokenRecord): {
  virtualRlo: number;
  virtualTokens: number;
  currentPrice: number;
} {
  // Rebuild virtual reserves from initial + all trades
  let vRlo = INITIAL_VIRTUAL_RLO;
  let vTokens = INITIAL_VIRTUAL_TOKENS;
  for (const trade of t.trades) {
    if (trade.type === "buy") {
      const fee = Math.floor(trade.rloAmount * PLATFORM_FEE_BPS / 10000);
      const rloAfterFee = trade.rloAmount - fee;
      const result = calcBuyTokens(rloAfterFee, vRlo, vTokens);
      vRlo = result.newVirtualRlo;
      vTokens = result.newVirtualTokens;
    } else {
      const result = calcSellRlo(trade.tokenAmount, vRlo, vTokens);
      vRlo = result.newVirtualRlo;
      vTokens = result.newVirtualTokens;
    }
  }
  return { virtualRlo: vRlo, virtualTokens: vTokens, currentPrice: getPrice(vRlo, vTokens) };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", rpc: RPC_URL });
});

// Deployer public key
app.get("/deployer", (_req, res) => {
  if (!deployerKeypair) return res.status(503).json({ error: "No deployer key" });
  res.json({ pubkey: deployerKeypair.publicKey.toBase58() });
});

// Chain info
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

// Airdrop (devnet only)
app.post("/airdrop", async (req, res) => {
  try {
    const { pubkey, amount } = req.body;
    if (!pubkey) return res.status(400).json({ error: "pubkey required" });
    const { PublicKey } = await import("@rialo/ts-cdk");
    const pk = new PublicKey(pubkey);
    const kelvin = BigInt(Math.round((amount || 10) * KELVIN_PER_RLO));
    const sig = await client.requestAirdropAndConfirm(pk, kelvin);
    res.json({ success: true, signature: sig.signature });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Get balance
app.get("/balance/:pubkey", async (req, res) => {
  try {
    const { PublicKey } = await import("@rialo/ts-cdk");
    const pk = new PublicKey(req.params.pubkey);
    const bal = await client.getBalance(pk);
    res.json({ kelvin: bal.toString(), rlo: (Number(bal) / KELVIN_PER_RLO).toFixed(6) });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// List tokens
app.get("/tokens", (req, res) => {
  const list = Array.from(tokens.values())
    .sort((a, b) => b.marketCap - a.marketCap)
    .map((t) => {
      const { currentPrice } = buildTokenState(t);
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
        marketCap: Math.round(currentPrice * t.tokenSupply),
        progressPct: Math.min(100, (t.tokenSupply / GRADUATION_SUPPLY) * 100),
      };
    });
  res.json(list);
});

// Get single token
app.get("/tokens/:id", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  const state = buildTokenState(t);
  res.json({
    ...t,
    currentPrice: state.currentPrice,
    marketCap: Math.round(state.currentPrice * t.tokenSupply),
    progressPct: Math.min(100, (t.tokenSupply / GRADUATION_SUPPLY) * 100),
    virtualRlo: state.virtualRlo,
  });
});

// Create token
app.post("/tokens", async (req, res) => {
  try {
    const { name, symbol, description, imageUrl, creator } = req.body;
    if (!name || !symbol || !creator) {
      return res.status(400).json({ error: "name, symbol, creator required" });
    }
    if (symbol.length > 10) return res.status(400).json({ error: "symbol max 10 chars" });
    if (name.length > 32) return res.status(400).json({ error: "name max 32 chars" });

    // Check creator has balance (at least 0.02 RLO for creation fee)
    const { PublicKey } = await import("@rialo/ts-cdk");
    let pk: InstanceType<typeof PublicKey>;
    try { pk = new PublicKey(creator); } catch {
      return res.status(400).json({ error: "Invalid creator pubkey" });
    }
    const balance = await client.getBalance(pk);
    const minRequired = BigInt(Math.round(0.02 * KELVIN_PER_RLO));
    if (balance < minRequired) {
      return res.status(400).json({ error: "Insufficient balance. Need at least 0.02 RLO to create a token. Use /airdrop to get test RLO." });
    }

    const id = uuidv4().replace(/-/g, "").slice(0, 16);
    const token: TokenRecord = {
      id,
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      description: (description || "").trim(),
      imageUrl: imageUrl || "",
      creator,
      createdAt: Date.now(),
      rloSupply: INITIAL_VIRTUAL_RLO,
      tokenSupply: 0,
      totalSupply: MAX_TOKEN_SUPPLY,
      graduated: false,
      trades: [],
      marketCap: 0,
    };
    tokens.set(id, token);
    saveTokens(tokens);
    res.json({ success: true, token: { id, ...token } });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Quote buy
app.post("/tokens/:id/quote-buy", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const { rloAmount } = req.body;
  if (!rloAmount || rloAmount <= 0) return res.status(400).json({ error: "rloAmount required (kelvin)" });
  const state = buildTokenState(t);
  const fee = Math.floor(rloAmount * PLATFORM_FEE_BPS / 10000);
  const rloAfterFee = rloAmount - fee;
  const { tokensOut } = calcBuyTokens(rloAfterFee, state.virtualRlo, state.virtualTokens);
  const limitedTokens = Math.min(tokensOut, GRADUATION_SUPPLY - t.tokenSupply);
  const price = rloAmount / limitedTokens;
  res.json({ tokensOut: limitedTokens, fee, price, currentPrice: state.currentPrice });
});

// Quote sell
app.post("/tokens/:id/quote-sell", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  if (t.graduated) return res.status(400).json({ error: "Token graduated" });
  const { tokenAmount } = req.body;
  if (!tokenAmount || tokenAmount <= 0) return res.status(400).json({ error: "tokenAmount required" });
  const state = buildTokenState(t);
  const { rloOut } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
  const fee = Math.floor(rloOut * PLATFORM_FEE_BPS / 10000);
  const rloAfterFee = rloOut - fee;
  const price = rloAfterFee / tokenAmount;
  res.json({ rloOut: rloAfterFee, fee, price, currentPrice: state.currentPrice });
});

// Execute buy (signed by user — in devnet we accept signed tx bytes or simulate)
app.post("/tokens/:id/buy", async (req, res) => {
  try {
    const t = tokens.get(req.params.id);
    if (!t) return res.status(404).json({ error: "Token not found" });
    if (t.graduated) return res.status(400).json({ error: "Token graduated" });

    const { trader, rloAmount, signedTxBase64 } = req.body;
    if (!trader || !rloAmount) return res.status(400).json({ error: "trader and rloAmount required" });

    // Verify trader has enough balance
    const { PublicKey } = await import("@rialo/ts-cdk");
    const pk = new PublicKey(trader);
    const balance = await client.getBalance(pk);
    if (Number(balance) < rloAmount) {
      return res.status(400).json({ error: "Insufficient RLO balance" });
    }

    const state = buildTokenState(t);
    const fee = Math.floor(rloAmount * PLATFORM_FEE_BPS / 10000);
    const rloAfterFee = rloAmount - fee;
    const { tokensOut } = calcBuyTokens(rloAfterFee, state.virtualRlo, state.virtualTokens);
    const limitedTokens = Math.min(tokensOut, GRADUATION_SUPPLY - t.tokenSupply);

    if (limitedTokens <= 0) return res.status(400).json({ error: "No tokens available" });

    // In devnet: accept the tx bytes and broadcast, or simulate if no tx provided
    let txHash = "sim_" + uuidv4().replace(/-/g, "").slice(0, 32);
    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        const sig = await client.sendAndConfirmTransaction(txBytes);
        txHash = sig.signature || txHash;
      } catch (e: unknown) {
        console.warn("TX broadcast failed, recording as simulated:", e instanceof Error ? e.message : String(e));
      }
    }

    const price = rloAmount / limitedTokens;
    const trade: TradeRecord = {
      id: uuidv4().replace(/-/g, "").slice(0, 16),
      type: "buy",
      trader,
      rloAmount,
      tokenAmount: limitedTokens,
      price,
      timestamp: Date.now(),
      txHash,
    };

    t.trades.push(trade);
    t.tokenSupply += limitedTokens;
    t.rloSupply += rloAfterFee;
    const newState = buildTokenState(t);
    t.marketCap = Math.round(newState.currentPrice * t.tokenSupply);

    // Check graduation
    if (t.tokenSupply >= GRADUATION_SUPPLY) {
      t.graduated = true;
    }

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

    const { trader, tokenAmount, signedTxBase64 } = req.body;
    if (!trader || !tokenAmount) return res.status(400).json({ error: "trader and tokenAmount required" });

    // Check trader held tokens
    const traderBought = t.trades
      .filter((tr) => tr.trader === trader && tr.type === "buy")
      .reduce((sum, tr) => sum + tr.tokenAmount, 0);
    const traderSold = t.trades
      .filter((tr) => tr.trader === trader && tr.type === "sell")
      .reduce((sum, tr) => sum + tr.tokenAmount, 0);
    const traderBalance = traderBought - traderSold;
    if (traderBalance < tokenAmount) {
      return res.status(400).json({ error: `Insufficient token balance. You hold ${traderBalance} tokens.` });
    }

    const state = buildTokenState(t);
    const { rloOut } = calcSellRlo(tokenAmount, state.virtualRlo, state.virtualTokens);
    const fee = Math.floor(rloOut * PLATFORM_FEE_BPS / 10000);
    const rloAfterFee = rloOut - fee;

    if (rloAfterFee <= 0) return res.status(400).json({ error: "Nothing to receive" });

    let txHash = "sim_" + uuidv4().replace(/-/g, "").slice(0, 32);
    if (signedTxBase64) {
      try {
        const txBytes = Buffer.from(signedTxBase64, "base64");
        const sig = await client.sendAndConfirmTransaction(txBytes);
        txHash = sig.signature || txHash;
      } catch (e: unknown) {
        console.warn("TX broadcast failed:", e instanceof Error ? e.message : String(e));
      }
    }

    const price = rloAfterFee / tokenAmount;
    const trade: TradeRecord = {
      id: uuidv4().replace(/-/g, "").slice(0, 16),
      type: "sell",
      trader,
      rloAmount: rloAfterFee,
      tokenAmount,
      price,
      timestamp: Date.now(),
      txHash,
    };

    t.trades.push(trade);
    t.tokenSupply -= tokenAmount;
    t.rloSupply -= rloAfterFee;
    const newState = buildTokenState(t);
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

// Token trades
app.get("/tokens/:id/trades", (req, res) => {
  const t = tokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Token not found" });
  const trades = [...t.trades].reverse().slice(0, 100);
  res.json(trades);
});

// Trader portfolio
app.get("/portfolio/:pubkey", (req, res) => {
  const { pubkey } = req.params;
  const holdings: Array<{ token: TokenRecord; balance: number; value: number; pnl: number }> = [];
  for (const t of tokens.values()) {
    const bought = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "buy");
    const sold = t.trades.filter((tr) => tr.trader === pubkey && tr.type === "sell");
    const tokenBalance = bought.reduce((s, tr) => s + tr.tokenAmount, 0)
      - sold.reduce((s, tr) => s + tr.tokenAmount, 0);
    if (tokenBalance > 0) {
      const state = buildTokenState(t);
      const value = Math.round(state.currentPrice * tokenBalance);
      const spent = bought.reduce((s, tr) => s + tr.rloAmount, 0);
      const received = sold.reduce((s, tr) => s + tr.rloAmount, 0);
      const pnl = value + received - spent;
      holdings.push({ token: t, balance: tokenBalance, value, pnl });
    }
  }
  res.json(holdings);
});

// Generate new wallet keypair (browser users)
app.post("/wallet/generate", (_req, res) => {
  const secret = randomBytes(32);
  // We can't use @rialo/ts-cdk Keypair here without async import, just return secret bytes
  // Client will reconstruct using CDK
  res.json({
    secretHex: secret.toString("hex"),
    note: "Store this secret safely. It is your wallet private key on Rialo devnet.",
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[rialo-launchpad] Server running on :${PORT}`);
  console.log(`[rialo-launchpad] Rialo devnet RPC: ${RPC_URL}`);
});
