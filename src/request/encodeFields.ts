import { Effect, Schema } from "effect";
import { RequestFieldsEncodeError } from "../errors/RequestFieldsEncodeError.js";

/** Schema ownership covers the complete collection, including inherited defaults. Overrides suppress computed defaults. */
export const encodeFields = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: unknown,
  defaults: ReadonlyArray<readonly [string, unknown]>,
  field: "headers" | "urlParams",
  hasInput = input !== undefined,
) =>
  Effect.suspend(() => {
    const encode = (value: unknown) =>
      Schema.encodeUnknown(schema)(value).pipe(
        Effect.mapError((cause) => new RequestFieldsEncodeError({ field, cause })),
      );
    const supplied = hasInput ? input : {};
    const isRecord =
      typeof supplied === "object" &&
      supplied !== null &&
      (Object.getPrototypeOf(supplied) === Object.prototype || Object.getPrototypeOf(supplied) === null);
    // Arrays, class instances, scalars and explicit undefined are complete domain values, not mergeable field maps.
    if (!isRecord) return encode(supplied);
    const overridden = new Set(typeof supplied === "object" && supplied !== null ? Object.keys(supplied) : []);
    const grouped = new Map<string, unknown[]>();
    for (const [key, declaration] of defaults) {
      if (overridden.has(key)) continue;
      const resolved: unknown = typeof declaration === "function" ? declaration() : declaration;
      if (resolved === undefined) continue;
      const values = grouped.get(key) ?? [];
      values.push(resolved);
      grouped.set(key, values);
    }
    const inherited = Object.fromEntries(
      Array.from(grouped, ([key, values]) => [key, values.length === 1 ? values[0] : values]),
    );
    const value = typeof supplied === "object" && supplied !== null ? { ...inherited, ...supplied } : supplied;
    return encode(value);
  });
