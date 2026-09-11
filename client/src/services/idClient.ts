import { Schema } from "effect";
import { createApi, extendApi, RequestBody, response, ResponseBody } from "viell-effect-schema-http";
import {
  DirectoryEntry,
  DiscoveryDocument,
  EchoRequest,
  EchoResponse,
  FormGrantRequest,
  FormGrantResponse,
  JoinedScopeError,
  JsonWebKeySet,
  NonceReplayError,
  ScopedTokenResponse,
  WarmingUpError,
} from "../schemas/idLegacy.js";
import {
  OAuthError,
  RegisterInput,
  RegisterResponse,
  SimpleError,
  TokenInput,
  TokenResponse,
  UserInfoResponse,
} from "../schemas/idServer.js";
import { getSession } from "../session.js";

export const ID_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_ID_SERVER_URL) || "http://localhost:4100";

/**
 * The ID server, as one API declaration.
 *
 * `authorization` is an API-wide **computed** header rather than something attached per
 * call site. It is read from live session state when each request is materialized, so
 * one API object survives signing in, refreshing and signing out — and, more usefully,
 * a new endpoint is authenticated by construction. Forgetting to think about
 * authentication cannot produce an anonymous request here; it can only produce an
 * authenticated one somewhere it was not needed, which is an explicit, visible opt-out
 * (`publicIdApi`) rather than a silent omission.
 *
 * The API-wide `OAuthError` rule uses a status *predicate* because three statuses share
 * one schema and rule tags must be unique. Endpoints that need a different shape at one
 * of those statuses declare an exact-status rule, which outranks the predicate.
 */
export const idApi = createApi(ID_SERVER_URL, {
  headers: {
    authorization: () => {
      const session = getSession();
      return session === undefined ? undefined : `Bearer ${session.accessToken}`;
    },
  },
  responses: [
    response({ _tag: "OAuthError", status: (status: number) => status === 400 || status === 401 || status === 409 }, OAuthError),
  ] as const,
});

/**
 * The three endpoints that must not send a credential.
 *
 * Removing the header here means it is never even computed for these calls: a removed
 * field's function is not invoked. That is the difference between a declared computed
 * value and a request transform — a transform runs after the declarative layer is
 * materialized, so nothing below it could take the header away again.
 */
export const publicIdApi = idApi.pipe(extendApi({ removeHeaders: ["authorization"] }));

// ---------------------------------------------------------------------------
// The original 2019 endpoints
// ---------------------------------------------------------------------------

/** `POST /register` — 201 with the full user; `/token` deliberately answers with neither. */
export const register = publicIdApi.createRequest({
  method: "POST",
  path: "/register",
  body: RegisterInput,
  responses: [response({ _tag: "created", status: 201 }, RegisterResponse)],
});

/** `POST /token` — the JSON grant a frontend developer asked for in 2019. */
export const requestToken = publicIdApi.createRequest({
  method: "POST",
  path: "/token",
  body: TokenInput,
  responses: [
    response({ _tag: "ok", status: 200 }, TokenResponse),
    // The rate limiter answers `429` with an HTTP-date `Retry-After`, which the library
    // honours without configuration; the body is still the OAuth error shape.
    response({ _tag: "RateLimited", status: 429 }, OAuthError),
  ],
});

/** `GET /userinfo` — the endpoint with its own private error shape. */
export const getUserInfo = idApi.createRequest({
  method: "GET",
  path: "/userinfo",
  responses: [
    response({ _tag: "ok", status: 200 }, UserInfoResponse),
    // Exact statuses outrank the API-wide `OAuthError` predicate, which is how one
    // endpoint's divergent error format is expressed without disturbing the others.
    response({ _tag: "SimpleUnauthorized", status: 401 }, SimpleError),
    response({ _tag: "SimpleNotFound", status: 404 }, SimpleError),
  ],
});

/** `POST /introspect` — what the other services call to validate a token. */
export const introspectToken = publicIdApi.createRequest({
  method: "POST",
  path: "/introspect",
  body: Schema.Struct({ token: Schema.String }),
  responses: [
    response(
      { _tag: "ok", status: 200 },
      Schema.Struct({
        active: Schema.Boolean,
        sub: Schema.optional(Schema.String),
        username: Schema.optional(Schema.String),
        exp: Schema.optional(Schema.Number),
      }),
    ),
  ],
});

// ---------------------------------------------------------------------------
// Endpoints added after 2019
// ---------------------------------------------------------------------------

/**
 * `POST /oauth/token` — the form-encoded grant RFC 6749 actually specifies.
 *
 * The only configuration this needs is `bodyCodec`. `FormGrantRequest` is an ordinary
 * struct; its encoded form is already the flat record of strings `RequestBody.urlParams`
 * wants, so nothing was written for the codec's benefit.
 */
