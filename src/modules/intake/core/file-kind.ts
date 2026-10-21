// Pure file-kind sniffing for the universal intake recognizer (decisions/0020-universal-intake.md).
// Mirrors `src/modules/documents/core/magic-bytes.ts`'s "detect by bytes, never by the
// client's declared Content-Type or file extension" rule, re-implemented here (not imported
// from `src/modules/documents`) because that module owns a narrower PDF/JPEG/PNG-only
// contract and this owner must not create a cross-module dependency for three constants.
// No I/O.

export const FILE_KINDS = ["pdf", "jpeg", "png", "xml", "csv", "tsv", "mt940", "unknown"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// BOM signatures this sniffer strips before looking at text content, in order of length
// (UTF-8's is a prefix-free 3-byte marker; UTF-16's are 2 bytes each).
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Strips a leading byte-order mark, if present, and decodes the remainder as text.
 * UTF-16 is decoded via `TextDecoder` (Node/edge runtime both support "utf-16le"; a
 * big-endian BOM is byte-swapped first since there is no native "utf-16be" decoder label
 * in every runtime this application targets). Falls back to UTF-8 when nothing else
 * matches - the common case for CSV/XML uploads from German accounting software.
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (startsWith(bytes, UTF8_BOM)) {
    return new TextDecoder("utf-8").decode(bytes.subarray(UTF8_BOM.length));
  }
  if (startsWith(bytes, UTF16_LE_BOM)) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(UTF16_LE_BOM.length));
  }
  if (startsWith(bytes, UTF16_BE_BOM)) {
    const rest = bytes.subarray(UTF16_BE_BOM.length);
    const swapped = new Uint8Array(rest.length);
    for (let i = 0; i + 1 < rest.length; i += 2) {
      swapped[i] = rest[i + 1]!;
      swapped[i + 1] = rest[i]!;
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  return detectEncoding(bytes) === "windows-1252" ? new TextDecoder("windows-1252").decode(bytes) : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

const XML_PROLOG_PATTERN = /^\s*<\?xml[\s?]/i;
const XML_ROOT_ELEMENT_PATTERN = /^\s*<[a-zA-Z_][\w.-]*(:[a-zA-Z_][\w.-]*)?[\s/>]/;

function looksLikeXml(text: string): boolean {
  return XML_PROLOG_PATTERN.test(text) || XML_ROOT_ELEMENT_PATTERN.test(text);
}

// MT940 structural sniff (decisions/0028-mt940-support.md): SWIFT tag lines at line starts,
// in particular `:20:` (Transaction Reference Number, mandatory) plus at least one `:61:`
// (Statement Line) - a file with neither is never MT940, regardless of extension. Tolerates a
// leading `{1:`/`{4:` SWIFT block-header envelope some banks emit (stripped before the
// line-start check) and either CRLF or LF line endings; a trailing lone `-` record terminator
// needs no special handling here since it never itself starts with `:`. Deliberately a small,
// self-contained duplicate of `mt940-parser.ts`'s own (fuller) envelope stripping, mirroring
// this codebase's existing precedent of `camt053-detect.ts`/`camt053-parser.ts` each keeping
// their own copy of the camt.053 namespace pattern rather than importing one from the other.
function stripSwiftBlockHeaders(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\{[1235]:[^{}]*\}/g, "")
    .replace(/\{4:/g, "");
}

const MT940_REFERENCE_TAG_PATTERN = /^:20:/m;
const MT940_STATEMENT_LINE_TAG_PATTERN = /^:61:/m;

function looksLikeMt940(text: string): boolean {
  const stripped = stripSwiftBlockHeaders(text);
  return MT940_REFERENCE_TAG_PATTERN.test(stripped) && MT940_STATEMENT_LINE_TAG_PATTERN.test(stripped);
}

/**
 * Detects whether `bytes` is plain UTF-8 or Windows-1252 (the common alternative German
 * accounting/banking software still exports, e.g. Sparkasse's older CSV exports): decodes as
 * UTF-8 first, and falls back to Windows-1252 the moment that produces even one U+FFFD
 * replacement character - a byte sequence UTF-8 cannot represent, which a German umlaut
 * encoded as a single Windows-1252 byte (e.g. 0xE4 for "ä") reliably triggers.
 */
export function detectEncoding(bytes: Uint8Array): "utf-8" | "windows-1252" {
  const utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return utf8Text.includes("�") ? "windows-1252" : "utf-8";
}

const DELIMITER_CANDIDATES = [",", ";", "\t", "|"] as const;
type DelimiterCandidate = (typeof DELIMITER_CANDIDATES)[number];

/** Counts a delimiter's occurrences per non-empty line, outside double-quoted spans - a
 * cheap heuristic sniff, not a real CSV parse (that is `sampleTabular`'s job), but quote-aware
 * enough that a quoted field carrying the delimiter itself (Google Play's `"Jan 5, 2025"`) is
 * not miscounted as an extra column separator. A double-quote toggles an "inside a quoted
 * field" flag; two consecutive quotes (RFC 4180's escaped-quote convention) toggle it twice,
 * correctly netting to no change. */
function countPerLine(lines: string[], delimiter: DelimiterCandidate): number[] {
  return lines.map((line) => {
    let count = 0;
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (char === delimiter && !inQuotes) count++;
    }
    return count;
  });
}

/** How many sampled lines must agree on the same positive delimiter count for a delimiter to
 * "fit". Real reports (Apple's payment summary, Google Play's earnings report) carry a title
 * or footer row whose own field count differs from the data rows' (a title cell followed by
 * empty cells at a different width, a footer note in an otherwise-empty row) - requiring every
 * line to agree, as this used to, made such a file sniff as `unknown` outright. Requiring only
 * a quorum of lines (capped at the sample size for a file with fewer lines than that) lets the
 * data rows decide while a preamble or footer of a different shape no longer disqualifies the
 * whole file. */
const DELIMITER_QUORUM = 3;

/** A delimiter "fits" when at least `DELIMITER_QUORUM` of the sampled non-empty lines (or
 * every line, for a shorter sample) share the same positive count of it. */
function findConsistentDelimiter(lines: string[]): DelimiterCandidate | null {
  const requiredAgreement = Math.min(DELIMITER_QUORUM, lines.length);
  for (const delimiter of DELIMITER_CANDIDATES) {
    const counts = countPerLine(lines, delimiter);
    const tally = new Map<number, number>();
    for (const count of counts) {
      if (count <= 0) continue;
      tally.set(count, (tally.get(count) ?? 0) + 1);
    }
    for (const frequency of tally.values()) {
      if (frequency >= requiredAgreement) return delimiter;
    }
  }
  return null;
}

/** A byte is "binary-looking" when it is a control character other than tab/CR/LF - used to
 * reject a file that merely happens to decode without throwing (a PDF/image byte soup does). */
function nonTextByteRatio(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let nonText = 0;
  const sampleSize = Math.min(bytes.length, 8192);
  for (let i = 0; i < sampleSize; i++) {
    const byte = bytes[i]!;
    const isControl = byte < 0x09 || (byte > 0x0d && byte < 0x20);
    if (isControl || byte === 0x00) nonText++;
  }
  return nonText / sampleSize;
}

/**
 * Sniffs the format of an uploaded file from its bytes alone (decisions/0020-universal-intake.md's
 * "the file format only decides how we read the content"). Order matters: binary signatures
 * first (cheap, unambiguous), then XML (a `<?xml` prolog or a root element), then a CSV/TSV
 * heuristic (mostly printable text, a consistent delimiter count across the first several
 * lines), else `"unknown"`.
 */
export function sniffFileKind(bytes: Uint8Array): FileKind {
  if (startsWith(bytes, PDF_SIGNATURE)) return "pdf";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";

  if (nonTextByteRatio(bytes) > 0.01) return "unknown";

  const text = decodeTextBytes(bytes);
  if (looksLikeXml(text)) return "xml";
  // Checked before the CSV/TSV delimiter heuristic below: an MT940 file's tag lines have no
  // consistent per-line delimiter count of their own, but a bank-generated CSV/TSV never
  // contains a line starting with `:20:`/`:61:` either, so this ordering never mis-sniffs one
  // format as the other.
  if (looksLikeMt940(text)) return "mt940";

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 10);
  if (lines.length < 2) return "unknown";

  const delimiter = findConsistentDelimiter(lines);
  if (delimiter === "\t") return "tsv";
  if (delimiter === "," || delimiter === ";" || delimiter === "|") return "csv";
  return "unknown";
}
