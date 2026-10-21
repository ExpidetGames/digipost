import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2) of src/modules/closing
 * (decisions/0066-abschluss-check-and-export.md). `/dashboard/abschluss` and
 * `GET /api/closing/export` import from here, never from `core/**`/`server/**` directly.
 *
 * Everything behind this door is admin-only by contract: the caller must have already
 * checked `PERMISSIONS.financeRead`, exactly like the rest of `/dashboard/finance/**`.
 */
export { getClosingReportProjection } from "./server/read-models";
export { closingExportFileName, createClosingExport, type ClosingExport, type ClosingExportLabels } from "./server/export";
