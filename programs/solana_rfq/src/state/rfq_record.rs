use anchor_lang::prelude::*;

#[account]
pub struct RfqRecord {
    pub executed: bool,
    pub maker: Pubkey,
    pub taker: Pubkey,
}

impl RfqRecord {
    pub const LEN: usize = 8 + 1 + 32 + 32;
}