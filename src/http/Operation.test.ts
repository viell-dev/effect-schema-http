import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Context, Effect, Either, Layer, Schema, Schedule } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";
import * as Url from "./Url.js";

const reply = (request: HttpClientRequest.HttpClientRequest, body: string, status = 200) =>
  HttpClientResponse.fromWeb(request, new globalThis.Response(body, { status }));
const textResponse = Response.when(() => true, Body.text);

describe("operation execution", () => {
  it("is cold, suppresses removed defaults, snapshots once across mixed retries, and re-evaluates independently", async () => {
    let computed = 0;
    let removed = 0;
    let calls = 0;
    const seen: Array<string | undefined> = [];
    const request = Request.get("/search?q=old&q=older").pipe(
      Request.baseUrl("https://example.test"),
      Request.setHeader("Authorization", () => `token-${++computed}`),
      Request.setHeader("unused", () => {
        removed++;
        return "bad";
      }),
      Request.removeHeader("unused"),
      Request.setQuery("q", "new"),
      Request.appendQuery("q", "second"),
    );
    const operation = Operation.make(request, textResponse, { policy: Policy.make(Schedule.recurs(2)) });
    const program = operation.execute(undefined);
    expect(computed).toBe(0);
    const client = HttpClient.make((req) =>
      Effect.suspend(() => {
        seen.push(req.headers.authorization);
        expect(req.url).toBe("https://example.test/search?q=new&q=second");
        expect(req.urlParams).toEqual([]);
        calls++;
        return calls % 3 === 1
          ? Effect.fail(new HttpClientError.RequestError({ request: req, reason: "Transport" }))
          : Effect.succeed(reply(req, calls % 3 === 2 ? "busy" : "ok", calls % 3 === 2 ? 503 : 200));
      }),
    );
    const layer = Layer.succeed(HttpClient.HttpClient, client);
    expect(await Effect.runPromise(program.pipe(Effect.provide(layer)))).toBe("ok");
    expect(seen).toEqual(["token-1", "token-1", "token-1"]);
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
    expect(seen.slice(3)).toEqual(["token-2", "token-2", "token-2"]);
    expect(removed).toBe(0);
  });

  it("encodes every typed field and body, including literal dot segments", async () => {
    const request = Request.post("").pipe(
      Request.baseUrl("https://example.test/api"),
      Request.path(Schema.Struct({ id: Schema.String }), ({ id }, encode) => `/items/${encode(id)}`),
      Request.headers(Schema.Struct({ "x-count": Schema.NumberFromString })),
      Request.query(Schema.Struct({ page: Schema.NumberFromString, filter: Schema.Array(Schema.String) })),
      Request.body(Body.jsonSchema(Schema.Struct({ count: Schema.NumberFromString }))),
    );
    const encoded = await Effect.runPromise(
      Request.materialize(request, {
        path: { id: ".." },
        headers: { "x-count": 3 },
        query: { page: 2, filter: ["a b", "c"] },
        body: { count: 4 },
      }),
    );
    expect(encoded.url).toBe("https://example.test/api/items/..?page=2&filter=a%20b&filter=c");
    expect(encoded.headers["x-count"]).toBe("3");
    if (encoded.body._tag === "Uint8Array") expect(new TextDecoder().decode(encoded.body.body)).toBe('{"count":"4"}');
    else throw new Error("Expected encoded bytes");
    // @ts-expect-error Schema-bound headers have no raw setter path.
    request.pipe(Request.setHeader("x-count", "unchecked"));
    // @ts-expect-error Schema-bound query has no raw setter path.
    request.pipe(Request.setQuery("page", "unchecked"));
    const operation = Operation.make(request, textResponse);
    // @ts-expect-error Required body and other input cannot be omitted.
    operation.execute({ path: { id: "x" } });
    operation.execute({
      path: { id: "x" },
      headers: { "x-count": 1 },
      query: { page: 1, filter: [] },
      // @ts-expect-error The application-side body is numeric, not encoded text.
      body: { count: "1" },
    });
  });

  it("replaces URL encoding through a native layer and retains empty path input", async () => {
    const request = Request.get("").pipe(
      Request.path(Schema.String, (value, encode) => `/x/${encode(value)}`),
      Request.setQuery("a b", "c d"),
    );
    const custom = Url.layer({ ...Url.defaults, path: (value) => `[${value}]`, query: () => "legacy=true" });
    expect((await Effect.runPromise(Request.materialize(request, { path: "" }).pipe(Effect.provide(custom)))).url).toBe(
      "/x/[]?legacy=true",
    );
  });

  it("keeps schema service requirements and provides them using native Effect services", async () => {
    class Prefix extends Context.Tag("Prefix")<Prefix, string>() {}
    const contract = Schema.transformOrFail(Schema.String, Schema.String, {
      decode: (value) => Effect.map(Prefix, (prefix) => `${prefix}${value}`),
      encode: (value) => Effect.succeed(value),
    });
    const operation = Operation.make(
      Request.get("https://example.test"),
      Response.status(200, Body.jsonSchema(contract)),
    );
    const program = operation.execute(undefined);
    expectTypeOf<Effect.Effect.Context<typeof program>>().toEqualTypeOf<Prefix | HttpClient.HttpClient>();
    const client = HttpClient.make((req) => Effect.succeed(reply(req, '"ok"')));
    expect(
      await Effect.runPromise(
        program.pipe(Effect.provideService(Prefix, "prefix:"), Effect.provideService(HttpClient.HttpClient, client)),
      ),
    ).toBe("prefix:ok");
  });

  it("returns the final mapped response when the shared retry budget is exhausted", async () => {
    let calls = 0;
    const client = HttpClient.make((req) =>
      Effect.sync(() => {
        calls++;
        return reply(req, "busy", 503);
      }),
    );
    const operation = Operation.make(
      Request.get("https://example.test/"),
      Response.status(503, Response.tag("Unavailable", Body.text)),
      {
        policy: Policy.make(Schedule.recurs(2)),
      },
    );
    expect(
      await Effect.runPromise(operation.execute(undefined).pipe(Effect.provideService(HttpClient.HttpClient, client))),
    ).toMatchObject({ _tag: "Unavailable", value: "busy" });
    expect(calls).toBe(3);
  });

  it("runs client transforms for each attempt and includes decoding in attempt timeout", async () => {
    let transforms = 0;
    let decodes = 0;
    const client = HttpClient.make((req) => Effect.succeed(reply(req, "ok")));
    const decoder = Body.decoder(() => Effect.suspend(() => (++decodes === 1 ? Effect.never : Effect.succeed("ok"))));
    const operation = Operation.make(Request.get("https://example.test/"), Response.status(200, decoder), {
      policy: Policy.make(Schedule.recurs(1), { attemptTimeout: "5 millis", while: () => true }),
      transformClient: (value) => {
        transforms++;
        return value;
      },
    });
    expect(
      await Effect.runPromise(operation.execute(undefined).pipe(Effect.provideService(HttpClient.HttpClient, client))),
    ).toBe("ok");
    expect(transforms).toBe(2);
  });

  it("reports unsupported responses and rejects forbidden request bodies", async () => {
    const client = HttpClient.make((req) => Effect.succeed(reply(req, "missing", 404)));
    const operation = Operation.make(Request.get("https://example.test/"), Response.status(200, Body.text));
    const result = await Effect.runPromise(
      operation.execute(undefined).pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("UnexpectedStatus");
    const invalid = Request.get("https://example.test/").pipe(Request.body(Body.text));
    const rejected = await Effect.runPromise(Effect.either(Request.materialize(invalid, { body: "not allowed" })));
    expect(Either.isLeft(rejected) && rejected.left._tag).toBe("InvalidRequest");
  });
});
