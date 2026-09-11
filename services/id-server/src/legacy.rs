#![allow(clippy::doc_markdown)] // OAuth2, LDAP and JWKS appear in prose, not as identifiers.
//! Endpoints that accreted onto the ID server after the original 2019 build.
//!
//! Each one was added by a different person for a different reason, and none of them
//! agreed with the conventions already in `routes.rs`. They are collected here because
//! that is roughly how they exist in the real service: a second file nobody wanted to
//! merge into the first.

use std::collections::HashMap;

use axum::body::Body;
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::error::ApiError;
use crate::routes::AppState;

/// Seconds the emulated reverse proxy keeps `/jwks.json` before re-reading the origin.
const JWKS_CACHE_TTL_SECONDS: i64 = 10;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn bearer(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get("authorization")?.to_str().ok()?;
    let (scheme, value) = auth.split_once(' ')?;
    let scheme = scheme.to_lowercase();
    (scheme == "bearer" || scheme == "token").then(|| value.to_string())
}

fn http_date(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// LDAP generalized time, which is what the directory gateway in front of the legacy
/// user lookup emitted and what its consumers learned to parse.
fn ldap_generalized_time(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%Y%m%d%H%M%SZ").to_string()
}

// ---------------------------------------------------------------------------
// POST /oauth/token — the RFC 6749-correct form-encoded grant
// ---------------------------------------------------------------------------

/// `POST /oauth/token` — the *original* token endpoint, form-encoded as RFC 6749
/// actually requires.
///
/// The JSON `/token` endpoint came later, when a frontend developer complained that
/// building a form body was annoying. Nobody retired this one because the ERP
/// integration and two mobile builds still post to it.
///
/// Quirk: every value in the response is a string, including `expires_in`. The struct
/// behind this handler was written with `HashMap<String, String>` fields because the
/// author was already parsing a form and did not want to think about types twice.
///
/// Quirk: `token_type` is `"BEARER"` here — a third spelling, from a third code path.
pub async fn form_token(
    State(store): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Quirk: this endpoint predates content negotiation of any kind. It answers 415 to
    // anything that is not form-encoded, including the JSON its own sibling accepts.
    if !content_type.starts_with("application/x-www-form-urlencoded") {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            [("content-type", "application/json")],
            r#"{"error":"invalid_request","error_description":"POST a urlencoded form"}"#,
        )
            .into_response();
    }

    let form: HashMap<String, String> = body
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            Some((form_decode(key), form_decode(value)))
        })
        .collect();

    let grant = form.get("grant_type").map(String::as_str).unwrap_or("");
    if grant != "password" {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            r#"{"error":"unsupported_grant_type","error_description":"this endpoint only does password"}"#,
        )
            .into_response();
    }

    let username = form.get("username").map(String::as_str).unwrap_or("");
    let password = form.get("password").map(String::as_str).unwrap_or("");

    let mut store = store.write().await;
    let Some(user) = store.authenticate(username, password) else {
        return (
            StatusCode::UNAUTHORIZED,
            [("content-type", "application/json")],
            r#"{"error":"invalid_grant","error_description":"invalid username or password"}"#,
        )
            .into_response();
    };

    let user_id = user.id.clone();
    let access = store.issue_access_token(&user_id);

    // Quirk: scope is a space-delimited string, per the spec, while everything written
    // after 2019 in this service uses JSON arrays.
    let payload = serde_json::json!({
        "access_token": access.token,
        "token_type": "BEARER",
        "expires_in": "3600",
        "scope": "openid profile projects:read projects:write",
    });

    (StatusCode::OK, [("content-type", "application/json")], payload.to_string()).into_response()
}

fn form_decode(raw: &str) -> String {
    let replaced = raw.replace('+', " ");
    let bytes = replaced.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// POST /revoke — RFC 7009
// ---------------------------------------------------------------------------

/// `POST /revoke` — revoke an access token.
///
/// RFC 7009 says the response is `200` with no content. This implementation obeys that
/// to the letter: `200`, a `Content-Type: application/json` header inherited from the
/// shared response builder, and a body of exactly zero bytes. A JSON client that trusts
/// the content type and calls `response.json()` throws on the empty payload.
pub async fn revoke(State(store): State<AppState>, body: String) -> Response {
    let token = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("token").and_then(|t| t.as_str()).map(String::from));

    if let Some(token) = token {
        store.write().await.revoke_token(&token);
    }

    // Quirk: 200 + a content type + an empty body. Deliberate, and spec-compliant.
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("content-length", "0")
        .body(Body::empty())
        .expect("static response")
}

