use rialo_s_program::program_error::ProgramError;
use rialo_s_program_error::declare_error;

declare_error! {
    pub enum LaunchpadError {
        #[msg("Invalid instruction data")]
        InvalidInstruction,
        #[msg("Token state already initialised")]
        AlreadyInitialized,
        #[msg("Token state not initialised")]
        NotInitialized,
        #[msg("Integer overflow in bonding curve math")]
        Overflow,
        #[msg("Buy amount is below the minimum (0.001 RLO)")]
        BelowMinimumBuy,
        #[msg("Token has graduated and can no longer be traded on the curve")]
        TokenGraduated,
        #[msg("Insufficient tokens available on curve")]
        NoTokensAvailable,
        #[msg("Slippage tolerance exceeded")]
        SlippageExceeded,
        #[msg("Insufficient balance")]
        InsufficientBalance,
        #[msg("Creator tax exceeds maximum (10%)")]
        TaxTooHigh,
        #[msg("Caller is not the token creator")]
        NotCreator,
        #[msg("Nothing to claim")]
        NothingToClaim,
    }
}

impl From<LaunchpadError> for ProgramError {
    fn from(e: LaunchpadError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
