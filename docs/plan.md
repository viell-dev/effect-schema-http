# test-llm1-2 — Multi-Service Integration Test Plan

A TypeScript/Effect client consuming three independent non-JS servers, each in a different language
with its own transport style and historical quirks. The purpose is the same as `test-llm1` — to
exercise `viell-effect-schema-http` under realistic conditions — but this time the "realistic" part
is that the client talks to separate services that were built by different teams at different times,
each carrying its own legacy.

## Working Convention

**Always commit after completing a task.** Uncommitted work is assumed to be the next unchecked
task, still in progress.

---

## Architecture

```
services/
  id-server/      Rust (Axum)        — OAuth2-style identity provider, JWT tokens
  file-server/    Python (stdlib)    — SOAP/XML file storage service
  api-server/     Java (JDK HttpServer) — REST/RPC business API

client/           TypeScript + Effect + Vite SPA
                  Uses viell-effect-schema-http to talk to all three services

vendor/           The packed viell-effect-schema-http tarball (copied from test-llm1)
```

### Service Responsibilities

| Service | Port | Protocol | Purpose |
| --- | --- | --- | --- |
| ID Server (Rust) | 4100 | REST + OAuth2 flows | User registration, login, token issuance/refresh, user info |
| File Server (Python) | 4200 | SOAP/XML | File upload, download, listing, metadata; used by API server for attachments |
| API Server (Java) | 4300 | REST/RPC (JSON) | Business logic: projects, tasks, comments; references ID server for auth and file server for attachments |

### Inter-Service Communication

- API Server validates tokens by calling ID Server's `/introspect` endpoint
- API Server stores/retrieves files by calling File Server's SOAP endpoints
- File Server calls ID Server to verify upload permissions
- Client talks to all three directly for some operations (file download, auth)

---

## Historical Quirks (Plausible Reasons)

Each server carries intentional misbehaviour that a real legacy system would have. The reasons are
all plausible — these are things that exist in production right now.

### ID Server (Rust) — "Built in 2019 by the security team"

| Quirk | Plausible reason | Client cost |
| --- | --- | --- |
| Access tokens are opaque strings, not JWT; refresh tokens _are_ JWT | Original team used opaque tokens for revocability; a later contractor added refresh tokens using a JWT library and nobody unified them | Client must call `/userinfo` instead of decoding the token locally |
| Token endpoint returns `token_type: "bearer"` (lowercase) sometimes and `"Bearer"` other times | Two code paths (password grant vs refresh grant), written months apart, different string casing | Client must case-insensitive compare or normalize |
| Error responses use `error`/`error_description` (OAuth2 spec) for auth endpoints but `{"message": "..."}` for the user-info endpoint | User-info was added later by a different developer who didn't read the auth error format | Client needs two error decoders |
| Rate-limiting returns `429` with `Retry-After` as a date string, not seconds | The rate limiter is a reverse-proxy config the devops team wrote; they used HTTP-date format | `Schema` transform from HTTP-date to seconds |
| `/register` returns `201` with the user in the body; `/login` returns `200` with just the tokens, no user | Register was the first endpoint; login was added when someone realized the mobile app didn't need the user object at login time | Client must call `/userinfo` after login if it needs the profile |
| CORS headers are present but `Access-Control-Allow-Headers` omits `Content-Type` for preflight on one endpoint | That endpoint was added after the CORS middleware was configured; nobody updated the list | Client sees a CORS error in the browser and must use a workaround |

### File Server (Python) — "Ported from a .NET WCF service in 2016"

