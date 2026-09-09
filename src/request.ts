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

export type StatusPredicate = (status: number) => boolean;
export type HeaderPredicate = (value: string | undefined) => boolean;
export type StatusMatcher = number | StatusPredicate;
export type HeaderMatcher = string | HeaderPredicate;

export interface ResponseMatcher<
  Key extends string = string,
  Status extends StatusMatcher = StatusMatcher,
  MatchHeaders extends Readonly<Record<string, HeaderMatcher>> | undefined =
    Readonly<Record<string, HeaderMatcher>> | undefined,
> {
  readonly key: Key;
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

export interface ResponseRule<
  Matcher extends ResponseMatcher = ResponseMatcher,
  S extends AnySchema = AnySchema,
  Codec extends AnyResponseBodyCodec = AnyResponseBodyCodec,
> {
  readonly match: Matcher;
  readonly schema: S;
  readonly codec: Codec;
}

type AnyResponseRule = ResponseRule<ResponseMatcher, AnySchema, AnyResponseBodyCodec>;

type CodecOptions<S extends AnySchema, Codec extends AnyResponseBodyCodec> = Codec["name"] extends "none"
  ? undefined extends Schema.Schema.Type<S>
    ? { readonly codec: Codec }
    : never
  : { readonly codec: Codec };

export const response = <
  const Matcher extends ResponseMatcher,
  const S extends AnySchema,
  const Codec extends AnyResponseBodyCodec = typeof ResponseBody.json,
>(
  match: Matcher,
  schema: S,
  options?: CodecOptions<S, Codec>,
): ResponseRule<Matcher, S, Codec> => ({
  match,
  schema,
  codec: (options?.codec ?? ResponseBody.json) as unknown as Codec,
});

type MatcherOf<Rule extends AnyResponseRule> =
  Rule extends ResponseRule<infer Matcher, AnySchema, AnyResponseBodyCodec> ? Matcher : never;

type KeyOf<Rule extends AnyResponseRule> = MatcherOf<Rule>["key"];

type RemoveMatchingRule<Rules extends ReadonlyArray<AnyResponseRule>, Key extends string> = Rules extends readonly [
  infer Head extends AnyResponseRule,
  ...infer Tail extends ReadonlyArray<AnyResponseRule>,
]
  ? KeyOf<Head> extends Key
    ? RemoveMatchingRule<Tail, Key>
    : readonly [Head, ...RemoveMatchingRule<Tail, Key>]
  : readonly [];

type SetResponseRule<Rules extends ReadonlyArray<AnyResponseRule>, Rule extends AnyResponseRule> = readonly [
  Rule,
  ...RemoveMatchingRule<Rules, KeyOf<Rule>>,
];

type MergeResponseRules<
  Defaults extends ReadonlyArray<AnyResponseRule>,
  Overrides extends ReadonlyArray<AnyResponseRule>,
> = Overrides extends readonly [
  infer Head extends AnyResponseRule,
  ...infer Tail extends ReadonlyArray<AnyResponseRule>,
]
  ? readonly [Head, ...MergeResponseRules<RemoveMatchingRule<Defaults, KeyOf<Head>>, Tail>]
  : Defaults;

type DuplicateResponseKeyOf<
  Rules extends ReadonlyArray<AnyResponseRule>,
  Seen extends string = never,
> = Rules extends readonly [infer Head extends AnyResponseRule, ...infer Tail extends ReadonlyArray<AnyResponseRule>]
  ? KeyOf<Head> extends Seen
    ? KeyOf<Head>
    : DuplicateResponseKeyOf<Tail, Seen | KeyOf<Head>>
  : never;

type UniqueResponseRules<Rules extends ReadonlyArray<AnyResponseRule>> =
  DuplicateResponseKeyOf<Rules> extends never
    ? unknown
    : { readonly "Duplicate response key": DuplicateResponseKeyOf<Rules> };

type ExactMatchedHeaders<MatchHeaders extends Readonly<Record<string, HeaderMatcher>>> = {
  readonly [Key in keyof MatchHeaders as MatchHeaders[Key] extends string ? Key : never]: MatchHeaders[Key];
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
  readonly key: Matcher["key"];
  readonly status: MatchedStatus<Matcher>;
  readonly headers: Headers.Headers & MatchedHeaders<Matcher>;
  readonly body: Body;
  readonly matched: Matcher;
  readonly response: HttpClientResponse.HttpClientResponse;
}

type EnvelopeOfRule<Rule> =
  Rule extends ResponseRule<infer Matcher, infer S, AnyResponseBodyCodec>
    ? ResponseEnvelope<Matcher, Schema.Schema.Type<S>>
    : never;

export type ResponseOf<Rules extends ReadonlyArray<AnyResponseRule>> = EnvelopeOfRule<Rules[number]>;

type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> =
  Rules[number] extends ResponseRule<ResponseMatcher, infer S, AnyResponseBodyCodec> ? Schema.Schema.Context<S> : never;

type BodyContextOf<Body extends AnySchema | undefined> = Body extends AnySchema ? Schema.Schema.Context<Body> : never;
type RequestEncodingError<Body extends AnySchema | undefined> = Body extends AnySchema ? HttpBody.HttpBodyError : never;
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

type PathParameterCharacter = LowercaseLetter | Uppercase<LowercaseLetter> | `${number}` | "_";

type TakePathParameter<Input extends string, Name extends string = ""> = Input extends `${infer Character}${infer Rest}`
  ? Character extends PathParameterCharacter
    ? TakePathParameter<Rest, `${Name}${Character}`>
    : readonly [name: Name, rest: Input]
  : readonly [name: Name, rest: ""];

type PathArguments<Path extends string> = Path extends `${infer Character}${infer Rest}`
  ? Character extends ":"
    ? TakePathParameter<Rest> extends readonly [infer Name extends string, infer Remaining extends string]
      ? Name extends ""
        ? PathArguments<Rest>
        : readonly [value: string, ...PathArguments<Remaining>]
      : never
    : PathArguments<Rest>
  : readonly [];

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

export class InvalidPathArguments extends Data.TaggedError("InvalidPathArguments")<{
  readonly path: string;
  readonly expected: number;
  readonly received: number;
}> {}

export class DuplicateResponseKey extends Data.TaggedError("DuplicateResponseKey")<{
  readonly key: string;
  readonly owner: "api" | "request";
}> {}

export class InvalidRetryCount extends Data.TaggedError("InvalidRetryCount")<{
  readonly retries: number;
}> {}

export class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  readonly key: string;
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly cause: ParseResult.ParseError;
}> {
  get status(): number {
    return this.response.status;
  }
}

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
  readonly urlParams?: UrlParams.Input;
  readonly cache?: CachePolicy;
  readonly timeout?: Duration.DurationInput;
  readonly retry?: RetryPolicy;
  readonly retries?: number;
  readonly transformRequest?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest;
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

