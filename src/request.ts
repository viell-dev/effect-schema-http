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
import { Data, Effect, type ParseResult, Schema } from "effect";

type AnySchema = Schema.Schema.Any;

export interface ResponseMatcher<
  Key extends string = string,
  Status extends number = number,
  MatchHeaders extends Readonly<Record<string, string>> | undefined = Readonly<Record<string, string>> | undefined,
> {
  readonly key: Key;
  readonly status: Status;
  readonly headers?: MatchHeaders;
}

export interface ResponseRule<Matcher extends ResponseMatcher = ResponseMatcher, S extends AnySchema = AnySchema> {
  readonly match: Matcher;
  readonly schema: S;
  readonly body: "json" | "none";
}

type AnyResponseRule = ResponseRule<ResponseMatcher, AnySchema>;

export const response = <const Matcher extends ResponseMatcher, const S extends AnySchema>(
  match: Matcher,
  schema: S,
  options?: { readonly body?: "json" | "none" },
): ResponseRule<Matcher, S> => ({
  match,
  schema,
  body: options?.body ?? "json",
});

type MatcherOf<Rule extends AnyResponseRule> = Rule extends ResponseRule<infer Matcher, AnySchema> ? Matcher : never;

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
  ? MergeResponseRules<SetResponseRule<Defaults, Head>, Tail>
  : Defaults;

type MatchedHeaders<Matcher extends ResponseMatcher> =
  Matcher extends ResponseMatcher<string, number, infer MatchHeaders extends Readonly<Record<string, string>>>
    ? MatchHeaders
    : unknown;

export interface ResponseEnvelope<Matcher extends ResponseMatcher, Body> {
  readonly key: Matcher["key"];
  readonly status: Matcher["status"];
  readonly headers: Headers.Headers & MatchedHeaders<Matcher>;
  readonly body: Body;
  readonly matched: Matcher;
}

type EnvelopeOfRule<Rule> =
  Rule extends ResponseRule<infer Matcher, infer S> ? ResponseEnvelope<Matcher, Schema.Schema.Type<S>> : never;

export type ResponseOf<Rules extends ReadonlyArray<AnyResponseRule>> = EnvelopeOfRule<Rules[number]>;

type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> =
  Rules[number] extends ResponseRule<ResponseMatcher, infer S> ? Schema.Schema.Context<S> : never;

type BodyContextOf<Body extends AnySchema | undefined> = Body extends AnySchema ? Schema.Schema.Context<Body> : never;

type InitialBodyReady<Body extends AnySchema | undefined, DefaultBody = undefined> = Body extends AnySchema
  ? [DefaultBody] extends [undefined]
    ? false
    : true
  : true;

type PathArguments<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? Segment extends `:${string}`
    ? readonly [value: string, ...PathArguments<Rest>]
    : PathArguments<Rest>
  : Path extends `:${string}`
    ? readonly [value: string]
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

export interface CachePolicy {
  readonly control?: string;
  readonly fetch?: RequestCache;
}

