// Shared Drizzle types (WEBAPP_TEMPLATE_SPEC.md §5.2). Repositories
// (src/persistence/repositories/drizzle/*) accept a `DbExecutor` so the same repository
// function works whether it runs directly against a pool or inside
// `uow.transaction(...)` (src/persistence/repositories/drizzle/unit-of-work.ts): callers
// above the Unit of Work never see this type (WEBAPP_TEMPLATE_SPEC.md §5.1: use cases
// see repositories, never a `tx`/`DbExecutor`).
import type { AppDb as AppDbInstance } from "./client";

/** The Drizzle instance `src/persistence/foundation/client.ts` builds (either pool). */
export type AppDb = AppDbInstance;

/** The transaction handle `AppDb["transaction"]`'s callback receives. */
export type DbTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

/** Whatever a repository actually runs queries against: a pool, or one open transaction. */
export type DbExecutor = AppDb | DbTx;