// ---------------------------------------------------------------------------
// HEAD /userinfo/probe — facts in headers only
// ---------------------------------------------------------------------------

/// `HEAD /userinfo/probe` — a token validity probe used by the mobile app's splash
/// screen, which needs to know whether to show the login form before it has anything
/// to render.
///
/// Everything it reports lives in response headers, because HEAD responses have no body
/// and the developer refused to add a GET variant "that returns the same thing twice".
/// Scopes are emitted as repeated `X-Token-Scope` header field lines.
pub async fn userinfo_probe(State(store): State<AppState>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let store = store.read().await;
    let Some(access) = store.validate_access_token(&token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let seconds = (access.expires_at - chrono::Utc::now()).num_seconds().max(0);
    let username = store
        .get_user(&access.user_id)
        .map_or_else(|| "unknown".to_string(), |user| user.username.clone());

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("x-token-subject", access.user_id.clone())
        .header("x-token-username", username)
        .header("x-token-expires-in", seconds.to_string())
        .header("x-token-expires-at", http_date(access.expires_at));

    // Quirk: repeated header field lines rather than one comma-joined value, because
    // the 2019 code wrote them in a loop.
    for scope in ["openid", "profile", "projects:read", "projects:write"] {
        builder = builder.header("x-token-scope", scope);
    }

    builder.body(Body::empty()).expect("static response")
}

// ---------------------------------------------------------------------------
// GET /jwks.json — behind a cache that ignores request directives
// ---------------------------------------------------------------------------

/// `GET /jwks.json` — the signing key set, served through the same emulated reverse
/// proxy the production deployment puts in front of it.
///
/// The proxy caches for ten seconds and ignores `Cache-Control` on the *request*,
/// because the configuration predates anyone thinking about client-driven revalidation.
/// The only way past it is a parameter the cache key includes, which is why every
/// internal runbook says "add `?_cb=<timestamp>`".
pub async fn jwks(State(store): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let has_cache_buster = query
        .as_deref()
        .is_some_and(|raw| raw.split('&').any(|pair| pair.starts_with("_cb=")));

    let body = serde_json::json!({
        "keys": [{
            "kty": "oct",
            "kid": "refresh-2020",
            "alg": "HS256",
            "use": "sig",
        }],
    })
    .to_string();

    let now = chrono::Utc::now();
    let mut store = store.write().await;

    if !has_cache_buster {
        if let Some((stored_at, cached)) = store.jwks_cache.clone() {
            let age = (now - stored_at).num_seconds();
            if age <= JWKS_CACHE_TTL_SECONDS {
                return (
                    StatusCode::OK,
                    [
                        ("content-type", "application/json".to_string()),
                        ("x-cache", "HIT".to_string()),
                        ("age", age.to_string()),
                        ("cache-control", format!("public, max-age={JWKS_CACHE_TTL_SECONDS}")),
                    ],
                    cached,
                )
                    .into_response();
            }
        }
        store.jwks_cache = Some((now, body.clone()));
    }

    (
        StatusCode::OK,
        [
            ("content-type", "application/json".to_string()),
            ("x-cache", if has_cache_buster { "BYPASS".to_string() } else { "MISS".to_string() }),
            ("age", "0".to_string()),
            ("cache-control", format!("public, max-age={JWKS_CACHE_TTL_SECONDS}")),
        ],
        body,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /directory/:username — the LDAP gateway's shape
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct DirectoryEntry {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "USERNAME")]
    username: String,
    #[serde(rename = "EMAIL")]
    email: String,
    #[serde(rename = "DISPLAYNAME")]
    display_name: String,
    #[serde(rename = "CREATEDTIMESTAMP")]
    created: String,
    #[serde(rename = "ACTIVE")]
    active: String,
}

/// `GET /directory/:username?access_token=…` — user lookup through the directory
/// gateway.
///
/// Quirk: authentication is a query parameter. This is how the 2012 mobile client did
/// it, following a draft of OAuth 2.0 that allowed it, and the endpoint was never
/// migrated because the client shipped on hardware that is still in the field.
///
/// Quirk: field names are upper case with no separators and `ACTIVE` is `"Y"`/`"N"`,
/// because the gateway maps LDAP attributes straight through. `CREATEDTIMESTAMP` is
/// LDAP generalized time, not ISO 8601.
///
/// Quirk: a missing user is `200` with `ACTIVE: "N"` and blank fields, because the
/// operations team asked for "no 404s in the access log, they page us".
pub async fn directory_entry(
    State(store): State<AppState>,
    Path(username): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(token) = params.get("access_token") else {
        return ApiError::Simple {
            status: StatusCode::UNAUTHORIZED,
            message: "access_token query parameter is required".to_string(),
        }
        .into_response();
    };

    let store = store.read().await;
    if store.validate_access_token(token).is_none() {
        return ApiError::Simple {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid or expired access token".to_string(),
        }
        .into_response();
    }

    let found = store
        .users_by_username
        .get(&username)
        .and_then(|id| store.get_user(id));

    let entry = found.map_or_else(
        || DirectoryEntry {
            id: String::new(),
            username: username.clone(),
            email: String::new(),
            display_name: String::new(),
            created: String::new(),
            active: "N".to_string(),
        },
        |user| DirectoryEntry {
            id: user.id.clone(),
            username: user.username.clone(),
            email: user.email.clone(),
            display_name: user.display_name.clone().unwrap_or_default(),
            created: ldap_generalized_time(user.created_at),
            active: "Y".to_string(),
        },
    );

    (StatusCode::OK, axum::Json(entry)).into_response()
}

// ---------------------------------------------------------------------------
// POST /session/echo — nonce replay protection on a flaky endpoint
// ---------------------------------------------------------------------------

/// `POST /session/echo` — the request-correlation endpoint the payments integration
/// uses to prove a request was not replayed.
///
/// Quirk: `X-Nonce` must strictly increase per token. A repeated value is `409`,
/// because that is what replay protection means.
///
/// Quirk: the first two calls for a token answer `503` with a `Retry-After` *date*,
/// because the backing service is a cold-start Lambda and the platform team put the
/// rate limiter's date formatter in the retry path too.
///
/// Together these two make the endpoint impossible to drive with a retry policy that
/// replays an already-encoded request: the retry succeeds on the transport and then
/// fails on the nonce.
pub async fn session_echo(
    State(store): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return ApiError::Simple {
            status: StatusCode::UNAUTHORIZED,
            message: "Authorization header is required".to_string(),
        }
        .into_response();
    };

    let nonce = headers
        .get("x-nonce")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    let Some(nonce) = nonce else {
        return ApiError::Simple {
            status: StatusCode::BAD_REQUEST,
            message: "X-Nonce must be a positive integer".to_string(),
        }
        .into_response();
    };

    let mut store = store.write().await;

    if store.validate_access_token(&token).is_none() {
        return ApiError::Simple {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid or expired access token".to_string(),
        }
        .into_response();
    }

    // The replay check runs *before* the warm-up check, because in production it lives
    // in the API gateway and the warm-up failure comes from the service behind it. That
    // ordering is what makes this endpoint impossible to drive with a replayed retry:
    // the nonce is spent by the attempt that failed with a 503.
    if let Err(previous) = store.accept_nonce(&token, nonce) {
        return (
            StatusCode::CONFLICT,
            [("content-type", "application/json")],
            serde_json::json!({
                "message": format!("nonce {nonce} was already used (highest seen: {previous})"),
            })
            .to_string(),
        )
            .into_response();
    }

    let attempt = store.next_echo_attempt(&token);
    if attempt <= 2 {
        let retry_at = chrono::Utc::now() + chrono::Duration::seconds(1);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [
                ("retry-after", http_date(retry_at)),
                ("content-type", "application/json".to_string()),
                ("x-attempt", attempt.to_string()),
            ],
            serde_json::json!({
                "message": format!("warming up, attempt {attempt} of 3"),
            })
            .to_string(),
        )
            .into_response();
    }

    let echoed = serde_json::from_str::<serde_json::Value>(&body)
        .unwrap_or_else(|_| serde_json::json!({ "raw": body }));

    (
        StatusCode::OK,
        [
            ("content-type", "application/json".to_string()),
            ("x-attempt", attempt.to_string()),
        ],
        serde_json::json!({
            "nonce": nonce,
            "attempt": attempt,
            "echo": echoed,
        })
        .to_string(),
    )
        .into_response()
}

