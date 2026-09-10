import {
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
import { Cause, Data, type Duration, Effect, Option, ParseResult, Schedule, Schema } from "effect";
import { dual } from "effect/Function";
import type * as Pipeable from "effect/Pipeable";

const pipeSelf = function (this: unknown, ...operations: ReadonlyArray<(value: unknown) => unknown>): unknown {
  return operations.reduce<unknown>((value, operation) => operation(value), this);
} as Pipeable.Pipeable["pipe"];

type AnySchema = Schema.Schema.Any;

export type RequestMethod = string;

export type QueryParamValue = string | true;
export type QueryParamsInput =
  | Readonly<Record<string, QueryParamValue | ReadonlyArray<QueryParamValue> | undefined>>
  | Iterable<readonly [string, QueryParamValue]>
  | URLSearchParams;

type QueryParams = ReadonlyArray<readonly [string, QueryParamValue]>;

export interface RequestBodyCodec<Input = unknown> {
  readonly name: string;
  readonly encode: (
    input: Input,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, HttpBody.HttpBodyError>;
}

const jsonRequestBodyCodec = {
  name: "json" as const,
  encode: (input: unknown, request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.bodyJson(request, input),
} satisfies RequestBodyCodec<unknown>;

export const RequestBody = {
  json: jsonRequestBodyCodec,
  text: (contentType?: string) =>
    ({
      name: "text" as const,
      encode: (input: string, request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientRequest.bodyText(request, input, contentType)),
    }) satisfies RequestBodyCodec<string>,
  uint8Array: (contentType?: string) =>
    ({
      name: "uint8-array" as const,
      encode: (input: Uint8Array, request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(HttpClientRequest.bodyUint8Array(request, input, contentType)),
    }) satisfies RequestBodyCodec<Uint8Array>,
  urlParams: {
    name: "url-params" as const,
    encode: (input: UrlParams.Input, request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientRequest.bodyUrlParams(request, input)),
  } satisfies RequestBodyCodec<UrlParams.Input>,
  formData: {
    name: "form-data" as const,
    encode: (input: FormData, request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(HttpClientRequest.bodyFormData(request, input)),
  } satisfies RequestBodyCodec<FormData>,
} as const;

export type StatusPredicate = (status: number) => boolean;
export type HeaderPredicate = (value: string | undefined) => boolean;
export type StatusMatcher = number | StatusPredicate;
export type HeaderMatcher = string | HeaderPredicate;

export interface ResponseMatcher<
  Tag extends string = string,
  Status extends StatusMatcher = StatusMatcher,
  MatchHeaders extends Readonly<Record<string, HeaderMatcher>> | undefined =
    Readonly<Record<string, HeaderMatcher>> | undefined,
> {
  readonly _tag: Tag;
  readonly status: Status;
  readonly headers?: MatchHeaders;
}

export interface ResponseBodyCodec<Input = unknown> {
  readonly name: string;
  readonly decode: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<Input, HttpClientError.ResponseError>;
}

const jsonBodyCodec = {
  name: "json" as const,
  decode: (raw: HttpClientResponse.HttpClientResponse) => raw.json,
} satisfies ResponseBodyCodec<unknown>;

const textBodyCodec = {
  name: "text" as const,
  decode: (raw: HttpClientResponse.HttpClientResponse) => raw.text,
} satisfies ResponseBodyCodec<string>;

const noBodyCodec = {
  name: "none" as const,
  decode: (raw: HttpClientResponse.HttpClientResponse) => Effect.as(raw.arrayBuffer, undefined),
} satisfies ResponseBodyCodec<undefined>;

export const ResponseBody = {
  json: jsonBodyCodec,
  text: textBodyCodec,
  none: noBodyCodec,
} as const;

type AnyResponseBodyCodec = ResponseBodyCodec;
export type DefaultResponseBodyCodec = typeof ResponseBody.json | typeof ResponseBody.text;
type ResponseBodyCodecOrDefault = AnyResponseBodyCodec | undefined;

export interface ResponseRule<
  Matcher extends ResponseMatcher = ResponseMatcher,
  S extends AnySchema = AnySchema,
  Codec extends ResponseBodyCodecOrDefault = undefined,
> {
  readonly match: Matcher;
  readonly schema: S;
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

export interface ResponseEnvelope<Matcher extends ResponseMatcher, Body> {
  readonly _tag: Matcher["_tag"];
  readonly status: MatchedStatus<Matcher>;
  readonly headers: Headers.Headers & MatchedHeaders<Matcher>;
  readonly body: Body;
  readonly matched: Matcher;
}

type EnvelopeOfRule<Rule> =
  Rule extends ResponseRule<infer Matcher, infer S, ResponseBodyCodecOrDefault>
    ? ResponseEnvelope<Matcher, Schema.Schema.Type<S>>
    : never;

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

export type PathParameters<Path extends string> = {
  readonly [Name in PathParameterNames<Path>]: string;
};

export type PathArguments<Path extends string> = [PathParameterNames<Path>] extends [never]
  ? readonly []
  : readonly [parameters: PathParameters<Path>];

export class UnhandledResponse extends Data.TaggedError("UnhandledResponse")<{
  readonly response: HttpClientResponse.HttpClientResponse;
}> {
  get status(): number {
    return this.response.status;
  }

  get headers(): Headers.Headers {
    return this.response.headers;
  }
}

export class RequestBodyNotAllowed extends Data.TaggedError("RequestBodyNotAllowed")<{
  readonly request: HttpClientRequest.HttpClientRequest;
}> {}

export class RequestBodyRequired extends Data.TaggedError("RequestBodyRequired")<{
  readonly method: RequestMethod;
  readonly path: string;
  readonly reason: "Call setBody before reading effect";
}> {}

export class InvalidPathArguments extends Error {
  readonly name = "InvalidPathArguments";

  constructor(
    readonly path: string,
    readonly expected: ReadonlyArray<string>,
    readonly received: ReadonlyArray<string>,
    readonly argumentCount: number,
  ) {
    super(
      expected.length === 0
        ? `Path ${JSON.stringify(path)} does not accept arguments; received ${argumentCount}`
        : `Path ${JSON.stringify(path)} requires one parameter object with exactly ${JSON.stringify(expected)}; received ${argumentCount} arguments with keys ${JSON.stringify(received)}`,
    );
  }
}

export class InvalidPathParameterValue extends Error {
  readonly name = "InvalidPathParameterValue";

  constructor(
    readonly path: string,
    readonly parameter: string,
    readonly reason: "empty" | "not-string",
  ) {
    super(
      `Path parameter ${JSON.stringify(parameter)} for ${JSON.stringify(path)} must be a non-empty string; received ${reason === "empty" ? "an empty string" : "a non-string value"}`,
    );
  }
}

export class DuplicateResponseTag extends Error {
  readonly name = "DuplicateResponseTag";

  constructor(
    readonly tag: string,
    readonly owner: "api" | "request",
  ) {
    super(`Duplicate response tag ${JSON.stringify(tag)} in ${owner} declaration`);
  }
}

export class InvalidRetryCount extends Error {
  readonly name = "InvalidRetryCount";

  constructor(readonly retries: number) {
    super(`Retry count must be a finite, non-negative integer; received ${String(retries)}`);
  }
}

export class AbsolutePathWithBaseUrl extends Error {
  readonly name = "AbsolutePathWithBaseUrl";

  constructor(
    readonly baseUrl: string,
    readonly path: string,
  ) {
    super(`Cannot combine base URL ${JSON.stringify(baseUrl)} with absolute path ${JSON.stringify(path)}`);
  }
}

export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  readonly responseTag: string;
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly cause: ParseResult.ParseError;
}> {
  get status(): number {
    return this.response.status;
  }
}

export class RequestBodyEncodeError extends Data.TaggedError("RequestBodyEncodeError")<{
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly cause: ParseResult.ParseError | HttpBody.HttpBodyError;
}> {}

export interface CachePolicy {
  readonly control?: string;
  readonly fetch?: RequestCache;
}

export type RetryInput =
  HttpClientResponse.HttpClientResponse | HttpClientError.HttpClientError | Cause.TimeoutException;
export type RetrySchedule = Schedule.Schedule<unknown, RetryInput, never>;

export interface RetryPolicy {
  readonly times: number;
  readonly schedule?: RetrySchedule;
  readonly mode?: "errors-only" | "response-only" | "both";
}

export interface RequestOptions {
  readonly headers?: Headers.Input;
  readonly urlParams?: QueryParamsInput;
  readonly responseCodec?: DefaultResponseBodyCodec;
  readonly cache?: CachePolicy;
  readonly timeout?: Duration.DurationInput;
  readonly retry?: RetryPolicy;
  readonly retries?: number;
  readonly transformRequest?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest;
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

export interface ApiOptions<Defaults extends ReadonlyArray<AnyResponseRule> = readonly []> extends RequestOptions {
  readonly responses?: Defaults & UniqueResponseRules<Defaults>;
}

export interface RequestDefinition<
  Method extends RequestMethod,
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  DefaultBody = undefined,
> extends RequestOptions {
  readonly method: Method;
  readonly path: Path;
  readonly body?: Uppercase<Method> extends "GET" | "HEAD" ? never : Body;
  readonly bodyCodec?: Uppercase<Method> extends "GET" | "HEAD"
    ? never
    : Body extends AnySchema
      ? RequestBodyCodec<Schema.Schema.Encoded<Body>>
      : never;
  readonly defaultBody?: Uppercase<Method> extends "GET" | "HEAD"
    ? never
    : Body extends AnySchema
      ? DefaultBodyValue<Body, DefaultBody>
      : never;
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

interface UrlParamSetter<Output> {
  (key: string, value: QueryParamValue): Output;
  (key: string, currentValue: QueryParamValue, replacementValue: QueryParamValue): Output;
}

interface UrlParamRemover<Output> {
  (key: string): Output;
  (key: string, value: QueryParamValue): Output;
}

export interface RequestPlan<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
>
  extends Pipeable.Pipeable {
  readonly setBody: BodySetter<Body, Rules>;
  readonly setRequestBodyCodec: RequestBodyCodecSetter<Body, Rules, BodyReady>;
  readonly setUrlParam: UrlParamSetter<RequestPlan<Body, Rules, BodyReady>>;
  readonly setUrlParams: (params: QueryParamsInput) => RequestPlan<Body, Rules, BodyReady>;
  readonly appendUrlParam: (key: string, value: QueryParamValue) => RequestPlan<Body, Rules, BodyReady>;
  readonly removeUrlParam: UrlParamRemover<RequestPlan<Body, Rules, BodyReady>>;
  readonly setHeader: (name: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setHeaders: (headers: Headers.Input) => RequestPlan<Body, Rules, BodyReady>;
  readonly removeHeader: (name: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setCache: (cache: CachePolicy | undefined) => RequestPlan<Body, Rules, BodyReady>;
  readonly setResponseCodec: (codec: DefaultResponseBodyCodec) => RequestPlan<Body, Rules, BodyReady>;
  readonly setBaseUrl: (baseUrl: string | undefined) => RequestPlan<Body, Rules, BodyReady>;
  readonly setTimeout: (timeout: Duration.DurationInput | undefined) => RequestPlan<Body, Rules, BodyReady>;
  readonly setRetry: (retry: RetryPolicy | undefined) => RequestPlan<Body, Rules, BodyReady>;
  readonly setRetries: (retries: number) => RequestPlan<Body, Rules, BodyReady>;
  readonly mapRequest: (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) => RequestPlan<Body, Rules, BodyReady>;
  readonly mapClient: (
    transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
  ) => RequestPlan<Body, Rules, BodyReady>;
  readonly setResponseSchema: <
    const Matcher extends ResponseMatcher,
    const S extends AnySchema,
    const Codec extends ResponseBodyCodecOrDefault = undefined,
  >(
    match: Matcher,
    schema: S,
    options?: CodecOptions<S, Codec>,
  ) => RequestPlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S, Codec>>, BodyReady>;
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

export type Endpoint<
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
> = ((...pathArguments: PathArguments<Path>) => RequestPlan<Body, Rules, BodyReady>) & Pipeable.Pipeable;

export const setBody =
  <Value>(body: Value) =>
  <Body extends AnySchema, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: Value extends Schema.Schema.Type<Body> ? RequestPlan<Body, Rules, BodyReady> : never,
  ): RequestPlan<Body, Rules, true> =>
    plan.setBody(body as Schema.Schema.Type<Body>);

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

export const setUrlParams =
  (params: QueryParamsInput) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setUrlParams(params);

export const appendUrlParam =
  (key: string, value: QueryParamValue) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.appendUrlParam(key, value);

export function removeUrlParam(key: string): PlanTransform;
export function removeUrlParam(key: string, value: QueryParamValue): PlanTransform;
export function removeUrlParam(key: string, value?: QueryParamValue): PlanTransform {
  return (plan) => (value === undefined ? plan.removeUrlParam(key) : plan.removeUrlParam(key, value));
}

export const setHeader =
  (name: string, value: string) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setHeader(name, value);

export const setHeaders =
  (headers: Headers.Input) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setHeaders(headers);

export const removeHeader =
  (name: string) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.removeHeader(name);

export const setCache =
  (cache: CachePolicy | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setCache(cache);

export const setResponseCodec =
  (codec: DefaultResponseBodyCodec) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setResponseCodec(codec);

export const setBaseUrl =
  (baseUrl: string | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setBaseUrl(baseUrl);

export const setTimeout =
  (timeout: Duration.DurationInput | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setTimeout(timeout);

export const setRetry =
  (retry: RetryPolicy | undefined) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setRetry(retry);

export const setRetries =
  (retries: number) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setRetries(retries);

export const mapRequest =
  (transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.mapRequest(transform);

export const mapClient =
  (transform: (client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.mapClient(transform);

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

export const toEffect = <
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean,
>(
  plan: RequestPlan<Body, Rules, BodyReady>,
): RequestPlan<Body, Rules, BodyReady>["effect"] => plan.effect;

type PipeableEndpoint<Arguments extends ReadonlyArray<unknown>, Value> = ((...arguments_: Arguments) => Value) &
  Pipeable.Pipeable;

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
  readonly headers: Headers.Headers;
  readonly urlParams: QueryParams;
  readonly responseCodec: DefaultResponseBodyCodec;
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
  readonly setHeader: (name: string, value: string) => unknown;
  readonly setHeaders: (headers: Headers.Input) => unknown;
  readonly removeHeader: (name: string) => unknown;
  readonly setCache: (cache: CachePolicy | undefined) => unknown;
  readonly setResponseCodec: (codec: DefaultResponseBodyCodec) => unknown;
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

const isTransientRetryError = (error: unknown): boolean =>
  Cause.isTimeoutException(error) ||
  (HttpClientError.isHttpClientError(error) &&
    ((error._tag === "RequestError" && error.reason === "Transport") ||
      (error._tag === "ResponseError" && isTransientResponseStatus(error.response.status))));

const withAttemptTimeout = <Success, Error, Requirements>(
  effect: Effect.Effect<Success, Error, Requirements>,
  timeout: Duration.DurationInput | undefined,
): Effect.Effect<Success, Error | Cause.TimeoutException, Requirements> =>
  timeout === undefined ? effect : Effect.timeout(effect, timeout);

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

  return Effect.gen(function* () {
    const driver = yield* Schedule.driver(schedule);
    let retries = 0;

    while (true) {
      const attempt = withAttemptTimeout(
        Effect.gen(function* () {
          const raw = yield* client.execute(request);
          if (mode !== "errors-only" && retries < times && isTransientResponseStatus(raw.status)) {
            return { _tag: "RetryResponse" as const, response: raw };
          }
          return { _tag: "Done" as const, value: yield* handleResponse(raw) };
        }),
        timeout,
      );
      const outcome = yield* Effect.either(attempt);

      if (outcome._tag === "Left") {
        if (mode === "response-only" || retries >= times || !isTransientRetryError(outcome.left)) {
          return yield* Effect.fail(outcome.left);
        }

        const canRetry = yield* driver.next(outcome.left as RetryInput).pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        );
        if (!canRetry) return yield* Effect.fail(outcome.left);

        retries += 1;
        continue;
      }

      if (outcome.right._tag === "Done") return outcome.right.value;

      const canRetry = yield* driver.next(outcome.right.response).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (!canRetry) return yield* withAttemptTimeout(handleResponse(outcome.right.response), timeout);

      yield* withAttemptTimeout(outcome.right.response.arrayBuffer, timeout);
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

const matches = (rule: AnyResponseRule, status: number, headers: Headers.Headers): boolean => {
  const statusMatches =
    typeof rule.match.status === "number" ? rule.match.status === status : rule.match.status(status);
  return (
    statusMatches &&
    Object.entries(rule.match.headers ?? {}).every(([name, matcher]) => {
      const value = headers[name.toLowerCase()];
      return typeof matcher === "string" ? value === matcher : matcher(value);
    })
  );
};

const specificity = (rule: AnyResponseRule): number => Object.keys(rule.match.headers ?? {}).length;

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
): AnyResponseRule | undefined => {
  let selected: AnyResponseRule | undefined;
  let selectedSpecificity = -1;

  for (const rule of rules) {
    const ruleSpecificity = specificity(rule);
    if (matches(rule, status, headers) && ruleSpecificity > selectedSpecificity) {
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

  const effect =
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
          request = HttpClientRequest.setHeaders(request, state.headers);

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
            const rule = findResponseRule(rules, raw.status, raw.headers);
            if (rule === undefined) return Effect.fail(new UnhandledResponse({ response: raw }));

            return Effect.map(decodeResponse(rule, raw, state.responseCodec), (body) => {
              const envelope = {
                _tag: rule.match._tag,
                status: raw.status,
                headers: raw.headers,
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
    setHeader: (name, value) => update({ headers: Headers.set(state.headers, name, value) }),
    setHeaders: (headers) => update({ headers: Headers.setAll(state.headers, headers) }),
    removeHeader: (name) => update({ headers: Headers.remove(state.headers, name) }),
    setCache: (cache) => update({ cache }),
    setResponseCodec: (responseCodec) => update({ responseCodec }),
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
    effect,
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
    const baseHeaders = Headers.fromInput(definition.baseOptions?.headers);
    const headers = Headers.setAll(baseHeaders, definition.headers ?? {});
    const baseParams = queryParamsFromInput(definition.baseOptions?.urlParams ?? {});
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
      cache: definition.cache ?? definition.baseOptions?.cache,
      timeout: definition.timeout ?? definition.baseOptions?.timeout,
      retry,
      requestTransforms,
      clientTransforms,
    });
  };
  return makePipeableEndpoint(endpoint);
};

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

export interface Api<Defaults extends ReadonlyArray<AnyResponseRule>> extends Pipeable.Pipeable {
  readonly baseUrl: string;
  readonly extend: <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(
    options: ApiOptions<Overrides>,
  ) => Api<MergeResponseRules<Defaults, Overrides>>;
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

export const createApi = <const Defaults extends ReadonlyArray<AnyResponseRule> = readonly []>(
  baseUrl: string,
  options: ApiOptions<Defaults> = {} as ApiOptions<Defaults>,
): Api<Defaults> => {
  validateUniqueResponseTags(options.responses ?? [], "api");
  return {
    pipe: pipeSelf,
    baseUrl,
    extend: <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(
      overrides: ApiOptions<Overrides>,
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

      return createApi<MergeResponseRules<Defaults, Overrides>>(baseUrl, {
        headers: Headers.setAll(Headers.fromInput(options.headers), overrides.headers ?? {}),
        urlParams: setQueryParams(queryParamsFromInput(options.urlParams ?? {}), overrides.urlParams ?? {}),
        responseCodec: overrides.responseCodec ?? options.responseCodec,
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

export const extendApi =
  <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(options: ApiOptions<Overrides>) =>
  <Defaults extends ReadonlyArray<AnyResponseRule>>(api: Api<Defaults>): Api<MergeResponseRules<Defaults, Overrides>> =>
    api.extend(options);
