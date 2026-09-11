import { Effect, Schema } from "effect";
import { response, ResponseBody, type RequestBodyRequired, UnhandledResponse } from "viell-effect-schema-http";
import { beforeAll, describe, expect, it } from "vitest";
import { FILE_SERVER_URL, uploadRawBytes, uploadRawUnmodelled } from "../src/services/fileClient.js";
import { lookup } from "../src/services/apiLegacyClient.js";
import { apiServer } from "../src/services/apiClient.js";
import { listNotificationsUnmodelled } from "../src/services/notifyClient.js";
import { register, requestToken } from "../src/services/idClient.js";
import { run } from "../src/runtime.js";
import { setSession } from "../src/session.js";
import { call, callFailure, servicesUp } from "./support.js";

/**
 * The parts of the library's surface no service happened to force us into.
 *
 * Everything else in this suite is driven by a backend that genuinely behaves that way.
 * These are the remaining exported behaviours — raw byte bodies, retained unmapped
 * responses, base-URL replacement, repeated query parameters, and the compile-time
 * guards — exercised deliberately so the evaluation can say it covered them rather than
 * that nothing happened to need them.
 */
describe.runIf(await servicesUp([4100, 4200, 4300, 4500]))("the rest of the library's surface", () => {
  const username = `surface_${Date.now()}`;
  const password = "surface_password_123";

  beforeAll(async () => {
    await call(register().setBody({ username, email: `${username}@test.invalid`, password }), "created");
    const token = await call(requestToken().setBody({ grant_type: "password", username, password }), "ok");
    setSession({
      accessToken: token.body.access_token,
      refreshToken: token.body.refresh_token,
      tokenType: "Bearer",
      username,
    });
  });

  it("sends raw bytes through the identity schema the codec pairs with", async () => {
    const payload = new TextEncoder().encode("raw bytes from the ERP");

    const created = await call(uploadRawBytes().setBody(payload).setUrlParam("name", "erp-export.dat"), "created");

    expect(created.body).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.headers["x-file-size"]).toBe(String(payload.byteLength));
  });

  describe("a response nobody modelled", () => {
    it("is drained by default and reaches the caller as UnhandledResponse", async () => {
      const failure = await callFailure(listNotificationsUnmodelled());

      expect(failure).toBeInstanceOf(UnhandledResponse);
      // The default is right: an undrained body holds a connection open, and a caller
      // who has not asked for the payload almost never wants it.
      expect((failure as UnhandledResponse).status).toBe(405);
    });

    it("is handed over when the caller asks to retain it, and then the caller owns it", async () => {
      const failure = await callFailure(listNotificationsUnmodelled().setUnhandledResponseBody("retain"));
      const unhandled = failure as UnhandledResponse;

      expect(unhandled.status).toBe(405);
      expect(unhandled.headers.allow).toBe("POST");

      // Reading the live body is the whole point of retaining it: this is the only way
      // to see what a service that nobody modelled actually said.
      const text = await run(unhandled.response.text);
      expect(text).toContain("only POST is accepted");
    });

    it("can be discarded instead of read, which is the other half of owning it", async () => {
      const failure = await callFailure(
        uploadRawUnmodelled().setBody(new Uint8Array([1, 2, 3])).setUnhandledResponseBody("retain"),
      );
      const unhandled = failure as UnhandledResponse;

      expect(unhandled.status).toBe(201);
      await run(unhandled.discard);
    });
  });

  it("replaces the base URL for one call, leaving the endpoint's declaration alone", async () => {
    // The same service under its other name. Real deployments have two: the internal
    // DNS name and the one the load balancer answers to, and only one of them resolves
    // from any given network.
    const alias = FILE_SERVER_URL.replace("localhost", "127.0.0.1");

    const created = await call(
      uploadRawBytes().setBody(new TextEncoder().encode("through the alias")).setBaseUrl(alias),
      "created",
    );

    expect(created.body).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("sends repeated query parameters, which this service then ignores all but one of", async () => {
    // `appendUrlParam` puts two `q` values on the wire. The Java service's 2014 query
    // parser reads them into a Map<String, String>, so the last one wins and the first
    // vanishes — the client did everything right and the server still lost data.
    const both = await call(lookup().setUrlParam("q", "first").appendUrlParam("q", "second"), "ok");
    const onlySecond = await call(lookup().setUrlParam("q", "second"), "ok");

    expect(both.body.matches.length).toBe(onlySecond.body.matches.length);
  });

  it("refuses a path parameter that would change the target path", async () => {
    const endpoint = apiServer.createRequest({
      method: "GET",
      path: "/api/projects/:id",
      responses: [response({ _tag: "ok", status: 200 }, Schema.Unknown)],
    });

    // Validation happens while the plan is built, synchronously, before any Effect
    // exists — so a bad path value cannot become a request at all.
    expect(() => endpoint({ id: "" })).toThrow();
  });

  it("does not offer an Effect for a body-bearing plan whose body was never set", async () => {
    const endpoint = apiServer.createRequest({
      method: "POST",
      path: "/api/projects",
      body: Schema.Struct({ name: Schema.String }),
      responses: [response({ _tag: "ok", status: 201 }, Schema.Unknown)],
    });

    // The plan's `effect` is typed as a diagnostic value rather than as an Effect until
    // `setBody` has been called, so the mistake is a compile error at every call site.
    const diagnostic: RequestBodyRequired = endpoint().effect;

    // At runtime the property is still an Effect — the diagnostic type is a compile-time
    // marker, and bypassing it produces the same failure from the failure channel
    // instead. The README says "available in the type system" and means it precisely.
    expect(Effect.isEffect(diagnostic)).toBe(true);
    const failure = await callFailure(endpoint());
    expect((failure as { readonly _tag: string })._tag).toBe("RequestBodyRequired");

    // With a body, it executes.
    expect(Effect.isEffect(endpoint().setBody({ name: "ok" }).effect)).toBe(true);
  });

  it("rejects duplicate response tags, both in the type system and at declaration time", () => {
    // Caught twice, which is the right amount: the type error is what a developer sees,
    // and the synchronous throw covers a declaration built dynamically or from
    // JavaScript. Two rules sharing a tag make `Match.tag` ambiguous rather than wrong,
    // so without this the mistake would only surface as a response decoded by whichever
    // rule happened to be declared first.
    expect(() =>
      apiServer.createRequest({
        method: "GET",
        path: "/api/projects",
        // @ts-expect-error Response tags must be unique within a declaration.
        responses: [
          response({ _tag: "ok", status: 200 }, Schema.Unknown),
          response({ _tag: "ok", status: 204 }, Schema.Unknown, { codec: ResponseBody.none }),
        ],
      }),
    ).toThrow(/Duplicate response tag "ok"/u);
  });
});
