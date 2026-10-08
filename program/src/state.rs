use borsh::{BorshDeserialize, BorshSerialize};
use rialo_s_program::pubkey::Pubkey;

pub const TOKEN_STATE_VERSION: u8 = 2;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_DESC_LEN: usize = 280;
pub const MAX_URL_LEN: usize = 200;
pub const MAX_TAX_BPS: u64 = 1_000; // max 10% creator tax

/// Per-token bonding curve state stored in the token's program-derived account.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct TokenState {
    pub version: u8,
    pub creator: Pubkey,
    /// Virtual RLO reserve (kelvin), starts at INITIAL_VIRTUAL_RLO
    pub virtual_rlo: u64,
    /// Virtual token reserve, starts at INITIAL_VIRTUAL_TOKENS
    pub virtual_tokens: u64,
    /// Tokens actually sold so far (real, not virtual)
    pub token_supply: u64,
    /// Accumulated platform fees in the fee vault (kelvin) — informational
    pub fees_collected: u64,
    /// Accumulated creator earnings not yet claimed (kelvin)
    pub creator_earnings: u64,
    pub graduated: bool,
    /// Creator-set tax on every buy/sell in basis points (0–1000, default 0)
    pub token_tax_bps: u64,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub image_url: String,
}

impl TokenState {
    pub const INITIAL_VIRTUAL_RLO: u64 = 30_000_000_000; // 30 RLO in kelvin
    pub const INITIAL_VIRTUAL_TOKENS: u64 = 1_073_000_191;
    pub const GRADUATION_SUPPLY: u64 = 800_000_000;
    pub const MAX_SUPPLY: u64 = 1_000_000_000;
    /// Platform fee: 1% of trade value goes to fee vault
    pub const PLATFORM_FEE_BPS: u64 = 100;
    /// Minimum buy: 0.001 RLO in kelvin to prevent dust attacks
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
            virtual_rlo: Self::INITIAL_VIRTUAL_RLO,
            virtual_tokens: Self::INITIAL_VIRTUAL_TOKENS,
            token_supply: 0,
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

    /// Total deduction on a buy: platform fee + creator tax.
    /// Returns (rlo_after_all_fees, platform_fee, creator_tax).
    pub fn apply_buy_fees(&self, rlo_amount: u64) -> (u64, u64, u64) {
        let platform_fee = rlo_amount
            .checked_mul(Self::PLATFORM_FEE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or(0);
        let creator_tax = rlo_amount
            .checked_mul(self.token_tax_bps)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or(0);
        let total_deducted = platform_fee.saturating_add(creator_tax);
        let after = rlo_amount.saturating_sub(total_deducted);
        (after, platform_fee, creator_tax)
    }

    /// Total deduction on a sell: platform fee + creator tax applied to rlo_out.
    /// Returns (rlo_to_seller, platform_fee, creator_tax).
    pub fn apply_sell_fees(&self, rlo_out: u64) -> (u64, u64, u64) {
        let platform_fee = rlo_out
            .checked_mul(Self::PLATFORM_FEE_BPS)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or(0);
        let creator_tax = rlo_out
            .checked_mul(self.token_tax_bps)
            .and_then(|v| v.checked_div(10_000))
            .unwrap_or(0);
        let total_deducted = platform_fee.saturating_add(creator_tax);
        let to_seller = rlo_out.saturating_sub(total_deducted);
        (to_seller, platform_fee, creator_tax)
    }

    /// Calculate tokens out for rlo_in kelvin (after all fee deductions).
    /// Returns (tokens_out, new_virtual_rlo, new_virtual_tokens).
    pub fn calc_buy(&self, rlo_in_after_fee: u64) -> Option<(u64, u64, u64)> {
        let k = (self.virtual_rlo as u128).checked_mul(self.virtual_tokens as u128)?;
        let new_vr = (self.virtual_rlo as u128).checked_add(rlo_in_after_fee as u128)?;
        if new_vr == 0 { return None; }
        let new_vt = k.checked_div(new_vr)?;
        if new_vt > self.virtual_tokens as u128 { return None; }
        let tokens_out = (self.virtual_tokens as u128).checked_sub(new_vt)?;
        Some((tokens_out as u64, new_vr as u64, new_vt as u64))
    }

    /// Calculate rlo out for tokens_in.
    /// Returns (rlo_out_before_fee, new_virtual_rlo, new_virtual_tokens).
    pub fn calc_sell(&self, tokens_in: u64) -> Option<(u64, u64, u64)> {
        let k = (self.virtual_rlo as u128).checked_mul(self.virtual_tokens as u128)?;
        let new_vt = (self.virtual_tokens as u128).checked_add(tokens_in as u128)?;
        if new_vt == 0 { return None; }
        let new_vr = k.checked_div(new_vt)?;
        if new_vr > self.virtual_rlo as u128 { return None; }
        let rlo_out = (self.virtual_rlo as u128).checked_sub(new_vr)?;
        Some((rlo_out as u64, new_vr as u64, new_vt as u64))
    }
}
