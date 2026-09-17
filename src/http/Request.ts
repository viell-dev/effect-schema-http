import { HttpClientRequest, HttpMethod } from "@effect/platform";
import { Data, Effect, ParseResult, Pipeable, Ref, Schema } from "effect";
import * as Body from "./Body.js";
import * as Url from "./Url.js";
import * as Fields from "./internal/fields.js";
import { HeaderState } from "./internal/headerState.js";
import * as Query from "./internal/query.js";
import * as Transport from "./Transport.js";

export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface Options<H extends boolean, Q extends boolean> {
  readonly method: string;
  readonly url: string;
  readonly baseUrl: string;
  readonly headers: Fields.Fields;
  readonly query: Fields.Fields<string | null>;
  readonly headersBound: H;
  readonly queryBound: Q;
}

/** A pure input description. Schema-bound fields cannot be edited by raw setters. */
export interface Request<
  in I,
  out E = never,
  out R = never,
  out H extends boolean = false,
  out Q extends boolean = false,
>
  extends Pipeable.Pipeable {
  readonly options: Options<H, Q>;
  readonly prepare: (
    input: I,
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, E, R>;
}

const construct = <I, E, R, H extends boolean, Q extends boolean>(
  options: Options<H, Q>,
  prepare: Request<I, E, R, H, Q>["prepare"],
): Request<I, E, R, H, Q> => ({
  options,
  prepare,
  pipe() {
    // eslint-disable-next-line prefer-rest-params -- Effect pipeArguments accepts IArguments.
    return Pipeable.pipeArguments(this, arguments);
  },
});

/** Custom methods pass through unchanged; Platform's method union is narrower than its runtime. */
export const make = (method: string, url: string): Request<unknown> => {
  const hash = url.indexOf("#");
  const withoutHash = hash < 0 ? url : url.slice(0, hash);
  const start = withoutHash.indexOf("?");
  const query: Array<readonly [string, string | null]> = [];
  if (start >= 0)
    for (const segment of withoutHash.slice(start + 1).split("&")) {
      for (const [key, value] of new URLSearchParams(segment)) {
        query.push([key, segment.includes("=") ? value : null]);
      }
    }
  return construct(
    {
      method,
      url: start < 0 ? withoutHash : withoutHash.slice(0, start),
      baseUrl: "",
      headers: [],
      query,
      headersBound: false,
      queryBound: false,
    },
    (_, request) => Effect.succeed(request),
  );
};
export const get = (url: string) => make("GET", url);
export const post = (url: string) => make("POST", url);

export const baseUrl =
  (url: string) =>
  <I, E, R, H extends boolean, Q extends boolean>(self: Request<I, E, R, H, Q>): Request<I, E, R, H, Q> =>
    construct({ ...self.options, baseUrl: url }, self.prepare);

export const setHeader =
  (name: string, value: Fields.Value) =>
  <I, E, R, Q extends boolean>(self: Request<I, E, R, false, Q>): Request<I, E, R, false, Q> =>
    construct({ ...self.options, headers: Fields.set(self.options.headers, name.toLowerCase(), value) }, self.prepare);
export const appendHeader =
  (name: string, value: Fields.Value) =>
  <I, E, R, Q extends boolean>(self: Request<I, E, R, false, Q>): Request<I, E, R, false, Q> =>
    construct(
      { ...self.options, headers: Fields.set(self.options.headers, name.toLowerCase(), value, true) },
      self.prepare,
    );
export const removeHeader =
  (name: string, value?: string) =>
  <I, E, R, Q extends boolean>(self: Request<I, E, R, false, Q>): Request<I, E, R, false, Q> =>
    construct(
      { ...self.options, headers: Fields.remove(self.options.headers, name.toLowerCase(), value) },
      self.prepare,
    );
export const setQuery =
  (name: string, value: Fields.Value<string | null>) =>
  <I, E, R, H extends boolean>(self: Request<I, E, R, H, false>): Request<I, E, R, H, false> =>
    construct({ ...self.options, query: Fields.set(self.options.query, name, value) }, self.prepare);
export const appendQuery =
  (name: string, value: Fields.Value<string | null>) =>
  <I, E, R, H extends boolean>(self: Request<I, E, R, H, false>): Request<I, E, R, H, false> =>
    construct({ ...self.options, query: Fields.set(self.options.query, name, value, true) }, self.prepare);
export const removeQuery =
  (name: string, value?: string | null) =>
  <I, E, R, H extends boolean>(self: Request<I, E, R, H, false>): Request<I, E, R, H, false> =>
    construct({ ...self.options, query: Fields.remove(self.options.query, name, value) }, self.prepare);

export const headers =
  <A, I extends Transport.HeaderInput, R2>(contract: Schema.Schema<A, I, R2>) =>
  <Input, E, R, Q extends boolean>(
    self: Request<Input, E, R, false, Q>,
  ): Request<Input & { readonly headers: A }, E | ParseResult.ParseError, R | R2, true, Q> =>
    construct({ ...self.options, headers: [], headersBound: true }, (input, request) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encode(contract)(input.headers);
        const prepared = yield* self.prepare(input, request);
        const lines = Transport.entries(encoded);
        yield* Ref.set(yield* HeaderState, lines);
        return HttpClientRequest.setHeaders(prepared, Transport.toHeaders(lines));
      }),
    );

