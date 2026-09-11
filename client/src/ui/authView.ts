import { DateTime, Schema } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { forceFresh, withNonce, withScopeLines } from "../plans/transforms.js";
import { EdgeCacheStatus, TokenProbeHeaders } from "../schemas/idLegacy.js";
import { run } from "../runtime.js";
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
          register().setBody({ username: name, email: `${name}@example.invalid`, password: secret }).pipe(toEffect),
        );
        return result._tag === "created"
          ? `created ${result.body.username} (${result.body.id})`
          : `${result._tag}: ${show(result.body)}`;
      },
    },
    {
      label: "Log in (JSON)",
      note: 'The 2019 grant. token_type is "bearer" here, lower case, from one of three code paths.',
      run: async () => {
        const { username: name, password: secret } = credentials();
        const result = await run(
          requestToken().setBody({ grant_type: "password", username: name, password: secret }).pipe(toEffect),
        );
        if (result._tag !== "ok") return `${result._tag}: ${show(result.body)}`;
        setSession({
          accessToken: result.body.access_token,
          refreshToken: result.body.refresh_token,
          tokenType: result.body.token_type,
          username: name,
        });
        return `signed in\ntoken_type decoded as ${result.body.token_type}\naccess token ${result.body.access_token}`;
      },
    },
    {
      label: "Log in (form-encoded)",
      note: "The RFC 6749 grant this service had first. RequestBody.urlParams, and every value a string.",
      run: async () => {
        const { username: name, password: secret } = credentials();
        const result = await run(
          formLogin().setBody({ grant_type: "password", username: name, password: secret }).pipe(toEffect),
        );
        if (result._tag !== "ok") return `${result._tag}: ${show(result.body)}`;
        setSession({
          accessToken: result.body.access_token,
          refreshToken: "",
          tokenType: result.body.token_type,
          username: name,
        });
        return `signed in\ntoken_type on the wire was BEARER, decoded as ${result.body.token_type}\nexpires_in arrived as a string, decoded as ${result.body.expires_in}\nscope ${result.body.scope.join(", ")}`;
      },
    },
    {
      label: "Probe the token (HEAD)",
      note: "A bodyless response whose facts are all in headers, decoded with an ordinary schema.",
      run: async () => {
        const result = await run(probeToken().pipe(toEffect));
        if (result._tag !== "valid") return "the token is not valid";
        const facts = Schema.decodeUnknownSync(TokenProbeHeaders)(result.headers);
        const lines = result.headerEntries.filter(([name]) => name.toLowerCase() === "x-token-scope");
        return `${show(facts)}\n\nThe server wrote ${facts["x-token-scope"].length} separate X-Token-Scope lines; Fetch delivered ${lines.length}.`;
      },
    },
    {
      label: "Read the profile",
      note: "The endpoint with its own error format, which is why it declares exact-status rules.",
      run: async () => {
        const result = await run(getUserInfo().pipe(toEffect));
        return result._tag === "ok" ? show(result.body) : `${result._tag}: ${show(result.body)}`;
      },
    },
    {
      label: "Look up in the directory",
      note: "Query-parameter authentication, SCREAMING field names, LDAP time, and no 404s ever.",
      run: async () => {
        const result = await run(directoryEntry({ username: credentials().username }).pipe(toEffect));
        if (result._tag !== "ok") return `${result._tag}: ${show(result.body)}`;
        const created = result.body.createdAt === null ? "none" : DateTime.formatIso(result.body.createdAt);
        return `${show({ ...result.body, createdAt: created })}\n\nA missing user is a 200 with ACTIVE: "N", because operations asked for no 404s in the log.`;
      },
    },
    {
      label: "Fetch the key set",
      note: "Behind a proxy that ignores Cache-Control. Watch X-Cache across three calls.",
      run: async () => {
        await run(purgeJwksCache().pipe(toEffect));
        const first = await run(getJwks().pipe(toEffect));
        const second = await run(getJwks().pipe(toEffect));
        const bypassed = await run(getJwks().pipe(forceFresh, toEffect));
        const status = (headers: Record<string, string | undefined>) =>
          Schema.decodeUnknownSync(EdgeCacheStatus)(headers);
        return [
          `after a purge:      ${status(first.headers)["x-cache"]}`,
          `immediately again:  ${status(second.headers)["x-cache"]}  (setCache alone changes nothing)`,
          `with forceFresh:    ${status(bypassed.headers)["x-cache"]}  (a computed cache-busting parameter)`,
        ].join("\n");
      },
    },
    {
      label: "Narrow the scopes",
      note: "Needs repeated X-Scope header lines, which Fetch joins. Expect a rejection here.",
      run: async () => {
        const result = await run(scopedToken().pipe(withScopeLines(["openid", "projects:read"]), toEffect));
        return result._tag === "ok"
          ? `narrowed to ${result.body.scope.join(", ")}`
          : `rejected: ${result.body.error_description}\n\nThe plan retained two entries; the Fetch provider combined them. A node:http provider that reads getHeaderEntries preserves them — see repeatedHeaderClient.ts.`;
      },
    },
    {
      label: "Correlate with a nonce (built-in retry)",
      note: "The 503 is retried automatically; the nonce cannot change, so the replay check refuses it.",
      run: async () => {
        await run(resetSessionEcho().pipe(toEffect));
        const result = await run(
          sessionEcho().setBody({ message: "built-in retry" }).pipe(withNonce(Date.now()), toEffect).pipe(),
        );
        return result._tag === "ok"
          ? `unexpectedly succeeded on attempt ${result.body.attempt}`
          : `${result._tag}: ${show(result.body)}\n\nRequest encoding runs once per evaluation, so all attempts carried the same X-Nonce.`;
      },
    },
    {
      label: "Correlate with a nonce (own loop)",
      note: "setRetries(0) and a loop over the cold plan, with a new nonce each time.",
      run: async () => {
        await run(resetSessionEcho().pipe(toEffect));
        const trail: Array<string> = [];
        let nonce = Date.now();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const result = await run(
            sessionEcho().setBody({ message: "own loop" }).pipe(withNonce(nonce), toEffect),
          );
          trail.push(`nonce ${nonce} -> ${result._tag}`);
          if (result._tag === "ok") return `${trail.join("\n")}\n\nsucceeded on attempt ${result.body.attempt}`;
          nonce += 1;
        }
        return trail.join("\n");
      },
    },
    {
      label: "Read the discovery document",
      note: "grant_types_supported is a space-delimited string where the spec requires an array.",
      run: async () => {
        const result = await run(discovery().pipe(toEffect));
        return result._tag === "ok" ? show(result.body) : show(result.body);
      },
    },
    {
      label: "Revoke and sign out",
      note: "RFC 7009: 200, a JSON content type, and zero bytes. ResponseBody.none is the declaration.",
      run: async () => {
        const session = getSession();
        if (session === undefined) return "not signed in";
        const revoked = await run(revokeToken().setBody({ token: session.accessToken }).pipe(toEffect));
        const after = await run(getUserInfo().pipe(toEffect));
        clearSession();
        return `${revoked._tag} (${revoked.status}), and the profile now answers ${after._tag}`;
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
