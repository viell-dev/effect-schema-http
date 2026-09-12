import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Cause, Deferred, Effect, Either, Exit, Fiber, Ref } from "effect";
import { describe, expect, it } from "vitest";
import type { UploadCheckpoint } from "./attachmentSchemas.js";
import { createAttachmentWorkflow } from "./createAttachmentWorkflow.js";

const documentId = "123e4567-e89b-42d3-a456-426614174000";
const workflow = createAttachmentWorkflow("https://example.test");
const input = {
  document: { title: "Report" },
  attachments: [
    { name: "first", bytes: new Uint8Array([1]) },
    { name: "second", bytes: new Uint8Array([2]) },
  ],
};

describe("attachment workflow recipe", () => {
  it("creates lazily and completes an operation with no attachments", async () => {
    const progress = await Effect.runPromise(Ref.make<UploadCheckpoint | undefined>(undefined));
    let sends = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        sends++;
        return HttpClientResponse.fromWeb(request, Response.json({ id: documentId }, { status: 201 }));
      }),
    );
    const operation = workflow.create({ document: input.document, attachments: [] }, progress);
    expect(sends).toBe(0);
    const result = await Effect.runPromise(operation.pipe(Effect.provideService(HttpClient.HttpClient, client)));
    expect(result).toEqual({ documentId, uploaded: [] });
    expect(await Effect.runPromise(Ref.get(progress))).toEqual({ documentId, completed: [], pending: [] });
    expect(sends).toBe(1);
  });

  it.each([
    { document: { title: "" }, attachments: [] },
    { document: input.document, attachments: [{ name: "bad", bytes: "not bytes" }] },
    { document: input.document, attachments: [input.attachments[0], input.attachments[0]] },
  ])("validates the entire operation before any request", async (invalid) => {
    const progress = await Effect.runPromise(Ref.make<UploadCheckpoint | undefined>(undefined));
    let sends = 0;
    const client = HttpClient.make(() => {
      sends++;
      return Effect.die("validation should prevent transport execution");
    });
    const result = await Effect.runPromise(
      workflow.create(invalid, progress).pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("ParseError");
    expect(sends).toBe(0);
  });

  it("does not upload or fabricate a checkpoint when creation fails", async () => {
    const progress = await Effect.runPromise(Ref.make<UploadCheckpoint | undefined>(undefined));
    let sends = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        sends++;
        expect(request.method).toBe("POST");
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 409 }));
      }),
    );
    const result = await Effect.runPromise(
      workflow.create(input, progress).pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("UnhandledResponse");
    expect(await Effect.runPromise(Ref.get(progress))).toBeUndefined();
    expect(sends).toBe(1);
  });

  it("preserves failure context and resumes only pending uploads without creating twice", async () => {
    const progress = await Effect.runPromise(Ref.make<UploadCheckpoint | undefined>(undefined));
    const sent: string[] = [];
    let fail = true;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        sent.push(`${request.method} ${request.url}`);
        return HttpClientResponse.fromWeb(
          request,
          request.method === "POST"
            ? Response.json({ id: documentId }, { status: 201 })
            : request.url.endsWith("/second") && fail
              ? new Response(null, { status: 503 })
              : new Response(null, { status: 204 }),
        );
      }),
    );
    const result = await Effect.runPromise(
      workflow.create(input, progress).pipe(Effect.either, Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe("AttachmentUploadFailed");
    if (Either.isRight(result) || result.left._tag !== "AttachmentUploadFailed")
      throw new Error("Expected upload failure");
    expect(result.left.cause._tag).toBe("UnhandledResponse");
    expect(result.left.checkpoint.completed).toEqual(["first"]);
    expect(result.left.checkpoint.pending.map(({ name }) => name)).toEqual(["second"]);
    expect(await Effect.runPromise(Ref.get(progress))).toBe(result.left.checkpoint);
    fail = false;
    const resumed = await Effect.runPromise(
      workflow.resume(result.left.checkpoint, progress).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
    expect(resumed).toEqual({ documentId, uploaded: ["first", "second"] });
    expect(sent.map((request) => request.split("/").at(-1))).toEqual(["documents", "first", "second", "second"]);
  });

  it("keeps interruption as interruption, awaits upload cleanup and leaves a recoverable checkpoint", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const progress = yield* Ref.make<UploadCheckpoint | undefined>(undefined);
        const started = yield* Deferred.make<void>();
        let finalized = false;
        const client = HttpClient.make((request) =>
          request.method === "POST"
            ? Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ id: documentId }, { status: 201 })))
            : Effect.acquireUseRelease(
                Deferred.succeed(started, undefined),
                () => Effect.never,
                () =>
                  Effect.sync(() => {
                    finalized = true;
                  }),
              ),
        );
        const fiber = yield* Effect.fork(
          workflow.create(input, progress).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        );
        yield* Deferred.await(started);
        const exit = yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
        expect(finalized).toBe(true);
        const checkpoint = yield* Ref.get(progress);
        expect(checkpoint?.documentId).toBe(documentId);
        expect(checkpoint?.completed).toEqual([]);
        expect(checkpoint?.pending.map(({ name }) => name)).toEqual(["first", "second"]);
      }),
    );
  });

  it("snapshots input bytes before creation and does not send changed form data", async () => {
    const bytes = new Uint8Array([7]);
    const progress = await Effect.runPromise(Ref.make<UploadCheckpoint | undefined>(undefined));
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.method === "POST") {
          bytes[0] = 99;
          return HttpClientResponse.fromWeb(request, Response.json({ id: documentId }, { status: 201 }));
        }
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag === "Uint8Array") expect([...request.body.body]).toEqual([7]);
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }),
    );
    await Effect.runPromise(
      workflow
        .create({ document: input.document, attachments: [{ name: "file", bytes }] }, progress)
        .pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
  });
});
