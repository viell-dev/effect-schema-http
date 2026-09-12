import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  type HttpMethod,
} from "@effect/platform";
import { Effect, Option, Schema } from "effect";
import { setUrlQuery } from "../encoding/setUrlQuery.js";
import { UrlEncoding } from "../encoding/UrlEncoding.js";
import { RequestBodyEncodeError } from "../errors/RequestBodyEncodeError.js";
import { RequestBodyNotAllowed } from "../errors/RequestBodyNotAllowed.js";
import { RequestBodyRequired } from "../errors/RequestBodyRequired.js";
import { ResponseDecodeError } from "../errors/ResponseDecodeError.js";
import { UnhandledResponse } from "../errors/UnhandledResponse.js";
import { appendHeaderEntry } from "../headers/appendHeaderEntry.js";
import { attachHeaderEntries } from "../headers/attachHeaderEntries.js";
import { getHeaderEntries } from "../headers/getHeaderEntries.js";
import { headerEntriesFromInput } from "../headers/headerEntriesFromInput.js";
import { normalizeHeaderEntries } from "../headers/normalizeHeaderEntries.js";
import { reconcileHeaderEntries } from "../headers/reconcileHeaderEntries.js";
import { removeHeaderEntry } from "../headers/removeHeaderEntry.js";
import { replaceHeaderEntryValue } from "../headers/replaceHeaderEntryValue.js";
import { resolveHeaderEntries } from "../headers/resolveHeaderEntries.js";
import { setHeaderEntries } from "../headers/setHeaderEntries.js";
import { decodeResponse } from "../response/decodeResponse.js";
import { findResponseRule } from "../response/findResponseRule.js";
import { response } from "../response/response.js";
import { setResponseRule } from "../response/setResponseRule.js";
import { encodeFields } from "./encodeFields.js";
import { pipeSelf } from "./pipeSelf.js";
import { appendQueryParam } from "./query/appendQueryParam.js";
import { queryParamsFromInput } from "./query/queryParamsFromInput.js";
import { removeQueryParam } from "./query/removeQueryParam.js";
import { removeQueryParamValue } from "./query/removeQueryParamValue.js";
import { replaceQueryParamValue } from "./query/replaceQueryParamValue.js";
import { resolveQueryParams } from "./query/resolveQueryParams.js";
import { setQueryParam } from "./query/setQueryParam.js";
import { setQueryParams } from "./query/setQueryParams.js";
import { executeWithRetry } from "./retry/executeWithRetry.js";
import { normalizeRetry } from "./retry/normalizeRetry.js";
import type { AnyRequestBody, HeaderInput, QueryParamsInput } from "./types.js";
import {
  type AnyResponseRule,
  type AnySchema,
  type CodecOptions,
  type HeaderValueInput,
  type InternalDefinition,
  type InternalRequestPlan,
  type PlanState,
  type QueryParamValue,
  type QueryParamValueInput,
  type RequestBodyCodec,
  type RequestPlan,
  type ResponseBodyCodecOrDefault,
  type ResponseEnvelope,
  type ResponseMatcher,
  type ResponseOf,
  type ResponseRule,
  type SetResponseRule,
} from "./types.js";

