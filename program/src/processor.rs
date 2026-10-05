use borsh::{BorshDeserialize, BorshSerialize};
use rialo_s_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::{rent::Rent, Sysvar},
};

use crate::{
    error::LaunchpadError,
    instruction::LaunchpadInstruction,
    state::{TokenState, MAX_DESC_LEN, MAX_NAME_LEN, MAX_SYMBOL_LEN},
};

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = LaunchpadInstruction::try_from_slice(instruction_data)
        .map_err(|_| LaunchpadError::InvalidInstruction)?;

    match instruction {
        LaunchpadInstruction::CreateToken { token_id, name, symbol, description } => {
            process_create_token(program_id, accounts, token_id, name, symbol, description)
        }
        LaunchpadInstruction::Buy { token_id, rlo_amount } => {
            process_buy(program_id, accounts, token_id, rlo_amount)
        }
        LaunchpadInstruction::Sell { token_id, token_amount } => {
            process_sell(program_id, accounts, token_id, token_amount)
        }
        LaunchpadInstruction::WithdrawFees { token_id } => {
            process_withdraw_fees(program_id, accounts, token_id)
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn token_state_seeds(token_id: &[u8; 16]) -> Vec<Vec<u8>> {
    vec![b"token".to_vec(), token_id.to_vec()]
}

fn fee_vault_seeds(token_id: &[u8; 16]) -> Vec<Vec<u8>> {
    vec![b"fees".to_vec(), token_id.to_vec()]
}

fn find_pda(program_id: &Pubkey, seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}

fn apply_fee(amount: u64) -> (u64, u64) {
    let fee = amount
        .checked_mul(TokenState::PLATFORM_FEE_BPS)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0);
    let after_fee = amount.saturating_sub(fee);
    (after_fee, fee)
}

// ── CreateToken ────────────────────────────────────────────────────────────

fn process_create_token(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    name: String,
    symbol: String,
    description: String,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate lengths
    if name.len() > MAX_NAME_LEN || symbol.len() > MAX_SYMBOL_LEN || description.len() > MAX_DESC_LEN {
        return Err(LaunchpadError::InvalidInstruction.into());
    }

    // Derive PDA and verify
    let seeds_raw = token_state_seeds(&token_id);
    let seeds: Vec<&[u8]> = seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (pda, bump) = find_pda(program_id, &seeds);
    if &pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Check not already initialized
    if !token_state_info.data_is_empty() {
        return Err(LaunchpadError::AlreadyInitialized.into());
    }

    // Allocate account
    let state = TokenState::new(*creator_info.key, name, symbol, description);
    let data = state.try_to_vec()?;
    let space = data.len() + 64; // small headroom for future fields
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);

    let mut signer_seeds = seeds_raw.clone();
    signer_seeds.push(vec![bump]);
    let signer_seeds_ref: Vec<&[u8]> = signer_seeds.iter().map(|s| s.as_slice()).collect();

    invoke_signed(
        &system_instruction::create_account(
            creator_info.key,
            &pda,
            lamports,
            space as u64,
            program_id,
        ),
        &[creator_info.clone(), token_state_info.clone(), system_program_info.clone()],
        &[&signer_seeds_ref],
    )?;

    // Write state
    let mut acct_data = token_state_info.try_borrow_mut_data()?;
    acct_data[..data.len()].copy_from_slice(&data);

    msg!("CreateToken: {} ({}) id={:?}", state.name, state.symbol, token_id);
    Ok(())
}

// ── Buy ───────────────────────────────────────────────────────────────────

fn process_buy(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    rlo_amount: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let buyer_info = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !buyer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Load state
    let mut state = {
        let data = token_state_info.try_borrow_data()?;
        TokenState::try_from_slice(&data).map_err(|_| LaunchpadError::NotInitialized)?
    };

    if state.graduated {
        return Err(LaunchpadError::TokenGraduated.into());
    }

    let (rlo_after_fee, fee) = apply_fee(rlo_amount);

    let (tokens_out, new_vr, new_vt) = state
        .calc_buy(rlo_after_fee)
        .ok_or(LaunchpadError::Overflow)?;

    let available = TokenState::GRADUATION_SUPPLY.saturating_sub(state.token_supply);
    let tokens_out = tokens_out.min(available);
    if tokens_out == 0 {
        return Err(LaunchpadError::NoTokensAvailable.into());
    }

    // Transfer rlo_amount from buyer to token_state account (lamports = kelvin on Rialo)
    invoke_signed(
        &system_instruction::transfer(buyer_info.key, token_state_info.key, rlo_after_fee),
        &[buyer_info.clone(), token_state_info.clone(), system_program_info.clone()],
        &[],
    )?;

    // Transfer fee to fee_vault
    if fee > 0 {
        invoke_signed(
            &system_instruction::transfer(buyer_info.key, fee_vault_info.key, fee),
            &[buyer_info.clone(), fee_vault_info.clone(), system_program_info.clone()],
            &[],
        )?;
    }

    // Update state
    state.virtual_rlo = new_vr;
    state.virtual_tokens = new_vt;
    state.token_supply += tokens_out;
    state.fees_collected += fee;

    if state.token_supply >= TokenState::GRADUATION_SUPPLY {
        state.graduated = true;
        msg!("Token graduated!");
    }

    let new_data = state.try_to_vec()?;
    let mut acct_data = token_state_info.try_borrow_mut_data()?;
    acct_data[..new_data.len()].copy_from_slice(&new_data);

    msg!("Buy: {} tokens for {} kelvin (fee={})", tokens_out, rlo_amount, fee);
    Ok(())
}

