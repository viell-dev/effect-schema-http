import { Effect } from "effect";
import { makeRequestGate, toEffect } from "viell-effect-schema-http";
import { adminListUsers } from "./api.js";

export interface UserFilters {
  readonly name: string;
  readonly email: string;
}

export const usersFilterKey = (filters: UserFilters): string => JSON.stringify([filters.name, filters.email]);

/** Allocate once per mounted directory interaction. Each new filter interrupts superseded work. */
export const makeUsersGate = () =>
  makeRequestGate(
    (filters: UserFilters) =>
      adminListUsers()
        .setUrlParams({
          ...(filters.name === "" ? {} : { name: filters.name }),
          ...(filters.email === "" ? {} : { email: filters.email }),
        })
        .pipe(toEffect),
    { key: usersFilterKey },
  );

export type UsersGate = Effect.Effect.Success<ReturnType<typeof makeUsersGate>>;
