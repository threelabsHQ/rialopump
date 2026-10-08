use borsh::{BorshDeserialize, BorshSerialize};

/// All instructions the hugefun launchpad program understands.
///
/// Borsh enum discriminant = variant index (0-based).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum LaunchpadInstruction {
    /// Launch a new meme token.
    ///
    /// - Pays CREATION_FEE_KELVIN from creator to fee_vault.
    /// - Creates token_state PDA with bonding curve initialised.
    /// - No pre-allocation; all 1 billion tokens start on the curve.
    ///
    /// Accounts:
    ///   0. [signer, writable] creator
    ///   1. [writable]         token_state PDA  (seeds: ["token", token_id])
    ///   2. [writable]         fee_vault PDA    (seeds: ["fees",  token_id])
    ///   3. []                 system_program
    CreateToken {
        token_id: [u8; 16],
        name: String,
        symbol: String,
        description: String,
        image_url: String,
        /// Optional creator tax in basis points (0–1000). Clamped on-chain.
        token_tax_bps: u64,
    },

    /// Buy tokens from the bonding curve.
    ///
    /// rlo_amount is the total spend (inclusive of all fees).
    /// Platform fee (1%) → fee_vault.
    /// Creator tax → token_state.creator_earnings.
    /// Remainder → curve (added to virtual_rlo, real_rlo_raised).
    ///
    /// Accounts:
    ///   0. [signer, writable] buyer
    ///   1. [writable]         token_state PDA  (seeds: ["token", token_id])
    ///   2. [writable]         fee_vault PDA    (seeds: ["fees",  token_id])
    ///   3. []                 system_program
    Buy {
        token_id: [u8; 16],
        /// Total RLO to spend (kelvin), inclusive of all fees.
        rlo_amount: u64,
        /// Minimum tokens acceptable — tx reverts if tokens_out < this.
        min_tokens_out: u64,
    },

    /// Sell tokens back to the bonding curve.
    ///
    /// token_amount tokens are returned to the curve.
    /// Platform fee + creator tax deducted from rlo_out.
    ///
    /// Accounts:
    ///   0. [signer, writable] seller
    ///   1. [writable]         token_state PDA
    ///   2. [writable]         fee_vault PDA
    ///   3. []                 system_program
    Sell {
        token_id: [u8; 16],
        /// Number of tokens to sell.
        token_amount: u64,
        /// Minimum RLO after all fees — tx reverts if rlo_to_seller < this.
        min_rlo_out: u64,
    },

    /// Withdraw accumulated platform fees from fee_vault to the protocol wallet.
    ///
    /// Only callable by the program's fee authority (creator of the token
    /// acts as authority in this devnet version — change to a fixed program
    /// authority on mainnet).
    ///
    /// Accounts:
    ///   0. [signer, writable] authority (must match state.creator on devnet)
    ///   1. [writable]         token_state PDA
    ///   2. [writable]         fee_vault PDA
    ///   3. []                 system_program
    WithdrawFees {
        token_id: [u8; 16],
    },

    /// Claim creator tax earnings accumulated in token_state.creator_earnings.
    ///
    /// Pull-based (creator calls this to receive their cut).
    /// Only callable by state.creator.
    ///
    /// Accounts:
    ///   0. [signer, writable] creator
    ///   1. [writable]         token_state PDA
    ///   2. []                 system_program
    ClaimCreatorEarnings {
        token_id: [u8; 16],
    },

    /// Update the creator tax rate for a token (0–1000 bps).
    ///
    /// Only callable by state.creator.
    ///
    /// Accounts:
    ///   0. [signer]   creator
    ///   1. [writable] token_state PDA
    UpdateTokenTax {
        token_id: [u8; 16],
        new_tax_bps: u64,
    },
}
