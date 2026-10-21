/**
 * Public entrypoint of `src/platform/api-pipeline`. Neutral (no `server-only`, no
 * `"use client"`): the step machine, request parsing, error mapping, and the
 * request-id generator all run in Node without touching a privileged import. The
 * access steps live behind `@/platform/api-pipeline/server` instead - they read
 * server env (`requireCronSecret`) or call `src/platform/auth/server`
 * (`requireSessionAccess`), both privileged.
 */
export { mapErrorCode, mapUseCaseError } from "./core/error-mapping";
export { createApiHandler, createApiHandlerFromContract, defineApiEndpointContract } from "./core/handler-factory";
export { newRequestId } from "./core/request-id";
export { parseJsonRequestWithSchema, parseQueryWithSchema } from "./core/request-validation";
export { apiErrorResponse, type ApiErrorResponse } from "./core/responses";
