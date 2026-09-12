import { HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { type ResponseBodyCodec } from "../request/types.js";
import { responseBodyError } from "./responseBodyError.js";

/** Default JSON response codec, implemented through text parsing for consistent empty-body handling. */
export const jsonBodyCodec = {
  name: "json" as const,
  accept: "application/json",
  decode: (raw: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(raw.text, (text) =>
      text.trim() === ""
        ? Effect.fail(responseBodyError(raw, "EmptyBody"))
        : Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: (cause) => responseBodyError(raw, "Decode", cause),
          }),
    ),
} satisfies ResponseBodyCodec<unknown>;
