import { Context, Ref } from "effect";
import type * as Transport from "../Transport.js";

/** A fresh reference per compilation carries schema-encoded lines through native preparation. */
export class HeaderState extends Context.Reference<HeaderState>()("viell-effect-schema-http/internal/HeaderState", {
  defaultValue: () => Ref.unsafeMake<Transport.Lines>([]),
}) {}
