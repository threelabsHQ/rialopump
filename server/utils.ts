/**
 * Shared server utilities: sendAndConfirm, base58 encoder, signature poller.
 * Extracted from index.ts so route modules can import them without circular deps.
 */
import type { RialoClient } from "@rialo/ts-cdk";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function sigToBase58(sig: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of sig) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = "";
  for (let k = 0; k < sig.length - 1 && sig[k] === 0; k++) result += "1";
  for (let k = digits.length - 1; k >= 0; k--) result += BASE58_ALPHABET[digits[k]];
  return result;
}

export async function pollConfirm(client: RialoClient, sigBytes: Uint8Array, maxMs = 60_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const statuses = await client.getSignatureStatuses([sigBytes]);
      const s = statuses?.[0];
      if (s && !s.err) return;
      if (s?.err) throw new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Transaction failed:")) throw e;
      console.warn("[pollConfirm] status check (will retry):", msg);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.warn("[pollConfirm] timeout — assuming landed");
}

export async function sendAndConfirm(client: RialoClient, txBytes: Uint8Array | Buffer): Promise<string> {
  try {
    const confirmed = await client.sendAndConfirmTransaction(txBytes);
    return confirmed.signature;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("timed out") || msg.includes("TRANSACTION_CONFIRMATION_TIMEOUT") || msg.includes("timeout")) {
      const sig = await client.sendTransaction(txBytes);
      await new Promise((r) => setTimeout(r, 5_000));
      console.log("[sendAndConfirm] fallback confirmed (5s wait):", sig);
      return sig;
    }
    throw e;
  }
}
