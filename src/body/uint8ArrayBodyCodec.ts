import { HttpClientResponse } from "@effect/platform";
import { Effect } from "effect";
import { type ResponseBodyCodec } from "../request/types.js";

/** Byte response codec for finite binary payloads. */
export const uint8ArrayBodyCodec = {
  name: "uint8-array" as const,
  accept: "application/octet-stream",
  decode: (raw: HttpClientResponse.HttpClientResponse) =>
    Effect.map(raw.arrayBuffer, (buffer) => new Uint8Array(buffer)),
} satisfies ResponseBodyCodec<Uint8Array>;
