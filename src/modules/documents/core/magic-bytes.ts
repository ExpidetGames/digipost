// Pure magic-byte sniffing (decisions/0015-documents-and-quotas.md: "detect types by magic
// bytes, never by the client's MIME type or extension"). No I/O, no dependency on the
// upload's declared `Content-Type` at all.
export type SniffedFileType = "pdf" | "jpeg" | "png";

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/** `null` when `bytes` matches none of the supported signatures (PDF, JPEG, PNG) -
 * the caller maps that to `unsupported_file_type`. */
export function sniffFileType(bytes: Uint8Array): SniffedFileType | null {
  if (startsWith(bytes, PDF_SIGNATURE)) return "pdf";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  return null;
}
