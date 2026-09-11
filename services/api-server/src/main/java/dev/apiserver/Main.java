package dev.apiserver;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;

/**
 * REST/RPC API Server — "The main backend, started in 2014, Java 8 originally"
 *
 * <p>Runs on port 4300. Uses the JDK built-in HttpServer with Gson for JSON.
 * All the historical quirks are documented inline at their implementation site.
 */
public class Main {
    public static void main(String[] args) throws IOException {
        var store = new Store();
        var idServerUrl = System.getenv().getOrDefault("ID_SERVER_URL", "http://localhost:4100");
        var fileServerUrl = System.getenv().getOrDefault("FILE_SERVER_URL", "http://localhost:4200");
        var auth = new AuthMiddleware(idServerUrl);
        var routes = new Routes(store, auth, fileServerUrl);
        var legacy = new Legacy(store, auth);
        routes.withLegacy(legacy);

        var server = HttpServer.create(new InetSocketAddress(4300), 0);
        server.setExecutor(Executors.newFixedThreadPool(10));

        // Health check
        server.createContext("/health", exchange -> {
            var response = "ok".getBytes();
            exchange.getResponseHeaders().add("Access-Control-Allow-Origin", "*");
            exchange.sendResponseHeaders(200, response.length);
            try (var os = exchange.getResponseBody()) {
                os.write(response);
            }
        });

        // Projects CRUD
        server.createContext("/api/projects", routes::handleProjects);
        // Tasks (nested under projects)
        server.createContext("/api/tasks", routes::handleTasks);
        // Comments
        server.createContext("/api/comments", routes::handleComments);
        // Search
        server.createContext("/api/search", routes::handleSearch);
        // File attachment proxy
        server.createContext("/api/files", routes::handleFiles);

        // Endpoints that predate the ones above — see Legacy.java.
        server.createContext("/api/odata/Orders", legacy::handleOrders);
        server.createContext("/api/reports/grid", legacy::handleGrid);
        server.createContext("/api/v2/projects", legacy::handleVersionedProject);
        server.createContext("/api/batch", legacy::handleBatch);
        server.createContext("/api/imports", legacy::handleImports);
        server.createContext("/api/lookup", legacy::handleLookup);

        server.start();
        System.out.println("API Server listening on http://localhost:4300");
    }
}
