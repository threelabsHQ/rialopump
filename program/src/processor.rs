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
    state::{TokenState, MAX_DESC_LEN, MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_TAX_BPS, MAX_URL_LEN},
};

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = LaunchpadInstruction::try_from_slice(instruction_data)
        .map_err(|_| LaunchpadError::InvalidInstruction)?;

    match instruction {
        LaunchpadInstruction::CreateToken { token_id, name, symbol, description, image_url, token_tax_bps } => {
            process_create_token(program_id, accounts, token_id, name, symbol, description, image_url, token_tax_bps)
        }
        LaunchpadInstruction::Buy { token_id, rlo_amount, min_tokens_out } => {
            process_buy(program_id, accounts, token_id, rlo_amount, min_tokens_out)
        }
        LaunchpadInstruction::Sell { token_id, token_amount, min_rlo_out } => {
            process_sell(program_id, accounts, token_id, token_amount, min_rlo_out)
        }
        LaunchpadInstruction::WithdrawFees { token_id } => {
            process_withdraw_fees(program_id, accounts, token_id)
        }
        LaunchpadInstruction::ClaimCreatorEarnings { token_id } => {
            process_claim_creator_earnings(program_id, accounts, token_id)
        }
        LaunchpadInstruction::UpdateTokenTax { token_id, new_tax_bps } => {
            process_update_token_tax(program_id, accounts, token_id, new_tax_bps)
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn token_state_seeds(token_id: &[u8; 16]) -> Vec<Vec<u8>> {
    vec![b"token".to_vec(), token_id.to_vec()]
}

fn fee_vault_seeds(token_id: &[u8; 16]) -> Vec<Vec<u8>> {
    vec![b"fees".to_vec(), token_id.to_vec()]
}

fn find_pda(program_id: &Pubkey, seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}

fn load_state(account: &AccountInfo) -> Result<TokenState, ProgramError> {
    let data = account.try_borrow_data()?;
    TokenState::try_from_slice(&data).map_err(|_| LaunchpadError::NotInitialized.into())
}

fn save_state(account: &AccountInfo, state: &TokenState) -> ProgramResult {
    let serialized = borsh::to_vec(state).map_err(|_| ProgramError::InvalidAccountData)?;
    let mut data = account.try_borrow_mut_data()?;
    if serialized.len() > data.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    data[..serialized.len()].copy_from_slice(&serialized);
    Ok(())
}

/// Transfer lamports from one account to another via system program.
/// Pass signer_seeds if the `from` account is a PDA.
fn transfer_lamports<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    amount: u64,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    if amount == 0 { return Ok(()); }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    let accounts = &[from.clone(), to.clone(), system.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, accounts, &[seeds]),
        None => invoke_signed(&ix, accounts, &[]),
    }
}

// ── CreateToken ────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn process_create_token(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    name: String,
    symbol: String,
    description: String,
    image_url: String,
    token_tax_bps: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info      = next_account_info(account_iter)?;
    let token_state_info  = next_account_info(account_iter)?;
    let fee_vault_info    = next_account_info(account_iter)?;
    let system_info       = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // Input validation
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return Err(LaunchpadError::InvalidInstruction.into());
    }
    if symbol.is_empty() || symbol.len() > MAX_SYMBOL_LEN {
        return Err(LaunchpadError::InvalidInstruction.into());
    }
    if description.len() > MAX_DESC_LEN || image_url.len() > MAX_URL_LEN {
        return Err(LaunchpadError::InvalidInstruction.into());
    }
    if token_tax_bps > MAX_TAX_BPS {
        return Err(LaunchpadError::TaxTooHigh.into());
    }

    // Verify token_state PDA
    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, ts_bump) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if !token_state_info.data_is_empty() {
        return Err(LaunchpadError::AlreadyInitialized.into());
    }

    // Verify fee_vault PDA
    let fv_seeds_raw = fee_vault_seeds(&token_id);
    let fv_seeds: Vec<&[u8]> = fv_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, fv_bump) = find_pda(program_id, &fv_seeds);
    if &fv_pda != fee_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Build initial state
    let state = TokenState::new(
        *creator_info.key, name.clone(), symbol.clone(),
        description, image_url, token_tax_bps,
    );

    // Allocate token_state account (add 128 bytes headroom)
    let serialized = borsh::to_vec(&state).map_err(|_| ProgramError::InvalidAccountData)?;
    let ts_space = serialized.len() + 128;
    let rent = Rent::get()?;
    let ts_lamports = rent.minimum_balance(ts_space);

    let mut ts_signer = ts_seeds_raw.clone();
    ts_signer.push(vec![ts_bump]);
    let ts_signer_ref: Vec<&[u8]> = ts_signer.iter().map(|s| s.as_slice()).collect();

    invoke_signed(
        &system_instruction::create_account(
            creator_info.key, &ts_pda, ts_lamports, ts_space as u64, program_id,
        ),
        &[creator_info.clone(), token_state_info.clone(), system_info.clone()],
        &[&ts_signer_ref],
    )?;
    save_state(token_state_info, &state)?;

    // Allocate fee_vault account (0 data, just rent-exempt)
    if fee_vault_info.data_is_empty() {
        let fv_lamports = rent.minimum_balance(0);
        let mut fv_signer = fv_seeds_raw.clone();
        fv_signer.push(vec![fv_bump]);
        let fv_signer_ref: Vec<&[u8]> = fv_signer.iter().map(|s| s.as_slice()).collect();

        invoke_signed(
            &system_instruction::create_account(
                creator_info.key, &fv_pda, fv_lamports, 0, program_id,
            ),
            &[creator_info.clone(), fee_vault_info.clone(), system_info.clone()],
            &[&fv_signer_ref],
        )?;
    }

    // Charge creation fee → fee_vault
    transfer_lamports(
        creator_info, fee_vault_info, system_info,
        TokenState::CREATION_FEE_KELVIN, None,
    )?;

    msg!(
        "CreateToken: {} ({}) id={:?} tax={}bps creation_fee={}k",
        name, symbol, token_id, token_tax_bps, TokenState::CREATION_FEE_KELVIN
    );
    Ok(())
}

