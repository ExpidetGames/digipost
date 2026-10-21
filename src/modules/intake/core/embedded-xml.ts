// Extracts a ZUGFeRD/Factur-X/XRechnung invoice XML attachment from a PDF
// (decisions/0020-universal-intake.md's other self-identifying format: a hybrid PDF/A-3
// invoice that embeds its own structured XML twin). Deterministic, no AI.
//
// `pdf-lib` (already a dependency, `src/modules/documents/core/searchable-pdf.ts`'s owner)
// only exposes a WRITE API for attachments (`PDFDocument.attach`, see
// `node_modules/pdf-lib/cjs/api/PDFDocument.js`) - there is no public `getAttachments()` or
// equivalent to read one back out. This walks the PDF's own `/Names/EmbeddedFiles` name
// tree (ISO 32000-1 §7.7.4/§7.11.4) using pdf-lib's lower-level object primitives
// (`PDFDict`/`PDFArray`/`PDFName`/`decodePDFRawStream`), which the package does export.
//
// Security review finding (R1, high, confirmed): a `/Kids` name tree is nominally a tree,
// but nothing in the file format stops two parent nodes from pointing at the SAME child
// `PDFRef` (a DAG) or, worse, a child eventually pointing back at one of its own ancestors (a
// genuine cycle) - `PDFDocument.load` never validates that. The original recursion had no
// visited-set, depth limit, or node cap, so a crafted PDF with ~40 levels of shared
// references could force `2^40` node visits without ever throwing, and this function runs on
// every OCR'd PDF upload (`documents-use-cases.ts`'s `processOcrDocument`) - an unauthenticated
// member-level upload could exhaust a worker's CPU. Three independent bounds now apply: a
// `PDFRef` is only ever expanded once (`visitedRefs`, keyed by `PDFRef.tag`, which collapses
// both the DAG and the cycle case to linear work), a hard depth cap
// (`MAX_NAME_TREE_DEPTH`), and a total-node budget (`MAX_NAME_TREE_WORK_UNITS`, also charged
// per `/Names` entry examined so a single node with an enormous flat array cannot bypass the
// per-node accounting). Exceeding any bound simply stops expanding that branch - the function
// degrades to "attachment not found down that path" rather than throwing, consistent with its
// existing "never throws for an ordinary PDF" contract. See `tests/embedded-xml.test.ts` for
// the DAG/cycle/deep-chain fixtures and their time bounds.
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";

/** Attachment file names ZUGFeRD/Factur-X/XRechnung profiles use for the embedded invoice
 * XML, matched case-insensitively. */
const EMBEDDED_INVOICE_XML_NAMES = ["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"];

/** No legitimate name tree for a handful of embedded-file entries needs to nest this deep;
 * this is purely a backstop against a maliciously deep `/Kids` chain. */
const MAX_NAME_TREE_DEPTH = 32;

/** Total node-visits-plus-names-entries-examined budget across the whole walk (not per
 * level) - bounds a wide-but-shallow tree the same way the depth cap bounds a deep one, and
 * bounds a single node with an oversized `/Names` array the same way. */
const MAX_NAME_TREE_WORK_UNITS = 256;

/** An embedded file above this size is never read into memory, checked before
 * `decodePDFRawStream` runs (a small compressed payload can still decode to something much
 * larger, see `isDeclaredStreamTooLarge`'s own comment) - a legitimate ZUGFeRD/Factur-X/
 * XRechnung XML twin is a few hundred KB at most. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isEmbeddedInvoiceXmlName(name: string): boolean {
  return EMBEDDED_INVOICE_XML_NAMES.includes(name.toLowerCase());
}

/** Shared mutable walk state, threaded through the recursion rather than returned/merged at
 * every level (simpler than plumbing a budget count back up through every recursive call's
 * return value). */
type NameTreeWalkBudget = { remainingWorkUnits: number };

/** Walks a PDF name tree (ISO 32000-1 §7.9.6): either a flat `/Names` array of alternating
 * (name, value-or-ref) pairs, or a `/Kids` array of sub name-tree dictionaries to recurse
 * into. Returns every (name, value) pair found, resolving references along the way, bounded
 * by `visitedRefs`/`depth`/`budget` (see this file's header comment for why each exists). */