// ── Sell ──────────────────────────────────────────────────────────────────

fn process_sell(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    token_amount: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let seller_info = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !seller_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = {
        let data = token_state_info.try_borrow_data()?;
        TokenState::try_from_slice(&data).map_err(|_| LaunchpadError::NotInitialized)?
    };

    if state.graduated {
        return Err(LaunchpadError::TokenGraduated.into());
    }

    let (rlo_before_fee, new_vr, new_vt) = state
        .calc_sell(token_amount)
        .ok_or(LaunchpadError::Overflow)?;

    let (rlo_to_seller, fee) = apply_fee(rlo_before_fee);

    if rlo_to_seller == 0 {
        return Err(LaunchpadError::InsufficientBalance.into());
    }

    // Transfer RLO from token_state back to seller
    // (using PDA signer)
    let seeds_raw = token_state_seeds(&token_id);
    let (_, bump) = {
        let seeds: Vec<&[u8]> = seeds_raw.iter().map(|s| s.as_slice()).collect();
        find_pda(program_id, &seeds)
    };
    let mut signer_seeds = seeds_raw.clone();
    signer_seeds.push(vec![bump]);
    let signer_seeds_ref: Vec<&[u8]> = signer_seeds.iter().map(|s| s.as_slice()).collect();

    invoke_signed(
        &system_instruction::transfer(token_state_info.key, seller_info.key, rlo_to_seller),
        &[token_state_info.clone(), seller_info.clone(), system_program_info.clone()],
        &[&signer_seeds_ref],
    )?;

    if fee > 0 {
        invoke_signed(
            &system_instruction::transfer(token_state_info.key, fee_vault_info.key, fee),
            &[token_state_info.clone(), fee_vault_info.clone(), system_program_info.clone()],
            &[&signer_seeds_ref],
        )?;
    }

    // Update state
    state.virtual_rlo = new_vr;
    state.virtual_tokens = new_vt;
    state.token_supply = state.token_supply.saturating_sub(token_amount);
    state.fees_collected += fee;

    let new_data = state.try_to_vec()?;
    let mut acct_data = token_state_info.try_borrow_mut_data()?;
    acct_data[..new_data.len()].copy_from_slice(&new_data);

    msg!("Sell: {} tokens → {} kelvin to seller (fee={})", token_amount, rlo_to_seller, fee);
    Ok(())
}

// ── WithdrawFees ──────────────────────────────────────────────────────────

fn process_withdraw_fees(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let state = {
        let data = token_state_info.try_borrow_data()?;
        TokenState::try_from_slice(&data).map_err(|_| LaunchpadError::NotInitialized)?
    };

    if &state.creator != creator_info.key {
        return Err(LaunchpadError::UnauthorizedWithdraw.into());
    }

    let fee_seeds_raw = fee_vault_seeds(&token_id);
    let (_, bump) = {
        let seeds: Vec<&[u8]> = fee_seeds_raw.iter().map(|s| s.as_slice()).collect();
        find_pda(program_id, &seeds)
    };
    let mut signer_seeds = fee_seeds_raw.clone();
    signer_seeds.push(vec![bump]);
    let signer_seeds_ref: Vec<&[u8]> = signer_seeds.iter().map(|s| s.as_slice()).collect();

    let vault_balance = **fee_vault_info.lamports.borrow();
    if vault_balance == 0 {
        return Ok(());
    }

    invoke_signed(
        &system_instruction::transfer(fee_vault_info.key, creator_info.key, vault_balance),
        &[fee_vault_info.clone(), creator_info.clone(), system_program_info.clone()],
        &[&signer_seeds_ref],
    )?;

    msg!("WithdrawFees: {} kelvin to creator", vault_balance);
    Ok(())
}
