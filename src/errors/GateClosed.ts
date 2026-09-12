import { Data } from "effect";

/** A disposed interaction cannot start new work. Allocate another gate for a new interaction. */
export class GateClosed extends Data.TaggedError("GateClosed") {}