export const query =
  <A, I extends Url.QueryInput, R2>(contract: Schema.Schema<A, I, R2>) =>
  <Input, E, R, H extends boolean>(
    self: Request<Input, E, R, H, false>,
  ): Request<Input & { readonly query: A }, E | ParseResult.ParseError, R | R2, H, true> =>
    construct({ ...self.options, query: [], queryBound: true }, (input, request) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encode(contract)(input.query);
        const prepared = yield* self.prepare(input, request);
        return Query.set(prepared, Url.queryEntries(encoded), yield* Query.Flags);
      }),
    );

/** The callback receives the encoded schema value and the selected path encoder. */
export const path =
  <A, I, R2>(contract: Schema.Schema<A, I, R2>, render: (value: I, encode: Url.Service["path"]) => string) =>
  <Input, E, R, H extends boolean, Q extends boolean>(
    self: Request<Input, E, R, H, Q>,
  ): Request<Input & { readonly path: A }, E | ParseResult.ParseError, R | R2, H, Q> =>
    construct(self.options, (input, request) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encode(contract)(input.path);
        const service = yield* Url.Url;
        const prepared = yield* self.prepare(input, request);
        return HttpClientRequest.setUrl(prepared, render(encoded, service.path));
      }),
    );

export const body =
  <A, E2, R2>(codec: Body.Encoder<A, E2, R2>) =>
  <Input, E, R, H extends boolean, Q extends boolean>(
    self: Request<Input, E, R, H, Q>,
  ): Request<Input & { readonly body: A }, E | E2, R | R2, H, Q> =>
    construct(self.options, (input, request) =>
      Effect.gen(function* () {
        const encoded = yield* codec.encode(input.body);
        return HttpClientRequest.setBody(yield* self.prepare(input, request), encoded);
      }),
    );

/** Adapt arguments without weakening their contract, including application-selected defaults. */
export const mapInput =
  <I, I2>(f: (input: I2) => I) =>
  <E, R, H extends boolean, Q extends boolean>(self: Request<I, E, R, H, Q>): Request<I2, E, R, H, Q> =>
    construct(self.options, (input, request) => Effect.suspend(() => self.prepare(f(input), request)));

/** Escape hatch for signing or custom preparation. Runs once, before attempt policies. */
export const mapEffect =
  <I, E2, R2>(
    f: (
      request: HttpClientRequest.HttpClientRequest,
      input: I,
    ) => Effect.Effect<HttpClientRequest.HttpClientRequest, E2, R2>,
  ) =>
  <E, R, H extends boolean, Q extends boolean>(self: Request<I, E, R, H, Q>): Request<I, E | E2, R | R2, H, Q> =>
    construct(self.options, (input, request) =>
      Effect.flatMap(self.prepare(input, request), (prepared) => f(prepared, input)),
    );

export interface Compiled {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headerLines: Transport.Lines;
}

/** Materialize both the native request and lossless provider hints. */
export const compile = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request<I, E, R, H, Q>,
  input: I,
): Effect.Effect<Compiled, E | InvalidRequest, R> =>
  Effect.gen(function* () {
    const service = yield* Url.Url;
    const flags = new WeakSet<readonly [string, string]>();
    let headerLines: Transport.Lines = [];
    const initial = yield* Effect.try({
      try: () => {
        // The platform constructor preserves custom method strings at runtime.
        let request = HttpClientRequest.make(self.options.method as HttpMethod.HttpMethod)(self.options.url);
        headerLines = Fields.resolve(self.options.headers);
        request = HttpClientRequest.setHeaders(request, Transport.toHeaders(headerLines));
        return Query.set(request, Fields.resolve(self.options.query), flags);
      },
      catch: (cause) => new InvalidRequest({ message: "Failed to materialize request fields", cause }),
    });
    const state = yield* Ref.make(headerLines);
    const prepared = yield* self
      .prepare(input, initial)
      .pipe(Effect.provideService(Query.Flags, flags), Effect.provideService(HeaderState, state));
    headerLines = yield* Ref.get(state);
    if ((prepared.method === "GET" || prepared.method === "HEAD") && prepared.body._tag !== "Empty") {
      return yield* new InvalidRequest({ message: `${prepared.method} cannot carry a request body` });
    }
    return yield* Effect.try({
      try: () => {
        const url = service.join(self.options.baseUrl, prepared.url);
        const queryString = service.query(
          prepared.urlParams.map((pair) => [pair[0], flags.has(pair) ? null : pair[1]]),
        );
        const finalUrl = queryString ? `${url}${url.includes("?") ? "&" : "?"}${queryString}` : url;
        const request = HttpClientRequest.setHeaders(
          HttpClientRequest.setBody(HttpClientRequest.make(prepared.method)(finalUrl), prepared.body),
          prepared.headers,
        );
        return { request, headerLines: Transport.reconcile(headerLines, request.headers) };
      },
      catch: (cause) => new InvalidRequest({ message: "Failed to encode request URL", cause }),
    });
  });

/** Explicit preparation without transport execution. Use compile for a custom lossless provider. */
export const materialize = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request<I, E, R, H, Q>,
  input: I,
): Effect.Effect<HttpClientRequest.HttpClientRequest, E | InvalidRequest, R> =>
  Effect.map(compile(self, input), (compiled) => compiled.request);
