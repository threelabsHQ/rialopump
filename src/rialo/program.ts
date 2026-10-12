/**
 * Rialo Launchpad — browser-side program interface.
 *
 * State version 3 layout (must match program/src/state.rs BorshSerialize order):
 *   version (u8), creator (32 bytes), virtual_rlo (u64), virtual_tokens (u64),
 *   real_rlo_raised (u64), tokens_sold (u64), fees_collected (u64),
 *   creator_earnings (u64), graduated (bool), token_tax_bps (u64),
 *   name (string), symbol (string), description (string), image_url (string)
 *
 * Curve: constant-product with phantom reserve.
 *   k = virtual_rlo * virtual_tokens
 *   virtual_rlo  = PHANTOM_RLO + real_rlo_raised
 *   virtual_tokens = TOTAL_SUPPLY - tokens_sold
 *
 * Graduation: when real_rlo_raised >= GRADUATION_RLO_TARGET (85 RLO on devnet).
 */

import {
  PublicKey,
  TransactionBuilder,
  SYSTEM_PROGRAM_ID,
} from "@rialo/ts-cdk";
import type { Transaction } from "@rialo/ts-cdk";

// ─── Program ID ───────────────────────────────────────────────────────────────

export const PROGRAM_ID_STR: string =
  (import.meta.env as Record<string, string | undefined>).VITE_PROGRAM_ID
  ?? "CDy4MtWvAJyLfQBU4TLK7ZDDapPeq9SqSqvC65HVdESk";

export const PROGRAM_ID = PublicKey.fromString(PROGRAM_ID_STR);
export const SYSTEM_PK  = PublicKey.fromString(SYSTEM_PROGRAM_ID);

// ─── Constants (mirror state.rs) ─────────────────────────────────────────────

export const KELVIN_PER_RLO        = 1_000_000_000n;
/** Phantom RLO reserve — sets opening price. */
export const PHANTOM_RLO           = 30_000_000_000n;  // 30 RLO
/** All 1 billion tokens start on the curve. */
export const TOTAL_SUPPLY          = 1_000_000_000n;
/** Graduation when this much real RLO is raised (85 RLO on devnet). */
export const GRADUATION_RLO_TARGET = 85_000_000_000n;  // 85 RLO
export const PLATFORM_FEE_BPS      = 100n;             // 1%
export const MAX_TAX_BPS           = 1_000n;           // 10%
/** Creation fee paid at launch (0.02 RLO). */
export const CREATION_FEE_KELVIN   = 20_000_000n;
export const MIN_BUY_KELVIN        = 1_000_000n;       // 0.001 RLO

// ─── Instruction shape ────────────────────────────────────────────────────────

export interface RialoInstruction {
  programId: PublicKey;
  accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

// ─── Borsh codec ─────────────────────────────────────────────────────────────

class BorshWriter {
  private buf: Uint8Array;
  private pos = 0;

  constructor(capacity = 256) { this.buf = new Uint8Array(capacity); }

  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n + 64));
      next.set(this.buf);
      this.buf = next;
    }
  }

  writeU8(v: number)  { this.ensure(1); this.buf[this.pos++] = v & 0xff; }

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
    this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length;
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
    const v =
      (this.data[this.pos]) |
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
    const b = this.data.slice(this.pos, this.pos + n); this.pos += n; return b;
  }

  readString(): string {
    const len = this.readU32LE();
    const bytes = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return new TextDecoder().decode(bytes);
  }
}

// ─── TokenState (v3) ─────────────────────────────────────────────────────────

export interface TokenState {
  version: number;
  creator: PublicKey;
  /** virtual_rlo = PHANTOM_RLO + real_rlo_raised (kelvin) */
  virtualRlo: bigint;
  /** virtual_tokens = TOTAL_SUPPLY - tokens_sold */
  virtualTokens: bigint;
  /** Real RLO deposited by traders (kelvin) */
  realRloRaised: bigint;
  /** Tokens sold to traders so far */
  tokensSold: bigint;
  feesCollected: bigint;
  creatorEarnings: bigint;
  graduated: boolean;
  tokenTaxBps: bigint;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
}

