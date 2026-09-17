import { HttpClient, type HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";

/** HMAC runs in the native HttpClient, after body encoding and once per attempt. */

/** Committed to the repository in 2011 and never rotated. */
const SHARED_SECRET = "notify-shared-secret-2011";

const encoder = new TextEncoder();

/** Reads the encoded request body back as text, which is what the signature covers. */
const bodyText = (body: HttpClientRequest.HttpClientRequest["body"]): string => {
  switch (body._tag) {
    case "Empty":
      return "";
    case "Uint8Array":
      return new TextDecoder().decode((body as unknown as { readonly body: Uint8Array }).body);
    case "Raw": {
      const raw = (body as unknown as { readonly body: unknown }).body;
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    default:
      // A stream or a multipart body cannot be signed without buffering it, which would
      // defeat the point of streaming it. The 2011 service never accepted either.
      throw new Error(`cannot sign a ${body._tag} body`);
  }
};

const hmacSha256 = (secret: string, message: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });

/**
 * Signs one request.
 *
 * The message is `METHOD\nPATH\nTIMESTAMP\nBODY`, which is the 2011 house style: no
 * canonical header set and no query string, so a signed request's query parameters are
 * not actually protected. That is a real weakness of the scheme and not something the
 * client can fix from this side — it is recorded here rather than quietly worked around.
 */
export const signNotifyRequest = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
  Effect.gen(function* () {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const path = new URL(request.url).pathname;
    const signature = yield* hmacSha256(
      SHARED_SECRET,
      `${request.method.toUpperCase()}\n${path}\n${timestamp}\n${bodyText(request.body)}`,
    );

    return {
      ...request,
      headers: { ...request.headers, "x-timestamp": timestamp, "x-signature": signature },
    } as HttpClientRequest.HttpClientRequest;
  });

/**
 * Sign every request this plan sends.
 *
 * Unlike a computed header, this resolves **per attempt**: `transformClient` wraps the client,
 * and the client is called again on every retry. A signature has a five-minute window,
 * so a retry that waited longer than that would fail with a header computed once — which
 * makes this the one place in the repository where per-attempt resolution is not merely
 * convenient but required.
 */
export const signed = HttpClient.mapRequestEffect(signNotifyRequest);

// ---------------------------------------------------------------------------
// HTTP Digest, 1997 edition
// ---------------------------------------------------------------------------

/**
 * The `WWW-Authenticate: Digest …` challenge, parsed.
 *
 * Digest is a two-round-trip scheme: the server answers `401` with a realm and a nonce,
 * and the client answers with an MD5 of the password, the nonce and the request line.
 * There is no way to skip the first trip, because the nonce is the server's.
 */
export const parseDigestChallenge = (header: string | undefined): Record<string, string> => {
  const fields: Record<string, string> = {};
  if (header === undefined || !/^Digest\s/iu.test(header)) return fields;
  for (const match of header.slice(7).matchAll(/([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/gu)) {
    fields[(match[1] ?? "").toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return fields;
};

/** MD5, which is what RFC 2069 specifies and what the 1999 Apache module implemented. */
const md5 = (value: string): string => {
  // WebCrypto does not implement MD5 — deliberately, and correctly, because it is broken.
  // A scheme from 1997 needs it anyway, so this is the algorithm written out. It is the
  // only hand-rolled cryptographic primitive in this repository and it exists solely
  // because the alternative is to not speak to the service at all.
  const bytes = new TextEncoder().encode(value);
  const words: Array<number> = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] = (words[index >> 2] ?? 0) | (bytes[index]! << ((index % 4) << 3));
  }
  words[bytes.length >> 2] = (words[bytes.length >> 2] ?? 0) | (0x80 << ((bytes.length % 4) << 3));
  const bitLength = bytes.length * 8;
  const padded = [...words];
  while (padded.length % 16 !== 14) padded.push(0);
  padded.push(bitLength & 0xffffffff, Math.floor(bitLength / 0x100000000));

  const add = (a: number, b: number) => (a + b) | 0;
  const rotate = (value_: number, shift: number) => (value_ << shift) | (value_ >>> (32 - shift));
  const step = (q: number, a: number, b: number, x: number, s: number, t: number) =>
    add(rotate(add(add(a, q), add(x, t)), s), b);
  const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    step((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    step((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    step(b ^ c ^ d, a, b, x, s, t);
  const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
    step(c ^ (b | ~d), a, b, x, s, t);

  const constants = [
    -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426, -1473231341, -45705983, 1770035416,
    -1958414417, -42063, -1990404162, 1804603682, -40341101, -1502002290, 1236535329, -165796510, -1069501632,
    643717713, -373897302, -701558691, 38016083, -660478335, -405537848, 568446438, -1019803690, -187363961, 1163531501,
    -1444681467, -51403784, 1735328473, -1926607734, -378558, -2022574463, 1839030562, -35309556, -1530992060,
    1272893353, -155497632, -1094730640, 681279174, -358537222, -722521979, 76029189, -640364487, -421815835, 530742520,
    -995338651, -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606, -1051523, -2054922799,
    1873313359, -30611744, -1560198380, 1309151649, -145523070, -1120210379, 718787259, -343485551,
  ];
  const shifts = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  const rounds = [ff, gg, hh, ii];
  const indexOf = [
    (i: number) => i,
    (i: number) => (5 * i + 1) % 16,
    (i: number) => (3 * i + 5) % 16,
    (i: number) => (7 * i) % 16,
  ];

  let [a0, b0, c0, d0] = [1732584193, -271733879, -1732584194, 271733878];
  for (let block = 0; block < padded.length; block += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i += 1) {
      const round = i >> 4;
      const operation = rounds[round]!;
      const shift = shifts[round]![i % 4]!;
      const word = padded[block + indexOf[round]!(i)] ?? 0;
      const next = operation(a, b, c, d, word, shift, constants[i]!);
      [a, d, c, b] = [d, c, b, next];
    }
    [a0, b0, c0, d0] = [add(a0, a), add(b0, b), add(c0, c), add(d0, d)];
  }

  return [a0, b0, c0, d0]
    .map((word) => [0, 1, 2, 3].map((byte) => (((word >> (byte * 8)) & 0xff) + 0x100).toString(16).slice(1)).join(""))
    .join("");
};

/**
 * Builds the `Authorization: Digest …` value for one challenge.
 *
 * RFC 2069: `HA1 = MD5(user:realm:password)`, `HA2 = MD5(method:uri)`, and the response
 * is `MD5(HA1:nonce:HA2)`. No `qop`, no client nonce, no nonce count — the 1997 form,
 * which is what the gateway's Apache module implemented and never moved past.
 */
export const digestAuthorization = (
  challenge: Record<string, string>,
  username: string,
  password: string,
  method: string,
  uri: string,
): string => {
  const realm = challenge["realm"] ?? "";
  const nonce = challenge["nonce"] ?? "";
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  const responseValue = md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseValue}"`;
};
