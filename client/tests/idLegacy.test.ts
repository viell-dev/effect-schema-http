import { Effect, Schema } from "effect";
import { RequestBody } from "viell-effect-schema-http";
import { beforeAll, describe, expect, it } from "vitest";
import { forceFresh, withNonce, withScopeLines } from "../src/plans/transforms.js";
import { HttpDate, RetryAfterSeconds } from "../src/schemas/common.js";
import { EdgeCacheStatus, TokenProbeHeaders } from "../src/schemas/idLegacy.js";
import {
  directoryEntry,
  discovery,
  formLogin,
  getJwks,
  getUserInfo,
  purgeJwksCache,
  probeToken,
  register,
  requestToken,
  resetSessionEcho,
  revokeToken,
  scopedToken,
  sessionEcho,
} from "../src/services/idClient.js";
import { clearSession, setSession } from "../src/session.js";
import { call, callAny, callWithRepeatedHeaders, expectTag, servicesUp } from "./support.js";

const up = await servicesUp([4100]);

describe.runIf(up)("ID server — the endpoints that accreted after 2019", () => {
  const username = `legacy_${Date.now()}`;
  const password = "legacy_password_123";
  let accessToken = "";

  beforeAll(async () => {
    clearSession();
    await call(register().setBody({ username, email: `${username}@test.invalid`, password }), "created");
  });

  it("logs in through the form-encoded grant RFC 6749 actually specifies", async () => {
    // `RequestBody.urlParams` receives the schema's *encoded* value, which for an
    // ordinary struct of strings is already the flat record the codec wants.
    const ok = await call(
      formLogin().setBody({ grant_type: "password", username, password }),
      "ok",
    );

    expect(ok.body.access_token).toMatch(/^at_[0-9a-f]{32}$/u);
    // Three code paths spell the same word three ways; all decode to one literal.
    expect(ok.body.token_type).toBe("Bearer");
    // `expires_in` is a string on the wire because the handler models the whole
    // exchange as a map of strings.
    expect(ok.body.expires_in).toBe(3600);
    // `scope` is space-delimited, as the specification requires and as nothing else
    // in this service does.
    expect(ok.body.scope).toEqual(["openid", "profile", "projects:read", "projects:write"]);

    accessToken = ok.body.access_token;
    setSession({ accessToken, refreshToken: "", tokenType: "Bearer", username });
  });

  it("answers 415 when the same body is sent as JSON, and that is a mapped response", async () => {
    // Overriding the codec at the call site is one setter; the endpoint declaration is
    // untouched, and the 415 rule decodes the OAuth error shape rather than throwing.
    const rejected = await call(
      formLogin()
        .setBody({ grant_type: "password", username, password })
        .setRequestBodyCodec(RequestBody.json),
      "UnsupportedMediaType",
    );

    expect(rejected.body.error).toBe("invalid_request");
  });

  it("reads a HEAD probe's facts out of its headers with an ordinary schema", async () => {
    const probe = await call(probeToken(), "valid");

    // Header values are strings, which is what a schema's *encoded* side describes, so
    // no special support is needed to decode an envelope's headers.
    const facts = Schema.decodeUnknownSync(TokenProbeHeaders)(probe.headers);
    expect(facts["x-token-username"]).toBe(username);
    expect(facts["x-token-expires-in"]).toBeGreaterThan(3000);
    expect(facts["x-token-scope"]).toContain("projects:write");

    // The server wrote four separate `X-Token-Scope` field lines. Fetch combined them
    // before Effect Platform ever saw them, so `headerEntries` reports one joined entry.
    // This is a provider property, not a library one — see repeatedHeaderClient.ts.
    const scopeLines = probe.headerEntries.filter(([name]) => name.toLowerCase() === "x-token-scope");
    expect(scopeLines.length).toBe(1);
  });

  it("decodes the LDAP gateway's spelling into the shape the rest of the client uses", async () => {
    const found = await call(directoryEntry({ username }), "ok");

    expect(found.body.username).toBe(username);
    expect(found.body.active).toBe(true);
    expect(found.body.createdAt).not.toBeNull();
    // DISPLAYNAME was blank on the wire; blank means absent, not empty.
    expect(found.body.displayName).toBeNull();

    // A user who does not exist is still a 200, because operations asked for no 404s
    // in the access log.
    const missing = await call(directoryEntry({ username: "nobody-at-all" }), "ok");
    expect(missing.body.active).toBe(false);
    expect(missing.body.id).toBeNull();
    expect(missing.body.createdAt).toBeNull();
  });

  it("omits the query-parameter credential entirely when signed out", async () => {
    clearSession();
    const unauthorized = await call(directoryEntry({ username }), "SimpleUnauthorized");
    // A computed value returning undefined omits the parameter; it does not send the
    // string "undefined", which is what a template literal would have done.
    expect(unauthorized.body.message).toContain("access_token");
    setSession({ accessToken, refreshToken: "", tokenType: "Bearer", username });
  });

  it("splits the one list in the discovery document that is not a list", async () => {
    const document = await call(discovery(), "ok");
    expect(document.body.grant_types_supported).toEqual(["password", "refresh_token"]);
    expect(document.body.response_types_supported).toEqual(["token"]);
  });

  it("goes around a reverse proxy that ignores request cache directives", async () => {
    // A cache in front of a service is shared by every reader, so an assertion about a
    // MISS has to start from a known state. Purging is how that is done in production
    // too, and the purge API is nothing like the cache's own configuration.
    await call(purgeJwksCache(), "purged");

    const first = await call(getJwks(), "ok");
    const second = await call(getJwks(), "ok");
    const bypassed = await call(getJwks().pipe(forceFresh), "ok");

    const status = (headers: Record<string, string | undefined>) =>
      Schema.decodeUnknownSync(EdgeCacheStatus)(headers);

    expect(status(first.headers)["x-cache"]).toBe("MISS");
    // `setCache({ control: "no-cache" })` alone changes nothing here: the proxy was
    // configured in an era that ignored request directives.
    expect(status(second.headers)["x-cache"]).toBe("HIT");
    // The computed cache-busting parameter is what actually reaches the origin.
    expect(status(bypassed.headers)["x-cache"]).toBe("BYPASS");
    expect(bypassed.body.keys[0]?.kid).toBe("refresh-2020");
  });

  describe("a request that must differ per attempt", () => {
    beforeAll(async () => {
      await call(resetSessionEcho(), "reset");
    });

    it("cannot use the built-in retry policy, because the replayed nonce is spent", async () => {
      // The endpoint answers 503 twice before it warms up, and the library retries a
      // 503 without configuration — including honouring the `Retry-After`, which this
      // server sends as an HTTP-date rather than seconds.
      //
      // It still fails, and the failure is the point: request encoding runs once per
      // evaluation, so all three attempts carry the same `X-Nonce`, and the gateway's
      // replay check spends that nonce on the attempt that returned 503.
      const replayed = await callAny(
        sessionEcho().setBody({ message: "built-in retry" }).pipe(withNonce(1000)).setRetries(3),
      );

      expect(replayed._tag).toBe("NonceReplayError");
      expectTag(replayed, "NonceReplayError");
    });

    it("succeeds when the caller drives the loop and supplies a fresh nonce each time", async () => {
      await call(resetSessionEcho(), "reset");

      // Plans are cold and re-executable, so "loop over the plan" is ordinary code
      // rather than a second call site. The trade is explicit: this gives up
      // `Retry-After` handling and the jittered schedule to gain a per-attempt value.
      const attempt = (nonce: number) =>
        Effect.promise(() =>
          callAny(sessionEcho().setBody({ message: "manual loop" }).pipe(withNonce(nonce)).setRetries(0)),
        );

      let nonce = 2000;
      let result = await Effect.runPromise(attempt(nonce));
      while (result._tag === "WarmingUpError" && nonce < 2010) {
        nonce += 1;
        result = await Effect.runPromise(attempt(nonce));
      }

      const ok = expectTag(result, "ok");
      expect(ok.body.attempt).toBe(3);
      expect(ok.body.nonce).toBe(2002);
      expect(ok.body.echo.message).toBe("manual loop");
    });
  });

  describe("repeated request header field lines", () => {
    it("is rejected through Fetch, which joins them before the request is sent", async () => {
      const joined = await call(
        scopedToken().pipe(withScopeLines(["openid", "projects:read"])),
        "JoinedScopeError",
      );

      // One physical line arrived carrying "openid, projects:read".
      expect(joined.body.received_lines).toBe(1);
      expect(joined.body.error_description).toContain("one scope per X-Scope header line");
    });

    it("succeeds through a provider that preserves the plan's header entries", async () => {
      const ok = expectTag(
        await callWithRepeatedHeaders(scopedToken().pipe(withScopeLines(["openid", "projects:read"]))),
        "ok",
      );

      expect(ok.body.scope_lines).toEqual(["openid", "projects:read"]);
      expect(ok.body.scope).toEqual(["openid", "projects:read"]);
    });
  });

  describe("the rate limiter, which is a reverse-proxy configuration", () => {
    it("answers 429 with an HTTP-date Retry-After, which the library honours unaided", async () => {
      // The limiter keys on X-Forwarded-For and trusts it, so this burst gets its own
      // bucket and does not starve the rest of the suite. That is a real flaw in every
      // limiter deployed this way, and it is what makes the test possible.
      const bucket = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
      const burst = () =>
        requestToken()
          .setBody({ grant_type: "password", username, password: "wrong-on-purpose" })
          .setHeader("x-forwarded-for", bucket);

      let retryAfter: string | undefined;
      for (let attempt = 0; attempt < 70 && retryAfter === undefined; attempt += 1) {
        const result = await callAny(burst());
        if (result._tag === "RateLimited") retryAfter = result.headers["retry-after"];
      }

      expect(retryAfter).toBeDefined();
      // Seconds is what RFC 9110 suggests first and what every client assumes. This
      // limiter sends the other legal form, because devops copied an Apache example.
      expect(retryAfter).toMatch(/GMT$/u);
      expect(Schema.decodeUnknownSync(RetryAfterSeconds)(retryAfter!)).toBeGreaterThanOrEqual(0);
      expect(Schema.decodeUnknownSync(HttpDate)(retryAfter!)).toBeDefined();
    }, 30_000);
  });

  it("treats RFC 7009's empty 200 as a response, not as malformed JSON", async () => {
    // The response carries `Content-Type: application/json` and zero bytes. The default
    // JSON codec rejects an empty payload, which is correct; `ResponseBody.none` is the
    // declaration that says so.
    const revoked = await call(revokeToken().setBody({ token: accessToken }), "revoked");
    expect(revoked.body).toBeUndefined();

    // And the token really is gone, through the endpoint with its own error format.
    const rejected = await call(getUserInfo(), "SimpleUnauthorized");
    expect(rejected.body.message).toContain("Invalid or expired");
    clearSession();
  });
});
