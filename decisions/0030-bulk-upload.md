# Bulk upload: several selections become several documents, client-side only

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: What one browser file selection turns into when it should become more than one
document, the classification rules, and what this phase deliberately does not build
Canonical responsibility: Active source for `ui/upload-form.tsx`'s file-selection grouping
and its progress-queue UI
Maintenance triggers:
- The classification rules (PDF/structured-file/image grouping) change
- The upload queue's concurrency, ordering, or quota-stop behavior changes
- Any of the deliberately-excluded items below gets built after all
Last verified: 2026-09-21, initial version

## Status

Accepted

## Context

Before this phase, a file selection on `/dashboard/scan`'s "Datei hochladen" tab always meant
exactly one document: either one PDF, 1..20 JPEG/PNG images (assembled server-side into one
PDF, one page per image), or one structured file (XML/CSV/TSV/MT940). That single-document
contract is `POST /api/documents`'s own (`src/app/api/documents/route.ts`,
`core/upload-processing.ts`'s `processUploadParts`) and is unchanged by this phase - it is
still true after this change, just invoked more than once per selection when needed.

The product owner wants to select several unrelated pieces of mail (several scanned PDFs, or
several photos that are not pages of the same letter) in one go, without uploading them one at
a time by hand. Two meanings of "several files" already existed and had to stay distinguishable:
several PAGES of one letter (several images) versus several separate PIECES OF MAIL (several
PDFs, several structured files, or images the user explicitly marks as separate).

## Decision

Classification happens entirely client-side in `core/bulk-upload.ts`
(`classifyUploadGroups`), turning one selection into one or more groups; each group is
submitted as exactly one `POST /api/documents` request, unchanged from before. The rules:

1. Several PDFs, or several structured files (XML/CSV/TSV/MT940): always one document each.
2. Several images: stay pages of one document by default. A visible switch, "Jede Datei ist
   ein eigenes Dokument", shown only when the selection has 2+ images, makes every image its
   own document instead.
3. A mixed selection: every PDF/structured file gets its own document; the images in the
   selection are grouped per rule 2.
4. The Kamera tab (`src/modules/scanner`) is unchanged - it always produces one set of pages
   for one document, the same as before this phase.

The grouping check (`isImageFile`) is a best-effort MIME-type/extension sniff, for grouping
only - it is never the security boundary. The server's own magic-byte sniff
(`core/magic-bytes.ts`, `@/modules/intake`'s `sniffFileKind`) remains the sole authority on
what a file actually is; a file misclassified client-side only ever lands in the "wrong"
group and gets rejected by the server with its usual error code (most likely
`unsupported_file_type`), exactly as a single bad upload always has.

Groups upload sequentially, one request at a time (the assignment allowed "sequentially or 2
at a time"; sequential is the simpler of the two and was chosen for that reason alone). A
single group's `POST /api/documents` failure (duplicate/too-large/unsupported/...) marks that
group's row(s) `"Fehler"` with the existing German message and the queue continues to the next
group. A quota error (`quota_total_exceeded`/`quota_monthly_exceeded`) stops the queue outright
(every later request would fail the same way) and marks every still-waiting row `"übersprungen"`
plus a short summary message. `ui/upload-form.tsx` renders one row per FILE (not per group, so
several images sharing one document still each get their own row) with a "wartet"/"lädt
hoch"/"fertig"/"Fehler" state and an "X von Y" counter (`core/bulk-upload.ts`'s
`BulkUploadRow`/`applyGroupResult`/`countSettledRows`).

When the current selection classifies into exactly one group (the pre-existing, still by far
the most common case: one PDF, one structured file, or several images with the switch off),
behavior is unchanged - the client calls `uploadDocument` once and redirects straight to the
new document's detail page. The bulk queue/list UI, and the loss of the custom "Bezeichnung"
name field (it cannot meaningfully name several documents at once), only appear once a
selection would actually become more than one document.

## Deliberately NOT in this phase

- Folder picking.
- ZIP upload/extraction.
- Cancelling an in-progress queue.
- Retry-failed-only (a failed row must be re-selected and re-submitted like any other upload).
- Drag-and-drop of a folder.
- A progress bar per file (only the four discrete states above).
- Resumability across a reload/navigation.
- A `beforeunload` warning if the user navigates away mid-queue.

Each is a real gap for a very large batch (see this ADR's own module README entry for what a
200-file selection would look like in practice) but out of scope for this lean first version;
revisit if the product owner reports it as a real problem.

## Consequences

- A large selection (tens to hundreds of files) means that many sequential `POST
  /api/documents` round trips with no batching, so total wall-clock time scales linearly with
  file count and network latency; there is no way to speed this up without either a
  presigned/batch upload endpoint or real concurrency, both out of scope here.
- Closing the tab or navigating away mid-queue loses all remaining progress with no warning
  (deliberately excluded above) and no way to resume; the user must reselect whatever did not
  finish and start again, including re-doing already-`"fertig"` rows since there is no
  retry-failed-only mode either.
- The per-file list is not virtualized; a very large selection renders that many `<li>` rows
  at once. Fine at the scale this product's own document-count tiers imply (decisions/0017's
  largest tier has a 5000/month quota, not a 200-per-selection one), not verified beyond that.
