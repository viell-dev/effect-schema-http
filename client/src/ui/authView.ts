import { Effect } from "effect";
import { toEffect } from "viell-effect-schema-http";
import { h } from "../dom.js";
import { run } from "../runtime.js";
import {
  getUserInfo,
  register,
  requestToken,
} from "../services/idClient.js";
import { clearSession, getSession, setSession } from "../session.js";

export const renderAuthView = (): HTMLElement => {
  const logBox = h("div", { class: "log-box" }, "Ready for auth actions...");

  const appendLog = (msg: string) => {
    logBox.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n\n${logBox.textContent}`;
  };

  // Register Form
  const regUser = h("input", { type: "text", placeholder: "Username", value: "carol" });
  const regEmail = h("input", { type: "email", placeholder: "Email", value: "carol@example.com" });
  const regPass = h("input", { type: "password", placeholder: "Password", value: "secret123" });
  const regBtn = h("button", { class: "btn btn-primary" }, "Register (ID Server)");

  regBtn.onclick = async () => {
    try {
      appendLog(`Sending register request for user "${regUser.value}"...`);
      const res = await run(
        register()
          .setBody({
            username: regUser.value,
            email: regEmail.value,
            password: regPass.value,
            display_name: regUser.value,
          })
          .pipe(toEffect),
      );
      appendLog(`✓ Registered 201 Created: ${JSON.stringify(res.body, null, 2)}`);
    } catch (err) {
      appendLog(`✗ Register failed: ${String(err)}`);
    }
  };

  // Login Form
  const loginUser = h("input", { type: "text", placeholder: "Username", value: "carol" });
  const loginPass = h("input", { type: "password", placeholder: "Password", value: "secret123" });
  const loginBtn = h("button", { class: "btn btn-primary" }, "Login (Password Grant)");

  loginBtn.onclick = async () => {
    try {
      appendLog(`Authenticating "${loginUser.value}"...`);
      const res = await run(
        requestToken()
          .setBody({
            grant_type: "password",
            username: loginUser.value,
            password: loginPass.value,
          })
          .pipe(toEffect),
      );

      const tokenData = res.body;
      setSession({
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
        username: loginUser.value,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
      });

      appendLog(`✓ Login succeeded!\nAccess Token: ${tokenData.access_token}\nToken Type: ${tokenData.token_type} (Quirk: normalized from raw wire value)\nRefresh Token: ${tokenData.refresh_token.slice(0, 30)}...`);
    } catch (err) {
      appendLog(`✗ Login failed: ${String(err)}`);
    }
  };

  // Refresh Token Form
  const refreshBtn = h("button", { class: "btn btn-outline" }, "Refresh Token (JWT Grant)");
  refreshBtn.onclick = async () => {
    const session = getSession();
    if (!session?.refreshToken) {
      appendLog("✗ No refresh token in session. Please login first.");
      return;
    }
    try {
      appendLog("Requesting token refresh with JWT refresh token...");
      const res = await run(
        requestToken()
          .setBody({
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
          })
          .pipe(toEffect),
      );
      const tokenData = res.body;
      setSession({
        ...session,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenType: tokenData.token_type,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
      });
      appendLog(`✓ Token refreshed!\nAccess Token: ${tokenData.access_token}\nQuirk: Refresh grant returned "Bearer" with capital B`);
    } catch (err) {
      appendLog(`✗ Refresh failed: ${String(err)}`);
    }
  };

  // Userinfo
  const userInfoBtn = h("button", { class: "btn btn-outline" }, "Fetch User Info (GET /userinfo)");
  userInfoBtn.onclick = async () => {
    try {
      appendLog("Fetching userinfo from ID server...");
      const res = await run(getUserInfo().pipe(toEffect));
      appendLog(`✓ User Info: ${JSON.stringify(res.body, null, 2)}`);
    } catch (err) {
      appendLog(`✗ Userinfo failed (Quirk: decoded as SimpleError if 401/404): ${String(err)}`);
    }
  };

  // Logout
  const logoutBtn = h("button", { class: "btn btn-danger" }, "Logout / Clear Session");
  logoutBtn.onclick = () => {
    clearSession();
    appendLog("✓ Session cleared.");
  };

  // Trigger rate limit
  const rateLimitBtn = h("button", { class: "btn btn-outline" }, "Trigger Rate Limit (12 quick requests)");
  rateLimitBtn.onclick = async () => {
    appendLog("Sending 12 rapid token requests to trigger rate limit (max 10/min)...");
    for (let i = 1; i <= 12; i++) {
      try {
        await run(
          requestToken()
            .setBody({
              grant_type: "password",
              username: "carol",
              password: "wrongpassword",
            })
            .pipe(toEffect),
        );
      } catch (err: any) {
        appendLog(`Attempt ${i}: ${String(err?.message || err)}`);
        if (String(err).includes("429") || String(err).includes("rate_limited")) {
          appendLog("✓ Quirk hit: 429 Too Many Requests with HTTP-date Retry-After!");
          break;
        }
      }
    }
  };

  return h(
    "div",
    {},
    h(
      "div",
      { class: "quirk-callout" },
      h("strong", {}, "Historical Quirks on ID Server (Port 4100):"),
      h("br"),
      "1. Access tokens are opaque strings (security team 2019), but refresh tokens are JWTs (contractor 2020).",
      h("br"),
      "2. Password grant returns token_type 'bearer' (lowercase), refresh grant returns 'Bearer' (capitalized).",
      h("br"),
      "3. Error shapes: /token uses OAuth2 spec {error, error_description}, while /userinfo uses {message}.",
      h("br"),
      "4. Rate limiter (429) returns Retry-After as an HTTP-date string (RFC 1123), not seconds.",
    ),
    h(
      "div",
      { class: "grid" },
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-title" }, "Register Account"),
        h("div", { class: "form-group" }, h("label", {}, "Username"), regUser),
        h("div", { class: "form-group" }, h("label", {}, "Email"), regEmail),
        h("div", { class: "form-group" }, h("label", {}, "Password"), regPass),
        regBtn,
      ),
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-title" }, "Login & Session"),
        h("div", { class: "form-group" }, h("label", {}, "Username"), loginUser),
        h("div", { class: "form-group" }, h("label", {}, "Password"), loginPass),
        h(
          "div",
          { style: "display: flex; gap: 0.5rem; flex-wrap: wrap;" },
          loginBtn,
          refreshBtn,
          userInfoBtn,
          logoutBtn,
        ),
        h("div", { style: "margin-top: 1rem;" }, rateLimitBtn),
      ),
    ),
    h("div", { class: "panel" }, h("div", { class: "panel-title" }, "Activity Log"), logBox),
  );
};
