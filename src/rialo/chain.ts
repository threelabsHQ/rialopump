/**
 * Browser-side Rialo chain helpers.
 * Signs transactions in-browser; submits via server RPC proxy (CORS).
 */
import {
  Keypair,
  PublicKey,
} from "@rialo/ts-cdk";
import {
  buildTx,
  PROGRAM_ID,
  type RialoInstruction,
  type TokenState,
} from "./program";

// ─── API base (Vite proxy strips /api prefix on dev) ──────────────────────────
const API = "/api";

async function serverReq<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!res.ok) {
    const err = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json as T;
}

// ─── Keypair from stored secretHex ───────────────────────────────────────────

export function keypairFromHex(secretHex: string): Keypair {
  const bytes = new Uint8Array(
    ([...(secretHex.match(/.{2}/g) ?? [])]).map((b: string) => parseInt(b, 16))
  );
  return Keypair.fromSecretKey(bytes);
}

// ─── Config hash prefix (via server proxy — browser can't call devnet RPC) ───

async function getConfigHashPrefix(): Promise<bigint> {
  const { configHashPrefix } = await serverReq<{ configHashPrefix: string }>("/rpc/config-hash");
  return BigInt(configHashPrefix);
}

// ─── Balance (via server — same reason) ──────────────────────────────────────

export async function fetchBalance(pubkey: string): Promise<{ kelvin: bigint; rlo: number }> {
  const { kelvin } = await serverReq<{ kelvin: string; rlo: string }>(`/balance/${pubkey}`);
  const k = BigInt(kelvin);
  return { kelvin: k, rlo: Number(k) / 1_000_000_000 };
}

// ─── Fetch token state from chain (via server) ────────────────────────────────

export async function fetchTokenState(tokenIdHex: string): Promise<TokenState | null> {
  try {
    const data = await serverReq<TokenState | null>(`/tokens/${tokenIdHex}/state`);
    return data;
  } catch {
    return null;
  }
}

// ─── Sign and send (sign in browser, broadcast via server proxy) ──────────────

export async function signAndSend(
  instructions: RialoInstruction[],
  signer: Keypair
): Promise<string> {
  const configHashPrefix = await getConfigHashPrefix();
  const tx = buildTx(instructions, signer.publicKey, configHashPrefix);
  tx.sign(signer);
  const txBase64 = Buffer.from(tx.serialize()).toString("base64");
  const { signature } = await serverReq<{ signature: string }>("/rpc/send-tx", { txBase64 });
  return signature;
}

// ─── Build signed tx bytes (base64) for server submission ────────────────────

export async function buildSignedTxBytes(
  instructions: RialoInstruction[],
  signer: Keypair
): Promise<string> {
  const configHashPrefix = await getConfigHashPrefix();
  const tx = buildTx(instructions, signer.publicKey, configHashPrefix);
  tx.sign(signer);
  return Buffer.from(tx.serialize()).toString("base64");
}

// ─── Token ID encoding ────────────────────────────────────────────────────────

export function tokenIdToBytes(idHex: string): Uint8Array {
  const hex = idHex.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function makeTokenIdHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Re-export PublicKey for callers that need it
export { PublicKey, Keypair, PROGRAM_ID };


