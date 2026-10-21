// Owner: src/modules/documents (decisions/0020-universal-intake.md's "confirm once" flow,
// wired by decisions/0022-intake-wiring.md). A workspace's confirmed tabular source layouts:
// once a human confirms an unrecognized CSV/TSV's proposed kind and column mapping, the next
// file sharing the same `TabularSample.fingerprint` (`@/modules/intake`) imports without
// another model call or another confirmation prompt. Only
// `repositories/drizzle/intake-fingerprints-repository.ts` writes to this table (§5.7 "only
// the owner writes").
//
// Kept in its own file rather than folded into `documents.ts`: distinct table, distinct
// lifecycle (a workspace's confirmed sources rarely change once established, unlike a
// document row).
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { DOCUMENT_KINDS } from "@/modules/intake";

import { user } from "./auth";
import { workspaces } from "./workspaces";

export const intakeSourceFingerprints = pgTable(
  "intake_source_fingerprints",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // `TabularSample.fingerprint` (`@/modules/intake`'s `sampleTabular`): a sha256 over the
    // normalized header, delimiter, and column count - identifies "this exact source layout"
    // independent of any given file's actual data.
    fingerprint: text().notNull(),
    documentKind: text({ enum: DOCUMENT_KINDS }).notNull(),
    // Only meaningful for `payout_report`/`platform_settlement` (`@/modules/intake`'s
    // `SettlementPlatform`) - `null` for a bank statement or any other confirmed kind.
    platform: text(),
    // `ColumnMapping`/`AmountSign` (`@/modules/intake`), stored as the confirmed user
    // decision - not typed more strictly than `jsonb` here since both are already validated
    // shapes by the time they are confirmed (`parseIntakeClassification`,
    // `validateMapping`), and re-declaring their Zod shape in a schema file would duplicate
    // that module's own source of truth.
    columnMapping: jsonb().notNull(),
    amountSign: jsonb(),
    confirmedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    confirmedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    useCount: integer().notNull().default(1),
  },
  (t) => [unique("intake_source_fingerprints_workspace_fingerprint_key").on(t.workspaceId, t.fingerprint)],
);