function collectNameTreeEntries(dict: PDFDict, visitedRefs: Set<string>, budget: NameTreeWalkBudget, depth: number): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  if (depth > MAX_NAME_TREE_DEPTH || budget.remainingWorkUnits <= 0) return entries;
  budget.remainingWorkUnits -= 1;

  const namesArray = dict.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (namesArray) {
    for (let i = 0; i + 1 < namesArray.size() && budget.remainingWorkUnits > 0; i += 2) {
      budget.remainingWorkUnits -= 1;
      const nameObject = namesArray.lookup(i);
      if (!(nameObject instanceof PDFString) && !(nameObject instanceof PDFHexString)) continue;
      const valueRef = namesArray.get(i + 1);
      entries.push([nameObject.decodeText(), valueRef]);
    }
  }

  const kids = dict.lookupMaybe(PDFName.of("Kids"), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size() && budget.remainingWorkUnits > 0; i++) {
      const kidRef = kids.get(i);
      let kidDict: PDFDict | null = null;
      if (kidRef instanceof PDFRef) {
        // Marking the ref visited BEFORE recursing is what turns a genuine cycle (a
        // descendant's `/Kids` pointing back at an ancestor) into a no-op on the repeat
        // visit, not just a DAG's re-converging branches.
        if (visitedRefs.has(kidRef.tag)) continue;
        visitedRefs.add(kidRef.tag);
        kidDict = dict.context.lookup(kidRef, PDFDict);
      } else if (kidRef instanceof PDFDict) {
        kidDict = kidRef;
      }
      if (kidDict) entries.push(...collectNameTreeEntries(kidDict, visitedRefs, budget, depth + 1));
    }
  }

  return entries;
}

function resolveDict(context: PDFDocument["context"], value: unknown): PDFDict | null {
  if (value instanceof PDFRef) {
    const resolved = context.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  }
  return value instanceof PDFDict ? value : null;
}

/**
 * Resolves to a `PDFRawStream` specifically (not the abstract `PDFStream` base class) - the
 * only concrete stream subclass a freshly loaded, not-yet-modified PDF ever produces, and the
 * only one `decodePDFRawStream` accepts.
 */
function resolveRawStream(context: PDFDocument["context"], value: unknown): PDFRawStream | null {
  if (value instanceof PDFRef) {
    const resolved = context.lookup(value);
    return resolved instanceof PDFRawStream ? resolved : null;
  }
  return value instanceof PDFRawStream ? value : null;
}

/**
 * `true` when the stream's own declared size - its encoded `/Length`, its already-in-memory
 * `contents.length`, or (when present) the EmbeddedFile stream's `/Params/Size` decoded-size
 * hint (ISO 32000-1 Table 46) - exceeds `MAX_ATTACHMENT_BYTES`. Checked BEFORE
 * `decodePDFRawStream` runs: a `/Length` is not required to be accurate, but the encoded
 * bytes are already fully in memory by this point either way, and a small Flate-compressed
 * payload can still decode to something far larger, so this is a defense against both an
 * oversized attachment outright and a compression-bomb-shaped one, without ever needing to
 * inflate the stream just to find out.
 */
function isDeclaredStreamTooLarge(stream: PDFRawStream): boolean {
  if (stream.contents.length > MAX_ATTACHMENT_BYTES) return true;
  const declaredLength = stream.dict.lookupMaybe(PDFName.of("Length"), PDFNumber);
  if (declaredLength && declaredLength.asNumber() > MAX_ATTACHMENT_BYTES) return true;
  const params = stream.dict.lookupMaybe(PDFName.of("Params"), PDFDict);
  const decodedSizeHint = params?.lookupMaybe(PDFName.of("Size"), PDFNumber);
  if (decodedSizeHint && decodedSizeHint.asNumber() > MAX_ATTACHMENT_BYTES) return true;
  return false;
}

/**
 * Returns the bytes of a ZUGFeRD/Factur-X/XRechnung invoice XML attachment embedded in
 * `pdfBytes`, or `null` when the PDF has no `/Names/EmbeddedFiles` tree, none of its entries
 * (within this function's traversal bounds, see the header comment) match one of the known
 * attachment file names, or every matching entry is oversized. Never throws for an ordinary
 * PDF with no attachment at all, nor for a maliciously shaped name tree (DAG, cycle, or
 * excessive depth/width - all degrade to "not found down that path", never an exception or a
 * hang); a genuinely unparseable/corrupt PDF still throws (pdf-lib's own `PDFDocument.load`
 * error), since that is a different failure than "no invoice attached".
 */
export async function extractEmbeddedXml(pdfBytes: Uint8Array): Promise<Uint8Array | null> {
  const document = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });

  const embeddedFiles = document.catalog
    .lookupMaybe(PDFName.of("Names"), PDFDict)
    ?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  if (!embeddedFiles) return null;

  const entries = collectNameTreeEntries(embeddedFiles, new Set<string>(), { remainingWorkUnits: MAX_NAME_TREE_WORK_UNITS }, 0);

  for (const [name, fileSpecValue] of entries) {
    if (!isEmbeddedInvoiceXmlName(name)) continue;

    const fileSpecDict = resolveDict(document.context, fileSpecValue);
    const efDict = fileSpecDict?.lookupMaybe(PDFName.of("EF"), PDFDict);
    const fileRef = efDict?.get(PDFName.of("F")) ?? efDict?.get(PDFName.of("UF"));
    const stream = resolveRawStream(document.context, fileRef);
    if (!stream) continue;
    if (isDeclaredStreamTooLarge(stream)) continue; // oversized candidate: skip it, keep looking

    return decodePDFRawStream(stream).decode();
  }

  return null;
}
