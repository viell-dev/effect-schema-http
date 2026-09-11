import { ParseResult, Schema } from "effect";
import { BlankAsNull, LdapGeneralizedTime, SpaceDelimited, taggedBody, YesNo } from "./common.js";

/**
 * Schemas for the endpoints that accreted onto the ID server after 2019.
 *
 * These are kept apart from `idServer.ts` for the same reason the server keeps them in
 * a separate module: they share a base URL with the original endpoints and nothing else.
 */

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/**
 * An opaque access token.
 *
 * The security team chose opaque tokens for revocability, so the client can never look
 * inside one. Branding it means the compiler will not let a refresh token — a JWT, from
 * an entirely different code path — be passed where an access token belongs, even
 * though both are strings.
 */
export const OpaqueAccessToken = Schema.String.pipe(
  Schema.pattern(/^at_[0-9a-f]{32}$/u),
  Schema.brand("OpaqueAccessToken"),
  Schema.annotations({
    identifier: "OpaqueAccessToken",
    description: "An opaque, server-side-revocable access token issued by the ID server",
    // Redact the token when a decoded value is printed for debugging.
    pretty: () => (token: string) => `OpaqueAccessToken(at_…${token.slice(-4)})`,
  }),
);
export type OpaqueAccessToken = typeof OpaqueAccessToken.Type;

/** A scope name. Never contains a comma, which is the whole reason `/token/scoped` exists. */
export const Scope = Schema.String.pipe(
  Schema.filter((value) => (value.includes(",") ? "a scope name cannot contain a comma" : true)),
  Schema.brand("Scope"),
);
export type Scope = typeof Scope.Type;

// ---------------------------------------------------------------------------
// POST /oauth/token — the form-encoded grant
// ---------------------------------------------------------------------------

/**
 * The request body for the form-encoded grant.
 *
 * Nothing here was written *for* `RequestBody.urlParams`: this is an ordinary struct of
 * branded strings, and its **encoded** form — a flat record of strings — already
 * satisfies the codec's "record of coercible values" input. The codec needs no
 * transform because the schema's encoded side is already the shape it wants.
 */
export const FormGrantRequest = Schema.Struct({
  grant_type: Schema.Literal("password"),
  username: Schema.String.pipe(Schema.minLength(1)),
  password: Schema.String.pipe(Schema.minLength(1)),
});
export type FormGrantRequest = typeof FormGrantRequest.Type;

/**
 * Three spellings of the same word, from three code paths.
 *
 * `"bearer"` (password grant, 2019), `"Bearer"` (refresh grant, 2020), `"BEARER"`
 * (form grant, which predates both and was never touched again). Decoding fails on
 * anything that is not one of those, rather than quietly normalizing an unknown scheme
 * into `Bearer` and attaching a credential the server will not understand.
 */
export const BearerTokenType = Schema.transformOrFail(Schema.String, Schema.Literal("Bearer"), {
  strict: true,
  decode: (raw, _options, ast) =>
    raw.toLowerCase() === "bearer"
      ? ParseResult.succeed("Bearer" as const)
      : ParseResult.fail(new ParseResult.Type(ast, raw, `unsupported token_type ${JSON.stringify(raw)}`)),
  encode: (value) => ParseResult.succeed(value),
});

/**
 * The form grant's response.
 *
 * Quirk: `expires_in` is a string, because the handler behind this endpoint models the
 * whole exchange as `HashMap<String, String>` and serializes what it has.
 */
export const FormGrantResponse = Schema.Struct({
  access_token: OpaqueAccessToken,
  token_type: BearerTokenType,
  expires_in: Schema.NumberFromString,
  scope: SpaceDelimited(Scope),
});
export type FormGrantResponse = typeof FormGrantResponse.Type;

// ---------------------------------------------------------------------------
// HEAD /userinfo/probe — everything in headers
// ---------------------------------------------------------------------------

/**
 * The probe's facts, decoded from response headers rather than from a body.
 *
 * A `HEAD` response has no payload by definition, so the schema is applied to
 * `envelope.headers` by hand instead of by a response codec. Header values are always
 * strings, which is exactly the shape a schema's *encoded* side describes, so ordinary
 * schemas work without anything special.
 */
export const TokenProbeHeaders = Schema.Struct({
  "x-token-subject": Schema.UUID,
  "x-token-username": Schema.String,
  "x-token-expires-in": Schema.NumberFromString,
  "x-token-scope": SpaceDelimited(Scope),
});
export type TokenProbeHeaders = typeof TokenProbeHeaders.Type;

// ---------------------------------------------------------------------------
// GET /jwks.json
// ---------------------------------------------------------------------------

export const JsonWebKeySet = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.String,
      kid: Schema.String,
      alg: Schema.String,
      use: Schema.String,
    }),
  ),
});
export type JsonWebKeySet = typeof JsonWebKeySet.Type;

