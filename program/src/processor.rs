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

fn load_state(account: &AccountInfo) -> Result<TokenState, ProgramError> {
    let data = account.try_borrow_data()?;
    TokenState::try_from_slice(&data).map_err(|_| LaunchpadError::NotInitialized.into())
}

fn save_state(account: &AccountInfo, state: &TokenState) -> ProgramResult {
    let new_data = borsh::to_vec(state).map_err(|_| ProgramError::InvalidAccountData)?;
    let mut acct_data = account.try_borrow_mut_data()?;
    if new_data.len() > acct_data.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    acct_data[..new_data.len()].copy_from_slice(&new_data);
    Ok(())
}

fn transfer_lamports<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    amount: u64,
    signer_seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    let accounts = &[from.clone(), to.clone(), system.clone()];
    match signer_seeds {
        Some(seeds) => invoke_signed(&ix, accounts, &[seeds]),
        None => invoke_signed(&ix, accounts, &[]),
    }
}

// ── CreateToken ────────────────────────────────────────────────────────────

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
    let creator_info   = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if name.len() > MAX_NAME_LEN
        || symbol.len() > MAX_SYMBOL_LEN
        || description.len() > MAX_DESC_LEN
        || image_url.len() > MAX_URL_LEN
    {
        return Err(LaunchpadError::InvalidInstruction.into());
    }
    if token_tax_bps > MAX_TAX_BPS {
        return Err(LaunchpadError::TaxTooHigh.into());
    }

    // Derive PDA and verify
    let seeds_raw = token_state_seeds(&token_id);
    let seeds: Vec<&[u8]> = seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (pda, bump) = find_pda(program_id, &seeds);
    if &pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if !token_state_info.data_is_empty() {
        return Err(LaunchpadError::AlreadyInitialized.into());
    }

    let state = TokenState::new(
        *creator_info.key,
        name.clone(),
        symbol.clone(),
        description,
        image_url,
        token_tax_bps,
    );
    // Add 128 bytes headroom for future fields
    let serialized = borsh::to_vec(&state).map_err(|_| ProgramError::InvalidAccountData)?;
    let space = serialized.len() + 128;
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

    save_state(token_state_info, &state)?;
    msg!("CreateToken: {} ({}) tax={}bps id={:?}", name, symbol, token_tax_bps, token_id);
    Ok(())
}

// ── Buy ───────────────────────────────────────────────────────────────────

fn process_buy(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    rlo_amount: u64,
    min_tokens_out: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let buyer_info      = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info  = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

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
    if &ts_pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    let fv_seeds_raw = fee_vault_seeds(&token_id);
    let fv_seeds: Vec<&[u8]> = fv_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, _) = find_pda(program_id, &fv_seeds);
    if &fv_pda != fee_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let (rlo_after_fees, platform_fee, creator_tax) = state.apply_buy_fees(rlo_amount);

    let available = TokenState::GRADUATION_SUPPLY.saturating_sub(state.token_supply);
    let (tokens_out, new_vr, new_vt) = state
        .calc_buy(rlo_after_fees)
        .ok_or(LaunchpadError::Overflow)?;
    let tokens_out = tokens_out.min(available);

    if tokens_out == 0 {
        return Err(LaunchpadError::NoTokensAvailable.into());
    }
    if tokens_out < min_tokens_out {
        return Err(LaunchpadError::SlippageExceeded.into());
    }

    // 1) platform fee → fee_vault
    transfer_lamports(buyer_info, fee_vault_info, system_program_info, platform_fee, None)?;
    // 2) creator tax → token_state (will be claimed via ClaimCreatorEarnings)
    transfer_lamports(buyer_info, token_state_info, system_program_info, creator_tax, None)?;
    // 3) net rlo → token_state (bonding curve liquidity)
    transfer_lamports(buyer_info, token_state_info, system_program_info, rlo_after_fees, None)?;

    state.virtual_rlo = new_vr;
    state.virtual_tokens = new_vt;
    state.token_supply += tokens_out;
    state.fees_collected += platform_fee;
    state.creator_earnings = state.creator_earnings.saturating_add(creator_tax);

    if state.token_supply >= TokenState::GRADUATION_SUPPLY {
        state.graduated = true;
        msg!("Token graduated!");
    }

    save_state(token_state_info, &state)?;
    msg!(
        "Buy: {} tokens for {} kelvin (platform_fee={} creator_tax={})",
        tokens_out, rlo_amount, platform_fee, creator_tax
    );
    Ok(())
}

// ── Sell ──────────────────────────────────────────────────────────────────

