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
  // v2 fields
  tokenTaxBps?: number;
  creatorEarnings?: number; // kelvin
  onchain?: boolean;
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
  onchain?: boolean;
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
  creatorTax?: number;
  price: number;
  currentPrice: number;
}

export type View = "home" | "token" | "create" | "portfolio";
