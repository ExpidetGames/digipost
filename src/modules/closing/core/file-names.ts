// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). What a document's
// file is called inside the export ZIP, and nothing else: pure, synchronous, no I/O. The
// workbook's "Datei" column and the archive entry are both written from the SAME result of
// `assignBelegFileNames`, so the two can never disagree about a single character.
import { MT940_MIME_TYPE } from "@/modules/intake";
import type { DocumentDirection } from "@/persistence/repositories/contracts";

/** The workbook at the root of the archive. */
export const OVERVIEW_FILE_NAME = "uebersicht.xlsx";
/** Evidence the workspace RECEIVED: every incoming document, and everything with no direction
 * at all (a report, a bank statement). Trailing slash included. */
export const BELEGE_DIRECTORY = "belege/";
/** Evidence the workspace ISSUED: a document whose direction is `outgoing`. Its own folder
 * because it is a different thing from an incoming receipt, and because nine outgoing
 * invoices among seventy incoming ones are otherwise unfindable (decisions/0066). */
export const AUSGANGSRECHNUNGEN_DIRECTORY = "ausgangsrechnungen/";

/** Which of the two folders a document belongs in. The ONE place that decision is made: the
 * workbook's "Datei" column and the archive entry both read it out of
 * `assignBelegFileNames`'s result. */
export function closingDirectoryFor(direction: DocumentDirection | null): string {
  return direction === "outgoing" ? AUSGANGSRECHNUNGEN_DIRECTORY : BELEGE_DIRECTORY;
}

/** How much of the generated name survives into the file name. Long enough to recognize a
 * document at a glance, short enough that date + name + id + extension stays well inside the
 * ~255-byte component limit every relevant filesystem has. */
const MAX_NAME_SLUG_LENGTH = 60;
/** Enough of the document id to make two documents with the same date and the same name
 * distinct; `uuid`'s first block is 8 hex characters. */
const ID_SUFFIX_LENGTH = 8;

/** German letters that have a real transliteration, applied before diacritics are stripped so
 * "Müller" becomes "Mueller" rather than "Muller". */
const TRANSLITERATIONS: [RegExp, string][] = [
  [/ä/g, "ae"],
  [/ö/g, "oe"],
  [/ü/g, "ue"],
  [/Ä/g, "Ae"],
  [/Ö/g, "Oe"],
  [/Ü/g, "Ue"],
  [/ß/g, "ss"],
];

/** Media type -> the extension that media type actually calls for. A bank statement is XML or
 * MT940 and an app-store report a CSV; not everything in this product is a PDF
 * (decisions/0066). */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "application/xml": "xml",
  "text/xml": "xml",
  [MT940_MIME_TYPE]: "mt940",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/plain": "txt",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/tiff": "tiff",
};

/** Lowercase, no dot. Falls back to the uploaded file's own extension, then to `bin` - never
 * to `pdf`, which would mislabel a statement. */
export function fileExtensionFor(mimeType: string, originalFileName: string): string {
  const known = EXTENSION_BY_MEDIA_TYPE[mimeType.toLowerCase().split(";")[0]!.trim()];
  if (known) return known;
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(originalFileName);
  if (fromName) return fromName[1]!.toLowerCase();
  return "bin";
}

/**
 * A filesystem-safe, cross-platform slug: transliterated, diacritics stripped, every
 * remaining non-alphanumeric run collapsed to a single `-`, trimmed, and truncated. Case is
 * preserved (a human reads these names), but nothing a filesystem, a ZIP reader, or a shell
 * could misinterpret survives - no slash, backslash, colon, quote, space, dot, or control
 * character.
 */
export function slugifyFileNamePart(raw: string): string {
  let value = raw;
  for (const [pattern, replacement] of TRANSLITERATIONS) value = value.replace(pattern, replacement);
  const ascii = value
    .normalize("NFD")
    // Strip combining marks left over from the normalization (é -> e).
    .replace(/[̀-ͯ]/g, "");
  const collapsed = ascii
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_SLUG_LENGTH)
    // The truncation above may have left a trailing separator.
    .replace(/-+$/g, "");
  return collapsed || "beleg";
}

export type BelegFileNameInput = {
  /** The document's id - only its first characters are used, as the uniqueness tie-break. */
  id: string;
  /** Decides the folder (`closingDirectoryFor`), nothing else. */
  direction: DocumentDirection | null;
  /** The document's effective date, ISO `YYYY-MM-DD` (the same expression the inbox sorts
   * by, decisions/0058/0060/0061). */
  effectiveDate: string;
  /** The generated name this document is filed under (`documentNameSource`), before any date
   * half was appended. */
  name: string;
  /** Lowercase, no dot. */
  extension: string;
};

/** `2026-01-15_Bauwerk-Generalbau_a1b2c3d4.pdf` - date first so a plain alphabetical listing
 * is chronological. */
export function belegFileName(input: BelegFileNameInput): string {
  const idSuffix = input.id.replace(/[^A-Za-z0-9]/g, "").slice(0, ID_SUFFIX_LENGTH) || "0";
  return `${input.effectiveDate}_${slugifyFileNamePart(input.name)}_${idSuffix}.${input.extension}`;
}

/**
 * The path inside the archive for every document, in one pass: `belege/<file>`, or
 * `ausgangsrechnungen/<file>` for one the workspace issued itself. The id suffix already makes
 * a collision impossible for two DIFFERENT documents, so the `-2`/`-3` pass below only ever
 * fires for a genuinely repeated id (which cannot happen for rows out of one `select`) - it
 * exists so "unique" is a property of this function rather than an assumption about its input.
 * Uniqueness is per FULL PATH, so the same name in the two folders is not a collision.
 */
export function assignBelegFileNames(documents: BelegFileNameInput[]): Map<string, string> {
  const taken = new Set<string>();
  const byId = new Map<string, string>();

  for (const document of documents) {
    const directory = closingDirectoryFor(document.direction);
    const base = `${directory}${belegFileName(document)}`;
    let candidate = base;
    let attempt = 2;
    while (taken.has(candidate)) {
      const dot = base.lastIndexOf(".");
      candidate = `${base.slice(0, dot)}-${attempt}${base.slice(dot)}`;
      attempt += 1;
    }
    taken.add(candidate);
    byId.set(document.id, candidate);
  }

  return byId;
}
