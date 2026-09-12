import { HttpClient, HttpClientRequest } from "@effect/platform";
import { headerEntriesFromInput } from "../headers/headerEntriesFromInput.js";
import { removeHeaderEntries } from "../headers/removeHeaderEntries.js";
import { setHeaderEntries } from "../headers/setHeaderEntries.js";
import { queryParamsFromInput } from "../request/query/queryParamsFromInput.js";
import { removeQueryParams } from "../request/query/removeQueryParams.js";
import { setQueryParams } from "../request/query/setQueryParams.js";
import type { ApiExtensionOptions, RequestOptions } from "../request/types.js";

/** Compose shared options without evaluating computed declarations or executing transforms. */
export const mergeRequestOptions = (
  options: RequestOptions,
  overrides: RequestOptions & Pick<ApiExtensionOptions, "removeHeaders" | "removeUrlParams">,
): RequestOptions => {
  const baseRequestTransform = options.transformRequest;
  const overrideRequestTransform = overrides.transformRequest;
  const baseClientTransform = options.transformClient;
  const overrideClientTransform = overrides.transformClient;
  const retry =
    overrides.retry ??
    (overrides.retries !== undefined
      ? { times: overrides.retries }
      : (options.retry ?? (options.retries !== undefined ? { times: options.retries } : undefined)));
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
  return {
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
  };
};
