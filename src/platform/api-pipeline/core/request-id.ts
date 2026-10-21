/**
 * A per-request id (`core/handler-factory.ts`/`core/responses.ts`) used to
 * correlate a client-visible error response (`x-request-id` header) with the full
 * error `handler-factory.ts` logs server-side: the client only ever sees an error
 * code and this id, never a message or a stack trace. `crypto.randomUUID()` is a
 * Web Crypto API global (Node, edge, and the browser alike), not a Node-only
 * import, which keeps this module runtime-neutral like the rest of `core/`.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}
