import { createRequestInternal } from "../request/createRequestInternal.js";
import { pipeSelf } from "../request/pipeSelf.js";
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
import { mergeRequestOptions } from "./mergeRequestOptions.js";

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
      const responses = mergeResponseRules(options.responses ?? [], overrides.responses ?? []);
      return createApi<MergeResponseRules<Defaults, Overrides>>(overrides.baseUrl ?? baseUrl, {
        ...mergeRequestOptions(options, overrides),
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