export const makePlan = <
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
>(
  definition: InternalDefinition<Body>,
  rules: Rules,
  state: PlanState,
): RequestPlan<Body, Rules, BodyReady, H, Q> => {
  const requireRawFields = (field: "headers" | "urlParams") => {
    if ((field === "headers" ? definition.headersSchema : definition.urlParamsSchema) !== undefined) {
      throw new TypeError(`Use ${field === "headers" ? "setHeaders" : "setUrlParams"} with the schema's input value`);
    }
  };
  const update = (next: Partial<PlanState>): RequestPlan<Body, Rules, BodyReady, H, Q> =>
    makePlan<Body, Rules, BodyReady, H, Q>(definition, rules, { ...state, ...next });

  const rawUpdate = (field: "headers" | "urlParams", next: Partial<PlanState>) => {
    requireRawFields(field);
    return update(next);
  };
  const getEffect = () =>
    definition.body !== undefined && !state.hasBody
      ? Effect.fail(
          new RequestBodyRequired({
            method: definition.method,
            path: definition.path,
            reason: "Call setBody before reading effect",
          }),
        )
      : Effect.gen(function* () {
          // Computed headers and query parameters are resolved exactly here: once per plan evaluation, after every
          // declarative default, override, and removal has been applied, and before any request transform runs. A
          // field that a declaration removed is therefore never computed, and a value that resolves to `undefined`
          // is omitted from the request entirely.
          const requestHeaders =
            definition.headersSchema === undefined
              ? resolveHeaderEntries(state.headers)
              : resolveHeaderEntries(
                  headerEntriesFromInput(
                    (yield* encodeFields(
                      definition.headersSchema,
                      state.schemaHeaders,
                      state.headers,
                      "headers",
                      state.hasSchemaHeaders,
                    )) as HeaderInput,
                  ),
                );
          const urlParams =
            definition.urlParamsSchema === undefined
              ? resolveQueryParams(state.urlParams)
              : resolveQueryParams(
                  queryParamsFromInput(
                    (yield* encodeFields(
                      definition.urlParamsSchema,
                      state.schemaUrlParams,
                      state.urlParams,
                      "urlParams",
                      state.hasSchemaUrlParams,
                    )) as QueryParamsInput,
                  ),
                );

          const encoding = definition.urlEncoding ?? definition.baseOptions?.urlEncoding ?? UrlEncoding.defaults;
          const diagnostics = definition.diagnostics ?? definition.baseOptions?.diagnostics ?? false;
          if (diagnostics)
            yield* Effect.logDebug("schema-http request").pipe(Effect.annotateLogs({ method: definition.method }));
          let request = HttpClientRequest.make(definition.method as HttpMethod.HttpMethod)(
            setUrlQuery(encoding.join(state.baseUrl, definition.path), urlParams, encoding.queryParameter),
          );
          request = HttpClientRequest.setHeaders(request, normalizeHeaderEntries(requestHeaders));

          if (!Headers.has(request.headers, "accept")) {
            request = HttpClientRequest.setHeader(request, "accept", state.responseCodec.accept ?? "application/json");
          }

          if (state.cache?.control !== undefined && !Headers.has(request.headers, "cache-control")) {
            request = HttpClientRequest.setHeader(request, "cache-control", state.cache.control);
          }

          if (definition.body !== undefined && state.hasBody) {
            const encoded = yield* (
              Schema.isSchema(definition.body)
                ? Schema.encodeUnknown(definition.body)(state.body)
                : Effect.succeed(state.body)
            ).pipe(Effect.mapError((cause) => new RequestBodyEncodeError({ request, cause })));
            const bodyCodec = state.bodyCodec as RequestBodyCodec<unknown>;
            request = yield* bodyCodec
              .encode(encoded, request)
              .pipe(Effect.mapError((cause) => new RequestBodyEncodeError({ request, cause })));
          }

          for (const transform of state.requestTransforms) request = transform(request);
          attachHeaderEntries(request, reconcileHeaderEntries(requestHeaders, request.headers));

          const normalizedMethod = request.method.toUpperCase();
          if ((normalizedMethod === "GET" || normalizedMethod === "HEAD") && request.body._tag !== "Empty") {
            return yield* new RequestBodyNotAllowed({ request });
          }

          let client = yield* HttpClient.HttpClient;
          for (const transform of state.clientTransforms) client = transform(client);
          const handleResponse = (
            raw: HttpClientResponse.HttpClientResponse,
          ): Effect.Effect<
            ResponseOf<Rules>,
            UnhandledResponse | HttpClientError.ResponseError | ResponseDecodeError,
            unknown
          > => {
            const headerEntries = getHeaderEntries(raw);
            const rule = findResponseRule(rules, raw.status, raw.headers, headerEntries);
            if (rule === undefined) {
              const error = new UnhandledResponse({ response: raw });
              return state.unhandledResponseBody === "retain"
                ? Effect.fail(error)
                : Effect.zipRight(Effect.ignore(error.discard), Effect.fail(error));
            }

            return Effect.map(decodeResponse(rule, raw, state.responseCodec), (body) => {
              const envelope = {
                _tag: rule.match._tag,
                status: raw.status,
                headers: raw.headers,
                headerEntries,
                cookies: raw.cookies,
                body,
                matched: rule.match,
              } satisfies ResponseEnvelope<ResponseMatcher, unknown>;
              return envelope as ResponseOf<Rules>;
            });
          };
          let send = executeWithRetry(client, request, state.retry, state.timeout, handleResponse);

          if (state.cache?.fetch !== undefined) {
            const existingRequestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
            send = Effect.provideService(send, FetchHttpClient.RequestInit, {
              ...Option.getOrElse(existingRequestInit, () => ({})),
              cache: state.cache.fetch,
            });
          }

          const result = yield* send;
          if (diagnostics)
            yield* Effect.logDebug("schema-http response").pipe(
              Effect.annotateLogs({ method: definition.method, status: result.status, responseTag: result._tag }),
            );
          return result;
        });

  const plan = {
    pipe: pipeSelf,
    setBody: (body: unknown) => makePlan<Body, Rules, true, H, Q>(definition, rules, { ...state, body, hasBody: true }),
    setRequestBodyCodec: (bodyCodec: RequestBodyCodec<never>) => update({ bodyCodec }),
    setUrlParam: (key: string, currentValue: QueryParamValueInput, replacementValue?: QueryParamValueInput) =>
      rawUpdate("urlParams", {
        urlParams:
          replacementValue === undefined
            ? setQueryParam(state.urlParams, key, currentValue)
            : replaceQueryParamValue(state.urlParams, key, currentValue as QueryParamValue, replacementValue),
      }),
    setUrlParams: (params) =>
      definition.urlParamsSchema === undefined
        ? update({ urlParams: setQueryParams(state.urlParams, params) })
        : update({ schemaUrlParams: params, hasSchemaUrlParams: true }),
    appendUrlParam: (key, value) =>
      rawUpdate("urlParams", { urlParams: appendQueryParam(state.urlParams, key, value) }),
    removeUrlParam: (key: string, value?: QueryParamValue) =>
      rawUpdate("urlParams", {
        urlParams:
          value === undefined
            ? removeQueryParam(state.urlParams, key)
            : removeQueryParamValue(state.urlParams, key, value),
      }),
    setHeader: (name: string, currentValue: HeaderValueInput, replacementValue?: HeaderValueInput) =>
      rawUpdate("headers", {
        headers:
          replacementValue === undefined
            ? setHeaderEntries(state.headers, [[name, currentValue]])
            : replaceHeaderEntryValue(state.headers, name, currentValue as string, replacementValue),
      }),
    setHeaders: (headers) =>
      definition.headersSchema === undefined
        ? update({ headers: setHeaderEntries(state.headers, headers) })
        : update({ schemaHeaders: headers, hasSchemaHeaders: true }),
    appendHeader: (name, value) => rawUpdate("headers", { headers: appendHeaderEntry(state.headers, name, value) }),
    removeHeader: (name: string, value?: string) =>
      rawUpdate("headers", { headers: removeHeaderEntry(state.headers, name, value) }),
    setCache: (cache) => update({ cache }),
    setResponseCodec: (responseCodec) => update({ responseCodec }),
    setUnhandledResponseBody: (unhandledResponseBody) => update({ unhandledResponseBody }),
    setBaseUrl: (baseUrl) => update({ baseUrl }),
    setTimeout: (timeout) => update({ timeout }),
    setRetry: (retry) => update({ retry: normalizeRetry(retry) }),
    setRetries: (retries) => update({ retry: normalizeRetry(retries) }),
    mapRequest: (transform) => update({ requestTransforms: [...state.requestTransforms, transform] }),
    mapClient: (transform) => update({ clientTransforms: [...state.clientTransforms, transform] }),
    setResponseSchema: <
      const Matcher extends ResponseMatcher,
      const S extends AnySchema,
      const Codec extends ResponseBodyCodecOrDefault = undefined,
    >(
      match: Matcher,
      schema: S,
      options?: CodecOptions<S, Codec>,
    ) => {
      const rule = response<Matcher, S, Codec>(match, schema, options);
      return makePlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady, H, Q>(
        definition,
        setResponseRule(rules, rule) as SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>,
        state,
      );
    },
    get effect() {
      return getEffect();
    },
  } satisfies InternalRequestPlan;

  return plan as unknown as RequestPlan<Body, Rules, BodyReady, H, Q>;
};
