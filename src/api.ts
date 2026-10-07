import type { Token, TradeRecord, QuoteResult } from "./types";

export interface TradeResponse {
  success: boolean;
  trade: TradeRecord;
  tokenSupply: number;
  graduated?: boolean;
  currentPrice: number;
  progressPct: number;
}

export interface PortfolioHolding {
  token: Token;
  balance: number;
  value: number;
  pnl: number;
}

const BASE = "/api";

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
  return json as unknown as T;
}

export const api = {
  health: () => req<{ status: string; rpc: string }>("/health"),
  chain: () => req<{ blockHeight: string; epoch: number; slot: string }>("/chain"),
  deployer: () => req<{ pubkey: string }>("/deployer"),

  tokens: () => req<Token[]>("/tokens"),
  token: (id: string) => req<Token>(`/tokens/${id}`),
  createToken: (body: {
    name: string;
    symbol: string;
    description: string;
    imageUrl: string;
    creator: string;
    signedTxBase64?: string;
    tokenIdHex?: string;
  }) => req<{ success: boolean; token: Token }>("/tokens", { method: "POST", body: JSON.stringify(body) }),

  quoteBuy: (id: string, rloAmount: number) =>
    req<QuoteResult>(`/tokens/${id}/quote-buy`, {
      method: "POST",
      body: JSON.stringify({ rloAmount }),
    }),
  quoteSell: (id: string, tokenAmount: number) =>
    req<QuoteResult>(`/tokens/${id}/quote-sell`, {
      method: "POST",
      body: JSON.stringify({ tokenAmount }),
    }),
  buy: (id: string, trader: string, rloAmount: number, signedTxBase64?: string) =>
    req<TradeResponse>(`/tokens/${id}/buy`, {
      method: "POST",
      body: JSON.stringify({ trader, rloAmount, signedTxBase64 }),
    }),
  sell: (id: string, trader: string, tokenAmount: number, signedTxBase64?: string) =>
    req<TradeResponse>(`/tokens/${id}/sell`, {
      method: "POST",
      body: JSON.stringify({ trader, tokenAmount, signedTxBase64 }),
    }),
  trades: (id: string) => req<TradeRecord[]>(`/tokens/${id}/trades`),

  balance: (pubkey: string) => req<{ kelvin: string; rlo: string }>(`/balance/${pubkey}`),
  airdrop: (pubkey: string, amount?: number) =>
    req<{ success: boolean; signature: string }>("/airdrop", {
      method: "POST",
      body: JSON.stringify({ pubkey, amount: amount ?? 100 }),
    }),
  portfolio: (pubkey: string) => req<PortfolioHolding[]>(`/portfolio/${pubkey}`),
  generateWallet: () => req<{ secretHex: string; note: string }>("/wallet/generate", { method: "POST" }),
};
