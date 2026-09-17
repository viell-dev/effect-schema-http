import { HttpBody } from "@effect/platform";
import { Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "../src/main.js";

/** A finite fixed-width protocol: three digits, a colon, and a label. */
export const Record = Schema.transform(
  Schema.String.pipe(Schema.pattern(/^\d{3}:[^\r\n]+$/)),
  Schema.Struct({ code: Schema.Int.pipe(Schema.between(0, 999)), label: Schema.NonEmptyString }),
  {
    strict: true,
    decode: (value) => ({ code: Number(value.slice(0, 3)), label: value.slice(4) }),
    encode: ({ code, label }) => `${String(code).padStart(3, "0")}:${label}`,
  },
);

const wire = Body.make({
  encode: (value: string) => Effect.succeed(HttpBody.text(value, "application/x-fixed-record")),
  decode: (response) => response.text,
  mediaType: "application/x-fixed-record",
});

export const exchange = Operation.make(
  Request.post("https://legacy.example.test/records").pipe(Request.body(Body.encodeSchema(Record)(wire))),
  Response.when(
    ({ status, headers }) => status === 200 && headers["content-type"]?.split(";")[0] === wire.mediaType,
    wire.pipe(Body.schema(Record)),
  ),
);