/// `POST /session/echo/reset` — clears the flaky counter so the demo can be run twice.
pub async fn session_echo_reset(State(store): State<AppState>, headers: HeaderMap) -> Response {
    let Some(token) = bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    store.write().await.reset_echo_attempts(&token);
    StatusCode::NO_CONTENT.into_response()
}

// ---------------------------------------------------------------------------
// POST /token/scoped — repeated request header field lines
// ---------------------------------------------------------------------------

/// `POST /token/scoped` — narrow an access token to a subset of its scopes.
///
/// Quirk: the scopes are read with `get_all("x-scope")`, one scope per header field
/// line. A single comma-joined `X-Scope: a, b` is rejected, because the 2019 parser
/// never split on commas and the downstream authorization service treats a comma as
/// part of a scope name.
///
/// This is exactly the case the library documents as provider-dependent: plans retain
/// repeated header entries, but the Fetch provider may join them before they reach the
/// wire.
pub async fn scoped_token(
    State(store): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(token) = bearer(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let lines: Vec<String> = headers
        .get_all("x-scope")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .map(String::from)
        .collect();

    if lines.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json")],
            r#"{"error":"invalid_scope","error_description":"at least one X-Scope header line is required"}"#,
        )
            .into_response();
    }

    if let Some(joined) = lines.iter().find(|line| line.contains(',')) {
        return (
            StatusCode::BAD_REQUEST,
            [("content-type", "application/json".to_string())],
            serde_json::json!({
                "error": "invalid_scope",
                "error_description":
                    format!("one scope per X-Scope header line; received the joined value {joined:?}"),
                "received_lines": lines.len(),
            })
            .to_string(),
        )
            .into_response();
    }

    let mut store = store.write().await;
    let Some(access) = store.validate_access_token(&token).cloned() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let issued = store.issue_access_token(&access.user_id);

    (
        StatusCode::OK,
        [("content-type", "application/json".to_string())],
        serde_json::json!({
            "access_token": issued.token,
            "token_type": "bearer",
            "expires_in": 3600,
            "scope": lines.join(" "),
            "scope_lines": lines,
        })
        .to_string(),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /.well-known/openid-configuration
// ---------------------------------------------------------------------------

/// `GET /.well-known/openid-configuration` — the discovery document.
///
/// Quirk: `grant_types_supported` is a space-delimited string rather than the array the
/// specification requires. It was hand-written in 2019 by copying the `scope` field
/// two lines above it, and the only consumer that ever complained was told to split it.
///
/// Quirk: `issuer` carries a trailing slash the service's own URLs do not, so naive
/// string concatenation against it produces a double slash.
pub async fn discovery() -> Response {
    let document = serde_json::json!({
        "issuer": "http://localhost:4100/",
        "token_endpoint": "http://localhost:4100/token",
        "userinfo_endpoint": "http://localhost:4100/userinfo",
        "revocation_endpoint": "http://localhost:4100/revoke",
        "introspection_endpoint": "http://localhost:4100/introspect",
        "jwks_uri": "http://localhost:4100/jwks.json",
        "grant_types_supported": "password refresh_token",
        "response_types_supported": ["token"],
        "scopes_supported": ["openid", "profile", "projects:read", "projects:write"],
        "token_endpoint_auth_methods_supported": ["none"],
    });

    (
        StatusCode::OK,
        [("content-type", "application/json")],
        document.to_string(),
    )
        .into_response()
}
