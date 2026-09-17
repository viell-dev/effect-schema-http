# Vendored llm2 library

`viell-effect-schema-http-0.1.0-alpha.2.tgz` was produced with `pnpm pack` from
`repo-llm2` at commit `45a8069` (branch `llm2`). The package includes its built JavaScript,
declarations, source, examples, and documentation. `client/package.json` installs this
archive as a `file:` dependency; no linked checkout or llm1 package participates.

To regenerate it from the same library revision:

```sh
cd ../../repo-llm2
pnpm pack --out ../repo-llm2-test1/vendor/viell-effect-schema-http-0.1.0-alpha.2.tgz
cd ../repo-llm2-test1
pnpm install
```

Packing rather than linking lets the consuming workspace resolve a single copy of
Effect and Platform for the library and application.
