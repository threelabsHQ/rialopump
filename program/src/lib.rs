//! hugefun — bonding-curve launchpad program for Rialo devnet.
//!
//! Instruction layout (first byte = discriminant):
//!   0 = CreateToken   { name: String, symbol: String, description: String }
//!   1 = Buy           { rlo_amount: u64 }   (kelvin units)
//!   2 = Sell          { token_amount: u64 }
//!   3 = WithdrawFees  {}
//!
//! Account layout for each instruction is documented per handler below.
//!
//! Bonding curve: constant-product AMM (pump.fun style)
//!   virtual_rlo    = 30_000_000_000 kelvin  (30 RLO)
//!   virtual_tokens = 1_073_000_191
//!   graduation     = 800_000_000 tokens
//!   fee_bps        = 100  (1 %)
//!   max_supply     = 1_000_000_000 tokens

#[cfg(not(feature = "no-entrypoint"))]
pub mod entrypoint;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

// Re-export for test harness
pub use rialo_s_program::pubkey::Pubkey;