/** What the emulated reverse proxy in front of the key set reports about itself. */
export const EdgeCacheStatus = Schema.Struct({
  "x-cache": Schema.Literal("HIT", "MISS", "BYPASS"),
  age: Schema.NumberFromString,
});
export type EdgeCacheStatus = typeof EdgeCacheStatus.Type;

// ---------------------------------------------------------------------------
// GET /directory/:username — the LDAP gateway's shape
// ---------------------------------------------------------------------------

/**
 * Exactly what the directory gateway puts on the wire: upper-case attribute names, a
 * `"Y"`/`"N"` flag, LDAP generalized time, and blanks where a value is missing.
 *
 * This is deliberately a *wire* type. It is not what the rest of the client wants to
 * hold, and it is not what any other service will accept.
 */
const DirectoryWireEntry = Schema.Struct({
  ID: BlankAsNull(Schema.UUID),
  USERNAME: Schema.String,
  EMAIL: BlankAsNull(Schema.String),
  DISPLAYNAME: BlankAsNull(Schema.String),
  CREATEDTIMESTAMP: BlankAsNull(LdapGeneralizedTime),
  ACTIVE: YesNo,
});

/**
 * The domain value the application actually wants.
 *
 * The transform between the two is the alignment work this repository exists to
 * exercise: one definition describes the gateway's spelling, another describes the
 * shape the rest of the client uses, and `Schema.transform` is the seam. Because it is
 * a transform rather than a mapping function, it also runs backwards — which is how the
 * directory's own view can be rendered from a domain value in a test.
 */
export const DirectoryEntry = Schema.transform(
  DirectoryWireEntry,
  Schema.Struct({
    id: Schema.NullOr(Schema.String),
    username: Schema.String,
    email: Schema.NullOr(Schema.String),
    displayName: Schema.NullOr(Schema.String),
    createdAt: Schema.NullOr(Schema.DateTimeUtcFromSelf),
    active: Schema.Boolean,
  }),
  {
    strict: true,
    decode: (wire) => ({
      id: wire.ID,
      username: wire.USERNAME,
      email: wire.EMAIL,
      displayName: wire.DISPLAYNAME,
      createdAt: wire.CREATEDTIMESTAMP,
      active: wire.ACTIVE,
    }),
    encode: (entry) => ({
      ID: entry.id,
      USERNAME: entry.username,
      EMAIL: entry.email,
      DISPLAYNAME: entry.displayName,
      CREATEDTIMESTAMP: entry.createdAt,
      ACTIVE: entry.active,
    }),
  },
);
export type DirectoryEntry = typeof DirectoryEntry.Type;

// ---------------------------------------------------------------------------
// POST /session/echo — replay-protected correlation
// ---------------------------------------------------------------------------

export const EchoRequest = Schema.Struct({
  message: Schema.String,
});

export const EchoResponse = Schema.Struct({
  nonce: Schema.Number,
  attempt: Schema.Number,
  echo: Schema.Struct({ message: Schema.String }),
});
export type EchoResponse = typeof EchoResponse.Type;

/** `503` while the backing service warms up, and `409` when a nonce is replayed. */
export const WarmingUpError = taggedBody("WarmingUpError", {
  message: Schema.String,
});
export type WarmingUpError = typeof WarmingUpError.Type;

export const NonceReplayError = taggedBody("NonceReplayError", {
  message: Schema.String,
});
export type NonceReplayError = typeof NonceReplayError.Type;

// ---------------------------------------------------------------------------
// POST /token/scoped — repeated request header field lines
// ---------------------------------------------------------------------------

export const ScopedTokenResponse = Schema.Struct({
  access_token: OpaqueAccessToken,
  token_type: BearerTokenType,
  expires_in: Schema.Number,
  scope: SpaceDelimited(Scope),
  scope_lines: Schema.Array(Scope),
});
export type ScopedTokenResponse = typeof ScopedTokenResponse.Type;

/** What the server answers when the scope lines arrived comma-joined. */
export const JoinedScopeError = taggedBody("JoinedScopeError", {
  error: Schema.Literal("invalid_scope"),
  error_description: Schema.String,
  received_lines: Schema.Number,
});
export type JoinedScopeError = typeof JoinedScopeError.Type;

// ---------------------------------------------------------------------------
// GET /.well-known/openid-configuration
// ---------------------------------------------------------------------------

/**
 * The discovery document.
 *
 * Quirk: `grant_types_supported` is a space-delimited string where the specification
 * requires an array, so it decodes through the same combinator as `scope`. Every other
 * list on this document really is an array, which is what makes the one exception
 * annoying enough to be worth a schema rather than a comment.
 */
export const DiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  token_endpoint: Schema.String,
  userinfo_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
  introspection_endpoint: Schema.String,
  jwks_uri: Schema.String,
  grant_types_supported: SpaceDelimited(Schema.String),
  response_types_supported: Schema.Array(Schema.String),
  scopes_supported: Schema.Array(Scope),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.String),
});
export type DiscoveryDocument = typeof DiscoveryDocument.Type;
