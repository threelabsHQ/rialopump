use borsh::{BorshDeserialize, BorshSerialize};

/// All instructions the hugefun launchpad program understands.
///
/// Discriminant is the first byte, matching borsh enum variant index.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum LaunchpadInstruction {
    /// Create a new token with bonding curve.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` creator
    ///   1. `[writable]`         token_state PDA  (seeds: ["token", token_id])
    ///   2. `[]`                 system_program
    CreateToken {
        token_id: [u8; 16],
        name: String,
        symbol: String,
        description: String,
        image_url: String,
        /// Creator-set tax in basis points (0–1000). Validated and clamped on-chain.
        token_tax_bps: u64,
    },

    /// Buy tokens from the bonding curve.
    ///
    /// Platform fee (1%) goes to fee_vault PDA.
    /// Creator tax (token_tax_bps/10000) goes to token_state.creator_earnings.
    /// Remaining RLO goes into token_state as bonding curve liquidity.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` buyer
    ///   1. `[writable]`         token_state PDA   (seeds: ["token", token_id])
    ///   2. `[writable]`         fee_vault PDA     (seeds: ["fees",  token_id])
    ///   3. `[]`                 system_program
    Buy {
        token_id: [u8; 16],
        /// Total RLO to spend (kelvin), inclusive of all fees.
        rlo_amount: u64,
        /// Minimum tokens acceptable — transaction reverts if tokens_out < min_tokens_out.
        min_tokens_out: u64,
    },

    /// Sell tokens back to the bonding curve.
    ///
    /// Platform fee (1%) and creator tax go to their respective destinations.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` seller
    ///   1. `[writable]`         token_state PDA
    ///   2. `[writable]`         fee_vault PDA
    ///   3. `[]`                 system_program
    Sell {
        token_id: [u8; 16],
        /// Number of tokens to sell.
        token_amount: u64,
        /// Minimum RLO acceptable after fees — transaction reverts if rlo_out < min_rlo_out.
        min_rlo_out: u64,
    },

    /// Withdraw accumulated platform fees from fee_vault to creator.
    ///
    /// Anyone can call; funds always go to state.creator.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` caller (must be creator)
    ///   1. `[writable]`         token_state PDA
    ///   2. `[writable]`         fee_vault PDA
    ///   3. `[]`                 system_program
    WithdrawFees {
        token_id: [u8; 16],
    },

    /// Claim creator earnings accumulated in token_state.creator_earnings.
    ///
    /// Only callable by state.creator.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` creator
    ///   1. `[writable]`         token_state PDA
    ///   2. `[]`                 system_program
    ClaimCreatorEarnings {
        token_id: [u8; 16],
    },

    /// Update the creator tax rate for a token.
    ///
    /// Only callable by state.creator. Tax must be <= 1000 bps (10%).
    ///
    /// Accounts:
    ///   0. `[signer]`   creator
    ///   1. `[writable]` token_state PDA
    UpdateTokenTax {
        token_id: [u8; 16],
        new_tax_bps: u64,
    },
}
