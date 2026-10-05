use borsh::{BorshDeserialize, BorshSerialize};
use rialo_s_program::pubkey::Pubkey;

pub const TOKEN_STATE_VERSION: u8 = 1;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_DESC_LEN: usize = 280;

/// Per-token bonding curve state stored in the token's program-derived account.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct TokenState {
    pub version: u8,
    pub creator: Pubkey,
    /// Virtual RLO reserve (kelvin), starts at INITIAL_VIRTUAL_RLO
    pub virtual_rlo: u64,
    /// Virtual token reserve, starts at INITIAL_VIRTUAL_TOKENS
    pub virtual_tokens: u64,
    /// Tokens actually minted/sold so far (real, not virtual)
    pub token_supply: u64,
    /// Accumulated fees (kelvin)
    pub fees_collected: u64,
    pub graduated: bool,
    pub name: String,
    pub symbol: String,
    pub description: String,
}

impl TokenState {
    pub const INITIAL_VIRTUAL_RLO: u64 = 30_000_000_000; // 30 RLO in kelvin
    pub const INITIAL_VIRTUAL_TOKENS: u64 = 1_073_000_191;
    pub const GRADUATION_SUPPLY: u64 = 800_000_000;
    pub const MAX_SUPPLY: u64 = 1_000_000_000;
    pub const PLATFORM_FEE_BPS: u64 = 100; // 1%

    pub fn new(creator: Pubkey, name: String, symbol: String, description: String) -> Self {
        Self {
            version: TOKEN_STATE_VERSION,
            creator,
            virtual_rlo: Self::INITIAL_VIRTUAL_RLO,
            virtual_tokens: Self::INITIAL_VIRTUAL_TOKENS,
            token_supply: 0,
            fees_collected: 0,
            graduated: false,
            name,
            symbol,
            description,
        }
    }

    /// Current price in kelvin per token (virtual_rlo / virtual_tokens).
    pub fn current_price_kelvin(&self) -> u64 {
        self.virtual_rlo
            .checked_div(self.virtual_tokens)
            .unwrap_or(0)
    }

    /// Calculate tokens out for rlo_in kelvin (after fee deduction).
    /// Returns (tokens_out, new_virtual_rlo, new_virtual_tokens).
    pub fn calc_buy(
        &self,
        rlo_in_after_fee: u64,
    ) -> Option<(u64, u64, u64)> {
        // constant product: (vR + rloIn) * (vT - tokensOut) = k
        let k = (self.virtual_rlo as u128).checked_mul(self.virtual_tokens as u128)?;
        let new_vr = (self.virtual_rlo as u128).checked_add(rlo_in_after_fee as u128)?;
        let new_vt = k.checked_div(new_vr)?;
        let tokens_out = (self.virtual_tokens as u128).checked_sub(new_vt)?;
        Some((
            tokens_out as u64,
            new_vr as u64,
            new_vt as u64,
        ))
    }

    /// Calculate rlo out for tokens_in.
    /// Returns (rlo_out_before_fee, new_virtual_rlo, new_virtual_tokens).
    pub fn calc_sell(
        &self,
        tokens_in: u64,
    ) -> Option<(u64, u64, u64)> {
        // constant product: (vT + tokensIn) * (vR - rloOut) = k
        let k = (self.virtual_rlo as u128).checked_mul(self.virtual_tokens as u128)?;
        let new_vt = (self.virtual_tokens as u128).checked_add(tokens_in as u128)?;
        let new_vr = k.checked_div(new_vt)?;
        let rlo_out = (self.virtual_rlo as u128).checked_sub(new_vr)?;
        Some((
            rlo_out as u64,
            new_vr as u64,
            new_vt as u64,
        ))
    }
}
