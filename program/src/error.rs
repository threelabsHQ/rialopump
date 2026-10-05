use rialo_s_program::program_error::ProgramError;

#[derive(Debug, Clone, PartialEq)]
pub enum LaunchpadError {
    AlreadyInitialized,
    NotInitialized,
    InvalidInstruction,
    InsufficientBalance,
    TokenGraduated,
    Overflow,
    NoTokensAvailable,
    UnauthorizedWithdraw,
}

impl From<LaunchpadError> for ProgramError {
    fn from(e: LaunchpadError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
