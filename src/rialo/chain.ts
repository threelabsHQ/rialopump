/**
 * Browser-side Rialo chain helpers.
 * Signs and sends transactions using the user's in-memory keypair.
 */
import {
  createRialoClient,
  RIALO_DEVNET_CHAIN,
  Keypair,
  PublicKey,
} from "@rialo/ts-cdk";
import {
  deserializeTokenState,
  deriveTokenStatePda,
  buildTx,
  PROGRAM_ID,
  type RialoInstruction,
  type TokenState,
} from "./program";

// ─── Singleton client ─────────────────────────────────────────────────────────

let _client: ReturnType<typeof createRialoClient> | null = null;

export function getRialoClient() {
  if (!_client) _client = createRialoClient({ chain: RIALO_DEVNET_CHAIN });
  return _client;
}

// ─── Keypair from stored secretHex ───────────────────────────────────────────

export function keypairFromHex(secretHex: string): Keypair {
  const bytes = new Uint8Array(
    ([...(secretHex.match(/.{2}/g) ?? [])]).map((b: string) => parseInt(b, 16))
  );
  return Keypair.fromSecretKey(bytes);
}

// ─── Balance ──────────────────────────────────────────────────────────────────

export async function fetchBalance(pubkey: string): Promise<{ kelvin: bigint; rlo: number }> {
  const client = getRialoClient();
  const pk = PublicKey.fromString(pubkey);
  const kelvin = await client.getBalance(pk);
  return { kelvin, rlo: Number(kelvin) / 1_000_000_000 };
}

// ─── Fetch token state from chain ────────────────────────────────────────────

export async function fetchTokenState(tokenId: Uint8Array): Promise<TokenState | null> {
  const client = getRialoClient();
  const { pda } = deriveTokenStatePda(tokenId);
  try {
    const info = await client.getAccountInfo(pda);
    if (!info?.data) return null;
    // RPC returns data as [base64String, "base64"] tuple
    let data: Uint8Array;
    if (info.data instanceof Uint8Array) {
      data = info.data;
    } else {
      const raw = Array.isArray(info.data)
        ? (info.data as [string, string])[0]
        : (info.data as string);
      data = new Uint8Array(Buffer.from(raw, "base64"));
    }
    return deserializeTokenState(data);
  } catch {
    return null;
  }
}

// ─── Sign and send a transaction ──────────────────────────────────────────────

export async function signAndSend(
  instructions: RialoInstruction[],
  signer: Keypair
): Promise<string> {
  const client = getRialoClient();
  const configHashPrefix = await client.getConfigHashPrefix();
  const tx = buildTx(instructions, signer.publicKey, configHashPrefix, configHashPrefix);
  tx.sign(signer);
  const confirmed = await client.sendAndConfirmTransaction(tx.serialize());
  return confirmed.signature;
}

// ─── Build signed tx bytes (base64) for server submission ────────────────────

export async function buildSignedTxBytes(
  instructions: RialoInstruction[],
  signer: Keypair
): Promise<string> {
  const client = getRialoClient();
  const validFrom = await client.getConfigHashPrefix();
  const tx = buildTx(instructions, signer.publicKey, validFrom, validFrom);
  tx.sign(signer);
  return Buffer.from(tx.serialize()).toString("base64");
}

// ─── Airdrop ──────────────────────────────────────────────────────────────────

export async function requestAirdrop(pubkey: string, rloAmount: number): Promise<string> {
  const client = getRialoClient();
  const pk = PublicKey.fromString(pubkey);
  const kelvin = BigInt(Math.round(rloAmount * 1_000_000_000));
  const confirmed = await client.requestAirdropAndConfirm(pk, kelvin);
  return confirmed.signature;
}

// ─── Token ID encoding ────────────────────────────────────────────────────────
// Token IDs are stored as 32-char hex strings representing 16 raw bytes.
// Must match server/index.ts tokenIdToBytes() exactly.

export function tokenIdToBytes(idHex: string): Uint8Array {
  const hex = idHex.replace(/-/g, "").slice(0, 32).padEnd(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Generate a random 16-byte token ID as a 32-char hex string. */
export function makeTokenIdHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Re-export PublicKey for callers that need it
export { PublicKey, Keypair, PROGRAM_ID };
