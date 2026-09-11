//! In-memory user store with password hashing.

use hmac::Hmac;
use sha2::Sha256;
use hmac::Mac;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

/// The "secret" used for password hashing. In the real system this was in a config file
/// that got committed to the repo in 2019 and was never rotated.
const PASSWORD_SECRET: &[u8] = b"id-server-totally-secret-key-2019";

/// The secret used for signing JWTs (refresh tokens). The contractor who added refresh
/// tokens used a different secret than the password hash. Of course.
pub const JWT_SECRET: &[u8] = b"refresh-token-jwt-secret-contractor-2020";

#[derive(Debug, Clone)]
pub struct User {
    pub id: String,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub display_name: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    pub user_id: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

pub struct UserStore {
    pub users: HashMap<String, User>,
    pub users_by_username: HashMap<String, String>,
    pub users_by_email: HashMap<String, String>,
    /// Opaque access tokens mapped to their metadata.
    /// Quirk: access tokens are opaque strings, not JWTs.
    pub access_tokens: HashMap<String, AccessToken>,
    /// Rate limit tracking: IP → (count, window_start)
    pub rate_limits: HashMap<String, (u32, chrono::DateTime<chrono::Utc>)>,
    /// Tokens revoked through `/revoke` (RFC 7009). Kept separately from `access_tokens`
    /// because the revocation endpoint was added in 2021 and its author did not want to
    /// touch the original token map "in case something else depends on it".
    pub revoked_tokens: HashSet<String>,
    /// Highest nonce seen per access token, for the replay-protected echo endpoint.
    pub nonces: HashMap<String, u64>,
    /// Attempt counter per access token for the deliberately flaky echo endpoint.
    pub echo_attempts: HashMap<String, u32>,
    /// Emulated reverse-proxy cache in front of `/jwks.json`: (stored_at, body).
    pub jwks_cache: Option<(chrono::DateTime<chrono::Utc>, String)>,
}

impl UserStore {
    pub fn new() -> Self {
        Self {
            users: HashMap::new(),
            users_by_username: HashMap::new(),
            users_by_email: HashMap::new(),
            access_tokens: HashMap::new(),
            rate_limits: HashMap::new(),
            revoked_tokens: HashSet::new(),
            nonces: HashMap::new(),
            echo_attempts: HashMap::new(),
            jwks_cache: None,
        }
    }

    pub fn hash_password(password: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(PASSWORD_SECRET).expect("HMAC can take key of any size");
        mac.update(password.as_bytes());
        let result = mac.finalize();
        hex::encode(result.into_bytes())
    }

    pub fn register(
        &mut self,
        username: &str,
        email: &str,
        password: &str,
        display_name: Option<&str>,
    ) -> Result<User, &'static str> {
        if self.users_by_username.contains_key(username) {
            return Err("username already taken");
        }
        if self.users_by_email.contains_key(email) {
            return Err("email already registered");
        }

        let id = Uuid::new_v4().to_string();
        let user = User {
            id: id.clone(),
            username: username.to_string(),
            email: email.to_string(),
            password_hash: Self::hash_password(password),
            display_name: display_name.map(String::from),
            created_at: chrono::Utc::now(),
        };

        self.users_by_username
            .insert(username.to_string(), id.clone());
        self.users_by_email.insert(email.to_string(), id.clone());
        self.users.insert(id, user.clone());
        Ok(user)
    }

    pub fn authenticate(&self, username: &str, password: &str) -> Option<&User> {
        let id = self.users_by_username.get(username)?;
        let user = self.users.get(id)?;
        if user.password_hash == Self::hash_password(password) {
            Some(user)
        } else {
            None
        }
    }

    /// Issue an opaque access token. NOT a JWT — the original security team wanted
    /// revocability, so access tokens are random strings stored server-side.
    pub fn issue_access_token(&mut self, user_id: &str) -> AccessToken {
        let token = format!("at_{}", Uuid::new_v4().to_string().replace('-', ""));
        let access_token = AccessToken {
            token: token.clone(),
            user_id: user_id.to_string(),
            expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
        };
        self.access_tokens.insert(token, access_token.clone());
        access_token
    }

    pub fn validate_access_token(&self, token: &str) -> Option<&AccessToken> {
        if self.revoked_tokens.contains(token) {
            return None;
        }
        let at = self.access_tokens.get(token)?;
        if at.expires_at > chrono::Utc::now() {
            Some(at)
        } else {
            None
        }
    }

    pub fn get_user(&self, user_id: &str) -> Option<&User> {
        self.users.get(user_id)
    }

    /// Revoke a token (RFC 7009). Revoking an unknown or already-revoked token is a
    /// no-op, exactly as the RFC requires.
    pub fn revoke_token(&mut self, token: &str) {
        self.revoked_tokens.insert(token.to_string());
    }

    /// Record a nonce for a token, rejecting values that do not strictly increase.
    /// Returns the previously highest value on rejection.
    pub fn accept_nonce(&mut self, token: &str, nonce: u64) -> Result<(), u64> {
        let last = self.nonces.get(token).copied().unwrap_or(0);
        if nonce <= last {
            return Err(last);
        }
        self.nonces.insert(token.to_string(), nonce);
        Ok(())
    }

    /// Count an attempt against the flaky echo endpoint. The first two attempts per
    /// token fail with `503`; the third and later succeed.
    pub fn next_echo_attempt(&mut self, token: &str) -> u32 {
        let counter = self.echo_attempts.entry(token.to_string()).or_insert(0);
        *counter += 1;
        *counter
    }

    /// Reset the flaky echo endpoint so a fresh run starts from attempt one again.
    pub fn reset_echo_attempts(&mut self, token: &str) {
        self.echo_attempts.remove(token);
    }

    /// Check rate limit. Returns Ok(()) if allowed, Err(retry_after) if limited.
    pub fn check_rate_limit(
        &mut self,
        ip: &str,
        max_requests: u32,
        window_seconds: i64,
    ) -> Result<(), chrono::DateTime<chrono::Utc>> {
        let now = chrono::Utc::now();
        let entry = self
            .rate_limits
            .entry(ip.to_string())
            .or_insert((0, now));

        // Reset window if expired.
        if (now - entry.1).num_seconds() > window_seconds {
            *entry = (0, now);
        }

        entry.0 += 1;
        if entry.0 > max_requests {
            // Quirk: return the time when the window resets, not seconds remaining.
            // The devops team configured the rate limiter to use HTTP-date format.
            Err(entry.1 + chrono::Duration::seconds(window_seconds))
        } else {
            Ok(())
        }
    }
}

/// Hex encoding utility (no extra dependency needed).
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .fold(String::new(), |mut s, b| {
                use std::fmt::Write;
                let _ = write!(s, "{b:02x}");
                s
            })
    }
}
