use borsh::{BorshDeserialize, BorshSerialize};

/// All instructions the hugefun program understands.
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
    },

    /// Buy tokens from the bonding curve.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` buyer
    ///   1. `[writable]`         token_state PDA
    ///   2. `[writable]`         fee_vault PDA    (seeds: ["fees", token_id])
    ///   3. `[]`                 system_program
    Buy {
        token_id: [u8; 16],
        /// Amount of RLO to spend, in kelvin (inclusive of fee).
        rlo_amount: u64,
    },

    /// Sell tokens back to the bonding curve.
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
    },

    /// Withdraw accumulated platform fees to the creator.
    ///
    /// Accounts:
    ///   0. `[signer, writable]` creator (must match state.creator)
    ///   1. `[writable]`         token_state PDA
    ///   2. `[writable]`         fee_vault PDA
    ///   3. `[]`                 system_program
    WithdrawFees {
        token_id: [u8; 16],
    },
}
