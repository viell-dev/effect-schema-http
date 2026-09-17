import { h } from "../dom.js";

/**
 * The inventory: every deliberate misbehaviour in the five services, what a tidy API
 * would have done, and what it cost the client.
 *
 * This view makes no requests. It summarizes the protocol cases exercised by the service tests.
 */

interface Quirk {
  readonly service: string;
  readonly quirk: string;
  readonly tidy: string;
  readonly cost: string;
}

const QUIRKS: ReadonlyArray<Quirk> = [
  { service: "Rust", quirk: "Three spellings of “bearer” from three code paths", tidy: "One spelling", cost: "One transformOrFail that fails on a fourth scheme rather than guessing" },
  { service: "Rust", quirk: "Opaque access tokens, JWT refresh tokens", tidy: "One token strategy", cost: "Nothing; the client never looks inside either" },
  { service: "Rust", quirk: "OAuth error shape on /token, {message} on /userinfo", tidy: "One envelope", cost: "Explicit-status cases placed before the shared fallback" },
  { service: "Rust", quirk: "429 with an HTTP-date Retry-After", tidy: "Delay-seconds", cost: "Nothing; the library honours both forms" },
  { service: "Rust", quirk: "expires_in as a string on the form grant", tidy: "A number", cost: "Schema.NumberFromString" },
  { service: "Rust", quirk: "RFC 7009 revocation: 200, JSON content type, zero bytes", tidy: "204", cost: "Body.empty with Schema.Void" },
  { service: "Rust", quirk: "A HEAD probe whose facts are all in headers", tidy: "A GET with a body", cost: "A schema applied to metadata.headers" },
  { service: "Rust", quirk: "JWKS behind a proxy that ignores Cache-Control", tidy: "Honour request directives", cost: "Fetch cache mode, Cache-Control, and a computed cache-busting parameter" },
  { service: "Rust", quirk: "Query-parameter authentication on the directory", tidy: "A header", cost: "A computed url parameter, and Request.removeHeader so no credential travels twice" },
  { service: "Rust", quirk: "SCREAMING field names, Y/N, LDAP time, blanks for absent", tidy: "JSON conventions", cost: "A wire schema and a transform into the domain shape" },
  { service: "Rust", quirk: "A missing user is 200 with ACTIVE: N", tidy: "404", cost: "Nulls in the domain type and a boolean nobody can ignore" },
  { service: "Rust", quirk: "Scopes as repeated X-Scope request lines", tidy: "One comma-joined value", cost: "A node:http provider; Fetch cannot send them" },
  { service: "Rust", quirk: "A nonce that must strictly increase", tidy: "Idempotency keys", cost: "A fresh nonce in per-attempt HttpClient middleware, or a caller-owned loop" },
  { service: "Rust", quirk: "grant_types_supported as a space-delimited string", tidy: "An array", cost: "The same combinator that reads scope" },
  { service: "Python", quirk: "Outcome inside a 200, in <FaultCode>", tidy: "Real statuses", cost: "A soapResult combinator producing a tagged union" },
  { service: "Python", quirk: "SOAPAction required and required to be quoted", tidy: "Anything", cost: "One declared header per action" },
  { service: "Python", quirk: "Single-element lists wrapped in an extra <Result>", tidy: "Consistent arrays", cost: "Read every <File> wherever it sits" },
  { service: "Python", quirk: "MM/dd/yyyy HH:mm:ss with no timezone", tidy: "ISO 8601", cost: "A transform that refuses anything looser" },
  { service: "Python", quirk: "?wsdl accepted only as a bare key", tidy: "Either form", cost: "Nothing; the library distinguishes null from \"\"" },
  { service: "Python", quirk: "SOAP 1.2 carries the action in the content type", tidy: "One protocol", cost: "Change the body codec, not the header — the codec owns it" },
  { service: "Python", quirk: "One action answers a real soap:Fault with 500", tidy: "Consistency", cost: "One more rule" },
  { service: "Python", quirk: "ISO-8859-1 documents under a bare text/xml", tidy: "A charset", cost: "Body.bytes and read the encoding from the document" },
  { service: "Python", quirk: "PROPFIND and 207 Multi-Status", tidy: "The same, honestly", cost: "Nothing; methods are strings and statuses are numbers" },
  { service: "Python", quirk: "A multipart bundle of metadata and bytes", tidy: "Two requests", cost: "Body.formData and an effectful schema transform" },
  { service: "Java", quirk: "Authorization: Token, not Bearer", tidy: "RFC 6750", cost: "One computed header" },
  { service: "Java", quirk: "Epoch-millisecond timestamps", tidy: "ISO 8601", cost: "One transform, shared with the Ruby service" },
  { service: "Java", quirk: "4xx is {error:{code,message}}, 5xx is {error:string}", tidy: "One envelope", cost: "Two rules" },
  { service: "Java", quirk: "PATCH answers with the state before the write", tidy: "The new state", cost: "Re-read, and never trust the response" },
  { service: "Java", quirk: "A status name in, an ordinal out", tidy: "One representation", cost: "One transform used in both directions" },
  { service: "Java", quirk: "Comments answer 200 with a relative Location", tidy: "201 and an absolute URI", cost: "Resolve it against the base URL" },
  { service: "Java", quirk: "Search unwraps a single-element array", tidy: "Always an array", cost: "A union normalized to an array" },
  { service: "Java", quirk: "64-bit ids above 2^53", tidy: "String ids", cost: "Body.text and a JSON dialect that quotes long integers" },
  { service: "Java", quirk: "An OData v2 {d:{results}} envelope with a stringified count", tidy: "The array", cost: "One transform, and no view ever sees it" },
  { service: "Java", quirk: "/Date(…)/, 0000-00-00, -1 for unlimited, $1,234.50", tidy: "Real types", cost: "One transform each, all reversible" },
  { service: "Java", quirk: "Four spellings of “no value” in one object", tidy: "One", cost: "Collapsed into Option at the boundary" },
  { service: "Java", quirk: "Positional report rows behind text/json", tidy: "Records", cost: "A transform that checks the column header rather than trusting it" },
  { service: "Java", quirk: "A batch endpoint whose envelope is always 200", tidy: "Real statuses", cost: "Discrimination in the schema, because the envelope cannot" },
  { service: "Java", quirk: "202 with a relative Location, then polling", tidy: "The same, honestly", cost: "A loop over a cold plan — not a retry" },
  { service: "Java", quirk: "Errors signalled by X-Error-Code on a 200", tidy: "A status", cost: "A header-matched rule, which ranks above the plain one" },
  { service: "Java", quirk: "1-based pages, 0-based Link offsets", tidy: "One base", cost: "The arithmetic, in one schema" },
  { service: "Java", quirk: "The gateway strips PUT and DELETE", tidy: "Let them through", cost: "A transform that rewrites the method and sets an override header" },
  { service: "Java", quirk: "A 204 that still tries to write a debug body", tidy: "No body", cost: "Nothing — the container has silently dropped it since 2015" },
  { service: "Perl", quirk: "Credentials in a query string", tidy: "A POST", cost: "Nothing the client can fix; the password is in every log" },
  { service: "Perl", quirk: "XML-RPC, faults inside 200s", tidy: "JSON and statuses", cost: "A text codec and an rpcResult combinator" },
  { service: "Perl", quirk: "Fixed-width Latin-1 records with no delimiters", tidy: "Anything", cost: "Body.bytes, positional parsing, and a checked control total" },
  { service: "Perl", quirk: "A CSV with a BOM, CRLF, semicolons and a decimal comma", tidy: "RFC 4180", cost: "Strip the BOM before it becomes part of a column name" },
  { service: "Perl", quirk: "Every failure is a 200", tidy: "Statuses", cost: "A header-matched rule, or a union in the schema" },
  { service: "Ruby", quirk: "HMAC over the encoded body", tidy: "A bearer token", cost: "transformClient with an effectful request transform — a computed header cannot" },
  { service: "Ruby", quirk: "A double-submitted CSRF token", tidy: "Nothing, for an API", cost: "Fetch it first, echo it in a header" },
  { service: "Ruby", quirk: "A )]}', guard before every JSON payload", tidy: "JSON", cost: "A text codec; the JSON codec fails on the first byte" },
  { service: "Ruby", quirk: "JSONP for a partner that predates CORS", tidy: "CORS", cost: "Match the exact wrapper and refuse anything else" },
  { service: "Ruby", quirk: "JSON served as text/html", tidy: "The right type", cost: "A header matcher that says so, and a text codec" },
  { service: "Ruby", quirk: "420 Enhance Your Calm", tidy: "429", cost: "Policy.make with an explicit 420 classifier" },
  { service: "Ruby", quirk: "A long poll that holds the connection open", tidy: "The same, honestly", cost: "Effect.timeout, and a TimeoutException rather than a response" },
  { service: "Ruby", quirk: "An absolutized Location, where Java sends a relative one", tidy: "Agreement", cost: "Resolve it either way; the container decides, not the code" },
];

export const renderQuirksView = (): HTMLElement => {
  const rows = QUIRKS.map((quirk) =>
    h(
      "tr",
      {},
      h("td", { class: `service service-${quirk.service.toLowerCase()}` }, quirk.service),
      h("td", {}, quirk.quirk),
      h("td", {}, quirk.tidy),
      h("td", {}, quirk.cost),
    ),
  );

  return h(
    "section",
    { class: "panel" },
    h("h2", {}, `Every deliberate misbehaviour (${QUIRKS.length})`),
    h(
      "p",
      { class: "blurb" },
      "Each of these exists in a production system right now. The interesting column is the last one: " +
        "what the client had to do about it. Most of them cost a declaration or a schema; three cost " +
        "something real, and one cannot be fixed from this side at all.",
    ),
    h(
      "table",
      { class: "quirks" },
      h("thead", {}, h("tr", {}, h("th", {}, "Service"), h("th", {}, "The oddity"), h("th", {}, "A tidy API would have"), h("th", {}, "What the client needed"))),
      h("tbody", {}, ...rows),
    ),
  );
};
