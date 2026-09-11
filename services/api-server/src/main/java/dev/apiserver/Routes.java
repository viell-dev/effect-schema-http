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
import java.util.*;

/**
 * HTTP route handlers for the API server.
 *
 * <p>All the historical quirks are documented inline at their implementation site.
 * The general pattern: this is a Java 8-era backend that was upgraded piecemeal.
 * Timestamps are epoch milliseconds, error formats differ between 4xx and 5xx,
 * PATCH returns old state, pagination has an off-by-one between query params
 * and Link headers, and the auth scheme is "Token" not "Bearer".
 */
public class Routes {
    private final Store store;
    private final AuthMiddleware auth;
    private final String fileServerUrl;
    private final Gson gson;
    private Legacy legacy;

    public Routes(Store store, AuthMiddleware auth, String fileServerUrl) {
        this.store = store;
        this.auth = auth;
        this.fileServerUrl = fileServerUrl;
        this.gson = new GsonBuilder().disableHtmlEscaping().create();
    }

    /**
     * Shares the pagination and method-override rules with the older handlers.
     *
     * <p>Both live in {@link Legacy} because both arrived with the gateway, years after
     * the handlers in this file were written.
     */
    public void withLegacy(Legacy legacy) {
        this.legacy = legacy;
    }

    // -----------------------------------------------------------------------
    // CORS + utility
    // -----------------------------------------------------------------------

