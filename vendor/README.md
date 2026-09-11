# Vendored tarball

`viell-effect-schema-http-0.1.0-beta.1.tgz` was produced by `pnpm pack` against commit
`8fa4ac5ee18e0febd24a0abd8f780e84c10934b6` of the library (`../../repo-llm1` relative to this workspace), following the
"Trying the beta" instructions in that project's README. It is installed by the `web`
package as a `file:` dependency pointing at this tarball, matching the library's
documented beta-distribution flow (no registry package exists yet).

## Why a tarball and not `link:`

This workspace briefly used `"viell-effect-schema-http": "link:../../../repo-llm1"`, which
is convenient while iterating on both at once and produces 24 `TS2883` errors in this
package:

```
The inferred type of 'getBlogFeed' cannot be named without a reference to
'HttpClientResponse' from 'viell-effect-schema-http/node_modules/.pnpm/@effect+platform@…'.
This is likely not portable. A type annotation is necessary.
```

A linked directory brings its own `node_modules`, so the library resolves its own copy of
`@effect/platform` while this package resolves another. The two copies declare structurally
identical but nominally distinct types, and every endpoint whose inferred type mentions one
— which is every endpoint using a non-default codec — becomes unnameable. A packed tarball
installs against this workspace's own peer copies and the problem disappears.
