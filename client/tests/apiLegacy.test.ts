import { DateTime, Effect, Option, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { beforeAll, describe, expect, it } from "vitest";
import { tunnelMethod } from "../src/plans/transforms.js";
import { LinkHeader, UsdFromDisplay } from "../src/schemas/apiLegacy.js";
import { apiRequest, createProject, createTask, deleteTask } from "../src/services/apiClient.js";
import {
  batchGet,
  getVersionedProject,
  gridReport,
  importStatus,
  listOrders,
  listProjectsPage,
  lookup,
  putVersionedProject,
  startImport,
} from "../src/services/apiLegacyClient.js";
import { register, requestToken } from "../src/services/idClient.js";
import { setSession } from "../src/session.js";
import { call, servicesUp } from "./support.js";

const up = await servicesUp([4100, 4300]);

describe.runIf(up)("API server — the endpoints that predate the rest of it", () => {
  const username = `legacy_api_${Date.now()}`;
  const password = "legacy_api_pw_123";
  let projectId = "";
  let taskId = "";

  beforeAll(async () => {
    await call(register().execute({ body: { username, email: `${username}@test.invalid`, password } }), "created");
    const token = await call(requestToken().execute({ body: { grant_type: "password", username, password } }), "ok");
    setSession({
      accessToken: token.value.access_token,
      refreshToken: token.value.refresh_token,
      tokenType: "Bearer",
      username,
    });

    const project = await call(
      createProject().execute({ body: { name: `Grid ${username}`, description: "" } }),
      "created",
    );
    projectId = project.value.id;
    const task = await call(
      createTask().execute({ body: { projectId, title: `Report row ${username}`, status: "REVIEW", priority: 3 } }),
      "created",
    );
    taskId = task.value.id;
  });

  describe("64-bit ids, which JSON cannot carry", () => {
    it("keeps them exact by reading the body as text and parsing it differently", async () => {
      const ok = await call(listOrders().execute(undefined), "ok");
      const [first] = ok.value.orders;

      expect(ok.value.total).toBe(4);
      expect(first?.id).toBe("9007199254740993");
      expect(first?.idStr).toBe(first?.id);
    });

    it("shows what the default codec would have done to the same payload", async () => {
      // Bind a text decoder to the same request. JSON.parse is the lossy control case.
      const raw = await call(
        Operation.make(
          apiRequest("GET", "/api/odata/Orders", {}),
          Response.status(200, Response.tag("ok", Body.text)),
        ).execute(undefined),
        "ok",
      );

      const lossy = JSON.parse(raw.value) as { d: { results: ReadonlyArray<{ id: number; idStr: string }> } };
      const order = lossy.d.results[0]!;
      expect(order.idStr).toBe("9007199254740993");
      // Rounded, silently, before any schema could see it — and rounded *into* the
      // previous order's id, so two distinct rows become indistinguishable.
      expect(order.id).toBe(9007199254740992);
      expect(String(order.id)).not.toBe(order.idStr);
    });

    it("decodes every other convention in the same object", async () => {
      const ok = await call(listOrders().execute(undefined), "ok");
      const [first, second, third, fourth] = ok.value.orders;

      // /Date(…)/ with and without a decorative offset.
      expect(DateTime.toEpochMillis(first!.orderDate)).toBe(1262304000000);
      expect(DateTime.toEpochMillis(third!.orderDate)).toBe(1262304000000);

      // Money as integer cents, never a float.
      expect(first?.amount).toBe(123450);
      expect(second?.amount).toBe(223450);

      // "Y"/"N", the zero date, and -1 for unlimited.
      expect(first?.active).toBe(true);
      expect(second?.active).toBe(false);
      expect(first?.cancelledOn).toBeNull();
      expect(fourth?.cancelledOn).not.toBeNull();
      expect(second?.creditLimit).toEqual({ _tag: "unlimited" });
      expect(first?.creditLimit).toEqual({ _tag: "limited", amount: 50000 });

      // Four spellings of nothing, collapsed into one.
      expect(Option.isNone(first!.notes)).toBe(true);
      expect(Option.isNone(second!.notes)).toBe(true);
      expect(Option.isNone(third!.notes)).toBe(true);
      expect(Option.getOrNull(fourth!.notes)).toBe("Escalated by support");

      // A reference that is an object in some rows and a bare id in others.
      expect(first?.customerRef).toEqual({ id: "CUST-100", name: "Contoso 0" });
      expect(second?.customerRef).toEqual({ id: "CUST-101", name: null });
    });

    it("round-trips a formatted money string", () => {
      const cents = Schema.decodeUnknownSync(UsdFromDisplay)("$1,234.50");
      expect(cents).toBe(123450);
      expect(Schema.encodeSync(UsdFromDisplay)(cents)).toBe("$1,234.50");
      expect(() => Schema.decodeUnknownSync(UsdFromDisplay)("1234.5")).toThrow();
    });
  });

  it("gives the report grid's positional rows their names back", async () => {
    const ok = await call(gridReport().execute(undefined), "ok");
    const mine = ok.value.rows.find((row) => row.id === taskId);

    expect(mine?.title).toBe(`Report row ${username}`);
    // Column four is an ordinal in the grid too, decoded through the same names.
    expect(mine?.status).toBe("REVIEW");
    expect(mine?.priority).toBe(3);
    expect(DateTime.isDateTime(ok.value.generatedAt)).toBe(true);
  });

  describe("conditional requests, which this endpoint gets right", () => {
    it("answers 304 with no body when the validator still matches", async () => {
      const first = await call(getVersionedProject().execute({ path: { id: projectId } }), "ok");
      const etag = first.metadata.headers.etag;
      expect(etag).toBeDefined();

      const second = await call(
        getVersionedProject({ request: (request) => request.pipe(Request.setHeader("if-none-match", etag!)) }).execute({
          path: { id: projectId },
        }),
        "notModified",
      );
      // `ResponseBody.none` drains and yields undefined; the JSON codec would have
      // rejected the empty payload, which is correct of it.
      expect(second.value).toBeUndefined();
    });

    it("refuses a write whose validator is stale", async () => {
      const stale = await call(
        putVersionedProject({
          request: (request) =>
            request.pipe(Request.setHeader("if-match", '"not-the-current-etag"'), tunnelMethod("PUT")),
        }).execute({ path: { id: projectId }, body: { name: "Should not apply" } }),
        "preconditionFailed",
      );
      expect(stale.metadata.status).toBe(412);
    });

    it("requires a validator at all", async () => {
      const missing = await call(
        putVersionedProject({ request: (request) => request.pipe(tunnelMethod("PUT")) }).execute({
          path: { id: projectId },
          body: { name: "No validator" },
        }),
        "preconditionRequired",
      );
      expect(missing.metadata.status).toBe(428);
    });

    it("is refused outright without the method override the gateway expects", async () => {
      // The same plan, minus the transform: the gateway rule is enforced by the service
      // too, so this is not a path that only works in development.
      const blocked = await call(
        putVersionedProject({ request: (request) => request.pipe(Request.setHeader("if-match", '"x"')) }).execute({
          path: { id: projectId },
          body: { name: "Raw PUT" },
        }),
        "methodBlocked",
      );
      expect(blocked.metadata.status).toBe(405);
      expect(blocked.metadata.headers.allow).toBe("GET, POST");
    });

    it("writes, and returns what it wrote", async () => {
      const current = await call(getVersionedProject().execute({ path: { id: projectId } }), "ok");
      const updated = await call(
        putVersionedProject({
          request: (request) =>
            request.pipe(Request.setHeader("if-match", current.metadata.headers.etag!), tunnelMethod("PUT")),
        }).execute({ path: { id: projectId }, body: { name: `Renamed ${username}` } }),
        "ok",
      );

      // Unlike PATCH on the 2014 endpoint two files over, this one is honest.
      expect(updated.value.name).toBe(`Renamed ${username}`);
      expect(updated.metadata.headers.etag).not.toBe(current.metadata.headers.etag);
    });
  });

  it("carries several outcomes inside one 200 and discriminates them in the schema", async () => {
    const ok = await call(
      batchGet().execute({
        body: {
          requests: [
            { id: "mine", path: `/api/projects/${projectId}` },
            { id: "gone", path: "/api/projects/does-not-exist" },
            { id: "odd", path: "/api/unsupported" },
          ],
        },
      }),
      "ok",
    );

    const [found, missing, unsupported] = ok.value.responses;
    expect(found?._tag).toBe("found");
    expect(missing).toMatchObject({ _tag: "failed", status: 404, code: "NOT_FOUND" });
    expect(unsupported).toMatchObject({ _tag: "failed", status: 400, code: "UNSUPPORTED_PATH" });
    if (found?._tag === "found") expect(found.project.id).toBe(projectId);
  });

  it("follows a 202 with a relative Location until the job finishes", async () => {
    const accepted = await call(startImport().execute({ body: { source: "legacy.csv" } }), "accepted");

    // The Location header is relative because the servlet container used to resolve it.
    expect(accepted.metadata.headers.location).toBe(`/api/imports/${accepted.value.id}`);
    const resolved = new URL(accepted.metadata.headers.location!, "http://localhost:4300");
    expect(resolved.pathname).toBe(`/api/imports/${accepted.value.id}`);

    // Polling is a loop over a cold plan, not a retry: the status changes rather than
    // the attempt failing, so nothing about it is transient in the library's sense.
    const poll = Effect.promise(() => call(importStatus().execute({ path: { id: accepted.value.id } }), "ok"));
    let status = await Effect.runPromise(poll);
    let polls = 1;
    while (status.value.state === "pending" && polls < 6) {
      status = await Effect.runPromise(poll);
      polls += 1;
    }

    expect(status.value.state).toBe("done");
    expect(polls).toBe(3);
  });

  describe("a service that answers 200 to everything", () => {
    it("selects the error rule from a header, before the body is read", async () => {
      const failed = await call(
        lookup({ request: (request) => request.pipe(Request.setQuery("q", 'name:"unbalanced')) }).execute(undefined),
        "LookupSyntaxError",
      );
      expect(failed.metadata.status).toBe(200);
      expect(failed.value.message).toContain("Unbalanced quote");
      // The body carries the tag the client attached, not one the server sent.
      expect(failed.value._tag).toBe("LookupSyntaxError");
    });

    it("falls through to the plain 200 rule when the header is absent", async () => {
      // A project of its own, because an earlier test renames the shared one and the
      // lookup matches on the current name.
      const target = await call(
        createProject().execute({ body: { name: `Lookup ${username}`, description: "" } }),
        "created",
      );
      const ok = await call(
        lookup({ request: (request) => request.pipe(Request.setQuery("q", `Lookup ${username}`)) }).execute(undefined),
        "ok",
      );
      expect(ok.value.matches.some((match) => match.id === target.value.id)).toBe(true);
    });
  });

  it("converts the Link header's zero-based offsets into the one-based pages the query wants", async () => {
    // Scoped to this run's own user, so the page boundaries do not move when another
    // test writes to a project.
    await call(createProject().execute({ body: { name: `Page two ${username}`, description: "" } }), "created");
    const first = await call(
      listProjectsPage({
        request: (request) =>
          request.pipe(
            Request.setQuery("owner", username),
            Request.setQuery("page", "1"),
            Request.setQuery("pageSize", "1"),
          ),
      }).execute(undefined),
      "ok",
    );

    expect(first.value).toHaveLength(1);
    expect(Number(first.metadata.headers["x-total-count"])).toBeGreaterThan(0);

    const links = Schema.decodeUnknownSync(LinkHeader)(first.metadata.headers.link);
    const next = links.find((link) => link.rel === "next");
    // The header says offset=1; the endpoint's own parameter calls that page 2.
    expect(next?.offset).toBe(1);
    expect(next?.page).toBe(2);

    const second = await call(
      listProjectsPage({
        request: (request) =>
          request.pipe(
            Request.setQuery("owner", username),
            Request.setQuery("page", String(next!.page)),
            Request.setQuery("pageSize", String(next!.pageSize)),
          ),
      }).execute(undefined),
      "ok",
    );
    expect(second.value[0]?.id).not.toBe(first.value[0]?.id);
  });

  it("refuses a DELETE the gateway would have stripped, and accepts the tunnelled one", async () => {
    const blocked = await call(deleteTask().execute({ path: { id: taskId } }), "methodBlocked");
    expect(blocked.value.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(blocked.metadata.headers.allow).toBe("GET, POST, PATCH");

    const tunnelled = await call(
      deleteTask({ request: (request) => request.pipe(tunnelMethod("DELETE")) }).execute({ path: { id: taskId } }),
      "noContent",
    );
    // The handler still writes a debug body after its 204. It has never arrived, because
    // the container will not send one, which is why this is `ResponseBody.none`.
    expect(tunnelled.value).toBeUndefined();
  });
});
