import { createRequestInternal } from "../request/createRequestInternal.js";
import type { AnyRequestBody, RequestOptions } from "../request/types.js";
import {
  type AnyResponseRule,
  type AnySchema,
  type Endpoint,
  type InitialBodyReady,
  type RequestDefinition,
  type RequestMethod,
} from "../request/types.js";
import { validateUniqueResponseTags } from "../response/validateUniqueResponseTags.js";

/**
 * Creates a standalone lazy endpoint from a request definition.
 *
 * @remarks
 * Calling the returned endpoint only constructs an immutable request plan. No provider is selected and no I/O occurs
 * until its Effect is executed.
 *
 * @param definition - HTTP method, path, schemas, response rules, and defaults.
 * @returns A callable, pipeable endpoint.
 * @public
 */
export const createRequest = <
  const Method extends RequestMethod,
  const Path extends string,
  Body extends AnyRequestBody | undefined = undefined,
  const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
  const DefaultBody = undefined,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
>(
  definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody, H, Q>,
  defaults: RequestOptions = {},
): Endpoint<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>, H, Q> => {
  validateUniqueResponseTags(definition.responses ?? [], "request");
  return createRequestInternal<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>, H, Q>(
    { ...definition, baseOptions: defaults },
    definition.responses ?? ([] as unknown as Rules),
  );
};
