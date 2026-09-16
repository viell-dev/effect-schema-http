import { Cookies, Headers, HttpClient, HttpClientResponse } from "@effect/platform";
import { Clock, Effect, Fiber, Schedule, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import * as Body from "./Body.js";
import * as Operation from "./Operation.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const metadata = (status: number, retryAfter?: string): Response.Metadata => ({
  status,
  headers: Headers.fromInput(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
  cookies: Cookies.empty,
});

describe("attempt policies", () => {
  it("uses Platform's transient statuses and permits explicit policy replacement", () => {
    for (const status of [408, 429, 500, 502, 503, 504])
      expect(Policy.transient({ _tag: "Response", metadata: metadata(status) })).toBe(true);
    for (const status of [200, 404, 501, 505, 600])
      expect(Policy.transient({ _tag: "Response", metadata: metadata(status) })).toBe(false);
    const custom = Policy.make(Schedule.recurs(1), { while: ({ metadata: info }) => info?.status === 409 });
    expect(custom.while({ _tag: "Response", metadata: metadata(409) })).toBe(true);
  });

  it("interprets Retry-After dates and seconds without accepting nonfinite delays", () => {
    expect(Policy.retryAfterTime(metadata(429, "3"), 1000)).toBe(4000);
    expect(Policy.retryAfterTime(metadata(429, "Thu, 01 Jan 1970 00:00:05 GMT"), 1000)).toBe(5000);
    expect(Policy.retryAfterTime(metadata(429, "Thu, 01 Jan 1970 00:00:00 GMT"), 1000)).toBe(1000);
    expect(Policy.retryAfterTime(metadata(429, "invalid"), 1000)).toBe(1000);
    expect(Policy.retryAfterTime(metadata(429, "9".repeat(400)), 1000)).toBe(1000);
  });

  it("releases the attempt before sleeping and treats Retry-After as a minimum", async () => {
    let calls = 0;
    const signals: Array<AbortSignal> = [];
    const client = HttpClient.make((request, _url, signal) =>
      Effect.sync(() => {
        signals.push(signal);
        return HttpClientResponse.fromWeb(
          request,
          new globalThis.Response("ok", { status: ++calls === 1 ? 429 : 200, headers: { "retry-after": "5" } }),
        );
      }),
    );
    const operation = Operation.make(
      Request.get("https://example.test"),
      Response.when(() => true, Body.text),
      {
        policy: Policy.make(Schedule.spaced("2 seconds").pipe(Schedule.intersect(Schedule.recurs(1)))),
      },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(operation.execute(undefined));
        yield* TestClock.adjust("2 seconds");
        expect(calls).toBe(1);
        expect(signals[0]?.aborted).toBe(true);
        yield* TestClock.adjust("3 seconds");
        expect(yield* Fiber.join(fiber)).toBe("ok");
        expect(calls).toBe(2);
        expect(yield* Clock.currentTimeMillis).toBe(5000);
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.provide(TestContext.TestContext)),
    );
  });
});
