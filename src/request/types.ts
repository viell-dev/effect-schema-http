import {
  Cookies,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { Cause, Duration, Effect, Schedule, Schema } from "effect";
import type * as Pipeable from "effect/Pipeable";
import type { UrlEncoding } from "../encoding/UrlEncoding.js";
import { RequestBodyEncodeError } from "../errors/RequestBodyEncodeError.js";
import { RequestBodyNotAllowed } from "../errors/RequestBodyNotAllowed.js";
import { RequestBodyRequired } from "../errors/RequestBodyRequired.js";
import type { RequestFieldsEncodeError } from "../errors/RequestFieldsEncodeError.js";
import { ResponseDecodeError } from "../errors/ResponseDecodeError.js";
import { UnhandledResponse } from "../errors/UnhandledResponse.js";
import { HeaderEntriesTypeId } from "../headers/HeaderEntriesTypeId.js";

/** Any Effect Schema accepted by the request builder. */
export type AnySchema = Schema.Schema.Any;

/** A schema-validated body or an explicitly selected codec-only body. */
export type AnyRequestBody = AnySchema | RequestBodyCodec<never>;
export type RequestBodyValue<Body> = Body extends AnySchema
  ? Schema.Schema.Type<Body>
  : Body extends RequestBodyCodec<infer Input>
    ? Input
    : never;
export type RequestBodyEncoded<Body> = Body extends AnySchema
  ? Schema.Schema.Encoded<Body>
  : Body extends RequestBodyCodec<infer Input>
    ? Input
    : never;

/** An HTTP method token. Arbitrary extension methods are supported. */
export type RequestMethod = string;

/** A materialized query parameter value; `true` serializes as a bare parameter without `=`. */
export type QueryParamValue = string | true;

/**
 * A static query parameter value, or a function computing one while the request is materialized.
 *
 * @remarks
 * A plain value is static and is fixed when it is declared. A function is called once per plan evaluation, just before
 * the request is built, so it can read application state that did not exist at declaration time. Returning `undefined`
 * omits the parameter entirely, which makes "include this filter only when it is set" a declaration rather than a
 * branch at the call site.
 *
 * The function must be pure and cheap: it runs outside the Effect runtime, its result is fixed for the whole
 * evaluation including every retry attempt, and it may run while a plan is being reused. Use a request transform for
 * anything effectful.
 *
 * @public
 */
export type QueryParamValueInput = QueryParamValue | (() => QueryParamValue | undefined);

/** Accepted query parameter collections, including repeated and computed values. */
export type QueryParamsInput =
  | Readonly<Record<string, QueryParamValueInput | ReadonlyArray<QueryParamValueInput> | undefined>>
  | Iterable<readonly [string, QueryParamValueInput]>
  | URLSearchParams;

/** Canonical ordered query parameters as declared, before computed values are resolved. */
export type DeclaredQueryParams = ReadonlyArray<readonly [string, QueryParamValueInput]>;

/** Canonical ordered query parameters after computed values are resolved. */
export type QueryParams = ReadonlyArray<readonly [string, QueryParamValue]>;

/** Removes every value by name, or one exact name/value pair. Only static values can be matched by value. */
export type QueryParamRemoval = string | { readonly name: string; readonly value?: QueryParamValue };

/**
 * A static header field value, or a function computing one while the request is materialized.
 *
 * @remarks
 * Behaves exactly like {@link QueryParamValueInput}: a plain string is static, a function is called once per plan
 * evaluation just before the request is built, and returning `undefined` omits the field. This is what lets an
 * API-wide `authorization` default read the current session instead of whatever was signed in when the API was
 * declared, while remaining an ordinary declared header that endpoint `removeHeaders`, sub-API extension, and
 * plan-level `removeHeader` can still take away.
 *
 * The function must be pure and cheap: it runs outside the Effect runtime, its result is fixed for the whole
 * evaluation including every retry attempt, and it may run while a plan is being reused. Use a request transform for
 * anything effectful.
 *
 * @public
 */
export type HeaderValueInput = string | (() => string | undefined);

/** Header inputs accepted by declarations and setters, including repeated and computed values. */
export type HeaderInput =
  | Readonly<Record<string, HeaderValueInput | ReadonlyArray<HeaderValueInput> | undefined>>
  | Iterable<readonly [string, HeaderValueInput]>;

/** Ordered HTTP header fields as declared, before computed values are resolved. */
export type DeclaredHeaderEntries = ReadonlyArray<readonly [name: string, value: HeaderValueInput]>;

/** Ordered HTTP header fields that preserve repeated field lines. Always materialized values. */
export type HeaderEntries = ReadonlyArray<readonly [name: string, value: string]>;

/** Removes every field by name, or one exact name/value pair. Only static values can be matched by value. */
export type HeaderRemoval = string | { readonly name: string; readonly value?: string };

/** Structural carrier for provider-preserved header entries. */
export interface HeaderEntriesCarrier {
  readonly [HeaderEntriesTypeId]?: HeaderEntries;
}

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

/** Internal union of every response codec. */
export type AnyResponseBodyCodec = ResponseBodyCodec<unknown, boolean>;

/** A response codec that may be selected as the default for multiple response rules. */
export type DefaultResponseBodyCodec = ResponseBodyCodec<unknown, true>;

/** Optional rule-specific response codec. */
export type ResponseBodyCodecOrDefault = AnyResponseBodyCodec | undefined;

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
  S extends AnySchema | undefined = AnySchema,
  Codec extends ResponseBodyCodecOrDefault = undefined,
> {
  /** Conditions used to select this rule. */
  readonly match: Matcher;
  /** Schema used to decode the selected response body. */
  readonly schema: S;
  /** Rule-specific codec, or `undefined` to use the plan default. */
  readonly codec: Codec;
}

/** General response-rule type for helpers; retain literal tags and tuples for precise replacement inference. */
export type AnyResponseRule = ResponseRule<ResponseMatcher, AnySchema | undefined, ResponseBodyCodecOrDefault>;

export type CodecOptions<
  S extends AnySchema,
  Codec extends ResponseBodyCodecOrDefault,
> = Codec extends AnyResponseBodyCodec
  ? Codec["name"] extends "none"
    ? undefined extends Schema.Schema.Encoded<S>
      ? { readonly codec: Codec }
      : never
    : { readonly codec: Codec }
  : never;

export type MatcherOf<Rule extends AnyResponseRule> =
  Rule extends ResponseRule<infer Matcher, AnySchema | undefined, ResponseBodyCodecOrDefault> ? Matcher : never;

export type TagOf<Rule extends AnyResponseRule> = MatcherOf<Rule>["_tag"];

export type RemoveMatchingRule<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Tag extends string,
> = Rules extends readonly [infer Head extends AnyResponseRule, ...infer Tail extends ReadonlyArray<AnyResponseRule>]
  ? TagOf<Head> extends Tag
    ? RemoveMatchingRule<Tail, Tag>
    : readonly [Head, ...RemoveMatchingRule<Tail, Tag>]
  : readonly [];

export type ReplaceMatchingRule<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Rule extends AnyResponseRule,
> = Rules extends readonly [infer Head extends AnyResponseRule, ...infer Tail extends ReadonlyArray<AnyResponseRule>]
  ? TagOf<Head> extends TagOf<Rule>
    ? readonly [Rule, ...Tail]
    : readonly [Head, ...ReplaceMatchingRule<Tail, Rule>]
  : Rules;

export type SetResponseRule<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Rule extends AnyResponseRule,
> = number extends Rules["length"]
  ? ReadonlyArray<Rules[number] | Rule>
  : TagOf<Rule> extends TagOf<Rules[number]>
    ? ReplaceMatchingRule<Rules, Rule>
    : readonly [Rule, ...Rules];

export type MergeResponseRules<
  Defaults extends ReadonlyArray<AnyResponseRule>,
  Overrides extends ReadonlyArray<AnyResponseRule>,
> = number extends Defaults["length"] | Overrides["length"]
  ? ReadonlyArray<Defaults[number] | Overrides[number]>
  : Overrides extends readonly [
        infer Head extends AnyResponseRule,
        ...infer Tail extends ReadonlyArray<AnyResponseRule>,
      ]
    ? readonly [Head, ...MergeResponseRules<RemoveMatchingRule<Defaults, TagOf<Head>>, Tail>]
    : Defaults;

export type DuplicateResponseTagOf<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Seen extends string = never,
> = Rules extends readonly [infer Head extends AnyResponseRule, ...infer Tail extends ReadonlyArray<AnyResponseRule>]
  ? TagOf<Head> extends Seen
    ? TagOf<Head>
    : DuplicateResponseTagOf<Tail, Seen | TagOf<Head>>
  : never;

export type UniqueResponseRules<Rules extends ReadonlyArray<AnyResponseRule>> =
  DuplicateResponseTagOf<Rules> extends never
    ? unknown
    : { readonly "Duplicate response tag": DuplicateResponseTagOf<Rules> };

export type ExactMatchedHeaders<MatchHeaders extends Readonly<Record<string, HeaderMatcher>>> = {
  readonly [
    Key in keyof MatchHeaders as MatchHeaders[Key] extends string ? Lowercase<Key & string> : never
  ]: MatchHeaders[Key];
};

export type MatchedHeaders<Matcher extends ResponseMatcher> =
  Matcher extends ResponseMatcher<
    string,
    StatusMatcher,
    infer MatchHeaders extends Readonly<Record<string, HeaderMatcher>>
  >
    ? ExactMatchedHeaders<MatchHeaders>
    : unknown;

export type MatchedStatus<Matcher extends ResponseMatcher> = Matcher["status"] extends number
  ? Matcher["status"]
  : number;

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

export type EnvelopeOfRule<Rule> =
  Rule extends ResponseRule<infer Matcher, infer S, infer Codec>
    ? ResponseEnvelope<
        Matcher,
        S extends AnySchema
          ? Schema.Schema.Type<S>
          : Codec extends ResponseBodyCodec<infer Value, boolean>
            ? Value
            : unknown
      >
    : never;

/** Produces the tag-discriminated response envelope union for a rule tuple. */
export type ResponseOf<Rules extends ReadonlyArray<AnyResponseRule>> = EnvelopeOfRule<Rules[number]>;

export type ContextOfRule<Rule> =
  Rule extends ResponseRule<ResponseMatcher, infer S, ResponseBodyCodecOrDefault>
    ? S extends AnySchema
      ? Schema.Schema.Context<S>
      : never
    : never;

export type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> = ContextOfRule<Rules[number]>;

export type BodyContextOf<Body extends AnyRequestBody | undefined> = Body extends AnySchema
  ? Schema.Schema.Context<Body>
  : never;

export type RequestEncodingError<Body extends AnyRequestBody | undefined> = [Body] extends [AnyRequestBody]
  ? RequestBodyEncodeError
  : never;

export type ResponseDecodingError<Rules extends ReadonlyArray<AnyResponseRule>> = Rules extends readonly []
  ? never
  : ResponseDecodeError;

export type InitialBodyReady<Body extends AnyRequestBody | undefined, DefaultBody = undefined> = [Body] extends [
  AnyRequestBody,
]
  ? undefined extends DefaultBody
    ? false
    : true
  : true;

export type LowercaseLetter =
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

export type PathParameterStartCharacter = LowercaseLetter | Uppercase<LowercaseLetter> | "_";

export type PathParameterCharacter = PathParameterStartCharacter | `${number}`;

export type TakePathParameterRest<
  Input extends string,
  Name extends string,
> = Input extends `${infer Character}${infer Rest}`
  ? Character extends PathParameterCharacter
    ? TakePathParameterRest<Rest, `${Name}${Character}`>
    : readonly [name: Name, rest: Input]
  : readonly [name: Name, rest: ""];

export type TakePathParameter<Input extends string> = Input extends `${infer Character}${infer Rest}`
  ? Character extends PathParameterStartCharacter
    ? TakePathParameterRest<Rest, Character>
    : readonly [name: "", rest: Input]
  : readonly [name: "", rest: ""];

export type PathParameterNames<Path extends string> = Path extends `\\:${infer Rest}`
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
export type PathArguments<Path extends string> = string extends Path
  ? readonly [parameters: Readonly<Record<string, string>>]
  : [PathParameterNames<Path>] extends [never]
    ? readonly []
    : readonly [parameters: PathParameters<Path>];

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

/**
 * Retry behavior applied around request execution and response selection.
 *
 * @remarks
 * Disabled by default. Applies to every method and retries mapped transient responses before schema decoding.
 * Enable only when replay is acceptable. Attempts reuse the encoded body, which must be replayable.
 */
export interface RetryPolicy {
  /** Maximum number of attempts after the initial request. */
  readonly times: number;
  /** Delay schedule; defaults to jittered exponential backoff. */
  readonly schedule?: RetrySchedule;
  /** Whether retry decisions apply to failures, responses, or both. */
  readonly mode?: "errors-only" | "response-only" | "both";
  /** Adds retryable cases; cannot veto built-in transient cases and is not called for them. */
  readonly while?: (input: RetryInput) => boolean;
  /** Whether `Retry-After` can extend the schedule delay. Defaults to `true`. */
  readonly respectRetryAfter?: boolean;
}

/** Options shared by APIs, endpoints, and immutable request plans. */
export interface RequestOptions {
  /** URL construction policy; supplied by SchemaHttp or overridden for an individual API/endpoint. */
  readonly urlEncoding?: UrlEncoding["Type"];
  /** Emits payload-free Effect debug events. Logger configuration remains consumer-owned. */
  readonly diagnostics?: boolean;
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
  /** Transport and final-decoding timeout; excludes encoding, transforms, and backoff. Disposal has a separate window. */
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

export type ExactAssignable<Provided, Expected> = Expected extends unknown
  ? Provided extends Expected
    ? Provided extends object
      ? Exclude<keyof Provided, keyof Expected> extends never
        ? Provided
        : never
      : Provided
    : never
  : never;

export type DefaultBodyValue<Body extends AnyRequestBody, Provided> = [
  ExactAssignable<Provided, RequestBodyValue<Body>>,
] extends [never]
  ? RequestBodyValue<Body>
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
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  DefaultBody = undefined,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
> extends Omit<RequestOptions, "headers" | "urlParams"> {
  readonly headersSchema?: H & WireCompatible<H, SchemaHeaderInput>;
  readonly urlParamsSchema?: Q & WireCompatible<Q, SchemaQueryInput>;
  readonly headers?: FieldInput<H, HeaderInput>;
  readonly urlParams?: FieldInput<Q, QueryParamsInput>;
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
    : Body extends AnyRequestBody
      ? RequestBodyCodec<RequestBodyEncoded<Body>>
      : never;
  /** Defined body value used by every plan unless replaced with `setBody`; `undefined` means no default. */
  readonly defaultBody?: Uppercase<Method> extends "GET" | "HEAD"
    ? never
    : Body extends AnyRequestBody
      ? DefaultBodyValue<Body, DefaultBody>
      : never;
  /** Endpoint response rules, replacing inherited rules with the same `_tag`. */
  readonly responses?: Rules & UniqueResponseRules<Rules>;
}

export type FieldInput<S, Raw> = S extends AnySchema ? Schema.Schema.Type<S> : Raw;
export type FieldContext<S> = S extends AnySchema ? Schema.Schema.Context<S> : never;
export type FieldsError<H, Q> = H extends AnySchema
  ? RequestFieldsEncodeError
  : Q extends AnySchema
    ? RequestFieldsEncodeError
    : never;
/** Schema output contains materialized values; computed declarations belong before schema encoding. */
export type SchemaHeaderInput =
  Readonly<Record<string, string | ReadonlyArray<string> | undefined>> | Iterable<readonly [string, string]>;
export type SchemaQueryInput =
  | Readonly<Record<string, QueryParamValue | ReadonlyArray<QueryParamValue> | undefined>>
  | Iterable<readonly [string, QueryParamValue]>;

export type WireCompatible<S, Wire> = S extends AnySchema
  ? Schema.Schema.Encoded<S> extends Wire
    ? unknown
    : { readonly "Schema encoded type must be a supported HTTP field collection": never }
  : unknown;

export type BodySetter<
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
> = [Body] extends [AnyRequestBody] ? (body: RequestBodyValue<Body>) => RequestPlan<Body, Rules, true, H, Q> : never;

export type RequestBodyCodecSetter<
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
> = [Body] extends [AnyRequestBody]
  ? (codec: RequestBodyCodec<RequestBodyEncoded<Body>>) => RequestPlan<Body, Rules, BodyReady, H, Q>
  : never;

/** Overloads for replacing all values or one exact static query parameter value. */
export interface UrlParamSetter<Output> {
  (key: string, value: QueryParamValueInput): Output;
  (key: string, currentValue: QueryParamValue, replacementValue: QueryParamValueInput): Output;
}

/** Overloads for removing all values or one exact query parameter value. */
export interface UrlParamRemover<Output> {
  (key: string): Output;
  (key: string, value: QueryParamValue): Output;
}

/** Overloads for removing all fields or one exact header field value. */
export interface HeaderRemover<Output> {
  (name: string): Output;
  (name: string, value: string): Output;
}

/** Overloads for replacing all values or one exact static header field value. */
export interface HeaderSetter<Output> {
  (name: string, value: HeaderValueInput): Output;
  (name: string, currentValue: string, replacementValue: HeaderValueInput): Output;
}

/**
 * Immutable, lazy description of one HTTP request and its typed response alternatives.
 *
 * @remarks
 * Every setter returns another plan without executing I/O. Read `effect` or use {@link toEffect} only after all
 * call-site overrides have been composed. Reading the Effect is also lazy; each evaluation sends independently.
 * Immutability is structural: caller-supplied body values, codecs, matchers, and policies are not deep-cloned.
 * Treat them as immutable for the lifetime of the endpoint and its plans.
 *
 * @typeParam Body - Optional request-body schema.
 * @typeParam Rules - Ordered response rule tuple.
 * @typeParam BodyReady - Whether a required body has been supplied.
 * @public
 */
export interface RequestPlan<
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
>
  extends Pipeable.Pipeable {
  /** Replaces the request body's decoded value and marks the body ready. */
  readonly setBody: BodySetter<Body, Rules, H, Q>;
  /** Replaces the codec used after the body schema encodes its value. */
  readonly setRequestBodyCodec: RequestBodyCodecSetter<Body, Rules, BodyReady, H, Q>;
  /** Replaces all values for a key, or replaces matching values only. */
  readonly setUrlParam: Q extends AnySchema ? never : UrlParamSetter<RequestPlan<Body, Rules, BodyReady, H, Q>>;
  /** Replaces all values for every key present in the input. */
  readonly setUrlParams: (params: FieldInput<Q, QueryParamsInput>) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Appends one query parameter without replacing existing values. */
  readonly appendUrlParam: Q extends AnySchema
    ? never
    : (key: string, value: QueryParamValueInput) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Removes all values for a key, or only an exact key/value pair. */
  readonly removeUrlParam: Q extends AnySchema ? never : UrlParamRemover<RequestPlan<Body, Rules, BodyReady, H, Q>>;
  /** Replaces all values for a header name, or replaces matching field values only. */
  readonly setHeader: H extends AnySchema ? never : HeaderSetter<RequestPlan<Body, Rules, BodyReady, H, Q>>;
  /** Replaces all values for every header name present in the input. */
  readonly setHeaders: (headers: FieldInput<H, HeaderInput>) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Appends one header field without replacing existing values. */
  readonly appendHeader: H extends AnySchema
    ? never
    : (name: string, value: HeaderValueInput) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Removes all fields for a name, or only an exact name/value pair. */
  readonly removeHeader: H extends AnySchema ? never : HeaderRemover<RequestPlan<Body, Rules, BodyReady, H, Q>>;
  /** Replaces or clears request caching behavior. */
  readonly setCache: (cache: CachePolicy | undefined) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Replaces the default response-body codec. */
  readonly setResponseCodec: (codec: DefaultResponseBodyCodec) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Chooses whether unmatched response bodies are drained or retained. */
  readonly setUnhandledResponseBody: (policy: UnhandledResponseBodyPolicy) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Replaces or clears the base URL. */
  readonly setBaseUrl: (baseUrl: string | undefined) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Replaces or clears the timeout described by {@link RequestOptions.timeout}. */
  readonly setTimeout: (timeout: Duration.DurationInput | undefined) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Replaces or disables the retry policy. */
  readonly setRetry: (retry: RetryPolicy | undefined) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Replaces retries using count-only sugar and the default schedule. */
  readonly setRetries: (retries: number) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Appends an immutable request transformation. */
  readonly mapRequest: (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Appends an HTTP client transformation. */
  readonly mapClient: (
    transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  ) => RequestPlan<Body, Rules, BodyReady, H, Q>;
  /** Replaces a rule with the same `_tag` in place, or prepends a new rule; specificity still determines priority. */
  readonly setResponseSchema: <
    const Matcher extends ResponseMatcher,
    const S extends AnySchema,
    const Codec extends ResponseBodyCodecOrDefault = undefined,
  >(
    match: Matcher,
    schema: S,
    options?: CodecOptions<S, Codec>,
  ) => RequestPlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady, H, Q>;
  /** Builds a cold Effect; typed as {@link RequestBodyRequired} until a required body is supplied. */
  readonly effect: BodyReady extends true
    ? Effect.Effect<
        ResponseOf<Rules>,
        | UnhandledResponse
        | RequestBodyNotAllowed
        | RequestEncodingError<Body>
        | FieldsError<H, Q>
        | HttpClientError.HttpClientError
        | Cause.TimeoutException
        | ResponseDecodingError<Rules>,
        HttpClient.HttpClient | BodyContextOf<Body> | ResponseContextOf<Rules> | FieldContext<H> | FieldContext<Q>
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
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
> = ((...pathArguments: PathArguments<Path>) => RequestPlan<Body, Rules, BodyReady, H, Q>) & Pipeable.Pipeable;

/**
 * A reusable plan transformation that works on any endpoint's plans.
 *
 * @remarks
 * `Body`, `Rules`, and `BodyReady` differ per endpoint, so a helper written against one concrete
 * {@link RequestPlan} instantiation is not reusable across endpoints. This is the type every pipeable setter already
 * returns, and annotating a cross-endpoint helper with it keeps the helper polymorphic without casts:
 *
 * ```ts
 * const withAuth =
 *   (token: string): RawHeaderPlanTransform =>
 *   (plan) =>
 *     plan.setHeader("authorization", `Bearer ${token}`).setHeader("x-request-source", "web");
 *
 * const plan = getUser({ userId }).pipe(withAuth(token), setUrlParam("expand", "profile"));
 * ```
 *
 * A transformation that only adds a header or query parameter needs no helper at all: the pipeable setters are
 * already values of this type. A transformation that must also change response rules or supply a body cannot use
 * this type, because those operations change the plan's type parameters; compose those with `mapEndpoint` per
 * endpoint instead.
 *
 * @public
 */
export type RequestPlanTransform = <
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
  H extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
>(
  plan: RequestPlan<Body, Rules, BodyReady, H, Q>,
) => RequestPlan<Body, Rules, BodyReady, H, Q>;

export type PipeableEndpoint<Arguments extends ReadonlyArray<unknown>, Value> = ((...arguments_: Arguments) => Value) &
  Pipeable.Pipeable;

export interface InternalDefinition<Body extends AnyRequestBody | undefined> extends Omit<
  RequestOptions,
  "headers" | "urlParams"
> {
  readonly headers?: unknown;
  readonly urlParams?: unknown;
  readonly headersSchema?: AnySchema | undefined;
  readonly urlParamsSchema?: AnySchema | undefined;
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

export interface PlanState {
  readonly schemaHeaders: unknown;
  readonly hasSchemaHeaders: boolean;
  readonly schemaUrlParams: unknown;
  readonly hasSchemaUrlParams: boolean;
  readonly baseUrl: string | undefined;
  readonly body: unknown;
  readonly hasBody: boolean;
  readonly bodyCodec: RequestBodyCodec<never>;
  readonly headers: DeclaredHeaderEntries;
  readonly urlParams: DeclaredQueryParams;
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

export interface InternalRequestPlan extends Pipeable.Pipeable {
  readonly setBody: (body: unknown) => unknown;
  readonly setRequestBodyCodec: (codec: RequestBodyCodec<never>) => unknown;
  readonly setUrlParam: UrlParamSetter<unknown>;
  readonly setUrlParams: (params: QueryParamsInput) => unknown;
  readonly appendUrlParam: (key: string, value: QueryParamValueInput) => unknown;
  readonly removeUrlParam: UrlParamRemover<unknown>;
  readonly setHeader: HeaderSetter<unknown>;
  readonly setHeaders: (headers: HeaderInput) => unknown;
  readonly appendHeader: (name: string, value: HeaderValueInput) => unknown;
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
    Body extends AnyRequestBody | undefined = undefined,
    const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
    const DefaultBody = undefined,
    H extends AnySchema | undefined = undefined,
    Q extends AnySchema | undefined = undefined,
  >(
    definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody, H, Q>,
  ) => Endpoint<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>, H, Q>;
}

export type RawHeaderPlanTransform = <
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  Ready extends boolean,
  Q extends AnySchema | undefined,
>(
  plan: RequestPlan<Body, Rules, Ready, undefined, Q>,
) => RequestPlan<Body, Rules, Ready, undefined, Q>;
export type RawQueryPlanTransform = <
  Body extends AnyRequestBody | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  Ready extends boolean,
  H extends AnySchema | undefined,
>(
  plan: RequestPlan<Body, Rules, Ready, H, undefined>,
) => RequestPlan<Body, Rules, Ready, H, undefined>;
