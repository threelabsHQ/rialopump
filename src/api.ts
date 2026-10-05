const BASE = "/api";

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  health: () => req<{ status: string; rpc: string }>("/health"),
  chain: () => req<{ blockHeight: string; epoch: number; slot: string }>("/chain"),
  deployer: () => req<{ pubkey: string }>("/deployer"),

  tokens: () => req<any[]>("/tokens"),
  token: (id: string) => req<any>(`/tokens/${id}`),
  createToken: (body: {
    name: string;
    symbol: string;
    description: string;
    imageUrl: string;
    creator: string;
  }) => req<any>("/tokens", { method: "POST", body: JSON.stringify(body) }),

  quoteBuy: (id: string, rloAmount: number) =>
    req<any>(`/tokens/${id}/quote-buy`, {
      method: "POST",
      body: JSON.stringify({ rloAmount }),
    }),
  quoteSell: (id: string, tokenAmount: number) =>
    req<any>(`/tokens/${id}/quote-sell`, {
      method: "POST",
      body: JSON.stringify({ tokenAmount }),
    }),
  buy: (id: string, trader: string, rloAmount: number, signedTxBase64?: string) =>
    req<any>(`/tokens/${id}/buy`, {
      method: "POST",
      body: JSON.stringify({ trader, rloAmount, signedTxBase64 }),
    }),
  sell: (id: string, trader: string, tokenAmount: number, signedTxBase64?: string) =>
    req<any>(`/tokens/${id}/sell`, {
      method: "POST",
      body: JSON.stringify({ trader, tokenAmount, signedTxBase64 }),
    }),
  trades: (id: string) => req<any[]>(`/tokens/${id}/trades`),

  balance: (pubkey: string) => req<{ kelvin: string; rlo: string }>(`/balance/${pubkey}`),
  airdrop: (pubkey: string, amount?: number) =>
    req<any>("/airdrop", {
      method: "POST",
      body: JSON.stringify({ pubkey, amount: amount || 100 }),
    }),
  portfolio: (pubkey: string) => req<any[]>(`/portfolio/${pubkey}`),
  generateWallet: () => req<{ secretHex: string; note: string }>("/wallet/generate", { method: "POST" }),
};
