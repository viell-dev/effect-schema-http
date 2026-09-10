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