export const formLogin = publicIdApi.createRequest({
  method: "POST",
  path: "/oauth/token",
  body: FormGrantRequest,
  bodyCodec: RequestBody.urlParams,
  responses: [
    response({ _tag: "ok", status: 200 }, FormGrantResponse),
    // A second tag over the same schema: rule tags must be unique, schemas need not be.
    response({ _tag: "UnsupportedMediaType", status: 415 }, OAuthError),
  ],
});

/**
 * `POST /revoke` — RFC 7009, which specifies `200` and no content.
 *
 * The response carries `Content-Type: application/json` and zero bytes, so the default
 * JSON codec would reject it: an empty payload is not JSON. `ResponseBody.none` drains
 * whatever arrived and `Schema.Void` is the schema that pairs with it.
 */
export const revokeToken = publicIdApi.createRequest({
  method: "POST",
  path: "/revoke",
  body: Schema.Struct({ token: Schema.String }),
  responses: [response({ _tag: "revoked", status: 200 }, Schema.Void, { codec: ResponseBody.none })],
});

/**
 * `HEAD /userinfo/probe` — a token validity check whose answer is entirely in headers.
 *
 * Both outcomes are bodyless, so both rules use `ResponseBody.none`. The interesting
 * part is on the envelope: `TokenProbeHeaders` is applied to `envelope.headers` by the
 * caller, because header values are strings and a schema's encoded side already
 * describes strings.
 */
export const probeToken = idApi.createRequest({
  method: "HEAD",
  path: "/userinfo/probe",
  responses: [
    response({ _tag: "valid", status: 200 }, Schema.Void, { codec: ResponseBody.none }),
    response({ _tag: "invalid", status: 401 }, Schema.Void, { codec: ResponseBody.none }),
  ],
});

/**
 * `GET /jwks.json` — served through a reverse proxy that ignores request cache
 * directives. Pair it with `forceFresh` when a caller genuinely wants the origin.
 */
export const getJwks = publicIdApi.createRequest({
  method: "GET",
  path: "/jwks.json",
  responses: [response({ _tag: "ok", status: 200 }, JsonWebKeySet)],
});

/**
 * `POST /jwks.json/purge` — the cache's purge API.
 *
 * Every cache in front of a real service has one, and it never looks like the cache's
 * own configuration: no body, no credential, and a `204`, because it was added during an
 * incident at two in the morning.
 */
export const purgeJwksCache = publicIdApi.createRequest({
  method: "POST",
  path: "/jwks.json/purge",
  responses: [response({ _tag: "purged", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
});

/**
 * `GET /directory/:username` — the LDAP gateway, authenticated by query parameter.
 *
 * `removeHeaders` is not cosmetic here: this endpoint is the one place in the client
 * where a credential travels in a URL, and the declaration says so. The parameter is
 * computed, so it is read from the live session and omitted entirely when signed out —
 * which produces an honest `401` rather than the string `"undefined"` in a query.
 */
export const directoryEntry = idApi.createRequest({
  method: "GET",
  path: "/directory/:username",
  removeHeaders: ["authorization"],
  urlParams: {
    access_token: () => getSession()?.accessToken,
  },
  responses: [
    response({ _tag: "ok", status: 200 }, DirectoryEntry),
    response({ _tag: "SimpleUnauthorized", status: 401 }, SimpleError),
  ],
});

/**
 * `POST /session/echo` — replay-protected correlation against a service that is cold.
 *
 * The `409` rule is an exact status and therefore outranks the API-wide `OAuthError`
 * predicate that also covers `409`; the `503` is mapped as an ordinary response rather
 * than left to become a transport error, so a caller driving the loop itself can read
 * why it failed.
 */
export const sessionEcho = idApi.createRequest({
  method: "POST",
  path: "/session/echo",
  body: EchoRequest,
  responses: [
    response({ _tag: "ok", status: 200 }, EchoResponse),
    response({ _tag: "NonceReplayError", status: 409 }, NonceReplayError),
    response({ _tag: "WarmingUpError", status: 503 }, WarmingUpError),
  ],
});

/** `POST /session/echo/reset` — start the warm-up sequence over. */
export const resetSessionEcho = idApi.createRequest({
  method: "POST",
  path: "/session/echo/reset",
  responses: [response({ _tag: "reset", status: 204 }, Schema.Void, { codec: ResponseBody.none })],
});

/**
 * `POST /token/scoped` — narrow a token, one scope per `X-Scope` header field line.
 *
 * Apply `withScopeLines` to supply them. Whether the repeated entries survive to the
 * wire depends on the provider: see `repeatedHeaderClient.ts` and the README.
 */
export const scopedToken = idApi.createRequest({
  method: "POST",
  path: "/token/scoped",
  responses: [
    response({ _tag: "ok", status: 200 }, ScopedTokenResponse),
    response({ _tag: "JoinedScopeError", status: 400 }, JoinedScopeError),
  ],
});

/** `GET /.well-known/openid-configuration` — with one list that is not a list. */
export const discovery = publicIdApi.createRequest({
  method: "GET",
  path: "/.well-known/openid-configuration",
  responses: [response({ _tag: "ok", status: 200 }, DiscoveryDocument)],
});
