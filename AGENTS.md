# Repository instructions

- Keep unit tests beside implementation files under `src/`.
- Keep server-backed integration tests under the sibling `tests/` directory.
- Preserve the lazy Effect API: building or modifying a request plan must not execute it.
- Update `docs/design.md` when public types or semantics change.
- Commit completed task changes after the required checks pass unless the user explicitly asks otherwise.
- Before committing, run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build`.
- Group source by category; use deeper nesting where useful and no `index.ts` barrels. `src/main.ts` is the public export
  surface. Named entry files may sit beside category directories when useful; directory/file pairing is optional.
- Synchronize the workspace's numbered reference after changes to exports, architecture or behavior; run its example verifier.
- Preserve consumer-owned Effect composition, optional schema validation and automatic interaction-gate supersession.
