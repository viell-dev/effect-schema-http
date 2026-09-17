import assert from "node:assert/strict";
import { chromium } from "playwright";

// Use Playwright's browser, or a locally installed executable without downloading another one.
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const baseUrl = process.env.CLIENT_URL ?? "http://localhost:5173";
const tab = (name) => page.getByRole("button", { name, exact: true }).click();
const action = async (name, pattern) => {
  const button = page.getByRole("button", { name, exact: true });
  const output = button.locator("xpath=ancestor::section").locator("pre.output");
  await button.click();
  await page.waitForFunction((name) => {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent === name);
    return button && !button.disabled;
  }, name);
  const text = await output.innerText();
  assert.match(text, pattern, `${name}\n${text}`);
  assert.doesNotMatch(text, /\nfailed:/u);
  console.log(`PASS ${name}`);
  return text;
};

try {
  for (const port of [4100, 4200, 4300, 4400, 4500]) {
    const response = await fetch(`http://localhost:${port}/health`);
    assert.equal(response.ok, true, `backend ${port} must be running`);
  }
  await page.goto(baseUrl);
  await page.getByLabel("username", { exact: true }).fill(`browser_${Date.now()}`);
  await action("Register", /created browser_/u);
  await action("Log in (JSON)", /signed in\ntoken_type decoded as Bearer/u);
  await action("Log in (form-encoded)", /decoded as Bearer/u);
  await action("Probe the token (HEAD)", /Fetch delivered 1/u);
  await action("Look up in the directory", /createdAt/u);
  await action("Fetch the key set", /BYPASS/u);
  await action("Narrow the scopes", /rejected:/u);
  await action("Correlate with a nonce (built-in retry)", /NonceReplayError/u);
  await action("Correlate with a nonce (own loop)", /succeeded on attempt 3/u);

  await tab("Business API (Java)");
  await action("Create a project", /createdAt arrived/u);
  await action("Rename it (PATCH)", /the stored value is/u);
  await action("Add a task", /decoded back to "IN_PROGRESS"/u);
  await action("List its tasks", /Reconcile the extract/u);

  await tab("Files (Python)");
  await action("Upload over SOAP", /stored [0-9a-f-]{36}/u);
  await action("List files", /Rapport Anné.txt/u);
  await action("Send an unquoted SOAPAction", /fault/u);
  await action("Read the metadata (SOAP 1.1)", /Rapport Anné.txt/u);
  await action("Read the archive document (SOAP 1.2)", /archivist:/u);
  await action("Fetch the contract (?wsdl, then ?wsdl=)", /bytes of WSDL/u);
  await action("PROPFIND the collection", /HTTP 207/u);
  await action("Upload multipart (the 2019 endpoint)", /Location:/u);
  await action("Download the bundle", /bonjour, ceci est un fichier/u);

  await tab("Reports (Perl)");
  await action("Sign in (credentials in the URL)", /session /u);
  await action("XML-RPC: report.list", /Rückstellungen/u);
  await action("XML-RPC: report.count", /4 records/u);
  await action("XML-RPC: an unknown method", /fault -32601/u);

  await tab("Notifications (Ruby)");
  await action("Open a session", /csrf token/u);
  // Browser Set-Cookie headers are intentionally invisible; the CSRF body supplies the credential.
  await action("Post one (signed)", /created/u);

  await tab("Reconciliation");
  await action("Sign in to the gateway", /gateway session/u);
  const input = page.getByPlaceholder("filter the live system and the nightly extract…");
  await input.fill("Rückstellungen");
  await page.waitForFunction(
    () => document.querySelector("section .blurb")?.textContent === "showing “Rückstellungen”",
  );
  assert.match(await page.locator("section").first().locator("pre").innerText(), /Rückstellungen/u);
  // Slow the browser network so a replaced flight is observable while it is active.
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 250,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const started = page.waitForRequest((request) => request.url().includes("/api/search?q=Ann"));
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.url().includes("/api/search?q=Ann") && request.failure()?.errorText === "net::ERR_ABORTED",
  });
  await input.fill("Ann");
  await started;
  await input.fill("Rückstellungen");
  await cancelled;
  await page.waitForFunction(
    () => document.querySelector("section .blurb")?.textContent === "showing “Rückstellungen”",
  );
  await network.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await action("Run the month-end reconciliation", /9\. Java|8\. Java\s+search finds/u);
  await input.fill("navigation cancels this");
  await tab("Identity (Rust)");
  await tab("Reconciliation");
  assert.equal(await page.locator("section").first().locator("pre").innerText(), "Ready.");
  assert.deepEqual(pageErrors, []);
  console.log("PASS interaction supersession, navigation disposal, and five-service browser saga");
} finally {
  await browser.close();
}
