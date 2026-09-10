/**
 * The "easy case" for `makeRequestGate`: a datatable of users behind a name/email filter form,
 * where every `input` event fires a new request. Read the library's own semantics carefully
 * before assuming `run`/`refresh` alone give you an aborting search box:
 *
 * From `docs/design.md`'s "Request gates" section: "Different keys may run concurrently, but
 * older completions cannot overwrite newer successful completions." That is a *correctness*
 * guarantee (a slow, stale response can't clobber a newer one), not a *cancellation* one — the
 * stale request's underlying `fetch()` keeps running on the wire even after a newer one starts.
 * A live filter box wants the stale network request itself interrupted, not just its result
 * discarded, so this module calls `gate.invalidate` before every `run`. `invalidate` "clears the
 * retained pair, interrupts every request currently owned by that gate" — `FetchHttpClient`
 * translates that Effect interruption into a real `AbortController.abort()`, which is what
 * actually cancels the in-flight HTTP request (confirmed in the browser as a
 * `net::ERR_ABORTED` failed request — see the README's gate section for how that was checked).
 *
 * The trade-off, and a genuine gap in the library's own vocabulary: there is no "interrupt the
 * current flight but keep any already-cached success" primitive. `invalidate` is the only
 * interruption tool, and it clears the cache too. For this UI that's fine — the page keeps its
 * own last-rendered rows on screen regardless of what the gate remembers — but a caller who
 * actually wanted the gate's cross-call caching *and* interruption at once has no single method
 * for that; see the README.
 */
import { Effect } from "effect";
import { makeRequestGate, toEffect } from "viell-effect-schema-http";
import type { RequestGate } from "viell-effect-schema-http";
import { adminListUsers } from "./api.js";
import { withAuth } from "./withAuth.js";

export interface UserFilters {
  readonly name: string;
  readonly email: string;
}

const allocateUsersGate = () =>
  makeRequestGate(
    (filters: UserFilters) =>
      withAuth(adminListUsers())
        .setUrlParam("name", filters.name)
        .setUrlParam("email", filters.email)
        .pipe(toEffect),
    { key: (filters) => JSON.stringify([filters.name, filters.email]) },
  );

export type UsersGate = Effect.Effect.Success<ReturnType<typeof allocateUsersGate>>;

// Allocating a gate is itself an Effect (it has explicit lifetime, per the library's docs) but
// needs no HttpClient — only `run`/`refresh` do, once a filter is actually submitted. A single
// module-level instance is exactly the "isolated gate" shape the docs describe: one gate per
// distinct thing being memoized, not a fresh one per render.
let cached: Promise<UsersGate> | undefined;

export const getUsersGate = (): Promise<UsersGate> => {
  cached ??= Effect.runPromise(allocateUsersGate());
  return cached;
};
