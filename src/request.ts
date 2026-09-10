/**
 * Lazy, schema-driven HTTP request plans and API builders.
 *
 * @packageDocumentation
 */
import {
  Cookies,
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  type HttpMethod,
  UrlParams,
} from "@effect/platform";
import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Option,
  ParseResult,
  Schedule,
  ScheduleDecision,
  ScheduleIntervals,
  Schema,
  Stream,
} from "effect";
import { dual } from "effect/Function";
import type * as Pipeable from "effect/Pipeable";

/** Applies pipeable operations to the current value. */
const pipeSelf = function (this: unknown, ...operations: ReadonlyArray<(value: unknown) => unknown>): unknown {
  return operations.reduce<unknown>((value, operation) => operation(value), this);
} as Pipeable.Pipeable["pipe"];

/** Any Effect Schema accepted by the request builder. */
type AnySchema = Schema.Schema.Any;

/** An HTTP method token. Arbitrary extension methods are supported. */
export type RequestMethod = string;

/** A query parameter value; `true` serializes as a bare parameter without `=`. */
export type QueryParamValue = string | true;

/** Accepted query parameter collections, including repeated values. */
export type QueryParamsInput =
  | Readonly<Record<string, QueryParamValue | ReadonlyArray<QueryParamValue> | undefined>>
  | Iterable<readonly [string, QueryParamValue]>
  | URLSearchParams;

/** Canonical ordered query parameter representation. */
type QueryParams = ReadonlyArray<readonly [string, QueryParamValue]>;

/** Removes every value by name, or one exact name/value pair. */
export type QueryParamRemoval = string | { readonly name: string; readonly value?: QueryParamValue };

/** Header inputs accepted by Effect Platform. */
export type HeaderInput = Headers.Input;

/** Ordered HTTP header fields that preserve repeated field lines. */
export type HeaderEntries = ReadonlyArray<readonly [name: string, value: string]>;

/** Removes every field by name, or one exact name/value pair. */
export type HeaderRemoval = string | { readonly name: string; readonly value?: string };

/** Symbol used by providers to retain repeated header field lines on a message. */
export const HeaderEntriesTypeId: unique symbol = Symbol.for(
  "viell-effect-schema-http/HeaderEntries",
) as typeof HeaderEntriesTypeId;

/** Structural carrier for provider-preserved header entries. */
interface HeaderEntriesCarrier {
  readonly [HeaderEntriesTypeId]?: HeaderEntries;
}

/** Converts supported header input into canonical lower-case entries. */
const headerEntriesFromInput = (input: HeaderInput | undefined): HeaderEntries => {
  if (input === undefined) return [];
  if (Symbol.iterator in input) {
    return Array.from(input, ([name, value]) => [name.toLowerCase(), value] as const);
  }

  return Object.entries(input).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return Array.isArray(value)
      ? value.map((item) => [name.toLowerCase(), item] as const)
      : [[name.toLowerCase(), value as string] as const];
  });
};

/**
 * Attaches lossless ordered header entries to a request or response object.
 *
 * @remarks
 * Providers can use this hook when their native header representation preserves repeated fields. The attachment is
 * non-enumerable and does not alter the message's normalized `headers` value.
 *
 * @param message - Message that should carry the entries.
 * @param input - Header entries to retain.
 * @returns The same message instance.
 * @public
 */
export const attachHeaderEntries = <Message extends object>(message: Message, input: HeaderInput): Message => {
  Object.defineProperty(message, HeaderEntriesTypeId, {
    configurable: true,
    value: headerEntriesFromInput(input),
  });
  return message;
};

/**
 * Reads lossless header entries from a message, falling back to normalized headers and parsed cookies.
 *
 * @param message - Request or response-like message.
 * @returns Ordered lower-case header entries.
 * @public
 */
export const getHeaderEntries = (message: {
  readonly headers: Headers.Headers;
  readonly cookies?: unknown;
}): HeaderEntries => {
  const attached = (message as HeaderEntriesCarrier)[HeaderEntriesTypeId];
  if (attached !== undefined) return attached;

  const entries = headerEntriesFromInput(message.headers);
  if (!Cookies.isCookies(message.cookies)) return entries;
  const setCookie = Cookies.toSetCookieHeaders(message.cookies);
  return setCookie.length === 0
    ? entries
    : [
        ...entries.filter(([name]) => name !== "set-cookie"),
        ...setCookie.map((value) => ["set-cookie", value] as const),
      ];
};

/** Produces Effect Platform's normalized header map from ordered entries. */
const normalizeHeaderEntries = (entries: HeaderEntries): Headers.Headers => {
  const grouped: Record<string, Array<string>> = {};
  for (const [name, value] of entries) (grouped[name] ??= []).push(value);
  return Headers.fromInput(grouped);
};

/** Reconciles provider-preserved entries with request transforms applied to normalized headers. */
const reconcileHeaderEntries = (entries: HeaderEntries, headers: Headers.Headers): HeaderEntries => {
  const normalized = normalizeHeaderEntries(entries);
  const names = new Set<string>();
  const reconciled: Array<readonly [string, string]> = [];

  for (const [name] of entries) {
    if (names.has(name)) continue;
    names.add(name);
    const value = headers[name];
    if (value === undefined) continue;
    if (normalized[name] === value) {
      reconciled.push(...entries.filter(([candidate]) => candidate === name));
    } else {
      reconciled.push([name, value]);
    }
  }

  for (const [name, value] of Object.entries(headers)) {
    if (!names.has(name)) reconciled.push([name, value]);
  }

  return reconciled;
};

/** Replaces all existing values for names present in the incoming input. */
const setHeaderEntries = (entries: HeaderEntries, input: HeaderInput): HeaderEntries => {
  const incoming = headerEntriesFromInput(input);
  const names = new Set(incoming.map(([name]) => name));
  return [...incoming, ...entries.filter(([name]) => !names.has(name))];
};

/** Appends one header field without replacing existing values. */
const appendHeaderEntry = (entries: HeaderEntries, name: string, value: string): HeaderEntries => [
  ...entries,
  [name.toLowerCase(), value],
];

/** Replaces every exact occurrence of one header name/value pair. */
const replaceHeaderEntryValue = (
  entries: HeaderEntries,
  name: string,
  currentValue: string,
  replacementValue: string,
): HeaderEntries => {
  const canonicalName = name.toLowerCase();
  return entries.map((entry) =>
    entry[0] === canonicalName && entry[1] === currentValue ? ([canonicalName, replacementValue] as const) : entry,
  );
};

/** Removes all fields by name, or only fields having an exact value. */
const removeHeaderEntry = (entries: HeaderEntries, name: string, value?: string): HeaderEntries => {
  const canonicalName = name.toLowerCase();
  return entries.filter(
    ([candidateName, candidateValue]) =>
      candidateName !== canonicalName || (value !== undefined && candidateValue !== value),
  );
};

/** Applies ordered header removals. */
const removeHeaderEntries = (
  entries: HeaderEntries,
  removals: ReadonlyArray<HeaderRemoval> | undefined,
): HeaderEntries =>
  (removals ?? []).reduce(
    (current, removal) =>
      typeof removal === "string"
        ? removeHeaderEntry(current, removal)
        : removeHeaderEntry(current, removal.name, removal.value),
    entries,
  );

/**
 * Serializes schema-encoded request values into HTTP request bodies.
 *
 * @typeParam Input - Encoded schema value consumed by the codec.
 * @public
 */
