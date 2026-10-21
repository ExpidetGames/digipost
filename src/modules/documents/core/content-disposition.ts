// Pure RFC 5987 `Content-Disposition` header builder: a document's original file name can
// contain non-ASCII characters (German umlauts, an invoice sender's name, ...), so the
// header needs both a plain ASCII fallback (`filename=`) and the encoded extended form
// (`filename*=`) browsers prefer when present.
export function contentDispositionHeader(disposition: "inline" | "attachment", fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(fileName);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