| Quirk | Plausible reason | Client cost |
| --- | --- | --- |
| SOAP envelope uses a custom namespace `urn:filestore:2011` | Original WCF service declared its own namespace; the Python port preserved it for backward compat with other internal consumers | Client must use this exact namespace in requests |
| Successful uploads return HTTP `200` with a SOAP fault code `0` (success) inside the body | The original .NET service always returned 200; the outcome was in the SOAP body | Client must parse SOAP body to know if it worked |
| File download uses HTTP `GET` but the file-id is in a SOAP header, not the URL | The WCF service used SOAP headers for everything; the Python port kept that for downloads to avoid breaking the ERP integration | `RequestBody.text` with an XML SOAP envelope on a GET (yes, really — the server reads the body on GET) |
| File metadata responses include a `<LastModified>` field as `MM/dd/yyyy HH:mm:ss` (US format, no timezone) | Original .NET `DateTime.ToString()` default; the Python port used `strftime` to match | A date transform that handles this specific format |
| Maximum file size is returned in the WSDL as bytes but the error message says "KB" | WSDL was generated, error message was hand-written; nobody noticed the unit mismatch | Client must just know which one is right (the WSDL, always) |
| Listing files returns `<Files/>` (self-closing) for empty, `<Files><File>...</File></Files>` for one, and `<Files><File>...</File><File>...</File></Files>` for many — but the single-file case wraps it in an extra `<Result>` | The .NET serializer had a quirk with single-element arrays; the Python port reproduced the bug because the ERP expected it | Client must normalize the three shapes |

### API Server (Java) — "The main backend, started in 2014, Java 8 originally"

