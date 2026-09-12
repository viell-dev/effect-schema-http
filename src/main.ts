/**
 * Public API for lazy, schema-driven Effect HTTP requests.
 *
 * @packageDocumentation
 */

export { createApi } from "./api/createApi.js";
export { createRequest } from "./api/createRequest.js";
export { extendApi } from "./api/extendApi.js";
export { mapEndpoint } from "./api/mapEndpoint.js";
export { RequestBody } from "./body/RequestBody.js";
export { ResponseBody } from "./body/ResponseBody.js";
export { AbsolutePathWithBaseUrl } from "./errors/AbsolutePathWithBaseUrl.js";
export { DuplicateResponseTag } from "./errors/DuplicateResponseTag.js";
export { InvalidPathArguments } from "./errors/InvalidPathArguments.js";
export { InvalidPathParameterValue } from "./errors/InvalidPathParameterValue.js";
export { InvalidRetryCount } from "./errors/InvalidRetryCount.js";
export { RequestBodyEncodeError } from "./errors/RequestBodyEncodeError.js";
export { RequestBodyNotAllowed } from "./errors/RequestBodyNotAllowed.js";
export { RequestBodyRequired } from "./errors/RequestBodyRequired.js";
export { ResponseDecodeError } from "./errors/ResponseDecodeError.js";
export { UnhandledResponse } from "./errors/UnhandledResponse.js";
export { attachHeaderEntries } from "./headers/attachHeaderEntries.js";
export { getHeaderEntries } from "./headers/getHeaderEntries.js";
export { HeaderEntriesTypeId } from "./headers/HeaderEntriesTypeId.js";
export { appendHeader } from "./request/appendHeader.js";
export { appendUrlParam } from "./request/appendUrlParam.js";
export { mapClient } from "./request/mapClient.js";
export { mapRequest } from "./request/mapRequest.js";
export { removeHeader } from "./request/removeHeader.js";
export { removeUrlParam } from "./request/removeUrlParam.js";
export { setBaseUrl } from "./request/setBaseUrl.js";
export { setBody } from "./request/setBody.js";
export { setCache } from "./request/setCache.js";
export { setHeader } from "./request/setHeader.js";
export { setHeaders } from "./request/setHeaders.js";
export { setRequestBodyCodec } from "./request/setRequestBodyCodec.js";
export { setResponseCodec } from "./request/setResponseCodec.js";
export { setResponseSchema } from "./request/setResponseSchema.js";
export { setRetries } from "./request/setRetries.js";
export { setRetry } from "./request/setRetry.js";
export { setTimeout } from "./request/setTimeout.js";
export { setUnhandledResponseBody } from "./request/setUnhandledResponseBody.js";
export { setUrlParam } from "./request/setUrlParam.js";
export { setUrlParams } from "./request/setUrlParams.js";
export { toEffect } from "./request/toEffect.js";
export {
  type AnyResponseRule,
  type Api,
  type ApiExtensionOptions,
  type ApiOptions,
  type BodyNotReady,
  type CachePolicy,
  type DefaultResponseBodyCodec,
  type Endpoint,
  type HeaderEntries,
  type HeaderInput,
  type HeaderMatcher,
  type HeaderPredicate,
  type HeaderRemoval,
  type HeaderValueInput,
  type PathArguments,
  type PathParameters,
  type QueryParamRemoval,
  type QueryParamValue,
  type QueryParamValueInput,
  type QueryParamsInput,
  type RequestBodyCodec,
  type RequestDefinition,
  type RequestMethod,
  type RequestOptions,
  type RequestPlan,
  type RequestPlanTransform,
  type ResponseBodyCodec,
  type ResponseEnvelope,
  type ResponseMatcher,
  type ResponseOf,
  type ResponseRule,
  type RetryInput,
  type RetryPolicy,
  type RetrySchedule,
  type StatusMatcher,
  type StatusPredicate,
  type UnhandledResponseBodyPolicy,
} from "./request/types.js";
export { response } from "./response/response.js";

export { GateClosed } from "./errors/GateClosed.js";
export { makeRequestGate } from "./gate/makeRequestGate.js";
export type { RequestGate, RequestGateOptions, RequestGateRunOptions } from "./gate/types.js";

export { SchemaHttp } from "./api/SchemaHttp.js";
export { UrlEncoding } from "./encoding/UrlEncoding.js";
export { RequestFieldsEncodeError } from "./errors/RequestFieldsEncodeError.js";

export type { RawHeaderPlanTransform, RawQueryPlanTransform } from "./request/types.js";
export type { PipeableEndpoint, ResponseBodyCodecOrDefault } from "./request/types.js";
