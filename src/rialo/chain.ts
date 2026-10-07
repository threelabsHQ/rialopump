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
    const data =
      info.data instanceof Uint8Array
        ? info.data
        : new Uint8Array(Buffer.from(info.data as unknown as string, "base64"));
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
  const [validFrom, configHashPrefix] = await Promise.all([
    client.getConfigHashPrefix(),
    client.getConfigHashPrefix(),
  ]);
  const tx = buildTx(instructions, signer.publicKey, validFrom, configHashPrefix);
  tx.sign(signer);
  const sig = await client.sendAndConfirmTransaction(tx.serialize());
  return sig.signature ?? (sig as unknown as { toString(): string }).toString();
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
  const sig = await client.requestAirdropAndConfirm(pk, kelvin);
  return sig.signature ?? (sig as unknown as { toString(): string }).toString();
}

// ─── Token ID encoding ────────────────────────────────────────────────────────
// Token IDs are 16-char strings; encode as 16-byte UTF-8 array

export function tokenIdToBytes(id: string): Uint8Array {
  const padded = id.slice(0, 16).padEnd(16, "\0");
  return new Uint8Array(padded.split("").map((c) => c.charCodeAt(0)));
}

// Re-export PublicKey for callers that need it
export { PublicKey, Keypair, PROGRAM_ID };
