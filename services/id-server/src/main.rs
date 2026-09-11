#![allow(clippy::doc_markdown)] // OAuth2, etc. appear in prose, not code identifiers.
//! OAuth2-style identity server with historical quirks.
//!
//! "Built in 2019 by the security team" — the original team used opaque access tokens
//! for revocability, a later contractor bolted on JWT refresh tokens, and nobody ever
//! unified the two. Error formats diverged when the user-info endpoint was added by
//! someone who didn't read the OAuth2 error spec. The rate limiter was configured by
//! devops using HTTP-date `Retry-After` instead of seconds. CORS was set up once and
//! never updated when new endpoints were added.

mod store;
mod routes;
mod error;

use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use store::UserStore;

#[tokio::main]
async fn main() {
    let store = Arc::new(RwLock::new(UserStore::new()));

    // CORS: intentionally omit Content-Type from allowed headers on preflight.
    // Quirk: the devops team configured CORS once for the initial endpoints and never
    // updated the allowed-headers list when the /register endpoint was added (which
    // sends JSON and needs Content-Type). The browser will block preflight for /register
    // unless the client works around it (e.g. using a simple request or a proxy).
    //
    // In practice we allow Content-Type for most endpoints via the permissive layer,
    // but the /register endpoint gets a restrictive sub-router (see routes.rs).
    let permissive_cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = routes::build_router(store).layer(permissive_cors);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:4100")
        .await
        .expect("failed to bind to port 4100");

    println!("ID Server listening on http://localhost:4100");

    axum::serve(listener, app).await.expect("server error");
}
