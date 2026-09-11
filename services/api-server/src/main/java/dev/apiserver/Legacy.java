package dev.apiserver;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The parts of the API that predate the parts in {@link Routes}.
 *
 * <p>Nothing here would be written this way today. Each endpoint is a faithful copy of a
 * shape that a real system shipped, kept alive by a consumer nobody can decommission:
 * an OData v2 envelope produced by a 2010 WCF Data Services layer, a report grid the
 * reporting tool reads positionally, a batch endpoint written before anyone had heard
 * of HTTP/2, a job endpoint that answers 202 and a relative Location, and a gateway that
 * strips DELETE.
 */
public class Legacy {
    private final Store store;
    private final AuthMiddleware auth;
    private final Gson gson;

    /** Import jobs, keyed by id, counting polls so a job takes three reads to finish. */
    private final Map<String, AtomicInteger> imports = new ConcurrentHashMap<>();

    /** Monotonic order ids that start above 2^53, where JSON numbers stop being exact. */
    private final AtomicLong orderIds = new AtomicLong(9007199254740993L);

    public Legacy(Store store, AuthMiddleware auth) {
        this.store = store;
        this.auth = auth;
        this.gson = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    }

    // -----------------------------------------------------------------------
    // Plumbing
    // -----------------------------------------------------------------------

    @FunctionalInterface
    interface Handler {
        void handle(HttpExchange exchange) throws Exception;
    }

