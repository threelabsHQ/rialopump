/**
 * Server-side Rialo helpers (Node.js / bun).
 * Mirrors src/rialo/program.ts but uses @rialo/ts-cdk directly (no Vite imports).
 */
import { PublicKey } from "@rialo/ts-cdk";

// ─── Borsh reader ─────────────────────────────────────────────────────────────

class BorshReader {
  private pos = 0;
  constructor(private data: Uint8Array) {}

  readU8(): number { return this.data[this.pos++]; }
  readBool(): boolean { return this.readU8() !== 0; }

  readU32LE(): number {
    const v =
      this.data[this.pos] |
      (this.data[this.pos + 1] << 8) |
      (this.data[this.pos + 2] << 16) |
      (this.data[this.pos + 3] << 24);
    this.pos += 4;
    return v >>> 0;
  }

  readU64LE(): bigint {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(this.data[this.pos++]) << BigInt(i * 8);
    return v;
  }

  readFixedBytes(n: number): Uint8Array {
    const b = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  readString(): string {
    const len = this.readU32LE();
    const bytes = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return Buffer.from(bytes).toString("utf-8");
  }
}

// ─── Borsh writer (exported for tests) ───────────────────────────────────────

export class BorshWriter {
  private buf: Buffer;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = Buffer.alloc(capacity);
  }

  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      const next = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + n + 64));
      this.buf.copy(next);
      this.buf = next;
    }
  }

  writeU8(v: number) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }

  writeU32LE(v: number) {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.pos);
    this.pos += 4;
  }

  writeU64LE(v: bigint) {
    this.ensure(8);
    this.buf.writeBigUInt64LE(BigInt.asUintN(64, v), this.pos);
    this.pos += 8;
  }

  writeFixedBytes(b: Uint8Array) {
    this.ensure(b.length);
    Buffer.from(b).copy(this.buf, this.pos);
    this.pos += b.length;
  }

  writeString(s: string) {
    const enc = Buffer.from(s, "utf-8");
    this.writeU32LE(enc.length);
    this.ensure(enc.length);
    enc.copy(this.buf, this.pos);
    this.pos += enc.length;
  }

  toBytes(): Uint8Array { return new Uint8Array(this.buf.slice(0, this.pos)); }
}

// ─── Token state ──────────────────────────────────────────────────────────────

// Field order mirrors Rust BorshSerialize for TokenState v2 (state.rs):
//   version, creator, virtual_rlo, virtual_tokens, token_supply,
//   fees_collected, creator_earnings, graduated, token_tax_bps,
//   name, symbol, description, image_url
export interface ServerTokenState {
  version: number;
  creator: string; // base58
  virtualRlo: bigint;
  virtualTokens: bigint;
  tokenSupply: bigint;
  feesCollected: bigint;
  creatorEarnings: bigint;
  graduated: boolean;
  tokenTaxBps: bigint;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
}

export function deserializeTokenState(data: Uint8Array): ServerTokenState {
  const r = new BorshReader(data);
  return {
    version:         r.readU8(),
    creator:         PublicKey.fromBytes(r.readFixedBytes(32)).toString(),
    virtualRlo:      r.readU64LE(),
    virtualTokens:   r.readU64LE(),
    tokenSupply:     r.readU64LE(),
    feesCollected:   r.readU64LE(),
    creatorEarnings: r.readU64LE(),
    graduated:       r.readBool(),
    tokenTaxBps:     r.readU64LE(),
    name:            r.readString(),
    symbol:          r.readString(),
    description:     r.readString(),
    imageUrl:        r.readString(),
  };
}

// ─── PDA derivation ───────────────────────────────────────────────────────────

export function deriveTokenStatePda(
  tokenId: Uint8Array,
  programId: PublicKey
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddress(
    [Buffer.from("token"), tokenId],
    programId
  );
  return { pda, bump };
}

export function deriveFeeVaultPda(
  tokenId: Uint8Array,
  programId: PublicKey
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddress(
    [Buffer.from("fees"), tokenId],
    programId
  );
  return { pda, bump };
}
