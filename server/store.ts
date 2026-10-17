/**
 * Token store — shared types and persistence helpers.
 * Extracted so route modules can import without circular deps.
 */
import fs from "fs";
import path from "path";

export interface TradeRecord {
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

export interface TokenRecord {
  id: string;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  creator: string;
  createdAt: number;
  tokenSupply: number;
  totalSupply: number;
  graduated: boolean;
  trades: TradeRecord[];
  marketCap: number;
  tokenTaxBps: number;
  creatorEarnings: number;
  realRloRaised: number;
  onchain: boolean;
  tokenIdHex: string;
}

const DATA_FILE = path.join(process.cwd(), "server", "tokens.json");

export function loadTokens(): Map<string, TokenRecord> {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as Record<string, TokenRecord>;
      return new Map(Object.entries(raw));
    }
  } catch {}
  return new Map();
}

export function saveTokens(tokens: Map<string, TokenRecord>) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const obj: Record<string, TokenRecord> = {};
    for (const [k, v] of tokens) obj[k] = v;
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("Failed to save tokens:", e);
  }
}
