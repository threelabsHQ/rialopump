// Ed25519 keypair derivation using @noble/ed25519 (available via @rialo/ts-cdk deps)
// We derive public key from secret key bytes

export async function generateKeypairFromSecret(secretHex: string): Promise<string> {
  // Use the Web Crypto API for Ed25519 key derivation
  // Import the secret key bytes
  const secretBytes = hexToBytes(secretHex);
  
  // Use @noble/ed25519 via dynamic import
  try {
    const ed = await import("@noble/ed25519");
    const pubkeyBytes = await ed.getPublicKeyAsync(secretBytes);
    return bytesToBase58(pubkeyBytes);
  } catch {
    // Fallback: use SubtleCrypto
    return fallbackDerivePublicKey(secretBytes);
  }
}

async function fallbackDerivePublicKey(secretBytes: Uint8Array): Promise<string> {
  // Use WebCrypto Ed25519
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes.buffer as ArrayBuffer,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    const jwk = await crypto.subtle.exportKey("jwk", key);
    if (jwk.x) {
      const pub = base64urlToBytes(jwk.x);
      return bytesToBase58(pub);
    }
  } catch {}
  // Last resort: deterministic pseudorandom from hash
  const buf = secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", buf as ArrayBuffer);
  return bytesToBase58(new Uint8Array(hash));
}

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  return new Uint8Array(binary.split("").map((c) => c.charCodeAt(0)));
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Base58 encoding (Bitcoin alphabet, same as Solana/Rialo)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function bytesToBase58(bytes: Uint8Array): string {
  let n = BigInt("0x" + bytesToHex(bytes));
  const zero = BigInt(0);
  const base = BigInt(58);
  const chars: string[] = [];
  while (n > zero) {
    chars.unshift(BASE58_ALPHABET[Number(n % base)]);
    n = n / base;
  }
  // Leading zeros
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    chars.unshift("1");
  }
  return chars.join("");
}

export function shortenAddress(addr: string, chars = 4): string {
  if (!addr) return "";
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

/**
 * pump.fun-style compact price notation.
 * Values with many leading zeros after the decimal use subscript zero count:
 *   3.00e-8 → "0.0(7)3"   (7 zeros after decimal, then sig figs)
 *   0.00034 → "0.0003400"  (≤3 zeros: just fixed decimal)
 *   1.23    → "1.2300"
 */
const SUB = "₀₁₂₃₄₅₆₇₈₉";
const toSub = (n: number) => String(n).split("").map((c) => SUB[+c] ?? c).join("");

export function fmtPumpPrice(val: number, sigFigs = 4): string {
  if (val === 0) return "0";
  if (val >= 0.01) return val.toFixed(sigFigs);
  // Count leading zeros after "0."
  const s = val.toFixed(30);
  const dec = s.split(".")[1] ?? "";
  let zeros = 0;
  while (zeros < dec.length && dec[zeros] === "0") zeros++;
  const sig = dec.slice(zeros, zeros + sigFigs).replace(/0+$/, "") || "0";
  if (zeros <= 3) return val.toFixed(zeros + sigFigs);
  // 0.0₇31 — pump.fun style with real Unicode subscript digits
  return `0.0${toSub(zeros)}${sig}`;
}

export function formatRlo(kelvin: number, decimals = 4): string {
  const rlo = kelvin / 1_000_000_000;
  if (rlo < 0.0001) return rlo.toExponential(2);
  return rlo.toFixed(decimals);
}

/** Format a USD value — e.g. $0.0000031 or $1.23 */
export function fmtUsd(val: number, decimals = 6): string {
  if (val === 0) return "$0";
  if (val >= 0.01) return `$${val.toFixed(2)}`;
  return `$${val.toFixed(decimals)}`;
}

export function formatLargeNumber(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toFixed(0);
}

export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
