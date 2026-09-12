import { Schema } from "effect";
import type { AnyResponseBodyCodec } from "../request/types.js";
import {
  type AnySchema,
  type CodecOptions,
  type ResponseBodyCodecOrDefault,
  type ResponseMatcher,
  type ResponseRule,
} from "../request/types.js";

/**
 * Defines one typed response rule.
 *
 * @param match - Response-selection conditions with a unique `_tag`.
 * @param schema - Schema used after the response body codec.
 * @param options - Optional rule-specific codec.
 * @returns A response rule suitable for an API or request declaration.
 * @public
 */
export function response<const Matcher extends ResponseMatcher, const Codec extends AnyResponseBodyCodec>(
  match: Matcher,
  codec: Codec,
): ResponseRule<Matcher, undefined, Codec>;
export function response<
  const Matcher extends ResponseMatcher,
  const S extends AnySchema,
  const Codec extends ResponseBodyCodecOrDefault = undefined,
>(match: Matcher, schema: S, options?: CodecOptions<S, Codec>): ResponseRule<Matcher, S, Codec>;
export function response(
  match: ResponseMatcher,
  body: AnySchema | AnyResponseBodyCodec,
  options?: { readonly codec: AnyResponseBodyCodec },
): ResponseRule<ResponseMatcher, AnySchema | undefined, ResponseBodyCodecOrDefault> {
  return Schema.isSchema(body)
    ? { match, schema: body, codec: options?.codec }
    : { match, schema: undefined, codec: body };
}
