// Mirrors `src/modules/documents/core/upload-limits.ts` (decisions/0015-documents-and-quotas.md).
// Duplicated on purpose, not imported: that module's limits are published only through
// `src/modules/documents/server.ts` (`import "server-only"`), which a client component
// (this whole module runs client-side) cannot import at all - Next.js refuses to bundle a
// "server-only" module into client code. Keep these two values in sync by hand if the
// documents module's upload limits ever change.
export const MAX_SCANNER_PAGES = 20;

/** 4 MB, the same total-request budget `src/modules/documents` enforces (Vercel's 4.5 MB
 * function body limit leaves headroom for multipart overhead). */
export const MAX_UPLOAD_TOTAL_BYTES = 4 * 1024 * 1024;
