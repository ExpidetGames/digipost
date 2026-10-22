// Owner: src/modules/mail-intake (decisions/0075-email-intake.md). Encapsulates access only
// (WEBAPP_TEMPLATE_SPEC.md §5.3). Every method but `findSettingsByToken` filters on
// `workspaceId` explicitly.
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import type { MailIntakeRepository } from "@/persistence/repositories/contracts/mail-intake-repository";
import { inboundEmails, mailIntakeAllowedSenders, mailIntakeSettings } from "@/persistence/schema/mail-intake";

export function createDrizzleMailIntakeRepository(db: DbExecutor): MailIntakeRepository {
  async function findSettings(workspaceId: string) {
    const [row] = await db.select().from(mailIntakeSettings).where(eq(mailIntakeSettings.workspaceId, workspaceId)).limit(1);
    return row ?? null;
  }

  return {
    async ensureSettings(workspaceId, token) {
      await db.insert(mailIntakeSettings).values({ workspaceId, token }).onConflictDoNothing({ target: mailIntakeSettings.workspaceId });
      const row = await findSettings(workspaceId);
      if (!row) throw new Error("mail_intake_settings row missing right after ensureSettings");
      return row;
    },

    findSettings,

    async lockSettings(workspaceId) {
      const [row] = await db.select().from(mailIntakeSettings).where(eq(mailIntakeSettings.workspaceId, workspaceId)).for("update").limit(1);
      return row ?? null;
    },

    async findSettingsByToken(token) {
      const [row] = await db.select().from(mailIntakeSettings).where(eq(mailIntakeSettings.token, token)).limit(1);
      return row ?? null;
    },

    async updateSettings(workspaceId, patch) {
      const [row] = await db
        .update(mailIntakeSettings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(mailIntakeSettings.workspaceId, workspaceId))
        .returning();
      return row ?? null;
    },

    listAllowedSenders: (workspaceId) =>
      db
        .select()
        .from(mailIntakeAllowedSenders)
        .where(eq(mailIntakeAllowedSenders.workspaceId, workspaceId))
        .orderBy(mailIntakeAllowedSenders.value),

    async countAllowedSenders(workspaceId) {
      const [row] = await db.select({ value: count() }).from(mailIntakeAllowedSenders).where(eq(mailIntakeAllowedSenders.workspaceId, workspaceId));
      return row?.value ?? 0;
    },

    async addAllowedSender(input) {
      const [row] = await db
        .insert(mailIntakeAllowedSenders)
        .values(input)
        .onConflictDoNothing({ target: [mailIntakeAllowedSenders.workspaceId, mailIntakeAllowedSenders.value] })
        .returning();
      return row ?? null;
    },

    async removeAllowedSender(workspaceId, id) {
      const rows = await db
        .delete(mailIntakeAllowedSenders)
        .where(and(eq(mailIntakeAllowedSenders.workspaceId, workspaceId), eq(mailIntakeAllowedSenders.id, id)))
        .returning({ id: mailIntakeAllowedSenders.id });
      return rows.length > 0;
    },

    async insertInboundEmail(row) {
      const [inserted] = await db
        .insert(inboundEmails)
        .values(row)
        .onConflictDoNothing({ target: [inboundEmails.providerEmailId, inboundEmails.workspaceId] })
        .returning();
      return inserted ?? null;
    },

    async findInboundEmail(workspaceId, id) {
      const [row] = await db
        .select()
        .from(inboundEmails)
        .where(and(eq(inboundEmails.workspaceId, workspaceId), eq(inboundEmails.id, id)))
        .limit(1);
      return row ?? null;
    },

    async updateInboundEmail(workspaceId, id, patch) {
      await db
        .update(inboundEmails)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(inboundEmails.workspaceId, workspaceId), eq(inboundEmails.id, id)));
    },

    listInboundEmails: (workspaceId, limit) =>
      db
        .select()
        .from(inboundEmails)
        .where(eq(inboundEmails.workspaceId, workspaceId))
        .orderBy(desc(inboundEmails.receivedAt), desc(inboundEmails.createdAt))
        .limit(limit),

    async hasNotificationSince(workspaceId, reasonCode, since) {
      const [row] = await db
        .select({ id: inboundEmails.id })
        .from(inboundEmails)
        .where(and(eq(inboundEmails.workspaceId, workspaceId), eq(inboundEmails.reasonCode, reasonCode), gte(inboundEmails.notifiedAt, since)))
        .limit(1);
      return Boolean(row);
    },

    async findByDocumentId(workspaceId, documentId) {
      const [row] = await db
        .select()
        .from(inboundEmails)
        .where(
          and(
            eq(inboundEmails.workspaceId, workspaceId),
            sql`${inboundEmails.attachments} @> ${JSON.stringify([{ documentId, outcome: "imported" }])}::jsonb`,
          ),
        )
        .orderBy(desc(inboundEmails.receivedAt))
        .limit(1);
      return row ?? null;
    },
  };
}
