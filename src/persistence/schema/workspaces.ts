// Owner: src/modules/workspaces (WEBAPP_TEMPLATE_SPEC.md §14 "Mandanten" recipe,
// decisions/0014-workspaces-and-access.md). Only repositories of this owner write to
// these tables (§5.7 "only the owner writes").
//
// Tenancy model: a user may belong to SEVERAL workspaces
// (decisions/0070-several-workspaces-per-user.md) but never twice to the same one (the
// composite unique index on `(workspace_id, user_id)` below), with exactly one admin per
// workspace (the partial unique index below). There is no role beyond `admin`/`member`
// (PRD: "kein Rechte-Management") - authorization is modeled as permission bundles per role
// in `src/platform/access`, not as scattered role string checks. Which of a user's
// workspaces is the ACTIVE one for a given request is resolved in exactly one place,
// `src/platform/access/server/get-workspace-access.ts`'s `resolveAccess`, never stored here.
//
// `workspaces` does NOT cascade from `auth.user` deletion (there is no FK from
// `workspaces` to `user`): a workspace can outlive every one of its original members.
// `workspaceMembers` rows do cascade (`onDelete: "cascade"` on `userId`), so deleting a
// user only removes their membership, never the workspace itself - e2e fixtures that
// create a workspace must delete it explicitly (`tests/e2e/helpers/workspace.ts`).
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { TIERS } from "@/modules/billing";
import { PAYMENT_AUTO_CONFIRM_MODES } from "@/modules/payments";
import { ROLES } from "@/platform/access";

import { user } from "./auth";

/** Kept as a plain `text` column (not a Postgres enum) so a future tier requires only an
 * application-level constant change, not a migration that alters an enum type.
 * `src/modules/billing`'s `TIERS` (P2a) is the single source for the tier list itself; this
 * re-export keeps every existing `WORKSPACE_TIERS`/`WorkspaceTier` consumer unchanged. */
export const WORKSPACE_TIERS = TIERS;
export type WorkspaceTier = (typeof WORKSPACE_TIERS)[number];

/** Same pattern as `WORKSPACE_TIERS` above (P6 review finding D3): `src/platform/access`'s
 * `ROLES` (`["admin", "member"]`) is the single source for the role list; this re-export
 * keeps every existing `WORKSPACE_ROLES`/`WorkspaceRole` consumer unchanged while removing
 * the duplicated literal that previously lived here too. */
export const WORKSPACE_ROLES = ROLES;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  tier: text({ enum: WORKSPACE_TIERS }).notNull().default("free"),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // Company profile (decisions/0019-contacts.md's "own-company exclusion"): the workspace's
  // own address/VAT id, so the processing pipeline (C2) never files the workspace's own
  // company as if it were one of its contacts. All nullable (every workspace created before
  // this phase has none yet); `name` above already holds the company name. There are no
  // persisted "normalized" counterparts of these columns (unlike `contacts.name_normalized`
  // etc.) - a workspace has exactly one company profile, never searched or matched against
  // at scale, so `@/modules/contacts`'s `isOwnCompany` normalizes both sides on the fly at
  // comparison time instead of maintaining a denormalized column here.
  companyAddressLine1: text(),
  companyAddressLine2: text(),
  companyPostalCode: text(),
  companyCity: text(),
  companyCountry: text().default("DE"),
  companyVatId: text(),
  // Extended company profile (decisions/0034-extended-company-profile.md, H1): lets an admin
  // teach `isOwnCompany` about brand names, own bank accounts, and own web/e-mail domains a
  // plain name/postal-code/VAT-id match cannot cover (the observed defect: a letterhead
  // reading "musterfirma", a short-form GbR name, the workspace's own IBAN on a document footer
  // being mistaken for a business contact). All seven columns are optional with a safe
  // default so this migration is a no-op for every existing workspace row. The three arrays
  // are stored already normalized (`normalizeName`/`normalizeIban` for aliases/ibans, lowercase
  // host-only for domains) - see `src/modules/workspaces/README.md`'s "Extended company
  // profile" section for the exact normalization each one gets on write.
  companyAliases: text().array().notNull().default([]),
  companyIbans: text().array().notNull().default([]),
  companyDomains: text().array().notNull().default([]),
  companyTaxNumber: text(),
  companyRegisterCourt: text(),
  companyRegisterNumber: text(),
  // Free text (max 1000 chars, trimmed): helps the AI recognize "das sind wir" (brand names,
  // "our bank is X", what the business does) but is NEVER consulted by `isOwnCompany` itself
  // (decisions/0034's central rule: structured data decides, free text only helps the model
  // find things) - only read by `src/modules/documents`'s prompt-building code (wave 2).
  companyProfileText: text(),
  // decisions/0044: which payment suggestions are confirmed without a human. Chosen by an admin
  // on the finance page; written only through `workspaces-use-cases.ts`.
  paymentAutoConfirm: text({ enum: PAYMENT_AUTO_CONFIRM_MODES }).notNull().default("system"),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // A user may belong to several workspaces (decisions/0070-several-workspaces-per-user.md):
    // no unique constraint on this column alone any more, only the composite one below.
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text({ enum: WORKSPACE_ROLES }).notNull(),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_members_workspace_idx").on(t.workspaceId),
    // decisions/0070-several-workspaces-per-user.md: `userId` alone used to be unique, which
    // both enforced "one workspace per user" and indexed every lookup by user. The composite
    // index below replaces the constraint; this one replaces the lost index, which every
    // request now needs (`resolveAccess` lists the caller's memberships on each one).
    index("workspace_members_user_idx").on(t.userId),
    // The same user may not join the same workspace twice
    // (decisions/0070-several-workspaces-per-user.md). This is the database-level backstop
    // behind `acceptInvitation`'s own `already_in_workspace` pre-check, exactly the way the
    // dropped unique on `userId` alone used to back `createForUser`.
    uniqueIndex("workspace_members_workspace_user_key").on(t.workspaceId, t.userId),
    // Exactly one admin per workspace (PRD). A partial unique index, not a check
    // constraint: Postgres has no "at most one row where role = 'admin'" constraint
    // form other than a unique index scoped by a WHERE predicate.
    uniqueIndex("workspace_members_one_admin_key")
      .on(t.workspaceId)
      .where(sql`${t.role} = 'admin'`),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Normalized (trimmed, lowercased) by the use case before it ever reaches this table.
    email: text().notNull(),
    // sha256 of a random 32-byte token, hex-encoded. The plain token is never stored -
    // only ever returned once, to be embedded in the invitation e-mail's link.
    tokenHash: text().notNull().unique(),
    // Nullable, `onDelete: "set null"` (P6 review finding A9): deleting the inviting
    // admin's user account must not cascade-delete a pending or already-accepted
    // invitation (a workspace member's own membership row is unaffected either way).
    invitedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    // `null` while pending; set by `acceptInvitation` in the same transaction as the
    // membership insert.
    acceptedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_invitations_workspace_idx").on(t.workspaceId),
    // Re-inviting the same email replaces the pending invitation (the use case deletes
    // the existing pending row before inserting the new one, inside one transaction);
    // this partial unique index is the DB-level backstop against two pending invitations
    // for the same email existing at once.
    uniqueIndex("workspace_invitations_pending_email_key")
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} is null`),
  ],
);
