import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/runtime.js";
import { apiRequest } from "../src/services/apiClient.js";
import { lookup } from "../src/services/apiLegacyClient.js";
import { FILE_SERVER_URL, fileRequest, uploadRawBytes } from "../src/services/fileClient.js";
import { register, requestToken } from "../src/services/idClient.js";
import { listNotificationsUnmodelled, notifyRequest } from "../src/services/notifyClient.js";
import { setSession } from "../src/session.js";
import { call, callFailure, servicesUp } from "./support.js";

describe.runIf(await servicesUp([4100, 4200, 4300, 4500]))("native llm2 composition against the services", () => {
  const username = `surface_${Date.now()}`;
  const password = "surface_password_123";

  beforeAll(async () => {
    await call(register().execute({ body: { username, email: `${username}@test.invalid`, password } }), "created");
    const token = await call(requestToken().execute({ body: { grant_type: "password", username, password } }), "ok");
    setSession({
      accessToken: token.value.access_token,
      refreshToken: token.value.refresh_token,
      tokenType: "Bearer",
      username,
    });
  });

  it("sends raw bytes without an identity schema", async () => {
    const payload = new TextEncoder().encode("raw bytes from the ERP");
    const created = await call(
      uploadRawBytes({ request: Request.setQuery("name", "erp-export.dat") }).execute({ body: payload }),
      "created",
    );
    expect(created.value).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.metadata.headers["x-file-size"]).toBe(String(payload.byteLength));
  });

  describe("a response nobody modelled", () => {
    it("is drained before reaching the caller as UnexpectedStatus", async () => {
      const failure = await callFailure(listNotificationsUnmodelled().execute(undefined));
      expect(failure).toBeInstanceOf(Response.UnexpectedStatus);
      if (failure instanceof Response.UnexpectedStatus) expect(failure.metadata.status).toBe(405);
    });

    it("can be read by an explicit fallback inside the operation scope", async () => {
      const operation = Operation.make(
        notifyRequest("GET", "/notifications", {}),
        Response.status(200, Response.tag("ok", Body.json)).pipe(
          Response.orElse(Response.when(() => true, Response.tag("unmodelled", Body.text))),
        ),
      );
      const result = await call(operation.execute(undefined), "unmodelled");
      expect(result.metadata.status).toBe(405);
      expect(result.metadata.headers.allow).toBe("POST");
      expect(result.value).toContain("only POST is accepted");
    });

    it("can discard the payload through an explicit empty fallback", async () => {
      const operation = Operation.make(
        fileRequest("POST", "/raw", {}).pipe(Request.body(Body.bytes)),
        Response.status(200, Response.tag("ok", Body.text)).pipe(
          Response.orElse(Response.when(() => true, Response.tag("discarded", Body.empty))),
        ),
      );
      const result = await call(operation.execute({ body: new Uint8Array([1, 2, 3]) }), "discarded");
      expect(result.metadata.status).toBe(201);
      expect(result.value).toBeUndefined();
    });
  });

  it("replaces the base URL for one operation", async () => {
    const alias = FILE_SERVER_URL.replace("localhost", "127.0.0.1");
    const created = await call(
      uploadRawBytes({ request: Request.baseUrl(alias) }).execute({
        body: new TextEncoder().encode("through the alias"),
      }),
      "created",
    );
    expect(created.value).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("sends repeated query parameters, which this service keeps only the last of", async () => {
    const both = await call(
      lookup({
        request: (request) => request.pipe(Request.setQuery("q", "first"), Request.appendQuery("q", "second")),
      }).execute(undefined),
      "ok",
    );
    const onlySecond = await call(lookup({ request: Request.setQuery("q", "second") }).execute(undefined), "ok");
    expect(both.value.matches.length).toBe(onlySecond.value.matches.length);
  });

  it("leaves empty path values to the application contract", async () => {
    const request = apiRequest("GET", "/", {}).pipe(
      Request.path(Schema.Struct({ id: Schema.String }), (value, encode) => `/api/projects/${encode(value.id)}`),
    );
    const prepared = await run(Request.materialize(request, { path: { id: "" } }));
    expect(prepared.url).toMatch(/\/api\/projects\/$/u);
  });

  it("requires the body in the operation input and validates it before dispatch", async () => {
    const operation = Operation.make(
      apiRequest("POST", "/api/projects", {}).pipe(
        Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
      ),
      Response.status(201, Body.json),
    );
    // @ts-expect-error The complete input must include a body.
    const incomplete = operation.execute({});
    const failure = await callFailure(incomplete);
    expect(failure._tag).toBe("ParseError");
    expect(Effect.isEffect(operation.execute({ body: { name: "ok" } }))).toBe(true);
  });

  it("uses explicit response order and permits one tag for multiple statuses", async () => {
    const contract = Response.status(200, Response.tag("ok", Body.json)).pipe(
      Response.orElse(Response.status(204, Response.tag("ok", Body.empty))),
    );
    expect(contract).toBeDefined();
    // Tags belong to decoders; ordered metadata predicates select the representation.
    const result = await run(Operation.make(apiRequest("GET", "/api/projects", {}), contract).execute(undefined));
    expect(result._tag).toBe("ok");
    expect(Array.isArray(result.value)).toBe(true);
  });
});