// ── Buy ───────────────────────────────────────────────────────────────────────

fn process_buy(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    rlo_amount: u64,
    min_tokens_out: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let buyer_info       = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info   = next_account_info(account_iter)?;
    let system_info      = next_account_info(account_iter)?;

    if !buyer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if rlo_amount < TokenState::MIN_BUY_KELVIN {
        return Err(LaunchpadError::BelowMinimumBuy.into());
    }

    let mut state = load_state(token_state_info)?;
    if state.graduated {
        return Err(LaunchpadError::TokenGraduated.into());
    }

    // Verify PDAs
    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, _) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key { return Err(ProgramError::InvalidArgument); }

    let fv_seeds_raw = fee_vault_seeds(&token_id);
    let fv_seeds: Vec<&[u8]> = fv_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, _) = find_pda(program_id, &fv_seeds);
    if &fv_pda != fee_vault_info.key { return Err(ProgramError::InvalidArgument); }

    let (rlo_into_curve, platform_fee, creator_tax) = state.apply_buy_fees(rlo_amount);

    let (tokens_out, new_vr, new_vt) = state
        .calc_buy(rlo_into_curve)
        .ok_or(LaunchpadError::Overflow)?;

    // Cap at available supply
    let available = TokenState::TOTAL_SUPPLY.saturating_sub(state.tokens_sold);
    let tokens_out = tokens_out.min(available);

    if tokens_out == 0 { return Err(LaunchpadError::NoTokensAvailable.into()); }
    if tokens_out < min_tokens_out { return Err(LaunchpadError::SlippageExceeded.into()); }

    // Transfers: fee → fee_vault, creator_tax → token_state (held for claim), curve_rlo → token_state
    transfer_lamports(buyer_info, fee_vault_info, system_info, platform_fee, None)?;
    transfer_lamports(buyer_info, token_state_info, system_info, creator_tax, None)?;
    transfer_lamports(buyer_info, token_state_info, system_info, rlo_into_curve, None)?;

    // Update state
    state.virtual_rlo = new_vr;
    state.virtual_tokens = new_vt;
    state.real_rlo_raised = state.real_rlo_raised.saturating_add(rlo_into_curve);
    state.tokens_sold = state.tokens_sold.saturating_add(tokens_out);
    state.fees_collected = state.fees_collected.saturating_add(platform_fee);
    state.creator_earnings = state.creator_earnings.saturating_add(creator_tax);

    // Graduation check: real RLO raised >= target
    if state.real_rlo_raised >= TokenState::GRADUATION_RLO_TARGET {
        state.graduated = true;
        msg!(
            "GRADUATION: {} ({}) raised {} kelvin — token is now graduated!",
            state.name, state.symbol, state.real_rlo_raised
        );
    }

    save_state(token_state_info, &state)?;
    msg!(
        "Buy: out={} tokens rlo_spent={} fee={} tax={} raised_total={}",
        tokens_out, rlo_amount, platform_fee, creator_tax, state.real_rlo_raised
    );
    Ok(())
}

// ── Sell ──────────────────────────────────────────────────────────────────────

