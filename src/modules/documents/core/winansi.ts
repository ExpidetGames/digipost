// Standard PDF-lib fonts (Helvetica et al.) are WinAnsi-encoded only: `drawText` throws for
// any character outside that set. German business letters need umlauts (ä/ö/ü/Ä/Ö/Ü) and ß,
// all of which WinAnsi (Windows-1252) covers - this sanitizer keeps those and every other
// WinAnsi-representable character, replacing anything else (emoji, CJK, most other Unicode)
// with "?" rather than letting `src/modules/documents/core/searchable-pdf.ts`'s `drawText`
// call throw partway through building the document.
//
// The allowed ranges are: printable ASCII (0x20-0x7E), Latin-1 supplement (0xA0-0xFF, which
// covers ä/ö/ü/ß/Ä/Ö/Ü at 0xE4/0xF6/0xFC/0xDF/0xC4/0xD6/0xDC), plus WinAnsi's own
// higher-code-point punctuation (smart quotes, dashes, ellipsis, per mille, Euro sign, etc.)
// that Latin-1 does not include but Windows-1252 does.
const WINANSI_EXTRA_CHARS =
  "ŒœŠšŸŽžƒˆ˜" + // Œ œ Š š Ÿ Ž ž ƒ ˆ ˜
  "–—‘’‚“”„†‡" + // – — ‘ ’ ‚ “ ” „ † ‡
  "•…‰‹›€"; // • … ‰ ‹ › €

const WINANSI_SAFE_RE = new RegExp(`[^\\x20-\\x7E\\u00A0-\\u00FF${WINANSI_EXTRA_CHARS}]`, "g");

export function sanitizeWinAnsi(text: string): string {
  return text.replace(WINANSI_SAFE_RE, "?");
}
