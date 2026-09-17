import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Context, Effect, Either, Option, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Body, Operation, Request, Response, Transport } from "../main.js";

const root = "https://example.test";
const pairs = Schema.Array(Schema.Tuple(Schema.String, Schema.String));

const raw = () =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.get(root),
    new globalThis.Response("ok", {
      headers: { "x-scope": "one, two", "set-cookie": "first=1" },
    }),
  );

describe("field representations", () => {
  it("preserves cross-name order, repeated lines, comma-containing values and removable computations", async () => {
    let removed = 0;
    const request = Request.get(`${root}/?a&b=&a=last`).pipe(
      Request.appendHeader("X-Scope", "one, two"),
      Request.appendHeader("x-other", "middle"),
      Request.appendHeader("x-scope", "three"),
      Request.appendHeader("unused", () => {
        removed++;
        return "unused";
      }),
      Request.removeHeader("unused"),
    );
    const compiled = await Effect.runPromise(Request.compile(request, undefined));
    expect(compiled.request.url).toBe(`${root}/?a&b=&a=last`);
    expect(compiled.headerLines).toEqual([
      ["x-scope", "one, two"],
      ["x-other", "middle"],
      ["x-scope", "three"],
    ]);
    expect(removed).toBe(0);
    const changed = compiled.request.pipe(HttpClientRequest.setHeader("x-other", "changed"));
    expect(Transport.reconcile(compiled.headerLines, changed.headers)).toEqual([
      ["x-scope", "one, two"],
      ["x-scope", "three"],
      ["x-other", "changed"],
    ]);
  });

  it("accepts schema-encoded arrays and pairs without weakening application inputs", async () => {
    const request = Request.get(root).pipe(
      Request.headers(
        Schema.Struct({
          "x-count": Schema.Array(Schema.NumberFromString),
          omitted: Schema.optional(Schema.String),
        }),
      ),
    );
    const compiled = await Effect.runPromise(Request.compile(request, { headers: { "x-count": [1, 2] } }));
    expect(compiled.headerLines).toEqual([
      ["x-count", "1"],
      ["x-count", "2"],
    ]);
    expect(compiled.request.headers["x-count"]).toBe("1, 2");
    const tupleRequest = Request.get(root).pipe(Request.headers(pairs));
    const input = [
      ["X-Scope", "one, two"],
      ["Other", "middle"],
      ["x-scope", "three"],
    ] as const;
    expect((await Effect.runPromise(Request.compile(tupleRequest, { headers: input }))).headerLines).toEqual(input);
    // @ts-expect-error The application schema requires numbers, not encoded strings.
    Request.compile(request, { headers: { "x-count": ["1"] } });
    // @ts-expect-error A schema-bound collection cannot be bypassed with raw appenders.
    request.pipe(Request.appendHeader("x-count", "invalid"));
    // @ts-expect-error A bare string has no defined encoding as a complete header collection.
    Request.headers(Schema.String);
    // @ts-expect-error Query schemas must also encode to a supported field collection.
    Request.query(Schema.Struct({ invalid: Schema.Struct({ nested: Schema.String }) }));
  });

  it("allows arbitrary domain inputs through a compatible encoded schema and isolates concurrent preparation", async () => {
    class Prefix extends Context.Tag("header-prefix")<Prefix, string>() {}
    const contract = Schema.transformOrFail(pairs, Schema.String, {
      decode: (lines) => Effect.succeed(lines[0]?.[1] ?? ""),
      encode: (value) =>
        Effect.gen(function* () {
          const prefix = yield* Prefix;
          yield* Effect.yieldNow();
          return [
            ["X-Value", `${prefix}${value}`],
            ["Other", "middle"],
            ["X-Value", value],
          ] as const;
        }),
    });
    const request = Request.get(root).pipe(Request.headers(contract));
    const prepared = Request.compile(request, { headers: "a" });
    expectTypeOf<Effect.Effect.Context<typeof prepared>>().toEqualTypeOf<Prefix>();
    const results = await Effect.runPromise(
      Effect.all([prepared, Request.compile(request, { headers: "b" })], { concurrency: "unbounded" }).pipe(
        Effect.provideService(Prefix, "prefix:"),
      ),
    );
    expect(results.map((value) => value.headerLines)).toEqual([
      [
        ["X-Value", "prefix:a"],
        ["Other", "middle"],
        ["X-Value", "a"],
      ],
      [
        ["X-Value", "prefix:b"],
        ["Other", "middle"],
        ["X-Value", "b"],
      ],
    ]);
    const failure = await Effect.runPromise(
      Request.compile(Request.get(root).pipe(Request.headers(Schema.Struct({ name: Schema.NonEmptyString }))), {
        headers: { name: "" },
      }).pipe(Effect.either),
    );
    expect(Either.isLeft(failure) && failure.left._tag).toBe("ParseError");
  });
});

describe("provider response headers", () => {
  it("preserves observed order, casing and values in matching, results, and unmatched errors", async () => {
    const lines = [
      ["X-Scope", "one"],
      ["Other", "middle"],
      ["x-scope", "two"],
    ] as const;
    const response = Transport.withResponseHeaders(raw(), lines);
    const metadata = Response.metadata(response);
    expect(metadata.headers["x-scope"]).toBe("one, two");
    expect(Option.getOrThrow(metadata.headerLines)).toEqual(lines);
    const contract = Response.when(
      (info) => Option.isSome(info.headerLines) && info.headerLines.value.length === 3,
      Response.tag("Repeated", Body.text),
    );
    const result = await Effect.runPromise(Response.decode(contract, response));
    expect(result.value).toBe("ok");
    expect(Option.getOrThrow(result.metadata.headerLines)).toEqual(lines);
    const client = HttpClient.make(() => Effect.succeed(Transport.withResponseHeaders(raw(), lines)));
    const failure = await Effect.runPromise(
      Operation.make(Request.get(root), Response.status(201, Body.text))
        .execute(undefined)
        .pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(failure) && failure.left._tag).toBe("UnexpectedStatus");
    if (Either.isLeft(failure) && failure.left._tag === "UnexpectedStatus") {
      expect(Option.getOrThrow(failure.left.metadata.headerLines)).toEqual(lines);
    }
  });

  it("does not invent lines from normalized headers or cookies, and snapshots provider-owned arrays", () => {
    expect(Option.isNone(Response.metadata(raw()).headerLines)).toBe(true);
    const lines: Array<[string, string]> = [["X-Scope", "one, two"]];
    const response = Transport.withResponseHeaders(raw(), lines);
    lines[0][1] = "changed";
    lines.push(["X-Scope", "three"]);
    expect(Option.getOrThrow(Response.metadata(response).headerLines)).toEqual([["X-Scope", "one, two"]]);
    expect(
      Transport.toHeaders([
        ["X-Scope", "one"],
        ["x-scope", "two"],
      ]),
    ).toEqual(Headers.fromInput({ "x-scope": "one, two" }));
  });
});
