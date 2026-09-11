import { DateTime, ParseResult, Schema } from "effect";

/**
 * Schema pieces that more than one service needs.
 *
 * Nothing here is service-specific. Each of these exists because at least two of the
 * five backends independently invented the same bad idea, which is itself the point:
 * the wire conventions repeat, the services do not agree on which one to use, and the
 * client is where they have to be reconciled.
 */

/**
 * A value several services send as a space-delimited string where the relevant
 * specification asks for an array.
 *
 * The ID server does it for `scope` (where OAuth 2.0 agrees) and for
 * `grant_types_supported` (where it does not). Both decode through this, and both
 * re-encode to the same flat string, so a value read from one endpoint can be sent
 * back to another.
 */
export const SpaceDelimited = <A, R>(member: Schema.Schema<A, string, R>): Schema.Schema<ReadonlyArray<A>, string, R> =>
  Schema.transform(Schema.String, Schema.Array(member), {
    strict: true,
    decode: (raw) => raw.split(/[\s,]+/u).filter((part) => part.length > 0),
    encode: (values) => values.join(" "),
  });

/**
 * `"Y"`/`"N"` as a boolean.
 *
 * The LDAP gateway in front of the ID server's directory endpoint emits it, and so does
 * the Java billing record, which learned it from the same mainframe extract. Anything
 * else — `"y"`, `"1"`, `"true"` — is a decode failure rather than a silent `false`.
 */
export const YesNo = Schema.transform(Schema.Literal("Y", "N"), Schema.Boolean, {
  strict: true,
  decode: (flag) => flag === "Y",
  encode: (value) => (value ? ("Y" as const) : ("N" as const)),
});

const pad = (value: number, width: number): string => value.toString().padStart(width, "0");

/**
 * LDAP generalized time: `YYYYMMDDHHMMSSZ`, no separators.
 *
 * Decodes to an Effect `DateTime.Utc` rather than a bare `Date`, and fails rather than
 * guessing when the value does not match — a directory that answers with a blank or a
 * partial timestamp should surface as a decode failure, not as the epoch.
 */
export const LdapGeneralizedTime = Schema.transformOrFail(Schema.String, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (raw, _options, ast) => {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u.exec(raw.trim());
    if (match === null) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected LDAP generalized time YYYYMMDDHHMMSSZ"));
    }
    const [, year, month, day, hour, minute, second] = match;
    return ParseResult.succeed(DateTime.unsafeMake(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`));
  },
  encode: (value) => {
    const parts = DateTime.toParts(value);
    return ParseResult.succeed(
      `${pad(parts.year, 4)}${pad(parts.month, 2)}${pad(parts.day, 2)}` +
        `${pad(parts.hours, 2)}${pad(parts.minutes, 2)}${pad(parts.seconds, 2)}Z`,
    );
  },
});

/**
 * Epoch milliseconds as a JSON number, decoded to an Effect `DateTime.Utc`.
 *
 * The Java API server emits these because `System.currentTimeMillis()` was the obvious
 * thing to call in 2014, and the Ruby notification service copied the convention so the
 * two would at least agree with each other.
 */
export const EpochMillis = Schema.transform(Schema.Number, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (millis) => DateTime.unsafeMake(millis),
  encode: (value) => DateTime.toEpochMillis(value),
});

/**
 * A blank string treated as an absent value.
 *
 * Three of the five services use `""` where they mean "nothing", so the distinction
 * between "absent", "null" and "empty" has to be collapsed somewhere. Doing it in the
 * schema keeps `if (value === "")` out of every view.
 */
export const BlankAsNull = <A, R>(member: Schema.Schema<A, string, R>): Schema.Schema<A | null, string, R> =>
  Schema.transform(Schema.String, Schema.NullOr(member), {
    strict: true,
    decode: (raw) => (raw.trim() === "" ? null : raw),
    encode: (value) => value ?? "",
  });

/**
 * An HTTP-date (RFC 9110 §5.6.7) as found in `Retry-After` and `Expires`.
 *
 * `Date.parse` accepts it, but it accepts a great deal else too, so the shape is checked
 * before the value is trusted: a `Retry-After` of `"120"` must not decode as a date.
 */
export const HttpDate = Schema.transformOrFail(Schema.String, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (raw, _options, ast) => {
    const trimmed = raw.trim();
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed) || !/GMT$/u.test(trimmed)) {
      return ParseResult.fail(new ParseResult.Type(ast, raw, "expected an HTTP-date ending in GMT"));
    }
    return ParseResult.succeed(DateTime.unsafeMake(parsed));
  },
  encode: (value) => ParseResult.succeed(new Date(DateTime.toEpochMillis(value)).toUTCString()),
});

/**
 * `Retry-After` in either of the two forms RFC 9110 allows, normalized to seconds.
 *
 * The ID server's rate limiter emits the date form and the Ruby service emits the
 * integer form, so a caller that wants to display "try again in N seconds" needs both.
 */
export const RetryAfterSeconds = Schema.transformOrFail(Schema.String, Schema.Number, {
  strict: true,
  decode: (raw, options, ast) => {
    const trimmed = raw.trim();
    if (/^\d+$/u.test(trimmed)) return ParseResult.succeed(Number(trimmed));
    return ParseResult.decodeUnknown(HttpDate)(trimmed, options).pipe(
      ParseResult.mapBoth({
        onFailure: () => new ParseResult.Type(ast, raw, "expected delay-seconds or an HTTP-date"),
        onSuccess: (value) => secondsUntil(value),
      }),
    );
  },
  encode: (seconds) => ParseResult.succeed(String(Math.max(0, Math.round(seconds)))),
});

/** Seconds from now until a moment, floored at zero. */
export const secondsUntil = (value: DateTime.Utc, now = Date.now()): number =>
  Math.max(0, Math.round((DateTime.toEpochMillis(value) - now) / 1000));

/**
 * A response-body schema whose `_tag` is attached on decode rather than transmitted.
 *
 * This is the single most important difference between this repository and its
 * sibling. When one codebase owns both ends, `Schema.TaggedError` is the obvious
 * choice: the server encodes an instance, the client decodes the same class, and the
 * `_tag` travels on the wire because both ends agree it should. None of the five
 * services here has ever heard of Effect. Their error payloads are
 * `{"error":…,"error_description":…}` and `{"message":…}`, with no discriminant
 * anywhere, so a `Schema.TaggedError` used as a response schema simply fails to
 * decode — the field it requires is not there and never will be.
 *
 * `Schema.attachPropertySignature` is the tool for that: the encoded side stays exactly
 * what the service sends, and the decoded value gains a discriminant the client chose.
 * `Match.tag` then works over bodies as well as over response envelopes, and encoding
 * strips the tag again so a value can be sent back to a service that would not
 * recognize it.
 */
export const taggedBody = <const Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) =>
  Schema.Struct(fields).pipe(Schema.attachPropertySignature("_tag", tag));
