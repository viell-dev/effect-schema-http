import { HttpClientResponse } from "@effect/platform";

export const isHttpClientResponse = (input: unknown): input is HttpClientResponse.HttpClientResponse =>
  typeof input === "object" && input !== null && HttpClientResponse.TypeId in input;
