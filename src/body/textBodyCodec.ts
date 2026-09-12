import { HttpClientResponse } from "@effect/platform";
import { type ResponseBodyCodec } from "../request/types.js";

/** Text response codec that preserves an empty body as an empty string. */
export const textBodyCodec = {
  name: "text" as const,
  accept: "text/*",
  decode: (raw: HttpClientResponse.HttpClientResponse) => raw.text,
} satisfies ResponseBodyCodec<string>;
