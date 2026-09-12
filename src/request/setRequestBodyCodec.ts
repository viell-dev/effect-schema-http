import type { AnyRequestBody, RequestBodyEncoded } from "./types.js";
import { type AnyResponseRule, type AnySchema, type RequestBodyCodec, type RequestPlan } from "./types.js";

/** Pipeable form of {@link RequestPlan.setRequestBodyCodec}. */
export const setRequestBodyCodec =
  <Input>(codec: RequestBodyCodec<Input>) =>
  <
    Body extends AnyRequestBody,
    Rules extends ReadonlyArray<AnyResponseRule>,
    BodyReady extends boolean,
    H extends AnySchema | undefined = undefined,
    Q extends AnySchema | undefined = undefined,
  >(
    plan: RequestBodyEncoded<Body> extends Input ? RequestPlan<Body, Rules, BodyReady, H, Q> : never,
  ): RequestPlan<Body, Rules, BodyReady, H, Q> =>
    plan.setRequestBodyCodec(codec as RequestBodyCodec<RequestBodyEncoded<Body>>);
