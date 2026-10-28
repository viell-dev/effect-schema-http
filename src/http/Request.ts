import { Data, Effect, Pipeable, Redacted, Schema } from "effect";
import { HttpClientRequest, type HttpMethod, UrlParams } from "effect/http";
import type * as Body from "./Body.js";
import * as Fields from "./internal/fields.js";
import * as Transport from "./Transport.js";
import * as UrlEncoding from "./UrlEncoding.js";

/** Request fields could not be materialized, the URL could not be encoded, or a GET/HEAD request has a body. */
export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A header or query value, or a computation evaluated once per materialization. `undefined` omits it. */
export type FieldValue<A = string> = Fields.Value<A>;

/** Raw declarations, materialized before input preparation. */
export interface Declaration<
  H extends boolean = boolean,
  Q extends boolean = boolean,
> {
  readonly method: string;
  readonly url: string;
  readonly baseUrl: string;
  readonly headers: Fields.Fields;
  readonly query: Fields.Fields<string | null>;
  /** Whether a schema owns the header group; raw header setters are then unavailable. */
  readonly headersBound: H;
  /** Whether a schema owns the query group; raw query setters are then unavailable. */
  readonly queryBound: Q;
}

/** A query parameter of a native request, compared by identity to recognize bare keys. */
export type UrlParam = UrlParams.UrlParams["params"][number];

/** The request during input preparation. */
export interface Draft {
  /** Method, path or URL, query parameters, normalized headers and body. */
  readonly request: HttpClientRequest.HttpClientRequest;
  /** The authoritative header lines; compilation reconciles them with the native headers. */
  readonly headerLines: Transport.Lines;
  /** The parameters of `request.urlParams` that render as bare keys. Native edits replace them. */
  readonly bareKeys: ReadonlySet<UrlParam>;
}

/**
 * A pure description of an HTTP request and the application input it requires. `I` is the complete
 * invocation argument; `H` and `Q` record whether schemas own the header and query groups.
 *
 * `declaration` and `prepare` are low-level extension points. Prefer the combinators of this module.
 */
export interface Request<
  in I,
  out E = never,
  out R = never,
  out H extends boolean = false,
  out Q extends boolean = false,
>
  extends Pipeable.Pipeable {
  readonly declaration: Declaration<H, Q>;
  readonly prepare: (input: I, draft: Draft) => Effect.Effect<Draft, E, R>;
}

const construct = <I, E, R, H extends boolean, Q extends boolean>(
  declaration: Declaration<H, Q>,
  prepare: (input: I, draft: Draft) => Effect.Effect<Draft, E, R>,
): Request<I, E, R, H, Q> => ({ ...Pipeable.Prototype, declaration, prepare });

/**
 * A request with no required input; execute it with `undefined`. A query string in `url` becomes raw query
 * declarations, keeping bare keys distinct from empty values. A fragment is discarded. Custom method
 * strings pass through to the transport unchanged.
 */
