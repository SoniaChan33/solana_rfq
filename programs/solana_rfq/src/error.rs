use anchor_lang::prelude::*;

#[error_code]
pub enum RfqError {
    #[msg("The quote has expired.")]
    QuoteExpired,
    #[msg("Missing Ed25519 signature instruction.")]
    MissingEd25519Instruction,
    #[msg("Invalid Ed25519 instruction program ID.")]
    InvalidEd25519Program,
    #[msg("Maker public key does not match the signature.")]
    SignerMismatch,
    #[msg("Signed message does not match the provided quote data.")]
    MessageMismatch,
    #[msg("Insufficient delegation")]
    InsufficientDelegation,
}
