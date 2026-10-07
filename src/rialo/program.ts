/**
 * Rialo Launchpad program interface — browser-compatible.
 *
 * Uses @rialo/ts-cdk exactly as the API exists (inspected at runtime):
 * - PublicKey.fromString() / PublicKey.fromBytes() — no `new PublicKey()`
 * - PublicKey.findProgramAddress() — async, not sync
 * - TransactionBuilder with setPayer/setValidFrom/setConfigHashPrefix/addInstruction/build
 * - SYSTEM_PROGRAM_ID is a string — wrap with PublicKey.fromString()
 * - No Transaction/SystemProgram/TransactionInstruction exports
 */
import {
  PublicKey,
  TransactionBuilder,
  SYSTEM_PROGRAM_ID,
  transferInstruction,
  createAccount,
} from "@rialo/ts-cdk";
import type { Transaction } from "@rialo/ts-cdk";

// ─── Constants ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
export const PROGRAM_ID_STR: string =
  (import.meta.env as Record<string, string | undefined>).VITE_PROGRAM_ID
  ?? "AqSikYubk5DEygNhAZh1rSuVvrtNyHTUveLrze1QHn3R";

export const PROGRAM_ID = PublicKey.fromString(PROGRAM_ID_STR);
export const SYSTEM_PK = PublicKey.fromString(SYSTEM_PROGRAM_ID);

export const KELVIN_PER_RLO = 1_000_000_000n;
export const INITIAL_VIRTUAL_RLO = 30_000_000_000n;
export const INITIAL_VIRTUAL_TOKENS = 1_073_000_191n;
export const GRADUATION_SUPPLY = 800_000_000n;
export const MAX_SUPPLY = 1_000_000_000n;
export const PLATFORM_FEE_BPS = 100n;

// ─── Instruction type (matches ts-cdk internal shape) ────────────────────────

export interface RialoInstruction {
  programId: PublicKey;
  accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

// ─── Borsh helpers ────────────────────────────────────────────────────────────

class BorshWriter {
  private buf: Uint8Array;
  private pos = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
  }

  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n + 64));
      next.set(this.buf);
      this.buf = next;
    }
  }

  writeU8(v: number) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }

  writeU32LE(v: number) {
    this.ensure(4);
    const n = v >>> 0;
    this.buf[this.pos++] = n & 0xff;
    this.buf[this.pos++] = (n >>> 8) & 0xff;
    this.buf[this.pos++] = (n >>> 16) & 0xff;
    this.buf[this.pos++] = (n >>> 24) & 0xff;
  }

  writeU64LE(v: bigint) {
    this.ensure(8);
    let n = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) { this.buf[this.pos++] = Number(n & 0xffn); n >>= 8n; }
  }

  writeFixedBytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  writeString(s: string) {
    const enc = new TextEncoder().encode(s);
    this.writeU32LE(enc.length);
    this.writeFixedBytes(enc);
  }

  toBytes(): Uint8Array { return this.buf.slice(0, this.pos); }
}

class BorshReader {
  private pos = 0;
  constructor(private data: Uint8Array) {}
  readU8(): number { return this.data[this.pos++]; }
  readBool(): boolean { return this.readU8() !== 0; }
  readU32LE(): number {
    const v = this.data[this.pos] | (this.data[this.pos+1]<<8) | (this.data[this.pos+2]<<16) | (this.data[this.pos+3]<<24);
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
    return new TextDecoder().decode(bytes);
  }
}

// ─── Token state ──────────────────────────────────────────────────────────────

export interface TokenState {
  version: number;
  creator: PublicKey;
  virtualRlo: bigint;
  virtualTokens: bigint;
  tokenSupply: bigint;
  feesCollected: bigint;
  graduated: boolean;
  name: string;
  symbol: string;
  description: string;
}

export function deserializeTokenState(data: Uint8Array): TokenState {
  const r = new BorshReader(data);
  return {
    version: r.readU8(),
    creator: PublicKey.fromBytes(r.readFixedBytes(32)),
    virtualRlo: r.readU64LE(),
    virtualTokens: r.readU64LE(),
    tokenSupply: r.readU64LE(),
    feesCollected: r.readU64LE(),
    graduated: r.readBool(),
    name: r.readString(),
    symbol: r.readString(),
    description: r.readString(),
  };
}

// ─── Bonding curve math ───────────────────────────────────────────────────────

export function calcBuy(
  state: Pick<TokenState, "virtualRlo" | "virtualTokens">,
  rloInAfterFee: bigint
): { tokensOut: bigint; newVr: bigint; newVt: bigint } | null {
  const k = state.virtualRlo * state.virtualTokens;
  const newVr = state.virtualRlo + rloInAfterFee;
  if (newVr === 0n) return null;
  const newVt = k / newVr;
  if (newVt > state.virtualTokens) return null;
  return { tokensOut: state.virtualTokens - newVt, newVr, newVt };
}

