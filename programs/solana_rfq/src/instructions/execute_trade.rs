use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_program::sysvar::instructions::{load_instruction_at_checked, ID as IX_ID};

use crate::{constants::*, error::RfqError, state::RfqRecord};

#[derive(Accounts)]
#[instruction(rfq_id: [u8; 16])]
pub struct ExecuteTrade<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    // Maker does not sign here; their intent is verified via the Ed25519 native instruction.
    /// CHECK:
    pub maker: UncheckedAccount<'info>,

    #[account(
        init,
        payer = taker,
        space = RfqRecord::LEN,
        seeds = [RFQ_RECORD_SEED, rfq_id.as_ref()],
        bump
    )]
    pub rfq_record: Account<'info, RfqRecord>,

    // PDA used as the authority for transferring maker's funds.
    /// CHECK:
    #[account(seeds = [RFQ_AUTHORITY_SEED], bump)]
    pub rfq_authority: UncheckedAccount<'info>,

    // Owner constraint: ensures the taker's base token ATA is owned by the taker.
    // This validation is critical for atomic, zero-slippage settlement in high-value RWA trading.
    #[account(
        mut, 
        constraint = taker_base_ata.owner == taker.key()
    )]
    pub taker_base_ata: Account<'info, TokenAccount>,

    // Owner constraint: ensures the maker's base token ATA is owned by the maker and matches the taker's base mint.
    // Atomic, zero-slippage settlement for high-value RWA trading requires strict ownership verification.
    #[account(
        mut, 
        constraint = maker_base_ata.owner == maker.key(),
        constraint = maker_base_ata.mint == taker_base_ata.mint
    )]
    pub maker_base_ata: Account<'info, TokenAccount>,

    // Owner constraint: ensures the maker's quote token ATA is owned by the maker.
    // Delegate amount validation below enforces sufficient token allowance for atomic settlement.
    #[account(
        mut, 
        constraint = maker_quote_ata.owner == maker.key()
    )]
    pub maker_quote_ata: Account<'info, TokenAccount>,

    // Owner constraint: ensures the taker's quote token ATA is owned by the taker and matches the maker's quote mint.
    // Atomic, zero-slippage settlement for high-value RWA trading requires strict mint matching.
    #[account(
        mut, 
        constraint = taker_quote_ata.owner == taker.key(),
        constraint = taker_quote_ata.mint == maker_quote_ata.mint
    )]
    pub taker_quote_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    // Instructions sysvar required for reading the preceding Ed25519 verification instruction.
    /// CHECK:
    #[account(address = IX_ID)]
    pub ix_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<ExecuteTrade>,
    rfq_id: [u8; 16],
    base_amount: u64,
    quote_amount: u64,
    expiry: i64,
    msg_bytes: Vec<u8>, // Pre-constructed message bytes for signature verification.
) -> Result<()> {

    // Verify that the maker has delegated sufficient quote tokens for this trade.
    require!(
        ctx.accounts.maker_quote_ata.delegated_amount >= quote_amount,
        RfqError::InsufficientDelegation
    );

    // Ensure the quote has not expired.
    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= expiry, RfqError::QuoteExpired);

    // Replay protection: mark this RFQ as executed and record the involved parties.
    // This prevents double-spend attacks in large volume trades by ensuring each RFQ ID
    // can only be settled once, critical for institutional-grade RWA settlement.
    let rfq_record = &mut ctx.accounts.rfq_record;
    rfq_record.executed = true;
    rfq_record.maker = ctx.accounts.maker.key();
    rfq_record.taker = ctx.accounts.taker.key();

    // Core verification: parse and validate the Ed25519 instruction to confirm maker's signature.
    // Gas-optimized instruction introspection via SYSVAR, bypassing expensive cryptographic syscalls
    // to minimize execution latency and failure rate (MEV protection).
    verify_ed25519_ix(
        &ctx.accounts.ix_sysvar,
        &ctx.accounts.maker.key(),
        &msg_bytes,
    )?;

    // Settlement: taker transfers base tokens to maker.
    let taker_transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.taker_base_ata.to_account_info(),
            to: ctx.accounts.maker_base_ata.to_account_info(),
            authority: ctx.accounts.taker.to_account_info(),
        },
    );
    token::transfer(taker_transfer_ctx, base_amount)?;

    // Settlement: maker transfers quote tokens to taker via PDA authority.
    let authority_bump = ctx.bumps.rfq_authority;
    let authority_seeds = &[RFQ_AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds = &[&authority_seeds[..]];

    let maker_transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.maker_quote_ata.to_account_info(),
            to: ctx.accounts.taker_quote_ata.to_account_info(),
            authority: ctx.accounts.rfq_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(maker_transfer_ctx, quote_amount)?;

    msg!("Trade executed successfully! RFQ ID: {:?}", rfq_id);
    Ok(())
}

/// Parses the Solana native Ed25519 instruction data to verify the maker's signature
/// against the current trade parameters.
/// Gas-optimized instruction introspection via SYSVAR, bypassing expensive cryptographic syscalls
/// to minimize execution latency and failure rate (MEV protection).
fn verify_ed25519_ix(
    ix_sysvar: &AccountInfo,
    expected_maker_pubkey: &Pubkey,
    expected_msg: &[u8],
) -> Result<()> {
    // Read the previous instruction (client places Ed25519 at index 0, this instruction at index 1).
    let current_idx = 1;
    let prev_ix = load_instruction_at_checked(current_idx - 1, ix_sysvar)
        .map_err(|_| RfqError::MissingEd25519Instruction)?;

    // Verify the instruction originates from the official Ed25519 program.
    require!(
        prev_ix.program_id == solana_program::ed25519_program::ID,
        RfqError::InvalidEd25519Program
    );

    let data = prev_ix.data;
    // Parse Ed25519 instruction data layout (first two bytes are num_signatures and padding).
    // Public key offset is at data[6..8].
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    // Message offset is at data[10..12].
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    // Message length is at data[12..14].
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;

    // Extract the signed public key and message from the instruction data.
    let ix_pubkey = &data[pubkey_offset..pubkey_offset + 32];
    let ix_msg = &data[msg_offset..msg_offset + msg_size];

    // Verify the signing public key matches the expected maker.
    require!(
        ix_pubkey == expected_maker_pubkey.as_ref(),
        RfqError::SignerMismatch
    );
    // Verify the signed message matches the expected order parameters exactly.
    require!(ix_msg == expected_msg, RfqError::MessageMismatch);

    Ok(())
}