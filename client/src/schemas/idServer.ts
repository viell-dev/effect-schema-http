import { Schema } from "effect";
import { taggedBody } from "./common.js";

/**
 * Register input for POST /register on ID Server.
 */
export const RegisterInput = Schema.Struct({
  username: Schema.String,
  email: Schema.String,
  password: Schema.String,
  display_name: Schema.optional(Schema.String),
});
export type RegisterInput = typeof RegisterInput.Type;

/**
 * Register response: 201 with User representation.
 */
export const RegisterResponse = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  email: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});
export type RegisterResponse = typeof RegisterResponse.Type;

/**
 * Token request: supports password grant and refresh_token grant.
 */
export const PasswordGrantInput = Schema.Struct({
  grant_type: Schema.Literal("password"),
  username: Schema.String,
  password: Schema.String,
});

export const RefreshTokenGrantInput = Schema.Struct({
  grant_type: Schema.Literal("refresh_token"),
  refresh_token: Schema.String,
});

export const TokenInput = Schema.Union(PasswordGrantInput, RefreshTokenGrantInput);
export type TokenInput = typeof TokenInput.Type;

/**
 * Quirk: token_type casing inconsistency.
 * Password grant returns "bearer" (lowercase).
 * Refresh token grant returns "Bearer" (capitalized).
 * We normalize both to "Bearer" using a Schema transform.
 */
export const NormalizedTokenType = Schema.transform(
  Schema.String,
  Schema.Literal("Bearer"),
  {
    strict: true,
    decode: (raw) => (raw.toLowerCase() === "bearer" ? ("Bearer" as const) : ("Bearer" as const)),
    encode: () => "Bearer" as const,
  },
);

export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: NormalizedTokenType,
  expires_in: Schema.Number,
  refresh_token: Schema.String,
});
export type TokenResponse = typeof TokenResponse.Type;

/**
 * UserInfo response from GET /userinfo.
 */
export const UserInfoResponse = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  email: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});
export type UserInfoResponse = typeof UserInfoResponse.Type;

/**
 * OAuth2 standard error format used by /token and /register:
 * { error: string, error_description: string }
 */
export const OAuthError = taggedBody("OAuthError", {
  error: Schema.String,
  error_description: Schema.String,
});
export type OAuthError = typeof OAuthError.Type;

/**
 * Quirk: Simple error format used by /userinfo (divergent team convention):
 * { message: string }
 */
export const SimpleError = taggedBody("SimpleError", {
  message: Schema.String,
});
export type SimpleError = typeof SimpleError.Type;

/**
 * Quirk: Rate-limit error (429) where Retry-After header is formatted
 * as an HTTP-date string (e.g. "Fri, 11 Sep 2026 15:39:28 GMT"), not seconds.
 */
export const RateLimitError = taggedBody("RateLimitError", {
  error: Schema.String,
  error_description: Schema.String,
});
export type RateLimitError = typeof RateLimitError.Type;

/**
 * Parses HTTP-date string (RFC 7231 / RFC 1123) into seconds until expiration.
 */
export const parseHttpDateHeader = (headerValue: string | null | undefined): {
  date: Date;
  secondsRemaining: number;
} | undefined => {
  if (!headerValue) return undefined;
  const parsed = Date.parse(headerValue);
  if (Number.isNaN(parsed)) return undefined;
  const date = new Date(parsed);
  const secondsRemaining = Math.max(0, Math.round((parsed - Date.now()) / 1000));
  return { date, secondsRemaining };
};
