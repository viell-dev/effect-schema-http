import { DateTime, Effect, Option, Schema } from "effect";
import { ResponseBody } from "viell-effect-schema-http";
import { beforeAll, describe, expect, it } from "vitest";
import { tunnelMethod } from "../src/plans/transforms.js";
import { LinkHeader, UsdFromDisplay } from "../src/schemas/apiLegacy.js";
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
import { createProject, createTask, deleteTask } from "../src/services/apiClient.js";
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
    await call(register().setBody({ username, email: `${username}@test.invalid`, password }), "created");
    const token = await call(requestToken().setBody({ grant_type: "password", username, password }), "ok");
    setSession({
      accessToken: token.body.access_token,
      refreshToken: token.body.refresh_token,
      tokenType: "Bearer",
      username,
    });

    const project = await call(createProject().setBody({ name: `Grid ${username}`, description: "" }), "created");
    projectId = project.body.id;
    const task = await call(
      createTask().setBody({ projectId, title: `Report row ${username}`, status: "REVIEW", priority: 3 }),
      "created",
    );
    taskId = task.body.id;
  });

  describe("64-bit ids, which JSON cannot carry", () => {
    it("keeps them exact by reading the body as text and parsing it differently", async () => {
      const ok = await call(listOrders(), "ok");
      const [first] = ok.body.orders;

      expect(ok.body.total).toBe(4);
      expect(first?.id).toBe("9007199254740993");
      expect(first?.idStr).toBe(first?.id);
    });

    it("shows what the default codec would have done to the same payload", async () => {
      // `setResponseSchema` replaces one rule's schema at the call site, so the same
      // endpoint can hand back its raw text. Running the platform parser over it is the
      // control case: this is precisely what `ResponseBody.json` would have produced.
      const raw = await call(
        listOrders().setResponseSchema({ _tag: "ok", status: 200 }, Schema.String, { codec: ResponseBody.text }),
        "ok",
      );

      const lossy = JSON.parse(raw.body) as { d: { results: ReadonlyArray<{ id: number; idStr: string }> } };
      const order = lossy.d.results[0]!;
      expect(order.idStr).toBe("9007199254740993");
      // Rounded, silently, before any schema could see it — and rounded *into* the
      // previous order's id, so two distinct rows become indistinguishable.
      expect(order.id).toBe(9007199254740992);
      expect(String(order.id)).not.toBe(order.idStr);
    });

    it("decodes every other convention in the same object", async () => {
      const ok = await call(listOrders(), "ok");
      const [first, second, third, fourth] = ok.body.orders;

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
    const ok = await call(gridReport(), "ok");
    const mine = ok.body.rows.find((row) => row.id === taskId);

    expect(mine?.title).toBe(`Report row ${username}`);
    // Column four is an ordinal in the grid too, decoded through the same names.
    expect(mine?.status).toBe("REVIEW");
    expect(mine?.priority).toBe(3);
    expect(DateTime.isDateTime(ok.body.generatedAt)).toBe(true);
  });

  describe("conditional requests, which this endpoint gets right", () => {
    it("answers 304 with no body when the validator still matches", async () => {
      const first = await call(getVersionedProject({ id: projectId }), "ok");
      const etag = first.headers.etag;
      expect(etag).toBeDefined();

      const second = await call(
        getVersionedProject({ id: projectId }).setHeader("if-none-match", etag!),
        "notModified",
      );
      // `ResponseBody.none` drains and yields undefined; the JSON codec would have
      // rejected the empty payload, which is correct of it.
      expect(second.body).toBeUndefined();
    });

    it("refuses a write whose validator is stale", async () => {
      const stale = await call(
        putVersionedProject({ id: projectId })
          .setBody({ name: "Should not apply" })
          .setHeader("if-match", '"not-the-current-etag"')
          .pipe(tunnelMethod("PUT")),
        "preconditionFailed",
      );
      expect(stale.status).toBe(412);
    });

    it("requires a validator at all", async () => {
      const missing = await call(
        putVersionedProject({ id: projectId }).setBody({ name: "No validator" }).pipe(tunnelMethod("PUT")),
        "preconditionRequired",
      );
      expect(missing.status).toBe(428);
    });

    it("is refused outright without the method override the gateway expects", async () => {
      // The same plan, minus the transform: the gateway rule is enforced by the service
      // too, so this is not a path that only works in development.
      const blocked = await call(
        putVersionedProject({ id: projectId }).setBody({ name: "Raw PUT" }).setHeader("if-match", '"x"'),
        "methodBlocked",
      );
      expect(blocked.status).toBe(405);
      expect(blocked.headers.allow).toBe("GET, POST");
    });

    it("writes, and returns what it wrote", async () => {
      const current = await call(getVersionedProject({ id: projectId }), "ok");
      const updated = await call(
        putVersionedProject({ id: projectId })
          .setBody({ name: `Renamed ${username}` })
          .setHeader("if-match", current.headers.etag!)
          .pipe(tunnelMethod("PUT")),
        "ok",
      );

      // Unlike PATCH on the 2014 endpoint two files over, this one is honest.
      expect(updated.body.name).toBe(`Renamed ${username}`);
      expect(updated.headers.etag).not.toBe(current.headers.etag);
    });
  });

  it("carries several outcomes inside one 200 and discriminates them in the schema", async () => {
    const ok = await call(
      batchGet().setBody({
        requests: [
          { id: "mine", path: `/api/projects/${projectId}` },
          { id: "gone", path: "/api/projects/does-not-exist" },
          { id: "odd", path: "/api/unsupported" },
        ],
      }),
      "ok",
    );

    const [found, missing, unsupported] = ok.body.responses;
    expect(found?._tag).toBe("found");
    expect(missing).toMatchObject({ _tag: "failed", status: 404, code: "NOT_FOUND" });
    expect(unsupported).toMatchObject({ _tag: "failed", status: 400, code: "UNSUPPORTED_PATH" });
    if (found?._tag === "found") expect(found.project.id).toBe(projectId);
  });

  it("follows a 202 with a relative Location until the job finishes", async () => {
    const accepted = await call(startImport().setBody({ source: "legacy.csv" }), "accepted");

    // The Location header is relative because the servlet container used to resolve it.
    expect(accepted.headers.location).toBe(`/api/imports/${accepted.body.id}`);
    const resolved = new URL(accepted.headers.location!, "http://localhost:4300");
    expect(resolved.pathname).toBe(`/api/imports/${accepted.body.id}`);

    // Polling is a loop over a cold plan, not a retry: the status changes rather than
    // the attempt failing, so nothing about it is transient in the library's sense.
    const poll = Effect.promise(() => call(importStatus({ id: accepted.body.id }), "ok"));
    let status = await Effect.runPromise(poll);
    let polls = 1;
    while (status.body.state === "pending" && polls < 6) {
      status = await Effect.runPromise(poll);
      polls += 1;
    }

    expect(status.body.state).toBe("done");
    expect(polls).toBe(3);
  });

  describe("a service that answers 200 to everything", () => {
    it("selects the error rule from a header, before the body is read", async () => {
      const failed = await call(lookup().setUrlParam("q", 'name:"unbalanced'), "LookupSyntaxError");
      expect(failed.status).toBe(200);
      expect(failed.body.message).toContain("Unbalanced quote");
      // The body carries the tag the client attached, not one the server sent.
      expect(failed.body._tag).toBe("LookupSyntaxError");
    });

    it("falls through to the plain 200 rule when the header is absent", async () => {
      // A project of its own, because an earlier test renames the shared one and the
      // lookup matches on the current name.
      const target = await call(createProject().setBody({ name: `Lookup ${username}`, description: "" }), "created");
      const ok = await call(lookup().setUrlParam("q", `Lookup ${username}`), "ok");
      expect(ok.body.matches.some((match) => match.id === target.body.id)).toBe(true);
    });
  });

  it("converts the Link header's zero-based offsets into the one-based pages the query wants", async () => {
    // Scoped to this run's own user, so the page boundaries do not move when another
    // test writes to a project.
    await call(createProject().setBody({ name: `Page two ${username}`, description: "" }), "created");
    const first = await call(
      listProjectsPage().setUrlParam("owner", username).setUrlParam("page", "1").setUrlParam("pageSize", "1"),
      "ok",
    );

    expect(first.body).toHaveLength(1);
    expect(Number(first.headers["x-total-count"])).toBeGreaterThan(0);

    const links = Schema.decodeUnknownSync(LinkHeader)(first.headers.link);
    const next = links.find((link) => link.rel === "next");
    // The header says offset=1; the endpoint's own parameter calls that page 2.
    expect(next?.offset).toBe(1);
    expect(next?.page).toBe(2);

    const second = await call(
      listProjectsPage()
        .setUrlParam("owner", username)
        .setUrlParam("page", String(next!.page))
        .setUrlParam("pageSize", String(next!.pageSize)),
      "ok",
    );
    expect(second.body[0]?.id).not.toBe(first.body[0]?.id);
  });

  it("refuses a DELETE the gateway would have stripped, and accepts the tunnelled one", async () => {
    const blocked = await call(deleteTask({ id: taskId }), "methodBlocked");
    expect(blocked.body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(blocked.headers.allow).toBe("GET, POST, PATCH");

    const tunnelled = await call(deleteTask({ id: taskId }).pipe(tunnelMethod("DELETE")), "noContent");
    // The handler still writes a debug body after its 204. It has never arrived, because
    // the container will not send one, which is why this is `ResponseBody.none`.
    expect(tunnelled.body).toBeUndefined();
  });
});
