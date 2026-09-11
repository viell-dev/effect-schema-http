import { Cause, DateTime, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { signed } from "../src/plans/signing.js";
import { RetirementNotice } from "../src/schemas/notifyService.js";
import {
  createNotification,
  getInbox,
  listNotifications,
  listNotificationsJsonp,
  notifySession,
  pollNotifications,
  throttled,
} from "../src/services/notifyClient.js";
import { NOTIFY_SERVER_URL } from "../src/services/notifyClient.js";
import { setCsrfToken } from "../src/session.js";
import { call, callAny, callFailure, servicesUp } from "./support.js";

const up = await servicesUp([4500]);

/** The same HMAC the service computes, for tests that need to get it deliberately wrong. */
const signatureFor = async (method: string, path: string, timestamp: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("notify-shared-secret-2011"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${method}\n${path}\n${timestamp}\n${body}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe.runIf(up)("Notify service — signatures, guards, and a status code that was never registered", () => {
  beforeAll(async () => {
    const session = await call(notifySession(), "ok");
    setCsrfToken(session.body.csrf_token);
  });

  it("reports its own retirement three different ways, and carries two cookies", async () => {
    const session = await call(notifySession(), "ok");

    // Three headers saying the same thing, each from a different draft.
    const notice = Schema.decodeUnknownSync(RetirementNotice)(session.headers);
    expect(notice.deprecation).toBe("true");
    expect(DateTime.toEpochMillis(notice.sunset)).toBeGreaterThan(Date.now());
    expect(notice.warning).toContain("299");

    // Set-Cookie is the one header that may never be combined, and the envelope carries
    // the parsed cookies alongside the raw entries.
    expect(session.cookies.cookies["notify_csrf"]?.value).toBe(session.body.csrf_token);
    expect(session.cookies.cookies["notify_seen"]).toBeDefined();
  });

  it("strips a guard that the default JSON codec would have choked on", async () => {
    const ok = await call(listNotifications(), "ok");

    expect(ok.body.length).toBeGreaterThanOrEqual(2);
    expect(ok.body[0]?.kind).toBe("mention");
    expect(DateTime.isDateTime(ok.body[0]!.createdAt)).toBe(true);
    // The content type claims JSON; the payload is not JSON until five bytes come off.
    expect(ok.headers["content-type"]).toContain("application/json");
  });

  it("reads a JSONP response as data, by knowing exactly which wrapper to expect", async () => {
    const ok = await call(listNotificationsJsonp(), "ok");
    expect(ok.body[0]?.id).toBe("n-1001");

    // A different callback name is a decode failure rather than something to be clever
    // about: reading JSONP safely means refusing anything but the exact expected shape.
    const wrong = await callFailure(listNotificationsJsonp().setUrlParam("callback", "somethingElse"));
    expect((wrong as { readonly _tag: string })._tag).toBe("ResponseDecodeError");
  });

  it("reads JSON out of a response that says it is HTML", async () => {
    const ok = await call(getInbox(), "ok");
    expect(ok.headers["content-type"]).toContain("text/html");
    expect(ok.body.items.length).toBeGreaterThanOrEqual(2);
    expect(ok.body.unread).toBeGreaterThanOrEqual(1);
  });

  describe("request signing, which a computed header cannot do", () => {
    it("signs the encoded body from mapClient, after encoding and per attempt", async () => {
      const created = await call(
        createNotification().setBody({ kind: "note", text: "signed from the client" }).pipe(signed),
        "created",
      );

      expect(created.body.text).toBe("signed from the client");
      // WEBrick absolutizes a relative Location, which is exactly what the Java
      // service's original servlet container used to do and its current one does not.
      // Same header, same intent, opposite results, decided by the container.
      expect(created.headers.location).toBe(`${NOTIFY_SERVER_URL}/notifications/${created.body.id}`);
    });

    it("is rejected without the transform, as a typed response rather than a thrown error", async () => {
      const rejected = await call(
        createNotification().setBody({ kind: "note", text: "unsigned" }),
        "SignatureRejected",
      );
      expect(rejected.body.detail).toContain("required");
    });

    it("does not care where in the pipeline the transform was applied", async () => {
      // Signing before the body is set still works, because `mapClient` wraps the
      // *client*: it runs at execution, against the finished request, not at the point
      // in the pipeline where it was written. A computed header could not do this
      // either — it resolves while the request is being materialized, before the body
      // schema has encoded anything.
      const created = await call(
        createNotification().pipe(signed).setBody({ kind: "note", text: "signed before the body was set" }),
        "created",
      );
      expect(created.body.text).toBe("signed before the body was set");
    });

    it("is rejected when the signature does not cover the body that was sent", async () => {
      // Signed by hand over a different body, and sent without the transform, which is
      // the failure a signature exists to catch.
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const stale = await signatureFor("POST", "/notifications", timestamp, '{"kind":"note","text":"original"}');

      const tampered = await call(
        createNotification()
          .setBody({ kind: "note", text: "substituted" })
          .setHeader("x-timestamp", timestamp)
          .setHeader("x-signature", stale),
        "SignatureRejected",
      );
      expect(tampered.body.detail).toContain("mismatch");
    });

    it("is rejected when the signature is older than the window", async () => {
      const stale = Math.floor(Date.now() / 1000 - 600).toString();
      const signature = await signatureFor("POST", "/notifications", stale, '{"kind":"note","text":"late"}');

      const expired = await call(
        createNotification()
          .setBody({ kind: "note", text: "late" })
          .setHeader("x-timestamp", stale)
          .setHeader("x-signature", signature),
        "SignatureRejected",
      );
      expect(expired.body.detail).toContain("window");
    });

    it("is rejected when the CSRF token is missing, separately from the signature", async () => {
      const rejected = await call(
        createNotification()
          .setBody({ kind: "note", text: "no token" })
          .removeHeader("x-csrf-token")
          .pipe(signed),
        "CsrfRejected",
      );
      expect(rejected.body.detail).toContain("GET /session");
    });

    it("validates the payload after both credentials pass", async () => {
      // A value the schema accepts and the server does not: the client's rule is
      // "non-empty", the server's is "non-blank", and the two were written eleven years
      // apart. Server-side validation is not redundant just because a schema exists.
      const rejected = await call(
        createNotification().setBody({ kind: "note", text: " " }).pipe(signed),
        "PayloadRejected",
      );
      expect(rejected.body.detail).toContain("text is required");
    });

    it("refuses an empty text before a request is ever sent", async () => {
      // `RequestBodyEncodeError`, from the body schema, with no network involved. The
      // library will not let an invalid domain value reach the transport.
      const failure = await callFailure(createNotification().setBody({ kind: "note", text: "" }).pipe(signed));
      expect((failure as { readonly _tag: string })._tag).toBe("RequestBodyEncodeError");
    });
  });

  describe("420 Enhance Your Calm", () => {
    it("is not transient as far as the library is concerned, and should not be", async () => {
      const first = await callAny(throttled().setHeader("x-client-id", `plain-${Date.now()}`).setRetries(3));
      // Three built-in retries changed nothing: 420 is not a registered status and is
      // not in the transient set, which is the correct default.
      expect(first._tag).toBe("EnhanceYourCalm");
    });

    it("is retried when `while` says so, which is exactly what `while` is for", async () => {
      const client = `calm-${Date.now()}`;
      const ok = await callAny(
        throttled()
          .setHeader("x-client-id", client)
          .setRetry({
            times: 4,
            // `while` can only *add* retryable cases; it cannot veto the built-in ones.
            while: (input) =>
              typeof input === "object" && input !== null && "status" in input && input.status === 420,
          }),
      );

      expect(ok._tag).toBe("ok");
      // The server needed three calls, and the handler only ever saw the last one.
      if (ok._tag === "ok") expect(ok.body.attempts).toBe(3);
    });
  });

  describe("a long poll", () => {
    it("returns when the server does", async () => {
      const ok = await call(pollNotifications().setUrlParam("wait", "1"), "ok");
      expect(ok.body.waited).toBe(1);
      expect(ok.body.events).toEqual([]);
    });

    it("is bounded by setTimeout, which fails the attempt rather than hanging", async () => {
      const failure = await callFailure(
        pollNotifications().setUrlParam("wait", "5").setTimeout("400 millis"),
      );
      // A timeout is an Effect `TimeoutException`, not a mapped response: nothing came
      // back to map.
      expect(Cause.isTimeoutException(failure)).toBe(true);
    });
  });
});
