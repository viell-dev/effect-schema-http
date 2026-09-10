/** Client-side mirror of the server's `decodeBody` (see `packages/server/src/decode.ts`): the
 * same schema validates form input before it is ever sent, using the same `ArrayFormatter`
 * issue-list shape the server's `ValidationError.issues` carries. A `RequestPlan.setBody` call
 * only accepts an already-decoded, branded value, so this step cannot be skipped by accident. */
import { ParseResult, Schema } from "effect";

export interface DecodeSuccess<A> {
  readonly _tag: "success";
  readonly value: A;
}

export interface DecodeFailure {
  readonly _tag: "failure";
  readonly issues: ReadonlyArray<string>;
}

export const decodeForm = <A, I>(schema: Schema.Schema<A, I>, value: unknown): DecodeSuccess<A> | DecodeFailure => {
  const result = Schema.decodeUnknownEither(schema)(value);
  if (result._tag === "Right") return { _tag: "success", value: result.right };
  return {
    _tag: "failure",
    issues: ParseResult.ArrayFormatter.formatErrorSync(result.left).map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
};
