//! In-memory user store with password hashing.

use hmac::Hmac;
use sha2::Sha256;
use hmac::Mac;
use std::collections::HashMap;
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
}

impl UserStore {
    pub fn new() -> Self {
        Self {
            users: HashMap::new(),
            users_by_username: HashMap::new(),
            users_by_email: HashMap::new(),
            access_tokens: HashMap::new(),
            rate_limits: HashMap::new(),
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
