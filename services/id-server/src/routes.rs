//! HTTP routes for the ID server.
//!
//! All the historical quirks are implemented here, documented with the reason each
//! one exists and what a tidy system would have done instead.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use jsonwebtoken::{encode, decode, Header, Algorithm, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

use crate::error::ApiError;
use crate::store::{UserStore, JWT_SECRET};

pub type AppState = Arc<RwLock<UserStore>>;

pub fn build_router(state: AppState) -> Router {
    // Quirk: /register gets a RESTRICTIVE CORS layer that omits Content-Type from
    // allowed headers. The devops team configured CORS once for the initial endpoints
    // and never updated it when /register (which sends JSON) was added.
    let restrictive_cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods(tower_http::cors::Any)
        // Intentionally omit Content-Type — this causes preflight failures for
        // requests that send JSON. The client must work around this.
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::ACCEPT,
        ]);

    let register_router = Router::new()
        .route("/register", post(register))
        .layer(restrictive_cors)
        .with_state(state.clone());

    Router::new()
        .route("/token", post(token))
        .route("/userinfo", get(userinfo))
        .route("/introspect", post(introspect))
        .route("/health", get(health))
        .with_state(state)
        .merge(register_router)
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RegisterRequest {
    username: String,
    email: String,
    password: String,
    display_name: Option<String>,
}

#[derive(Debug, Serialize)]
struct RegisterResponse {
    id: String,
    username: String,
    email: String,
    display_name: Option<String>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct TokenRequest {
    grant_type: String,
    // For password grant:
    username: Option<String>,
    password: Option<String>,
    // For refresh grant:
    refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: i64,
    refresh_token: String,
}

/// JWT claims for refresh tokens. The contractor who added refresh tokens used JWT
/// (unlike the opaque access tokens the original team chose).
#[derive(Debug, Serialize, Deserialize)]
struct RefreshClaims {
    sub: String,
    exp: usize,
    iat: usize,
    token_type: String,
}

#[derive(Debug, Serialize)]
struct UserInfoResponse {
    id: String,
    username: String,
    email: String,
    display_name: Option<String>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct IntrospectRequest {
    token: String,
}

#[derive(Debug, Serialize)]
struct IntrospectResponse {
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exp: Option<i64>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract a Bearer/Token from the Authorization header. Accepts both "Bearer" and
/// "Token" schemes (case-insensitive) because the API server uses "Token" while the
/// standard says "Bearer".
fn extract_access_token(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get("authorization")?.to_str().ok()?;
    let parts: Vec<&str> = auth.splitn(2, ' ').collect();
    if parts.len() == 2 {
        let scheme = parts[0].to_lowercase();
        if scheme == "bearer" || scheme == "token" {
            return Some(parts[1].to_string());
        }
    }
    None
}

/// Create a JWT refresh token.
fn create_refresh_token(user_id: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let now = chrono::Utc::now();
    let claims = RefreshClaims {
        sub: user_id.to_string(),
        #[expect(clippy::cast_sign_loss, clippy::cast_possible_truncation, reason = "timestamp is a recent positive value")]
        iat: now.timestamp() as usize,
        #[expect(clippy::cast_sign_loss, clippy::cast_possible_truncation, reason = "timestamp is a recent positive value")]
        exp: (now + chrono::Duration::days(30)).timestamp() as usize,
        token_type: "refresh".to_string(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(JWT_SECRET),
    )
}

/// Validate a JWT refresh token and return the user ID.
fn validate_refresh_token(token: &str) -> Result<String, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["sub", "exp"]);

    let data = decode::<RefreshClaims>(token, &DecodingKey::from_secret(JWT_SECRET), &validation)
        .map_err(|e| format!("invalid refresh token: {e}"))?;

    if data.claims.token_type != "refresh" {
        return Err("not a refresh token".to_string());
    }

