// UI-facing DTOs (dates as ISO strings, not `Date` - mirrors
// `src/modules/workspaces/core/types.ts`'s convention).
import type { DocumentContactRole } from "@/modules/contacts";
import type { DocumentKind, SettlementPlatform } from "@/modules/intake";
import type { PaymentStatus } from "@/modules/payments";
import type { DocumentDirection, DocumentIntakeStatus, DocumentStatus } from "@/persistence/repositories/contracts";

import type { IntakeResult } from "./intake-result";

export type DocumentListItem = {
  id: string;
  title: string | null;
  originalFileName: string;
  sender: string | null;
  /** decisions/0059-generated-document-names.md: the contact this document is WITH (its
   * direction decides the role), which the generated row name is built from. `null` when
   * nothing is linked, which is every tabular import. */
  counterpartyName: string | null;
  /** decisions/0060-app-store-reports-are-named-by-their-period.md: the `YYYY-MM` an Apple or
   * Google report covers; `null` for every other document. */
  reportPeriod: string | null;
  /** decisions/0061-a-statement-is-dated-by-its-last-booking.md: the latest booking date in a
   * bank statement; `null` for every other document. */
  statementLastBooking: string | null;
  /** F4 (decisions/0026-platform-settlements.md): which platform a report came from, used
   * together with `reportPeriod` to name the row. */
  platform: SettlementPlatform | null;
  status: DocumentStatus;
  createdAt: string;
  documentDate: string | null;
  /** `null` before processing has run (decisions/0021-extraction-direction-and-invoice-fields.md). */
  direction: DocumentDirection | null;
  totalAmountCents: number | null;
  currency: string | null;
  /** F1b (decisions/0022-intake-wiring.md): "letter" until processing has classified the
   * document. */
  kind: DocumentKind;
  intakeStatus: DocumentIntakeStatus;
  /** F3b (decisions/0025-payment-matching-wiring.md): needed to upgrade `paymentStatus` to
   * `overdue` for display (`resolveDisplayStatus`) without a second round trip. */
  dueDate: string | null;
  /** F3b (decisions/0025-payment-matching-wiring.md): the inbox status chip and
   * "offen/überfällig/bezahlt" filter - visible to every member, never gated by
   * `finance.read` (it is document information, not bank information). */
  paymentStatus: PaymentStatus;
  paidAt: string | null;
};

/** `/dashboard/documents/[id]`'s "linked contacts" panel (C2's "UI surface"). */
export type LinkedContactOption = { contactId: string; name: string; role: DocumentContactRole; verified: boolean };

export type DocumentListView = {
  items: DocumentListItem[];
  hasMore: boolean;
  page: number;
};

export type DocumentDetailView = {
  id: string;
  title: string | null;
  originalFileName: string;
  /** decisions/0072-correcting-a-document-s-kind.md: "Dokumentart ändern" is offered only for
   * a processed PDF (`application/pdf`), never for a structured upload with its own intake flow. */
  mimeType: string;
  sender: string | null;
  documentDate: string | null;
  createdAt: string;
  uploadedByEmail: string | null;
  status: DocumentStatus;
  errorCode: string | null;
  ocrText: string | null;
  summary: string | null;
  direction: DocumentDirection | null;
  invoiceNumber: string | null;
  totalAmountCents: number | null;
  currency: string | null;
  dueDate: string | null;
  paymentIban: string | null;
  paymentReference: string | null;
  paidNote: string | null;
  contacts: LinkedContactOption[];
  /** F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md). */
  kind: DocumentKind;
  /** F4 (decisions/0026-platform-settlements.md): only set for `kind`
   * `payout_report`/`platform_settlement`. */
  platform: SettlementPlatform | null;
  intakeStatus: DocumentIntakeStatus;
  intakeResult: IntakeResult | null;
  /** F1b's semantic-duplicate hint ("möglicherweise doppelt") - `null` for a non-invoice
   * document or one with no matching earlier/later document. */
  possibleDuplicateOf: { id: string; originalFileName: string } | null;
  /** F3b (decisions/0025-payment-matching-wiring.md): `not_applicable` for a non-invoice
   * document - the page renders no payment section at all in that case. */
  paymentStatus: PaymentStatus;
  paidAt: string | null;
};

/** `/dashboard/settings/intake`'s admin-only list (F1b). */
export type IntakeFingerprintOption = {
  id: string;
  documentKind: DocumentKind;
  platform: string | null;
  confirmedAt: string;
  lastUsedAt: string;
  useCount: number;
};
