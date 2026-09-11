# test-llm1-2 — Multi-Service Integration Test

A TypeScript/Effect client consuming three independent non-JS backend services, each in a different
language with its own transport conventions and historical quirks. Built to exercise
[`viell-effect-schema-http`](../repo) under realistic conditions where the "realistic" part is that
the client talks to separate services built by different teams at different times.

See [docs/plan.md](docs/plan.md) for the full architecture, quirk tables, and task list.

## Services

| Service | Language | Port | Transport | Purpose |
| --- | --- | --- | --- | --- |
| ID Server | Rust (Axum) | 4100 | REST + OAuth2 | Identity, auth, tokens |
| File Server | Python (stdlib) | 4200 | SOAP/XML | File storage |
| API Server | Java (JDK HttpServer) | 4300 | REST/RPC (JSON) | Business logic |

## Client

TypeScript + Effect + Vite SPA in `client/`, using `viell-effect-schema-http` to talk to all three.

## Quick Start

```bash
# Terminal 1: ID Server
cd services/id-server && cargo run

# Terminal 2: File Server
cd services/file-server && source .venv/bin/activate && python main.py

# Terminal 3: API Server
cd services/api-server && ./gradlew run   # or: java -cp build/classes/java/main Main

# Terminal 4: Client
cd client && pnpm dev
```
