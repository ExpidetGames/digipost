// Owner: src/modules/documents (decisions/0020-universal-intake.md's "confirm once" flow,
// decisions/0022-intake-wiring.md). Contracts only: no Drizzle import besides type-only
// schema references.
import type { InferSelectModel } from "drizzle-orm";

import type { AmountSign, ColumnMapping, DocumentKind, SettlementPlatform } from "@/modules/intake";
import type { intakeSourceFingerprints } from "@/persistence/schema/intake-fingerprints";

export type IntakeFingerprintRow = InferSelectModel<typeof intakeSourceFingerprints>;

export type UpsertConfirmedFingerprintInput = {
  workspaceId: string;
  fingerprint: string;
  documentKind: DocumentKind;
  platform: SettlementPlatform | null;
  columnMapping: ColumnMapping;
  amountSign: AmountSign | null;
  confirmedByUserId: string | null;
};

export interface IntakeFingerprintRepository {
  /** `null` when this exact `(workspaceId, fingerprint)` pair has never been confirmed - the
   * caller falls through to the classifier proposal path. */
  findByFingerprint(workspaceId: string, fingerprint: string): Promise<IntakeFingerprintRow | null>;
  /** Confirming a proposal (first time for this fingerprint, or re-confirming after
   * "Zuordnung zurücksetzen") upserts the row, resetting `useCount` to 1 and `confirmedAt`/
   * `confirmedByUserId` to the new decision. */
  upsertConfirmed(input: UpsertConfirmedFingerprintInput): Promise<IntakeFingerprintRow>;
  /** Bumps `useCount`/`lastUsedAt` - called every time a later file's fingerprint matches an
   * already-confirmed source (the "no repeated model call/confirmation" fast path). */
  touchUsage(id: string): Promise<void>;
  /** `/dashboard/settings/intake`'s admin-only list: kind, platform, use count, last used. */
  listForWorkspace(workspaceId: string): Promise<IntakeFingerprintRow[]>;
  /** "Zuordnung zurücksetzen" (admin-only): removes the confirmed mapping entirely, so the
   * next matching file goes through the classifier proposal flow again. */
  remove(workspaceId: string, id: string): Promise<void>;
}
