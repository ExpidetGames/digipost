// Owner: src/modules/billing (architecture brief's product decisions 1, 5, 6; tiers/package
// table). Only repositories of this owner write to these tables (§5.7 "only the owner
// writes") - `src/modules/documents`'s use case calls this owner's use case
// (`recordDocumentsCreated`) inside its own transaction rather than writing
// `workspace_monthly_usage` itself (see `src/persistence/use-cases/billing-use-cases.ts`'s
// header comment for how a transaction is shared across two owners' use cases without either
// one writing the other's table). P3 (decisions/0017-billing-tiers-and-packages.md) added
// `workspace_tier_changes`: `billing-use-cases.ts`'s `changeTier` writes both this table and
// `workspaces.tier` (via `repos.workspace.updateTier`, `src/modules/workspaces`'s own
// repository method - the same cross-owner transaction-sharing shape as
// `recordDocumentsCreated`/`removeMember` elsewhere in this repository) inside one
// transaction.
//
// `period` is always the first day of a calendar month in UTC (`YYYY-MM-01`,
// `src/modules/billing`'s `periodKeyFor`), stored as a plain `date` (`mode: "string"`) so
// comparisons/grouping are simple date arithmetic, not a timestamp range.
import { date, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { PACKAGE_KEYS, TIERS } from "@/modules/billing";

import { user } from "./auth";
import { workspaces } from "./workspaces";

/** Documents created per workspace per calendar month (product decision 1: the monthly
 * limit counts creation, not current stock - deleting a document does not refund it).
 * `warnedTotalAt`/`warnedMonthlyAt` back the "at most once per limit per calendar month" 80%
 * warning e-mail (P3): `null` until that warning has been sent for this period. */
export const workspaceMonthlyUsage = pgTable(
  "workspace_monthly_usage",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    period: date({ mode: "string" }).notNull(),
    documentsCreated: integer().notNull().default(0),
    warnedTotalAt: timestamp({ withTimezone: true }),
    warnedMonthlyAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.period] })],
);

/** A one-off digitization-package purchase (product decisions 5/6): raises the monthly quota
 * for `period` only, expiring at the end of that calendar month (a later `period` needs its
 * own purchase). P3 (decisions/0017-billing-tiers-and-packages.md) is the first writer of
 * this table (test-mode purchases, `provider: "test"`; a future Stripe adapter writes
 * `provider: "stripe"` the same way); P2a only read it (sum of `extraDocuments` for the
 * current period, `src/persistence/use-cases/billing-use-cases.ts`'s `getUsage`). */
export const quotaPackagePurchases = pgTable("quota_package_purchases", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  packageKey: text({ enum: PACKAGE_KEYS }).notNull(),
  extraDocuments: integer().notNull(),
  priceCents: integer().notNull(),
  period: date({ mode: "string" }).notNull(),
  // Nullable, `onDelete: "set null"` (P6 review finding A9), like `documents.uploadedByUserId`:
  // deleting the purchasing user's account must not cascade-delete this row. It is paid,
  // billable history (the workspace's monthly quota for `period` is computed from
  // `extraDocuments` summed across this table) - losing it would silently shrink a
  // workspace's quota for capacity it already paid for.
  purchasedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
  provider: text({ enum: ["test", "stripe"] }).notNull(),
  providerReference: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** An audit ledger of tier changes (P3, decisions/0017-billing-tiers-and-packages.md): one
 * row per admin-initiated upgrade/downgrade, test-mode today (`provider: "test"`), a future
 * Stripe subscription-state webhook later (`provider: "stripe"`). Not read by any quota
 * check - `workspaces.tier` (updated in the same transaction as the insert here, via
 * `src/modules/workspaces`'s own `WorkspaceRepository.updateTier`) is the single source of
 * truth for the workspace's current tier; this table exists purely as a history/audit trail. */
export const workspaceTierChanges = pgTable("workspace_tier_changes", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  previousTier: text({ enum: TIERS }).notNull(),
  newTier: text({ enum: TIERS }).notNull(),
  // Nullable, `onDelete: "set null"` (P6 review finding A9): this table is an audit trail,
  // not a quota input, but deleting a former admin's user account must not delete audit
  // history of a tier change they made.
  changedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
  provider: text({ enum: ["test", "stripe"] }).notNull(),
  providerReference: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