export function deserializeTokenState(data: Uint8Array): TokenState {
  const r = new BorshReader(data);
  return {
    version:         r.readU8(),
    creator:         PublicKey.fromBytes(r.readFixedBytes(32)),
    virtualRlo:      r.readU64LE(),
    virtualTokens:   r.readU64LE(),
    realRloRaised:   r.readU64LE(),
    tokensSold:      r.readU64LE(),
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

// ─── Bonding curve math ───────────────────────────────────────────────────────

/** Constant-product buy: given rlo_in after fees, returns tokens out. */
export function calcBuy(
  state: Pick<TokenState, "virtualRlo" | "virtualTokens">,
  rloInAfterFee: bigint,
): { tokensOut: bigint; newVr: bigint; newVt: bigint } | null {
  const k = state.virtualRlo * state.virtualTokens;
  const newVr = state.virtualRlo + rloInAfterFee;
  if (newVr === 0n) return null;
  const newVt = k / newVr;
  if (newVt >= state.virtualTokens) return null;
  return { tokensOut: state.virtualTokens - newVt, newVr, newVt };
}

/** Constant-product sell: given tokens_in, returns rlo out before fees. */
export function calcSell(
  state: Pick<TokenState, "virtualRlo" | "virtualTokens">,
  tokensIn: bigint,
): { rloOut: bigint; newVr: bigint; newVt: bigint } | null {
  const k = state.virtualRlo * state.virtualTokens;
  const newVt = state.virtualTokens + tokensIn;
  if (newVt === 0n) return null;
  const newVr = k / newVt;
  if (newVr > state.virtualRlo) return null;
  return { rloOut: state.virtualRlo - newVr, newVr, newVt };
}

/** Platform fee + creator tax on a buy. Returns amounts in kelvin. */
export function applyBuyFees(
  rloAmount: bigint,
  tokenTaxBps: bigint,
): { intoCurve: bigint; platformFee: bigint; creatorTax: bigint } {
  const platformFee = (rloAmount * PLATFORM_FEE_BPS) / 10_000n;
  const creatorTax  = (rloAmount * tokenTaxBps) / 10_000n;
  const intoCurve   = rloAmount - platformFee - creatorTax;
  return { intoCurve, platformFee, creatorTax };
}

/** Platform fee + creator tax on a sell. Returns amounts in kelvin. */
export function applySellFees(
  rloOut: bigint,
  tokenTaxBps: bigint,
): { toSeller: bigint; platformFee: bigint; creatorTax: bigint } {
  const platformFee = (rloOut * PLATFORM_FEE_BPS) / 10_000n;
  const creatorTax  = (rloOut * tokenTaxBps) / 10_000n;
  const toSeller    = rloOut - platformFee - creatorTax;
  return { toSeller, platformFee, creatorTax };
}

/** Graduation progress as a fraction 0–1 (based on real RLO raised). */
export function graduationProgress(realRloRaised: bigint): number {
  const pct = Number((realRloRaised * 10_000n) / GRADUATION_RLO_TARGET) / 100;
  return Math.min(pct, 100);
}

// ─── PDA derivation ───────────────────────────────────────────────────────────

export function deriveTokenStatePda(tokenId: Uint8Array): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddress(
    [new TextEncoder().encode("token"), tokenId], PROGRAM_ID,
  );
  return { pda, bump };
}

export function deriveFeeVaultPda(tokenId: Uint8Array): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddress(
    [new TextEncoder().encode("fees"), tokenId], PROGRAM_ID,
  );
  return { pda, bump };
}

// ─── Instruction encoders ─────────────────────────────────────────────────────
// Borsh enum discriminant = variant index (matches LaunchpadInstruction in instruction.rs):
//   0=CreateToken  1=Buy  2=Sell  3=WithdrawFees  4=ClaimCreatorEarnings  5=UpdateTokenTax

function encodeCreateToken(
  tokenId: Uint8Array, name: string, symbol: string,
  description: string, imageUrl: string, tokenTaxBps: bigint,
): Uint8Array {
  const w = new BorshWriter(512);
  w.writeU32LE(0); // borsh enum discriminant is u32, not u8
  w.writeFixedBytes(tokenId);
  w.writeString(name); w.writeString(symbol);
  w.writeString(description); w.writeString(imageUrl);
  w.writeU64LE(tokenTaxBps);
  return w.toBytes();
}

function encodeBuy(tokenId: Uint8Array, rloAmount: bigint, minTokensOut: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU32LE(1); w.writeFixedBytes(tokenId);
  w.writeU64LE(rloAmount); w.writeU64LE(minTokensOut);
  return w.toBytes();
}

function encodeSell(tokenId: Uint8Array, tokenAmount: bigint, minRloOut: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU32LE(2); w.writeFixedBytes(tokenId);
  w.writeU64LE(tokenAmount); w.writeU64LE(minRloOut);
  return w.toBytes();
}

function encodeWithdrawFees(tokenId: Uint8Array): Uint8Array {
  const w = new BorshWriter();
  w.writeU32LE(3); w.writeFixedBytes(tokenId);
  return w.toBytes();
}

function encodeClaimCreatorEarnings(tokenId: Uint8Array): Uint8Array {
  const w = new BorshWriter();
  w.writeU32LE(4); w.writeFixedBytes(tokenId);
  return w.toBytes();
}

