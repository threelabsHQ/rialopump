use borsh::{BorshDeserialize, BorshSerialize};
use rialo_s_program::pubkey::Pubkey;

pub const TOKEN_STATE_VERSION: u8 = 3;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_DESC_LEN: usize = 280;
pub const MAX_URL_LEN: usize = 200;
/// Max creator tax: 10%
pub const MAX_TAX_BPS: u64 = 1_000;

/// Per-token bonding curve state stored in the token's program-derived account.
///
/// Curve model: constant-product with phantom reserves (same as pump.fun / flap.sh).
///   k = virtual_rlo * virtual_tokens  (invariant)
///
/// - virtual_rlo starts at PHANTOM_RLO (not zero), so the curve opens at a
///   non-zero price without the creator seeding liquidity.
/// - virtual_tokens starts at TOTAL_SUPPLY (all 1 billion tokens).
/// - real_rlo_raised tracks actual RLO deposited by traders (excludes phantom).
/// - Graduation triggers when real_rlo_raised >= GRADUATION_RLO_TARGET.
/// - On graduation the curve is sealed; no further buys/sells allowed.
///
/// Fee model (mirrors pump.fun 1.25% split, simplified to 1% platform + optional creator tax):
///   Every buy/sell deducts fees from the RLO amount before it hits the curve.
///   Platform fee → fee_vault PDA.
///   Creator tax  → token_state.creator_earnings (pull-based claim).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct TokenState {
    pub version: u8,
    /// Wallet that launched this token
    pub creator: Pubkey,
    /// Virtual RLO reserve (kelvin) = PHANTOM_RLO + real_rlo_raised
    pub virtual_rlo: u64,
    /// Virtual token reserve (decreases as tokens are bought)
    pub virtual_tokens: u64,
    /// Real RLO raised from traders (does NOT include phantom reserve)
    pub real_rlo_raised: u64,
    /// Tokens sold to traders so far (out of TOTAL_SUPPLY)
    pub tokens_sold: u64,
    /// Platform fees routed to fee_vault (informational counter)
    pub fees_collected: u64,
    /// Creator tax earnings not yet claimed (kelvin)
    pub creator_earnings: u64,
    /// True once real_rlo_raised >= GRADUATION_RLO_TARGET
    pub graduated: bool,
    /// Creator-set tax on every buy/sell in basis points (0–1000)
    pub token_tax_bps: u64,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub image_url: String,
}

impl TokenState {
    /// Phantom RLO reserve — sets the opening price.
    /// 30 RLO phantom → opening price ≈ 30 / 1_000_000_000 = 0.000000030 RLO/token
    pub const PHANTOM_RLO: u64 = 30_000_000_000; // 30 RLO in kelvin

    /// Total token supply: 1 billion (matches pump.fun / four.meme)
    pub const TOTAL_SUPPLY: u64 = 1_000_000_000;

    /// Graduation threshold: when this much real RLO has been raised, the token
    /// graduates. Equivalent to ~85 SOL on pump.fun scaled to our devnet.
    /// Set to 85 RLO for devnet (low enough to test graduation easily).
    pub const GRADUATION_RLO_TARGET: u64 = 85_000_000_000; // 85 RLO in kelvin

    /// Platform fee: 1% of every trade
    pub const PLATFORM_FEE_BPS: u64 = 100;

    /// Creation fee paid by the launcher (goes to fee_vault at creation)
    /// Mirrors pump.fun's ~0.02 SOL creation fee
    pub const CREATION_FEE_KELVIN: u64 = 20_000_000; // 0.02 RLO in kelvin

    /// Minimum buy: 0.001 RLO to block spam/dust
    pub const MIN_BUY_KELVIN: u64 = 1_000_000;