export interface RequestBodyCodec<Input = unknown> {
  /** Human-readable codec identifier. */
  readonly name: string;
  /** Adds the serialized value to an immutable request. */
  readonly encode: (
    input: Input,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>;
}

/** Default JSON request-body codec. */
const jsonRequestBodyCodec = {
  name: "json" as const,
  encode: (input: unknown, request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.bodyJson(request, input),
} satisfies RequestBodyCodec<unknown>;

/** Built-in request-body codecs. */
export const RequestBody = {
  /** Serializes an arbitrary JSON-compatible value. */
  json: jsonRequestBodyCodec,
  /** Serializes a string, optionally with an explicit content type. */
  text: (contentType?: string) =>
    ({
      name: "text" as const,
      encode: (input: string, request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientRequest.bodyText(request, input, contentType)),
    }) satisfies RequestBodyCodec<string>,
  /** Serializes bytes, optionally with an explicit content type. */
  uint8Array: (contentType?: string) =>
    ({
      name: "uint8-array" as const,
      encode: (input: Uint8Array, request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientRequest.bodyUint8Array(request, input, contentType)),
    }) satisfies RequestBodyCodec<Uint8Array>,
  /** Serializes URL-encoded form parameters. */
  urlParams: {
    name: "url-params" as const,
    encode: (input: UrlParams.Input, request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientRequest.bodyUrlParams(request, input)),
  } satisfies RequestBodyCodec<UrlParams.Input>,
  /** Serializes browser-compatible multipart form data. */
  formData: {
    name: "form-data" as const,
    encode: (input: FormData, request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientRequest.bodyFormData(request, input)),
  } satisfies RequestBodyCodec<FormData>,
} as const;

/** Selects a response when its numeric status satisfies the predicate. */
export type StatusPredicate = (status: number) => boolean;

/** Selects a response from a normalized header value and all original field values. */
export type HeaderPredicate = (value: string | undefined, values: ReadonlyArray<string>) => boolean;

/** Exact status code or status predicate used by a response matcher. */
export type StatusMatcher = number | StatusPredicate;

/** Exact normalized header value or predicate used by a response matcher. */
export type HeaderMatcher = string | HeaderPredicate;

/**
 * Identifies one possible response using a unique tag, status condition, and optional header conditions.
 *
 * @typeParam Tag - Unique discriminant copied to the response envelope.
 * @typeParam Status - Exact status or predicate.
 * @typeParam MatchHeaders - Header matchers applied after the status matches.
 * @public
 */
export interface ResponseMatcher<
  Tag extends string = string,
  Status extends StatusMatcher = StatusMatcher,
  MatchHeaders extends Readonly<Record<string, HeaderMatcher>> | undefined =
    Readonly<Record<string, HeaderMatcher>> | undefined,
> {
  /** Unique response discriminant compatible with `Match.tag`. */
  readonly _tag: Tag;
  /** Exact status or predicate. */
  readonly status: Status;
  /** Optional case-insensitive header-name matchers. */
  readonly headers?: MatchHeaders;
}

/**
 * Reads an HTTP response body into the encoded input expected by a response schema.
 *
 * @typeParam Input - Value passed to the response schema decoder.
 * @typeParam CanBeDefault - Whether the codec may be installed as an endpoint-wide default.
 * @public
 */
export interface ResponseBodyCodec<Input = unknown, CanBeDefault extends boolean = true> {
  /** Human-readable codec identifier. */
  readonly name: string;
  /** Set to `false` for codecs, such as `none`, that must be selected explicitly per rule. */
  readonly canBeDefault?: CanBeDefault;
  /** Default `Accept` header when the caller has not supplied one. */
  readonly accept?: string;
  /** Consumes the transport response and produces a schema input. */
  readonly decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<Input, HttpClientError.ResponseError>;
}

/** Constructs a provider-compatible response body error. */
const responseBodyError = (
  response: HttpClientResponse.HttpClientResponse,
  reason: "Decode" | "EmptyBody",
  cause?: unknown,
) =>
  new HttpClientError.ResponseError({
    request: response.request,
    response,
    reason,
    cause,
  });

/** Default JSON response codec, implemented through text parsing for consistent empty-body handling. */
const jsonBodyCodec = {
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

/** Text response codec that preserves an empty body as an empty string. */
const textBodyCodec = {
  name: "text" as const,
  accept: "text/*",
  decode: (raw: HttpClientResponse.HttpClientResponse) => raw.text,
} satisfies ResponseBodyCodec<string>;

/** Body-discarding codec used by rules that intentionally expect no value. */
const noBodyCodec = {
  name: "none" as const,
  canBeDefault: false as const,
  decode: (raw: HttpClientResponse.HttpClientResponse) => Effect.as(raw.arrayBuffer, undefined),
} satisfies ResponseBodyCodec<undefined, false>;

/** Built-in response-body codecs. */
export const ResponseBody = {
  /** Parses non-empty response text as JSON. */
  json: jsonBodyCodec,
  /** Returns response text, including an empty string. */
  text: textBodyCodec,
  /** Drains the response and yields `undefined`; only valid as a rule-specific codec. */
  none: noBodyCodec,
} as const;

/** Internal union of every response codec. */
type AnyResponseBodyCodec = ResponseBodyCodec<unknown, boolean>;

/** A response codec that may be selected as the default for multiple response rules. */
export type DefaultResponseBodyCodec = ResponseBodyCodec<unknown, true>;

/** Optional rule-specific response codec. */
type ResponseBodyCodecOrDefault = AnyResponseBodyCodec | undefined;

/**
 * Associates a response matcher with its schema and optional transport codec.
 *
 * @typeParam Matcher - Conditions and unique response tag.
 * @typeParam S - Schema that decodes the codec output.
 * @typeParam Codec - Optional rule-specific body codec.
 * @public
 */
export interface ResponseRule<
  Matcher extends ResponseMatcher = ResponseMatcher,
  S extends AnySchema = AnySchema,
  Codec extends ResponseBodyCodecOrDefault = undefined,
> {
  /** Conditions used to select this rule. */
  readonly match: Matcher;
  /** Schema used to decode the selected response body. */
  readonly schema: S;
  /** Rule-specific codec, or `undefined` to use the plan default. */
  readonly codec: Codec;
}

type AnyResponseRule = ResponseRule<ResponseMatcher, AnySchema, ResponseBodyCodecOrDefault>;

type CodecOptions<S extends AnySchema, Codec extends ResponseBodyCodecOrDefault> = Codec extends AnyResponseBodyCodec
  ? Codec["name"] extends "none"
    ? undefined extends Schema.Schema.Encoded<S>
      ? { readonly codec: Codec }
      : never
    : { readonly codec: Codec }
  : never;

/**
 * Defines one typed response rule.
 *
 * @param match - Response-selection conditions with a unique `_tag`.
 * @param schema - Schema used after the response body codec.
 * @param options - Optional rule-specific codec.
 * @returns A response rule suitable for an API or request declaration.
 * @public
 */
export const response = <
  const Matcher extends ResponseMatcher,
  const S extends AnySchema,
  const Codec extends ResponseBodyCodecOrDefault = undefined,
>(
  match: Matcher,
  schema: S,
  options?: CodecOptions<S, Codec>,
): ResponseRule<Matcher, S, Codec> => ({
  match,
  schema,
  codec: options?.codec as Codec,
});

type MatcherOf<Rule extends AnyResponseRule> =
  Rule extends ResponseRule<infer Matcher, AnySchema, ResponseBodyCodecOrDefault> ? Matcher : never;

type TagOf<Rule extends AnyResponseRule> = MatcherOf<Rule>["_tag"];

type RemoveMatchingRule<Rules extends ReadonlyArray<AnyResponseRule>, Tag extends string> = Rules extends readonly [
  infer Head extends AnyResponseRule,
  ...infer Tail extends ReadonlyArray<AnyResponseRule>,
]
  ? TagOf<Head> extends Tag
    ? RemoveMatchingRule<Tail, Tag>
    : readonly [Head, ...RemoveMatchingRule<Tail, Tag>]
  : readonly [];

type ReplaceMatchingRule<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Rule extends AnyResponseRule,
> = Rules extends readonly [infer Head extends AnyResponseRule, ...infer Tail extends ReadonlyArray<AnyResponseRule>]
  ? TagOf<Head> extends TagOf<Rule>
    ? readonly [Rule, ...Tail]
    : readonly [Head, ...ReplaceMatchingRule<Tail, Rule>]
  : Rules;

type SetResponseRule<Rules extends ReadonlyArray<AnyResponseRule>, Rule extends AnyResponseRule> =
  TagOf<Rule> extends TagOf<Rules[number]> ? ReplaceMatchingRule<Rules, Rule> : readonly [Rule, ...Rules];

type MergeResponseRules<
  Defaults extends ReadonlyArray<AnyResponseRule>,
  Overrides extends ReadonlyArray<AnyResponseRule>,
> = Overrides extends readonly [
  infer Head extends AnyResponseRule,
  ...infer Tail extends ReadonlyArray<AnyResponseRule>,
]
  ? readonly [Head, ...MergeResponseRules<RemoveMatchingRule<Defaults, TagOf<Head>>, Tail>]
  : Defaults;

type DuplicateResponseTagOf<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Seen extends string = never,
> = Rules extends readonly [infer Head extends AnyResponseRule, ...infer Tail extends ReadonlyArray<AnyResponseRule>]
  ? TagOf<Head> extends Seen
    ? TagOf<Head>
    : DuplicateResponseTagOf<Tail, Seen | TagOf<Head>>
  : never;

type UniqueResponseRules<Rules extends ReadonlyArray<AnyResponseRule>> =
  DuplicateResponseTagOf<Rules> extends never
    ? unknown
    : { readonly "Duplicate response tag": DuplicateResponseTagOf<Rules> };

type ExactMatchedHeaders<MatchHeaders extends Readonly<Record<string, HeaderMatcher>>> = {
  readonly [
    Key in keyof MatchHeaders as MatchHeaders[Key] extends string ? Lowercase<Key & string> : never
  ]: MatchHeaders[Key];
};

type MatchedHeaders<Matcher extends ResponseMatcher> =
  Matcher extends ResponseMatcher<
    string,
    StatusMatcher,
    infer MatchHeaders extends Readonly<Record<string, HeaderMatcher>>
  >
    ? ExactMatchedHeaders<MatchHeaders>
    : unknown;

type MatchedStatus<Matcher extends ResponseMatcher> = Matcher["status"] extends number ? Matcher["status"] : number;

/**
 * Successful response value with a tag-discriminated, decoded body and preserved metadata.
 *
 * @typeParam Matcher - Rule matcher selected for the response.
 * @typeParam Body - Decoded response body type.
 * @public
 */
export interface ResponseEnvelope<Matcher extends ResponseMatcher, Body> {
  /** Rule tag used to discriminate the response union. */
  readonly _tag: Matcher["_tag"];
  /** Actual HTTP status, narrowed when the matcher uses an exact status. */
  readonly status: MatchedStatus<Matcher>;
  /** Normalized response headers, narrowed for exact header matchers. */
  readonly headers: Headers.Headers & MatchedHeaders<Matcher>;
  /** Ordered header field lines, including repeated values when preserved by the provider. */
  readonly headerEntries: HeaderEntries;
  /** Parsed response cookies supplied by Effect Platform. */
  readonly cookies: Cookies.Cookies;
  /** Body decoded by the selected codec and schema. */
  readonly body: Body;
  /** Complete matcher that selected this response. */
  readonly matched: Matcher;
}

type EnvelopeOfRule<Rule> =
  Rule extends ResponseRule<infer Matcher, infer S, ResponseBodyCodecOrDefault>
    ? ResponseEnvelope<Matcher, Schema.Schema.Type<S>>
    : never;

/** Produces the tag-discriminated response envelope union for a rule tuple. */
export type ResponseOf<Rules extends ReadonlyArray<AnyResponseRule>> = EnvelopeOfRule<Rules[number]>;

type ContextOfRule<Rule> =
  Rule extends ResponseRule<ResponseMatcher, infer S, ResponseBodyCodecOrDefault> ? Schema.Schema.Context<S> : never;

type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> = ContextOfRule<Rules[number]>;

type BodyContextOf<Body extends AnySchema | undefined> = Body extends AnySchema ? Schema.Schema.Context<Body> : never;
type RequestEncodingError<Body extends AnySchema | undefined> = Body extends AnySchema ? RequestBodyEncodeError : never;
type ResponseDecodingError<Rules extends ReadonlyArray<AnyResponseRule>> = Rules extends readonly []
  ? never
  : ResponseDecodeError;

type InitialBodyReady<Body extends AnySchema | undefined, DefaultBody = undefined> = Body extends AnySchema
  ? [DefaultBody] extends [undefined]
    ? false
    : true
  : true;

type LowercaseLetter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

type PathParameterStartCharacter = LowercaseLetter | Uppercase<LowercaseLetter> | "_";
type PathParameterCharacter = PathParameterStartCharacter | `${number}`;

type TakePathParameterRest<Input extends string, Name extends string> = Input extends `${infer Character}${infer Rest}`
  ? Character extends PathParameterCharacter
    ? TakePathParameterRest<Rest, `${Name}${Character}`>
    : readonly [name: Name, rest: Input]
  : readonly [name: Name, rest: ""];

type TakePathParameter<Input extends string> = Input extends `${infer Character}${infer Rest}`
  ? Character extends PathParameterStartCharacter
    ? TakePathParameterRest<Rest, Character>
    : readonly [name: "", rest: Input]
  : readonly [name: "", rest: ""];

type PathParameterNames<Path extends string> = Path extends `\\:${infer Rest}`
  ? PathParameterNames<Rest>
  : Path extends `${infer Character}${infer Rest}`
    ? Character extends ":"
      ? TakePathParameter<Rest> extends readonly [infer Name extends string, infer Remaining extends string]
        ? Name extends ""
          ? PathParameterNames<Rest>
          : Name | PathParameterNames<Remaining>
        : never
      : PathParameterNames<Rest>
    : never;

/** Named path parameters inferred from `:placeholder` occurrences. */
export type PathParameters<Path extends string> = {
  readonly [Name in PathParameterNames<Path>]: string;
};

/** Endpoint arguments: none for a static path, otherwise one named parameter object. */
export type PathArguments<Path extends string> = [PathParameterNames<Path>] extends [never]
  ? readonly []
  : readonly [parameters: PathParameters<Path>];

/**
 * Indicates that no response rule matched.
 *
 * @remarks
 * The error retains the Effect Platform response. With the default `"discard"` policy its body has already been
 * drained. Use `unhandledResponseBody: "retain"` when the caller must inspect or consume that body, and then run
 * {@link UnhandledResponse.discard} if it is otherwise unused.
 *
 * @public
 */
export class UnhandledResponse extends Data.TaggedError("UnhandledResponse")<{
  /** Original unmatched response. */
  readonly response: HttpClientResponse.HttpClientResponse;
}> {
  /** HTTP status of the unmatched response. */
  get status(): number {
    return this.response.status;
  }

  /** Normalized headers of the unmatched response. */
  get headers(): Headers.Headers {
    return this.response.headers;
  }

  /** Drains the retained response body so the provider can release its resources. */
  get discard(): Effect.Effect<void, HttpClientError.ResponseError> {
    return Stream.runDrain(this.response.stream).pipe(
      Effect.catchAll((error) => (error.reason === "EmptyBody" ? Effect.void : Effect.fail(error))),
    );
  }
}

/** Indicates that a provider rejected a request body, notably on `GET` or `HEAD`. */
export class RequestBodyNotAllowed extends Data.TaggedError("RequestBodyNotAllowed")<{
  /** Request rejected because its method does not permit the configured body. */
  readonly request: HttpClientRequest.HttpClientRequest;
}> {}

/** Indicates that a body-bearing endpoint was converted to an Effect before a body was supplied. */
export class RequestBodyRequired extends Data.TaggedError("RequestBodyRequired")<{
  /** Configured HTTP method. */
  readonly method: RequestMethod;
  /** Configured endpoint path. */
  readonly path: string;
  /** Stable guidance for making the plan executable. */
  readonly reason: "Call setBody before reading effect";
}> {}

/** Indicates that runtime path arguments do not exactly match the path template. */
export class InvalidPathArguments extends Error {
  readonly name = "InvalidPathArguments";

  /** Constructs a path-argument validation error. */
  constructor(
    /** Configured path template. */
    readonly path: string,
    /** Parameter names inferred from the template. */
    readonly expected: ReadonlyArray<string>,
    /** Keys received from the runtime argument object. */
    readonly received: ReadonlyArray<string>,
    /** Number of runtime arguments supplied. */
    readonly argumentCount: number,
  ) {
    super(
      expected.length === 0
        ? `Path ${JSON.stringify(path)} does not accept arguments; received ${argumentCount}`
        : `Path ${JSON.stringify(path)} requires one parameter object with exactly ${JSON.stringify(expected)}; received ${argumentCount} arguments with keys ${JSON.stringify(received)}`,
    );
  }
}

/** Indicates that a path parameter is not a non-empty string. */
export class InvalidPathParameterValue extends Error {
  readonly name = "InvalidPathParameterValue";

  /** Constructs a path-parameter value error. */
  constructor(
    /** Configured path template. */
    readonly path: string,
    /** Invalid parameter name. */
    readonly parameter: string,
    /** Validation condition that failed. */
    readonly reason: "empty" | "not-string",
  ) {
    super(
      `Path parameter ${JSON.stringify(parameter)} for ${JSON.stringify(path)} must be a non-empty string; received ${reason === "empty" ? "an empty string" : "a non-string value"}`,
    );
  }
}

/** Indicates that one response declaration contains the same `_tag` more than once. */
export class DuplicateResponseTag extends Error {
  readonly name = "DuplicateResponseTag";

  /** Constructs a duplicate response-tag error. */
  constructor(
    /** Repeated response tag. */
    readonly tag: string,
    /** Declaration in which the duplicate appeared. */
    readonly owner: "api" | "request",
  ) {
    super(`Duplicate response tag ${JSON.stringify(tag)} in ${owner} declaration`);
  }
}

/** Indicates that retry sugar received a non-finite, negative, or fractional count. */
export class InvalidRetryCount extends Error {
  readonly name = "InvalidRetryCount";

  /** Constructs an invalid retry-count error. */
  constructor(
    /** Invalid retry count. */
    readonly retries: number,
  ) {
    super(`Retry count must be a finite, non-negative integer; received ${String(retries)}`);
  }
}

/** Indicates that a full absolute request URL was combined with an API base URL. */
export class AbsolutePathWithBaseUrl extends Error {
  readonly name = "AbsolutePathWithBaseUrl";

  /** Constructs an absolute-path/base-URL conflict error. */
  constructor(
    /** Configured API base URL. */
    readonly baseUrl: string,
    /** Absolute endpoint path that cannot be joined to the base URL. */
    readonly path: string,
  ) {
    super(`Cannot combine base URL ${JSON.stringify(baseUrl)} with absolute path ${JSON.stringify(path)}`);
  }
}

/**
 * Wraps schema parsing failures with the selected rule and raw HTTP response.
 *
 * @public
 */
export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  /** `_tag` of the response rule whose schema failed. */
  readonly responseTag: string;
  /** Original HTTP response. */
  readonly response: HttpClientResponse.HttpClientResponse;
  /** Effect Schema parsing failure. */
  readonly cause: ParseResult.ParseError;
}> {
  /** HTTP status of the response that failed schema decoding. */
  get status(): number {
    return this.response.status;
  }
}

/** Wraps schema encoding or transport body construction failures with the request. */
export class RequestBodyEncodeError extends Data.TaggedError("RequestBodyEncodeError")<{
  /** Request being constructed when encoding failed. */
  readonly request: HttpClientRequest.HttpClientRequest;
  /** Schema encoding or HTTP body construction failure. */
  readonly cause: ParseResult.ParseError | HttpBody.HttpBodyError;
}> {}

/** Browser fetch-cache and wire-level `Cache-Control` settings. */
export interface CachePolicy {
  /** `Cache-Control` request header value, unless an explicit header already exists. */
  readonly control?: string;
  /** Browser Fetch `RequestCache` value. */
  readonly fetch?: RequestCache;
}

/** Ownership policy for the body of an unmatched response. */
export type UnhandledResponseBodyPolicy = "discard" | "retain";

/** Values observed by retry predicates and schedules. */
export type RetryInput =
  HttpClientResponse.HttpClientResponse | HttpClientError.HttpClientError | Cause.TimeoutException;

/** Effect Schedule used to delay and limit retry attempts. */
export type RetrySchedule = Schedule.Schedule<unknown, RetryInput, never>;

/** Retry behavior applied around request execution and response selection. */
export interface RetryPolicy {
  /** Maximum number of attempts after the initial request. */
  readonly times: number;
  /** Delay schedule; defaults to jittered exponential backoff. */
  readonly schedule?: RetrySchedule;
  /** Whether retry decisions apply to failures, responses, or both. */
  readonly mode?: "errors-only" | "response-only" | "both";
  /** Additional retry predicate; built-in transient cases always remain retryable. */
  readonly while?: (input: RetryInput) => boolean;
  /** Whether `Retry-After` can extend the schedule delay. Defaults to `true`. */
  readonly respectRetryAfter?: boolean;
}

/** Options shared by APIs, endpoints, and immutable request plans. */
export interface RequestOptions {
  /** Default request headers; values for the same name replace inherited values. */
  readonly headers?: HeaderInput;
  /** Default query parameters; values for the same key replace inherited values. */
  readonly urlParams?: QueryParamsInput;
  /** Default transport decoder for response rules without their own codec. */
  readonly responseCodec?: DefaultResponseBodyCodec;
  /** Whether unmatched response bodies are drained or transferred to the error caller. */
  readonly unhandledResponseBody?: UnhandledResponseBodyPolicy;
  /** Request caching configuration. */
  readonly cache?: CachePolicy;
  /** Per-attempt timeout. */
  readonly timeout?: Duration.DurationInput;
  /** Full retry policy. */
  readonly retry?: RetryPolicy;
  /** Retry-count sugar using the default schedule. */
  readonly retries?: number;
  /** Immutable request transformation applied before execution. */
  readonly transformRequest?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest;
  /** HTTP client transformation applied before execution. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

type ExactAssignable<Provided, Expected> = Expected extends unknown
  ? Provided extends Expected
    ? Provided extends object
      ? Exclude<keyof Provided, keyof Expected> extends never
        ? Provided
        : never
      : Provided
    : never
  : never;

type DefaultBodyValue<Body extends AnySchema, Provided> = [
  ExactAssignable<Provided, Schema.Schema.Type<Body>>,
] extends [never]
  ? Schema.Schema.Type<Body>
  : Provided;

/** API-wide request options and inherited response rules. */
export interface ApiOptions<Defaults extends ReadonlyArray<AnyResponseRule> = readonly []> extends RequestOptions {
  /** Default response rules inherited by requests. Tags must be unique within this declaration. */
  readonly responses?: Defaults & UniqueResponseRules<Defaults>;
}

/** Options used to derive a sub-API from an existing API. */
export interface ApiExtensionOptions<
  Defaults extends ReadonlyArray<AnyResponseRule> = readonly [],
> extends ApiOptions<Defaults> {
  /** Complete replacement base URL. */
  readonly baseUrl?: string;
  /** Inherited header names or exact values to remove before applying extension headers. */
  readonly removeHeaders?: ReadonlyArray<HeaderRemoval>;
  /** Inherited query parameter names or exact values to remove before applying extension parameters. */
  readonly removeUrlParams?: ReadonlyArray<QueryParamRemoval>;
}

/** Declarative endpoint configuration used by {@link createRequest} and {@link Api.createRequest}. */
export interface RequestDefinition<
  Method extends RequestMethod,
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  DefaultBody = undefined,
> extends RequestOptions {
  /** Arbitrary HTTP method token. */
  readonly method: Method;
  /** Relative or absolute path template containing optional named `:parameters`. */
  readonly path: Path;
  /** API-inherited headers to remove before endpoint headers are applied. */
  readonly removeHeaders?: ReadonlyArray<HeaderRemoval>;
  /** API-inherited query parameters to remove before endpoint parameters are applied. */
  readonly removeUrlParams?: ReadonlyArray<QueryParamRemoval>;
  /** Schema for a request body; disallowed for `GET` and `HEAD`. */
  readonly body?: Uppercase<Method> extends "GET" | "HEAD" ? never : Body;
  /** Codec that serializes the request schema's encoded representation. */
  readonly bodyCodec?: Uppercase<Method> extends "GET" | "HEAD"
    ? never
    : Body extends AnySchema
      ? RequestBodyCodec<Schema.Schema.Encoded<Body>>
      : never;
  /** Body used by every plan unless replaced with `setBody`. */
  readonly defaultBody?: Uppercase<Method> extends "GET" | "HEAD"
    ? never
    : Body extends AnySchema
      ? DefaultBodyValue<Body, DefaultBody>
      : never;
  /** Endpoint response rules, replacing inherited rules with the same `_tag`. */
  readonly responses?: Rules & UniqueResponseRules<Rules>;
}

type BodySetter<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
> = Body extends AnySchema ? (body: Schema.Schema.Type<Body>) => RequestPlan<Body, Rules, true> : never;

type RequestBodyCodecSetter<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
> = Body extends AnySchema
  ? (codec: RequestBodyCodec<Schema.Schema.Encoded<Body>>) => RequestPlan<Body, Rules, BodyReady>
  : never;

/** Overloads for replacing all values or one exact query parameter value. */
interface UrlParamSetter<Output> {
  (key: string, value: QueryParamValue): Output;
  (key: string, currentValue: QueryParamValue, replacementValue: QueryParamValue): Output;
}

/** Overloads for removing all values or one exact query parameter value. */
interface UrlParamRemover<Output> {
  (key: string): Output;
  (key: string, value: QueryParamValue): Output;
}

/** Overloads for removing all fields or one exact header field value. */
interface HeaderRemover<Output> {
  (name: string): Output;
  (name: string, value: string): Output;
}

/** Overloads for replacing all values or one exact header field value. */
interface HeaderSetter<Output> {
  (name: string, value: string): Output;
  (name: string, currentValue: string, replacementValue: string): Output;
}

/**
 * Immutable, lazy description of one HTTP request and its typed response alternatives.
 *
 * @remarks
 * Every setter returns another plan without executing I/O. Read `effect` or use {@link toEffect} only after all
 * call-site overrides have been composed.
 *
 * @typeParam Body - Optional request-body schema.
 * @typeParam Rules - Ordered response rule tuple.
 * @typeParam BodyReady - Whether a required body has been supplied.
 * @public
 */
export interface RequestPlan<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
>
  extends Pipeable.Pipeable {
  /** Replaces the request body's decoded value and marks the body ready. */
  readonly setBody: BodySetter<Body, Rules>;
  /** Replaces the codec used after the body schema encodes its value. */
  readonly setRequestBodyCodec: RequestBodyCodecSetter<Body, Rules, BodyReady>;
  /** Replaces all values for a key, or replaces matching values only. */
  readonly setUrlParam: UrlParamSetter<RequestPlan<Body, Rules, BodyReady>>;
  /** Replaces all values for every key present in the input. */
  readonly setUrlParams: (params: QueryParamsInput) => RequestPlan<Body, Rules, BodyReady>;
  /** Appends one query parameter without replacing existing values. */
  readonly appendUrlParam: (key: string, value: QueryParamValue) => RequestPlan<Body, Rules, BodyReady>;
  /** Removes all values for a key, or only an exact key/value pair. */
  readonly removeUrlParam: UrlParamRemover<RequestPlan<Body, Rules, BodyReady>>;
  /** Replaces all values for a header name, or replaces matching field values only. */
  readonly setHeader: HeaderSetter<RequestPlan<Body, Rules, BodyReady>>;
  /** Replaces all values for every header name present in the input. */
  readonly setHeaders: (headers: HeaderInput) => RequestPlan<Body, Rules, BodyReady>;
  /** Appends one header field without replacing existing values. */
  readonly appendHeader: (name: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  /** Removes all fields for a name, or only an exact name/value pair. */
  readonly removeHeader: HeaderRemover<RequestPlan<Body, Rules, BodyReady>>;
  /** Replaces or clears request caching behavior. */
  readonly setCache: (cache: CachePolicy | undefined) => RequestPlan<Body, Rules, BodyReady>;
  /** Replaces the default response-body codec. */
  readonly setResponseCodec: (codec: DefaultResponseBodyCodec) => RequestPlan<Body, Rules, BodyReady>;
  /** Chooses whether unmatched response bodies are drained or retained. */
  readonly setUnhandledResponseBody: (policy: UnhandledResponseBodyPolicy) => RequestPlan<Body, Rules, BodyReady>;
  /** Replaces or clears the base URL. */
  readonly setBaseUrl: (baseUrl: string | undefined) => RequestPlan<Body, Rules, BodyReady>;
  /** Replaces or clears the per-attempt timeout. */
  readonly setTimeout: (timeout: Duration.DurationInput | undefined) => RequestPlan<Body, Rules, BodyReady>;
  /** Replaces or disables the retry policy. */
  readonly setRetry: (retry: RetryPolicy | undefined) => RequestPlan<Body, Rules, BodyReady>;
  /** Replaces retries using count-only sugar and the default schedule. */
  readonly setRetries: (retries: number) => RequestPlan<Body, Rules, BodyReady>;
  /** Appends an immutable request transformation. */
  readonly mapRequest: (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) => RequestPlan<Body, Rules, BodyReady>;
  /** Appends an HTTP client transformation. */
  readonly mapClient: (
    transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  ) => RequestPlan<Body, Rules, BodyReady>;
  /** Replaces the rule with the same `_tag`, or adds a new highest-precedence rule. */
  readonly setResponseSchema: <
    const Matcher extends ResponseMatcher,
    const S extends AnySchema,
    const Codec extends ResponseBodyCodecOrDefault = undefined,
  >(
    match: Matcher,
    schema: S,
    options?: CodecOptions<S, Codec>,
  ) => RequestPlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady>;
  /** Lazily builds the executable Effect, or a body-required marker when no body was supplied. */
  readonly effect: BodyReady extends true
    ? Effect.Effect<
        ResponseOf<Rules>,
        | UnhandledResponse
        | RequestBodyNotAllowed
        | RequestEncodingError<Body>
        | HttpClientError.HttpClientError
        | Cause.TimeoutException
        | ResponseDecodingError<Rules>,
        HttpClient.HttpClient | BodyContextOf<Body> | ResponseContextOf<Rules>
      >
    : RequestBodyRequired;
}

/**
 * Callable endpoint factory whose arguments are inferred from its path template.
 *
 * @typeParam Path - Literal path template.
 * @typeParam Body - Optional request-body schema.
 * @typeParam Rules - Ordered response rule tuple.
 * @typeParam BodyReady - Whether plans initially have a request body.
 * @public
 */
export type Endpoint<
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
> = ((...pathArguments: PathArguments<Path>) => RequestPlan<Body, Rules, BodyReady>) & Pipeable.Pipeable;

/** Pipeable form of {@link RequestPlan.setBody}. */
export const setBody =
  <Value>(body: Value) =>
  <Body extends AnySchema, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: Value extends Schema.Schema.Type<Body> ? RequestPlan<Body, Rules, BodyReady> : never,
  ): RequestPlan<Body, Rules, true> =>
    plan.setBody(body as Schema.Schema.Type<Body>);

/** Pipeable form of {@link RequestPlan.setRequestBodyCodec}. */
export const setRequestBodyCodec =
  <Input>(codec: RequestBodyCodec<Input>) =>
  <Body extends AnySchema, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: Schema.Schema.Encoded<Body> extends Input ? RequestPlan<Body, Rules, BodyReady> : never,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setRequestBodyCodec(codec as RequestBodyCodec<Schema.Schema.Encoded<Body>>);

type PlanTransform = <
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
>(
  plan: RequestPlan<Body, Rules, BodyReady>,
) => RequestPlan<Body, Rules, BodyReady>;

/** Pipeable form of {@link RequestPlan.setUrlParam}. */
export function setUrlParam(key: string, value: QueryParamValue): PlanTransform;
export function setUrlParam(
  key: string,
  currentValue: QueryParamValue,
  replacementValue: QueryParamValue,
): PlanTransform;
export function setUrlParam(
  key: string,
  currentValue: QueryParamValue,
  replacementValue?: QueryParamValue,
): PlanTransform {
  return (plan) =>
    replacementValue === undefined
      ? plan.setUrlParam(key, currentValue)
      : plan.setUrlParam(key, currentValue, replacementValue);
}

/** Pipeable form of {@link RequestPlan.setUrlParams}. */
export const setUrlParams =
  (params: QueryParamsInput) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setUrlParams(params);

/** Pipeable form of {@link RequestPlan.appendUrlParam}. */
export const appendUrlParam =
  (key: string, value: QueryParamValue) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.appendUrlParam(key, value);

/** Pipeable form of {@link RequestPlan.removeUrlParam}. */
export function removeUrlParam(key: string): PlanTransform;
export function removeUrlParam(key: string, value: QueryParamValue): PlanTransform;
export function removeUrlParam(key: string, value?: QueryParamValue): PlanTransform {
  return (plan) => (value === undefined ? plan.removeUrlParam(key) : plan.removeUrlParam(key, value));
}

/** Pipeable form of {@link RequestPlan.setHeader}. */
export function setHeader(name: string, value: string): PlanTransform;
export function setHeader(name: string, currentValue: string, replacementValue: string): PlanTransform;
export function setHeader(name: string, currentValue: string, replacementValue?: string): PlanTransform {
  return (plan) =>
    replacementValue === undefined
      ? plan.setHeader(name, currentValue)
      : plan.setHeader(name, currentValue, replacementValue);
}

/** Pipeable form of {@link RequestPlan.setHeaders}. */
export const setHeaders =
  (headers: HeaderInput) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setHeaders(headers);

/** Pipeable form of {@link RequestPlan.appendHeader}. */
export const appendHeader =
  (name: string, value: string) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.appendHeader(name, value);

/** Pipeable form of {@link RequestPlan.removeHeader}. */
export function removeHeader(name: string): PlanTransform;
export function removeHeader(name: string, value: string): PlanTransform;
export function removeHeader(name: string, value?: string): PlanTransform {
  return (plan) => (value === undefined ? plan.removeHeader(name) : plan.removeHeader(name, value));
}

/** Pipeable form of {@link RequestPlan.setCache}. */
export const setCache =
  (cache: CachePolicy | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setCache(cache);

/** Pipeable form of {@link RequestPlan.setResponseCodec}. */
export const setResponseCodec =
  (codec: DefaultResponseBodyCodec) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setResponseCodec(codec);

/** Pipeable form of {@link RequestPlan.setUnhandledResponseBody}. */
export const setUnhandledResponseBody =
  (policy: UnhandledResponseBodyPolicy) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setUnhandledResponseBody(policy);

/** Pipeable form of {@link RequestPlan.setBaseUrl}. */
export const setBaseUrl =
  (baseUrl: string | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setBaseUrl(baseUrl);

/** Pipeable form of {@link RequestPlan.setTimeout}. */
export const setTimeout =
  (timeout: Duration.DurationInput | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setTimeout(timeout);

/** Pipeable form of {@link RequestPlan.setRetry}. */
export const setRetry =
  (retry: RetryPolicy | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setRetry(retry);

/** Pipeable form of {@link RequestPlan.setRetries}. */
export const setRetries =
  (retries: number) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setRetries(retries);

/** Pipeable form of {@link RequestPlan.mapRequest}. */
export const mapRequest =
  (transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.mapRequest(transform);

/** Pipeable form of {@link RequestPlan.mapClient}. */
export const mapClient =
  (transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.mapClient(transform);

/** Pipeable form of {@link RequestPlan.setResponseSchema}. */
export const setResponseSchema =
  <
    const Matcher extends ResponseMatcher,
    const S extends AnySchema,
    const Codec extends ResponseBodyCodecOrDefault = undefined,
  >(
    match: Matcher,
    schema: S,
    options?: CodecOptions<S, Codec>,
  ) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady> =>
    plan.setResponseSchema<Matcher, S, Codec>(match, schema, options);

/** Extracts the lazy Effect from a fully configured request plan. */
export const toEffect = <
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
>(
  plan: RequestPlan<Body, Rules, BodyReady>,
): RequestPlan<Body, Rules, BodyReady>["effect"] => plan.effect;

type PipeableEndpoint<Arguments extends ReadonlyArray<unknown>, Value> = ((...arguments_: Arguments) => Value) &
  Pipeable.Pipeable;

/**
 * Maps every plan returned by an endpoint while retaining its call signature and pipeability.
 *
 * @public
 */
export const mapEndpoint: {
  <Input, Output>(
    transform: (value: Input) => Output,
  ): <Arguments extends ReadonlyArray<unknown>>(
    endpoint: PipeableEndpoint<Arguments, Input>,
  ) => PipeableEndpoint<Arguments, Output>;
  <Arguments extends ReadonlyArray<unknown>, Input, Output>(
    endpoint: PipeableEndpoint<Arguments, Input>,
    transform: (value: Input) => Output,
  ): PipeableEndpoint<Arguments, Output>;
} = dual(
  2,
  <Arguments extends ReadonlyArray<unknown>, Input, Output>(
    endpoint: PipeableEndpoint<Arguments, Input>,
    transform: (value: Input) => Output,
  ): PipeableEndpoint<Arguments, Output> =>
    makePipeableEndpoint((...arguments_: Arguments) => transform(endpoint(...arguments_))),
);

interface InternalDefinition<Body extends AnySchema | undefined> extends RequestOptions {
  readonly method: RequestMethod;
  readonly path: string;
  readonly removeHeaders?: ReadonlyArray<HeaderRemoval>;
  readonly removeUrlParams?: ReadonlyArray<QueryParamRemoval>;
  readonly body?: Body;
  readonly bodyCodec?: RequestBodyCodec<never>;
  readonly defaultBody?: unknown;
  readonly baseUrl?: string;
  readonly baseOptions?: RequestOptions;
}

interface PlanState {
  readonly baseUrl: string | undefined;
  readonly body: unknown;
  readonly hasBody: boolean;
  readonly bodyCodec: RequestBodyCodec<never>;
  readonly headers: HeaderEntries;
  readonly urlParams: QueryParams;
  readonly responseCodec: DefaultResponseBodyCodec;
  readonly unhandledResponseBody: UnhandledResponseBodyPolicy;
  readonly cache: CachePolicy | undefined;
  readonly timeout: Duration.DurationInput | undefined;
  readonly retry: RetryPolicy | undefined;
  readonly requestTransforms: ReadonlyArray<
    (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest
  >;
  readonly clientTransforms: ReadonlyArray<(client: HttpClient.HttpClient) => HttpClient.HttpClient>;
}

interface InternalRequestPlan extends Pipeable.Pipeable {
  readonly setBody: (body: unknown) => unknown;
  readonly setRequestBodyCodec: (codec: RequestBodyCodec<never>) => unknown;
  readonly setUrlParam: UrlParamSetter<unknown>;
  readonly setUrlParams: (params: QueryParamsInput) => unknown;
  readonly appendUrlParam: (key: string, value: QueryParamValue) => unknown;
  readonly removeUrlParam: UrlParamRemover<unknown>;
  readonly setHeader: HeaderSetter<unknown>;
  readonly setHeaders: (headers: HeaderInput) => unknown;
  readonly appendHeader: (name: string, value: string) => unknown;
  readonly removeHeader: HeaderRemover<unknown>;
  readonly setCache: (cache: CachePolicy | undefined) => unknown;
  readonly setResponseCodec: (codec: DefaultResponseBodyCodec) => unknown;
  readonly setUnhandledResponseBody: (policy: UnhandledResponseBodyPolicy) => unknown;
  readonly setBaseUrl: (baseUrl: string | undefined) => unknown;
  readonly setTimeout: (timeout: Duration.DurationInput | undefined) => unknown;
  readonly setRetry: (retry: RetryPolicy | undefined) => unknown;
  readonly setRetries: (retries: number) => unknown;
  readonly mapRequest: (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) => unknown;
  readonly mapClient: (transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient) => unknown;
  readonly setResponseSchema: (
    match: ResponseMatcher,
    schema: AnySchema,
    options?: { readonly codec: AnyResponseBodyCodec },
  ) => unknown;
  readonly effect: object;
}

const defaultRetrySchedule: RetrySchedule = Schedule.jittered(Schedule.exponential("100 millis"));

const normalizeRetry = (retry: RetryPolicy | number | undefined): RetryPolicy | undefined => {
  if (retry === undefined) return undefined;
  const policy = typeof retry === "number" ? { times: retry } : retry;
  if (!Number.isFinite(policy.times) || !Number.isInteger(policy.times) || policy.times < 0) {
    throw new InvalidRetryCount(policy.times);
  }
  return policy.times === 0 ? undefined : policy;
};

const isTransientResponseStatus = (status: number): boolean =>
  status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

const isHttpClientResponse = (input: unknown): input is HttpClientResponse.HttpClientResponse =>
  typeof input === "object" && input !== null && HttpClientResponse.TypeId in input;

const isRetryInput = (input: unknown): input is RetryInput =>
  isHttpClientResponse(input) || Cause.isTimeoutException(input) || HttpClientError.isHttpClientError(input);

const isTransientRetryInput = (input: RetryInput): boolean =>
  isHttpClientResponse(input)
    ? isTransientResponseStatus(input.status)
    : Cause.isTimeoutException(input) ||
      (HttpClientError.isHttpClientError(input) &&
        ((input._tag === "RequestError" && input.reason === "Transport") ||
          (input._tag === "ResponseError" && isTransientResponseStatus(input.response.status))));

const isRetryable = (input: RetryInput, additional: RetryPolicy["while"]): boolean =>
  isTransientRetryInput(input) || additional?.(input) === true;

const responseFromRetryInput = (input: RetryInput): HttpClientResponse.HttpClientResponse | undefined =>
  isHttpClientResponse(input)
    ? input
    : HttpClientError.isHttpClientError(input) && input._tag === "ResponseError"
      ? input.response
      : undefined;

const retryAfterTimestamp = (input: RetryInput, now: number): number | undefined => {
  const value = responseFromRetryInput(input)?.headers["retry-after"]?.trim();
  if (value === undefined || value === "") return undefined;

  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isFinite(milliseconds) ? now + milliseconds : undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : undefined;
};

const withAttemptTimeout = <Success, Error, Requirements>(
  effect: Effect.Effect<Success, Error, Requirements>,
  timeout: Duration.DurationInput | undefined,
): Effect.Effect<Success, Error | Cause.TimeoutException, Requirements> =>
  timeout === undefined ? effect : Effect.timeout(effect, timeout);

const waitUntil = (timestamp: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sleep(Duration.millis(Math.max(0, timestamp - now))));

const executeWithRetry = <Success, HandlingError, Requirements, Error extends HttpClientError.HttpClientError>(
  client: HttpClient.HttpClient.With<Error>,
  request: HttpClientRequest.HttpClientRequest,
  retry: RetryPolicy | undefined,
  timeout: Duration.DurationInput | undefined,
  handleResponse: (raw: HttpClientResponse.HttpClientResponse) => Effect.Effect<Success, HandlingError, Requirements>,
): Effect.Effect<
  Success,
  Error | HandlingError | HttpClientError.ResponseError | Cause.TimeoutException,
  Requirements
> => {
  const mode = retry?.mode ?? "both";
  const times = retry?.times ?? 0;
  const schedule = retry?.schedule ?? defaultRetrySchedule;
  const respectRetryAfter = retry?.respectRetryAfter ?? true;

  return Effect.gen(function* () {
    let scheduleState = schedule.initial;
    let retries = 0;

    const nextRetryAt = (input: RetryInput) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [nextState, , decision] = yield* schedule.step(now, input, scheduleState);
        scheduleState = nextState;
        if (ScheduleDecision.isDone(decision)) return undefined;

        const scheduled = ScheduleIntervals.start(decision.intervals);
        const retryAfter = respectRetryAfter ? retryAfterTimestamp(input, now) : undefined;
        return retryAfter === undefined ? scheduled : Math.max(scheduled, retryAfter);
      });

    while (true) {
      const attempt = withAttemptTimeout(
        Effect.gen(function* () {
          const raw = yield* client.execute(request);
          if (mode !== "errors-only" && retries < times && isRetryable(raw, retry?.while)) {
            return { _tag: "RetryResponse" as const, response: raw };
          }
          return { _tag: "Done" as const, value: yield* handleResponse(raw) };
        }),
        timeout,
      );
      const outcome = yield* Effect.either(attempt);

      if (outcome._tag === "Left") {
        if (
          mode === "response-only" ||
          retries >= times ||
          !isRetryInput(outcome.left) ||
          !isRetryable(outcome.left, retry?.while)
        ) {
          return yield* Effect.fail(outcome.left);
        }

        const retryAt = yield* nextRetryAt(outcome.left);
        if (retryAt === undefined) return yield* Effect.fail(outcome.left);

        yield* waitUntil(retryAt);
        retries += 1;
        continue;
      }

      if (outcome.right._tag === "Done") return outcome.right.value;

      const retryAt = yield* nextRetryAt(outcome.right.response);
      if (retryAt === undefined) return yield* withAttemptTimeout(handleResponse(outcome.right.response), timeout);

      yield* withAttemptTimeout(outcome.right.response.arrayBuffer, timeout);
      yield* waitUntil(retryAt);
      retries += 1;
    }
  });
};

const joinUrl = (baseUrl: string | undefined, path: string): string => {
  if (baseUrl === undefined) return path;
  if (URL.canParse(path)) throw new AbsolutePathWithBaseUrl(baseUrl, path);
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
};

const queryParamsFromInput = (input: QueryParamsInput): QueryParams => {
  if (Symbol.iterator in input) {
    return Array.from(input, ([key, value]) => [key, value] as const);
  }

  return Object.entries(input).flatMap(([key, value]) => {
    if (value === undefined) return [];
    return Array.isArray(value)
      ? value.map((item) => [key, item] as const)
      : [[key, value as QueryParamValue] as const];
  });
};

const setQueryParam = (params: QueryParams, key: string, value: QueryParamValue): QueryParams => [
  ...params.filter(([candidate]) => candidate !== key),
  [key, value],
];

const replaceQueryParamValue = (
  params: QueryParams,
  key: string,
  currentValue: QueryParamValue,
  replacementValue: QueryParamValue,
): QueryParams =>
  params.map((entry) => (entry[0] === key && entry[1] === currentValue ? ([key, replacementValue] as const) : entry));

const setQueryParams = (params: QueryParams, input: QueryParamsInput): QueryParams => {
  const incoming = queryParamsFromInput(input);
  const keys = new Set(incoming.map(([key]) => key));
  return [...incoming, ...params.filter(([key]) => !keys.has(key))];
};

const appendQueryParam = (params: QueryParams, key: string, value: QueryParamValue): QueryParams => [
  ...params,
  [key, value],
];

const removeQueryParam = (params: QueryParams, key: string): QueryParams =>
  params.filter(([candidate]) => candidate !== key);

const removeQueryParams = (params: QueryParams, removals: ReadonlyArray<QueryParamRemoval> | undefined): QueryParams =>
  (removals ?? []).reduce(
    (current, removal) =>
      typeof removal === "string"
        ? removeQueryParam(current, removal)
        : removal.value === undefined
          ? removeQueryParam(current, removal.name)
          : removeQueryParamValue(current, removal.name, removal.value),
    params,
  );

const removeQueryParamValue = (params: QueryParams, key: string, value: QueryParamValue): QueryParams =>
  params.filter(([candidate, candidateValue]) => candidate !== key || candidateValue !== value);

const encodeQueryParam = ([key, value]: readonly [string, QueryParamValue]): string => {
  const encoded = new URLSearchParams([[key, value === true ? "" : value]]).toString();
  return value === true ? encoded.slice(0, -1) : encoded;
};

const setUrlQuery = (url: string, params: QueryParams): string => {
  if (params.length === 0) return url;

  const fragmentIndex = url.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : url.slice(fragmentIndex);
  const separator = beforeFragment.includes("?") ? (beforeFragment.endsWith("?") ? "" : "&") : "?";
  return `${beforeFragment}${separator}${params.map(encodeQueryParam).join("&")}${fragment}`;
};

const parsePathQuery = (query: string): QueryParams =>
  query.split("&").flatMap((part) => {
    if (part === "") return [];
    const parsed = new URLSearchParams(part).entries().next();
    if (parsed.done) return [];
    const [key, value] = parsed.value;
    return [[key, part.includes("=") ? value : true] as const];
  });

const splitPathUrlParams = (path: string): { readonly path: string; readonly urlParams: QueryParams } => {
  const fragmentIndex = path.indexOf("#");
  const beforeFragment = fragmentIndex === -1 ? path : path.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : path.slice(fragmentIndex);
  const queryIndex = beforeFragment.indexOf("?");
  if (queryIndex === -1) return { path, urlParams: [] };

  return {
    path: `${beforeFragment.slice(0, queryIndex)}${fragment}`,
    urlParams: parsePathQuery(beforeFragment.slice(queryIndex + 1)),
  };
};

const fillPath = (path: string, pathArguments: ReadonlyArray<unknown>): string => {
  const parameterPattern = /(?<!\\):([A-Za-z_][A-Za-z0-9_]*)/g;
  const expected = Array.from(new Set(Array.from(path.matchAll(parameterPattern), ([, name]) => name!)));

  if (expected.length === 0) {
    if (pathArguments.length !== 0) throw new InvalidPathArguments(path, expected, [], pathArguments.length);
    return path.replaceAll("\\:", ":");
  }

  const candidate = pathArguments[0];
  const isParameterObject =
    pathArguments.length === 1 && typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  const parameters = isParameterObject ? (candidate as Readonly<Record<string, unknown>>) : undefined;
  const received = parameters === undefined ? [] : Object.keys(parameters);
  if (
    parameters === undefined ||
    received.length !== expected.length ||
    expected.some((name) => !Object.hasOwn(parameters, name)) ||
    received.some((name) => !expected.includes(name))
  ) {
    throw new InvalidPathArguments(path, expected, received, pathArguments.length);
  }

  for (const name of expected) {
    const value = parameters[name];
    if (typeof value !== "string") throw new InvalidPathParameterValue(path, name, "not-string");
    if (value.length === 0) throw new InvalidPathParameterValue(path, name, "empty");
  }

  return path
    .replace(parameterPattern, (_, name: string) => encodeURIComponent(parameters[name] as string))
    .replaceAll("\\:", ":");
};

const matches = (
  rule: AnyResponseRule,
  status: number,
  headers: Headers.Headers,
  headerEntries: HeaderEntries,
): boolean => {
  const statusMatches =
    typeof rule.match.status === "number" ? rule.match.status === status : rule.match.status(status);
  return (
    statusMatches &&
    Object.entries(rule.match.headers ?? {}).every(([name, matcher]) => {
      const canonicalName = name.toLowerCase();
      const value = headers[canonicalName];
      const values = headerEntries
        .filter(([candidate]) => candidate === canonicalName)
        .map(([, candidateValue]) => candidateValue);
      return typeof matcher === "string" ? value === matcher : matcher(value, values);
    })
  );
};

const specificity = (rule: AnyResponseRule): number =>
  Object.keys(rule.match.headers ?? {}).length * 2 + (typeof rule.match.status === "number" ? 1 : 0);

const setResponseRule = (
  rules: ReadonlyArray<AnyResponseRule>,
  rule: AnyResponseRule,
): ReadonlyArray<AnyResponseRule> => {
  const index = rules.findIndex((candidate) => candidate.match._tag === rule.match._tag);
  if (index === -1) return [rule, ...rules];
  return rules.map((candidate, candidateIndex) => (candidateIndex === index ? rule : candidate));
};

const validateUniqueResponseTags = (rules: ReadonlyArray<AnyResponseRule>, owner: "api" | "request"): void => {
  const tags = new Set<string>();
  for (const rule of rules) {
    if (tags.has(rule.match._tag)) throw new DuplicateResponseTag(rule.match._tag, owner);
    tags.add(rule.match._tag);
  }
};

const mergeResponseRules = (
  defaults: ReadonlyArray<AnyResponseRule>,
  overrides: ReadonlyArray<AnyResponseRule>,
): ReadonlyArray<AnyResponseRule> => [
  ...overrides,
  ...defaults.filter((rule) => !overrides.some((override) => override.match._tag === rule.match._tag)),
];

const findResponseRule = (
  rules: ReadonlyArray<AnyResponseRule>,
  status: number,
  headers: Headers.Headers,
  headerEntries: HeaderEntries,
): AnyResponseRule | undefined => {
  let selected: AnyResponseRule | undefined;
  let selectedSpecificity = -1;

  for (const rule of rules) {
    const ruleSpecificity = specificity(rule);
    if (matches(rule, status, headers, headerEntries) && ruleSpecificity > selectedSpecificity) {
      selected = rule;
      selectedSpecificity = ruleSpecificity;
    }
  }

  return selected;
};

const decodeResponse = (
  rule: AnyResponseRule,
  raw: HttpClientResponse.HttpClientResponse,
  defaultCodec: DefaultResponseBodyCodec,
) =>
  Effect.flatMap((rule.codec ?? defaultCodec).decode(raw), Schema.decodeUnknown(rule.schema)).pipe(
    Effect.mapError((error) =>
      ParseResult.isParseError(error)
        ? new ResponseDecodeError({ responseTag: rule.match._tag, response: raw, cause: error })
        : error,
    ),
  );

const makePlan = <
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
>(
  definition: InternalDefinition<Body>,
  rules: Rules,
  state: PlanState,
): RequestPlan<Body, Rules, BodyReady> => {
  const update = (next: Partial<PlanState>): RequestPlan<Body, Rules, BodyReady> =>
    makePlan<Body, Rules, BodyReady>(definition, rules, { ...state, ...next });

  const getEffect = () =>
    definition.body !== undefined && !state.hasBody
      ? Effect.fail(
          new RequestBodyRequired({
            method: definition.method,
            path: definition.path,
            reason: "Call setBody before reading effect",
          }),
        )
      : Effect.gen(function* () {
          let request = HttpClientRequest.make(definition.method as HttpMethod.HttpMethod)(
            setUrlQuery(joinUrl(state.baseUrl, definition.path), state.urlParams),
          );
          request = HttpClientRequest.setHeaders(request, normalizeHeaderEntries(state.headers));

          if (!Headers.has(request.headers, "accept")) {
            request = HttpClientRequest.setHeader(request, "accept", state.responseCodec.accept ?? "application/json");
          }

          if (state.cache?.control !== undefined && !Headers.has(request.headers, "cache-control")) {
            request = HttpClientRequest.setHeader(request, "cache-control", state.cache.control);
          }

          if (definition.body !== undefined && state.hasBody) {
            const encoded = yield* Schema.encodeUnknown(definition.body)(state.body).pipe(
              Effect.mapError((cause) => new RequestBodyEncodeError({ request, cause })),
            );
            const bodyCodec = state.bodyCodec as RequestBodyCodec<unknown>;
            request = yield* bodyCodec
              .encode(encoded, request)
              .pipe(Effect.mapError((cause) => new RequestBodyEncodeError({ request, cause })));
          }

          for (const transform of state.requestTransforms) request = transform(request);
          attachHeaderEntries(request, reconcileHeaderEntries(state.headers, request.headers));

          const normalizedMethod = request.method.toUpperCase();
          if ((normalizedMethod === "GET" || normalizedMethod === "HEAD") && request.body._tag !== "Empty") {
            return yield* new RequestBodyNotAllowed({ request });
          }

          let client = yield* HttpClient.HttpClient;
          for (const transform of state.clientTransforms) client = transform(client);
          const handleResponse = (
            raw: HttpClientResponse.HttpClientResponse,
          ): Effect.Effect<
            ResponseOf<Rules>,
            UnhandledResponse | HttpClientError.ResponseError | ResponseDecodeError,
            unknown
          > => {
            const headerEntries = getHeaderEntries(raw);
            const rule = findResponseRule(rules, raw.status, raw.headers, headerEntries);
            if (rule === undefined) {
              const error = new UnhandledResponse({ response: raw });
              return state.unhandledResponseBody === "retain"
                ? Effect.fail(error)
                : Effect.zipRight(Effect.ignore(error.discard), Effect.fail(error));
            }

            return Effect.map(decodeResponse(rule, raw, state.responseCodec), (body) => {
              const envelope = {
                _tag: rule.match._tag,
                status: raw.status,
                headers: raw.headers,
                headerEntries,
                cookies: raw.cookies,
                body,
                matched: rule.match,
              } satisfies ResponseEnvelope<ResponseMatcher, unknown>;
              return envelope as ResponseOf<Rules>;
            });
          };
          let send = executeWithRetry(client, request, state.retry, state.timeout, handleResponse);

          if (state.cache?.fetch !== undefined) {
            const existingRequestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
            send = Effect.provideService(send, FetchHttpClient.RequestInit, {
              ...Option.getOrElse(existingRequestInit, () => ({})),
              cache: state.cache.fetch,
            });
          }

          return yield* send;
        });

  const plan = {
    pipe: pipeSelf,
    setBody: (body: unknown) => makePlan<Body, Rules, true>(definition, rules, { ...state, body, hasBody: true }),
    setRequestBodyCodec: (bodyCodec: RequestBodyCodec<never>) => update({ bodyCodec }),
    setUrlParam: (key: string, currentValue: QueryParamValue, replacementValue?: QueryParamValue) =>
      update({
        urlParams:
          replacementValue === undefined
            ? setQueryParam(state.urlParams, key, currentValue)
            : replaceQueryParamValue(state.urlParams, key, currentValue, replacementValue),
      }),
    setUrlParams: (params) => update({ urlParams: setQueryParams(state.urlParams, params) }),
    appendUrlParam: (key, value) => update({ urlParams: appendQueryParam(state.urlParams, key, value) }),
    removeUrlParam: (key: string, value?: QueryParamValue) =>
      update({
        urlParams:
          value === undefined
            ? removeQueryParam(state.urlParams, key)
            : removeQueryParamValue(state.urlParams, key, value),
      }),
    setHeader: (name: string, currentValue: string, replacementValue?: string) =>
      update({
        headers:
          replacementValue === undefined
            ? setHeaderEntries(state.headers, [[name, currentValue]])
            : replaceHeaderEntryValue(state.headers, name, currentValue, replacementValue),
      }),
    setHeaders: (headers) => update({ headers: setHeaderEntries(state.headers, headers) }),
    appendHeader: (name, value) => update({ headers: appendHeaderEntry(state.headers, name, value) }),
    removeHeader: (name: string, value?: string) => update({ headers: removeHeaderEntry(state.headers, name, value) }),
    setCache: (cache) => update({ cache }),
    setResponseCodec: (responseCodec) => update({ responseCodec }),
    setUnhandledResponseBody: (unhandledResponseBody) => update({ unhandledResponseBody }),
    setBaseUrl: (baseUrl) => update({ baseUrl }),
    setTimeout: (timeout) => update({ timeout }),
    setRetry: (retry) => update({ retry: normalizeRetry(retry) }),
    setRetries: (retries) => update({ retry: normalizeRetry(retries) }),
    mapRequest: (transform) => update({ requestTransforms: [...state.requestTransforms, transform] }),
    mapClient: (transform) => update({ clientTransforms: [...state.clientTransforms, transform] }),
    setResponseSchema: <
      const Matcher extends ResponseMatcher,
      const S extends AnySchema,
      const Codec extends ResponseBodyCodecOrDefault = undefined,
    >(
      match: Matcher,
      schema: S,
      options?: CodecOptions<S, Codec>,
    ) => {
      const rule = response<Matcher, S, Codec>(match, schema, options);
      return makePlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady>(
        definition,
        setResponseRule(rules, rule) as SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>,
        state,
      );
    },
    get effect() {
      return getEffect();
    },
  } satisfies InternalRequestPlan;

  return plan as unknown as RequestPlan<Body, Rules, BodyReady>;
};

const makePipeableEndpoint = <Arguments extends ReadonlyArray<unknown>, Value>(
  endpoint: (...arguments_: Arguments) => Value,
): ((...arguments_: Arguments) => Value) & Pipeable.Pipeable => {
  return Object.assign(endpoint, { pipe: pipeSelf });
};

const createRequestInternal = <
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
>(
  definition: InternalDefinition<Body>,
  rules: Rules,
): Endpoint<Path, Body, Rules, BodyReady> => {
  const endpoint = (...pathArguments: PathArguments<Path>) => {
    const filled = splitPathUrlParams(fillPath(definition.path, pathArguments));
    const baseHeaders = removeHeaderEntries(
      headerEntriesFromInput(definition.baseOptions?.headers),
      definition.removeHeaders,
    );
    const headers = setHeaderEntries(baseHeaders, definition.headers ?? {});
    const baseParams = removeQueryParams(
      queryParamsFromInput(definition.baseOptions?.urlParams ?? {}),
      definition.removeUrlParams,
    );
    const pathParams = setQueryParams(baseParams, filled.urlParams);
    const urlParams = setQueryParams(pathParams, definition.urlParams ?? {});
    const requestTransforms = [definition.baseOptions?.transformRequest, definition.transformRequest].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );
    const clientTransforms = [definition.baseOptions?.transformClient, definition.transformClient].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );
    const retry = normalizeRetry(
      definition.retry ?? definition.retries ?? definition.baseOptions?.retry ?? definition.baseOptions?.retries,
    );

    return makePlan<Body, Rules, BodyReady>({ ...definition, path: filled.path }, rules, {
      baseUrl: definition.baseUrl,
      body: definition.defaultBody,
      hasBody: definition.defaultBody !== undefined,
      bodyCodec: definition.bodyCodec ?? RequestBody.json,
      headers,
      urlParams,
      responseCodec: definition.responseCodec ?? definition.baseOptions?.responseCodec ?? ResponseBody.json,
      unhandledResponseBody:
        definition.unhandledResponseBody ?? definition.baseOptions?.unhandledResponseBody ?? "discard",
      cache: definition.cache ?? definition.baseOptions?.cache,
      timeout: definition.timeout ?? definition.baseOptions?.timeout,
      retry,
      requestTransforms,
      clientTransforms,
    });
  };
  return makePipeableEndpoint(endpoint);
};

/**
 * Creates a standalone lazy endpoint from a request definition.
 *
 * @remarks
 * Calling the returned endpoint only constructs an immutable request plan. No provider is selected and no I/O occurs
 * until its Effect is executed.
 *
 * @param definition - HTTP method, path, schemas, response rules, and defaults.
 * @returns A callable, pipeable endpoint.
 * @public
 */
export const createRequest = <
  const Method extends RequestMethod,
  const Path extends string,
  Body extends AnySchema | undefined = undefined,
  const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
  const DefaultBody = undefined,
>(
  definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
): Endpoint<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>> => {
  validateUniqueResponseTags(definition.responses ?? [], "request");
  return createRequestInternal<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>>(
    definition,
    definition.responses ?? ([] as unknown as Rules),
  );
};

/**
 * Reusable API configuration that creates endpoints and derived sub-APIs.
 *
 * @typeParam Defaults - Response rules inherited by created endpoints.
 * @public
 */
export interface Api<Defaults extends ReadonlyArray<AnyResponseRule>> extends Pipeable.Pipeable {
  /** Current base URL used by created endpoints. */
  readonly baseUrl: string;
  /** Derives an API with merged options, optional removals, and an optional replacement base URL. */
  readonly extend: <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(
    options: ApiExtensionOptions<Overrides>,
  ) => Api<MergeResponseRules<Defaults, Overrides>>;
  /** Creates a lazy endpoint inheriting this API's options and response rules. */
  readonly createRequest: <
    const Method extends RequestMethod,
    const Path extends string,
    Body extends AnySchema | undefined = undefined,
    const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
    const DefaultBody = undefined,
  >(
    definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
  ) => Endpoint<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>>;
}

/**
 * Creates a reusable API configuration.
 *
 * @param baseUrl - Base URL prepended to relative endpoint paths.
 * @param options - Shared request options and response rules.
 * @returns A pipeable API builder.
 * @public
 */
export const createApi = <const Defaults extends ReadonlyArray<AnyResponseRule> = readonly []>(
  baseUrl: string,
  options: ApiOptions<Defaults> = {} as ApiOptions<Defaults>,
): Api<Defaults> => {
  validateUniqueResponseTags(options.responses ?? [], "api");
  return {
    pipe: pipeSelf,
    baseUrl,
    extend: <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(
      overrides: ApiExtensionOptions<Overrides>,
    ): Api<MergeResponseRules<Defaults, Overrides>> => {
      validateUniqueResponseTags(overrides.responses ?? [], "api");
      const baseRequestTransform = options.transformRequest;
      const overrideRequestTransform = overrides.transformRequest;
      const baseClientTransform = options.transformClient;
      const overrideClientTransform = overrides.transformClient;
      const retry =
        overrides.retry ??
        (overrides.retries !== undefined
          ? { times: overrides.retries }
          : (options.retry ?? (options.retries !== undefined ? { times: options.retries } : undefined)));
      const responses = mergeResponseRules(options.responses ?? [], overrides.responses ?? []);

      return createApi<MergeResponseRules<Defaults, Overrides>>(overrides.baseUrl ?? baseUrl, {
        headers: setHeaderEntries(
          removeHeaderEntries(headerEntriesFromInput(options.headers), overrides.removeHeaders),
          overrides.headers ?? {},
        ),
        urlParams: setQueryParams(
          removeQueryParams(queryParamsFromInput(options.urlParams ?? {}), overrides.removeUrlParams),
          overrides.urlParams ?? {},
        ),
        responseCodec: overrides.responseCodec ?? options.responseCodec,
        unhandledResponseBody: overrides.unhandledResponseBody ?? options.unhandledResponseBody,
        cache: overrides.cache ?? options.cache,
        timeout: overrides.timeout ?? options.timeout,
        retry,
        transformRequest:
          baseRequestTransform === undefined
            ? overrideRequestTransform
            : overrideRequestTransform === undefined
              ? baseRequestTransform
              : (request) => overrideRequestTransform(baseRequestTransform(request)),
        transformClient:
          baseClientTransform === undefined
            ? overrideClientTransform
            : overrideClientTransform === undefined
              ? baseClientTransform
              : (client) => overrideClientTransform(baseClientTransform(client)),
        responses: responses as MergeResponseRules<Defaults, Overrides>,
      });
    },
    createRequest: <
      const Method extends RequestMethod,
      const Path extends string,
      Body extends AnySchema | undefined = undefined,
      const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
      const DefaultBody = undefined,
    >(
      definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
    ): Endpoint<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>> => {
      validateUniqueResponseTags(definition.responses ?? [], "request");
      const rules = mergeResponseRules(options.responses ?? [], definition.responses ?? []);
      return createRequestInternal<
        Path,
        Body,
        MergeResponseRules<Defaults, Rules>,
        InitialBodyReady<Body, DefaultBody>
      >({ ...definition, baseUrl, baseOptions: options }, rules as MergeResponseRules<Defaults, Rules>);
    },
  };
};

/** Pipeable form of {@link Api.extend}. */
export const extendApi =
  <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(options: ApiExtensionOptions<Overrides>) =>
  <Defaults extends ReadonlyArray<AnyResponseRule>>(api: Api<Defaults>): Api<MergeResponseRules<Defaults, Overrides>> =>
    api.extend(options);
