import { formDataBodyCodec } from "./formDataBodyCodec.js";
import { jsonBodyCodec } from "./jsonBodyCodec.js";
import { noBodyCodec } from "./noBodyCodec.js";
import { textBodyCodec } from "./textBodyCodec.js";
import { uint8ArrayBodyCodec } from "./uint8ArrayBodyCodec.js";

/** Built-in response-body codecs. */
export const ResponseBody = {
  /** Parses non-empty response text as JSON. */
  json: jsonBodyCodec,
  /** Returns response text, including an empty string. */
  text: textBodyCodec,
  /** Returns a finite response body as bytes. */
  uint8Array: uint8ArrayBodyCodec,
  /** Parses a finite multipart or URL-encoded response as form data. */
  formData: formDataBodyCodec,
  /** Drains the response and yields `undefined`; only valid as a rule-specific codec. */
  none: noBodyCodec,
} as const;
