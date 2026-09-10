/** Password hashing. Deliberately simple (scrypt, no pepper/rotation) — this is a test server. */
import * as NodeCrypto from "node:crypto";
import { Effect } from "effect";
import { Password, PasswordHash } from "@realworld/domain";

const SCRYPT_KEY_LENGTH = 32;

export const hashPassword = (password: Password): Effect.Effect<PasswordHash> =>
  Effect.promise(
    () =>
      new Promise<PasswordHash>((resolve, reject) => {
        const salt = NodeCrypto.randomBytes(16);
        NodeCrypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(PasswordHash.make(`${salt.toString("hex")}:${derivedKey.toString("hex")}`));
        });
      }),
  );

export const verifyPassword = (password: Password, hash: PasswordHash): Effect.Effect<boolean> =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const [saltHex, keyHex] = hash.split(":");
        if (!saltHex || !keyHex) {
          resolve(false);
          return;
        }
        const salt = Buffer.from(saltHex, "hex");
        const expected = Buffer.from(keyHex, "hex");
        NodeCrypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(derivedKey.length === expected.length && NodeCrypto.timingSafeEqual(derivedKey, expected));
        });
      }),
  );
