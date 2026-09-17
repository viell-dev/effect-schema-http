import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Deferred, Effect, Either, Fiber, Schedule } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Body, Operation, Policy, Request, Response } from "../main.js";

describe("finite response ownership", () => {
  it("awaits decoding and scoped cleanup before classifying or retrying a failed decoder", async () => {
    const finalizing = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const events: Array<string> = [];
    let attempts = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts++;
        events.push(`send:${attempts}`);
        return HttpClientResponse.fromWeb(
          request,
          new globalThis.Response("body", { status: attempts === 1 ? 503 : 200 }),
        );
      }),
    );
    const decoder = Body.decoder((response) =>
      Effect.gen(function* () {
        const status = response.status;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            events.push(`cleanup:${status}`);
            if (status === 503) {
              yield* Deferred.succeed(finalizing, undefined);
              yield* Deferred.await(release);
            }
            events.push(`released:${status}`);
          }),
        );
        yield* response.text;
        events.push(`decoded:${status}`);
        return status === 503 ? yield* Effect.fail("invalid intermediate payload") : "ok";
      }),
    );
    const operation = Operation.make(
      Request.get("https://example.test"),
      Response.when(() => true, decoder),
      {
        policy: Policy.make(Schedule.recurs(1), {
          while: (reason) => {
            events.push(`classify:${reason.metadata?.status}`);
            return Policy.transient(reason);
          },
        }),
      },
    );
    const effect = operation.execute(undefined);
    // Decoder scopes belong to each attempt; they are not required from the caller.
    expectTypeOf<Effect.Effect.Context<typeof effect>>().toEqualTypeOf<HttpClient.HttpClient>();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(effect);
        yield* Deferred.await(finalizing);
        expect(events).toEqual(["send:1", "decoded:503", "cleanup:503"]);
        expect(attempts).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(fiber)).toBe("ok");
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(events).toEqual([
      "send:1",
      "decoded:503",
      "cleanup:503",
      "released:503",
      "classify:503",
      "send:2",
      "decoded:200",
      "cleanup:200",
      "released:200",
      "classify:200",
    ]);
  });

  it("drains an unmatched body before retrying and exposes only metadata on final failure", async () => {
    const events: Array<string> = [];
    let attempts = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        const attempt = ++attempts;
        events.push(`send:${attempt}`);
        let sent = false;
        const stream = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode("unmatched"));
              } else {
                events.push(`drained:${attempt}`);
                controller.close();
              }
            },
          },
          { highWaterMark: 0 },
        );
        return HttpClientResponse.fromWeb(request, new globalThis.Response(stream, { status: 503 }));
      }),
    );
    const result = await Effect.runPromise(
      Operation.make(Request.get("https://example.test"), Response.status(200, Body.text), {
        policy: Policy.make(Schedule.recurs(1)),
      })
        .execute(undefined)
        .pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(events).toEqual(["send:1", "drained:1", "send:2", "drained:2"]);
    expect(Either.isLeft(result) && result.left._tag).toBe("UnexpectedStatus");
    if (Either.isLeft(result)) expect("response" in result.left).toBe(false);
  });
});
