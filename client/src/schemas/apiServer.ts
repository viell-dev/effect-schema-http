import { Schema } from "effect";
import { EpochMillis, taggedBody } from "./common.js";

/**
 * Timestamps are epoch milliseconds as JSON numbers, because the 2014 backend called
 * `System.currentTimeMillis()` and nobody ever changed it.
 *
 * The transform itself lives in `common.ts`, because the Ruby notification service
 * copied this convention from here and the two now have to agree. One fact, one
 * definition — which is the only part of the "shared schema" model that survives when
 * the services are written in five different languages.
 */
export const EpochMsToDate = EpochMillis;

/**
 * Quirk: Task status asymmetry:
 * - Responses return an integer ordinal (0 = OPEN, 1 = IN_PROGRESS, 2 = REVIEW, 3 = DONE, 4 = CANCELLED).
 * - Requests accept the string name ("OPEN", "IN_PROGRESS", etc.).
 */
export const TaskStatusString = Schema.Literal(
  "OPEN",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
  "CANCELLED",
);
export type TaskStatusString = typeof TaskStatusString.Type;

const STATUS_ORDINALS: ReadonlyArray<TaskStatusString> = [
  "OPEN",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
  "CANCELLED",
];

export const TaskStatusFromOrdinal = Schema.transform(
  Schema.Number,
  TaskStatusString,
  {
    strict: true,
    decode: (ord) => STATUS_ORDINALS[ord] ?? "OPEN",
    encode: (status) => {
      const idx = STATUS_ORDINALS.indexOf(status);
      return idx >= 0 ? idx : 0;
    },
  },
);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  owner: Schema.String,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type Project = typeof Project.Type;

export const Task = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: TaskStatusFromOrdinal,
  assignee: Schema.String,
  priority: Schema.Number,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type Task = typeof Task.Type;

export const Comment = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  author: Schema.String,
  body: Schema.String,
  createdAt: EpochMillis,
});
export type Comment = typeof Comment.Type;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const CreateProjectInput = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
});

export const PatchProjectInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

export const CreateTaskInput = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.optional(TaskStatusString),
  assignee: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Number),
});

export const PatchTaskInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(TaskStatusString),
  assignee: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Number),
});

export const CreateCommentInput = Schema.Struct({
  taskId: Schema.String,
  body: Schema.String,
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * 4xx error: structured format { error: { code: string, message: string } }
 */
export const StructuredError = taggedBody("StructuredError", {
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
});
export type StructuredError = typeof StructuredError.Type;

/**
 * Quirk: 5xx error: flat format { error: string } (developer wrote .toString() on exception)
 */
export const FlatError = taggedBody("FlatError", {
  error: Schema.String,
});
export type FlatError = typeof FlatError.Type;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const ProjectSearchHit = Schema.Struct({
  type: Schema.Literal("project"),
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  updatedAt: EpochMillis,
});

export const TaskSearchHit = Schema.Struct({
  type: Schema.Literal("task"),
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: TaskStatusFromOrdinal,
  updatedAt: EpochMillis,
});

export const SearchHit = Schema.Union(ProjectSearchHit, TaskSearchHit);
export type SearchHit = typeof SearchHit.Type;

const EncodedSearchHit = Schema.encodedSchema(SearchHit);

/**
 * Quirk: Jackson WRITE_SINGLE_ELEM_ARRAYS_UNWRAPPED causes single-element search
 * results to return as a bare object instead of an array.
 * This transform normalizes bare objects or arrays into an array.
 */
export const SearchResults = Schema.transform(
  Schema.Union(Schema.Array(EncodedSearchHit), EncodedSearchHit),
  Schema.Array(SearchHit),
  {
    decode: (val) => (Array.isArray(val) ? val : [val]),
    encode: (val) => val,
  },
);

// ---------------------------------------------------------------------------
// File Proxy
// ---------------------------------------------------------------------------

export const FileProxyUploadInput = Schema.Struct({
  fileName: Schema.String,
  contentType: Schema.String,
  fileData: Schema.String, // base64
});

export const FileProxyUploadResponse = Schema.Struct({
  status: Schema.String,
  soapResponse: Schema.String,
});