fn process_sell(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    token_amount: u64,
    min_rlo_out: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let seller_info     = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info  = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !seller_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token_amount == 0 {
        return Err(LaunchpadError::InsufficientBalance.into());
    }

    let mut state = load_state(token_state_info)?;
    if state.graduated {
        return Err(LaunchpadError::TokenGraduated.into());
    }

    // Verify PDAs
    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, ts_bump) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    let fv_seeds_raw = fee_vault_seeds(&token_id);
    let fv_seeds: Vec<&[u8]> = fv_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, _) = find_pda(program_id, &fv_seeds);
    if &fv_pda != fee_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let (rlo_before_fee, new_vr, new_vt) = state
        .calc_sell(token_amount)
        .ok_or(LaunchpadError::Overflow)?;

    let (rlo_to_seller, platform_fee, creator_tax) = state.apply_sell_fees(rlo_before_fee);

    if rlo_to_seller == 0 {
        return Err(LaunchpadError::InsufficientBalance.into());
    }
    if rlo_to_seller < min_rlo_out {
        return Err(LaunchpadError::SlippageExceeded.into());
    }

    // token_state PDA signs the outgoing transfers
    let mut ts_signer_seeds = ts_seeds_raw.clone();
    ts_signer_seeds.push(vec![ts_bump]);
    let ts_signer_ref: Vec<&[u8]> = ts_signer_seeds.iter().map(|s| s.as_slice()).collect();

    // 1) rlo_to_seller ← token_state (PDA)
    transfer_lamports(token_state_info, seller_info, system_program_info, rlo_to_seller, Some(&ts_signer_ref))?;
    // 2) platform fee → fee_vault
    transfer_lamports(token_state_info, fee_vault_info, system_program_info, platform_fee, Some(&ts_signer_ref))?;
    // 3) creator tax stays in token_state (already there, just update creator_earnings)

    state.virtual_rlo = new_vr;
    state.virtual_tokens = new_vt;
    state.token_supply = state.token_supply.saturating_sub(token_amount);
    state.fees_collected = state.fees_collected.saturating_add(platform_fee);
    state.creator_earnings = state.creator_earnings.saturating_add(creator_tax);

    save_state(token_state_info, &state)?;
    msg!(
        "Sell: {} tokens → {} kelvin to seller (platform_fee={} creator_tax={})",
        token_amount, rlo_to_seller, platform_fee, creator_tax
    );
    Ok(())
}

// ── WithdrawFees ──────────────────────────────────────────────────────────

fn process_withdraw_fees(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info    = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let fee_vault_info  = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let state = load_state(token_state_info)?;
    if &state.creator != creator_info.key {
        return Err(LaunchpadError::UnauthorizedWithdraw.into());
    }

    let fee_seeds_raw = fee_vault_seeds(&token_id);
    let fee_seeds: Vec<&[u8]> = fee_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (fv_pda, bump) = find_pda(program_id, &fee_seeds);
    if &fv_pda != fee_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let mut fv_signer_seeds = fee_seeds_raw.clone();
    fv_signer_seeds.push(vec![bump]);
    let fv_signer_ref: Vec<&[u8]> = fv_signer_seeds.iter().map(|s| s.as_slice()).collect();

    let vault_balance = fee_vault_info.kelvins();
    if vault_balance == 0 {
        return Err(LaunchpadError::NothingToClaim.into());
    }

    transfer_lamports(fee_vault_info, creator_info, system_program_info, vault_balance, Some(&fv_signer_ref))?;

    msg!("WithdrawFees: {} kelvin to creator", vault_balance);
    Ok(())
}

// ── ClaimCreatorEarnings ──────────────────────────────────────────────────

fn process_claim_creator_earnings(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info    = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;
    let system_program_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut state = load_state(token_state_info)?;
    if &state.creator != creator_info.key {
        return Err(LaunchpadError::UnauthorizedWithdraw.into());
    }

    let amount = state.creator_earnings;
    if amount == 0 {
        return Err(LaunchpadError::NothingToClaim.into());
    }

    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, bump) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let mut ts_signer_seeds = ts_seeds_raw.clone();
    ts_signer_seeds.push(vec![bump]);
    let ts_signer_ref: Vec<&[u8]> = ts_signer_seeds.iter().map(|s| s.as_slice()).collect();

    transfer_lamports(token_state_info, creator_info, system_program_info, amount, Some(&ts_signer_ref))?;

    state.creator_earnings = 0;
    save_state(token_state_info, &state)?;

    msg!("ClaimCreatorEarnings: {} kelvin to creator", amount);
    Ok(())
}

// ── UpdateTokenTax ────────────────────────────────────────────────────────

fn process_update_token_tax(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    token_id: [u8; 16],
    new_tax_bps: u64,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let creator_info    = next_account_info(account_iter)?;
    let token_state_info = next_account_info(account_iter)?;

    if !creator_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if new_tax_bps > MAX_TAX_BPS {
        return Err(LaunchpadError::TaxTooHigh.into());
    }

    let ts_seeds_raw = token_state_seeds(&token_id);
    let ts_seeds: Vec<&[u8]> = ts_seeds_raw.iter().map(|s| s.as_slice()).collect();
    let (ts_pda, _) = find_pda(program_id, &ts_seeds);
    if &ts_pda != token_state_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let mut state = load_state(token_state_info)?;
    if &state.creator != creator_info.key {
        return Err(LaunchpadError::UnauthorizedWithdraw.into());
    }

    state.token_tax_bps = new_tax_bps;
    save_state(token_state_info, &state)?;

    msg!("UpdateTokenTax: new_tax={}bps", new_tax_bps);
    Ok(())
}
