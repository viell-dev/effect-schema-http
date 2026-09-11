import { FetchHttpClient, HttpClient } from "@effect/platform";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { legacyNotifications, notifySession, whoAmI } from "../src/services/notifyClient.js";
import { call, servicesUp } from "./support.js";

/**
 * Things that belong to the transport rather than to the request.
 *
 * A request plan describes a method, a path, headers, parameters, a body and how to
 * decode what comes back. It deliberately does not describe how the *provider* should
 * behave — whether to follow redirects, whether to send cookies, which credentials mode
 * to use — because those are properties of the client, and the library's stated position
 * is that the application chooses its client.
 *
 * That is defensible, and it has a consequence worth pinning: a response rule for a `3xx`
 * is perfectly declarable and, with the default Fetch provider, can never match.
 */
describe.runIf(await servicesUp([4500]))("transport options are not request options", () => {
  it("never reaches a 301 rule, because the provider followed the redirect", async () => {
    const result = await call(legacyNotifications(), "followed");

    // The `moved` rule is declared, typed, and unreachable: `fetch` followed the
    // Location and handed back the 200 from the new path. Nothing in the plan API can
    // change that, because the decision was made by the client before the library saw a
    // response at all.
    expect(result.status).toBe(200);
    expect(result.body.length).toBeGreaterThan(0);
  });

  it("reaches it when the provider is told not to follow", async () => {
    // The escape hatch is provider-specific and lives outside this library:
    // `FetchHttpClient.RequestInit` is a context tag carrying the options `fetch` is
    // called with. Providing it per call site is the closest thing to a per-request
    // transport option, and it is worth knowing it exists — nothing in the library's own
    // documentation mentions it, because from the library's point of view it is someone
    // else's API.
    const moved = await Effect.runPromise(
      legacyNotifications().effect.pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provide(FetchHttpClient.layer),
      ),
    );

    expect(moved._tag).toBe("moved");
    if (moved._tag === "moved") {
      expect(moved.body.moved).toBe("/notifications.json");
      expect(moved.body.since).toBe("2013-06-01");
      // WEBrick absolutizes it; the Java service does not. Same header, same intent.
      expect(moved.headers.location).toContain("/notifications.json");
    }
  });

  it("sends no cookies of its own, so a cookie-reading endpoint needs the header by hand", async () => {
    const session = await call(notifySession(), "ok");
    // The service set `notify_csrf` in a Set-Cookie header on that response, and the
    // envelope parsed it — but nothing will send it back. Node's fetch has no cookie
    // jar, and a cross-origin browser fetch sends none without `credentials: "include"`
    // and a server that allows credentials against a specific origin.
    expect(session.cookies.cookies["notify_csrf"]?.value).toBe(session.body.csrf_token);

    const withoutCookie = await call(whoAmI(), "noCookie");
    expect(withoutCookie.body.detail).toContain("a header is not the same thing");

    const withCookie = await call(whoAmI().setHeader("cookie", `notify_csrf=${session.body.csrf_token}`), "ok");
    expect(withCookie.body.valid).toBe(true);
  });

  it("can install a whole different provider for one plan", async () => {
    // `mapClient` covers the cases that *are* client transformations, which is most of
    // them: tracing, redaction, a retry policy of the client's own, or swapping the
    // transport entirely for one call.
    let seen = 0;
    const counting = HttpClient.tap(() => Effect.sync(() => (seen += 1)));

    const result = await Effect.runPromise(
      legacyNotifications().mapClient(counting).effect.pipe(Effect.provide(FetchHttpClient.layer)),
    );

    expect(result._tag).toBe("followed");
    expect(seen).toBe(1);
  });
});
