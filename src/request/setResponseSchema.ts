import type { AnyRequestBody } from "./types.js";
import {
  type AnyResponseRule,
  type AnySchema,
  type CodecOptions,
  type RequestPlan,
  type ResponseBodyCodecOrDefault,
  type ResponseMatcher,
  type ResponseRule,
  type SetResponseRule,
} from "./types.js";

/** Pipeable form of {@link RequestPlan.setResponseSchema}. */
export const setResponseSchema =
  <
    const Matcher extends ResponseMatcher,
    const S extends AnySchema,
    const Codec extends ResponseBodyCodecOrDefault = undefined,
  >(
    match: Matcher,
    schema: S,
    options?: CodecOptions<S, Codec>,
  ) =>
  <
    Body extends AnyRequestBody | undefined,
    Rules extends ReadonlyArray<AnyResponseRule>,
    BodyReady extends boolean,
    H extends AnySchema | undefined = undefined,
    Q extends AnySchema | undefined = undefined,
  >(
    plan: RequestPlan<Body, Rules, BodyReady, H, Q>,
  ): RequestPlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady, H, Q> =>
    plan.setResponseSchema<Matcher, S, Codec>(match, schema, options);