    private void addCorsHeaders(HttpExchange exchange) {
        var headers = exchange.getResponseHeaders();
        headers.add("Access-Control-Allow-Origin", "*");
        headers.add("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        headers.add("Access-Control-Allow-Headers", "Content-Type, Authorization");
        headers.add("Access-Control-Expose-Headers", "Link, Location, X-Total-Count");
    }

    private void handleCorsAndDispatch(HttpExchange exchange, RequestHandler handler) {
        try {
            addCorsHeaders(exchange);
            if ("OPTIONS".equalsIgnoreCase(exchange.getRequestMethod())) {
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            handler.handle(exchange);
        } catch (Exception e) {
            // Quirk: 5xx errors use a different format than 4xx.
            // 5xx just toString() the exception because the global handler was written
            // by someone in a hurry.
            try {
                sendError5xx(exchange, e);
            } catch (IOException ex) {
                // Nothing we can do
            }
        }
    }

    @FunctionalInterface
    interface RequestHandler {
        void handle(HttpExchange exchange) throws Exception;
    }

    private String readBody(HttpExchange exchange) throws IOException {
        return new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    }

    private void sendJson(HttpExchange exchange, int status, String json) throws IOException {
        var bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    /**
     * Send a 4xx error in the structured format.
     *
     * <p>Quirk: 4xx errors use {@code {"error": {"code": "...", "message": "..."}}}
     * because they are thrown from business logic with structured error types.
     */
    private void sendError4xx(HttpExchange exchange, int status, String code, String message)
            throws IOException {
        var error = new JsonObject();
        var inner = new JsonObject();
        inner.addProperty("code", code);
        inner.addProperty("message", message);
        error.add("error", inner);
        sendJson(exchange, status, gson.toJson(error));
    }

    /**
     * Send a 5xx error in the flat format.
     *
     * <p>Quirk: 5xx errors use {@code {"error": "string"}} because the global exception
     * handler just {@code .toString()}s the exception. Written by a different person
     * than the 4xx error handling.
     */
    private void sendError5xx(HttpExchange exchange, Exception e) throws IOException {
        var error = new JsonObject();
        error.addProperty("error", e.getClass().getSimpleName() + ": " + e.getMessage());
        sendJson(exchange, 500, gson.toJson(error));
    }

    private String requireAuth(HttpExchange exchange) throws IOException {
        var authHeader = exchange.getRequestHeaders().getFirst("Authorization");
        var username = auth.authenticate(authHeader);
        if (username == null) {
            sendError4xx(exchange, 401, "UNAUTHORIZED", "Valid Token authorization required");
            return null;
        }
        return username;
    }

    private Map<String, String> parseQueryParams(String query) {
        if (query == null || query.isBlank()) return Map.of();
        var params = new LinkedHashMap<String, String>();
        for (var param : query.split("&")) {
            var kv = param.split("=", 2);
            var key = URLDecoder.decode(kv[0], StandardCharsets.UTF_8);
            var value = kv.length > 1 ? URLDecoder.decode(kv[1], StandardCharsets.UTF_8) : "";
            params.put(key, value);
        }
        return params;
    }

    /** Extract a path segment: given "/api/projects/abc" and index 3, returns "abc". */
    private String pathSegment(HttpExchange exchange, int index) {
        var parts = exchange.getRequestURI().getPath().split("/");
        return index < parts.length ? parts[index] : null;
    }

    // -----------------------------------------------------------------------
    // Project serialization
    // -----------------------------------------------------------------------

    private JsonObject projectToJson(Store.Project p) {
        var obj = new JsonObject();
        obj.addProperty("id", p.id());
        obj.addProperty("name", p.name());
        obj.addProperty("description", p.description());
        obj.addProperty("owner", p.owner());
        // Quirk: timestamps as epoch milliseconds (Java System.currentTimeMillis())
        obj.addProperty("createdAt", p.createdAt());
        obj.addProperty("updatedAt", p.updatedAt());
        return obj;
    }

    private JsonObject taskToJson(Store.Task t) {
        var obj = new JsonObject();
        obj.addProperty("id", t.id());
        obj.addProperty("projectId", t.projectId());
        obj.addProperty("title", t.title());
        obj.addProperty("description", t.description());
        // Quirk: status is the enum ORDINAL (int) in responses, not the name.
        // This is because of a Jackson @JsonValue on the enum's ordinal() in the
        // original code. Requests use the name (string).
        obj.addProperty("status", t.status().ordinal());
        obj.addProperty("assignee", t.assignee());
        obj.addProperty("priority", t.priority());
        obj.addProperty("createdAt", t.createdAt());
        obj.addProperty("updatedAt", t.updatedAt());
        return obj;
    }

    private JsonObject commentToJson(Store.Comment c) {
        var obj = new JsonObject();
        obj.addProperty("id", c.id());
        obj.addProperty("taskId", c.taskId());
        obj.addProperty("author", c.author());
        obj.addProperty("body", c.body());
        obj.addProperty("createdAt", c.createdAt());
        return obj;
    }

    // -----------------------------------------------------------------------
    // Projects handler
    // -----------------------------------------------------------------------

    public void handleProjects(HttpExchange exchange) {
        handleCorsAndDispatch(exchange, this::dispatchProjects);
    }

    private void dispatchProjects(HttpExchange exchange) throws Exception {
        var method = exchange.getRequestMethod().toUpperCase();
        var projectId = pathSegment(exchange, 3); // /api/projects/{id}

        switch (method) {
            case "GET" -> {
                if (projectId != null && !projectId.isBlank()) {
                    getProject(exchange, projectId);
                } else {
                    listProjects(exchange);
                }
            }
            case "POST" -> createProject(exchange);
            case "PATCH" -> {
                if (projectId == null || projectId.isBlank()) {
                    sendError4xx(exchange, 400, "BAD_REQUEST", "Project ID required for PATCH");
                    return;
                }
                patchProject(exchange, projectId);
            }
            case "DELETE" -> {
                if (projectId == null || projectId.isBlank()) {
                    sendError4xx(exchange, 400, "BAD_REQUEST", "Project ID required for DELETE");
                    return;
                }
                deleteProject(exchange, projectId);
            }
            default -> sendError4xx(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }
    }

    private void listProjects(HttpExchange exchange) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        var params = parseQueryParams(exchange.getRequestURI().getQuery());
        var owner = params.getOrDefault("owner", null);
        var projects = store.listProjects(owner);

        // Pagination is opt-in: a caller that sends no page parameter gets everything,
        // because that is what every existing consumer already depended on.
        if (params.containsKey("page") || params.containsKey("pageSize")) {
            projects = legacy.paginate(exchange, projects);
        }

        var arr = new JsonArray();
        for (var p : projects) arr.add(projectToJson(p));
        sendJson(exchange, 200, gson.toJson(arr));
    }

    private void getProject(HttpExchange exchange, String id) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        var project = store.getProject(id);
        if (project.isEmpty()) {
            sendError4xx(exchange, 404, "NOT_FOUND", "Project not found");
            return;
        }
        sendJson(exchange, 200, gson.toJson(projectToJson(project.get())));
    }

    private void createProject(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        var name = body.has("name") ? body.get("name").getAsString() : null;
        var description = body.has("description") ? body.get("description").getAsString() : "";

        if (name == null || name.isBlank()) {
            sendError4xx(exchange, 400, "VALIDATION_ERROR", "name is required");
            return;
        }

        var project = store.createProject(name, description, username);
        sendJson(exchange, 201, gson.toJson(projectToJson(project)));
    }

    /**
     * PATCH a project.
     *
     * <p>Quirk: returns the OLD state, not the new state. A developer misread
     * "return the resource" as "return what it was" and it shipped. Clients
     * adapted. Changing it would break the mobile app.
     */
    private void patchProject(HttpExchange exchange, String id) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        var name = body.has("name") ? body.get("name").getAsString() : null;
        var description = body.has("description") ? body.get("description").getAsString() : null;

        var old = store.updateProject(id, name, description);
        if (old.isEmpty()) {
            sendError4xx(exchange, 404, "NOT_FOUND", "Project not found");
            return;
        }
        // Returns the OLD state — the quirk
        sendJson(exchange, 200, gson.toJson(projectToJson(old.get())));
    }

    /**
     * DELETE a project.
     *
     * <p>Quirk: returns 204 with a body containing {"deleted": true}. A junior
     * developer added the body "for debugging" and it stuck. 204 with a body is
     * technically allowed by HTTP, but many clients ignore or choke on it.
     */
    private void deleteProject(HttpExchange exchange, String id) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        if (!store.deleteProject(id)) {
            sendError4xx(exchange, 404, "NOT_FOUND", "Project not found");
            return;
        }

        // Quirk: 204 with a body
        var body = "{\"deleted\":true}";
        var bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(204, bytes.length);
        try (var os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    // -----------------------------------------------------------------------
    // Tasks handler
    // -----------------------------------------------------------------------

    public void handleTasks(HttpExchange exchange) {
        handleCorsAndDispatch(exchange, this::dispatchTasks);
    }

    private void dispatchTasks(HttpExchange exchange) throws Exception {
        // Quirk: the gateway strips DELETE, so a raw DELETE never reaches this service
        // in production. It is refused here too, so the client cannot depend on a path
        // that only works in development.
        if ("DELETE".equalsIgnoreCase(exchange.getRequestMethod())) {
            exchange.getResponseHeaders().add("Allow", "GET, POST, PATCH");
            sendError4xx(
                exchange,
                405,
                "METHOD_NOT_ALLOWED",
                "The gateway strips DELETE; resend as POST with X-HTTP-Method-Override: DELETE");
            return;
        }
        var method = legacy.methodFor(exchange);
        var path = exchange.getRequestURI().getPath();
        // /api/tasks?projectId=xxx or /api/tasks/{id}
        var taskId = pathSegment(exchange, 3);

        switch (method) {
            case "GET" -> {
                if (taskId != null && !taskId.isBlank()) {
                    getTask(exchange, taskId);
                } else {
                    listTasks(exchange);
                }
            }
            case "POST" -> createTask(exchange);
            case "PATCH" -> {
                if (taskId == null || taskId.isBlank()) {
                    sendError4xx(exchange, 400, "BAD_REQUEST", "Task ID required for PATCH");
                    return;
                }
                patchTask(exchange, taskId);
            }
            case "DELETE" -> {
                if (taskId == null || taskId.isBlank()) {
                    sendError4xx(exchange, 400, "BAD_REQUEST", "Task ID required for DELETE");
                    return;
                }
                deleteTask(exchange, taskId);
            }
            default -> sendError4xx(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }
    }

    private void listTasks(HttpExchange exchange) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        var params = parseQueryParams(exchange.getRequestURI().getQuery());
        var projectId = params.get("projectId");
        if (projectId == null || projectId.isBlank()) {
            sendError4xx(exchange, 400, "BAD_REQUEST", "projectId query parameter is required");
            return;
        }

        var tasks = store.listTasks(projectId);
        var arr = new JsonArray();
        for (var t : tasks) arr.add(taskToJson(t));
        sendJson(exchange, 200, gson.toJson(arr));
    }

    private void getTask(HttpExchange exchange, String id) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        var task = store.getTask(id);
        if (task.isEmpty()) {
            sendError4xx(exchange, 404, "NOT_FOUND", "Task not found");
            return;
        }
        sendJson(exchange, 200, gson.toJson(taskToJson(task.get())));
    }

    private void createTask(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        var projectId = body.has("projectId") ? body.get("projectId").getAsString() : null;
        var title = body.has("title") ? body.get("title").getAsString() : null;
        var description = body.has("description") ? body.get("description").getAsString() : "";
        // Quirk: status in requests is the NAME (string), not the ordinal (int).
        var status = body.has("status") ? body.get("status").getAsString() : "OPEN";
        var assignee = body.has("assignee") ? body.get("assignee").getAsString() : "";
        var priority = body.has("priority") ? body.get("priority").getAsInt() : 0;

        if (projectId == null || projectId.isBlank() || title == null || title.isBlank()) {
            sendError4xx(exchange, 400, "VALIDATION_ERROR", "projectId and title are required");
            return;
        }

        var task = store.createTask(projectId, title, description, status, assignee, priority);
        sendJson(exchange, 201, gson.toJson(taskToJson(task)));
    }

    private void patchTask(HttpExchange exchange, String id) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        var title = body.has("title") ? body.get("title").getAsString() : null;
        var description = body.has("description") ? body.get("description").getAsString() : null;
        var status = body.has("status") ? body.get("status").getAsString() : null;
        var assignee = body.has("assignee") ? body.get("assignee").getAsString() : null;
        var priority = body.has("priority") ? body.get("priority").getAsInt() : null;

        var old = store.updateTask(id, title, description, status, assignee, priority);
        if (old.isEmpty()) {
            sendError4xx(exchange, 404, "NOT_FOUND", "Task not found");
            return;
        }
        // Same quirk as projects: returns old state
        sendJson(exchange, 200, gson.toJson(taskToJson(old.get())));
    }

