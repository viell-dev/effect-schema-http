/**
 * Branded scalar primitives shared across the domain and the wire schemas.
 *
 * These demonstrate the "advanced schema tricks" this test project exists to exercise:
 * `Schema.brand` for nominal typing, `Schema.filter`-based combinators (`pattern`, `positive`,
 * `nonNegative`, `minLength`/`maxLength`) for refinement, and per-schema `arbitrary`/`pretty`/
 * `equivalence` annotations so every primitive is directly usable with fast-check, `Pretty.make`,
 * and `Schema.equivalence` without the consuming code writing any of that by hand.
 */
import { Schema } from "effect";

/** A strictly positive integer, i.e. a "NonZeroPositiveInteger". Used for page numbers, limits. */
export const NonZeroPositiveInt = Schema.Int.pipe(
  Schema.positive(),
  Schema.brand("NonZeroPositiveInt"),
  Schema.annotations({
    identifier: "NonZeroPositiveInt",
    arbitrary: () => (fc) => fc.integer({ min: 1, max: 1_000_000 }).map((value) => value as never),
  }),
);
export type NonZeroPositiveInt = typeof NonZeroPositiveInt.Type;

/** A zero-or-greater integer. Used for counters such as comment counts. */
export const NonNegativeInt = Schema.Int.pipe(
  Schema.nonNegative(),
  Schema.brand("NonNegativeInt"),
  Schema.annotations({
    identifier: "NonNegativeInt",
    arbitrary: () => (fc) => fc.integer({ min: 0, max: 1_000_000 }).map((value) => value as never),
  }),
);
export type NonNegativeInt = typeof NonNegativeInt.Type;

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{1,22}[a-z0-9])?$/;
const USERNAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 3-24 chars, lowercase alphanumerics plus `-`/`_`, never starting or ending with `-`/`_`. */
export const Username = Schema.String.pipe(
  Schema.pattern(USERNAME_PATTERN, {
    message: () => "username must be 3-24 lowercase alphanumeric characters, '-' or '_' (not first/last)",
  }),
  Schema.brand("Username"),
  Schema.annotations({
    identifier: "Username",
    // The pattern-derived arbitrary generates plain strings and filters them, which is slow and
    // can even exhaust fast-check's retry budget for a pattern this specific. Generating directly
    // from the alphabet is both fast and correct by construction.
    arbitrary: () => (fc) =>
      fc
        .stringOf(fc.constantFrom(...USERNAME_ALPHABET.split("")), { minLength: 3, maxLength: 24 })
        .filter((value) => USERNAME_PATTERN.test(value))
        .map((value) => value as never),
  }),
);
export type Username = typeof Username.Type;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const Email = Schema.String.pipe(
  Schema.pattern(EMAIL_PATTERN, { message: () => "must be a valid email address" }),
  Schema.brand("Email"),
  Schema.annotations({
    identifier: "Email",
    arbitrary: () => (fc) =>
      fc
        .tuple(fc.stringOf(fc.constantFrom(...USERNAME_ALPHABET.split("")), { minLength: 1, maxLength: 10 }), fc.constantFrom("example.com", "mail.test", "example.org"))
        .map(([local, domain]) => `${local}@${domain}` as never),
  }),
);
export type Email = typeof Email.Type;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** URL-safe post identifier derived from a title, e.g. `"my-first-post"`. */
export const Slug = Schema.String.pipe(
  Schema.pattern(SLUG_PATTERN, { message: () => "must be a lowercase kebab-case slug" }),
  Schema.minLength(1),
  Schema.maxLength(96),
  Schema.brand("Slug"),
  Schema.annotations({
    identifier: "Slug",
    arbitrary: () => (fc) =>
      fc
        .array(fc.stringOf(fc.constantFrom(...USERNAME_ALPHABET.split("")), { minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 5,
        })
        .map((words) => words.join("-") as never),
  }),
);
export type Slug = typeof Slug.Type;

/**
 * A plaintext password as submitted by a client. Never stored; the server hashes it immediately.
 * The `pretty` annotation redacts the value so it cannot leak into logs, `Pretty.make` output, or
 * any place that formats a decoded request body for debugging.
 */
export const Password = Schema.String.pipe(
  Schema.minLength(8, { message: () => "password must be at least 8 characters" }),
  Schema.maxLength(128),
  Schema.brand("Password"),
  Schema.annotations({
    identifier: "Password",
    arbitrary: () => (fc) => fc.string({ minLength: 8, maxLength: 40 }).map((value) => value as never),
    pretty: () => () => "Password(<redacted>)",
  }),
);
export type Password = typeof Password.Type;

/** An opaque bcrypt/scrypt hash. Only ever lives on the server. */
export const PasswordHash = Schema.String.pipe(
  Schema.brand("PasswordHash"),
  Schema.annotations({
    identifier: "PasswordHash",
    pretty: () => () => "PasswordHash(<redacted>)",
  }),
);
export type PasswordHash = typeof PasswordHash.Type;

/** Free-text display name, 1-50 chars, trimmed. */
export const DisplayName = Schema.Trim.pipe(
  Schema.minLength(1),
  Schema.maxLength(50),
  Schema.brand("DisplayName"),
);
export type DisplayName = typeof DisplayName.Type;

/** Short author biography, up to 280 chars. */
export const Bio = Schema.String.pipe(Schema.maxLength(280), Schema.brand("Bio"));
export type Bio = typeof Bio.Type;
