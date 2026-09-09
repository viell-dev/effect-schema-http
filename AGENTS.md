# Repository instructions

- Keep unit tests beside implementation files under `src/`.
- Keep server-backed integration tests under the sibling `tests/` directory.
- Preserve the lazy Effect API: building or modifying a request plan must not execute it.
- Update `docs/design.md` when public types or semantics change.
- Before committing, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`.