    Ok(data.claims.sub)
}

/// Format a `Retry-After` value as an HTTP-date.
/// Quirk: the rate limiter uses HTTP-date format instead of seconds, because the devops
/// team copied the format from an Apache `mod_ratelimit` example.
fn format_http_date(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// Get remote IP from headers (or a fallback).
fn get_remote_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1")
        .to_string()
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// `POST /register` — create a new user account.
///
/// Quirk: returns `201` with the full user object in the body. The `/login` endpoint
/// (token) only returns tokens, no user info. Register was written first; login was
/// added later by someone who reasoned that the mobile app didn't need the user at
/// login time.
///
/// CORS quirk: this endpoint's preflight is broken because `Content-Type` is missing
/// from `Access-Control-Allow-Headers`. Browsers will block the preflight for JSON
/// requests. The client must work around this (e.g. by using a non-preflight-triggering
/// content type, or by the server operator fixing the CORS config — which, historically,
/// never happened).
async fn register(
    State(store): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Response, ApiError> {
    let mut store = store.write().await;

    let user = store
        .register(
            &body.username,
            &body.email,
            &body.password,
            body.display_name.as_deref(),
        )
        .map_err(|e| ApiError::OAuth {
            status: StatusCode::CONFLICT,
            error: "invalid_request".to_string(),
            description: e.to_string(),
        })?;

    let response = RegisterResponse {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        created_at: user.created_at.to_rfc3339(),
    };

    Ok((StatusCode::CREATED, Json(response)).into_response())
}

/// `POST /token` — OAuth2-style token endpoint.
///
/// Supports `password` and `refresh_token` grant types.
///
/// Quirk: the `token_type` field is `"bearer"` (lowercase) for the password grant and
/// `"Bearer"` (capitalized) for the refresh grant. Two code paths written months apart
/// by different people. Clients must case-insensitive compare or normalize.
///
/// Quirk: the password grant returns only tokens (no user info). The original mobile
/// developer argued that sending the user object was a waste of bandwidth since the app
/// already had it from registration. Clients that need the profile after login must call
/// `/userinfo` separately.
async fn token(
    State(store): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<TokenRequest>,
) -> Result<Response, ApiError> {
    let mut store = store.write().await;

    // Rate limiting on the token endpoint.
    let ip = get_remote_ip(&headers);
    if let Err(retry_after) = store.check_rate_limit(&ip, 10, 60) {
        // Quirk: Retry-After is an HTTP-date, not seconds. The devops team configured
        // this based on an Apache mod_ratelimit example that used dates.
        let retry_header = format_http_date(retry_after);
        return Ok((
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", retry_header)],
            Json(serde_json::json!({
                "error": "rate_limited",
                "error_description": "Too many requests"
            })),
        )
            .into_response());
    }

    match body.grant_type.as_str() {
        "password" => {
            let username = body.username.as_deref().ok_or_else(|| ApiError::OAuth {
                status: StatusCode::BAD_REQUEST,
                error: "invalid_request".to_string(),
                description: "username is required for password grant".to_string(),
            })?;
            let password = body.password.as_deref().ok_or_else(|| ApiError::OAuth {
                status: StatusCode::BAD_REQUEST,
                error: "invalid_request".to_string(),
                description: "password is required for password grant".to_string(),
            })?;

            let user = store.authenticate(username, password).ok_or_else(|| {
                ApiError::OAuth {
                    status: StatusCode::UNAUTHORIZED,
                    error: "invalid_grant".to_string(),
                    description: "invalid username or password".to_string(),
                }
            })?;

            let user_id = user.id.clone();
            let at = store.issue_access_token(&user_id);
            let rt = create_refresh_token(&user_id).map_err(|_| ApiError::OAuth {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                error: "server_error".to_string(),
                description: "failed to create refresh token".to_string(),
            })?;

            let response = TokenResponse {
                access_token: at.token,
                // Quirk: lowercase "bearer" for password grant.
                token_type: "bearer".to_string(),
                expires_in: 3600,
                refresh_token: rt,
            };

            Ok((StatusCode::OK, Json(response)).into_response())
        }

        "refresh_token" => {
            let refresh = body
                .refresh_token
                .as_deref()
                .ok_or_else(|| ApiError::OAuth {
                    status: StatusCode::BAD_REQUEST,
                    error: "invalid_request".to_string(),
                    description: "refresh_token is required for refresh_token grant".to_string(),
                })?;

            let user_id = validate_refresh_token(refresh).map_err(|e| ApiError::OAuth {
                status: StatusCode::UNAUTHORIZED,
                error: "invalid_grant".to_string(),
                description: e,
            })?;

            // Verify the user still exists.
            if store.get_user(&user_id).is_none() {
                return Err(ApiError::OAuth {
                    status: StatusCode::UNAUTHORIZED,
                    error: "invalid_grant".to_string(),
                    description: "user no longer exists".to_string(),
                });
            }

            let at = store.issue_access_token(&user_id);
            let rt = create_refresh_token(&user_id).map_err(|_| ApiError::OAuth {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                error: "server_error".to_string(),
                description: "failed to create refresh token".to_string(),
            })?;

            let response = TokenResponse {
                access_token: at.token,
                // Quirk: capitalized "Bearer" for refresh grant. Different code path,
                // written by a different person months later.
                token_type: "Bearer".to_string(),
                expires_in: 3600,
                refresh_token: rt,
            };

            Ok((StatusCode::OK, Json(response)).into_response())
        }

        _ => Err(ApiError::OAuth {
            status: StatusCode::BAD_REQUEST,
            error: "unsupported_grant_type".to_string(),
            description: format!("grant type '{}' is not supported", body.grant_type),
        }),
    }
}

/// `GET /userinfo` — return the authenticated user's profile.
///
/// Quirk: error responses use `{"message": "..."}` instead of the OAuth2-spec
/// `{"error": "...", "error_description": "..."}` format used by all other endpoints.
/// The developer who added this endpoint came from a different team and used the error
/// format they were familiar with.
async fn userinfo(
    State(store): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token = extract_access_token(&headers).ok_or_else(|| {
        // Quirk: uses SimpleError format, not OAuthError.
        ApiError::Simple {
            status: StatusCode::UNAUTHORIZED,
            message: "Authorization header is required".to_string(),
        }
    })?;

    let store = store.read().await;

    let at = store.validate_access_token(&token).ok_or_else(|| {
        ApiError::Simple {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid or expired access token".to_string(),
        }
    })?;

    let user = store.get_user(&at.user_id).ok_or_else(|| {
        ApiError::Simple {
            status: StatusCode::NOT_FOUND,
            message: "User not found".to_string(),
        }
    })?;

    let response = UserInfoResponse {
        id: user.id.clone(),
        username: user.username.clone(),
        email: user.email.clone(),
        display_name: user.display_name.clone(),
        created_at: user.created_at.to_rfc3339(),
    };

    Ok(Json(response).into_response())
}

/// `POST /introspect` — server-to-server token introspection (RFC 7662-ish).
///
/// Used by the API server and File server to validate access tokens without needing
/// the signing key. Returns `{"active": true/false}` with optional metadata.
async fn introspect(
    State(store): State<AppState>,
    Json(body): Json<IntrospectRequest>,
) -> Response {
    let store = store.read().await;

    match store.validate_access_token(&body.token) {
        Some(at) => {
            let user = store.get_user(&at.user_id);
            Json(IntrospectResponse {
                active: true,
                sub: Some(at.user_id.clone()),
                username: user.map(|u| u.username.clone()),
                exp: Some(at.expires_at.timestamp()),
            })
            .into_response()
        }
        None => Json(IntrospectResponse {
            active: false,
            sub: None,
            username: None,
            exp: None,
        })
        .into_response(),
    }
}

/// `GET /health` — simple health check.
async fn health() -> &'static str {
    "ok"
}
