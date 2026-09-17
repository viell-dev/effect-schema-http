import { FetchHttpClient } from "@effect/platform";
import { Effect } from "effect";
import { Policy } from "viell-effect-schema-http";
import { DateTime, Schedule, Schema } from "effect";
import { h } from "../dom.js";
import { forceFresh, withNonce, withScopeLines } from "../plans/transforms.js";
import { run } from "../runtime.js";
import { EdgeCacheStatus, TokenProbeHeaders } from "../schemas/idLegacy.js";
import {
  directoryEntry,
  discovery,
  formLogin,
  getJwks,
  getUserInfo,
  probeToken,
  purgeJwksCache,
  register,
  requestToken,
  resetSessionEcho,
  revokeToken,
  scopedToken,
  sessionEcho,
} from "../services/idClient.js";
import { clearSession, getSession, setSession } from "../session.js";
import { actionPanel, field, show, type Action } from "./panel.js";

/** Every call in this view goes to the Rust identity server on :4100. */
export const renderAuthView = (): HTMLElement => {
  const suggested = `web_${Date.now().toString(36)}`;
  const username = field("username", getSession()?.username ?? suggested);
  const password = field("password", "web_password_123");

  const credentials = () => ({ username: username.input.value, password: password.input.value });

  const actions: ReadonlyArray<Action> = [
    {
      label: "Register",
      note: "201 with the whole user, unlike /token which answers with neither a user nor a 201.",
      run: async () => {
        const { username: name, password: secret } = credentials();
        const result = await run(
          register().execute({ body: { username: name, email: `${name}@example.invalid`, password: secret } }),
        );
        return result._tag === "created"
          ? `created ${result.value.username} (${result.value.id})`
          : `${result._tag}: ${show(result.value)}`;
      },
    },
    {
      label: "Log in (JSON)",
      note: 'The 2019 grant. token_type is "bearer" here, lower case, from one of three code paths.',
      run: async () => {
        const { username: name, password: secret } = credentials();
        const result = await run(
          requestToken().execute({ body: { grant_type: "password", username: name, password: secret } }),
        );
        if (result._tag !== "ok") return `${result._tag}: ${show(result.value)}`;
        setSession({
          accessToken: result.value.access_token,
          refreshToken: result.value.refresh_token,
          tokenType: result.value.token_type,
          username: name,
        });
        return `signed in\ntoken_type decoded as ${result.value.token_type}\naccess token ${result.value.access_token}`;
      },
    },
    {
      label: "Log in (form-encoded)",
      note: "The RFC 6749 grant this service had first. HttpBody.urlParams, and every value a string.",
      run: async () => {
        const { username: name, password: secret } = credentials();
        const result = await run(
          formLogin().execute({ body: { grant_type: "password", username: name, password: secret } }),
        );
        if (result._tag !== "ok") return `${result._tag}: ${show(result.value)}`;
        setSession({
          accessToken: result.value.access_token,
          refreshToken: "",
          tokenType: result.value.token_type,
          username: name,
        });
        return `signed in\ntoken_type on the wire was BEARER, decoded as ${result.value.token_type}\nexpires_in arrived as a string, decoded as ${result.value.expires_in}\nscope ${result.value.scope.join(", ")}`;
      },
    },
    {
      label: "Probe the token (HEAD)",
      note: "A bodyless response whose facts are all in headers, decoded with an ordinary schema.",
      run: async () => {
        const result = await run(probeToken().execute(undefined));
        if (result._tag !== "valid") return "the token is not valid";
        const facts = Schema.decodeUnknownSync(TokenProbeHeaders)(result.metadata.headers);
        const lines = Object.entries(result.metadata.headers).filter(
          ([name]) => name.toLowerCase() === "x-token-scope",
        );
        return `${show(facts)}\n\nThe server wrote ${facts["x-token-scope"].length} separate X-Token-Scope lines; Fetch delivered ${lines.length}.`;
      },
    },
    {
      label: "Read the profile",
      note: "The endpoint with its own error format, which is why it declares exact-status rules.",
      run: async () => {
        const result = await run(getUserInfo().execute(undefined));
        return result._tag === "ok" ? show(result.value) : `${result._tag}: ${show(result.value)}`;
      },
    },
    {
      label: "Look up in the directory",
      note: "Query-parameter authentication, SCREAMING field names, LDAP time, and no 404s ever.",
      run: async () => {
        const result = await run(directoryEntry().execute({ path: { username: credentials().username } }));
        if (result._tag !== "ok") return `${result._tag}: ${show(result.value)}`;
        const created = result.value.createdAt === null ? "none" : DateTime.formatIso(result.value.createdAt);
        return `${show({ ...result.value, createdAt: created })}\n\nA missing user is a 200 with ACTIVE: "N", because operations asked for no 404s in the log.`;
      },
    },
    {
      label: "Fetch the key set",
      note: "Behind a proxy that ignores Cache-Control. Watch X-Cache across three calls.",
      run: async () => {
        await run(purgeJwksCache().execute(undefined));
        const first = await run(getJwks().execute(undefined));
        const second = await run(getJwks().execute(undefined));
        const bypassed = await run(
          getJwks({ request: forceFresh })
            .execute(undefined)
            .pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: "reload" })),
        );
        const status = (headers: Record<string, string | undefined>) =>
          Schema.decodeUnknownSync(EdgeCacheStatus)(headers);
        return [
          `after a purge:      ${status(first.metadata.headers)["x-cache"]}`,
          `immediately again:  ${status(second.metadata.headers)["x-cache"]}  (Cache-Control alone changes nothing)`,
          `with forceFresh:    ${status(bypassed.metadata.headers)["x-cache"]}  (a computed cache-busting parameter)`,
        ].join("\n");
      },
    },
    {
      label: "Narrow the scopes",
      note: "Needs repeated X-Scope header lines, which Fetch joins. Expect a rejection here.",
      run: async () => {
        const result = await run(
          scopedToken({ request: (request) => request.pipe(withScopeLines(["openid", "projects:read"])) }).execute(
            undefined,
          ),
        );
        return result._tag === "ok"
          ? `narrowed to ${result.value.scope.join(", ")}`
          : `rejected: ${result.value.error_description}\n\nThe plan retained two entries; the Fetch provider combined them. A node:http provider that reads Transport.headerLines preserves them — see repeatedHeaderClient.ts.`;
      },
    },
    {
      label: "Correlate with a nonce (built-in retry)",
      note: "The 503 is retried automatically; the nonce cannot change, so the replay check refuses it.",
      run: async () => {
        await run(resetSessionEcho().execute(undefined));
        const result = await run(
          sessionEcho({ request: withNonce(Date.now()), policy: Policy.make(Schedule.recurs(3)) }).execute({
            body: { message: "built-in retry" },
          }),
        );
        return result._tag === "ok"
          ? `unexpectedly succeeded on attempt ${result.value.attempt}`
          : `${result._tag}: ${show(result.value)}\n\nRequest encoding runs once per evaluation, so all attempts carried the same X-Nonce.`;
      },
    },
    {
      label: "Correlate with a nonce (own loop)",
      note: "A loop over cold Effects, with a new nonce and no automatic retries.",
      run: async () => {
        await run(resetSessionEcho().execute(undefined));
        const trail: Array<string> = [];
        let nonce = Date.now();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const result = await run(
            sessionEcho({ request: (request) => request.pipe(withNonce(nonce)) }).execute({
              body: { message: "own loop" },
            }),
          );
          trail.push(`nonce ${nonce} -> ${result._tag}`);
          if (result._tag === "ok") return `${trail.join("\n")}\n\nsucceeded on attempt ${result.value.attempt}`;
          nonce += 1;
        }
        return trail.join("\n");
      },
    },
    {
      label: "Read the discovery document",
      note: "grant_types_supported is a space-delimited string where the spec requires an array.",
      run: async () => {
        const result = await run(discovery().execute(undefined));
        return result._tag === "ok" ? show(result.value) : show(result.value);
      },
    },
    {
      label: "Revoke and sign out",
      note: "RFC 7009: 200, a JSON content type, and zero bytes. Body.empty is the declaration.",
      run: async () => {
        const session = getSession();
        if (session === undefined) return "not signed in";
        const revoked = await run(revokeToken().execute({ body: { token: session.accessToken } }));
        const after = await run(getUserInfo().execute(undefined));
        clearSession();
        return `${revoked._tag} (${revoked.metadata.status}), and the profile now answers ${after._tag}`;
      },
    },
  ];

  return h(
    "div",
    {},
    h("div", { class: "fields" }, username.row, password.row),
    actionPanel(
      "Rust identity server, :4100",
      "Opaque access tokens, JWT refresh tokens, three spellings of “bearer”, two error formats, and a directory gateway that answers 200 to everything.",
      actions,
    ),
  );
};
