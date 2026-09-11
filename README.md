# multi-service-schema-http

Five backend services, written in five languages over what their comments claim is
twelve years, and one TypeScript client that has to talk to all of them at once — built
to push [`viell-effect-schema-http`](../repo-llm1) and
[Effect Schema](https://effect.website/docs/schema/introduction/) against the thing a
schema-driven HTTP client is hardest to be good at: **an API you did not design, written
by people who are not available, in a format that was reasonable at the time.**

This is the sibling of [`test-llm1`](../test-llm1), and it is deliberately its opposite.
That project put one package of Effect Schemas between a Node server and a browser
client, so a value read from an endpoint was *already* the value another endpoint
accepted and alignment was free. Here nothing is shared. The services are Rust, Python,
Java, Perl and Ruby; none of them has heard of Effect, four of them predate it, and every
one of them defines its own shape for facts the others also hold. Moving a value from one
to another is real work, and where that work should live is the question this project
exists to answer.

The second thing it tests is breadth. `test-llm1`'s conclusion was that the library's
failure mode under a badly-behaved API is *more configuration, not workarounds*. That was
measured against one backend that could have been rewritten. This one measures it against
XML-RPC, SOAP 1.1 and 1.2, WebDAV, OData v2, JSONP, fixed-width mainframe records in
ISO-8859-1, a CSV written for a German copy of Excel, HMAC request signing, and a status
code that was never registered — none of which the library has ever heard of either.

This is a local, no-remote git repository. `git log` is the real record; the last third of
this document is a candid writeup of what worked, what did not, and what had to change in
the library.

---

## Architecture

```
services/
  id-server/     Rust (Axum)            :4100  OAuth2-ish identity, "built in 2019 by the security team"
  file-server/   Python (stdlib)        :4200  SOAP/XML document store, "ported from a .NET WCF service in 2016"
  api-server/    Java (JDK HttpServer)  :4300  The business API, "started in 2014, Java 8 originally"
  report-server/ Perl (raw sockets)     :4400  The reporting gateway, "1999, and nobody dares touch it"
  notify-server/ Ruby (WEBrick)         :4500  Notifications, "the 2011 bolt-on"

client/          TypeScript + Effect + Vite    One client for all five
  src/schemas/     one module per service, plus common.ts for what they accidentally share
  src/services/    the endpoint declarations
  src/plans/       reusable RequestPlanTransforms, including HMAC signing
  src/integration/ the translation layer, the saga, and the gates
  src/ui/          a browser client that drives every endpoint in here
  tests/           127 tests across nine files

vendor/          the packed viell-effect-schema-http-0.1.0-beta.1 tarball
```

Roughly 5,800 lines of client TypeScript, 2,000 of tests, and 4,800 across the five
services. The language of each service was chosen by asking what was installed and then
picking whatever fit the persona: the point is that the client cannot tell, and should not
be able to.

### Who calls whom

- **Client → all five.** Each has its own idea of a credential and the client holds three
  of them at once.
- **Java → Rust.** The business API validates every `Authorization: Token <opaque>` by
  calling the identity server's `/introspect`.
- **Python → Rust.** The SOAP service does the same for its `Bearer` tokens.
- **Java → Python.** The file proxy translates JSON into SOAP envelopes so the mobile app
  never has to.
- **Perl → nobody.** The reporting gateway reads a nightly dump and has no connection to
  anything live, which is why finance and engineering never agree on a number.

### Three credentials, five services

| Service | Credential | How it travels |
| --- | --- | --- |
| Rust identity | opaque access token | `Authorization: Bearer` |
| Python files | the same token | `Authorization: Bearer` |
| Java business API | the same token | `Authorization: Token` — this API predates RFC 6750 |
| Rust directory | the same token | `?access_token=` in the query string, per a 2012 draft |
| Perl reports | its own session id | `?session=` in the query string, obtained by a GET with the password in the URL |
| Ruby notifications | a CSRF token plus an HMAC signature | `X-CSRF-Token` and `X-Signature` |

One API-wide **computed** header per service handles the first four. The other two cannot
be declared at all, for reasons that turned out to be the most interesting finding in the
project — see [Signing a request](#signing-a-request-the-one-thing-a-computed-header-cannot-do).

---

## Why the services are like this

Every oddity below is deliberate, and every one of them exists in a production system
right now. The interesting column is the last one.

### Rust identity server (:4100)

| The oddity | A tidy API would have | What the client needed |
| --- | --- | --- |
| Three spellings of "bearer" from three code paths | One | One `transformOrFail` that fails on a fourth scheme rather than guessing |
| Opaque access tokens, JWT refresh tokens | One strategy | Nothing; the client never looks inside either |
| OAuth error shape on `/token`, `{message}` on `/userinfo` | One envelope | Exact-status rules, which outrank the API-wide status predicate |
| `429` with an HTTP-date `Retry-After` | Delay-seconds | Nothing — the library honours both forms unaided |
| `expires_in` as a string on the form grant | A number | `Schema.NumberFromString` |
| RFC 7009 revocation: `200`, a JSON content type, zero bytes | `204` | `ResponseBody.none` with `Schema.Void` |
| A `HEAD` probe whose facts are all in headers | A `GET` with a body | A schema applied to `envelope.headers` |
| A key set behind a proxy that ignores `Cache-Control` | Honour request directives | `setCache` **and** a computed cache-busting parameter, as one transform |
| Query-parameter authentication on the directory | A header | A computed query parameter, plus `removeHeaders` so no credential travels twice |
| `SCREAMING` attribute names, `Y`/`N`, LDAP time, blanks for absent | JSON conventions | A wire schema and a transform into the domain shape |
| A missing user is `200` with `ACTIVE: "N"` | `404` | Nulls in the domain type and a boolean nobody can ignore |
| Scopes as repeated `X-Scope` request lines | One comma-joined value | A `node:http` provider; Fetch cannot send them at all |
| A nonce that must strictly increase | Idempotency keys | `setRetries(0)` and a loop — **the one real trade**, see below |
| `grant_types_supported` as a space-delimited string | An array | The same combinator that reads `scope` |
| A rate limiter that keys on `X-Forwarded-For` and trusts it | Key on the connection | Nothing, but it is worth knowing who can choose their own bucket |

### Python SOAP service (:4200)

| The oddity | A tidy API would have | What the client needed |
| --- | --- | --- |
| Outcome inside a `200`, in `<FaultCode>` | Real statuses | A `soapResult` combinator producing a tagged union |
| `SOAPAction` required, and required to be quoted | Anything | One declared header per action |
| Single-element lists wrapped in an extra `<Result>` | Consistent arrays | Read every `<File>` wherever it sits |
| `MM/dd/yyyy HH:mm:ss` with no timezone | ISO 8601 | A transform that refuses anything looser |
| `?wsdl` accepted only as a bare key, never `?wsdl=` | Either | Nothing — the library distinguishes `true` from `""` |
| SOAP 1.2 carries the action in the content type | One protocol | Change the **codec**, not the header: the codec owns the content type |
| One action answers a real `soap:Fault` with `500` | Consistency | One more rule |
| ISO-8859-1 documents under a bare `text/xml` | A charset | `ResponseBody.uint8Array`, and read the encoding out of the document |
| `PROPFIND` and `207 Multi-Status` | The same, honestly | Nothing; methods are strings and statuses are numbers |
| A multipart bundle of metadata and bytes | Two requests | `ResponseBody.formData` and an *effectful* schema transform |
| A raw byte upload with the name in the query string | A multipart form | `RequestBody.uint8Array` with `Schema.Uint8ArrayFromSelf` |

### Java business API (:4300)

| The oddity | A tidy API would have | What the client needed |
| --- | --- | --- |
| `Authorization: Token`, not `Bearer` | RFC 6750 | One computed header |
| Epoch-millisecond timestamps | ISO 8601 | One transform, shared with the Ruby service |
| `4xx` is `{error:{code,message}}`, `5xx` is `{error:string}` | One envelope | Two rules |
| `PATCH` answers with the state **before** the write | The new state | Re-read, and never trust the response |
| A status name in, an ordinal out | One representation | One transform, used in both directions |
| Comments answer `200` with a relative `Location` | `201` and an absolute URI | Resolve it against the base URL |
| Search unwraps a single-element array | Always an array | A union normalized to an array |
| 64-bit ids above 2^53 | String ids | `ResponseBody.text` and a JSON dialect that quotes long integers |
| An OData v2 `{"d":{"results":…}}` envelope with a stringified count | The array | One transform, and no view ever sees it |
| `/Date(…)/`, `0000-00-00`, `-1` for unlimited, `"$1,234.50"` | Real types | One transform each, all reversible |
| Four spellings of "no value" in one object | One | Collapsed into `Option` at the boundary |
| Positional report rows behind `text/json` | Records | A transform that **checks** the column header rather than trusting it |
| A batch endpoint whose envelope is always `200` | Real statuses | Discrimination in the schema, because the envelope cannot |
| `202` with a relative `Location`, then polling | The same, honestly | A loop over a cold plan — not a retry |
| Errors signalled by `X-Error-Code` on a `200` | A status | A header-matched rule, which ranks above the plain one |
| 1-based `page`, 0-based `Link` offsets | One base | The arithmetic, in one schema |
| A gateway that strips `PUT` and `DELETE` | Let them through | A transform that rewrites the method and sets an override header |
| A `204` that still tries to write a debug body | No body | Nothing — see [what the types found](#what-typed-decoding-found-that-nobody-was-looking-for) |

### Perl reporting gateway (:4400)

| The oddity | A tidy API would have | What the client needed |
| --- | --- | --- |
| Credentials in a query string, over `GET` | A `POST` | Nothing the client can fix; the password is in every log |
| XML-RPC, faults inside `200`s | JSON and statuses | A text codec and an `rpcResult` combinator |
| `<dateTime.iso8601>` with no separators and no timezone | ISO 8601 | One transform |
| Fixed-width Latin-1 records with **no delimiters at all** | Anything | `ResponseBody.uint8Array`, positional parsing, and a checked control total |
| A CSV with a UTF-8 BOM, CRLF, semicolons and a decimal comma | RFC 4180 | Strip the BOM before it becomes part of a column name |
| Every failure is a `200` | Statuses | A header-matched rule, or a union in the schema |
| Duplicate query parameters silently collapse | Repeat or reject | Nothing; worth knowing that the client did everything right |

### Ruby notification service (:4500)

| The oddity | A tidy API would have | What the client needed |
| --- | --- | --- |
| HMAC over the encoded body | A bearer token | `mapClient` with an effectful request transform — **a computed header cannot** |
| A double-submitted CSRF token | Nothing, for an API | Fetch it first, echo it in a header |
| A `)]}',` guard before every JSON payload | JSON | A text codec; the JSON codec fails on the first byte |
| JSONP for a partner that predates CORS | CORS | Match the exact wrapper and refuse anything else |
| JSON served as `text/html` | The right type | A header matcher that says so, and a text codec |
| `420 Enhance Your Calm` | `429` | `retry.while`, which is exactly what it is for |
| A long poll that holds the connection open | The same, honestly | `setTimeout`, and a `TimeoutException` rather than a response |
| An absolutized `Location`, where Java sends a relative one | Agreement | Resolve either; the **container** decides, not the code |
| Three different headers announcing its own retirement | One | Read all three; no two services pick the same one |

That last row is worth dwelling on. `Deprecation`, `Sunset` and `Warning` all say the same
thing on the same response, because each was added by a different person reading a
different draft — `Deprecation` from an RFC that never shipped, `Sunset` from RFC 8594
which did, and `Warning` from RFC 7234, which RFC 9111 later removed. Nothing about this
is a client problem, and it is exactly the sort of thing a client has to cope with anyway.

---

## The translation layer

This is the part `test-llm1` could not test at all, because it had nothing to translate.

`client/src/integration/translate.ts` is where a value read from one service becomes a
value another service accepts. The rule the project settled on is: **a translation is a
`Schema.transform` between two services' own type schemas, not a mapping function.** Three
things follow from that, and none follow from a function:

1. **It runs backwards.** The transform that produces a Java task draft from a 1999
   extract record also produces the extract record from the draft. A round trip is the
   only real evidence that a mapping is not quietly lossy, and a plain function cannot be
   tested for it.
2. **Drift is a compile error.** The target is the other service's own schema, so renaming
   a field on either side breaks the build here rather than producing a request the other
   service rejects at runtime.
3. **It composes with the codecs.** `decode` from one service's wire format, the
   transform, and `encode` into the other's are three steps of one pipeline, each a
   schema.

The extract-to-task mapping is the one worth reading. The two systems share exactly one
thing — the task status enum, because the extract *is* a nightly dump of the Java
service's own table — and nothing else:

- The extract's `id` (`T0000001`) is a different id space from the API server's
  (`1a0915522db-1`). Treating them as the same identifier is the single most tempting
  mistake available here and it would corrupt both systems silently, so the reference
  travels in the description where it is visibly a *reference*.
- The extract carries money and the API server has no money field at all. It becomes a
  priority band, which is lossy — so the exact figure goes into the description too, which
  is what makes the transform reversible.
- The extract's `active` flag has no counterpart, and is recovered from the status on the
  way back.

Where a translation genuinely cannot run backwards, it says so. `TaskToNotification`
produces a sentence for a human, and no arrangement of words recovers a task's id,
project, assignee or timestamps, so its `encode` fails with that as the message rather
than fabricating a plausible task. That is a real answer to "should this be a transform or
a function?": make it a transform, and be honest in the direction that does not work.

### The saga

`client/src/integration/saga.ts` runs the month-end reconciliation across all five
services, and it is the shape real integration work takes:

1. **Rust** — sign in, receive an opaque access token.
2. **Perl** — sign in *again*, separately, because the gateway has never heard of OAuth.
3. **Perl** — read the nightly fixed-width extract: Latin-1, no delimiters, a trailer
   whose control total the schema checks rather than trusts.
4. **Translate** each record into a task draft.
5. **Java** — create the tasks.
6. **Python** — store the *re-encoded* extract over SOAP. Re-encoding rather than keeping
   the original bytes is deliberate: it makes the round trip part of the flow, so a lossy
   schema would produce a stored file that differs from the downloaded one.
7. **Java** — send the same bytes through the proxy, which turns JSON into SOAP again.
8. **Ruby** — announce it, signed and CSRF-guarded.
9. **Java** — confirm the write is visible through the service's own search.

with `Effect.onError` undoing the created tasks if anything after step 5 fails — including
on interruption, so a user navigating away mid-saga does not leave half an import behind.
There is no transaction spanning a Rust process, a Python process, a Java process, a Perl
process and a Ruby process, so the compensation is written out by hand, and even the
rollback has to be tunnelled through `X-HTTP-Method-Override` because the gateway strips
`DELETE`.

The library's contribution to all of this is that every step hands back a typed, decoded
value and every failure is either a declared response or a typed Effect failure. The
sequencing, the error channel and the compensation are ordinary Effect.

---

## Running it

Requires Node.js 22+, pnpm 10, and — this being the point — a Rust toolchain, Python 3.12+,
a Java 21 JDK, Perl 5, and Ruby 3.

```sh
pnpm install
./scripts/start-all.sh
```

That starts all five services and the Vite dev server:

```
ID Server (Rust):     http://localhost:4100
File Server (Python): http://localhost:4200
API Server (Java):    http://localhost:4300
Report GW (Perl):     http://localhost:4400
Notify (Ruby):        http://localhost:4500
Web client (Vite):    http://localhost:5173
```

The browser client has one tab per service plus a reconciliation screen and the full quirk
inventory. Every button is a real call: the views are table-driven — a label, a sentence
saying which quirk it exercises, and the call itself — so the interesting part of each view
is the request rather than the markup.

```sh
cd client && pnpm test        # 127 tests, nine files
cd client && pnpm typecheck   # and this passes, which is load-bearing — see below
```

Tests skip themselves cleanly when the services they need are not listening, so
`pnpm test` is useful with nothing running (the schema unit tests, 23 of them, need no
backend at all).

---

## Effect Schema, put to work

Everything in `client/src/schemas/` and `client/src/integration/`. The client never
hand-parses a payload outside a schema.

- **Branded primitives with custom annotations.** `OpaqueAccessToken` is a branded
  pattern-checked string with a `pretty` annotation that redacts it, so a decoded value
  can be logged without leaking a credential. `Scope` is branded and *filtered* to reject
  a comma, which is the exact property the identity server's `/token/scoped` endpoint
  depends on. `Cents` is a branded integer, because money is never a float here and the
  compiler enforces it.
- **`transformOrFail` that refuses rather than guesses.** `UsDateFromString` rejects
  anything that is not exactly `MM/dd/yyyy HH:mm:ss`, because `Date.parse` accepts half
  the formats in the world and would shift the value by the reader's own offset.
  `BearerTokenType` fails on a fourth authentication scheme instead of normalizing an
  unknown one into `Bearer` and attaching a credential the server never agreed to.
  `YesNo` refuses `"y"` and `"1"`, because guessing is how a disabled account becomes an
  enabled one.
- **A decode that validates rather than reshapes.** `FixedWidthExtract` checks the tape
  trailer's record count and control total against the detail records it just read, and
  fails the decode if they disagree — so a truncated download is a parse error rather than
  half a month of imported data. `GridReport` checks the report's column header and fails
  if a column moved, rather than putting a priority into a title.
- **Combinators, because the same bad idea recurs.** `soapResult(schema)` and
  `rpcResult(schema)` are the same idea from two different decades: both turn "the
  transport said 200 but the body says it failed" into a tagged union member. `XssiGuarded`,
  `Jsonp` and `JsonText` each strip a wrapper and hand the payload to a real schema.
  `SpaceDelimited`, `YesNo`, `BlankAsNull`, `EpochMillis` and `HttpDate` live in
  `common.ts` because more than one service invented them independently.
- **An *effectful* schema transform.** `FileBundle` reads a `multipart/form-data`
  response, and getting a part's bytes out of a `FormData` is asynchronous. Effect Schema
  transforms can return an Effect, so the awaiting lives inside the schema and the
  endpoint still yields one finished value.
- **`Schema.compose` to stack a parser under a schema.** `losslessJsonOf(schema)` composes
  a JSON parser that quotes 16-digit integers *before* `JSON.parse` sees them with the real
  schema on top. This is the only way to read the Java service's 64-bit order ids: by the
  time the platform parser has finished, `9007199254740993` has already become
  `…992` and two distinct orders are indistinguishable.
- **`Schema.attachPropertySignature` for discriminants the wire does not carry.** See
  below; this is the single biggest difference from the sibling project.
- **`Schema.transform` between two services' type schemas** — the translation layer.
- **Bidirectional everywhere it can be.** `ExcelCsv`, `FixedWidthExtract`,
  `LdapGeneralizedTime`, `UsdFromDisplay`, `AspNetDate`, `MysqlNullableDate` and the
  translations all encode as well as decode, and the tests assert round trips. The saga
  actually depends on it: it stores an extract it re-encoded from what it decoded.

### `Schema.TaggedError` is the wrong tool here, and that is the headline difference

`test-llm1`'s report calls reusing the exact `Schema.TaggedError` class on both sides "the
headline feature" and says it "worked without a single hiccup". That is true, and it is
true *because one codebase owned both ends*. The server encoded an instance, so the `_tag`
was on the wire, so the client could decode the same class.

None of the five services here has heard of Effect. Their error payloads are
`{"error":…,"error_description":…}` and `{"message":…}` and `{"error":{"code":…}}`, with no
discriminant anywhere and no prospect of one. A `Schema.TaggedError` used as a response
schema therefore **fails to decode**: it requires a field that is not there. The first pass
of this project shipped exactly that mistake in all three of its services and never noticed,
because no test ever exercised an error path.

The right tool is `Schema.attachPropertySignature`:

```ts
export const taggedBody = <const Tag extends string, Fields extends Schema.Struct.Fields>(tag: Tag, fields: Fields) =>
  Schema.Struct(fields).pipe(Schema.attachPropertySignature("_tag", tag));
```

The encoded side stays exactly what the service sends; the decoded value gains a
discriminant the *client* chose. `Match.tag` then works over bodies as well as envelopes,
and encoding strips the tag again so a value can be sent back to a service that would not
recognize it. It is now documented in the library's README, because the distinction
between "a rule's tag, which is always the client's" and "a body's tag, which has to come
from somewhere" is not obvious until it bites.

---

## Request gates across two services

`client/src/integration/gates.ts` puts a gate over a filter box that has to ask the Java
search endpoint *and* the Perl gateway, translate the Perl side into task drafts, and show
both together. The library's motivating example is a filter-as-you-type table over one
endpoint; this is the same idea where the "endpoint" is two services and a translation.

The important thing the docs say plainly, and which is easy to get wrong: retention is a
**correctness** guarantee, not a cancellation one. `run` does not abort the previous
flight — it only stops an older completion overwriting a newer one. A live filter box
wants the stale request to stop on the wire too, which is what `cancel` is for, and
`cancel` keeps the retained success so correcting a typo back to a term that already
resolved costs no request at all. `invalidate` would throw that away, which is right after
a mutation and wrong here.

Putting both services behind one key is the right granularity for this screen: it is one
thing, and a half-refreshed screen is worse than a slower one. Where two halves genuinely
refresh independently, the library's own design notes record that whole-gate cancellation
is a deliberate simplification and one gate per key is the answer. That matched what this
page needed; it is recorded as a judgement call, not a defect.

---

## What worked well

- **Rules discriminate the envelope; schemas discriminate the body — and five services
  force both, repeatedly.** This is the library's central design claim and the one this
  project can speak to with the most confidence, because the split was forced in both
  directions many times over. The Perl gateway's `X-Error-Code` on a `200`, the Java
  lookup proxy's identical trick, and the SOAP service's two media types from one action
  are all cases where the *envelope* distinguishes the outcomes and a rule handles it
  before a byte of the body is read. The SOAP `<FaultCode>`, the XML-RPC `<fault>`, the
  batch endpoint's per-item statuses and the single-hit search are all cases where the
  envelope says nothing and the *schema* has to. Getting this backwards is the
  first-contact mistake, and having both kinds a dozen times each makes the rule easy to
  internalize: **if the fact is knowable before the body is read, it is a rule.**
- **The non-JSON codecs carried formats the library has never heard of, with no special
  support.** XML-RPC, SOAP 1.1 and 1.2, WebDAV multistatus, fixed-width ISO-8859-1 tape
  records, a BOM-prefixed semicolon CSV, JSONP, XSSI-guarded JSON, multipart in both
  directions, and raw bytes. Every one of them is `ResponseBody.text` or
  `.uint8Array` or `.formData` plus a schema. The README's claim that "a text codec
  followed by a `*FromString` schema can parse XML, YAML, a custom JSON dialect, or
  another textual protocol without special support from this library" is the single most
  load-bearing sentence in the documentation, and it held every time.
- **Reading bytes rather than text is the answer more often than it looks.** Three
  separate cases here need `ResponseBody.uint8Array` for reasons that have nothing to do
  with binary data: a Latin-1 XML document under a bare `text/xml`, a UTF-8 BOM that
  survives `Response.text()` as `U+FEFF` and silently poisons the first CSV column name,
  and fixed-length records with no delimiters. All three fail *invisibly* through a text
  codec — a replacement character, an empty column, an off-by-one field — which is the
  worst way for a decoder to fail. Taking the bytes and letting the schema decide is the
  general fix, and the library supports it with one word.
- **Arbitrary methods and statuses needed nothing at all.** `PROPFIND` with `207`, `420`,
  `412`, `428`, `202` — `RequestMethod` is a `string` and a status is a `number`, so none
  of it needed library support. A client that models HTTP as an enum of methods it has
  heard of cannot talk to a WebDAV service at all.
- **`mapEndpoint` is what makes a SOAP service tolerable.** Every SOAP action is the same
  `POST /` with a different `SOAPAction` header, body and response schema. Supplying a
  body and replacing a response schema both change a plan's type parameters, so
  `RequestPlanTransform` cannot describe them — `mapEndpoint` can, and `listFiles` ends up
  as a fully-configured, zero-argument endpoint derived from one shared declaration.
- **`RequestPlanTransform` earned its place four times over.** `forceFresh` (two setters
  that must travel together, or the refresh silently does nothing), `tunnelMethod` (a
  header and a method rewrite, likewise), `withScopeLines`, and `signed`. Each applies to
  endpoints whose bodies and response shapes have nothing in common, which is exactly what
  the type exists for.
- **Computed headers and query parameters made per-service credentials workable.** One
  computed `authorization` per service, read from live session state at send time, with
  `extendApi({ removeHeaders: ["authorization"] })` carrying the endpoints that must not
  send one. The fail-safe direction is right: a new endpoint is authenticated by
  construction, and the risk of a credential going somewhere it should not is confined to
  an explicit opt-out list. The directory endpoint uses the same mechanism for a query
  parameter, and a computed value returning `undefined` omits the parameter entirely
  rather than sending the string `"undefined"` — which is what the obvious template
  literal would have done.
- **`retry.while` is exactly the right shape.** `420 Enhance Your Calm` is unregistered
  and correctly absent from the built-in transient set; `while` adds it and cannot veto
  the built-in cases. The default is right and the escape hatch is right, which is a
  harder combination to get than it sounds.
- **`Retry-After` as an HTTP-date works unaided.** RFC 9110 allows both forms and this
  library accepts both. That is a small thing that a great many clients get wrong, and the
  identity server's limiter sends the date form precisely because a real devops team once
  copied it from an Apache example.
- **Cold, re-executable plans made two awkward flows ordinary.** Polling a `202` job and
  looping a nonce-bearing request with a fresh value each time are both "execute this plan
  again with something different", and both are ten lines of plain code rather than a
  second call site.
- **The compile-time guards are real.** A duplicate response tag is caught by the type
  system *and* by a synchronous throw; a body-bearing plan has no Effect in the type system
  until `setBody`; an empty path parameter throws while the plan is built. Each of these
  is a mistake that would otherwise surface as a wrong response silently decoded by
  whichever rule was declared first.
- **The escape hatch for repeated header lines exists and works.** `getHeaderEntries` plus
  a forty-line `node:http` provider sends `X-Scope: openid` and `X-Scope: projects:read`
  as two physical lines, which the identity server requires and Fetch cannot do. The
  library documents this precisely and the documentation is correct.
- **`UnhandledResponse` with `"retain"` is the right default in the right direction.**
  Draining by default is correct — an undrained body holds a connection open — and
  retaining is a deliberate diagnostic act with an explicit ownership transfer.

---

## Friction, findings, and one thing that cannot be done

Four findings from this project changed the library's documentation, and one process
finding changed how this repository is verified. None of them required a behaviour change:
in every case the library already did the right thing and had not said so.

### 1. A request body codec owns the content type — and nothing said so

_Resolved in the library._ Setting SOAP 1.2's
`application/soap+xml; action="…"` as a declared `content-type` header does nothing. Request
encoding runs *after* the declarative layer is materialized, and the codec sets its own
media type on the encoded request: `RequestBody.text()` sends `text/plain` over whatever was
declared, `RequestBody.urlParams` sends its own type, and `RequestBody.formData` removes the
header entirely so the transport can generate a boundary.

This is correct — the content type describes the encoding, and the codec is the encoding —
but it is invisible until a service dispatches on it, and the failure mode is a request
that is accepted and handled as the wrong thing. It cost a debugging session here. The
library's README now says it, and a server-backed test pins all three behaviours.

The fix at the call site is one setter: `.setRequestBodyCodec(RequestBody.text(type))`.

### 2. Signing a request: the one thing a computed header cannot do

_Resolved in the library._ The Ruby service signs `METHOD\nPATH\nTIMESTAMP\nBODY` with
HMAC-SHA256. Working out where that belongs is the most instructive thing in this project:

- **A computed header cannot.** It takes no arguments, so it cannot see the request, and it
  resolves while the request is being materialized — before the body schema has encoded
  anything. No amount of configuration changes that.
- **`mapRequest` cannot.** It runs after encoding and does see the built request, so it has
  the body. But it is synchronous, and `crypto.subtle.sign` is not, and there is no
  synchronous HMAC in a browser or in modern Node without shipping an implementation.
- **`mapClient` can.** It wraps the client, so it runs after encoding and it can be
  effectful.

The library already says "they run outside the Effect runtime, so they cannot fail, retry,
or be interrupted; use a request transform, `mapClient`, or a gate for anything effectful".
That sentence is correct and was not enough: every `mapClient` example in the documentation
changed *transport* behaviour (`withTracerPropagation`), never computed a header from the
encoded body, which is the most common reason a real application reaches for it. The README
now carries the worked example.

Two properties of `mapClient` turn out to matter here and are worth stating:

- **It resolves per attempt, not per evaluation.** A signature with a five-minute validity
  window has to be recomputed for a retry that waited. This is the only place in the
  repository where per-attempt resolution is *required* rather than merely convenient, and
  it is the exact inverse of the credential-must-not-change-mid-retry argument that makes
  computed headers resolve once.
- **Its position in the pipeline does not matter.** `plan.pipe(signed).setBody(x)` and
  `plan.setBody(x).pipe(signed)` produce the same request, because the transform sees the
  finished request regardless of where it was written. A test pins this, because the
  opposite would be a sharp edge.

### 3. A `_tag`-carrying schema cannot decode a payload from a service that never sends one

_Resolved in the library._ Covered in full under
[the headline difference](#schemataggederror-is-the-wrong-tool-here-and-that-is-the-headline-difference)
above. The short version: `Schema.TaggedError` and `Schema.TaggedClass` put `_tag` on the
*encoded* side. That is exactly right when both ends share the definition and impossible
otherwise. `Schema.attachPropertySignature` is the shape that works, and the README now
draws the distinction between a rule's tag and a body's tag.

### 4. Repeated header field lines are provider-dependent in *both* directions

_Resolved in the library._ The README documented this for requests. It is equally true for
responses: the identity server's probe endpoint writes four separate `X-Token-Scope` lines
and Fetch delivers one comma-joined entry, so `envelope.headerEntries` cannot tell that
service apart from one that sent a single joined value. `Set-Cookie` is the exception,
because Effect Platform parses it separately into `envelope.cookies`.

And in a browser there is no escape hatch at all: `Headers` combines entries before `fetch`
is called. An API that depends on repeated field lines is a Node-only API, whatever client
is used. That is now written down, because "use a provider that preserves it" reads like
advice a browser application could follow.

### 5. A request that must genuinely differ per attempt still cannot use the retry policy

**This remains the one real trade, and this project makes it sharper than its predecessor
did.** `test-llm1` found a server that *echoed* an attempt counter, so the built-in retry
merely made the echo uninformative. Here the identity server's `/session/echo` puts replay
protection in front of the warm-up failure — which is where it lives in production, because
the gateway runs before the service behind it — so:

```
-> POST x-nonce=1000   <- 503  (warming up; the nonce is now spent)
-> POST x-nonce=1000   <- 409  (nonce 1000 was already used)
```

The built-in retry does not merely fail to help; it converts a transient failure into a
permanent one. The alternative works cleanly, because plans are cold and re-executable:

```
-> POST x-nonce=2000   <- 503
-> POST x-nonce=2001   <- 503
-> POST x-nonce=2002   <- 200
```

but `setRetries(0)` plus a loop gives up `Retry-After` handling and the jittered schedule
to get there. The library's design notes already track this under the retry-lifecycle
question, and the note there — that "the narrowest useful form may be a per-attempt
_request_ transform rather than a body factory" — is exactly right for this case: the nonce
is a header, not a body, and a per-attempt request transform would have solved it. Worth
recording that `mapClient` *is* per-attempt and therefore already solves the header case;
what it cannot do is vary the body, and this project never needed that.

### 6. The first pass of this repository did not typecheck, and that mattered

Not a library finding — a finding about how a library like this must be evaluated. The
first pass shipped a client with 69 TypeScript errors and a `typecheck` script that had
never passed. Every one of them was the same mistake: reading `.body` off a response
envelope without narrowing it first.

That is not incidental. **The entire value proposition of mapped non-2xx responses is that
they are typed members of the same union as the success**, and a client that ignores `tsc`
has opted out of the only thing the library was being evaluated for. It also meant no test
ever exercised an error path, which is how three services shipped `Schema.TaggedError`
response schemas that could never have decoded anything.

The repository now typechecks `src` and `tests` together, every test narrows through an
`expectTag` helper that fails with the tag and body it actually received, and the UI was
rewritten so the view layer is held to the same standard as the tests.

### What typed decoding found that nobody was looking for

The Java service's "`DELETE` returns `204` with `{"deleted": true}`" quirk — inherited from
the first pass, and a real thing that real services do — **is not real here**. The handler
writes the body, but the JDK's `HttpServer` refuses to send a payload for a status that
forbids one, so the debug body a junior developer added "for debugging" in 2015 has been
dead code ever since and no caller has ever seen it.

Nobody noticed for the same reason nobody noticed anything else: the first pass declared
`ResponseBody.json` for that rule and never ran the code. Declaring the codec honestly made
the JSON codec reject the empty payload, which is correct of it, which is how the quirk
turned out to be a fiction. Two other things fell out the same way: WEBrick absolutizes the
relative `Location` that the Java servlet container passes through unchanged — same header,
same intent, opposite results, decided entirely by the container — and the Perl gateway's
duplicate query parameters collapse silently in a `Map<String,String>` even though
`appendUrlParam` put both on the wire correctly.

### Smaller papercuts

- **`defaultBody: undefined` does not typecheck** under `exactOptionalPropertyTypes`, which
  is the natural thing to write for a body-less `POST`. The answer is to omit both `body`
  and `defaultBody` — such a plan is already executable — but the error message points at
  a type mismatch rather than saying so.
- **The body-required diagnostic is a compile-time type only.** `plan.effect` is typed as
  `RequestBodyRequired` before `setBody`, but at runtime it is an ordinary Effect that
  *fails* with `RequestBodyRequired`. The README says "available in the type system" and
  means it precisely; a reader skimming might expect the property itself to be the
  diagnostic value.
- **Gate retention is a single entry.** It did not bite — this page runs one key at a time
  — and it is already an open design question. Recorded for the record, not as a complaint.

### Nothing else failed

Every one of the five services is driven end to end, every exported codec is used, and
every exported setter except `setResponseCodec` and `setHeaders`/`setUrlParams` (whose
singular forms were always what a call site wanted) appears somewhere in the client. There
is no unresolved blocker, and nothing in the library had to be worked around — only
configured, or, in the four cases above, documented.

---

## What this project says about the "agnostic" claim

The library's position is that the application chooses its transport, its formats and its
conventions, and that the library supplies schemas, rules and plans. Five services in five
languages, spanning a decade of wire-format fashion, is a reasonable test of that, and it
held: the client needed **one** provider written by hand (for repeated header lines, which
is a platform limitation rather than a library one), **zero** custom codecs, and **zero**
forks of library behaviour.

What it did need was a great deal of schema. That is the honest shape of the result: the
library's answer to a badly-behaved API is to push the badness into a schema, where it can
be named, tested, and — this is the part that matters for a five-service client — run
backwards. Sixty-odd deliberate quirks produced sixty-odd schema definitions and four
plan transforms, and no `if (response.status === …)` anywhere in the application code.

The one thing it cannot do is vary a request across the attempts of its own retry policy.
Everything else on that very long list was a declaration.