export interface ApiOptions<Defaults extends ReadonlyArray<AnyResponseRule> = readonly []> extends RequestOptions {
  readonly responses?: Defaults & UniqueResponseRules<Defaults>;
}

export interface RequestDefinition<
  Method extends HttpMethod.HttpMethod,
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  DefaultBody = undefined,
> extends RequestOptions {
  readonly method: Method;
  readonly path: Path;
  readonly body?: Method extends "GET" | "HEAD" ? never : Body;
  readonly defaultBody?: Method extends "GET" | "HEAD"
    ? never
    : Body extends AnySchema
      ? DefaultBody extends Schema.Schema.Type<Body>
        ? DefaultBody
        : never
      : never;
  readonly responses?: Rules & UniqueResponseRules<Rules>;
}

type BodySetter<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
> = Body extends AnySchema ? (body: Schema.Schema.Type<Body>) => RequestPlan<Body, Rules, true> : never;

export interface RequestPlan<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
>
  extends Pipeable.Pipeable {
  readonly setBody: BodySetter<Body, Rules>;
  readonly setUrlParam: (key: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setUrlParams: (params: UrlParams.Input) => RequestPlan<Body, Rules, BodyReady>;
  readonly appendUrlParam: (key: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly removeUrlParam: (key: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setHeader: (name: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setHeaders: (headers: Headers.Input) => RequestPlan<Body, Rules, BodyReady>;
  readonly removeHeader: (name: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setCache: (cache: CachePolicy | undefined) => RequestPlan<Body, Rules, BodyReady>;
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
    const Codec extends AnyResponseBodyCodec = typeof ResponseBody.json,
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
    : never;
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

export const setUrlParam =
  (key: string, value: string) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setUrlParam(key, value);

export const setUrlParams =
  (params: UrlParams.Input) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.setUrlParams(params);

export const appendUrlParam =
  (key: string, value: string) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.appendUrlParam(key, value);

export const removeUrlParam =
  (key: string) =>
  <Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>, BodyReady extends boolean>(
    plan: RequestPlan<Body, Rules, BodyReady>,
  ): RequestPlan<Body, Rules, BodyReady> =>
    plan.removeUrlParam(key);

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
    const Codec extends AnyResponseBodyCodec = typeof ResponseBody.json,
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

type PipeableEndpoint<Arguments extends ReadonlyArray<string>, Value> = ((...arguments_: Arguments) => Value) &
  Pipeable.Pipeable;

export const mapEndpoint: {
  <Input, Output>(
    transform: (value: Input) => Output,
  ): <Arguments extends ReadonlyArray<string>>(
    endpoint: PipeableEndpoint<Arguments, Input>,
  ) => PipeableEndpoint<Arguments, Output>;
  <Arguments extends ReadonlyArray<string>, Input, Output>(
    endpoint: PipeableEndpoint<Arguments, Input>,
    transform: (value: Input) => Output,
  ): PipeableEndpoint<Arguments, Output>;
} = dual(
  2,
  <Arguments extends ReadonlyArray<string>, Input, Output>(
    endpoint: PipeableEndpoint<Arguments, Input>,
    transform: (value: Input) => Output,
  ): PipeableEndpoint<Arguments, Output> =>
    makePipeableEndpoint((...arguments_: Arguments) => transform(endpoint(...arguments_))),
);

interface InternalDefinition<Body extends AnySchema | undefined> extends RequestOptions {
  readonly method: HttpMethod.HttpMethod;
  readonly path: string;
  readonly body?: Body;
  readonly defaultBody?: unknown;
  readonly baseUrl?: string;
  readonly baseOptions?: RequestOptions;
}

interface PlanState {
  readonly baseUrl: string | undefined;
  readonly body: unknown;
  readonly hasBody: boolean;
  readonly headers: Headers.Headers;
  readonly urlParams: UrlParams.UrlParams;
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
  readonly setUrlParam: (key: string, value: string) => unknown;
  readonly setUrlParams: (params: UrlParams.Input) => unknown;
  readonly appendUrlParam: (key: string, value: string) => unknown;
  readonly removeUrlParam: (key: string) => unknown;
  readonly setHeader: (name: string, value: string) => unknown;
  readonly setHeaders: (headers: Headers.Input) => unknown;
  readonly removeHeader: (name: string) => unknown;
  readonly setCache: (cache: CachePolicy | undefined) => unknown;
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
    throw new InvalidRetryCount({ retries: policy.times });
  }
  return policy.times === 0 ? undefined : policy;
};

const isTransientResponseStatus = (status: number): boolean =>
  status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

const executeWithRetry = <Error extends HttpClientError.HttpClientError | Cause.TimeoutException>(
  client: HttpClient.HttpClient.With<Error>,
  request: HttpClientRequest.HttpClientRequest,
  retry: RetryPolicy | undefined,
): Effect.Effect<HttpClientResponse.HttpClientResponse, Error | HttpClientError.ResponseError> => {
  if (retry === undefined) return client.execute(request);

  const mode = retry.mode ?? "both";
  const schedule = retry.schedule ?? defaultRetrySchedule;
  const errorRetryingClient =
    mode === "response-only"
      ? client
      : HttpClient.retryTransient(client, { mode: "errors-only", schedule, times: retry.times });
  const execute = errorRetryingClient.execute(request);
  if (mode === "errors-only") return execute;

  return Effect.gen(function* () {
    const driver = yield* Schedule.driver(schedule);
    let retries = 0;
    while (true) {
      const raw = yield* execute;
      if (!isTransientResponseStatus(raw.status) || retries >= retry.times) return raw;

      const canRetry = yield* driver.next(raw).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (!canRetry) return raw;

      yield* raw.arrayBuffer;
      retries += 1;
    }
  });
};

const joinUrl = (baseUrl: string | undefined, path: string): string => {
  if (baseUrl === undefined) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
};

const fillPath = (path: string, pathArguments: ReadonlyArray<string>): string => {
  const parameterPattern = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  const expected = Array.from(path.matchAll(parameterPattern)).length;
  if (pathArguments.length !== expected) {
    throw new InvalidPathArguments({ path, expected, received: pathArguments.length });
  }

  let argumentIndex = 0;
  return path.replace(parameterPattern, () => encodeURIComponent(pathArguments[argumentIndex++]!));
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
): ReadonlyArray<AnyResponseRule> => [rule, ...rules.filter((candidate) => candidate.match.key !== rule.match.key)];

const validateUniqueResponseKeys = (rules: ReadonlyArray<AnyResponseRule>, owner: "api" | "request"): void => {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (keys.has(rule.match.key)) throw new DuplicateResponseKey({ key: rule.match.key, owner });
    keys.add(rule.match.key);
  }
};

const mergeResponseRules = (
  defaults: ReadonlyArray<AnyResponseRule>,
  overrides: ReadonlyArray<AnyResponseRule>,
): ReadonlyArray<AnyResponseRule> => {
  let merged = defaults;
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const rule = overrides[index];
    if (rule !== undefined) merged = setResponseRule(merged, rule);
  }
  return merged;
};

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

const decodeResponse = (rule: AnyResponseRule, raw: HttpClientResponse.HttpClientResponse) =>
  Effect.flatMap(rule.codec.decode(raw), Schema.decodeUnknown(rule.schema)).pipe(
    Effect.mapError((error) =>
      ParseResult.isParseError(error)
        ? new ResponseDecodeError({ key: rule.match.key, response: raw, cause: error })
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

  const effect = Effect.gen(function* () {
    let request = HttpClientRequest.make(definition.method)(joinUrl(state.baseUrl, definition.path));
    request = HttpClientRequest.setHeaders(request, state.headers);
    request = HttpClientRequest.setUrlParams(request, state.urlParams);

    if (state.cache?.control !== undefined && !Headers.has(request.headers, "cache-control")) {
      request = HttpClientRequest.setHeader(request, "cache-control", state.cache.control);
    }

    if (definition.body !== undefined && state.hasBody) {
      request = yield* HttpClientRequest.schemaBodyJson(definition.body)(state.body)(request);
    }

    for (const transform of state.requestTransforms) request = transform(request);

    if ((request.method === "GET" || request.method === "HEAD") && request.body._tag !== "Empty") {
      return yield* new RequestBodyNotAllowed({ request });
    }

    let client = yield* HttpClient.HttpClient;
    for (const transform of state.clientTransforms) client = transform(client);
    const timedClient =
      state.timeout === undefined
        ? client
        : HttpClient.transformResponse(client, (responseEffect) => Effect.timeout(responseEffect, state.timeout!));
    let send = executeWithRetry(timedClient, request, state.retry);

    if (state.cache?.fetch !== undefined) {
      const existingRequestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      send = Effect.provideService(send, FetchHttpClient.RequestInit, {
        ...Option.getOrElse(existingRequestInit, () => ({})),
        cache: state.cache.fetch,
      });
    }

    const raw = yield* send;
    const rule = findResponseRule(rules, raw.status, raw.headers);

    if (rule === undefined) return yield* new UnhandledResponse({ response: raw });

    const body = yield* decodeResponse(rule, raw);
    const envelope = {
      key: rule.match.key,
      status: raw.status,
      headers: raw.headers,
      body,
      matched: rule.match,
      response: raw,
    } satisfies ResponseEnvelope<ResponseMatcher, unknown>;
    return envelope as ResponseOf<Rules>;
  });

  const plan = {
    pipe: pipeSelf,
    setBody: (body: unknown) => makePlan<Body, Rules, true>(definition, rules, { ...state, body, hasBody: true }),
    setUrlParam: (key, value) => update({ urlParams: UrlParams.set(state.urlParams, key, value) }),
    setUrlParams: (params) => update({ urlParams: UrlParams.setAll(state.urlParams, params) }),
    appendUrlParam: (key, value) => update({ urlParams: UrlParams.append(state.urlParams, key, value) }),
    removeUrlParam: (key) => update({ urlParams: UrlParams.remove(state.urlParams, key) }),
    setHeader: (name, value) => update({ headers: Headers.set(state.headers, name, value) }),
    setHeaders: (headers) => update({ headers: Headers.setAll(state.headers, headers) }),
    removeHeader: (name) => update({ headers: Headers.remove(state.headers, name) }),
    setCache: (cache) => update({ cache }),
    setBaseUrl: (baseUrl) => update({ baseUrl }),
    setTimeout: (timeout) => update({ timeout }),
    setRetry: (retry) => update({ retry: normalizeRetry(retry) }),
    setRetries: (retries) => update({ retry: normalizeRetry(retries) }),
    mapRequest: (transform) => update({ requestTransforms: [...state.requestTransforms, transform] }),
    mapClient: (transform) => update({ clientTransforms: [...state.clientTransforms, transform] }),
    setResponseSchema: <
      const Matcher extends ResponseMatcher,
      const S extends AnySchema,
      const Codec extends AnyResponseBodyCodec = typeof ResponseBody.json,
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
    const baseHeaders = Headers.fromInput(definition.baseOptions?.headers);
    const headers = Headers.setAll(baseHeaders, definition.headers ?? {});
    const baseParams = UrlParams.fromInput(definition.baseOptions?.urlParams ?? {});
    const urlParams = UrlParams.setAll(baseParams, definition.urlParams ?? {});
    const requestTransforms = [definition.baseOptions?.transformRequest, definition.transformRequest].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );
    const clientTransforms = [definition.baseOptions?.transformClient, definition.transformClient].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );
    const retry = normalizeRetry(
      definition.retry ?? definition.retries ?? definition.baseOptions?.retry ?? definition.baseOptions?.retries,
    );

    return makePlan<Body, Rules, BodyReady>({ ...definition, path: fillPath(definition.path, pathArguments) }, rules, {
      baseUrl: definition.baseUrl,
      body: definition.defaultBody,
      hasBody: definition.defaultBody !== undefined,
      headers,
      urlParams,
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
  const Method extends HttpMethod.HttpMethod,
  const Path extends string,
  Body extends AnySchema | undefined = undefined,
  const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
  const DefaultBody = undefined,
>(
  definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
): Endpoint<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>> => {
  validateUniqueResponseKeys(definition.responses ?? [], "request");
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
    const Method extends HttpMethod.HttpMethod,
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
  validateUniqueResponseKeys(options.responses ?? [], "api");
  return {
    pipe: pipeSelf,
    baseUrl,
    extend: <const Overrides extends ReadonlyArray<AnyResponseRule> = readonly []>(
      overrides: ApiOptions<Overrides>,
    ): Api<MergeResponseRules<Defaults, Overrides>> => {
      validateUniqueResponseKeys(overrides.responses ?? [], "api");
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
        urlParams: UrlParams.setAll(UrlParams.fromInput(options.urlParams ?? {}), overrides.urlParams ?? {}),
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
      const Method extends HttpMethod.HttpMethod,
      const Path extends string,
      Body extends AnySchema | undefined = undefined,
      const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
      const DefaultBody = undefined,
    >(
      definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
    ): Endpoint<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>> => {
      validateUniqueResponseKeys(definition.responses ?? [], "request");
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
