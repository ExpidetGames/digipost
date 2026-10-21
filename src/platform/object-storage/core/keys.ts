// Pure key builders (decisions/0012-object-storage.md, "Key layout"): every document
// object lives at `workspaces/<workspaceId>/documents/<documentId>/<variant>.pdf`, so a
// key alone shows which workspace owns an object. Both ids come from the database
// (Postgres `uuid` columns), never from client-provided names, so these builders reject
// anything that is not a syntactically valid UUID rather than building an unscoped or
// path-traversing key.
import { InvalidObjectKeySegmentError } from "./errors";

// RFC 4122 textual form (any variant/version - `gen_random_uuid()`'s v4 output and any
// other real UUID this application's own ids use both match).
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertUuid(field: string, value: string): string {
  if (!UUID_RE.test(value)) throw new InvalidObjectKeySegmentError(field, value);
  return value;
}

// F1b (decisions/0020-universal-intake.md): a structured intake file (XML/CSV/TSV) is stored
// as-is, never assembled into a PDF - a lowercase-letters-only extension keeps the key
// predictable and rules out path traversal via this segment the same way `assertUuid` does
// for the id segments.
const EXTENSION_RE = /^[a-z0-9]{1,10}$/;

function assertExtension(value: string): string {
  if (!EXTENSION_RE.test(value)) throw new InvalidObjectKeySegmentError("extension", value);
  return value;
}

/** `workspaces/<workspaceId>/documents/<documentId>/original.<extension>`: the exact bytes
 * the user uploaded, untouched. `extension` defaults to `"pdf"` (every upload before F1b, and
 * every PDF/image upload since - images are always assembled into a PDF first,
 * decisions/0015-documents-and-quotas.md); F1b's structured-file upload passes `"xml"`,
 * `"csv"`, or `"tsv"`. */
export function documentOriginalKey(input: { workspaceId: string; documentId: string; extension?: string }): string {
  const workspaceId = assertUuid("workspaceId", input.workspaceId);
  const documentId = assertUuid("documentId", input.documentId);
  const extension = assertExtension(input.extension ?? "pdf");
  return `workspaces/${workspaceId}/documents/${documentId}/original.${extension}`;
}

/** `workspaces/<workspaceId>/documents/<documentId>/searchable.pdf`: the server-built
 * PDF with an invisible OCR text layer, produced once processing finishes. */
export function documentSearchableKey(input: { workspaceId: string; documentId: string }): string {
  const workspaceId = assertUuid("workspaceId", input.workspaceId);
  const documentId = assertUuid("documentId", input.documentId);
  return `workspaces/${workspaceId}/documents/${documentId}/searchable.pdf`;
}

/** F5 (workspace deletion, decisions/0027-hardening-and-deletion.md): every object this
 * workspace ever owns lives under this one prefix (the key layout's own leading segment,
 * decisions/0012-object-storage.md), so listing and deleting everything under it removes
 * every document object (original + searchable) for the whole workspace in one sweep,
 * without needing to enumerate individual document ids first. */
export function workspaceStoragePrefix(workspaceId: string): string {
  return `workspaces/${assertUuid("workspaceId", workspaceId)}/`;
}
