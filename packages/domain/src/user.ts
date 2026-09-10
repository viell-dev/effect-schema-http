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
import { Bio, DisplayName, Email, PasswordHash, Username } from "./primitives.js";

export class Account extends Schema.Class<Account>("Account")({
  id: UserId,
  username: Username,
  email: Email,
  displayName: DisplayName,
  bio: Bio,
  passwordHash: PasswordHash,
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
