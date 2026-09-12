import { HttpClient, HttpClientRequest } from "@effect/platform";
import { headerEntriesFromInput } from "../headers/headerEntriesFromInput.js";
import { removeHeaderEntries } from "../headers/removeHeaderEntries.js";
import { setHeaderEntries } from "../headers/setHeaderEntries.js";
import { createRequestInternal } from "../request/createRequestInternal.js";
import { pipeSelf } from "../request/pipeSelf.js";
import { queryParamsFromInput } from "../request/query/queryParamsFromInput.js";
import { removeQueryParams } from "../request/query/removeQueryParams.js";
import { setQueryParams } from "../request/query/setQueryParams.js";
import type { AnyRequestBody } from "../request/types.js";
import {
  type AnyResponseRule,
  type AnySchema,
  type Api,
  type ApiExtensionOptions,
  type ApiOptions,
  type Endpoint,
  type InitialBodyReady,
  type MergeResponseRules,
  type RequestDefinition,
  type RequestMethod,
} from "../request/types.js";
import { mergeResponseRules } from "../response/mergeResponseRules.js";
import { validateUniqueResponseTags } from "../response/validateUniqueResponseTags.js";

/**
 * Creates a reusable API configuration.
 *
 * @param baseUrl - Base URL prepended to relative endpoint paths.
 * @param options - Shared request options and response rules.
 * @returns A pipeable API builder.
 * @public
 */
export const createApi = <const Defaults extends ReadonlyArray<AnyResponseRule> = readonly []>(
  baseUrl: string,
  options: ApiOptions<Defaults> = {} as ApiOptions<Defaults>,
): Api<Defaults> => {
  validateUniqueResponseTags(options.responses ?? [], "api");
  return {
    pipe: pipeSelf,
    baseUrl,
    extend: <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(
      overrides: ApiExtensionOptions<Overrides>,
    ): Api<MergeResponseRules<Defaults, Overrides>> => {
      validateUniqueResponseTags(overrides.responses ?? [], "api");
      const baseRequestTransform = options.transformRequest;
      const overrideRequestTransform = overrides.transformRequest;
      const baseClientTransform = options.transformClient;
      const overrideClientTransform = overrides.transformClient;
      const retry =
        overrides.retry ??
        (overrides.retries !== undefined
          ? { times: overrides.retries }
          : (options.retry ?? (options.retries !== undefined ? { times: options.retries } : undefined)));
      const responses = mergeResponseRules(options.responses ?? [], overrides.responses ?? []);
      const responseCodec = overrides.responseCodec ?? options.responseCodec;
      const unhandledResponseBody = overrides.unhandledResponseBody ?? options.unhandledResponseBody;
      const cache = overrides.cache ?? options.cache;
      const timeout = overrides.timeout ?? options.timeout;
      const transformRequest =
        baseRequestTransform === undefined
          ? overrideRequestTransform
          : overrideRequestTransform === undefined
            ? baseRequestTransform
            : (request: HttpClientRequest.HttpClientRequest) => overrideRequestTransform(baseRequestTransform(request));
      const transformClient =
        baseClientTransform === undefined
          ? overrideClientTransform
          : overrideClientTransform === undefined
            ? baseClientTransform
            : (client: HttpClient.HttpClient) => overrideClientTransform(baseClientTransform(client));

      const urlEncoding = overrides.urlEncoding ?? options.urlEncoding;
      const diagnostics = overrides.diagnostics ?? options.diagnostics;
      return createApi<MergeResponseRules<Defaults, Overrides>>(overrides.baseUrl ?? baseUrl, {
        ...(urlEncoding === undefined ? {} : { urlEncoding }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
        headers: setHeaderEntries(
          removeHeaderEntries(headerEntriesFromInput(options.headers), overrides.removeHeaders),
          overrides.headers ?? {},
        ),
        urlParams: setQueryParams(
          removeQueryParams(queryParamsFromInput(options.urlParams ?? {}), overrides.removeUrlParams),
          overrides.urlParams ?? {},
        ),
        ...(responseCodec === undefined ? {} : { responseCodec }),
        ...(unhandledResponseBody === undefined ? {} : { unhandledResponseBody }),
        ...(cache === undefined ? {} : { cache }),
        ...(timeout === undefined ? {} : { timeout }),
        ...(retry === undefined ? {} : { retry }),
        ...(transformRequest === undefined ? {} : { transformRequest }),
        ...(transformClient === undefined ? {} : { transformClient }),
        responses: responses as MergeResponseRules<Defaults, Overrides>,
      });
    },
    createRequest: <
      const Method extends RequestMethod,
      const Path extends string,
      Body extends AnyRequestBody | undefined = undefined,
      const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
      const DefaultBody = undefined,
      H extends AnySchema | undefined = undefined,
      Q extends AnySchema | undefined = undefined,
    >(
      definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody, H, Q>,
    ): Endpoint<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>, H, Q> => {
      validateUniqueResponseTags(definition.responses ?? [], "request");
      const rules = mergeResponseRules(options.responses ?? [], definition.responses ?? []);
      return createRequestInternal<
        Path,
        Body,
        MergeResponseRules<Defaults, Rules>,
        InitialBodyReady<Body, DefaultBody>,
        H,
        Q
      >({ ...definition, baseUrl, baseOptions: options }, rules as MergeResponseRules<Defaults, Rules>);
    },
  };
};
