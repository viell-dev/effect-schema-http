import { Effect, Schema } from "effect";
import { ForbiddenError, SessionToken, UnauthorizedError, type UserId } from "@realworld/domain";
import { Store } from "./store.js";

const parseAuthHeader = (headerValue: string | undefined): SessionToken | undefined => {
  if (!headerValue) return undefined;
  const match = /^Bearer (.+)$/.exec(headerValue);
  if (!match) return undefined;
  const token = match[1];
  return token && Schema.is(SessionToken)(token) ? (token as SessionToken) : undefined;
};

/** Resolves the caller's `UserId` if an `Authorization: Bearer <token>` header is present and
 * valid; succeeds with `undefined` for anonymous requests instead of failing. Used by routes
 * (like posting a comment) where authentication is optional. */
export const optionalSession = (headerValue: string | undefined): Effect.Effect<UserId | undefined, never, Store> =>
  Effect.gen(function* () {
    const token = parseAuthHeader(headerValue);
    if (!token) return undefined;
    const store = yield* Store;
    return yield* store.resolveSession(token);
  });

/** Same as `optionalSession` but fails with `UnauthorizedError` when there is no valid session. */
export const requireSession = (headerValue: string | undefined): Effect.Effect<UserId, UnauthorizedError, Store> =>
  optionalSession(headerValue).pipe(
    Effect.flatMap((userId) =>
      userId ? Effect.succeed(userId) : Effect.fail(new UnauthorizedError({ message: "a valid session token is required" })),
    ),
  );

/** Requires a session belonging to an admin account: `UnauthorizedError` with no/invalid
 * session, `ForbiddenError` for a real but non-admin session. */
export const requireAdmin = (
  headerValue: string | undefined,
): Effect.Effect<UserId, UnauthorizedError | ForbiddenError, Store> =>
  Effect.gen(function* () {
    const userId = yield* requireSession(headerValue);
    const store = yield* Store;
    const account = yield* store.getAccount(userId).pipe(
      Effect.catchTag("NotFoundError", () =>
        Effect.fail(new UnauthorizedError({ message: "a valid session token is required" })),
      ),
    );
    if (account.role !== "admin") {
      return yield* Effect.fail(new ForbiddenError({ message: "this action requires an admin account" }));
    }
    return userId;
  });