    void dispatch(HttpExchange exchange, Handler handler) {
        try {
            var headers = exchange.getResponseHeaders();
            headers.add("Access-Control-Allow-Origin", "*");
            headers.add("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
            headers.add("Access-Control-Allow-Headers", "*");
            headers.add("Access-Control-Expose-Headers", "*");
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            handler.handle(exchange);
        } catch (Exception e) {
            try {
                var error = new JsonObject();
                error.addProperty("error", e.getClass().getSimpleName() + ": " + e.getMessage());
                send(exchange, 500, "application/json", gson.toJson(error));
            } catch (IOException ignored) {
                // The connection is already gone.
            }
        }
    }

    private void send(HttpExchange exchange, int status, String contentType, String body) throws IOException {
        var bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", contentType);
        exchange.sendResponseHeaders(status, bytes.length);
        try (var os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private void sendNoBody(HttpExchange exchange, int status) throws IOException {
        exchange.sendResponseHeaders(status, -1);
        exchange.close();
    }

    private String readBody(HttpExchange exchange) throws IOException {
        return new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    private Map<String, String> query(HttpExchange exchange) {
        var raw = exchange.getRequestURI().getRawQuery();
        var params = new LinkedHashMap<String, String>();
        if (raw == null || raw.isBlank()) return params;
        for (var pair : raw.split("&")) {
            var kv = pair.split("=", 2);
            var key = URLDecoder.decode(kv[0], StandardCharsets.UTF_8);
            params.put(key, kv.length > 1 ? URLDecoder.decode(kv[1], StandardCharsets.UTF_8) : "");
        }
        return params;
    }

    private String requireAuth(HttpExchange exchange) throws IOException {
        var username = auth.authenticate(exchange.getRequestHeaders().getFirst("Authorization"));
        if (username == null) {
            var inner = new JsonObject();
            inner.addProperty("code", "UNAUTHORIZED");
            inner.addProperty("message", "Valid Token authorization required");
            var error = new JsonObject();
            error.add("error", inner);
            send(exchange, 401, "application/json", gson.toJson(error));
            return null;
        }
        return username;
    }

    /**
     * The effective method for a request.
     *
     * <p>Quirk: the corporate gateway in front of this service strips {@code DELETE} and
     * {@code PUT}, a rule written in 2008 to stop a misconfigured crawler and never
     * revisited. The mobile team's workaround — {@code POST} plus
     * {@code X-HTTP-Method-Override} — became the documented way to call those verbs.
     */
    private String effectiveMethod(HttpExchange exchange) {
        var override = exchange.getRequestHeaders().getFirst("X-HTTP-Method-Override");
        var method = exchange.getRequestMethod().toUpperCase();
        if (override != null && !override.isBlank() && method.equals("POST")) {
            return override.trim().toUpperCase();
        }
        return method;
    }

    // -----------------------------------------------------------------------
    // GET /api/odata/Orders — a WCF Data Services envelope
    // -----------------------------------------------------------------------

    /**
     * The order list, exactly as the 2010 data layer serialized it.
     *
     * <p>Quirk: the payload is wrapped in {@code {"d":{"results":[…]}}}, because OData
     * v2 wrapped everything in {@code d} to defeat a JSON array hijacking attack that
     * stopped being possible in 2011. {@code __count} is a string for the same reason
     * every other number here is: the serializer emitted decimals and longs as strings
     * so JavaScript could not round them.
     *
     * <p>Quirk: {@code id} is a 64-bit identity column above 2^53, so the JSON number is
     * *already wrong* by the time it reaches a JavaScript parser. {@code idStr} exists
     * because a customer noticed. Both are sent, forever, and the string is the true one.
     *
     * <p>Quirk: {@code orderDate} is {@code /Date(…)/}, the ASP.NET AJAX date format.
     * {@code cancelledOn} is {@code "0000-00-00"} when the order was never cancelled,
     * which is what the MySQL column contained. {@code creditLimit} is {@code -1} for
     * "unlimited". {@code notes} is one of four different spellings of "nothing"
     * depending on which import wrote the row. {@code customerRef} is an object when the
     * row was written by the new importer and a bare id string when it was not.
     */
    public void handleOrders(HttpExchange exchange) {
        dispatch(exchange, this::orders);
    }

    private void orders(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var results = new JsonArray();
        var base = orderIds.get();

        for (var index = 0; index < 4; index++) {
            var id = base + index;
            var order = new JsonObject();

            var metadata = new JsonObject();
            metadata.addProperty("uri", "http://localhost:4300/api/odata/Orders(" + id + "L)");
            metadata.addProperty("type", "Northwind.Order");
            order.add("__metadata", metadata);

            // Both forms of the same identity: the lossy one and the true one.
            order.addProperty("id", id);
            order.addProperty("idStr", Long.toString(id));
            order.addProperty("project", "Legacy import " + (index + 1));
            // ASP.NET AJAX date, with the offset form for one row.
            order.addProperty(
                "orderDate",
                index == 2
                    ? "/Date(1262304000000+0100)/"
                    : "/Date(" + (1262304000000L + index * 86_400_000L) + ")/");
            // Locale.US on purpose: the column is a formatted string, and the format is
            // whatever the 2010 report server's locale happened to be.
            order.addProperty("amount", String.format(Locale.US, "$%,.2f", 1234.5 + index * 1000));
            order.addProperty("taxRate", "0.1900");
            order.addProperty("active", index % 2 == 0 ? "Y" : "N");
            order.addProperty("cancelledOn", index == 3 ? "2019-04-02" : "0000-00-00");
            order.addProperty("creditLimit", index == 1 ? -1 : 50000);

            // Four spellings of "no notes", one per importer that ever touched the table.
            switch (index) {
                case 0 -> order.add("notes", com.google.gson.JsonNull.INSTANCE);
                case 1 -> order.addProperty("notes", "");
                case 2 -> order.addProperty("notes", "null");
                default -> order.addProperty("notes", "Escalated by support");
            }

            // A reference that is sometimes expanded and sometimes not.
            if (index % 2 == 0) {
                var customer = new JsonObject();
                customer.addProperty("id", "CUST-" + (100 + index));
                customer.addProperty("name", "Contoso " + index);
                order.add("customerRef", customer);
            } else {
                order.addProperty("customerRef", "CUST-" + (100 + index));
            }

            results.add(order);
        }

        var payload = new JsonObject();
        payload.add("results", results);
        payload.addProperty("__count", Integer.toString(results.size()));
        var envelope = new JsonObject();
        envelope.add("d", payload);

        send(exchange, 200, "application/json;odata=verbose", gson.toJson(envelope));
    }

    // -----------------------------------------------------------------------
    // GET /api/reports/grid — column-oriented rows
    // -----------------------------------------------------------------------

    /**
     * The task report, shaped for the reporting tool rather than for a program.
     *
     * <p>Quirk: rows are positional arrays, not objects, because in 2009 repeating the
     * key names on every row tripled the payload over a leased line. The column order is
     * the contract; the reporting tool indexes into it by number.
     *
     * <p>Quirk: the content type is {@code text/json}, which was never registered. A
     * client that dispatches on content type has to know about it.
     */
    public void handleGrid(HttpExchange exchange) {
        dispatch(exchange, this::grid);
    }

    private void grid(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var columns = new JsonArray();
        for (var column : List.of("id", "projectId", "title", "status", "priority", "updatedAt")) {
            columns.add(column);
        }

        var rows = new JsonArray();
        for (var task : store.listTasks(null)) {
            var row = new JsonArray();
            row.add(task.id());
            row.add(task.projectId());
            row.add(task.title());
            // The ordinal again, because the grid shares the serializer with everything else.
            row.add(task.status().ordinal());
            row.add(task.priority());
            row.add(task.updatedAt());
            rows.add(row);
        }

        var payload = new JsonObject();
        payload.add("columns", columns);
        payload.add("rows", rows);
        payload.addProperty("generatedAt", System.currentTimeMillis());

        send(exchange, 200, "text/json", gson.toJson(payload));
    }

    // -----------------------------------------------------------------------
    // /api/v2/projects/{id} — conditional requests
    // -----------------------------------------------------------------------

    /**
     * A project with cache validators, added in 2016 when the mobile app's data budget
     * became someone's objective.
     *
     * <p>This is the one endpoint on this service that behaves correctly: a strong
     * {@code ETag}, a real {@code 304} with no body for {@code If-None-Match}, and a
     * {@code 412} for a failed {@code If-Match}. It is here to prove that "the client
     * needed nothing" is a real outcome and not just the absence of testing.
     *
     * <p>The one concession to the gateway: {@code PUT} arrives tunnelled through
     * {@code POST} with {@code X-HTTP-Method-Override}, because the gateway strips it.
     */
    public void handleVersionedProject(HttpExchange exchange) {
        dispatch(exchange, this::versionedProject);
    }

    private String etagFor(Store.Project project) {
        return "\"" + Long.toHexString(project.updatedAt()) + "-" + project.id().hashCode() + "\"";
    }

    private JsonObject projectJson(Store.Project project) {
        var json = new JsonObject();
        json.addProperty("id", project.id());
        json.addProperty("name", project.name());
        json.addProperty("description", project.description());
        json.addProperty("owner", project.owner());
        json.addProperty("createdAt", project.createdAt());
        json.addProperty("updatedAt", project.updatedAt());
        return json;
    }

    private void versionedProject(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var parts = exchange.getRequestURI().getPath().split("/");
        var id = parts.length > 4 ? parts[4] : "";
        var found = store.getProject(id);
        if (found.isEmpty()) {
            var inner = new JsonObject();
            inner.addProperty("code", "NOT_FOUND");
            inner.addProperty("message", "Project not found");
            var error = new JsonObject();
            error.add("error", inner);
            send(exchange, 404, "application/json", gson.toJson(error));
            return;
        }

        var project = found.get();
        var etag = etagFor(project);

        // The gateway strips PUT and DELETE before they reach this service, so a raw
        // one is refused here too rather than working only in development.
        var rawMethod = exchange.getRequestMethod().toUpperCase();
        if (rawMethod.equals("PUT") || rawMethod.equals("DELETE")) {
            exchange.getResponseHeaders().add("Allow", "GET, POST");
            var inner = new JsonObject();
            inner.addProperty("code", "METHOD_NOT_ALLOWED");
            inner.addProperty(
                "message",
                "The gateway strips PUT and DELETE; resend as POST with X-HTTP-Method-Override");
            var error = new JsonObject();
            error.add("error", inner);
            send(exchange, 405, "application/json", gson.toJson(error));
            return;
        }

        var method = effectiveMethod(exchange);

        if (method.equals("GET")) {
            var ifNoneMatch = exchange.getRequestHeaders().getFirst("If-None-Match");
            exchange.getResponseHeaders().add("ETag", etag);
            exchange.getResponseHeaders().add("Cache-Control", "private, max-age=0, must-revalidate");
            if (etag.equals(ifNoneMatch)) {
                sendNoBody(exchange, 304);
                return;
            }
            send(exchange, 200, "application/json", gson.toJson(projectJson(project)));
            return;
        }

        if (method.equals("PUT")) {
            var ifMatch = exchange.getRequestHeaders().getFirst("If-Match");
            if (ifMatch == null) {
                var inner = new JsonObject();
                inner.addProperty("code", "PRECONDITION_REQUIRED");
                inner.addProperty("message", "If-Match is required for updates");
                var error = new JsonObject();
                error.add("error", inner);
                send(exchange, 428, "application/json", gson.toJson(error));
                return;
            }
            if (!ifMatch.equals(etag)) {
                var inner = new JsonObject();
                inner.addProperty("code", "PRECONDITION_FAILED");
                inner.addProperty("message", "The project changed since it was read");
                var error = new JsonObject();
                error.add("error", inner);
                exchange.getResponseHeaders().add("ETag", etag);
                send(exchange, 412, "application/json", gson.toJson(error));
                return;
            }

            var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
            var name = body.has("name") && !body.get("name").isJsonNull() ? body.get("name").getAsString() : null;
            var description = body.has("description") && !body.get("description").isJsonNull()
                ? body.get("description").getAsString()
                : null;
            store.updateProject(id, name, description);
            var updated = store.getProject(id).orElseThrow();
            exchange.getResponseHeaders().add("ETag", etagFor(updated));
            // Unlike PATCH on the 2014 endpoint, this one returns what it wrote.
            send(exchange, 200, "application/json", gson.toJson(projectJson(updated)));
            return;
        }

        exchange.getResponseHeaders().add("Allow", "GET, PUT");
        var inner = new JsonObject();
        inner.addProperty("code", "METHOD_NOT_ALLOWED");
        inner.addProperty(
            "message",
            "The gateway strips PUT and DELETE; resend as POST with X-HTTP-Method-Override");
        var error = new JsonObject();
        error.add("error", inner);
        send(exchange, 405, "application/json", gson.toJson(error));
    }

    // -----------------------------------------------------------------------
    // POST /api/batch — many calls, one connection
    // -----------------------------------------------------------------------

    /**
     * The batch endpoint, written when opening six connections from a phone on 3G was
     * the slowest thing the app did.
     *
     * <p>Quirk: the envelope is always {@code 200}. Each sub-response carries its own
     * status inside the body, so a batch where everything failed is still a successful
     * HTTP call. This is the shape a response-rule matcher cannot help with — the
     * transport genuinely says one thing about the whole batch — and a discriminated
     * union in the *schema* is the intended answer.
     */
    public void handleBatch(HttpExchange exchange) {
        dispatch(exchange, this::batch);
    }

    private void batch(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var requests = JsonParser.parseString(readBody(exchange)).getAsJsonObject().getAsJsonArray("requests");
        var responses = new JsonArray();

        for (var element : requests) {
            var request = element.getAsJsonObject();
            var path = request.get("path").getAsString();
            var item = new JsonObject();
            item.addProperty("id", request.has("id") ? request.get("id").getAsString() : path);

            if (path.startsWith("/api/projects/")) {
                var id = path.substring("/api/projects/".length());
                var project = store.getProject(id);
                if (project.isPresent()) {
                    item.addProperty("status", 200);
                    item.add("body", projectJson(project.get()));
                } else {
                    item.addProperty("status", 404);
                    var inner = new JsonObject();
                    inner.addProperty("code", "NOT_FOUND");
                    inner.addProperty("message", "Project not found");
                    var error = new JsonObject();
                    error.add("error", inner);
                    item.add("body", error);
                }
            } else {
                item.addProperty("status", 400);
                var inner = new JsonObject();
                inner.addProperty("code", "UNSUPPORTED_PATH");
                inner.addProperty("message", "The batch endpoint only understands /api/projects/{id}");
                var error = new JsonObject();
                error.add("error", inner);
                item.add("body", error);
            }
            responses.add(item);
        }

        var payload = new JsonObject();
        payload.add("responses", responses);
        send(exchange, 200, "application/json", gson.toJson(payload));
    }

    // -----------------------------------------------------------------------
    // /api/imports — a job that takes a while
    // -----------------------------------------------------------------------

    /**
     * Bulk import, the only asynchronous operation this service has.
     *
     * <p>Quirk: {@code 202} with a {@code Location} that is relative, because the
     * original servlet container resolved relative URLs against the request and the
     * current one does not. The header was never fixed, so a client has to resolve it
     * against its own base URL.
     *
     * <p>Quirk: the job reports {@code pending} for its first two polls regardless of
     * what it is importing, because the worker polls a queue on a fixed interval.
     */
    public void handleImports(HttpExchange exchange) {
        dispatch(exchange, this::imports);
    }

    private void imports(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var path = exchange.getRequestURI().getPath();
        var method = effectiveMethod(exchange);

        if (method.equals("POST") && path.equals("/api/imports")) {
            var id = "imp-" + System.nanoTime();
            imports.put(id, new AtomicInteger(0));
            exchange.getResponseHeaders().add("Location", "/api/imports/" + id);
            exchange.getResponseHeaders().add("Retry-After", "1");
            var payload = new JsonObject();
            payload.addProperty("id", id);
            payload.addProperty("state", "accepted");
            send(exchange, 202, "application/json", gson.toJson(payload));
            return;
        }

        if (method.equals("GET") && path.startsWith("/api/imports/")) {
            var id = path.substring("/api/imports/".length());
            var polls = imports.get(id);
            if (polls == null) {
                var inner = new JsonObject();
                inner.addProperty("code", "NOT_FOUND");
                inner.addProperty("message", "No such import job");
                var error = new JsonObject();
                error.add("error", inner);
                send(exchange, 404, "application/json", gson.toJson(error));
                return;
            }

            var payload = new JsonObject();
            payload.addProperty("id", id);
            if (polls.incrementAndGet() < 3) {
                payload.addProperty("state", "pending");
                payload.addProperty("progress", polls.get() * 33);
                exchange.getResponseHeaders().add("Retry-After", "1");
            } else {
                payload.addProperty("state", "done");
                payload.addProperty("progress", 100);
                payload.addProperty("importedAt", System.currentTimeMillis());
            }
            send(exchange, 200, "application/json", gson.toJson(payload));
            return;
        }

        send(exchange, 405, "application/json", "{\"error\":\"method not allowed\"}");
    }

    // -----------------------------------------------------------------------
    // GET /api/lookup — success reported in a header
    // -----------------------------------------------------------------------

    /**
     * The lookup proxy in front of the search index.
     *
     * <p>Quirk: it answers {@code 200} to everything. The proxy sits behind a load
     * balancer that was configured to treat any non-200 as a failed health check and
     * eject the node, so the team made the proxy stop emitting them. The real outcome
     * moved into {@code X-Error-Code}, which is the only place it has lived since.
     *
     * <p>This is the case a response *rule* handles well and a body union does not: the
     * distinguishing fact is in the envelope, just not in the status line.
     */
    public void handleLookup(HttpExchange exchange) {
        dispatch(exchange, this::lookup);
    }

    private void lookup(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var params = query(exchange);
        var term = params.getOrDefault("q", "");

        if (term.contains("\"") || term.contains(":")) {
            exchange.getResponseHeaders().add("X-Error-Code", "SEARCH_SYNTAX");
            var payload = new JsonObject();
            payload.addProperty("message", "Unbalanced quote or field selector in query");
            payload.addProperty("query", term);
            send(exchange, 200, "application/json", gson.toJson(payload));
            return;
        }

        var matches = new JsonArray();
        for (var project : store.listProjects(null)) {
            if (project.name().toLowerCase().contains(term.toLowerCase())) {
                var hit = new JsonObject();
                hit.addProperty("id", project.id());
                hit.addProperty("label", project.name());
                matches.add(hit);
            }
        }

        var payload = new JsonObject();
        payload.add("matches", matches);
        send(exchange, 200, "application/json", gson.toJson(payload));
    }

    // -----------------------------------------------------------------------
    // Pagination with a Link header
    // -----------------------------------------------------------------------

    /**
     * Adds {@code X-Total-Count} and an RFC 5988 {@code Link} header to a listing.
     *
     * <p>Quirk: the query parameter is 1-based and human-friendly, because it was added
     * first and a product manager asked for it. The {@code Link} header is 0-based,
     * because it was added two years later by someone reading GitHub's documentation
     * too quickly. Both are the public contract now, and a client following a link has
     * to convert.
     */
    List<Store.Project> paginate(HttpExchange exchange, List<Store.Project> all) {
        var params = query(exchange);
        var page = Math.max(1, parseInt(params.get("page"), 1));
        var pageSize = Math.max(1, parseInt(params.get("pageSize"), 2));
        var from = Math.min((page - 1) * pageSize, all.size());
        var to = Math.min(from + pageSize, all.size());

        var headers = exchange.getResponseHeaders();
        headers.add("X-Total-Count", Integer.toString(all.size()));

        var links = new ArrayList<String>();
        var base = "http://localhost:4300" + exchange.getRequestURI().getPath();
        // Offsets, not page numbers, and zero-based.
        if (to < all.size()) {
            links.add("<" + base + "?offset=" + to + "&pageSize=" + pageSize + ">; rel=\"next\"");
        }
        if (from > 0) {
            links.add("<" + base + "?offset=" + Math.max(0, from - pageSize) + "&pageSize=" + pageSize + ">; rel=\"prev\"");
        }
        links.add("<" + base + "?offset=0&pageSize=" + pageSize + ">; rel=\"first\"");
        var lastOffset = Math.max(0, ((all.size() - 1) / pageSize) * pageSize);
        links.add("<" + base + "?offset=" + lastOffset + "&pageSize=" + pageSize + ">; rel=\"last\"");
        headers.add("Link", String.join(", ", links));

        return all.subList(from, to);
    }

    private int parseInt(String value, int fallback) {
        if (value == null || value.isBlank()) return fallback;
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /** Exposes the override rule to {@link Routes}, which shares the same gateway. */
    String methodFor(HttpExchange exchange) {
        return effectiveMethod(exchange);
    }
}