fn process_sell(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    token_amount: u64,
    min_rlo_out: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let seller_info      = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info   = next_account_info(account_iter)?;
    let system_info      = next_account_info(account_iter)?;

    if !seller_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token_amount == 0 { return Err(LaunchpadError::InsufficientBalance.into()); }

    let mut state = load_state(token_state_info)?;
    if state.graduated { return Err(LaunchpadError::TokenGraduated.into()); }

    // Verify PDAs
    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, ts_bump) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key { return Err(ProgramError::InvalidArgument); }

    let fv_seeds_raw = fee_vault_seeds(&token_id);
    let fv_seeds: Vec<&[u8]> = fv_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, _) = find_pda(program_id, &fv_seeds);
    if &fv_pda != fee_vault_info.key { return Err(ProgramError::InvalidArgument); }

    let (rlo_before_fee, new_vr, new_vt) = state
        .calc_sell(token_amount)
        .ok_or(LaunchpadError::Overflow)?;

    let (rlo_to_seller, platform_fee, creator_tax) = state.apply_sell_fees(rlo_before_fee);

    if rlo_to_seller == 0 { return Err(LaunchpadError::InsufficientBalance.into()); }
    if rlo_to_seller < min_rlo_out { return Err(LaunchpadError::SlippageExceeded.into()); }

    // Signer seeds for token_state PDA (it pays out)
    let mut ts_signer = ts_seeds_raw.clone();
    ts_signer.push(vec![ts_bump]);
    let ts_signer_ref: Vec<&[u8]> = ts_signer.iter().map(|s| s.as_slice()).collect();

    // Transfers: curve RLO → seller, fee → fee_vault, creator_tax → stays in token_state
    transfer_lamports(token_state_info, seller_info, system_info, rlo_to_seller, Some(&ts_signer_ref))?;
    transfer_lamports(token_state_info, fee_vault_info, system_info, platform_fee, Some(&ts_signer_ref))?;
    // creator_tax stays in token_state (already there), just update the counter

    // Update state
    state.virtual_rlo = new_vr;
    state.virtual_tokens = new_vt;
    state.real_rlo_raised = state.real_rlo_raised.saturating_sub(rlo_before_fee);
    state.tokens_sold = state.tokens_sold.saturating_sub(token_amount);
    state.fees_collected = state.fees_collected.saturating_add(platform_fee);
    state.creator_earnings = state.creator_earnings.saturating_add(creator_tax);

    save_state(token_state_info, &state)?;
    msg!(
        "Sell: in={} tokens rlo_out={} fee={} tax={}",
        token_amount, rlo_to_seller, platform_fee, creator_tax
    );
    Ok(())
}

// ── WithdrawFees ──────────────────────────────────────────────────────────────

fn process_withdraw_fees(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let authority_info   = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info   = next_account_info(account_iter)?;
    let system_info      = next_account_info(account_iter)?;

    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let state = load_state(token_state_info)?;
    // On devnet: only the token creator can sweep platform fees
    if authority_info.key != &state.creator {
        return Err(LaunchpadError::NotCreator.into());
    }

    let fv_seeds_raw = fee_vault_seeds(&token_id);
    let fv_seeds: Vec<&[u8]> = fv_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, fv_bump) = find_pda(program_id, &fv_seeds);
    if &fv_pda != fee_vault_info.key { return Err(ProgramError::InvalidArgument); }

    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(0);
    let balance = fee_vault_info.lamports();
    if balance <= min_balance { return Err(LaunchpadError::NothingToClaim.into()); }
    let to_withdraw = balance - min_balance;

    let mut fv_signer = fv_seeds_raw.clone();
    fv_signer.push(vec![fv_bump]);
    let fv_signer_ref: Vec<&[u8]> = fv_signer.iter().map(|s| s.as_slice()).collect();

    transfer_lamports(fee_vault_info, authority_info, system_info, to_withdraw, Some(&fv_signer_ref))?;

    msg!("WithdrawFees: {} kelvin withdrawn by {}", to_withdraw, authority_info.key);
    Ok(())
}

// ── ClaimCreatorEarnings ──────────────────────────────────────────────────────

fn process_claim_creator_earnings(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info     = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let system_info      = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = load_state(token_state_info)?;
    if creator_info.key != &state.creator {
        return Err(LaunchpadError::NotCreator.into());
    }

    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, ts_bump) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key { return Err(ProgramError::InvalidArgument); }

    let amount = state.creator_earnings;
    if amount == 0 { return Err(LaunchpadError::NothingToClaim.into()); }

    let mut ts_signer = ts_seeds_raw.clone();
    ts_signer.push(vec![ts_bump]);
    let ts_signer_ref: Vec<&[u8]> = ts_signer.iter().map(|s| s.as_slice()).collect();

    transfer_lamports(token_state_info, creator_info, system_info, amount, Some(&ts_signer_ref))?;

    state.creator_earnings = 0;
    save_state(token_state_info, &state)?;

    msg!("ClaimCreatorEarnings: {} kelvin claimed by {}", amount, creator_info.key);
    Ok(())
}

// ── UpdateTokenTax ────────────────────────────────────────────────────────────

fn process_update_token_tax(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    new_tax_bps: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info     = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if new_tax_bps > MAX_TAX_BPS {
        return Err(LaunchpadError::TaxTooHigh.into());
    }

    let mut state = load_state(token_state_info)?;
    if creator_info.key != &state.creator {
        return Err(LaunchpadError::NotCreator.into());
    }

    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, _) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key { return Err(ProgramError::InvalidArgument); }

    state.token_tax_bps = new_tax_bps;
    save_state(token_state_info, &state)?;

    msg!("UpdateTokenTax: {}bps for token {:?}", new_tax_bps, token_id);
    Ok(())
}
