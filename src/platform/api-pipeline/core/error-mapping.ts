/**
 * `mapErrorCode` maps a source code through a partial table with an explicit
 * fallback. `mapUseCaseError` narrows a thrown `UseCaseError`
 * (`src/persistence/use-cases/errors.ts`, WEBAPP_TEMPLATE_SPEC.md §5.4) and maps its
 * `code` the same way, so an `execute` step's `mapError` can turn a use case's
 * stable error code into this route's own `ApiErrorResponse` without ever
 * forwarding the use case's raw message to the client.
 */
import { UseCaseError } from "@/persistence/use-cases/errors";

import type { ApiErrorResponse } from "./responses";

type ErrorCodeMap<TSourceCode extends string, TApiErrorCode extends string> = Partial<Record<TSourceCode, ApiErrorResponse<TApiErrorCode>>>;

export function mapErrorCode<TSourceCode extends string, TApiErrorCode extends string>(
  code: TSourceCode,
  mapping: ErrorCodeMap<TSourceCode, TApiErrorCode>,
  fallback: ApiErrorResponse<TApiErrorCode>,
): ApiErrorResponse<TApiErrorCode> {
  const mapped = mapping[code];
  if (mapped) {
    return mapped;
  }

  return fallback;
}

/**
 * Narrows a thrown `UseCaseError` and maps its `code` through an explicit table.
 * Returns `null` for anything that is not a `UseCaseError` (including no match in
 * `mapping` with no `fallback` given) so callers can chain it inside a step's
 * `mapError` and fall through to another mapper, or to the contract's
 * `unknownError` (which also gets the raw error logged server-side,
 * `core/handler-factory.ts`).
 */
export function mapUseCaseError<TUseCaseCode extends string, TApiErrorCode extends string>(
  error: unknown,
  mapping: ErrorCodeMap<TUseCaseCode, TApiErrorCode>,
  fallback?: ApiErrorResponse<TApiErrorCode>,
): ApiErrorResponse<TApiErrorCode> | null {
  if (!(error instanceof UseCaseError)) {
    return null;
  }

  const mapped = mapping[error.code as TUseCaseCode];
  if (mapped) {
    return mapped;
  }

  return fallback ?? null;
}
