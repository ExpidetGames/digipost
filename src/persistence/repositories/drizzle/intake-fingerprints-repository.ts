// Owner: src/modules/documents. Encapsulates access only (WEBAPP_TEMPLATE_SPEC.md §5.3).
import { and, desc, eq, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { intakeSourceFingerprints } from "@/persistence/schema/intake-fingerprints";
import type { IntakeFingerprintRepository } from "@/persistence/repositories/contracts/intake-fingerprints-repository";

export function createDrizzleIntakeFingerprintRepository(db: DbExecutor): IntakeFingerprintRepository {
  return {
    async findByFingerprint(workspaceId, fingerprint) {
      const [row] = await db
        .select()
        .from(intakeSourceFingerprints)
        .where(and(eq(intakeSourceFingerprints.workspaceId, workspaceId), eq(intakeSourceFingerprints.fingerprint, fingerprint)))
        .limit(1);
      return row ?? null;
    },

    async upsertConfirmed(input) {
      const now = new Date();
      const [row] = await db
        .insert(intakeSourceFingerprints)
        .values({
          workspaceId: input.workspaceId,
          fingerprint: input.fingerprint,
          documentKind: input.documentKind,
          platform: input.platform,
          columnMapping: input.columnMapping,
          amountSign: input.amountSign,
          confirmedByUserId: input.confirmedByUserId,
          confirmedAt: now,
          lastUsedAt: now,
          useCount: 1,
        })
        .onConflictDoUpdate({
          target: [intakeSourceFingerprints.workspaceId, intakeSourceFingerprints.fingerprint],
          set: {
            documentKind: input.documentKind,
            platform: input.platform,
            columnMapping: input.columnMapping,
            amountSign: input.amountSign,
            confirmedByUserId: input.confirmedByUserId,
            confirmedAt: now,
            lastUsedAt: now,
            useCount: 1,
          },
        })
        .returning();
      if (!row) throw new Error("upsert into intake_source_fingerprints returned no row");
      return row;
    },

    async touchUsage(id) {
      await db
        .update(intakeSourceFingerprints)
        .set({ lastUsedAt: new Date(), useCount: sql`${intakeSourceFingerprints.useCount} + 1` })
        .where(eq(intakeSourceFingerprints.id, id));
    },

    listForWorkspace: (workspaceId) =>
      db
        .select()
        .from(intakeSourceFingerprints)
        .where(eq(intakeSourceFingerprints.workspaceId, workspaceId))
        .orderBy(desc(intakeSourceFingerprints.lastUsedAt)),

    async remove(workspaceId, id) {
      await db.delete(intakeSourceFingerprints).where(and(eq(intakeSourceFingerprints.workspaceId, workspaceId), eq(intakeSourceFingerprints.id, id)));
    },
  };
}
