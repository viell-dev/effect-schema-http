# multi-service-schema-http

A multi-service platform test exercising [`viell-effect-schema-http`](../repo-llm1) and
[Effect Schema](https://effect.website/docs/schema/introduction/) against **three heterogeneous,
non-JS backend servers** (Rust, Python, and Java), each carrying deliberate historical quirks and
interop requirements.

Unlike `test-llm1` (which models a single monolithic Node.js backend that accreted features over
time), `test-llm1-2` models an enterprise architecture composed of distinct microservices built by
different engineering teams in different languages over the course of a decade:

1. **ID Server (Rust / Axum on `:4100`)**: An OAuth2-style identity provider written in 2019 by the
   security team, using opaque access tokens and JWT refresh tokens.
2. **File Server (Python / stdlib on `:4200`)**: A SOAP/XML document repository ported in 2016 from
   a .NET WCF service, preserving legacy XML namespaces, single-element array quirks, and US date
   formatting.
3. **API Server (Java / JDK HttpServer on `:4300`)**: A legacy core REST/RPC business API originally
   started in 2014, with epoch-millisecond timestamps, asymmetric enum serialization, off-by-one
   pagination, and a pre-RFC 6750 `Authorization: Token` scheme.
4. **Client (`client/`)**: A TypeScript + Effect Single Page Application built with Vite, consuming
   all three services simultaneously via `viell-effect-schema-http`.

---

## Architecture

```
services/
  id-server/     Rust (Axum)          Port 4100   OAuth2 identity provider, tokens, userinfo
  file-server/   Python (stdlib)      Port 4200   SOAP/XML file storage, WSDL, Fault codes
  api-server/    Java (JDK HttpServer) Port 4300 REST/RPC business API (projects, tasks, search)

client/          TypeScript + Effect + Vite SPA   Port 5173
                 viell-effect-schema-http client juggling all three backends
vendor/          Packed viell-effect-schema-http-0.1.0-beta.1.tgz from repo-llm1
```

### Inter-Service Communication

- **API Server -> ID Server**: When requests arrive at the Java API Server with `Authorization: Token
  <token>`, the Java server authenticates the caller by calling the Rust ID Server's `POST
  /introspect` endpoint.
- **API Server -> File Server**: When clients upload or download attachments through the API Server
  (`POST /api/files`, `GET /api/files/:id`), the Java server translates JSON payloads into SOAP XML
  envelopes (`urn:filestore:2011`) and proxies the calls to the Python File Server.
- **File Server -> ID Server**: When files are directly managed via SOAP (`ListFiles`,
  `UploadFile`), the Python service calls the Rust ID Server's `POST /introspect` endpoint to verify
  the bearer token before granting access.
- **Client -> All Three**: The client directly authenticates with the ID Server, calls business
  logic on the API Server, and performs direct SOAP file transfers or proxy transfers on the File
  Server.

---

## Why the Services are Like This (Historical Quirks)

Every service in this repository carries deliberate idiosyncrasies that mirror real production
systems running in enterprises today. Below is the full inventory of deliberate misbehaviour and
what the client had to do to survive each one.

| Quirk | Service | What a tidy API would have done | What the client needed |
| --- | --- | --- | --- |
| `token_type` casing differs ("bearer" vs "Bearer") | ID Server (`/token`) | Consistent casing | `Schema.transform` normalizing both strings to `"Bearer"` |
| Access tokens are opaque strings, but refresh tokens are JWTs | ID Server (`/token`) | Consistent token strategy | Client never assumes JWT structure; treats access token as opaque and calls `/userinfo` |
| Error shape divergence (`/token` uses spec, `/userinfo` uses `{message}`) | ID Server | Uniform error envelope across service | Two distinct tagged error schemas (`OAuthError` and `SimpleError`) |
| Rate-limiting (`429`) uses HTTP-date string in `Retry-After`, not seconds | ID Server (`/token`) | Integer seconds | Header parser converting RFC 1123 date into seconds remaining |
| Register returns 201 + User, login returns 200 + tokens only | ID Server | Uniform auth response | Two distinct response schemas; client fetches profile post-login |
| Custom SOAP namespace `urn:filestore:2011` | File Server (SOAP) | Standard REST / JSON | `makeSoapRequestXml` with `RequestBody.text` |
| HTTP 200 for all responses; outcome in SOAP `<FaultCode>` (0 = OK) | File Server (SOAP) | Real HTTP status codes | Response transform inspecting `<FaultCode>` and throwing `SoapFaultError` if non-zero |
| Single file listing wraps in extra `<Result><File>` wrapper | File Server (`ListFiles`) | Consistent array schema | Regex/DOM parser in transform extracting all `<File>` nodes across shapes |
| Date format is US `.NET` format `MM/dd/yyyy HH:mm:ss` (no timezone) | File Server | ISO 8601 UTC | `UsDateFromString` two-way `Schema.transform` converting to/from `Date` |
| Maximum file size in WSDL is bytes, but error messages state "KB" | File Server (`/wsdl`) | Consistent units | Client relies on WSDL schema attribute rather than message string |
| Strict rejection of GET requests carrying bodies (`RequestBodyNotAllowed`) | File Server (`DownloadFile`) | GET with body or query/path param | Client uses SOAP `POST`, verifying the library's `RequestBodyNotAllowed` invariant |
| Auth header requires `Token <val>`, NOT `Bearer <val>` | API Server | RFC 6750 `Bearer` | Dynamic header function in `createApi` prepending `"Token "` |
| All timestamps are epoch milliseconds as JSON numbers | API Server | ISO 8601 strings | `EpochMsToDate = Schema.transform(Schema.Number, Schema.DateFromSelf)` |
| 4xx errors are structured `{error: {code, message}}`, 5xx are `{error: str}` | API Server | Uniform error envelope | `StructuredError` and `FlatError` tagged error schemas behind status matchers |
| `PATCH` returns the _old_ resource state, not updated state | API Server (`/projects`) | Return updated entity | Client receives old state, logs warning, and reconciles/re-fetches |
| `DELETE` returns 204 with a JSON body `{"deleted": true}` | API Server (`/projects`) | Empty body on 204 | Response rule specifying `{ codec: ResponseBody.json }` for 204 |
| Task status enum: string in request ("OPEN"), int ordinal in response (0) | API Server (`/tasks`) | Uniform representation | `TaskStatusFromOrdinal` schema transforming `0..4` <-> `"OPEN"..` |
| Comments return 200 OK (not 201) with relative `Location` header | API Server (`/comments`) | 201 with absolute URI | Rule matching status 200; client resolves relative path from base URL |
| Search returns unwrapped bare object for 1 hit, array for multiple hits | API Server (`/search`) | Always an array | `SearchResults = Schema.transform(Union(Array(Hit), Hit), Array(Hit))` |

---

## What Working with `viell-effect-schema-http` Revealed

### 1. `DuplicateResponseTag` is a Compile-Time Protection

When declaring API-wide or endpoint-specific error rules:

```ts
// Compile error! Duplicate response tag "OAuthError"
responses: [
  response({ _tag: "OAuthError", status: 400 }, OAuthError),
  response({ _tag: "OAuthError", status: 401 }, OAuthError),
  response({ _tag: "OAuthError", status: 409 }, OAuthError),
]
```

The library enforces unique discriminants across rules so that pattern matching with `Match.tag`
over the response envelope remains unambiguous. When multiple HTTP statuses share the same error
schema, the idiom is a **status predicate**:

```ts
response(
  {
    _tag: "OAuthError",
    status: (s: number) => s === 400 || s === 401 || s === 409,
  },
  OAuthError,
)
```

### 2. Strict HTTP Semantics (`RequestBodyNotAllowed`)

When implementing the Python File Server's quirk (where downloads were originally modeled as an HTTP
`GET` request carrying a SOAP XML body), `viell-effect-schema-http` refused to send the request:

```
(FiberFailure) RequestBodyNotAllowed: An error has occurred
```

The library inspects `request.method` and prevents non-empty bodies from being dispatched on `GET`
and `HEAD`. Unlike low-level clients that blindly transmit invalid HTTP requests,
`viell-effect-schema-http` treats the HTTP specification as a firm contract. Legacy endpoints
requiring a body must either use `POST` (standard SOAP) or a proxy.

### 3. Asymmetric Schemas and Composable Transforms

The library cleanly handled the two most difficult real-world schema quirks:
- **Search Unwrapped Single Element**: Java's Jackson with `WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED`
  serializes `[{...}]` as `{...}`. Using `Schema.transform(Schema.Union(Array(Hit), Hit), Array(Hit))`
  normalized the payload at the boundary, ensuring downstream UI code never needed `Array.isArray()`
  guards.
- **Task Status Enum**: Requests send `"OPEN"` while responses return `0`. Effect Schema transforms
  seamlessly bridge the gap between human-readable domain values and wire representation.

---

## Running the Project

### Prerequisites

- Node.js >= 22 and `pnpm`
- Rust toolchain (`cargo`, `rustc`)
- Python 3.14
- Java 21 JDK (Temurin / OpenJDK)

### Quick Start (All Services)

```bash
# Start all 3 servers + Vite client simultaneously:
./scripts/start-all.sh
```

This starts:
- ID Server: http://localhost:4100
- File Server: http://localhost:4200
- API Server: http://localhost:4300
- Frontend SPA: http://localhost:5173

### Running Tests

```bash
# Run client unit tests:
cd client && pnpm test

# Run full end-to-end integration tests (requires servers to be running):
./scripts/start-all.sh &
cd client && pnpm test
```
