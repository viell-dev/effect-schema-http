import { HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Body from "./Body.js";
import * as Response from "./Response.js";

const response = (body: string, status = 200) =>
  HttpClientResponse.fromWeb(HttpClientRequest.get("https://example.test"), new globalThis.Response(body, { status }));

describe("finite body contracts", () => {
  it("validates and transforms in both directions", async () => {
    const codec = Body.jsonSchema(Schema.Struct({ count: Schema.NumberFromString }));
    expect(await Effect.runPromise(codec.decode(response('{"count":"42"}')))).toEqual({ count: 42 });
    const encoded = await Effect.runPromise(codec.encode({ count: 42 }));
    expect(encoded._tag).toBe("Uint8Array");
    if (encoded._tag === "Uint8Array") expect(new TextDecoder().decode(encoded.body)).toBe('{"count":"42"}');
  });
  it("does not fall back after selecting malformed data", async () => {
    const contract = Response.status(200, Body.jsonSchema(Schema.Number)).pipe(
      Response.orElse(Response.when(() => true, Body.text)),
    );
    const result = await Effect.runPromise(Effect.either(Response.decode(contract, response('"wrong"'))));
    expect(Either.isLeft(result) && result.left._tag).toBe("DecodeError");
  });
  it("preserves recognized negative outcomes and metadata", async () => {
    const contract = Response.status(404, Response.tag("Missing", Body.text));
    expect(await Effect.runPromise(Response.decode(contract, response("gone", 404)))).toMatchObject({
      _tag: "Missing",
      value: "gone",
      metadata: { status: 404 },
    });
  });
});
