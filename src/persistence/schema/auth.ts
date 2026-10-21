// Owner: src/platform/auth. Only src/platform/auth's Better Auth adapter writes these tables
// (WEBAPP_TEMPLATE_SPEC.md §5.7 "only the owner writes"; decisions/0005-better-auth-magic-link-drizzle-adapter.md).
//
// The shape Better Auth's Drizzle adapter (`drizzleAdapter(db, { provider: "pg",
// schema: authSchema })`, decisions/0005) expects for `user`, `session`, `account`,
// `verification`, and its database-backed rate limiter (`rateLimit: { storage:
// "database" }`, WEBAPP_TEMPLATE_SPEC.md §6.3). IDs are UUID (`advanced.database.generateId:
// "uuid"`), matching every other owner's tables.
//
// Better Auth queries unqualified, case-sensitive table/column names (`"user"`,
// `"emailVerified"`, …): Postgres folds unquoted identifiers to lowercase, so every
// table and every column here is quoted camelCase in the database. Every column
// below carries an EXPLICIT database name matching that exactly, so this schema's
// behavior does not depend on `casing: "snake_case"` (src/persistence/foundation/client.ts)
// at runtime: that option only fills in a name when a column has none.
//
// Do not rename columns/tables here without re-checking against a fresh Better Auth
// CLI run (`pnpm dlx @better-auth/cli generate`, WEBAPP_TEMPLATE_SPEC.md §6.2): an
// accidental rename would silently desync this file from what the adapter actually
// writes.
import { bigint, boolean, index, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const authSchema = pgSchema("auth");

export const user = authSchema.table("user", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
});

export const session = authSchema.table(
  "session",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = authSchema.table(
  "account",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = authSchema.table(
  "verification",
  {
    id: uuid("id").defaultRandom().primaryKey().notNull(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Better Auth's database-backed rate limiter (`rateLimit: { storage: "database" }`,
// WEBAPP_TEMPLATE_SPEC.md §6.3): survives serverless cold starts, works across
// multiple function instances, unlike an in-memory or Redis-backed limiter.
export const rateLimit = authSchema.table("rateLimit", {
  id: uuid("id").defaultRandom().primaryKey().notNull(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("lastRequest", { mode: "number" }).notNull(),
});
