import process from "node:process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const version = (name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
const directory = mkdtempSync(join(tmpdir(), "schema-http-consumer-"));
const run = (command, args, cwd = directory) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
};
try {
  run("pnpm", ["pack", "--out", join(directory, "library.tgz")], root);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: "packed-schema-http-consumer",
        private: true,
        type: "module",
        dependencies: {
          "viell-effect-schema-http": "file:./library.tgz",
          effect: version("effect"),
          "@effect/platform": version("@effect/platform"),
          typescript: version("typescript"),
        },
      },
      null,
      2,
    ),
  );
  // Preserve the tested dependency graph rather than re-resolving cached registry metadata.
  const locked = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      '@effect/platform':
        specifier: ${version("@effect/platform")}
        version: ${version("@effect/platform")}(effect@${version("effect")})
      effect:
        specifier: ${version("effect")}
        version: ${version("effect")}
      typescript:
        specifier: ${version("typescript")}
        version: ${version("typescript")}
${locked.slice(locked.indexOf("\npackages:"))}`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          strict: true,
          skipLibCheck: false,
          declaration: true,
          outDir: "dist",
        },
        include: ["check.ts"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(directory, "check.ts"),
    `
import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Effect, Schema } from "effect";
import * as Body from "viell-effect-schema-http/Body";
import * as Request from "viell-effect-schema-http/Request";
import * as Response from "viell-effect-schema-http/Response";
import * as Operation from "viell-effect-schema-http/Operation";
import * as Policy from "viell-effect-schema-http/Policy";
import * as Url from "viell-effect-schema-http/Url";
import * as Interaction from "viell-effect-schema-http/Interaction";
import * as Transport from "viell-effect-schema-http/Transport";
import * as Library from "viell-effect-schema-http";

export const operation = Operation.make(
  Request.post("https://example.test").pipe(Request.body(Body.jsonSchema(Schema.Struct({ value: Schema.NumberFromString })))),
  Response.status(200, Body.jsonSchema(Schema.Struct({ value: Schema.NumberFromString }))),
  { policy: Policy.none },
);
// @ts-expect-error Body readiness is enforced through the required argument.
operation.execute({});
export const program = operation.execute({ body: { value: 42 } });
const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new globalThis.Response('{"value":"42"}'))));
const result = await Effect.runPromise(program.pipe(Effect.provideService(HttpClient.HttpClient, client)));
if (result.value !== 42 || Url.defaults.path("/") !== "%2F" || Library.Body !== Body || Library.Transport !== Transport) throw new Error("Package smoke test failed");
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const interaction = yield* Interaction.make((input: string) => Effect.succeed(input));
  if ((yield* interaction.run("ok")) !== "ok") throw new Error("Interaction smoke test failed");
})));
console.log("Packed consumer: exports, declaration emit, peer identity, and execution passed.");
`,
  );
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"]);
  run("pnpm", ["exec", "tsc"]);
  run(process.execPath, ["dist/check.js"]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
