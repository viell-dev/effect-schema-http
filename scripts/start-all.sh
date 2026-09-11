#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Starting all services for test-llm1-2..."

PIDS=()

cleanup() {
  echo ""
  echo "Shutting down all services..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "All services stopped."
}

trap cleanup SIGINT SIGTERM EXIT

# 1. Rust ID Server (Port 4100)
echo "Starting ID Server (Rust/Axum on :4100)..."
(cd "$ROOT_DIR/services/id-server" && cargo run --quiet) &
PIDS+=($!)

# 2. Python SOAP File Server (Port 4200)
echo "Starting File Server (Python/stdlib on :4200)..."
(cd "$ROOT_DIR/services/file-server" && python3 main.py) &
PIDS+=($!)

# 3. Java REST API Server (Port 4300)
echo "Starting API Server (Java/HttpServer on :4300)..."
(cd "$ROOT_DIR/services/api-server" && ./gradlew run --quiet) &
PIDS+=($!)

# 4. Perl Report Gateway (Port 4400)
echo "Starting Report Gateway (Perl/raw sockets on :4400)..."
(cd "$ROOT_DIR/services/report-server" && perl report-gateway.pl) &
PIDS+=($!)

# 5. Ruby Notification Service (Port 4500)
echo "Starting Notify Service (Ruby/WEBrick on :4500)..."
(cd "$ROOT_DIR/services/notify-server" && ruby notify-service.rb) &
PIDS+=($!)

# Wait for backend servers to become available
echo "Waiting for backend services to be healthy..."
for i in {1..30}; do
  if curl -s http://localhost:4100/health >/dev/null 2>&1 && \
     curl -s http://localhost:4200/health >/dev/null 2>&1 && \
     curl -s http://localhost:4300/health >/dev/null 2>&1 && \
     curl -s http://localhost:4400/health >/dev/null 2>&1 && \
     curl -s http://localhost:4500/health >/dev/null 2>&1; then
    echo "✓ All backend services healthy!"
    break
  fi
  sleep 1
done

# 4. Vite Frontend Client (Port 5173)
echo "Starting Client (Vite/TypeScript on :5173)..."
(cd "$ROOT_DIR/client" && pnpm dev) &
PIDS+=($!)

echo ""
echo "=========================================================="
echo "  All services running:"
echo "    ID Server (Rust):   http://localhost:4100"
echo "    File Server (Py):   http://localhost:4200"
echo "    API Server (Java):  http://localhost:4300"
echo "    Report GW (Perl):   http://localhost:4400"
echo "    Notify (Ruby):      http://localhost:4500"
echo "    Web Client (Vite):  http://localhost:5173"
echo "=========================================================="
echo "Press Ctrl+C to terminate all services."

wait
