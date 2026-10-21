// Neutral SQLSTATE -> DbErrorKind mapping (WEBAPP_TEMPLATE_SPEC.md §5.2). Repositories
// and use cases branch on `DbErrorKind`, never on a raw driver error or a bare
// Postgres error code: a repository/use-case pair should read the same regardless
// of which pg client library eventually sits under `src/persistence/foundation/client.ts`
// (decisions/0003-provider-independent-postgres-with-drizzle.md).
//
// "Neutral" on purpose: this module knows nothing about any project's domain. A
// `P0001` raise (Postgres' `raise exception 'SOME_CODE'`, how custom SQL functions
// report a business error, WEBAPP_TEMPLATE_SPEC.md §5.7's custom-migration escape
// hatch) maps to the single generic kind `"raised"`; the raw message is preserved on
// the returned object exactly as Postgres reported it, so a caller that needs to
// branch on a specific business code still can (`isDbError(err, "raised") &&
// err.message === "SOME_CODE"`).
//
// Drizzle wraps the driver's own error in `DrizzleQueryError` (its `cause`, standard
// `Error.cause`: see `drizzle-orm/errors.js`), so this module unwraps `cause`
// before reading `.code`/`.message`/`.constraint`. A bare `pg` `DatabaseError`
// (thrown directly by a hand-written query, or by a test) already has those fields
// on itself and needs no unwrapping: `dbErrorOf` checks both shapes.
import "server-only";

export type DbErrorKind =
  | "unique" // 23505
  | "foreign_key" // 23503
  | "check" // 23514
  | "invalid_input" // 22001, 23502, 22P02
  | "forbidden" // 42501 (grant / RLS)
  | "serialization" // 40001, 40P01 -> retryable
  | "raised" // P0001 from a SQL function/trigger (see module doc above)
  | "unknown";

export type DbError = {
  kind: DbErrorKind;
  /** SQLSTATE (e.g. `23505`, `P0001`), or `null` for a non-Postgres error (network, etc.). */
  code: string | null;
  /** Violated constraint name, if Postgres reported one. */
  constraint: string | null;
  /** Raw driver message: for `"raised"`, this is the exact `raise exception` text. */
  message: string;
};

/** SQLSTATE -> DbErrorKind, the flat lookup behind `dbErrorOf`'s classification. */
const SQLSTATE_KINDS: Record<string, DbErrorKind> = {
  "23505": "unique",
  "23503": "foreign_key",
  "23514": "check",
  "22001": "invalid_input",
  "23502": "invalid_input",
  "22P02": "invalid_input",
  "42501": "forbidden",
  "40001": "serialization",
  "40P01": "serialization",
  P0001: "raised",
};

type PgErrorShape = { code?: unknown; message?: unknown; constraint?: unknown };

function isPgErrorShape(value: unknown): value is PgErrorShape {
  return typeof value === "object" && value !== null && "code" in value;
}

function stringField(value: PgErrorShape, key: keyof PgErrorShape): string | null {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field: null;
}

/**
 * The underlying Postgres error `err` (or a `DrizzleQueryError` wrapping one)
 * carries, if any. `null` when `err` has no SQLSTATE-shaped `code` anywhere in its
 * `cause` chain (a plain JS error, a network error without a driver `code`, etc.).
 */
function pgErrorOf(err: unknown): PgErrorShape | null {
  if (isPgErrorShape(err)) return err;
  if (err instanceof Error && err.cause !== undefined && isPgErrorShape(err.cause)) return err.cause;
  return null;
}

/** Best-effort message for something that is not a Postgres-shaped error at all. */
function genericMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Database error";
}

/** Maps a Postgres/driver error (or anything else thrown) to a neutral `DbError`. */
export function dbErrorOf(err: unknown): DbError {
  const pgErr = pgErrorOf(err);
  if (!pgErr) {
    return { kind: "unknown", code: null, constraint: null, message: genericMessageOf(err) };
  }

  const code = stringField(pgErr, "code");
  const message = stringField(pgErr, "message") ?? "Database error";
  const constraint = stringField(pgErr, "constraint");

  // SQLSTATE codes are exactly 5 alphanumerics (`23505`, `P0001`, …); driver-level
  // codes (ECONNRESET, …) are not and fall through to "unknown".
  const sqlState = code && /^[0-9A-Z]{5}$/.test(code) ? code: null;
  const kind = (sqlState && SQLSTATE_KINDS[sqlState]) || "unknown";

  return { kind, code: sqlState, constraint, message };
}

/** `isDbError(err, "unique")` reads better at a call site than `dbErrorOf(err).kind === "unique"`. */
export function isDbError(err: unknown, kind: DbErrorKind): boolean {
  return dbErrorOf(err).kind === kind;
}
