use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// RFQ request payload from taker.
/// Matches the exact structure required by the interview specification.
#[derive(Debug, Deserialize, Clone, ToSchema)]
pub struct RfqRequest {
    /// Base token mint address (e.g., tokenized stock like Ondo equities)
    #[serde(rename = "baseToken")]
    pub base_token: String,

    /// Quote token mint address (e.g., USDC, USDT)
    #[serde(rename = "quoteToken")]
    pub quote_token: String,

    /// Trade side: "buy" or "sell"
    pub side: String,

    /// Amount of base tokens to trade (as string for precision)
    pub amount: String,

    /// Taker's Solana public key (base58 encoded)
    pub taker: String,
}

/// Indicative quote response - preliminary price without commitment.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct IndicativeQuote {
    /// Unique RFQ identifier for tracking
    #[serde(rename = "rfqId")]
    pub rfq_id: String,

    /// Base token mint address
    #[serde(rename = "baseToken")]
    pub base_token: String,

    /// Quote token mint address
    #[serde(rename = "quoteToken")]
    pub quote_token: String,

    /// Trade side
    pub side: String,

    /// Amount of base tokens
    pub amount: String,

    /// Indicative price (quote per base)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<String>,

    /// Market maker identifier
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mm_id: Option<String>,

    /// Taker's public key
    pub taker: String,
}

/// Firm quote with cryptographic commitment from market maker.
/// This structure is used to build the on-chain settlement transaction.
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct FirmQuote {
    /// Unique RFQ identifier (UUID v4 without hyphens, 32 hex chars)
    #[serde(rename = "rfqId")]
    pub rfq_id: String,

    /// Executable price (quote per base)
    pub price: String,

    /// Quote amount (base amount * price)
    pub amount: String,

    /// Unix timestamp when this quote expires
    pub expiry: i64,

    /// Market maker's Solana public key (signer of this quote)
    pub maker: String,

    /// Ed25519 signature in Base58 encoding (Solana compatible)
    pub signature: String,
}

/// Health check response
#[derive(Debug, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
    pub timestamp: String,
    pub makers_active: usize,
}
