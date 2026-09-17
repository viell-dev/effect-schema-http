import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import { Request } from "viell-effect-schema-http";

/** Raw request transformations compose before schema bindings and materialization. */
export const forceFresh = (request: Request.Request<unknown>) =>
  request.pipe(
    Request.setHeader("cache-control", "no-cache"),
    Request.setQuery("_cb", () => String(Date.now())),
  );

export const withScopeLines = (scopes: ReadonlyArray<string>) => (request: Request.Request<unknown>) =>
  scopes.reduce((result, scope) => result.pipe(Request.appendHeader("x-scope", scope)), request);

/** One nonce per evaluation. To vary it per attempt, transform the HttpClient instead. */
export const withNonce = (nonce: number) => Request.setHeader("x-nonce", String(nonce));

export const tunnelMethod = (method: string) => (request: Request.Request<unknown>) =>
  request.pipe(
    Request.setHeader("x-http-method-override", method.toUpperCase()),
    Request.mapEffect((prepared) => Effect.succeed(HttpClientRequest.setMethod(prepared, "POST"))),
  );

export const withoutTracing = HttpClient.withTracerPropagation(false);
