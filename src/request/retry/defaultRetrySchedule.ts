import { Schedule } from "effect";
import { type RetrySchedule } from "../types.js";

export const defaultRetrySchedule: RetrySchedule = Schedule.jittered(Schedule.exponential("100 millis"));
