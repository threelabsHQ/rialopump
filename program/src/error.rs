use rialo_s_program::program_error::ProgramError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum LaunchpadError {
    InvalidInstruction    = 0,
    AlreadyInitialized    = 1,
    NotInitialized        = 2,
    Overflow              = 3,
    BelowMinimumBuy       = 4,
    TokenGraduated        = 5,
    NoTokensAvailable     = 6,
    SlippageExceeded      = 7,
    InsufficientBalance   = 8,
    TaxTooHigh            = 9,
    NotCreator            = 10,
    NothingToClaim        = 11,
}

impl From<LaunchpadError> for ProgramError {
    fn from(e: LaunchpadError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
