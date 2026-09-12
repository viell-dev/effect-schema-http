import { Schema } from "effect";
import { RequestBody } from "../body/RequestBody.js";
import { ResponseBody } from "../body/ResponseBody.js";
import { fillPath } from "../encoding/fillPath.js";
import { splitPathUrlParams } from "../encoding/splitPathUrlParams.js";
import { headerEntriesFromInput } from "../headers/headerEntriesFromInput.js";
import { removeHeaderEntries } from "../headers/removeHeaderEntries.js";
import { setHeaderEntries } from "../headers/setHeaderEntries.js";
import { makePipeableEndpoint } from "./makePipeableEndpoint.js";
import { makePlan } from "./makePlan.js";
import { queryParamsFromInput } from "./query/queryParamsFromInput.js";
import { removeQueryParams } from "./query/removeQueryParams.js";
import { setQueryParams } from "./query/setQueryParams.js";
import { normalizeRetry } from "./retry/normalizeRetry.js";
import type { AnyRequestBody, HeaderInput, QueryParamsInput } from "./types.js";
import {
  type AnyResponseRule,
  type AnySchema,
  type Endpoint,
  type InternalDefinition,
  type PathArguments,
} from "./types.js";

export const createRequestInternal = <
  Path extends string,
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
>(
  definition: InternalDefinition<Body>,
  rules: Rules,
): Endpoint<Path, Body, Rules, BodyReady, H, Q> => {
  const endpoint = (...pathArguments: PathArguments<Path>) => {
    const filled = splitPathUrlParams(
      fillPath(
        definition.path,
        pathArguments,
        (definition.urlEncoding ?? definition.baseOptions?.urlEncoding)?.pathParameter,
      ),
    );
    const baseHeaders = removeHeaderEntries(
      headerEntriesFromInput(definition.baseOptions?.headers),
      definition.removeHeaders,
    );
    const headers = setHeaderEntries(
      baseHeaders,
      (definition.headersSchema === undefined ? (definition.headers ?? {}) : {}) as HeaderInput,
    );
    const baseParams = removeQueryParams(
      queryParamsFromInput(definition.baseOptions?.urlParams ?? {}),
      definition.removeUrlParams,
    );
    const pathParams = setQueryParams(baseParams, filled.urlParams);
    const urlParams = setQueryParams(
      pathParams,
      (definition.urlParamsSchema === undefined ? (definition.urlParams ?? {}) : {}) as QueryParamsInput,
    );
    const requestTransforms = [definition.baseOptions?.transformRequest, definition.transformRequest].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );
    const clientTransforms = [definition.baseOptions?.transformClient, definition.transformClient].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );
    const retry = normalizeRetry(
      definition.retry ?? definition.retries ?? definition.baseOptions?.retry ?? definition.baseOptions?.retries,
    );

    return makePlan<Body, Rules, BodyReady, H, Q>({ ...definition, path: filled.path }, rules, {
      schemaHeaders: definition.headers,
      hasSchemaHeaders: Object.hasOwn(definition, "headers"),
      schemaUrlParams: definition.urlParams,
      hasSchemaUrlParams: Object.hasOwn(definition, "urlParams"),
      baseUrl: definition.baseUrl,
      body: definition.defaultBody,
      hasBody: definition.defaultBody !== undefined,
      bodyCodec:
        definition.bodyCodec ??
        (definition.body !== undefined && !Schema.isSchema(definition.body) ? definition.body : RequestBody.json),
      headers,
      urlParams,
      responseCodec: definition.responseCodec ?? definition.baseOptions?.responseCodec ?? ResponseBody.json,
      unhandledResponseBody:
        definition.unhandledResponseBody ?? definition.baseOptions?.unhandledResponseBody ?? "discard",
      cache: definition.cache ?? definition.baseOptions?.cache,
      timeout: definition.timeout ?? definition.baseOptions?.timeout,
      retry,
      requestTransforms,
      clientTransforms,
    });
  };
  return makePipeableEndpoint(endpoint);
};
