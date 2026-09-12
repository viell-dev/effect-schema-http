import { HttpClientResponse } from "@effect/platform";
import { type ResponseBodyCodec } from "../request/types.js";

/** Form-data response codec for finite multipart or URL-encoded payloads. */
export const formDataBodyCodec = {
  name: "form-data" as const,
  accept: "multipart/form-data",
  decode: (raw: HttpClientResponse.HttpClientResponse) => raw.formData,
} satisfies ResponseBodyCodec<FormData>;
