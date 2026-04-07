use bs58;
use chrono::{Duration, Utc};
use ed25519_dalek::{Signature, SigningKey, Verifier};
use solana_pubkey::Pubkey;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::models::FirmQuote;

/// OKX DEX specification: 40-second maximum quote validity window.
pub const QUOTE_EXPIRY_SECONDS: i64 = 40;

/// Fixed mock price for demonstration (quote tokens per base token).
pub const MOCK_PRICE: f64 = 2.0;

/// Mock Market Maker with Ed25519 signing capability.
/// In production, this would be a separate microservice with HSM-backed keys.
pub struct MockMarketMaker {
    /// Ed25519 signing key for quote signatures.
    /// The corresponding public key is registered as the maker's Solana address.
    signing_key: SigningKey,

    /// Maker's Solana public key (derived from signing_key)
    maker_pubkey: Pubkey,

    /// Unique identifier for this market maker
    maker_id: String,
}

impl MockMarketMaker {
    /// Initialize a new Mock Market Maker.
    ///
    /// Priority order for key initialization:
    /// 1. Environment variable `MAKER_PRIVATE_KEY` (Base58 encoded 64-byte seed)
    /// 2. Randomly generated keypair (for development/testing)
    ///
    /// The environment variable should contain a Base58-encoded 64-byte Ed25519 seed.
    /// This ensures consistency between the backend and test scripts.
    pub fn new() -> Self {
        let signing_key = Self::load_signing_key_from_env().unwrap_or_else(|| {
            warn!("MAKER_PRIVATE_KEY not found in environment, generating random keypair");
            Self::generate_random_keypair()
        });

        let verifying_key_bytes = signing_key.verifying_key().to_bytes();
        let maker_pubkey = Pubkey::new_from_array(verifying_key_bytes);

        info!(
            "Mock Market Maker initialized with pubkey: {}",
            maker_pubkey
        );

        Self {
            signing_key,
            maker_pubkey,
            maker_id: format!("mm_{}", Uuid::new_v4()),
        }
    }

    /// Load signing key from MAKER_PRIVATE_KEY environment variable.
    ///
    /// Expected format: Base58 encoded 64-byte Ed25519 secret key (87-88 characters).
    /// This is the format used by Solana's Keypair.secretKey.
    ///
    /// The 64-byte secret key format from Solana contains:
    /// - First 32 bytes: the actual Ed25519 secret scalar (seed)
    /// - Last 32 bytes: the public key (for verification)
    ///
    /// ed25519-dalek SigningKey::from_bytes expects only the 32-byte secret scalar.
    ///
    /// Returns `None` if the environment variable is not set or invalid.
    fn load_signing_key_from_env() -> Option<SigningKey> {
        let key_b58 = std::env::var("MAKER_PRIVATE_KEY").ok()?;

        if key_b58.is_empty() {
            warn!("MAKER_PRIVATE_KEY environment variable is empty");
            return None;
        }

        // Decode Base58 to get the key bytes
        let key_bytes = bs58::decode(&key_b58)
            .into_vec()
            .map_err(|e| {
                error!("Failed to decode MAKER_PRIVATE_KEY from Base58: {}", e);
                e
            })
            .ok()?;

        // Solana Keypair.secretKey is 64 bytes
        // We need the first 32 bytes which is the actual secret scalar
        if key_bytes.len() < 32 {
            error!(
                "Invalid MAKER_PRIVATE_KEY length: expected at least 32 bytes, got {}",
                key_bytes.len()
            );
            return None;
        }

        // Extract the first 32 bytes as the secret key (secret scalar)
        let secret_scalar: [u8; 32] = key_bytes[0..32]
            .try_into()
            .expect("First 32 bytes should convert to array");

        // Create SigningKey from the 32-byte secret scalar
        let signing_key = SigningKey::from_bytes(&secret_scalar);

        info!("Successfully loaded MAKER_PRIVATE_KEY from environment");
        info!(
            "Maker public key: {:?}",
            signing_key.verifying_key().to_bytes()
        );
        Some(signing_key)
    }

