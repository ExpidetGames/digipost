// Owner: src/platform/jobs (WEBAPP_TEMPLATE_SPEC.md §14's jobqueue recipe,
// decisions/0016-processing-pipeline-and-ai.md). Only `repositories/drizzle/jobs-repository.ts`
// writes to this table (§5.7 "only the owner writes") - even though other owners' use cases
// (`documents-use-cases.ts`) call `repos.jobs.enqueue(...)` from inside their own transaction
// to enqueue a job atomically with their own write, the same shared-transaction pattern
// `billing`/`documents` already use for `workspace_monthly_usage` and `recordDocumentsCreated`.
//
// `status` only ever tracks the TERMINAL outcome ("pending" until a handler succeeds or
// permanently fails); an in-flight claim is represented by `locked_until` being in the
// future, not a separate "processing" status value - this keeps the claim query
// (`status = 'pending' and run_at <= now() and (locked_until is null or locked_until < now())`)
// a single, simple predicate instead of two overlapping state machines. `workspace_id` is
// nullable (a future job kind might not be workspace-scoped) but present so the UI "kick"
// trigger (decisions/0016) can filter claiming to one workspace's own due jobs without a
// jsonb payload scan.
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { workspaces } from "./workspaces";

export const JOB_STATUSES = ["pending", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    payload: jsonb().notNull().default({}),
    workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
    status: text({ enum: JOB_STATUSES }).notNull().default("pending"),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lockedUntil: timestamp({ withTimezone: true }),
    lastErrorCode: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("jobs_status_check", sql`${t.status} in ('pending', 'done', 'failed')`),
    // The claim query's own index: due, unlocked (or lease-expired), pending jobs, oldest first.
    index("jobs_status_run_at_idx").on(t.status, t.runAt),
    index("jobs_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);