export const make = (method: string, url: string): Request<unknown> => {
  const hash = url.indexOf("#");
  const withoutHash = hash < 0 ? url : url.slice(0, hash);
  const start = withoutHash.indexOf("?");
  const query: Array<readonly [string, string | null]> = [];
  if (start >= 0) {
    for (const segment of withoutHash.slice(start + 1).split("&")) {
      for (const [key, value] of new URLSearchParams(segment))
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
    (_, draft) => Effect.succeed(draft),
  );
};

export const get = (url: string): Request<unknown> => make("GET", url);
export const post = (url: string): Request<unknown> => make("POST", url);
export const put = (url: string): Request<unknown> => make("PUT", url);
export const patch = (url: string): Request<unknown> => make("PATCH", url);
export const del = (url: string): Request<unknown> => make("DELETE", url);
export const head = (url: string): Request<unknown> => make("HEAD", url);
export const options = (url: string): Request<unknown> => make("OPTIONS", url);

/** Replace the base URL joined with the request URL during materialization. */
export const baseUrl =
  (url: string) =>
  <I, E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I, E, R, H, Q> =>
    construct({ ...self.declaration, baseUrl: url }, self.prepare);

const editHeaders =
  (edit: (fields: Fields.Fields) => Fields.Fields) =>
  <I, E, R, Q extends boolean>(
    self: Request<I, E, R, false, Q>,
  ): Request<I, E, R, false, Q> =>
    construct(
      { ...self.declaration, headers: edit(self.declaration.headers) },
      self.prepare,
    );

const editQuery =
  (
    edit: (
      fields: Fields.Fields<string | null>,
    ) => Fields.Fields<string | null>,
  ) =>
  <I, E, R, H extends boolean>(
    self: Request<I, E, R, H, false>,
  ): Request<I, E, R, H, false> =>
    construct(
      { ...self.declaration, query: edit(self.declaration.query) },
      self.prepare,
    );

/** Replace every line of a header. Names are case-insensitive. */
export const setHeader = (name: string, value: FieldValue) =>
  editHeaders((fields) => Fields.set(fields, name.toLowerCase(), value));

/** Add a header line after the existing lines. */
export const appendHeader = (name: string, value: FieldValue) =>
  editHeaders((fields) => Fields.append(fields, name.toLowerCase(), value));

/** Remove a header, or only its static lines equal to `value`. Computations are never evaluated to compare. */
export const removeHeader = (name: string, value?: string) =>
  editHeaders((fields) => Fields.remove(fields, name.toLowerCase(), value));

/** Replace every entry of a query key. `null` is a bare key. */
export const setQuery = (name: string, value: FieldValue<string | null>) =>
  editQuery((fields) => Fields.set(fields, name, value));

/** Add a query entry after the existing entries. */
export const appendQuery = (name: string, value: FieldValue<string | null>) =>
  editQuery((fields) => Fields.append(fields, name, value));

/** Remove a query key, or only its static entries equal to `value`. */
export const removeQuery = (name: string, value?: string | null) =>
  editQuery((fields) => Fields.remove(fields, name, value));

const replaceQuery = (draft: Draft, entries: UrlEncoding.Query): Draft => {
  const added = entries.map(([key, value]): UrlParam => [key, value ?? ""]);
  const keys = new Set(added.map(([key]) => key));
  const bareKeys = new Set(
    Array.from(draft.bareKeys).filter(([key]) => !keys.has(key)),
  );
  entries.forEach(([, value], index) => {
    if (value === null) bareKeys.add(added[index]!);
  });
  const { request } = draft;
  const params = [
    ...request.urlParams.params.filter(([key]) => !keys.has(key)),
    ...added,
  ];
  return {
    ...draft,
    request: HttpClientRequest.makeWith(
      request.method,
      request.url,
      UrlParams.make(params),
      request.hash,
      request.headers,
      request.body,
    ),
    bareKeys,
  };
};

/**
 * Require `{ headers }` input, encoded by a schema into ordered lines. The schema replaces the raw header
 * declarations and owns the group.
 */
export const headers = <
  S extends Schema.ConstraintCodec<
    unknown,
    Transport.HeaderInput,
    unknown,
    unknown
  >,
>(
  contract: S,
) => {
  const encode = Schema.encodeEffect(contract);
  return <I, E, R, Q extends boolean>(
    self: Request<I, E, R, false, Q>,
  ): Request<
    I & { readonly headers: S["Type"] },
    E | Schema.SchemaError,
    R | S["EncodingServices"],
    true,
    Q
  > =>
    construct(
      { ...self.declaration, headers: [], headersBound: true },
      Effect.fnUntraced(function* (
        input: I & { readonly headers: S["Type"] },
        draft: Draft,
      ) {
        const encoded = yield* encode(input.headers);
        const prepared = yield* self.prepare(input, draft);
        const headerLines = Transport.entries(encoded);
        return {
          ...prepared,
          request: HttpClientRequest.setHeaders(
            prepared.request,
            Transport.toHeaders(headerLines),
          ),
          headerLines,
        };
      }),
    );
};

/**
 * Require `{ query }` input, encoded by a schema into ordered entries. The schema replaces the raw query
 * declarations and owns the group.
 */
export const query = <
  S extends Schema.ConstraintCodec<
    unknown,
    UrlEncoding.QueryInput,
    unknown,
    unknown
  >,
>(
  contract: S,
) => {
  const encode = Schema.encodeEffect(contract);
  return <I, E, R, H extends boolean>(
    self: Request<I, E, R, H, false>,
  ): Request<
    I & { readonly query: S["Type"] },
    E | Schema.SchemaError,
    R | S["EncodingServices"],
    H,
    true
  > =>
    construct(
      { ...self.declaration, query: [], queryBound: true },
      Effect.fnUntraced(function* (
        input: I & { readonly query: S["Type"] },
        draft: Draft,
      ) {
        const encoded = yield* encode(input.query);
        const prepared = yield* self.prepare(input, draft);
        return replaceQuery(prepared, UrlEncoding.queryEntries(encoded));
      }),
    );
};

/** Require `{ path }` input. `render` receives the schema-encoded value and the current path encoder. */
export const path = <S extends Schema.Constraint>(
  contract: S,
  render: (value: S["Encoded"], encode: UrlEncoding.Service["path"]) => string,
) => {
  const encode = Schema.encodeEffect(contract);
  return <I, E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<
    I & { readonly path: S["Type"] },
    E | Schema.SchemaError,
    R | S["EncodingServices"],
    H,
    Q
  > =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly path: S["Type"] },
        draft: Draft,
      ) {
        const encoded = yield* encode(input.path);
        const encoding = yield* UrlEncoding.UrlEncoding;
        const prepared = yield* self.prepare(input, draft);
        return {
          ...prepared,
          request: HttpClientRequest.setUrl(
            prepared.request,
            render(encoded, encoding.path),
          ),
        };
      }),
    );
};