| Quirk | Plausible reason | Client cost |
| --- | --- | --- |
| All timestamps are epoch _milliseconds_ as JSON numbers | Java `System.currentTimeMillis()`; nobody ever changed it | Transform from epoch-ms to Date |
| Error responses for 4xx use `{"error": {"code": "...", "message": "..."}}` but 5xx uses `{"error": "string"}` | 4xx errors are thrown from business logic (structured); 5xx are caught by a global handler that just `.toString()`s the exception | Two error shapes behind a union |
| `PATCH` on projects returns the _old_ state, not the new state | A developer misread "return the resource" as "return what it was" and it shipped; clients adapted; changing it would break the mobile app | Client must either re-fetch or optimistically apply the patch locally |
| Pagination uses 1-based `page` param but the `Link` header uses 0-based offsets | Pagination was added in two phases: query params first (1-based, human-friendly), Link headers later (0-based, copied from GitHub's docs wrong) | Client must adjust by 1 when following Link headers |
| Creating a comment returns `200` (not `201`) and the `Location` header is relative, not absolute | The original servlet container resolved relative URLs; the current setup doesn't, but the header was never fixed | Client must resolve the relative URL against the request base |
| `DELETE` returns `204` with a body containing `{"deleted": true}` | A junior developer added the body "for debugging" and it stuck | Nothing — `204` with a body is technically allowed, but some HTTP clients choke |
| The `Authorization` header must be `Token <value>`, not `Bearer <value>` | The API predates the widespread adoption of RFC 6750; it used a custom scheme and never migrated | Client must use `Token` scheme, not `Bearer`, even though the ID server issues Bearer tokens |
| Search endpoint returns results as a JSON array when there are multiple, but a single object (not wrapped) when there is exactly one | Early Jackson configuration with `WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED`; nobody changed it | `Schema.Union` to normalize to always-array |
| Task status field is an integer enum (0–4) in responses but the string name in requests | Responses serialize the Java enum's ordinal; requests parse the name — two different Jackson annotations on the same field | Two schemas for the same concept |

---

## Task List

### Phase 0: Repository Setup

- [x] Create `.gitignore` covering all four languages (Rust target, Python venv/pycache, Java
  class files, Node modules, OS files)
- [x] Create root `README.md` explaining the project purpose and architecture
- [x] Copy the `vendor/` tarball from `test-llm1`
- [x] Commit: "Initial repository setup with plan and gitignore"

### Phase 1: ID Server (Rust/Axum)

- [x] Initialize Cargo project in `services/id-server/` with Axum, serde, jsonwebtoken, uuid,
  tokio dependencies
- [x] Implement in-memory user store (registration + hashed passwords)
- [x] Implement OAuth2-style `/token` endpoint (password grant + refresh grant)
- [x] Implement `/userinfo` endpoint (requires valid access token)
- [x] Implement `/introspect` endpoint (for server-to-server token validation)
- [x] Implement `/register` endpoint
- [x] Wire in all historical quirks (casing inconsistency, error format split, rate limiting with
  HTTP-date, etc.)
- [x] Add CORS middleware with the intentional omission on one endpoint
- [x] Test with `curl` / write a small integration test
- [x] Commit: "ID Server (Rust/Axum) — complete with historical quirks"

### Phase 2: File Server (Python/stdlib)

- [x] Create Python project in `services/file-server/` with a venv and minimal dependencies
  (stdlib `http.server` + `xml.etree` — no frameworks)
- [x] Implement SOAP envelope parsing with `urn:filestore:2011` namespace
- [x] Implement `UploadFile` SOAP action (multipart: SOAP envelope + file bytes, MTOM-style)
- [x] Implement `DownloadFile` SOAP action (GET with SOAP header containing file ID)
- [x] Implement `ListFiles` SOAP action with the three-shape quirk (empty, single-in-Result, multi)
- [x] Implement `GetFileMetadata` SOAP action with US-format dates
- [x] Implement token verification by calling ID Server's `/introspect`
- [x] Wire in all historical quirks (HTTP 200 always, SOAP fault code 0 for success, size unit
  mismatch, etc.)
- [x] Test with `curl`
- [ ] Commit: "File Server (Python/stdlib) — SOAP service with legacy quirks"

### Phase 3: API Server (Java/JDK HttpServer)

- [ ] Initialize Java project in `services/api-server/` (plain javac or Gradle, JDK HttpServer,
  Jackson for JSON)
- [ ] Implement in-memory store for projects, tasks, and comments
- [ ] Implement auth middleware that calls ID Server's `/introspect` and translates Bearer→Token
- [ ] Implement CRUD endpoints for projects (`GET`, `POST`, `PATCH`, `DELETE`)
- [ ] Implement CRUD endpoints for tasks (nested under projects)
- [ ] Implement comments endpoint with the `200`-not-`201` quirk
- [ ] Implement search endpoint with the single-object-vs-array quirk
- [ ] Implement file attachment proxying through the File Server
- [ ] Wire in all historical quirks (epoch-ms timestamps, error shape split, pagination off-by-one,
  `PATCH` returns old state, status int-vs-string, etc.)
- [ ] Test with `curl`
- [ ] Commit: "API Server (Java/JDK HttpServer) — REST API with legacy quirks"

### Phase 4: TypeScript/Effect Client

- [ ] Initialize client project in `client/` (Vite + TypeScript, Effect, the vendored library)
- [ ] Define API declarations for ID Server endpoints using `createApi`/`createRequest`
- [ ] Define API declarations for File Server SOAP endpoints (XML request/response bodies)
- [ ] Define API declarations for API Server endpoints
- [ ] Implement schema transforms for all quirks (date formats, casing, epoch-ms, SOAP parsing,
  error unions, etc.)
- [ ] Implement auth flow: register → login → store token → refresh cycle
- [ ] Implement a basic UI: project list, task board, file upload/download, user profile
- [ ] Wire file operations through both direct File Server calls and API Server proxy
- [ ] Commit: "TypeScript/Effect client — all three services wired"

### Phase 5: Integration & Polish

- [ ] Write a `docker-compose.yml` or a `start-all.sh` script to launch all four processes
- [ ] Verify end-to-end: register, login, create project, create task, attach file, search,
  refresh token, hit rate limit, trigger every quirk
- [ ] Write a comprehensive `README.md` in the style of test-llm1 (architecture, quirk table,
  what the client needed for each)
- [ ] Final commit: "Integration complete — all services running with client"