    pub fn new(
        creator: Pubkey,
        name: String,
        symbol: String,
        description: String,
        image_url: String,
        token_tax_bps: u64,
    ) -> Self {
        let clamped_tax = token_tax_bps.min(MAX_TAX_BPS);
        Self {
            version: TOKEN_STATE_VERSION,
            creator,
            // Virtual RLO starts at PHANTOM_RLO (no real RLO yet)
            virtual_rlo: Self::PHANTOM_RLO,
            // All 1 billion tokens start in the curve
            virtual_tokens: Self::TOTAL_SUPPLY,
            real_rlo_raised: 0,
            tokens_sold: 0,
            fees_collected: 0,
            creator_earnings: 0,
            graduated: false,
            token_tax_bps: clamped_tax,
            name,
            symbol,
            description,
            image_url,
        }
    }

    /// Deduct platform fee + creator tax from a buy amount.
    /// Returns (rlo_into_curve, platform_fee, creator_tax).
    pub fn apply_buy_fees(&self, rlo_amount: u64) -> (u64, u64, u64) {
        let platform_fee = rlo_amount
            .saturating_mul(Self::PLATFORM_FEE_BPS)
            .checked_div(10_000)
            .unwrap_or(0);
        let creator_tax = rlo_amount
            .saturating_mul(self.token_tax_bps)
            .checked_div(10_000)
            .unwrap_or(0);
        let into_curve = rlo_amount.saturating_sub(platform_fee).saturating_sub(creator_tax);
        (into_curve, platform_fee, creator_tax)
    }

    /// Deduct platform fee + creator tax from rlo_out on a sell.
    /// Returns (rlo_to_seller, platform_fee, creator_tax).
    pub fn apply_sell_fees(&self, rlo_out: u64) -> (u64, u64, u64) {
        let platform_fee = rlo_out
            .saturating_mul(Self::PLATFORM_FEE_BPS)
            .checked_div(10_000)
            .unwrap_or(0);
        let creator_tax = rlo_out
            .saturating_mul(self.token_tax_bps)
            .checked_div(10_000)
            .unwrap_or(0);
        let to_seller = rlo_out.saturating_sub(platform_fee).saturating_sub(creator_tax);
        (to_seller, platform_fee, creator_tax)
    }

    /// Constant-product buy: given rlo_in (after fees), how many tokens come out?
    /// Uses k = virtual_rlo * virtual_tokens.
    /// Returns (tokens_out, new_virtual_rlo, new_virtual_tokens) or None on overflow.
    pub fn calc_buy(&self, rlo_in: u64) -> Option<(u64, u64, u64)> {
        let k = (self.virtual_rlo as u128).checked_mul(self.virtual_tokens as u128)?;
        let new_vr = (self.virtual_rlo as u128).checked_add(rlo_in as u128)?;
        if new_vr == 0 { return None; }
        let new_vt = k.checked_div(new_vr)?;
        if new_vt >= self.virtual_tokens as u128 { return None; }
        let tokens_out = (self.virtual_tokens as u128).checked_sub(new_vt)?;
        Some((tokens_out as u64, new_vr as u64, new_vt as u64))
    }

    /// Constant-product sell: given tokens_in, how much RLO comes out (before fees)?
    /// Returns (rlo_out, new_virtual_rlo, new_virtual_tokens) or None on overflow.
    pub fn calc_sell(&self, tokens_in: u64) -> Option<(u64, u64, u64)> {
        let k = (self.virtual_rlo as u128).checked_mul(self.virtual_tokens as u128)?;
        let new_vt = (self.virtual_tokens as u128).checked_add(tokens_in as u128)?;
        if new_vt == 0 { return None; }
        let new_vr = k.checked_div(new_vt)?;
        if new_vr > self.virtual_rlo as u128 { return None; }
        let rlo_out = (self.virtual_rlo as u128).checked_sub(new_vr)?;
        Some((rlo_out as u64, new_vr as u64, new_vt as u64))
    }

    /// Current spot price in kelvin per token (virtual_rlo / virtual_tokens).
    /// Returns 0 if virtual_tokens is 0.
    pub fn spot_price_kelvin(&self) -> u64 {
        if self.virtual_tokens == 0 { return 0; }
        self.virtual_rlo / self.virtual_tokens
    }
}