export interface RequestOptions {
  readonly headers?: Headers.Input;
  readonly urlParams?: UrlParams.Input;
  readonly cache?: CachePolicy;
  readonly retries?: number;
  readonly transformRequest?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest;
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

export interface ApiOptions<Defaults extends ReadonlyArray<AnyResponseRule> = readonly []> extends RequestOptions {
  readonly responses?: Defaults;
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
  readonly responses?: Rules;
}

type BodySetter<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
> = Body extends AnySchema ? (body: Schema.Schema.Type<Body>) => RequestPlan<Body, Rules, true> : never;

export interface RequestPlan<
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
> {
  readonly setBody: BodySetter<Body, Rules>;
  readonly setUrlParam: (key: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setUrlParams: (params: UrlParams.Input) => RequestPlan<Body, Rules, BodyReady>;
  readonly setHeader: (name: string, value: string) => RequestPlan<Body, Rules, BodyReady>;
  readonly setCache: (cache: CachePolicy | undefined) => RequestPlan<Body, Rules, BodyReady>;
  readonly setRetries: (retries: number) => RequestPlan<Body, Rules, BodyReady>;
  readonly mapRequest: (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) => RequestPlan<Body, Rules, BodyReady>;
  readonly setResponseSchema: <const Matcher extends ResponseMatcher, const S extends AnySchema>(
    match: Matcher,
    schema: S,
    options?: { readonly body?: "json" | "none" },
  ) => RequestPlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S>>, BodyReady>;
  readonly effect: BodyReady extends true
    ? Effect.Effect<
        ResponseOf<Rules>,
        | UnhandledResponse
        | RequestBodyNotAllowed
        | HttpBody.HttpBodyError
        | HttpClientError.HttpClientError
        | ParseResult.ParseError,
        HttpClient.HttpClient | BodyContextOf<Body> | ResponseContextOf<Rules>
      >
    : never;
}

export type Endpoint<
  Path extends string,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
  BodyReady extends boolean = InitialBodyReady<Body>,
> = (...pathArguments: PathArguments<Path>) => RequestPlan<Body, Rules, BodyReady>;

interface InternalDefinition<Body extends AnySchema | undefined> extends RequestOptions {
  readonly method: HttpMethod.HttpMethod;
  readonly path: string;
  readonly body?: Body;
  readonly defaultBody?: unknown;
  readonly baseUrl?: string;
  readonly baseOptions?: RequestOptions;
}

interface PlanState {
  readonly body: unknown;
  readonly hasBody: boolean;
  readonly headers: Headers.Headers;
  readonly urlParams: UrlParams.UrlParams;
  readonly cache: CachePolicy | undefined;
  readonly retries: number;
  readonly requestTransforms: ReadonlyArray<
    (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest
  >;
}

const joinUrl = (baseUrl: string | undefined, path: string): string => {
  if (baseUrl === undefined) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
};

const fillPath = (path: string, pathArguments: ReadonlyArray<string>): string => {
  let argumentIndex = 0;
  return path
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? encodeURIComponent(pathArguments[argumentIndex++] ?? segment) : segment,
    )
    .join("/");
};

const matches = (rule: AnyResponseRule, status: number, headers: Headers.Headers): boolean =>
  rule.match.status === status &&
  Object.entries(rule.match.headers ?? {}).every(([name, value]) => headers[name.toLowerCase()] === value);

const specificity = (rule: AnyResponseRule): number => Object.keys(rule.match.headers ?? {}).length;

const setResponseRule = (
  rules: ReadonlyArray<AnyResponseRule>,
  rule: AnyResponseRule,
): ReadonlyArray<AnyResponseRule> => [rule, ...rules.filter((candidate) => candidate.match.key !== rule.match.key)];

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
  rule.body === "none"
    ? Schema.decodeUnknown(rule.schema)(undefined)
    : HttpClientResponse.schemaBodyJson(rule.schema)(raw);

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
    let request = HttpClientRequest.make(definition.method)(joinUrl(definition.baseUrl, definition.path));
    request = HttpClientRequest.setHeaders(request, state.headers);
    request = HttpClientRequest.setUrlParams(request, state.urlParams);

    if (state.cache?.control !== undefined) {
      request = HttpClientRequest.setHeader(request, "cache-control", state.cache.control);
    }

    if (definition.body !== undefined && state.hasBody) {
      request = yield* HttpClientRequest.schemaBodyJson(definition.body)(state.body)(request);
    }

    for (const transform of state.requestTransforms) request = transform(request);

    if ((request.method === "GET" || request.method === "HEAD") && request.body._tag !== "Empty") {
      return yield* new RequestBodyNotAllowed({ request });
    }

    const baseClient = yield* HttpClient.HttpClient;
    const apiClient = definition.baseOptions?.transformClient?.(baseClient) ?? baseClient;
    const endpointClient = definition.transformClient?.(apiClient) ?? apiClient;
    const client =
      state.retries > 0 ? HttpClient.retryTransient(endpointClient, { times: state.retries }) : endpointClient;
    let send = client.execute(request);

    if (state.cache?.fetch !== undefined) {
      send = Effect.provideService(send, FetchHttpClient.RequestInit, { cache: state.cache.fetch });
    }

    const raw = yield* send;
    const rule = findResponseRule(rules, raw.status, raw.headers);

    if (rule === undefined) return yield* new UnhandledResponse({ response: raw });

    const body = yield* decodeResponse(rule, raw);
    return {
      key: rule.match.key,
      status: rule.match.status,
      headers: raw.headers,
      body,
      matched: rule.match,
    } as ResponseOf<Rules>;
  });

  return {
    setBody: (body: unknown) => makePlan<Body, Rules, true>(definition, rules, { ...state, body, hasBody: true }),
    setUrlParam: (key, value) => update({ urlParams: UrlParams.set(state.urlParams, key, value) }),
    setUrlParams: (params) => update({ urlParams: UrlParams.fromInput(params) }),
    setHeader: (name, value) => update({ headers: Headers.set(state.headers, name, value) }),
    setCache: (cache) => update({ cache }),
    setRetries: (retries) => update({ retries: Math.max(0, Math.floor(retries)) }),
    mapRequest: (transform) => update({ requestTransforms: [...state.requestTransforms, transform] }),
    setResponseSchema: <const Matcher extends ResponseMatcher, const S extends AnySchema>(
      match: Matcher,
      schema: S,
      options?: { readonly body?: "json" | "none" },
    ) => {
      const rule = response(match, schema, options);
      return makePlan<Body, SetResponseRule<Rules, ResponseRule<Matcher, S>>, BodyReady>(
        definition,
        setResponseRule(rules, rule) as SetResponseRule<Rules, ResponseRule<Matcher, S>>,
        state,
      );
    },
    effect,
  } as RequestPlan<Body, Rules, BodyReady>;
};

