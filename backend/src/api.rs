use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use solana_pubkey::Pubkey;
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;
use tracing::info;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

use crate::error::AggregatorError;
use crate::maker::{MockMarketMaker, MOCK_PRICE, QUOTE_EXPIRY_SECONDS};
use crate::models::{FirmQuote, HealthResponse, IndicativeQuote, RfqRequest};
use chrono::Utc;
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
};

/// Validates a Solana public key string (base58 encoded, 32 bytes).
pub fn validate_pubkey(s: &str) -> Result<Pubkey, String> {
    let bytes = bs58::decode(s)
        .into_vec()
        .map_err(|_| "Invalid base58 encoding")?;
    if bytes.len() != 32 {
        return Err(format!(
            "Invalid pubkey length: expected 32 bytes, got {}",
            bytes.len()
        ));
    }
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Failed to convert to 32-byte array")?;
    Ok(Pubkey::new_from_array(array))
}

/// Shared application state managed by Axum.
#[derive(Clone)]
pub struct AppState {
    /// The mock market maker instance for quote generation
    pub market_maker: Arc<RwLock<MockMarketMaker>>,

    /// Track active RFQs for state management
    pub active_rfqs: Arc<RwLock<HashMap<String, FirmQuote>>>,
}

impl AppState {
    /// Create a new application state with initialized market maker
    pub fn new() -> Self {
        Self {
            market_maker: Arc::new(RwLock::new(MockMarketMaker::new())),
            active_rfqs: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// GET /health - Health check endpoint
#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 200, description = "Service is healthy", body = HealthResponse)
    )
)]
pub async fn health_check(State(_state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        timestamp: Utc::now().to_rfc3339(),
        makers_active: 1,
    })
}

/// GET /maker-info - Returns information about the mock market maker
#[utoipa::path(
    get,
    path = "/maker-info",
    responses(
        (status = 200, description = "Maker information retrieved", body = inline(serde_json::Value))
    )
)]
pub async fn maker_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mm = state.market_maker.read().await;
    Json(json!({
        "maker_id": mm.maker_id(),
        "maker_pubkey": mm.maker_pubkey(),
        "quote_expiry_seconds": QUOTE_EXPIRY_SECONDS,
        "mock_price": MOCK_PRICE,
    }))
}

/// POST /rfq - Request for Quote (Indicative)
#[utoipa::path(
    post,
    path = "/rfq",
    request_body = RfqRequest,
    responses(
        (status = 200, description = "Indicative quote returned", body = IndicativeQuote),
        (status = 400, description = "Invalid request parameters", body = inline(serde_json::Value)),
        (status = 503, description = "No makers available")
    )
)]
pub async fn request_rfq(
    State(state): State<AppState>,
    Json(payload): Json<RfqRequest>,
) -> Result<Json<IndicativeQuote>, AggregatorError> {
    info!(
        "RFQ request received: base_token={}, quote_token={}, side={}, amount={}, taker={}",
        payload.base_token, payload.quote_token, payload.side, payload.amount, payload.taker
    );

    validate_pubkey(&payload.taker).map_err(|_| {
        AggregatorError::InvalidRequest("Invalid taker public key (must be valid Solana base58)".to_string())
    })?;

    validate_pubkey(&payload.base_token).map_err(|_| {
        AggregatorError::InvalidRequest("Invalid base token mint address".to_string())
    })?;

    validate_pubkey(&payload.quote_token).map_err(|_| {
        AggregatorError::InvalidRequest("Invalid quote token mint address".to_string())
    })?;

    let base_amount: u64 = payload.amount.parse().map_err(|_| {
        AggregatorError::InvalidRequest("Invalid amount (must be positive integer)".to_string())
    })?;

    if base_amount == 0 {
        return Err(AggregatorError::InvalidRequest(
            "Amount must be greater than zero".to_string(),
        ));
    }

    let rfq_id = Uuid::new_v4().to_string().replace('-', "");
    let indicative_price = MOCK_PRICE.to_string();
    let mm = state.market_maker.read().await;

    info!(
        "Indicative quote generated: rfq_id={}, price={}, mm_id={}",
        rfq_id, indicative_price, mm.maker_id()
    );

    Ok(Json(IndicativeQuote {
        rfq_id,
        base_token: payload.base_token,
        quote_token: payload.quote_token,
        side: payload.side,
        amount: payload.amount,
        price: Some(indicative_price),
        mm_id: Some(mm.maker_id().to_string()),
        taker: payload.taker,
    }))
}

