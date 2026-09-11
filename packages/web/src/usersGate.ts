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
 * discarded, so this module's consumer calls `gate.cancel` before every `run`. `cancel`
 * "interrupts every request currently owned by that gate" while keeping the retained success —
 * `FetchHttpClient` translates that Effect interruption into a real `AbortController.abort()`,
 * which is what actually cancels the in-flight HTTP request (confirmed in the browser as a
 * `net::ERR_ABORTED` failed request — see the README's gate section for how that was checked).
 *
 * `cancel` is the half of that vocabulary this page wants: `invalidate` would do the same
 * interruption but also drop the retained rows, which are still the best answer available until
 * the newer request returns. Keeping them means backspacing to a filter the gate already
 * answered — `ali` → `alic` → `ali` — resolves from the cache without touching the network at
 * all, which is the gate's headline reuse behaviour finally doing something in a search box.
 */
import { Effect } from "effect";
import { makeRequestGate, toEffect } from "viell-effect-schema-http";
import { adminListUsers } from "./api.js";
import { withAuth } from "./withAuth.js";

export interface UserFilters {
  readonly name: string;
  readonly email: string;
}

/**
 * The gate's key function, exported so the UI can ask "is this the filter the gate is currently
 * holding rows for?" without inventing a second, drifting definition of filter equality.
 */
export const usersFilterKey = (filters: UserFilters): string => JSON.stringify([filters.name, filters.email]);

const allocateUsersGate = () =>
  makeRequestGate(
    (filters: UserFilters) =>
      adminListUsers().setUrlParam("name", filters.name).setUrlParam("email", filters.email).pipe(withAuth, toEffect),
    { key: usersFilterKey },
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
