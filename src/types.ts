export interface Token {
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
  tradeCount: number;
  currentPrice: number;
  marketCap: number;
  progressPct: number;
  virtualRlo?: number;
  trades?: TradeRecord[];
}

export interface TradeRecord {
  id: string;
  type: "buy" | "sell";
  trader: string;
  rloAmount: number;
  tokenAmount: number;
  price: number;
  timestamp: number;
  txHash: string;
}

export interface WalletState {
  pubkey: string;
  secretHex: string;
  balance: number; // in RLO
  balanceKelvin: number;
}

export interface QuoteResult {
  tokensOut?: number;
  rloOut?: number;
  fee: number;
  price: number;
  currentPrice: number;
}

export type View = "home" | "token" | "create" | "portfolio";
