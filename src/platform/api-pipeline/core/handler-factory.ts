/**
 * The step machine every route built on this pipeline runs: `access` -> `parse` ->
 * `execute` -> `respond`, in that order. A failing step's error goes through that
 * step's own `mapError` (falling back to the endpoint contract's `unknownError`
 * when `mapError` is absent, returns nothing, or itself throws); a `parse` step
 * that returns `null` short-circuits straight to the contract's `invalidRequestError`
 * without ever calling `execute`. `access`/`parse` failing never runs a later step.
 *
 * Two things happen around every error response this factory builds, beyond what a
 * single route's own `mapError` decides: a per-request id
 * (`core/request-id.ts`) rides along in the `x-request-id` header
 * (`core/responses.ts`), and whenever no `mapError` claims the raw error (so the
 * client only ever gets the generic `unknownError`), that raw error is logged
 * server-side, tagged with the same request id - "no stack traces to clients"
 * without losing the ability to correlate a client-reported failure with what
 * actually happened.
 */
import { newRequestId } from "./request-id";
import { apiErrorResponse, type ApiErrorResponse } from "./responses";

type ApiStepErrorMapper<TErrorCode extends string> = (error: unknown) => ApiErrorResponse<TErrorCode> | null;

type ApiHandlerStep<TStepInput, TStepResult, TErrorCode extends string> = {
  run: (input: TStepInput) => Promise<TStepResult> | TStepResult;
  mapError?: ApiStepErrorMapper<TErrorCode>;
};

export type CreateApiHandlerOptions<TInput, TResult, TErrorCode extends string, TContext, TAccess> = {
  access?: ApiHandlerStep<{ request: Request; context: TContext }, TAccess, TErrorCode>;
  parse: ApiHandlerStep<{ request: Request; context: TContext }, TInput | null, TErrorCode>;
  execute: ApiHandlerStep<
    { request: Request; context: TContext; parsedInput: TInput; access: TAccess },
    TResult,
    TErrorCode
  >;
  respond: ApiHandlerStep<
    { request: Request; context: TContext; parsedInput: TInput; access: TAccess; result: TResult },
    Response,
    TErrorCode
  >;
  invalidRequestError: ApiErrorResponse<TErrorCode>;
  unknownError: ApiErrorResponse<TErrorCode>;
};

export type ApiEndpointContract<TErrorCode extends string> = Pick<
  CreateApiHandlerOptions<unknown, unknown, TErrorCode, unknown, unknown>,
  "invalidRequestError" | "unknownError"
>;

type CreateContractBoundApiHandlerOptions<TInput, TResult, TErrorCode extends string, TContext, TAccess> = Omit<
  CreateApiHandlerOptions<TInput, TResult, TErrorCode, TContext, TAccess>,
  "invalidRequestError" | "unknownError"
>;

/** Names an endpoint's two shared fallbacks once, so every handler for that endpoint agrees on them. */
export function defineApiEndpointContract<TErrorCode extends string>(
  contract: ApiEndpointContract<TErrorCode>,
): ApiEndpointContract<TErrorCode> {
  return contract;
}

export function createApiHandlerFromContract<
  TInput,
  TResult,
  TErrorCode extends string,
  TContext = unknown,
  TAccess = undefined,
>(
  contract: ApiEndpointContract<TErrorCode>,
  options: CreateContractBoundApiHandlerOptions<TInput, TResult, TErrorCode, TContext, TAccess>,
) {
  return createApiHandler({
    ...options,
    invalidRequestError: contract.invalidRequestError,
    unknownError: contract.unknownError,
  });
}

export function createApiHandler<TInput, TResult, TErrorCode extends string, TContext = unknown, TAccess = undefined>(
  options: CreateApiHandlerOptions<TInput, TResult, TErrorCode, TContext, TAccess>,
) {
  return async (request: Request, context: TContext): Promise<Response> => {
    const requestId = newRequestId();

    const accessResult = await runStep(
      options.access,
      { request, context },
      options.unknownError,
      requestId,
      undefined as TAccess,
    );
    if (!accessResult.ok) {
      return apiErrorResponse(accessResult.error, requestId);
    }

    const parseResult = await runStep(options.parse, { request, context }, options.unknownError, requestId);
    if (!parseResult.ok) {
      return apiErrorResponse(parseResult.error, requestId);
    }

    if (parseResult.value === null) {
      return apiErrorResponse(options.invalidRequestError, requestId);
    }

    const executeResult = await runStep(
      options.execute,
      { request, context, parsedInput: parseResult.value, access: accessResult.value },
      options.unknownError,
      requestId,
    );
    if (!executeResult.ok) {
      return apiErrorResponse(executeResult.error, requestId);
    }

    const responseResult = await runStep(
      options.respond,
      { request, context, parsedInput: parseResult.value, access: accessResult.value, result: executeResult.value },
      options.unknownError,
      requestId,
    );
    if (!responseResult.ok) {
      return apiErrorResponse(responseResult.error, requestId);
    }

    return responseResult.value;
  };
}

async function runStep<TStepInput, TStepResult, TErrorCode extends string>(
  step: ApiHandlerStep<TStepInput, TStepResult, TErrorCode> | undefined,
  input: TStepInput,
  unknownError: ApiErrorResponse<TErrorCode>,
  requestId: string,
  emptyValue?: TStepResult,
): Promise<{ ok: true; value: TStepResult } | { ok: false; error: ApiErrorResponse<TErrorCode> }> {
  if (!step) {
    return { ok: true, value: emptyValue as TStepResult };
  }

  try {
    return { ok: true, value: await step.run(input) };
  } catch (error) {
    return { ok: false, error: resolveStepError(step.mapError, error, unknownError, requestId) };
  }
}

function resolveStepError<TErrorCode extends string>(
  mapError: ApiStepErrorMapper<TErrorCode> | undefined,
  error: unknown,
  unknownError: ApiErrorResponse<TErrorCode>,
  requestId: string,
): ApiErrorResponse<TErrorCode> {
  if (!mapError) {
    logUnhandledError(error, requestId);
    return unknownError;
  }

  try {
    const mapped = mapError(error);
    if (mapped) return mapped;
    logUnhandledError(error, requestId);
    return unknownError;
  } catch {
    logUnhandledError(error, requestId);
    return unknownError;
  }
}

/**
 * The one place a step's raw error is written anywhere: server-side only
 * (`console.error`), tagged with the same request id the client receives in
 * `x-request-id` (`core/responses.ts`) - never the response body, never the
 * response headers beyond that id.
 */
function logUnhandledError(error: unknown, requestId: string): void {
  console.error(`[api-pipeline] unhandled error (request ${requestId})`, error);
}