function encodeUpdateTokenTax(tokenId: Uint8Array, newTaxBps: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU32LE(5); w.writeFixedBytes(tokenId);
  w.writeU64LE(newTaxBps);
  return w.toBytes();
}

// ─── Transaction builder helper ───────────────────────────────────────────────

interface TxBuilderLike {
  setPayer(payer: PublicKey): TxBuilderLike;
  setValidFrom(v: bigint): TxBuilderLike;
  addInstruction(ix: RialoInstruction): TxBuilderLike;
  setConfigHashPrefix(v: bigint): TxBuilderLike;
  build(): Transaction;
}

function makeTxBuilder(): TxBuilderLike {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  return new (TransactionBuilder as unknown as new () => TxBuilderLike)();
}

/**
 * Build a Transaction from a list of instructions.
 * - setPayer: the account paying the tx fee
 * - setValidFrom: current time in ms since Unix epoch (timestamp-based replay protection)
 * - setConfigHashPrefix: from client.getConfigHashPrefix() (epoch-level chain ID)
 */
export function buildTx(
  instructions: RialoInstruction[],
  feePayer: PublicKey,
  configHashPrefix: bigint,
  validFromMs?: bigint,
): Transaction {
  const validFrom = validFromMs ?? BigInt(Date.now());
  let builder = makeTxBuilder()
    .setPayer(feePayer)
    .setValidFrom(validFrom)
    .setConfigHashPrefix(configHashPrefix);
  for (const ix of instructions) builder = builder.addInstruction(ix);
  return builder.build();
}

// ─── Instruction builders ─────────────────────────────────────────────────────

export function buildCreateTokenIx(params: {
  tokenId: Uint8Array;
  creator: PublicKey;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  tokenTaxBps: bigint | number;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda }   = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.creator,     isSigner: true,  isWritable: true  },
      { pubkey: tokenStatePda,      isSigner: false, isWritable: true  },
      { pubkey: feeVaultPda,        isSigner: false, isWritable: true  },
      { pubkey: SYSTEM_PK,          isSigner: false, isWritable: false },
    ],
    data: encodeCreateToken(
      params.tokenId, params.name, params.symbol,
      params.description, params.imageUrl, BigInt(params.tokenTaxBps),
    ),
  };
}

export function buildBuyIx(params: {
  tokenId: Uint8Array;
  buyer: PublicKey;
  rloAmount: bigint | number;
  minTokensOut: bigint | number;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda }   = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.buyer,   isSigner: true,  isWritable: true  },
      { pubkey: tokenStatePda,  isSigner: false, isWritable: true  },
      { pubkey: feeVaultPda,    isSigner: false, isWritable: true  },
      { pubkey: SYSTEM_PK,      isSigner: false, isWritable: false },
    ],
    data: encodeBuy(params.tokenId, BigInt(params.rloAmount), BigInt(params.minTokensOut)),
  };
}

export function buildSellIx(params: {
  tokenId: Uint8Array;
  seller: PublicKey;
  tokenAmount: bigint | number;
  minRloOut: bigint | number;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda }   = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.seller,  isSigner: true,  isWritable: true  },
      { pubkey: tokenStatePda,  isSigner: false, isWritable: true  },
      { pubkey: feeVaultPda,    isSigner: false, isWritable: true  },
      { pubkey: SYSTEM_PK,      isSigner: false, isWritable: false },
    ],
    data: encodeSell(params.tokenId, BigInt(params.tokenAmount), BigInt(params.minRloOut)),
  };
}

export function buildWithdrawFeesIx(params: {
  tokenId: Uint8Array;
  authority: PublicKey;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  const { pda: feeVaultPda }   = deriveFeeVaultPda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.authority, isSigner: true,  isWritable: true  },
      { pubkey: tokenStatePda,    isSigner: false, isWritable: true  },
      { pubkey: feeVaultPda,      isSigner: false, isWritable: true  },
      { pubkey: SYSTEM_PK,        isSigner: false, isWritable: false },
    ],
    data: encodeWithdrawFees(params.tokenId),
  };
}

export function buildClaimCreatorEarningsIx(params: {
  tokenId: Uint8Array;
  creator: PublicKey;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.creator,   isSigner: true,  isWritable: true  },
      { pubkey: tokenStatePda,    isSigner: false, isWritable: true  },
      { pubkey: SYSTEM_PK,        isSigner: false, isWritable: false },
    ],
    data: encodeClaimCreatorEarnings(params.tokenId),
  };
}

export function buildUpdateTokenTaxIx(params: {
  tokenId: Uint8Array;
  creator: PublicKey;
  newTaxBps: bigint | number;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.creator,   isSigner: true,  isWritable: false },
      { pubkey: tokenStatePda,    isSigner: false, isWritable: true  },
    ],
    data: encodeUpdateTokenTax(params.tokenId, BigInt(params.newTaxBps)),
  };
}
