/**
 * `AuthResponse` (returned by both `register` and `login`) deliberately carries only a token and
 * the public `Profile` — nothing about the account's role. Learning the role means a second,
 * authenticated call to `GET /api/user`, which is exactly what a real "who am I, including
 * privileged fields only I can see" endpoint looks like: broad login response, narrower
 * follow-up for anything sensitive.
 */
import { Match } from "effect";
import { toEffect } from "viell-effect-schema-http";
import type { AuthResponse } from "@realworld/domain";
import { currentUser } from "./api.js";
import { run } from "./runtime.js";
import { setSession } from "./session.js";

export const establishSession = async (auth: AuthResponse): Promise<void> => {
  // The one place that sets `authorization` by hand. Every other call inherits it from the API's
  // computed default, which reads the stored session — and the session is not stored yet: that is
  // what this call is gathering the last field for. A call-site setter replaces the computed
  // default for this plan, so the brand-new token is used without touching global state first.
  const result = await run(currentUser().setHeader("authorization", `Bearer ${auth.token}`).pipe(toEffect)).catch(
    () => undefined,
  );
  const role = result
    ? Match.value(result).pipe(
        Match.tag("ok", ({ body }) => body.role),
        Match.orElse(() => "member" as const),
      )
    : ("member" as const);
  setSession({ token: auth.token, profile: auth.profile, role });
};
