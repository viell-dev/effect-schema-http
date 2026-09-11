//! Error types for the ID server.
//!
//! Quirk: auth endpoints use OAuth2-spec error format (`error` + `error_description`),
//! but the user-info endpoint uses a different format (`message`). The user-info
//! endpoint was added later by a different developer who didn't read the OAuth2 error
//! spec — they just used the format they were familiar with from other services.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// OAuth2-spec error response for auth endpoints.
#[derive(Debug, Serialize)]
pub struct OAuthError {
    pub error: String,
    pub error_description: String,
}

/// Simple error response for non-auth endpoints (user-info, etc.).
/// Quirk: different developer, different format.
#[derive(Debug, Serialize)]
pub struct SimpleError {
    pub message: String,
}

/// Unified error type that picks the right format based on context.
pub enum ApiError {
    /// OAuth2-style error (for /token, /register, /introspect).
    OAuth {
        status: StatusCode,
        error: String,
        description: String,
    },
    /// Simple message error (for /userinfo and other non-OAuth endpoints).
    Simple {
        status: StatusCode,
        message: String,
    },
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::OAuth {
                status,
                error,
                description,
            } => {
                let body = serde_json::to_string(&OAuthError {
                    error,
                    error_description: description,
                })
                .expect("serialize error");
                (
                    status,
                    [("content-type", "application/json")],
                    body,
                )
                    .into_response()
            }
            Self::Simple { status, message } => {
                let body =
                    serde_json::to_string(&SimpleError { message }).expect("serialize error");
                (
                    status,
                    [("content-type", "application/json")],
                    body,
                )
                    .into_response()
            }
        }
    }
}
