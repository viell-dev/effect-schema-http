/**
 * Every server endpoint declared once with the `repo` library's `createApi`/`createRequest`.
 * This is the actual object of this test project: everything else exists to give this file
 * something realistic to call.
 */
import { Schema } from "effect";
import {
  AuthResponse,
  BlogResponse,
  Comment,
  CommentsResponse,
  ConflictError,
  CreateCommentInput,
  CreatePostInput,
  FeedResponse,
  ForbiddenError,
  LoginInput,
  NotFoundError,
  PostView,
  Profile,
  RegisterInput,
  UnauthorizedError,
  UpdatePostInput,
  ValidationError,
} from "@realworld/domain";
import { createApi, response, ResponseBody } from "viell-effect-schema-http";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

/**
 * The five domain errors are declared once as API-wide default response rules. Every endpoint
 * inherits them, so a 404 from a route nobody thought to override still decodes into a typed
 * `NotFoundError` instead of falling through to `UnhandledResponse`. Reusing the exact
 * `Schema.TaggedError` classes from `@realworld/domain` means the client decodes the identical
 * shape the server encoded — there is exactly one definition of what a `NotFoundError` looks like.
 */
const api = createApi(API_BASE_URL, {
  responses: [
    response({ _tag: "ValidationError", status: 400 }, ValidationError),
    response({ _tag: "UnauthorizedError", status: 401 }, UnauthorizedError),
    response({ _tag: "ForbiddenError", status: 403 }, ForbiddenError),
    response({ _tag: "NotFoundError", status: 404 }, NotFoundError),
    response({ _tag: "ConflictError", status: 409 }, ConflictError),
  ] as const,
});

/** `204 No Content` responses must opt into `ResponseBody.none` per the library's README: the
 * default JSON codec rejects empty bodies, and `none` cannot be installed as an implicit default. */
const noContent = response({ _tag: "noContent", status: 204 }, Schema.Void, { codec: ResponseBody.none });

export const register = api.createRequest({
  method: "POST",
  path: "/api/users",
  body: RegisterInput,
  responses: [response({ _tag: "created", status: 201 }, AuthResponse)],
});

export const login = api.createRequest({
  method: "POST",
  path: "/api/users/login",
  body: LoginInput,
  responses: [response({ _tag: "ok", status: 200 }, AuthResponse)],
});

export const currentUser = api.createRequest({
  method: "GET",
  path: "/api/user",
  responses: [response({ _tag: "ok", status: 200 }, Profile)],
});

export const getBlog = api.createRequest({
  method: "GET",
  path: "/api/blogs/:username",
  responses: [response({ _tag: "ok", status: 200 }, BlogResponse)],
});

export const listFeed = api.createRequest({
  method: "GET",
  path: "/api/posts",
  responses: [response({ _tag: "ok", status: 200 }, FeedResponse)],
});

export const createPost = api.createRequest({
  method: "POST",
  path: "/api/posts",
  body: CreatePostInput,
  responses: [response({ _tag: "created", status: 201 }, PostView)],
});

export const getPost = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug",
  responses: [response({ _tag: "ok", status: 200 }, PostView)],
});

export const updatePost = api.createRequest({
  method: "PUT",
  path: "/api/posts/:slug",
  body: UpdatePostInput,
  responses: [response({ _tag: "ok", status: 200 }, PostView)],
});

export const deletePost = api.createRequest({
  method: "DELETE",
  path: "/api/posts/:slug",
  responses: [noContent],
});

export const listComments = api.createRequest({
  method: "GET",
  path: "/api/posts/:slug/comments",
  responses: [response({ _tag: "ok", status: 200 }, CommentsResponse)],
});

export const createComment = api.createRequest({
  method: "POST",
  path: "/api/posts/:slug/comments",
  body: CreateCommentInput,
  responses: [response({ _tag: "created", status: 201 }, Comment)],
});

export const deleteComment = api.createRequest({
  method: "DELETE",
  path: "/api/posts/:slug/comments/:commentId",
  responses: [noContent],
});