/// POST /firm-quote - Request Firm Quote with Cryptographic Signature
#[utoipa::path(
    post,
    path = "/firm-quote",
    request_body = RfqRequest,
    responses(
        (status = 200, description = "Firm quote with signature returned", body = FirmQuote),
        (status = 400, description = "Invalid request parameters", body = inline(serde_json::Value)),
        (status = 410, description = "Quote expired")
    )
)]
pub async fn firm_quote(
    State(state): State<AppState>,
    Json(payload): Json<RfqRequest>,
) -> Result<Json<FirmQuote>, AggregatorError> {
    info!(
        "Firm quote request received: base_token={}, quote_token={}, amount={}, taker={}",
        payload.base_token, payload.quote_token, payload.amount, payload.taker
    );

    validate_pubkey(&payload.taker)
        .map_err(|_| AggregatorError::InvalidRequest("Invalid taker public key".to_string()))?;

    validate_pubkey(&payload.base_token).map_err(|_| {
        AggregatorError::InvalidRequest("Invalid base token mint address".to_string())
    })?;

    validate_pubkey(&payload.quote_token).map_err(|_| {
        AggregatorError::InvalidRequest("Invalid quote token mint address".to_string())
    })?;

    let base_amount: u64 = payload
        .amount
        .parse()
        .map_err(|_| AggregatorError::InvalidRequest("Invalid amount".to_string()))?;

    if base_amount == 0 {
        return Err(AggregatorError::InvalidRequest(
            "Amount must be greater than zero".to_string(),
        ));
    }

    let firm_quote = {
        let mm = state.market_maker.read().await;
        mm.generate_firm_quote(
            &payload.base_token,
            &payload.quote_token,
            base_amount,
            &payload.taker,
        )
    };

    {
        let mut rfqs = state.active_rfqs.write().await;
        rfqs.insert(firm_quote.rfq_id.clone(), firm_quote.clone());
    }

    info!(
        "Firm quote issued: rfq_id={}, maker={}, expiry={}",
        firm_quote.rfq_id, firm_quote.maker, firm_quote.expiry
    );

    Ok(Json(firm_quote))
}

/// GET /rfq/{id} - Retrieve an active RFQ by ID
#[utoipa::path(
    get,
    path = "/rfq/{id}",
    params(
        ("id" = String, Path, description = "RFQ identifier")
    ),
    responses(
        (status = 200, description = "RFQ found", body = FirmQuote),
        (status = 404, description = "RFQ not found")
    )
)]
pub async fn get_rfq(
    State(state): State<AppState>,
    axum::extract::Path(rfq_id): axum::extract::Path<String>,
) -> Result<Json<FirmQuote>, AggregatorError> {
    let rfqs = state.active_rfqs.read().await;
    rfqs.get(&rfq_id)
        .cloned()
        .map(Json)
        .ok_or_else(|| AggregatorError::InvalidRequest("RFQ not found".to_string()))
}

/// GET /rfq - List all active RFQs
#[utoipa::path(
    get,
    path = "/rfq",
    responses(
        (status = 200, description = "List of active RFQs", body = inline(serde_json::Value))
    )
)]
pub async fn list_rfqs(State(state): State<AppState>) -> Json<serde_json::Value> {
    let rfqs = state.active_rfqs.read().await;
    let active_quotes: Vec<&FirmQuote> = rfqs.values().collect();
    Json(json!({
        "count": active_quotes.len(),
        "rfqs": active_quotes,
    }))
}

/// OpenAPI schema definition for Swagger UI
#[derive(OpenApi)]
#[openapi(
    paths(
        health_check,
        maker_info,
        request_rfq,
        firm_quote,
        get_rfq,
        list_rfqs
    ),
    components(
        schemas(RfqRequest, IndicativeQuote, FirmQuote, HealthResponse)
    ),
    tags(
        (name = "Solana RFQ Aggregator", description = "Off-chain Request-for-Quote matching engine for high-value RWA and stablecoin trading on Solana")
    ),
    info(
        title = "Solana RFQ Aggregator API",
        version = "0.1.0",
        description = r#"
# Solana RFQ Aggregator Service

Production-grade RFQ aggregation engine for high-value RWA and stablecoin trading.

## Key Features
- **Zero-Slippage Settlement**: Lock prices off-chain before on-chain execution
- **OKX DEX Compatible**: Follows OKX DEX specification (40s expiry, Base58 signatures)
- **Ed25519 Signed Quotes**: Cryptographic commitment from market makers
- **Atomic Settlement**: Two-leg token transfers in a single transaction

## Authentication
Currently no authentication required. In production, API keys or JWT tokens would be used.
"#
    )
)]
pub struct ApiDoc;

/// Build the Axum router with all API endpoints and Swagger UI
pub fn create_router(state: AppState) -> Router {
    Router::new()
        .merge(
            SwaggerUi::new("/swagger-ui")
                .url("/api-docs/openapi.json", ApiDoc::openapi())
        )
        .route("/health", get(health_check))
        .route("/maker-info", get(maker_info))
        .route("/rfq", post(request_rfq))
        .route("/rfq", get(list_rfqs))
        .route("/rfq/{id}", get(get_rfq))
        .route("/firm-quote", post(firm_quote))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Start the HTTP server
pub async fn start_server(addr: SocketAddr, state: AppState) -> std::io::Result<()> {
    let app = create_router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await
}