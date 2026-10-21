// Upload limits (decisions/0015-documents-and-quotas.md, architecture brief):
// a single source so the route handler, the client upload helper, and the upload form's
// copy all agree.
/** Vercel's Functions request body limit is 4.5 MB; 4 MB leaves headroom for multipart
 * boundaries/headers (decisions/0012-object-storage.md). */
export const MAX_UPLOAD_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_PAGES = 20;
