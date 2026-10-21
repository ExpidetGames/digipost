/**
 * The single error body shape every route that adopts the pipeline shares:
 * `{ "errorCode": <string> }` at the given status, never the triggering error's
 * own message or stack (WEBAPP_TEMPLATE_SPEC.md §7's request-path table, this
 * owner's brief: "no stack traces to clients").
 *
 * `body`/`headers` are additive, optional escape hatches for a route whose
 * contract predates the pipeline, or otherwise needs to keep a different body
 * shape or extra headers (a `retry-after` on 429, for example) - a route that
 * never sets them gets exactly `{ errorCode }` with the request-id header below
 * and nothing else.
 */
export type ApiErrorResponse<TErrorCode extends string> = {
  errorCode: TErrorCode;
  status: number;
  /** Overrides the default `{ errorCode }` body. Omit to get the standard envelope. */
  body?: unknown;
  /** Extra response headers (merged into the JSON response). Omit for none. */
  headers?: Record<string, string>;
};

/**
 * Builds the error `Response`. Every error response the pipeline itself produces
 * carries `x-request-id` (`core/request-id.ts`) so a client-reported error code can
 * be correlated with the matching server-side log line
 * (`core/handler-factory.ts`'s `logUnhandledError`) without the body or headers
 * ever exposing the underlying error.
 */
export function apiErrorResponse<TErrorCode extends string>(error: ApiErrorResponse<TErrorCode>, requestId: string): Response {
  return Response.json(error.body ?? { errorCode: error.errorCode }, {
    status: error.status,
    headers: { "x-request-id": requestId, ...error.headers },
  });
}
