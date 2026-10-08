/**
 * Rialo Launchpad program interface — browser-compatible.
 * State version 2: adds creatorEarnings, tokenTaxBps, imageUrl.
 * Instruction encoders match the Rust borsh enum variant index exactly.
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
export const MAX_TAX_BPS = 1_000n;

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

// ─── Token state (mirrors Rust TokenState v2) ────────────────────────────────
// Field order MUST match Rust BorshSerialize derive order in state.rs:
//   version, creator, virtual_rlo, virtual_tokens, token_supply,
//   fees_collected, creator_earnings, graduated, token_tax_bps,
//   name, symbol, description, image_url

export interface TokenState {
  version: number;
  creator: PublicKey;
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

export function deserializeTokenState(data: Uint8Array): TokenState {
  const r = new BorshReader(data);
  return {
    version:         r.readU8(),
    creator:         PublicKey.fromBytes(r.readFixedBytes(32)),
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

/** Apply platform fee + creator tax to a buy amount.
 *  Returns { afterFee, platformFee, creatorTax } all in kelvin. */
export function applyBuyFees(
  rloAmount: bigint,
  tokenTaxBps: bigint
): { afterFee: bigint; platformFee: bigint; creatorTax: bigint } {
  const platformFee = (rloAmount * PLATFORM_FEE_BPS) / 10_000n;
  const creatorTax  = (rloAmount * tokenTaxBps) / 10_000n;
  const afterFee    = rloAmount - platformFee - creatorTax;
  return { afterFee, platformFee, creatorTax };
}

/** Apply platform fee + creator tax to rlo_out on a sell. */
export function applySellFees(
  rloOut: bigint,
  tokenTaxBps: bigint
): { toSeller: bigint; platformFee: bigint; creatorTax: bigint } {
  const platformFee = (rloOut * PLATFORM_FEE_BPS) / 10_000n;
  const creatorTax  = (rloOut * tokenTaxBps) / 10_000n;
  const toSeller    = rloOut - platformFee - creatorTax;
  return { toSeller, platformFee, creatorTax };
}

/** Legacy helper (platform fee only, no creator tax) — kept for quote endpoints. */
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
// Borsh enum variant indices (must match LaunchpadInstruction in instruction.rs):
//   0 = CreateToken, 1 = Buy, 2 = Sell, 3 = WithdrawFees,
//   4 = ClaimCreatorEarnings, 5 = UpdateTokenTax

function encodeCreateToken(
  tokenId: Uint8Array,
  name: string,
  symbol: string,
  description: string,
  imageUrl: string,
  tokenTaxBps: bigint
): Uint8Array {
  const w = new BorshWriter(512);
  w.writeU8(0);
  w.writeFixedBytes(tokenId);
  w.writeString(name);
  w.writeString(symbol);
  w.writeString(description);
  w.writeString(imageUrl);
  w.writeU64LE(tokenTaxBps);
  return w.toBytes();
}

function encodeBuy(tokenId: Uint8Array, rloAmount: bigint, minTokensOut: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(1);
  w.writeFixedBytes(tokenId);
  w.writeU64LE(rloAmount);
  w.writeU64LE(minTokensOut);
  return w.toBytes();
}

function encodeSell(tokenId: Uint8Array, tokenAmount: bigint, minRloOut: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(2);
  w.writeFixedBytes(tokenId);
  w.writeU64LE(tokenAmount);
  w.writeU64LE(minRloOut);
  return w.toBytes();
}

function encodeWithdrawFees(tokenId: Uint8Array): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(3);
  w.writeFixedBytes(tokenId);
  return w.toBytes();
}

function encodeClaimCreatorEarnings(tokenId: Uint8Array): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(4);
  w.writeFixedBytes(tokenId);
  return w.toBytes();
}

function encodeUpdateTokenTax(tokenId: Uint8Array, newTaxBps: bigint): Uint8Array {
  const w = new BorshWriter();
  w.writeU8(5);
  w.writeFixedBytes(tokenId);
  w.writeU64LE(newTaxBps);
  return w.toBytes();
}

// ─── Instruction builders ─────────────────────────────────────────────────────

export function buildCreateTokenIx(params: {
  tokenId: Uint8Array;
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  tokenTaxBps: bigint;
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
    data: encodeCreateToken(
      params.tokenId,
      params.name,
      params.symbol,
      params.description,
      params.imageUrl,
      params.tokenTaxBps
    ),
  };
}

export function buildBuyIx(params: {
  tokenId: Uint8Array;
  buyer: PublicKey;
  rloAmount: bigint;
  /** Minimum tokens acceptable; pass 0n to disable slippage check. */
  minTokensOut?: bigint;
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
    data: encodeBuy(params.tokenId, params.rloAmount, params.minTokensOut ?? 0n),
  };
}

export function buildSellIx(params: {
  tokenId: Uint8Array;
  seller: PublicKey;
  tokenAmount: bigint;
  /** Minimum RLO acceptable after fees; pass 0n to disable slippage check. */
  minRloOut?: bigint;
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
    data: encodeSell(params.tokenId, params.tokenAmount, params.minRloOut ?? 0n),
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

export function buildClaimCreatorEarningsIx(params: {
  tokenId: Uint8Array;
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
    data: encodeClaimCreatorEarnings(params.tokenId),
  };
}

export function buildUpdateTokenTaxIx(params: {
  tokenId: Uint8Array;
  creator: PublicKey;
  newTaxBps: bigint;
}): RialoInstruction {
  const { pda: tokenStatePda } = deriveTokenStatePda(params.tokenId);
  return {
    programId: PROGRAM_ID,
    accounts: [
      { pubkey: params.creator, isSigner: true, isWritable: true },
      { pubkey: tokenStatePda, isSigner: false, isWritable: true },
    ],
    data: encodeUpdateTokenTax(params.tokenId, params.newTaxBps),
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
