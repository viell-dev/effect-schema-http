import { ParseResult, Schema } from "effect";
import { EpochMillis, HttpDate, taggedBody } from "./common.js";

/**
 * Schemas for the 2011 notification service.
 *
 * Three of these exist only because the payload is wrapped in something that is not
 * JSON: an anti-hijacking guard, a JavaScript function call, and an HTML content type
 * over a JSON body. All three are read with `Body.text` and a schema, which is
 * the pairing the library documents for "another textual protocol".
 */

export const Notification = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("mention", "assignment", "note"),
  text: Schema.String,
  createdAt: EpochMillis,
  read: Schema.Boolean,
});
export type Notification = typeof Notification.Type;

/**
 * Strips the `)]}',` guard that prefixes this service's JSON.
 *
 * It made the payload invalid JavaScript so a `<script>` tag could not load it and read
 * the array through an overridden `Array` constructor. Browsers closed that hole in
 * 2011. The prefix outlived the attack by fifteen years, and every consumer still has to
 * take five bytes off the front before parsing — which means the default JSON codec
 * cannot be used at all, because `JSON.parse` sees a syntax error on the first character.
 */
export const XssiGuarded = <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, string, R> =>
  Schema.compose(
    Schema.transformOrFail(Schema.String, Schema.Unknown, {
      strict: true,
      decode: (raw, _options, ast) => {
        const guarded = raw.replace(/^\)\]\}',?\s*/u, "");
        if (guarded === raw) {
          return ParseResult.fail(new ParseResult.Type(ast, raw, "expected a )]}', guard before the payload"));
        }
        try {
          return ParseResult.succeed(JSON.parse(guarded) as unknown);
        } catch (cause) {
          return ParseResult.fail(new ParseResult.Type(ast, raw, `not JSON behind the guard: ${String(cause)}`));
        }
      },
      encode: (value) => ParseResult.succeed(`)]}',\n${JSON.stringify(value)}`),
    }),
    schema,
    { strict: false },
  );

/**
 * Reads a JSONP response, which is a JavaScript program rather than data.
 *
 * There is no safe general way to do this — evaluating it is the whole vulnerability —
 * so the only correct approach is to know the exact wrapper this service emits and
 * refuse anything else. A callback name that does not match, or any content between the
 * parentheses that is not a single JSON value, is a decode failure rather than something
 * to be clever about.
 */
export const Jsonp = <A, I, R>(callback: string, schema: Schema.Schema<A, I, R>): Schema.Schema<A, string, R> =>
  Schema.compose(
    Schema.transformOrFail(Schema.String, Schema.Unknown, {
      strict: true,
      decode: (raw, _options, ast) => {
        const escaped = callback.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const pattern = new RegExp(
          `^\\s*(?:/\\*\\*/)?\\s*typeof\\s+${escaped}\\s*===\\s*'function'\\s*&&\\s*${escaped}\\((.*)\\);?\\s*$`,
          "su",
        );
        const match = pattern.exec(raw);
        if (match === null) {
          return ParseResult.fail(new ParseResult.Type(ast, raw, `not a JSONP call to ${callback}`));
        }
        try {
          return ParseResult.succeed(JSON.parse(match[1] ?? "") as unknown);
        } catch (cause) {
          return ParseResult.fail(new ParseResult.Type(ast, raw, `the JSONP argument is not JSON: ${String(cause)}`));
        }
      },
      encode: (value) => ParseResult.succeed(`/**/ typeof ${callback} === 'function' && ${callback}(${JSON.stringify(value)});`),
    }),
    schema,
    { strict: false },
  );

/** Parses a JSON payload that arrived under a content type claiming it is something else. */
export const JsonText = <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, string, R> =>
  Schema.compose(
    Schema.transformOrFail(Schema.String, Schema.Unknown, {
      strict: true,
      decode: (raw, _options, ast) => {
        try {
          return ParseResult.succeed(JSON.parse(raw) as unknown);
        } catch (cause) {
          return ParseResult.fail(new ParseResult.Type(ast, raw, `not JSON: ${String(cause)}`));
        }
      },
      encode: (value) => ParseResult.succeed(JSON.stringify(value)),
    }),
    schema,
    { strict: false },
  );

export const Inbox = Schema.Struct({
  unread: Schema.Number,
  items: Schema.Array(Notification),
});

export const SessionToken = Schema.Struct({
  csrf_token: Schema.String,
  expires_in: Schema.Number,
});

/**
 * What the service says about its own retirement, read from response headers.
 *
 * Three headers saying the same thing, each added by a different person reading a
 * different draft: `Deprecation` (an RFC that never shipped), `Sunset` (RFC 8594, which
 * did), and `Warning` (RFC 7234, removed in RFC 9111). A client that wants to warn an
 * operator has to read all three, because no two services pick the same one.
 */
export const RetirementNotice = Schema.Struct({
  deprecation: Schema.Literal("true"),
  sunset: HttpDate,
  warning: Schema.String,
});

export const CreateNotification = Schema.Struct({
  kind: Schema.Literal("mention", "assignment", "note"),
  text: Schema.String.pipe(Schema.minLength(1)),
});

export const PollResult = Schema.Struct({
  events: Schema.Array(Notification),
  waited: Schema.Number,
});

export const ThrottleRelief = Schema.Struct({
  ok: Schema.Boolean,
  attempts: Schema.Number,
});

/** `420 Enhance Your Calm`, which predates `429` and was never registered. */
export const EnhanceYourCalm = taggedBody("EnhanceYourCalm", {
  error: Schema.Literal("enhance_your_calm"),
  attempt: Schema.Number,
});
export type EnhanceYourCalm = typeof EnhanceYourCalm.Type;

export const SignatureRejected = taggedBody("SignatureRejected", {
  error: Schema.Literal("invalid_signature"),
  detail: Schema.String,
});

export const CsrfRejected = taggedBody("CsrfRejected", {
  error: Schema.Literal("invalid_csrf"),
  detail: Schema.String,
});

export const PayloadRejected = taggedBody("PayloadRejected", {
  error: Schema.Literal("invalid_payload"),
  detail: Schema.String,
});