/** Require `{ body }` input, encoded once per evaluation. The encoded body sets Content-Type. */
export const body =
  <A, E2, R2>(codec: Body.Encoder<A, E2, R2>) =>
  <I, E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I & { readonly body: A }, E | E2, R | R2, H, Q> =>
    construct(
      self.declaration,
      Effect.fnUntraced(function* (
        input: I & { readonly body: A },
        draft: Draft,
      ) {
        const encoded = yield* codec.encode(input.body);
        const prepared = yield* self.prepare(input, draft);
        return {
          ...prepared,
          request: HttpClientRequest.setBody(prepared.request, encoded),
        };
      }),
    );

/** Adapt the invocation argument without weakening its contract, including application-selected defaults. */
export const mapInput =
  <I, I2>(f: (input: I2) => I) =>
  <E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I2, E, R, H, Q> =>
    construct(self.declaration, (input, draft) =>
      Effect.suspend(() => self.prepare(f(input), draft)),
    );

/** Effectful preparation of the native request, such as signing. Runs once per evaluation, before any attempt. */
export const mapEffect =
  <I, E2, R2>(
    f: (
      request: HttpClientRequest.HttpClientRequest,
      input: I,
    ) => Effect.Effect<HttpClientRequest.HttpClientRequest, E2, R2>,
  ) =>
  <E, R, H extends boolean, Q extends boolean>(
    self: Request<I, E, R, H, Q>,
  ): Request<I, E | E2, R | R2, H, Q> =>
    construct(self.declaration, (input, draft) =>
      Effect.flatMap(self.prepare(input, draft), (prepared) =>
        Effect.map(f(prepared.request, input), (request) => ({
          ...prepared,
          request,
        })),
      ),
    );

/** A materialized request with the header lines a supporting provider can send. */
export interface Compiled {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly headerLines: Transport.Lines;
}

const initialDraft = (declaration: Declaration): Draft => {
  // Custom method strings pass through at runtime; the method union is narrower than the transport.
  const native = HttpClientRequest.make(
    declaration.method as HttpMethod.HttpMethod,
  )(declaration.url);
  const headerLines = Fields.resolve(declaration.headers);
  return replaceQuery(
    {
      request: HttpClientRequest.setHeaders(
        native,
        Transport.toHeaders(headerLines),
      ),
      headerLines,
      bareKeys: new Set(),
    },
    Fields.resolve(declaration.query),
  );
};

const finalize = (
  draft: Draft,
  base: string,
  encoding: UrlEncoding.Service,
): Compiled => {
  const { request } = draft;
  const url = encoding.join(base, request.url);
  const search = encoding.query(
    request.urlParams.params.map((param) => [
      param[0],
      draft.bareKeys.has(param)
        ? null
        : Redacted.isRedacted(param[1])
          ? Redacted.value(param[1])
          : param[1],
    ]),
  );
  const compiled = HttpClientRequest.makeWith(
    request.method,
    search === "" ? url : `${url}${url.includes("?") ? "&" : "?"}${search}`,
    UrlParams.empty,
    request.hash,
    request.headers,
    request.body,
  );
  return {
    request: compiled,
    headerLines: Transport.reconcile(draft.headerLines, compiled.headers),
  };
};

/**
 * Materialize the native request and its header lines without sending it. Computed fields are evaluated
 * and input is encoded once per evaluation of the returned Effect.
 */
export const compile = Effect.fnUntraced(function* <
  I,
  E,
  R,
  H extends boolean,
  Q extends boolean,
>(
  self: Request<I, E, R, H, Q>,
  input: I,
): Effect.fn.Return<Compiled, E | InvalidRequest, R> {
  const encoding = yield* UrlEncoding.UrlEncoding;
  const initial = yield* Effect.try({
    try: () => initialDraft(self.declaration),
    catch: (cause) =>
      new InvalidRequest({
        message: "Failed to materialize request fields",
        cause,
      }),
  });
  const draft = yield* self.prepare(input, initial);
  const { method } = draft.request;
  if (
    (method === "GET" || method === "HEAD") &&
    draft.request.body._tag !== "Empty"
  ) {
    return yield* new InvalidRequest({
      message: `${method} cannot carry a request body`,
    });
  }
  return yield* Effect.try({
    try: () => finalize(draft, self.declaration.baseUrl, encoding),
    catch: (cause) =>
      new InvalidRequest({ message: "Failed to encode request URL", cause }),
  });
});

/** Materialize only the native request. Use {@link compile} when a provider sends header lines. */
export const materialize = <I, E, R, H extends boolean, Q extends boolean>(
  self: Request<I, E, R, H, Q>,
  input: I,
): Effect.Effect<HttpClientRequest.HttpClientRequest, E | InvalidRequest, R> =>
  Effect.map(compile(self, input), (compiled) => compiled.request);
