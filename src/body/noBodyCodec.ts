import { HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { type ResponseBodyCodec } from "../request/types.js";
import { discardResponseBody } from "./discardResponseBody.js";

/** Body-discarding codec used by rules that intentionally expect no value. */
export const noBodyCodec = {
  name: "none" as const,
  canBeDefault: false as const,
  decode: (raw: HttpClientResponse.HttpClientResponse) => Effect.as(discardResponseBody(raw), undefined),
} satisfies ResponseBodyCodec<undefined, false>;