const createRequestInternal =
  <
    Path extends string,
    Body extends AnySchema | undefined,
    Rules extends ReadonlyArray<AnyResponseRule>,
    BodyReady extends boolean,
  >(
    definition: InternalDefinition<Body>,
    rules: Rules,
  ): Endpoint<Path, Body, Rules, BodyReady> =>
  (...pathArguments: PathArguments<Path>) => {
    const baseHeaders = Headers.fromInput(definition.baseOptions?.headers);
    const headers = Headers.setAll(baseHeaders, definition.headers ?? {});
    const baseParams = UrlParams.fromInput(definition.baseOptions?.urlParams ?? {});
    const urlParams = UrlParams.appendAll(baseParams, definition.urlParams ?? {});
    const requestTransforms = [definition.baseOptions?.transformRequest, definition.transformRequest].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );

    return makePlan<Body, Rules, BodyReady>({ ...definition, path: fillPath(definition.path, pathArguments) }, rules, {
      body: definition.defaultBody,
      hasBody: Object.hasOwn(definition, "defaultBody"),
      headers,
      urlParams,
      cache: definition.cache ?? definition.baseOptions?.cache,
      retries: definition.retries ?? definition.baseOptions?.retries ?? 0,
      requestTransforms,
    });
  };

export const createRequest = <
  const Method extends HttpMethod.HttpMethod,
  const Path extends string,
  Body extends AnySchema | undefined = undefined,
  const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
  const DefaultBody = undefined,
>(
  definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
): Endpoint<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>> =>
  createRequestInternal<Path, Body, Rules, InitialBodyReady<Body, DefaultBody>>(
    definition,
    definition.responses ?? ([] as unknown as Rules),
  );

export interface Api<Defaults extends ReadonlyArray<AnyResponseRule>> {
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
): Api<Defaults> => ({
  createRequest: <
    const Method extends HttpMethod.HttpMethod,
    const Path extends string,
    Body extends AnySchema | undefined = undefined,
    const Rules extends ReadonlyArray<AnyResponseRule> = readonly [],
    const DefaultBody = undefined,
  >(
    definition: RequestDefinition<Method, Path, Body, Rules, DefaultBody>,
  ): Endpoint<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>> => {
    const rules = mergeResponseRules(options.responses ?? [], definition.responses ?? []);
    return createRequestInternal<Path, Body, MergeResponseRules<Defaults, Rules>, InitialBodyReady<Body, DefaultBody>>(
      { ...definition, baseUrl, baseOptions: options },
      rules as MergeResponseRules<Defaults, Rules>,
    );
  },
});
