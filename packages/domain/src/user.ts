/**
 * User domain entities.
 *
 * `Account` is the full server-side record (never sent to a client as-is: it carries the
 * password hash). `Profile` is the public projection returned by the API. Both are ordinary
 * `Schema.Struct`s, which get free structural `Equivalence` and a decent default `Pretty` — we
 * only add custom annotations where the defaults would be wrong (timestamps, redaction).
 */
import { Schema } from "effect";
import { UserId } from "./ids.js";
import { AdminRole, Bio, DisplayName, Email, PasswordHash, Username } from "./primitives.js";

export class Account extends Schema.Class<Account>("Account")({
  id: UserId,
  username: Username,
  email: Email,
  displayName: DisplayName,
  bio: Bio,
  passwordHash: PasswordHash,
  role: AdminRole,
  createdAt: Schema.DateTimeUtc,
}) {}

export const Profile = Schema.Struct({
  id: UserId,
  username: Username,
  displayName: DisplayName,
  bio: Bio,
  createdAt: Schema.DateTimeUtc,
});
export type Profile = typeof Profile.Type;

export const profileOfAccount = (account: Account): Profile => ({
  id: account.id,
  username: account.username,
  displayName: account.displayName,
  bio: account.bio,
  createdAt: account.createdAt,
});

/**
 * Extends `Profile`'s own fields (`Schema.Struct` exposes `.fields`, so this is a real reuse of
 * the existing schema, not a hand-copied duplicate) with the one extra fact only the authenticated
 * user themselves is allowed to see about their own account: their role.
 */
export const CurrentUser = Schema.Struct({ ...Profile.fields, role: AdminRole });
export type CurrentUser = typeof CurrentUser.Type;

export const currentUserOfAccount = (account: Account): CurrentUser => ({
  ...profileOfAccount(account),
  role: account.role,
});
