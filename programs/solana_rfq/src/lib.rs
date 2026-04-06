pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use instructions::*;

declare_id!("G29y9AUmrm3CwSifUbPMbUWmqLBKhjUcTCekYLtnegxG");

#[program]
pub mod solana_rfq {
    use super::*;

    pub fn execute_trade(
        ctx: Context<ExecuteTrade>,
        rfq_id: [u8; 16],
        base_amount: u64,
        quote_amount: u64,
        expiry: i64,
        msg_bytes: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_trade::handler(
            ctx,
            rfq_id,
            base_amount,
            quote_amount,
            expiry,
            msg_bytes,
        )
    }
}
