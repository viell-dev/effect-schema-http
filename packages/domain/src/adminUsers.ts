/**
 * The admin user directory: a name/email-filterable list, purpose-built to be the "datatable with
 * a filter form" the `repo` library's `makeRequestGate` is documented for — every keystroke in
 * the filter form is a genuinely distinct request, which is exactly the shape that needs a gate's
 * interruption behavior instead of its caching behavior. See `packages/web/src/usersGate.ts`.
 *
 * Unlike `Profile`, this view includes `email` — a real account owner would not want their email
 * broadcast on their public blog page, so this list only exists behind `requireAdmin`.
 */
import { Schema } from "effect";
import { AdminRole, Bio, DisplayName, Email, Username } from "./primitives.js";
import { UserId } from "./ids.js";
import type { Account } from "./user.js";

export const AdminUserView = Schema.Struct({
  id: UserId,
  username: Username,
  displayName: DisplayName,
  email: Email,
  bio: Bio,
  role: AdminRole,
  createdAt: Schema.DateTimeUtc,
});
export type AdminUserView = typeof AdminUserView.Type;

export const adminUserViewOfAccount = (account: Account): AdminUserView => ({
  id: account.id,
  username: account.username,
  displayName: account.displayName,
  email: account.email,
  bio: account.bio,
  role: account.role,
  createdAt: account.createdAt,
});

export const AdminUsersResponse = Schema.Struct({
  users: Schema.Array(AdminUserView),
});
export type AdminUsersResponse = typeof AdminUsersResponse.Type;
