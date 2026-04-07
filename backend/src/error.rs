use axum::{http::StatusCode, response::IntoResponse, Json};
use serde_json::json;
use thiserror::Error;

/// Aggregator service error types with HTTP status code mapping.
#[derive(Error, Debug)]
pub enum AggregatorError {
    #[error("Invalid request parameters: {0}")]
    InvalidRequest(String),

    #[error("No makers available for the requested token pair")]
    NoMakersAvailable,

    #[error("Quote has expired - please request a new quote")]
    QuoteExpired,

    #[error("Invalid cryptographic signature")]
    InvalidSignature,

    #[error("Maker communication failed: {0}")]
    MakerError(String),

    #[error("Internal server error: {0}")]
    Internal(String),
}

impl IntoResponse for AggregatorError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            AggregatorError::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            AggregatorError::NoMakersAvailable => StatusCode::SERVICE_UNAVAILABLE,
            AggregatorError::QuoteExpired => StatusCode::GONE,
            AggregatorError::InvalidSignature => StatusCode::UNAUTHORIZED,
            AggregatorError::MakerError(_) => StatusCode::BAD_GATEWAY,
            AggregatorError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({"error": self.to_string()}))).into_response()
    }
}
