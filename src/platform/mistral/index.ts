/**
 * Neutral entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2): the error shape and stable codes any
 * caller (including `src/persistence/use-cases/documents-use-cases.ts`, which classifies a
 * thrown `MistralRequestError` into `src/platform/jobs`'s `TransientJobError`/
 * `PermanentJobError`) needs, without pulling in `server-only` or a vendor SDK.
 */
export { MISTRAL_ERROR_CODES, MistralRequestError, type MistralErrorCode } from "./core/errors";
