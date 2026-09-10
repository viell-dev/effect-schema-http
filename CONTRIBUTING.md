# Contributing

Issues and pull requests are welcome on [Codeberg](https://codeberg.org/viell/effect-schema-http).

## Development setup

Use Node.js 22.13+ or 24 and the pnpm version declared in `package.json`. The development tools have a higher minimum
than the library's declared Node.js 20 runtime baseline. CI currently uses Node.js 24.

```sh
pnpm install --frozen-lockfile
```

## Verification

Run the complete local check before committing:

```sh
pnpm check
```

This runs the unit and integration tests, TypeScript type checking, linting, formatting verification, and the production
build. Integration tests bind disposable servers to ephemeral loopback ports and do not call external services.

Use the narrower commands while iterating:

```sh
pnpm test:unit
pnpm test:integration
pnpm test:watch
pnpm format
```

Before preparing a Codeberg beta revision, verify the packed file set and package metadata:

```sh
pnpm pack:check
```

For testing in another project, run `pnpm pack` and install the resulting local tarball there. This runs the production
build through `prepack`; source archives alone do not contain `dist/`. Keep the source commit with each local build.
The repository is marked `private` until registry publication is explicitly planned. No release tag or registry
publication is required for this evaluation stage. Track remaining release work in [docs/report.md](docs/report.md).

## Project conventions

- Keep unit and type-focused tests beside implementation files under `src/`.
- Keep server-backed integration tests under `tests/`.
- Preserve request-plan laziness: construction and setters must not execute a request.
- Update `docs/design.md` whenever public types or semantics change.
- Add TSDoc to exported APIs and their public members.
- Include tests for runtime behavior and type inference when a change affects both.

New behavior should remain HTTP-style agnostic. Do not assume that methods, status classes, paths, bodies, or response
formats follow REST conventions.

## Licence

By contributing, you agree that your contributions are licensed under the repository's [MIT licence](LICENSE).
