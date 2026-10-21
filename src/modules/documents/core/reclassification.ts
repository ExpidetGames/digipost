// "Dokumentart korrigieren" (decisions/0072-correcting-a-document-s-kind.md): which kinds a
// human may assign to a processed PDF document. Pure, no I/O - shared by the Server Action's
// Zod schema (`./schemas.ts`), `src/persistence/use-cases/documents-use-cases.ts`'s
// `reclassifyDocument` guard, and the detail page's select (`../ui/document-detail-client.tsx`).
import type { DocumentKind } from "@/modules/intake";

/**
 * Every `DocumentKind` except the three whose meaning is "this file feeds an account":
 * `bank_statement`, `payout_report`, and `platform_settlement`. Those kinds are only acted on
 * when they come from their own deterministic or confirmed intake flows (camt.053/MT940, an
 * app-store report, a confirmed tabular proposal, decisions/0020 and decisions/0026). A PDF the
 * classifier labels with one of them stays a label only (no import, no settlement lines,
 * `payment_status` `not_applicable`), so offering them here would promise an import that never
 * happens. A document currently carrying one of them can still be corrected AWAY from it.
 * Ordered like `DOCUMENT_KINDS` so the select reads the same as the inbox kind filter.
 */
export const RECLASSIFIABLE_KINDS = [
  "letter",
  "incoming_invoice",
  "outgoing_invoice",
  "reminder",
  "receipt",
  "contract",
  "authority_letter",
  "other",
] as const satisfies readonly DocumentKind[];
export type ReclassifiableKind = (typeof RECLASSIFIABLE_KINDS)[number];

export function isReclassifiableKind(kind: DocumentKind): kind is ReclassifiableKind {
  return (RECLASSIFIABLE_KINDS as readonly DocumentKind[]).includes(kind);
}
