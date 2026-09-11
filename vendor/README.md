# Vendored tarball

`viell-effect-schema-http-0.1.0-beta.1.tgz` was produced by `pnpm pack` against commit
`8fa4ac5ee18e0febd24a0abd8f780e84c10934b6` of `repo-llm1` (`../../repo-llm1` relative to this directory), following the
"Trying the beta" instructions in that project's README. It is installed by the `client`
package as a `file:` dependency pointing at this tarball, matching the library's
documented beta-distribution flow (no registry package exists yet).

That commit includes the documentation changes this project's evaluation produced: a
request body codec owning the content type, discriminating a response body from a service
that transmits no discriminant, `mapClient` as the seam for values derived from the
encoded request, repeated header field lines being provider-dependent in both directions,
and redirect/cookie behaviour belonging to the provider.
