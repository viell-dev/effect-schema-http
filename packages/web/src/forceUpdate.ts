/**
 * Opt in to overwriting a concurrent edit, for one retry of one request.
 *
 * `PUT /api/posts/:slug` carries an `x-expected-revision` field with the `updatedAt` the editor
 * loaded (see `packages/server/src/routes.ts`). If someone else saved in the meantime the write is
 * refused with a `ConflictError`, and the only thing that can decide what happens next is the
 * person looking at the screen. This is the transform that expresses their answer.
 *
 * It is two coordinated setters, which is what makes it worth naming: adding the override *and*
 * dropping the now-meaningless expected revision. The server ignores the revision once force is
 * set, but sending a value the caller has knowingly abandoned would be a lie about what the
 * request means — and a future server that logged "checked against X, forced anyway" would record
 * a revision the client never actually reconciled against.
 *
 * The shape this enables is the real point: the plan is built once, held, and executed again with
 * this transform applied if the person says so. Nothing is rebuilt and nothing is re-encoded by
 * hand — plans are cold and re-executable, so "replay that exact request with one more header" is
 * one `.pipe()` rather than a second copy of the call site.
 */
import type { RequestPlanTransform } from "viell-effect-schema-http";

export const forceUpdate: RequestPlanTransform = (plan) =>
  plan.setHeader("x-force-update", "true").removeHeader("x-expected-revision");
