import {
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

export interface ResponseMatcher {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ResponseRule<
  S extends AnySchema = AnySchema,
  Channel extends "success" | "failure" = "success" | "failure",
> {
  readonly match: ResponseMatcher;
  readonly schema: S;
  readonly channel: Channel;
  readonly body: "json" | "none";
}

type AnyResponseRule = ResponseRule<AnySchema, "success" | "failure">;

export const response = {
  success: <const S extends AnySchema>(
    match: ResponseMatcher,
    schema: S,
    options?: { readonly body?: "json" | "none" },
  ): ResponseRule<S, "success"> => ({
    match,
    schema,
    channel: "success",
    body: options?.body ?? "json",
  }),
  failure: <const S extends AnySchema>(
    match: ResponseMatcher,
    schema: S,
    options?: { readonly body?: "json" | "none" },
  ): ResponseRule<S, "failure"> => ({
    match,
    schema,
    channel: "failure",
    body: options?.body ?? "json",
  }),
};

type SuccessOf<Rules extends ReadonlyArray<AnyResponseRule>> = Rules[number] extends infer Rule
  ? Rule extends ResponseRule<infer S, "success">
    ? Schema.Schema.Type<S>
    : never
  : never;

type FailureOf<Rules extends ReadonlyArray<AnyResponseRule>> = Rules[number] extends infer Rule
  ? Rule extends ResponseRule<infer S, "failure">
    ? Schema.Schema.Type<S>
    : never
  : never;

type ResponseContextOf<Rules extends ReadonlyArray<AnyResponseRule>> =
  Rules[number] extends ResponseRule<infer S> ? Schema.Schema.Context<S> : never;

type BodyContextOf<Body extends AnySchema | undefined> = Body extends AnySchema ? Schema.Schema.Context<Body> : never;

type BodyArguments<Body extends AnySchema | undefined> = Body extends AnySchema
  ? readonly [body: Schema.Schema.Type<Body>]
  : readonly [];

export class UnhandledResponse extends Data.TaggedError("UnhandledResponse")<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}> {}

export interface RequestOptions {
  readonly headers?: Headers.Input;
  readonly urlParams?: UrlParams.Input;
  readonly transformRequest?: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest;
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

export type ApiOptions = RequestOptions;

export interface RequestDefinition<
  Method extends HttpMethod.HttpMethod,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
> extends RequestOptions {
  readonly method: Method;
  readonly path: string;
  readonly body?: Body;
  readonly responses: Rules;
}

export interface RequestPlan<Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>> {
  readonly setUrlParam: (key: string, value: string) => RequestPlan<Body, Rules>;
  readonly setUrlParams: (params: UrlParams.Input) => RequestPlan<Body, Rules>;
  readonly setHeader: (name: string, value: string) => RequestPlan<Body, Rules>;
  readonly mapRequest: (
    transform: (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest,
  ) => RequestPlan<Body, Rules>;
  readonly addResponseSchema: <const Rule extends AnyResponseRule>(
    rule: Rule,
  ) => RequestPlan<Body, readonly [Rule, ...Rules]>;
  readonly effect: Effect.Effect<
    SuccessOf<Rules>,
    | FailureOf<Rules>
    | UnhandledResponse
    | HttpBody.HttpBodyError
    | HttpClientError.HttpClientError
    | ParseResult.ParseError,
    HttpClient.HttpClient | BodyContextOf<Body> | ResponseContextOf<Rules>
  >;
}

export type Endpoint<Body extends AnySchema | undefined, Rules extends ReadonlyArray<AnyResponseRule>> = (
  ...args: BodyArguments<Body>
) => RequestPlan<Body, Rules>;

interface InternalDefinition<
  Method extends HttpMethod.HttpMethod,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
> extends RequestDefinition<Method, Body, Rules> {
  readonly baseUrl?: string;
  readonly baseOptions?: ApiOptions;
}

interface PlanState {
  readonly headers: Headers.Headers;
  readonly urlParams: UrlParams.UrlParams;
  readonly requestTransforms: ReadonlyArray<
    (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest
  >;
}

const joinUrl = (baseUrl: string | undefined, path: string): string => {
  if (baseUrl === undefined) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
};

const matches = (rule: AnyResponseRule, status: number, headers: Headers.Headers): boolean =>
  rule.match.status === status &&
  Object.entries(rule.match.headers ?? {}).every(([name, value]) => headers[name.toLowerCase()] === value);

const specificity = (rule: AnyResponseRule): number => Object.keys(rule.match.headers ?? {}).length;

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
  Method extends HttpMethod.HttpMethod,
  Body extends AnySchema | undefined,
  Rules extends ReadonlyArray<AnyResponseRule>,
>(
  definition: InternalDefinition<Method, Body, Rules>,
  body: Schema.Schema.Type<Body> | undefined,
  rules: Rules,
  state: PlanState,
): RequestPlan<Body, Rules> => {
  const update = (next: Partial<PlanState>): RequestPlan<Body, Rules> =>
    makePlan(definition, body, rules, { ...state, ...next });

  const effect = Effect.gen(function* () {
    let request = HttpClientRequest.make(definition.method)(joinUrl(definition.baseUrl, definition.path));
    request = HttpClientRequest.setHeaders(request, state.headers);
    request = HttpClientRequest.setUrlParams(request, state.urlParams);

    if (definition.body !== undefined) {
      request = yield* HttpClientRequest.schemaBodyJson(definition.body)(body)(request);
    }

    for (const transform of state.requestTransforms) request = transform(request);

    const baseClient = yield* HttpClient.HttpClient;
    const apiClient = definition.baseOptions?.transformClient?.(baseClient) ?? baseClient;
    const client = definition.transformClient?.(apiClient) ?? apiClient;
    const raw = yield* client.execute(request);
    const rule = findResponseRule(rules, raw.status, raw.headers);

    if (rule === undefined) {
      return yield* new UnhandledResponse({ status: raw.status, headers: raw.headers });
    }

    const decoded = yield* decodeResponse(rule, raw);
    if (rule.channel === "failure") return yield* Effect.fail(decoded);
    return decoded;
  });

  return {
    setUrlParam: (key, value) => update({ urlParams: UrlParams.set(state.urlParams, key, value) }),
    setUrlParams: (params) => update({ urlParams: UrlParams.fromInput(params) }),
    setHeader: (name, value) => update({ headers: Headers.set(state.headers, name, value) }),
    mapRequest: (transform) => update({ requestTransforms: [...state.requestTransforms, transform] }),
    addResponseSchema: <const Rule extends AnyResponseRule>(rule: Rule) =>
      makePlan(
        definition as unknown as InternalDefinition<Method, Body, readonly [Rule, ...Rules]>,
        body,
        [rule, ...rules],
        state,
      ),
    effect,
  } as RequestPlan<Body, Rules>;
};

const createRequestInternal = <
  const Method extends HttpMethod.HttpMethod,
  Body extends AnySchema | undefined = undefined,
  const Rules extends ReadonlyArray<AnyResponseRule> = ReadonlyArray<AnyResponseRule>,
>(
  definition: InternalDefinition<Method, Body, Rules>,
): Endpoint<Body, Rules> =>
  ((...args: BodyArguments<Body>) => {
    const baseHeaders = Headers.fromInput(definition.baseOptions?.headers);
    const headers = Headers.setAll(baseHeaders, definition.headers ?? {});
    const baseParams = UrlParams.fromInput(definition.baseOptions?.urlParams ?? {});
    const urlParams = UrlParams.appendAll(baseParams, definition.urlParams ?? {});
    const requestTransforms = [definition.baseOptions?.transformRequest, definition.transformRequest].filter(
      (transform): transform is NonNullable<typeof transform> => transform !== undefined,
    );

    return makePlan(definition, args[0], definition.responses, {
      headers,
      urlParams,
      requestTransforms,
    });
  }) as Endpoint<Body, Rules>;

export const createRequest = <
  const Method extends HttpMethod.HttpMethod,
  Body extends AnySchema | undefined = undefined,
  const Rules extends ReadonlyArray<AnyResponseRule> = ReadonlyArray<AnyResponseRule>,
>(
  definition: RequestDefinition<Method, Body, Rules>,
): Endpoint<Body, Rules> => createRequestInternal(definition);

export const createApi = (baseUrl: string, options: ApiOptions = {}) => ({
  createRequest: <
    const Method extends HttpMethod.HttpMethod,
    Body extends AnySchema | undefined = undefined,
    const Rules extends ReadonlyArray<AnyResponseRule> = ReadonlyArray<AnyResponseRule>,
  >(
    definition: RequestDefinition<Method, Body, Rules>,
  ): Endpoint<Body, Rules> => createRequestInternal({ ...definition, baseUrl, baseOptions: options }),
});