export function calcSell(
  state: Pick<TokenState, "virtualRlo" | "virtualTokens">,
  tokensIn: bigint
): { rloOut: bigint; newVr: bigint; newVt: bigint } | null {
  const k = state.virtualRlo * state.virtualTokens;
  const newVt = state.virtualTokens + tokensIn;
  if (newVt === 0n) return null;
  const newVr = k / newVt;
  if (newVr > state.virtualRlo) return null;
  return { rloOut: state.virtualRlo - newVr, newVr, newVt };
}

export function applyFee(amount: bigint): { afterFee: bigint; fee: bigint } {
  const fee = (amount * PLATFORM_FEE_BPS) / 10_000n;
  return { afterFee: amount - fee, fee };
}

// ─── PDA derivation ───────────────────────────────────────────────────────────

export function deriveTokenStatePda(tokenId: Uint8Array): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddress(
    [new TextEncoder().encode("token"), tokenId],
    PROGRAM_ID
  );
  return { pda, bump };
}

export function deriveFeeVaultPda(tokenId: Uint8Array): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddress(
    [new TextEncoder().encode("fees"), tokenId],
    PROGRAM_ID
  );
  return { pda, bump };
}

// ─── Instruction encoders ─────────────────────────────────────────────────────

function encodeCreateToken(tokenId: Uint8Array, name: string, symbol: string, description: string): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(0);
  w.writeFixedBytes(tokenId);
  w.writeString(name);
  w.writeString(symbol);
  w.writeString(description);
  return w.toBytes();
}

function encodeBuy(tokenId: Uint8Array, rloAmount: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(1);
  w.writeFixedBytes(tokenId);
  w.writeU64LE(rloAmount);
  return w.toBytes();
}

function encodeSell(tokenId: Uint8Array, tokenAmount: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(2);
  w.writeFixedBytes(tokenId);
  w.writeU64LE(tokenAmount);
  return w.toBytes();
}

function encodeWithdrawFees(tokenId: Uint8Array): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(3);
  w.writeFixedBytes(tokenId);
  return w.toBytes();
}

// ─── Instruction builders ─────────────────────────────────────────────────────

export function buildCreateTokenIx(params: {
  tokenId: Uint8Array;
  name: string;
  symbol: string;
  description: string;
  creator: PublicKey;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: tokenStatePda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PK, isSigner: false, isWritable: false },
    ],
    data: encodeCreateToken(params.tokenId, params.name, params.symbol, params.description),
  };
}

export function buildBuyIx(params: {
  tokenId: Uint8Array;
  buyer: PublicKey;
  rloAmount: bigint;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda } = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.buyer, isSigner: true, isWritable: true },
      { pubkey: tokenStatePda, isSigner: false, isWritable: true },
      { pubkey: feeVaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PK, isSigner: false, isWritable: false },
    ],
    data: encodeBuy(params.tokenId, params.rloAmount),
  };
}

export function buildSellIx(params: {
  tokenId: Uint8Array;
  seller: PublicKey;
  tokenAmount: bigint;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda } = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.seller, isSigner: true, isWritable: true },
      { pubkey: tokenStatePda, isSigner: false, isWritable: true },
      { pubkey: feeVaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PK, isSigner: false, isWritable: false },
    ],
    data: encodeSell(params.tokenId, params.tokenAmount),
  };
}

export function buildWithdrawFeesIx(params: {
  tokenId: Uint8Array;
  creator: PublicKey;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda } = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: tokenStatePda, isSigner: false, isWritable: true },
      { pubkey: feeVaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PK, isSigner: false, isWritable: false },
    ],
    data: encodeWithdrawFees(params.tokenId),
  };
}

// ─── Transaction builder helper ───────────────────────────────────────────────

// TransactionBuilder has a private constructor in the type defs but a public runtime constructor.
// Cast via unknown to bypass the TS access check.
type TxBuilderLike = {
  setPayer(p: PublicKey): TxBuilderLike;
  setValidFrom(v: bigint): TxBuilderLike;
  setConfigHashPrefix(v: bigint): TxBuilderLike;
  addInstruction(ix: RialoInstruction): TxBuilderLike;
  build(): Transaction;
};

export function buildTx(
  instructions: RialoInstruction[],
  feePayer: PublicKey,
  validFrom: bigint,
  configHashPrefix: bigint
): Transaction {
  const Ctor = TransactionBuilder as unknown as new () => TxBuilderLike;
  const builder = new Ctor()
    .setPayer(feePayer)
    .setValidFrom(validFrom)
    .setConfigHashPrefix(configHashPrefix);
  for (const ix of instructions) {
    builder.addInstruction(ix);
  }
  return builder.build();
}

// Re-export for convenience
export { transferInstruction, createAccount };
