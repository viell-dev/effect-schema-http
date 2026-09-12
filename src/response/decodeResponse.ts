import { HttpClientResponse } from "@effect/platform";
import { Effect, ParseResult, Schema } from "effect";
import { ResponseDecodeError } from "../errors/ResponseDecodeError.js";
import { type AnyResponseRule, type DefaultResponseBodyCodec } from "../request/types.js";

export const decodeResponse = (
  rule: AnyResponseRule,
  raw: HttpClientResponse.HttpClientResponse,
  defaultCodec: DefaultResponseBodyCodec,
) =>
  Effect.flatMap((rule.codec ?? defaultCodec).decode(raw), (value) =>
    rule.schema === undefined ? Effect.succeed(value) : Schema.decodeUnknown(rule.schema)(value),
  ).pipe(
    Effect.mapError((error) =>
      ParseResult.isParseError(error)
        ? new ResponseDecodeError({ responseTag: rule.match._tag, response: raw, cause: error })
        : error,
    ),
  );
