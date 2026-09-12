import type { HttpClientResponse } from "@effect/platform";
import { Effect, Schema } from "effect";
import { ResponseBody, type ResponseBodyCodec } from "../../src/main.js";

/**
 * This service identifies a created item by a literal UUID in Location's last path segment, or a JSON { id } body.
 * Location is inspected as data; it is never followed. The response rule still matches only status and headers.
 */
export const createdIdCodec = {
  name: "catalog-created-id",
  canBeDefault: false,
  decode: (raw: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      const path = raw.headers.location?.split(/[?#]/u)[0];
      const id = path?.split("/").at(-1);
      if (Schema.is(Schema.UUID)(id)) {
        // The body can be absent or non-JSON, but this branch must still release it.
        yield* ResponseBody.none.decode(raw);
        return { id };
      }
      // The selected response schema validates the fallback body's id too.
      return yield* ResponseBody.json.decode(raw);
    }),
} satisfies ResponseBodyCodec<unknown, false>;
