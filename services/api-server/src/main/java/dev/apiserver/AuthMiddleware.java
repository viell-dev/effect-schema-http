package dev.apiserver;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

/**
 * Authentication middleware that validates tokens by calling the ID Server's
 * {@code /introspect} endpoint.
 *
 * <p>Quirk: the API server requires {@code Authorization: Token <value>}, not
 * {@code Bearer <value>}. The API predates the widespread adoption of RFC 6750;
 * it used a custom scheme and never migrated. The ID server issues Bearer tokens,
 * but this server expects "Token" — the client must translate.
 */
public class AuthMiddleware {
    private final String idServerUrl;
    private final HttpClient httpClient;
    private final Gson gson;

    public AuthMiddleware(String idServerUrl) {
        this.idServerUrl = idServerUrl;
        this.httpClient = HttpClient.newHttpClient();
        this.gson = new Gson();
    }

    /**
     * Validate a request's authorization header.
     *
     * @return the username if valid, or null if unauthorized
     */
    public String authenticate(String authHeader) {
        if (authHeader == null || authHeader.isBlank()) return null;

        var parts = authHeader.split(" ", 2);
        if (parts.length != 2) return null;

        // Quirk: only accepts "Token" scheme, not "Bearer".
        // The API predates RFC 6750 and used a custom scheme.
        var scheme = parts[0];
        if (!scheme.equalsIgnoreCase("Token")) return null;

        var accessToken = parts[1];
        return introspect(accessToken);
    }

    private String introspect(String token) {
        try {
            var body = gson.toJson(new TokenRequest(token));
            var request = HttpRequest.newBuilder()
                .uri(URI.create(idServerUrl + "/introspect"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

            var response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) return null;

            var result = gson.fromJson(response.body(), JsonObject.class);
            if (result.has("active") && result.get("active").getAsBoolean()) {
                return result.has("username")
                    ? result.get("username").getAsString()
                    : result.get("sub").getAsString();
            }
        } catch (IOException | InterruptedException e) {
            // Token validation failed — treat as unauthorized
        }
        return null;
    }

    private record TokenRequest(String token) {}
}
