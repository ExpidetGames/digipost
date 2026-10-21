// Drizzle Kit config (WEBAPP_TEMPLATE_SPEC.md §5.7). Used by `pnpm db:generate`
// (`drizzle-kit generate`), `pnpm db:generate:custom` (`drizzle-kit generate --custom`),
// and `pnpm db:studio` (`drizzle-kit studio`). Not used at runtime:
// `src/persistence/foundation/client.ts` builds its own `drizzle()` instance against the
// runtime app connection, never this config.
import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile(".env.local");
} catch {
  // CI / the Docker test stack set the environment directly; no .env.local there.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/persistence/schema/index.ts",
  out: "./src/persistence/migrations",
  casing: "snake_case",
  // `generate` diffs the schema against the last snapshot and needs no DB
  // connection; `studio` does. `DATABASE_URL_MIGRATE` only, never `DATABASE_URL`/
  // `DATABASE_URL_PUBLIC` (decisions/0004-three-database-roles.md: the owner
  // connection is the only one with DDL rights).
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATE ?? "" },
});