    /// Generate a random Ed25519 keypair using OS random number generator.
    /// Used as fallback when no environment variable is set.
    fn generate_random_keypair() -> SigningKey {
        use rand_core::OsRng;
        SigningKey::generate(&mut OsRng)
    }

    /// Generate a firm quote with cryptographic signature.
    ///
    /// This method implements the OKX DEX specification for RFQ signing:
    /// 1. Generate a UUID v4 RFQ ID (without hyphens, 32 hex characters)
    /// 2. Calculate expiry as current time + 40 seconds (strict OKX spec)
    /// 3. Serialize message as: "{rfqId}|{baseToken}|{quoteToken}|{baseAmount}|{quoteAmount}|{expiry}|{taker}"
    /// 4. Sign the message bytes with the maker's Ed25519 private key
    /// 5. Encode signature as Base58 (Solana standard)
    pub fn generate_firm_quote(
        &self,
        base_token: &str,
        quote_token: &str,
        base_amount: u64,
        taker: &str,
    ) -> FirmQuote {
        // Generate UUID v4 without hyphens (32 hex characters = 16 bytes)
        let rfq_id = Uuid::new_v4().to_string().replace('-', "");

        // Calculate expiry: current time + 40 seconds (OKX DEX specification)
        let expiry = Utc::now()
            .checked_add_signed(Duration::seconds(QUOTE_EXPIRY_SECONDS))
            .unwrap()
            .timestamp();

        // Calculate quote amount based on fixed mock price
        let quote_amount = (base_amount as f64 * MOCK_PRICE) as u64;
        let price_str = MOCK_PRICE.to_string();
        let amount_str = quote_amount.to_string();

        // Build the sign message following OKX DEX specification
        // Format: "{rfqId}|{baseToken}|{quoteToken}|{baseAmount}|{quoteAmount}|{expiry}|{taker}"
        let sign_message = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            rfq_id, base_token, quote_token, base_amount, quote_amount, expiry, taker
        );

        info!(
            "Generating firm quote: rfq_id={}, message={}",
            rfq_id, sign_message
        );

        // Sign the message with the maker's Ed25519 private key
        let signature = self.sign_message(sign_message.as_bytes());

        // Encode signature as Base58 for Solana compatibility
        let signature_b58 = bs58::encode(signature).into_string();

        info!(
            "Firm quote generated: rfq_id={}, signature={}",
            rfq_id, signature_b58
        );

        FirmQuote {
            rfq_id,
            price: price_str,
            amount: amount_str,
            expiry,
            maker: self.maker_pubkey.to_string(),
            signature: signature_b58,
        }
    }

    /// Sign a message bytes using the maker's Ed25519 private key.
    /// Returns the raw 64-byte Ed25519 signature.
    fn sign_message(&self, message: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.signing_key.sign(message).to_bytes()
    }

    /// Verify a signature against a message (for testing/debugging).
    #[allow(dead_code)]
    pub fn verify_signature(
        &self,
        message: &[u8],
        signature: &[u8; 64],
    ) -> Result<(), ed25519_dalek::SignatureError> {
        let sig = Signature::from_bytes(signature);
        self.signing_key.verifying_key().verify(message, &sig)?;
        Ok(())
    }

    /// Get the maker's public key as a string
    pub fn maker_pubkey(&self) -> String {
        self.maker_pubkey.to_string()
    }

    /// Get the maker's ID
    pub fn maker_id(&self) -> &str {
        &self.maker_id
    }

    /// Get the maker's public key bytes (for use in Solana instructions)
    #[allow(dead_code)]
    pub fn maker_pubkey_bytes(&self) -> [u8; 32] {
        self.maker_pubkey.to_bytes()
    }
}

impl Default for MockMarketMaker {
    fn default() -> Self {
        Self::new()
    }
}
