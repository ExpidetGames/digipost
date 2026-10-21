// No owner, no table: `SystemRepository` exists only so `GET /api/health`'s DB
// readiness check goes through the same composition root and the same role
// (`app_runtime`) as every other request, instead of that route reaching into
// `src/persistence/foundation/client.ts` directly (WEBAPP_TEMPLATE_SPEC.md §5.1's "one
// door in" rule, applied even to a check that touches no application data).
export interface SystemRepository {
  /**
   * Runs the cheapest possible query against the runtime connection. Throws on any
   * failure (unreachable DB, misconfigured role, ...) rather than swallowing it -
   * `src/persistence/use-cases/system-use-cases.ts` is what turns that into a boolean.
   */
  ping(): Promise<void>;
}
