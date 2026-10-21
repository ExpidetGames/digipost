// Owner: src/modules/documents (decisions/0059-generated-document-names.md). The inbox does
// not show what a file happened to be called when someone dragged it in ("Rn_42_Bauwerk
// Generalbau München.pdf", "financial_report (5).csv", "scan_0007.pdf"): it shows a name this
// application generates, so every row reads the same way.
//
// Pure and synchronous: the caller resolves the counterparty and formats the date (the page
// owns the locale and the "Eingang" prefix for a document with no own date,
// decisions/0058-inbox-sorts-by-the-document-s-own-date.md), this only decides which name to
// use and how to compose the two halves.
import { shortenCompanyName } from "@/modules/contacts";

import type { DocumentDirection } from "@/persistence/repositories/contracts";

/** Everything the generated name is built from. */
export type DocumentNameParts = {
  /** A label the document's own type supplies, already translated by the caller, for a
   * document that has no counterparty because of what it IS: the platform of an app-store
   * report ("Apple", decisions/0060-app-store-reports-are-named-by-their-period.md) or the
   * kind of a bank statement ("Kontoauszug",
   * decisions/0061-a-statement-is-dated-by-its-last-booking.md). `null` for everything else,
   * including a report whose period could not be read. It outranks the counterparty, which
   * such a document never has. */
  typeLabel: string | null;
  /** The contact linked to this document in the role its direction makes the counterparty:
   * `sender` for an incoming document, `recipient` for an outgoing one. `null` for a tabular
   * import, which has no counterparty at all. */
  counterpartyName: string | null;
  /** The analyzer's extracted sender. Only ever a fallback, and never for an OUTGOING
   * document, where the sender is the workspace's own company rather than the other party. */
  sender: string | null;
  direction: DocumentDirection | null;
  originalFileName: string;
  /** Already formatted by the caller, including any "Eingang" prefix. */
  formattedDate: string;
};

/** `"financial_report (5).csv"` -> `"financial_report (5)"`. Only a real, short extension is
 * dropped, so a name that merely contains a dot keeps it. */
function withoutFileExtension(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

/**
 * Which name this document is filed under, before the date is appended. The document's own
 * type label first (a report's platform, a statement's kind), then the counterparty, then the
 * extracted sender (never for an outgoing document), and the uploaded file's own name last, so
 * a row always has something to show.
 */
export function documentNameSource(parts: DocumentNameParts): string {
  if (parts.typeLabel?.trim()) return parts.typeLabel.trim();
  if (parts.counterpartyName?.trim()) return shortenCompanyName(parts.counterpartyName);
  if (parts.direction !== "outgoing" && parts.sender?.trim()) return shortenCompanyName(parts.sender);
  return withoutFileExtension(parts.originalFileName).trim() || parts.originalFileName;
}

/**
 * The name shown for a document in the inbox: who it is with, then when it is from.
 * `"Bauwerk Generalbau, 24.11.2025"` for a letter, `"Apple, November 2025"` for a report
 * (whose caller passes the period as the date half, decisions/0060), and
 * `"Kontoauszug, 21.09.2026"` for a bank statement (its last booking, decisions/0061).
 */
export function documentDisplayName(parts: DocumentNameParts): string {
  const name = documentNameSource(parts);
  if (!parts.formattedDate) return name;
  return `${name}, ${parts.formattedDate}`;
}
