// Owner: src/modules/mail-intake (decisions/0075-email-intake.md). Only
// `repositories/drizzle/mail-intake-repository.ts` writes these tables (§5.7 "only the owner
// writes"). Every table is workspace-owned and cascades from `workspaces.id`, so deleting a
// workspace removes its address, its allowlist and its whole received-mail log in the same
// single `DELETE` (decisions/0027-hardening-and-deletion.md's "Cascade verification").
//
// The received-mail log is kept until the workspace is deleted (user decision): nothing here
// is ever purged automatically (AGENTS.md "Nothing is auto-deleted except one thing").
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { ALLOWED_SENDER_KINDS, INBOUND_EMAIL_REASONS, INBOUND_EMAIL_STATUSES, SENDER_POLICIES, type AttachmentResult } from "@/modules/mail-intake";

import { user } from "./auth";
import { workspaces } from "./workspaces";

/** One row per workspace, created lazily the first time anyone opens "E-Mail-Eingang" (no
 * migration backfills it, since migrations are generated, never hand-written). `token` is the
 * secret local part of `post-<token>@<INBOUND_EMAIL_DOMAIN>` and the only routing key a
 * received mail carries; unique across every workspace. */
export const mailIntakeSettings = pgTable("mail_intake_settings", {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid()
    .notNull()
    .unique()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  enabled: boolean().notNull().default(true),
  senderPolicy: text({ enum: SENDER_POLICIES }).notNull().default("allowlist"),
  /** When an admin last replaced the address ("Neue Adresse erzeugen"); the old one stops
   * working at that moment. `null` until the first rotation. */
  tokenRotatedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** The admin-maintained allowlist: a full address or a whole domain, stored normalized
 * (`@/modules/mail-intake`'s `normalizeAllowedSenderEntry`). */
export const mailIntakeAllowedSenders = pgTable(
  "mail_intake_allowed_senders",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text({ enum: ALLOWED_SENDER_KINDS }).notNull(),
    value: text().notNull(),
    createdByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("mail_intake_allowed_senders_workspace_value_key").on(t.workspaceId, t.value)],
);

/** Every received mail addressed to a workspace, with what became of each attachment.
 * `(provider_email_id, workspace_id)` is unique: the provider retries a webhook, and one mail
 * may be addressed to several workspaces (one row each). */
export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerEmailId: text().notNull(),
    fromAddress: text().notNull(),
    subject: text(),
    messageId: text(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    status: text({ enum: INBOUND_EMAIL_STATUSES }).notNull().default("received"),
    reasonCode: text({ enum: INBOUND_EMAIL_REASONS }),
    attachments: jsonb().$type<AttachmentResult[]>().notNull().default([]),
    /** How many job runs have started on this mail; the use case gives up on a provider that
     * keeps failing at its own limit rather than leaving the row `received` forever. */
    attempts: integer().notNull().default(0),
    /** Set when this mail's rejection was e-mailed to the admin: the notification throttle
     * looks for a recent one per workspace and reason. */
    notifiedAt: timestamp({ withTimezone: true }),
    processedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbound_emails_provider_email_workspace_key").on(t.providerEmailId, t.workspaceId),
    index("inbound_emails_workspace_received_idx").on(t.workspaceId, t.receivedAt),
    index("inbound_emails_workspace_notified_idx").on(t.workspaceId, t.reasonCode, t.notifiedAt),
    check("inbound_emails_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
