import { Schema } from "effect";
import { createApi, response } from "viell-effect-schema-http";
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
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_ID_SERVER_URL) ||
  "http://localhost:4100";

/**
 * ID Server API client configured with OAuth2 error handling.
 */
export const idApi = createApi(ID_SERVER_URL, {
  responses: [
    response(
      {
        _tag: "OAuthError",
        status: (s: number) => s === 400 || s === 401 || s === 409,
      },
      OAuthError,
    ),
  ] as const,
});

/**
 * POST /register — Register a new account.
 * Quirk: Returns 201 Created with full user object in body.
 */
export const register = idApi.createRequest({
  method: "POST",
  path: "/register",
  body: RegisterInput,
  responses: [response({ _tag: "created", status: 201 }, RegisterResponse)],
});

/**
 * POST /token — OAuth2 token endpoint.
 * Supports password grant and refresh_token grant.
 * Quirk: token_type casing differs ("bearer" vs "Bearer").
 */
export const requestToken = idApi.createRequest({
  method: "POST",
  path: "/token",
  body: TokenInput,
  responses: [response({ _tag: "ok", status: 200 }, TokenResponse)],
});

/**
 * GET /userinfo — Return the authenticated user profile.
 * Quirk: Error format uses SimpleError ({ message }), NOT OAuthError ({ error, error_description }).
 */
export const getUserInfo = idApi.createRequest({
  method: "GET",
  path: "/userinfo",
  headers: {
    authorization: () => {
      const session = getSession();
      return session ? `Bearer ${session.accessToken}` : undefined;
    },
  },
  responses: [
    response({ _tag: "ok", status: 200 }, UserInfoResponse),
    response(
      {
        _tag: "SimpleError",
        status: (s: number) => s === 401 || s === 404,
      },
      SimpleError,
    ),
  ],
});

/**
 * POST /introspect — Validate access tokens.
 */
export const introspectToken = idApi.createRequest({
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
