import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { encodeFields } from "./encodeFields.js";

describe("schema field inheritance", () => {
  it("preserves repeated defaults and suppresses overridden computations", async () => {
    let reads = 0;
    const encoded = await Effect.runPromise(
      encodeFields(
        Schema.Struct({ tags: Schema.Array(Schema.String), page: Schema.NumberFromString }),
        { page: 3 },
        [
          ["tags", "a"],
          ["tags", "b"],
          [
            "page",
            () => {
              reads++;
              return "wrong domain type";
            },
          ],
        ],
        "urlParams",
      ),
    );
    expect(encoded).toEqual({ tags: ["a", "b"], page: "3" });
    expect(reads).toBe(0);
  });

  it("re-evaluates inherited computed values for each evaluation", async () => {
    let reads = 0;
    const encoding = encodeFields(
      Schema.Struct({ token: Schema.String }),
      undefined,
      [["token", () => String(++reads)]],
      "headers",
    );
    expect(reads).toBe(0);
    expect(await Effect.runPromise(encoding)).toEqual({ token: "1" });
    expect(await Effect.runPromise(encoding)).toEqual({ token: "2" });
  });
  it("preserves non-record schema inputs and suppresses incompatible inherited defaults", async () => {
    let reads = 0;
    const defaults = [
      [
        "unused",
        () => {
          reads++;
          return "secret";
        },
      ],
    ] as const;
    const pairs = [
      ["x-test", "one"],
      ["x-test", "two"],
    ] as const;
    const entries = Schema.Array(Schema.Tuple(Schema.String, Schema.String));
    expect(await Effect.runPromise(encodeFields(entries, pairs, defaults, "headers"))).toEqual(pairs);
    const optional = Schema.transform(Schema.Struct({}), Schema.Undefined, {
      decode: () => undefined,
      encode: () => ({}),
    });
    expect(await Effect.runPromise(encodeFields(optional, undefined, defaults, "headers", true))).toEqual({});
    const date = new Date("2026-09-12T00:00:00Z");
    const dated = Schema.transform(Schema.Struct({ day: Schema.String }), Schema.DateFromSelf, {
      decode: ({ day }) => new Date(day),
      encode: (value) => ({ day: value.toISOString() }),
    });
    expect(await Effect.runPromise(encodeFields(dated, date, defaults, "headers"))).toEqual({
      day: date.toISOString(),
    });
    expect(reads).toBe(0);
  });
});
