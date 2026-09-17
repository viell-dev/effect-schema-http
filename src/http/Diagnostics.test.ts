import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, HashMap, Logger, LogLevel, Schedule } from "effect";
import { describe, expect, it } from "vitest";
import { Body, Operation, Policy, Request, Response } from "../main.js";

describe("native Effect diagnostics", () => {
  it("respects log levels, records attempts, and leaves request data out of messages", async () => {
    const records: Array<{ message: unknown; annotations: Record<string, unknown>; level: string }> = [];
    const logger = Logger.make(({ message, annotations, logLevel }) => {
      records.push({ message, annotations: Object.fromEntries(HashMap.toEntries(annotations)), level: logLevel._tag });
    });
    let attempts = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          new globalThis.Response("private-response", { status: ++attempts % 2 === 1 ? 503 : 200 }),
        ),
      ),
    );
    const operation = Operation.make(
      Request.post("https://example.test/private-path?token=private-query").pipe(
        Request.setHeader("authorization", "private-credential"),
        Request.body(Body.text),
      ),
      Response.when(() => true, Body.text),
      { policy: Policy.make(Schedule.recurs(1)) },
    );
    const program = operation
      .execute({ body: "private-body" })
      .pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      );
    expect(records).toEqual([]);
    await Effect.runPromise(program.pipe(Logger.withMinimumLogLevel(LogLevel.Info)));
    expect(records).toEqual([]);
    await Effect.runPromise(program.pipe(Logger.withMinimumLogLevel(LogLevel.Debug)));
    expect(records.every((entry) => entry.level === "Debug")).toBe(true);
    expect(records.map((entry) => entry.message)).toEqual([
      ["HTTP attempt started"],
      ["HTTP attempt completed"],
      ["HTTP retrying"],
      ["HTTP attempt started"],
      ["HTTP attempt completed"],
      ["HTTP operation completed"],
    ]);
    expect(records[1].annotations).toMatchObject({ "http.method": "POST", "http.attempt": 1, "http.status": 503 });
    expect(records[4].annotations).toMatchObject({ "http.attempt": 2, "http.status": 200 });
    expect(JSON.stringify(records)).not.toMatch(/private-|example\.test/);
  });

  it("reports a preparation failure without logging schema input or transport work", async () => {
    const records: Array<unknown> = [];
    const logger = Logger.make(({ message, annotations }) => records.push([message, Object.fromEntries(annotations)]));
    const operation = Operation.make(
      Request.post("/private").pipe(
        Request.body(Body.encoder((_input: string) => Effect.fail("private-encoding-error"))),
      ),
      Response.status(200, Body.text),
    );
    await Effect.runPromise(
      operation.execute({ body: "private-body" }).pipe(
        Effect.either,
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected dispatch")),
        ),
        Logger.withMinimumLogLevel(LogLevel.Debug),
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      ),
    );
    expect(records).toEqual([[["HTTP operation completed"], { "http.outcome": "failure" }]]);
  });
});
