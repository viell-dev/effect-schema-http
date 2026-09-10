import { Schema } from "effect";
import { SessionToken } from "./ids.js";
import { Email, Password } from "./primitives.js";
import { Profile } from "./user.js";

export const LoginInput = Schema.Struct({
  email: Email,
  password: Password,
});
export type LoginInput = typeof LoginInput.Type;

export const AuthResponse = Schema.Struct({
  token: SessionToken,
  profile: Profile,
});
export type AuthResponse = typeof AuthResponse.Type;
