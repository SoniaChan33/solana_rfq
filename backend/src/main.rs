pub mod api;
pub mod error;
pub mod maker;
pub mod models;

use tracing::{info, Level};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    // Initialize structured logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive(Level::INFO.into()),
        )
        .init();

    // Load environment configuration
    if dotenvy::dotenv().is_err() {
        dotenvy::from_path("../.env").ok();
    }

    let port = std::env::var("AGGREGATOR_PORT").unwrap_or_else(|_| "8080".to_string());

    // Initialize application state with Mock Market Maker
    let state = api::AppState::new();

    info!("Solana RFQ Aggregator Service initializing...");
    info!(
        "Mock Market Maker pubkey: {}",
        state.market_maker.read().await.maker_pubkey()
    );

    // Bind and start the HTTP server
    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", port)
        .parse()
        .expect("Invalid AGGREGATOR_PORT configuration");

    info!("Starting Solana RFQ Aggregator on {}", addr);
    info!("API Endpoints:");
    info!("  GET  /health      - Health check");
    info!("  GET  /maker-info  - Market maker information");
    info!("  POST /rfq         - Request indicative quote");
    info!("  GET  /rfq         - List active RFQs");
    info!("  GET  /rfq/{{id}}   - Get RFQ by ID");
    info!("  POST /firm-quote  - Request firm quote with signature");
    info!("");
    info!("Swagger UI: http://{}/swagger-ui", addr);
    info!("OpenAPI JSON: http://{}/api-docs/openapi.json", addr);

    api::start_server(addr, state).await.unwrap();
}
