import { HttpBody, UrlParams } from "@effect/platform";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
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
import { configure, executionOptions, type Options } from "./options.js";
export const ID_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_ID_SERVER_URL) || "http://localhost:4100";

export const idRequest = (method: string, path: string, options: Options) =>
  Request.make(method, path).pipe(
    Request.baseUrl(ID_SERVER_URL),
    Request.setHeader("authorization", () => {
      const session = getSession();
      return session === undefined ? undefined : `Bearer ${session.accessToken}`;
    }),
    configure(options),
  );

export const idFailure = Response.when(
  (metadata) => ((status: number) => status === 400 || status === 401 || status === 409)(metadata.status),
  Body.json.pipe(Body.schema(OAuthError), (decoder) => Response.tag("OAuthError", decoder)),
);

/** POST /register. */
export const register = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/register", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
      Request.body(Body.jsonSchema(RegisterInput)),
    ),
    Response.status(
      201,
      Body.json.pipe(Body.schema(RegisterResponse), (decoder) => Response.tag("created", decoder)),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** POST /token. */
export const requestToken = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/token", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
      Request.body(Body.jsonSchema(TokenInput)),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(TokenResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          429,
          Body.json.pipe(Body.schema(OAuthError), (decoder) => Response.tag("RateLimited", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** GET /userinfo. */
export const getUserInfo = (options: Options = {}) =>
  Operation.make(
    idRequest("GET", "/userinfo", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(UserInfoResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.json.pipe(Body.schema(SimpleError), (decoder) => Response.tag("SimpleUnauthorized", decoder)),
        ),
      ),
      Response.orElse(
        Response.status(
          404,
          Body.json.pipe(Body.schema(SimpleError), (decoder) => Response.tag("SimpleNotFound", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** POST /introspect. */
export const introspectToken = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/introspect", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
      Request.body(Body.jsonSchema(Schema.Struct({ token: Schema.String }))),
    ),
    Response.status(
      200,
      Body.json.pipe(
        Body.schema(
          Schema.Struct({
            active: Schema.Boolean,
            sub: Schema.optional(Schema.String),
            username: Schema.optional(Schema.String),
            exp: Schema.optional(Schema.Number),
          }),
        ),
        (decoder) => Response.tag("ok", decoder),
      ),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** POST /oauth/token. */
export const formLogin = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/oauth/token", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
      Request.body(
        Body.encodeSchema(FormGrantRequest)(
          Body.encoder((value: Schema.Schema.Encoded<typeof FormGrantRequest>) =>
            Effect.succeed(HttpBody.urlParams(UrlParams.fromInput(value))),
          ),
        ),
      ),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(FormGrantResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          415,
          Body.json.pipe(Body.schema(OAuthError), (decoder) => Response.tag("UnsupportedMediaType", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** POST /revoke. */
export const revokeToken = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/revoke", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
      Request.body(Body.jsonSchema(Schema.Struct({ token: Schema.String }))),
    ),
    Response.status(
      200,
      Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("revoked", decoder)),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** HEAD /userinfo/probe. */
export const probeToken = (options: Options = {}) =>
  Operation.make(
    idRequest("HEAD", "/userinfo/probe", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("valid", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("invalid", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** GET /jwks.json. */
export const getJwks = (options: Options = {}) =>
  Operation.make(
    idRequest("GET", "/jwks.json", {}).pipe(Request.removeHeader("authorization"), configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(JsonWebKeySet), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** POST /jwks.json/purge. */
export const purgeJwksCache = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/jwks.json/purge", {}).pipe(Request.removeHeader("authorization"), configure(options)),
    Response.status(
      204,
      Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("purged", decoder)),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** GET /directory/:username. */
export const directoryEntry = (options: Options = {}) =>
  Operation.make(
    idRequest("GET", "/directory/:username", {}).pipe(
      Request.removeHeader("authorization"),
      Request.setQuery("access_token", () => getSession()?.accessToken),
      configure(options),
      Request.path(
        Schema.Struct({ username: Schema.String }),
        (value, encode) => `/directory/${encode(value.username)}`,
      ),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(DirectoryEntry), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          401,
          Body.json.pipe(Body.schema(SimpleError), (decoder) => Response.tag("SimpleUnauthorized", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** POST /session/echo. */
export const sessionEcho = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/session/echo", {}).pipe(configure(options), Request.body(Body.jsonSchema(EchoRequest))),
    Response.status(
      200,
      Body.json.pipe(Body.schema(EchoResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          409,
          Body.json.pipe(Body.schema(NonceReplayError), (decoder) => Response.tag("NonceReplayError", decoder)),
        ),
      ),
      Response.orElse(
        Response.status(
          503,
          Body.json.pipe(Body.schema(WarmingUpError), (decoder) => Response.tag("WarmingUpError", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** POST /session/echo/reset. */
export const resetSessionEcho = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/session/echo/reset", {}).pipe(configure(options)),
    Response.status(
      204,
      Body.empty.pipe(Body.schema(Schema.Void), (decoder) => Response.tag("reset", decoder)),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** POST /token/scoped. */
export const scopedToken = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/token/scoped", {}).pipe(configure(options)),
    Response.status(
      200,
      Body.json.pipe(Body.schema(ScopedTokenResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          400,
          Body.json.pipe(Body.schema(JoinedScopeError), (decoder) => Response.tag("JoinedScopeError", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );

/** GET /.well-known/openid-configuration. */
export const discovery = (options: Options = {}) =>
  Operation.make(
    idRequest("GET", "/.well-known/openid-configuration", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(DiscoveryDocument), (decoder) => Response.tag("ok", decoder)),
    ).pipe(Response.orElse(idFailure)),
    executionOptions(options),
  );

/** Deliberately wrong representation, used to exercise the server's 415 contract. */
/** POST /oauth/token. */
export const formLoginJson = (options: Options = {}) =>
  Operation.make(
    idRequest("POST", "/oauth/token", {}).pipe(
      Request.removeHeader("authorization"),
      configure(options),
      Request.body(Body.jsonSchema(FormGrantRequest)),
    ),
    Response.status(
      200,
      Body.json.pipe(Body.schema(FormGrantResponse), (decoder) => Response.tag("ok", decoder)),
    ).pipe(
      Response.orElse(
        Response.status(
          415,
          Body.json.pipe(Body.schema(OAuthError), (decoder) => Response.tag("UnsupportedMediaType", decoder)),
        ),
      ),
      Response.orElse(idFailure),
    ),
    executionOptions(options),
  );
