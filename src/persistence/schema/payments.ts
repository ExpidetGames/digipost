// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md, building on
// F3a's pure domain layer, decisions/0023-payment-matching.md). Only repositories of this
// owner write to these tables (§5.7 "only the owner writes").
//
// `document_transactions`: one row per (document, transaction) pairing the three matching
// stages, or a human, have ever proposed or decided on - `status` moves `suggested` ->
// `confirmed`/`rejected` (never back), a `confirmed` row is what actually counts against a
// document's open amount (`allocated_amount_cents`, always the positive portion of the
// transaction's own amount this document claims - a whole-amount exact/skonto match allocates
// the full amount, a `partial`/`collective` suggestion allocates less). `unique
// (document_id, transaction_id)`: the SAME pairing is never proposed twice - re-running
// `runMatching` upserts onto the existing row rather than creating a duplicate suggestion.
// `reasons` is `MatchReasonCode[]` (`@/modules/payments`), `kind` is `MatchKind` (adds
// `"manual"` for a human-picked pairing, F3b), `matched_by` is `MatchedBy`.
//
// `payment_aliases`: a learned counterparty-name -> contact mapping (F3a's
// `core/learning.ts`'s `learnAliasFromConfirmation`/`applyAliases`, persisted here for the
// first time) - confirming a suggestion where both the counterparty name and the linked
// contact are known writes one of these; a future transaction/document from the same
// normalized name is corroborated by it even when the exact invoice-number/IBAN signal is
// missing that time. `unique (workspace_id, counterparty_name_normalized)`: one alias per
// name per workspace, the latest confirmation wins (upsert, never accumulate history).
//
// `payment_rejections`: F3a's `core/learning.ts`'s `filterRejectedPairs` persisted - a human
// explicitly declined this exact (document, transaction) pairing, so no future matching run
// ever re-suggests it (`unique (document_id, transaction_id)`). Kept as its own table (not
// merely `document_transactions.status = 'rejected'`) because a suggestion can be superseded
// (a `document_transactions` row can, in principle, later be reused for a fresh proposal of
// the SAME pairing after a data correction) while the rejection itself must remain permanent
// evidence a human does not want this pairing suggested again, independent of that row's own
// lifecycle - see decisions/0025's "Two rejection records" section for the full rationale.
//
// `payment_no_document_rules`: "kein Beleg nötig, für diese Gegenpartei immer" (F3b scope
// item 3) - a per-workspace, per-counterparty-name standing rule; `runMatching` applies it to
// every currently-unmatched transaction from that counterparty (`transactions.no_document_needed`,
// `src/persistence/schema/accounts.ts`) before running any of the three stages, so a
// recurring non-invoice counterparty (e.g. a payroll provider, an internal transfer) stops
// generating candidates/suggestions going forward without a human re-deciding it every time.
import { check, index, integer, jsonb, pgTable, real, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { DOCUMENT_TRANSACTION_STATUSES, MATCH_KINDS, MATCHED_BY_VALUES } from "@/modules/payments";

import { user } from "./auth";
import { contacts } from "./contacts";
import { transactions } from "./accounts";
import { documents } from "./documents";
import { workspaces } from "./workspaces";

const MATCH_KIND_VALUES = Object.values(MATCH_KINDS) as [string, ...string[]];

export const documentTransactions = pgTable(
  "document_transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    status: text({ enum: DOCUMENT_TRANSACTION_STATUSES }).notNull().default("suggested"),
    kind: text({ enum: MATCH_KIND_VALUES as [string, ...string[]] }).notNull(),
    // `real` (float4): a `MatchSuggestion.confidence` is always `0..1`, never a value whose
    // exact decimal representation matters (unlike a monetary amount, always stored in whole
    // cents as an integer elsewhere in this schema).
    confidence: real().notNull(),
    reasons: jsonb().notNull().default([]),
    explanation: text(),
    matchedBy: text({ enum: MATCHED_BY_VALUES }).notNull(),
    allocatedAmountCents: integer().notNull(),
    // F3a's `arbiterCacheKey(tx, candidateIds)` (`@/modules/payments`), stored ONLY on a
    // `kind: "ai"` row - `runMatching`'s own idempotency guard for the AI stage specifically
    // (decisions/0025-payment-matching-wiring.md's "AI stage caching" section): before ever
    // calling the arbiter for a transaction, the use case checks whether an `ai` row already
    // exists for that transaction with this exact key (the same transaction against the same
    // bounded candidate set) and, if so, reuses it rather than paying for (and re-prompting)
    // a network call whose answer cannot have changed. `null` for every non-`ai` row.
    arbiterCacheKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
    decidedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("document_transactions_document_transaction_key").on(t.documentId, t.transactionId),
    index("document_transactions_workspace_status_idx").on(t.workspaceId, t.status),
    index("document_transactions_transaction_idx").on(t.transactionId),
    check("document_transactions_status_check", sql`${t.status} in ('suggested', 'confirmed', 'rejected')`),
    check(
      "document_transactions_kind_check",
      sql`${t.kind} in ('exact', 'skonto', 'partial', 'collective', 'ai', 'manual')`,
    ),
    check("document_transactions_matched_by_check", sql`${t.matchedBy} in ('auto', 'ai', 'user')`),
  ],
);

export const paymentAliases = pgTable(
  "payment_aliases",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    counterpartyNameNormalized: text().notNull(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    learnedFromUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("payment_aliases_workspace_name_key").on(t.workspaceId, t.counterpartyNameNormalized)],
);

export const paymentRejections = pgTable(
  "payment_rejections",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    rejectedBy: uuid().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("payment_rejections_document_transaction_key").on(t.documentId, t.transactionId)],
);

export const paymentNoDocumentRules = pgTable(
  "payment_no_document_rules",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    counterpartyNameNormalized: text().notNull(),
    createdByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("payment_no_document_rules_workspace_name_key").on(t.workspaceId, t.counterpartyNameNormalized)],
);