    private void deleteTask(HttpExchange exchange, String id) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        if (!store.deleteTask(id)) {
            sendError4xx(exchange, 404, "NOT_FOUND", "Task not found");
            return;
        }
        var body = "{\"deleted\":true}";
        var bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(204, bytes.length);
        try (var os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    // -----------------------------------------------------------------------
    // Comments handler
    // -----------------------------------------------------------------------

    public void handleComments(HttpExchange exchange) {
        handleCorsAndDispatch(exchange, this::dispatchComments);
    }

    /**
     * Comments endpoint.
     *
     * <p>Quirk: creating a comment returns 200 (not 201) and the Location header
     * is relative, not absolute. The original servlet container resolved relative
     * URLs; the current setup doesn't, but the header was never fixed.
     */
    private void dispatchComments(HttpExchange exchange) throws Exception {
        var method = exchange.getRequestMethod().toUpperCase();

        switch (method) {
            case "GET" -> listComments(exchange);
            case "POST" -> createComment(exchange);
            default -> sendError4xx(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }
    }

    private void listComments(HttpExchange exchange) throws IOException {
        var username = requireAuth(exchange);
        if (username == null) return;

        var params = parseQueryParams(exchange.getRequestURI().getQuery());
        var taskId = params.get("taskId");
        if (taskId == null || taskId.isBlank()) {
            sendError4xx(exchange, 400, "BAD_REQUEST", "taskId query parameter is required");
            return;
        }

        var comments = store.listComments(taskId);
        var arr = new JsonArray();
        for (var c : comments) arr.add(commentToJson(c));
        sendJson(exchange, 200, gson.toJson(arr));
    }

    /**
     * Create a comment.
     *
     * <p>Quirk 1: returns 200, not 201. The original servlet was written before
     * anyone on the team cared about correct status codes.
     *
     * <p>Quirk 2: the Location header is RELATIVE ("/api/comments/{id}"), not
     * absolute. The old servlet container auto-resolved it; the current one doesn't.
     */
    private void createComment(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        var taskId = body.has("taskId") ? body.get("taskId").getAsString() : null;
        var commentBody = body.has("body") ? body.get("body").getAsString() : null;

        if (taskId == null || taskId.isBlank() || commentBody == null || commentBody.isBlank()) {
            sendError4xx(exchange, 400, "VALIDATION_ERROR", "taskId and body are required");
            return;
        }

        var comment = store.createComment(taskId, username, commentBody);

        // Quirk: Location is relative, not absolute
        exchange.getResponseHeaders().add("Location", "/api/comments/" + comment.id());

        // Quirk: 200, not 201
        sendJson(exchange, 200, gson.toJson(commentToJson(comment)));
    }

    // -----------------------------------------------------------------------
    // Search handler
    // -----------------------------------------------------------------------

    public void handleSearch(HttpExchange exchange) {
        handleCorsAndDispatch(exchange, this::dispatchSearch);
    }

    /**
     * Search across projects and tasks.
     *
     * <p>Quirk 1: returns a single JSON object (not wrapped in an array) when there
     * is exactly one result. This is from an early Jackson configuration with
     * WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED.
     *
     * <p>Quirk 2: pagination uses 1-based {@code page} query param, but the
     * {@code Link} header uses 0-based offsets. Pagination was added in two phases:
     * query params first (1-based, human-friendly), Link headers later (0-based,
     * copied from GitHub's docs and implemented wrong).
     */
    private void dispatchSearch(HttpExchange exchange) throws Exception {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendError4xx(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
            return;
        }

        var username = requireAuth(exchange);
        if (username == null) return;

        var params = parseQueryParams(exchange.getRequestURI().getQuery());
        var query = params.getOrDefault("q", "");
        var page = Integer.parseInt(params.getOrDefault("page", "1"));
        var pageSize = Integer.parseInt(params.getOrDefault("pageSize", "10"));

        if (query.isBlank()) {
            sendError4xx(exchange, 400, "BAD_REQUEST", "q query parameter is required");
            return;
        }

        var results = store.search(query, page, pageSize);
        var total = store.searchTotal(query);
        var totalPages = (int) Math.ceil((double) total / pageSize);

        // Add pagination headers
        exchange.getResponseHeaders().add("X-Total-Count", String.valueOf(total));

        // Quirk: Link header uses 0-BASED offsets, not 1-based pages.
        // This is an off-by-one: page 1 in the query corresponds to offset 0 in Link.
        var links = new ArrayList<String>();
        if (page < totalPages) {
            // "next" link uses 0-based offset (page - 1 + 1 = page)
            // but confusingly labels it as "page" in the URL despite being 0-based
            links.add("<http://localhost:4300/api/search?q=" + query + "&page=" + (page) +
                "&pageSize=" + pageSize + ">; rel=\"next\"");
        }
        if (page > 1) {
            links.add("<http://localhost:4300/api/search?q=" + query + "&page=" + (page - 2) +
                "&pageSize=" + pageSize + ">; rel=\"prev\"");
        }
        if (!links.isEmpty()) {
            exchange.getResponseHeaders().add("Link", String.join(", ", links));
        }

        // Quirk: single result → unwrapped object, multiple → array
        if (results.isEmpty()) {
            sendJson(exchange, 200, "[]");
        } else if (results.size() == 1) {
            // Single result: return as a bare object, not wrapped in an array
            sendJson(exchange, 200, gson.toJson(results.getFirst()));
        } else {
            sendJson(exchange, 200, gson.toJson(results));
        }
    }

    // -----------------------------------------------------------------------
    // Files handler (proxy to File Server)
    // -----------------------------------------------------------------------

    public void handleFiles(HttpExchange exchange) {
        handleCorsAndDispatch(exchange, this::dispatchFiles);
    }

    /**
     * Proxy file operations to the SOAP File Server.
     *
     * <p>The API server proxies file uploads and downloads through the File Server,
     * translating between JSON (client-facing) and SOAP (file-server-facing).
     */
    private void dispatchFiles(HttpExchange exchange) throws Exception {
        var method = exchange.getRequestMethod().toUpperCase();

        switch (method) {
            case "GET" -> getFileProxy(exchange);
            case "POST" -> uploadFileProxy(exchange);
            default -> sendError4xx(exchange, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
        }
    }

    private void getFileProxy(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        var fileId = pathSegment(exchange, 3); // /api/files/{id}
        if (fileId == null || fileId.isBlank()) {
            sendError4xx(exchange, 400, "BAD_REQUEST", "File ID required");
            return;
        }

        // Build SOAP request to File Server
        var soapRequest = """
            <?xml version="1.0" encoding="UTF-8"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
                           xmlns:fs="urn:filestore:2011">
              <soap:Body>
                <fs:DownloadFile>
                  <fs:FileId>%s</fs:FileId>
                </fs:DownloadFile>
              </soap:Body>
            </soap:Envelope>""".formatted(fileId);

        var client = java.net.http.HttpClient.newHttpClient();
        var request = java.net.http.HttpRequest.newBuilder()
            .uri(java.net.URI.create(fileServerUrl + "/"))
            .header("Content-Type", "text/xml")
            .method("GET", java.net.http.HttpRequest.BodyPublishers.ofString(soapRequest))
            .build();

        var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofByteArray());
        var contentType = response.headers().firstValue("Content-Type").orElse("application/octet-stream");

        // Forward the raw bytes to the client
        exchange.getResponseHeaders().add("Content-Type", contentType);
        exchange.sendResponseHeaders(200, response.body().length);
        try (var os = exchange.getResponseBody()) {
            os.write(response.body());
        }
    }

    private void uploadFileProxy(HttpExchange exchange) throws Exception {
        var username = requireAuth(exchange);
        if (username == null) return;

        // Read the JSON upload request from the client
        var body = JsonParser.parseString(readBody(exchange)).getAsJsonObject();
        var fileName = body.has("fileName") ? body.get("fileName").getAsString() : null;
        var contentType = body.has("contentType") ? body.get("contentType").getAsString() : "application/octet-stream";
        var fileDataB64 = body.has("fileData") ? body.get("fileData").getAsString() : null;

        if (fileName == null || fileDataB64 == null) {
            sendError4xx(exchange, 400, "VALIDATION_ERROR", "fileName and fileData (base64) are required");
            return;
        }

        // Get the user's access token to forward to the File Server
        var authHeader = exchange.getRequestHeaders().getFirst("Authorization");
        var token = authHeader != null ? authHeader.split(" ", 2)[1] : "";

        // Build SOAP request
        var soapRequest = """
            <?xml version="1.0" encoding="UTF-8"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
                           xmlns:fs="urn:filestore:2011">
              <soap:Body>
                <fs:UploadFile>
                  <fs:FileName>%s</fs:FileName>
                  <fs:ContentType>%s</fs:ContentType>
                  <fs:FileData>%s</fs:FileData>
                </fs:UploadFile>
              </soap:Body>
            </soap:Envelope>""".formatted(fileName, contentType, fileDataB64);

        var client = java.net.http.HttpClient.newHttpClient();
        var request = java.net.http.HttpRequest.newBuilder()
            .uri(java.net.URI.create(fileServerUrl + "/"))
            .header("Content-Type", "text/xml")
            .header("Authorization", "Bearer " + token)
            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(soapRequest))
            .build();

        var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());

        // Parse the SOAP response and translate to JSON
        var result = new JsonObject();
        result.addProperty("status", "uploaded");
        result.addProperty("soapResponse", response.body());
        sendJson(exchange, 200, gson.toJson(result));
    }
}
