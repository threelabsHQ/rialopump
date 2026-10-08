use rialo_s_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Debug, Clone, PartialEq)]
pub enum LaunchpadError {
    AlreadyInitialized   = 0,
    NotInitialized       = 1,
    InvalidInstruction   = 2,
    InsufficientBalance  = 3,
    TokenGraduated       = 4,
    Overflow             = 5,
    NoTokensAvailable    = 6,
    UnauthorizedWithdraw = 7,
    SlippageExceeded     = 8,
    TaxTooHigh           = 9,
    NothingToClaim       = 10,
    BelowMinimumBuy      = 11,
}

impl From<LaunchpadError> for ProgramError {
    fn from(e: LaunchpadError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
