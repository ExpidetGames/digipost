import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, type PDFContext } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { extractEmbeddedXml } from "../core/embedded-xml";

async function buildPdfWithAttachment(fileName: string, xml: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  await doc.attach(new TextEncoder().encode(xml), fileName, { mimeType: "application/xml" });
  return doc.save();
}

/**
 * Registers a `/Filespec` dict (with an `/EF/F` stream holding `contents`) for `fileName`,
 * the exact shape `extractEmbeddedXml` reads back out - the low-level equivalent of what
 * `PDFDocument.attach` writes, built directly against `context` so the fixtures below can
 * wire it into a hand-built (and deliberately malformed) name tree rather than the flat one
 * `attach` always produces.
 */
function registerFileSpec(context: PDFContext, fileName: string, contents: Uint8Array): PDFRef {
  const streamDict = PDFDict.withContext(context);
  streamDict.set(PDFName.of("Length"), PDFNumber.of(contents.length));
  const streamRef = context.register(PDFRawStream.of(streamDict, contents));

  const efDict = PDFDict.withContext(context);
  efDict.set(PDFName.of("F"), streamRef);

  const fileSpecDict = PDFDict.withContext(context);
  fileSpecDict.set(PDFName.of("Type"), PDFName.of("Filespec"));
  fileSpecDict.set(PDFName.of("F"), PDFString.of(fileName));
  fileSpecDict.set(PDFName.of("EF"), efDict);

  return context.register(fileSpecDict);
}

/** A name-tree leaf: a `/Names` dict with one (fileName, fileSpecRef) entry. */
function buildNamesLeaf(context: PDFContext, fileName: string, fileSpecRef: PDFRef): PDFDict {
  const namesArray = PDFArray.withContext(context);
  namesArray.push(PDFString.of(fileName));
  namesArray.push(fileSpecRef);
  const dict = PDFDict.withContext(context);
  dict.set(PDFName.of("Names"), namesArray);
  return dict;
}

/** Points the document's `/Names/EmbeddedFiles` at `rootDict` - the low-level equivalent of
 * whatever `PDFDocument.attach` normally wires up, but for a hand-built root. */
function setEmbeddedFilesRoot(doc: PDFDocument, rootDict: PDFDict): void {
  const namesDict = PDFDict.withContext(doc.context);
  namesDict.set(PDFName.of("EmbeddedFiles"), rootDict);
  doc.catalog.set(PDFName.of("Names"), namesDict);
}

async function timeBounded<T>(fn: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, elapsedMs: Date.now() - start };
}

describe("extractEmbeddedXml", () => {
  it("extracts a factur-x.xml attachment", async () => {
    const xml = '<?xml version="1.0"?><CrossIndustryInvoice>ZUGFeRD content</CrossIndustryInvoice>';
    const pdfBytes = await buildPdfWithAttachment("factur-x.xml", xml);

    const extracted = await extractEmbeddedXml(pdfBytes);
    expect(extracted).not.toBeNull();
    expect(new TextDecoder().decode(extracted!)).toBe(xml);
  });

  it("matches the attachment name case-insensitively", async () => {
    const xml = "<Invoice/>";
    const pdfBytes = await buildPdfWithAttachment("Factur-X.XML", xml);

    const extracted = await extractEmbeddedXml(pdfBytes);
    expect(extracted).not.toBeNull();
    expect(new TextDecoder().decode(extracted!)).toBe(xml);
  });

  it("extracts a zugferd-invoice.xml attachment", async () => {
    const xml = "<Invoice>zugferd</Invoice>";
    const pdfBytes = await buildPdfWithAttachment("zugferd-invoice.xml", xml);

    const extracted = await extractEmbeddedXml(pdfBytes);
    expect(new TextDecoder().decode(extracted!)).toBe(xml);
  });

  it("returns null when the PDF has an attachment but not an invoice XML one", async () => {
    const pdfBytes = await buildPdfWithAttachment("readme.txt", "just some notes");
    expect(await extractEmbeddedXml(pdfBytes)).toBeNull();
  });

  it("returns null when the PDF has no attachments at all", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const pdfBytes = await doc.save();

    expect(await extractEmbeddedXml(pdfBytes)).toBeNull();
  });

  // R1 security review (high, confirmed): the original recursive name-tree walk had no
  // visited-set, depth limit, or node cap - a crafted PDF could force exponential work
  // without ever throwing. Every fixture below is a name tree `PDFDocument.attach` itself
  // would never produce (hand-built directly against the document's `PDFContext`), and every
  // assertion includes a generous wall-clock bound: on the pre-fix code, the DAG and cycle
  // fixtures either never return or take far longer than this bound, so a regression shows up
  // as a timed-out test, not just a wrong return value.
  const TIME_BOUND_MS = 2000;

  it("terminates quickly on a name tree shaped as a DAG (two parents sharing one child, repeated many levels deep)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const context = doc.context;

    const fileSpecRef = registerFileSpec(context, "unreachable.txt", new TextEncoder().encode("never found"));
    let currentRef = context.register(buildNamesLeaf(context, "readme.txt", fileSpecRef));
    // 40 levels, each node's two Kids entries pointing at the SAME child ref: naive recursion
    // without a visited set explores 2^40 paths through this, though every level only ever
    // introduces one actual new object.
    for (let level = 0; level < 40; level++) {
      const kids = PDFArray.withContext(context);
      kids.push(currentRef);
      kids.push(currentRef);
      const parent = PDFDict.withContext(context);
      parent.set(PDFName.of("Kids"), kids);
      currentRef = context.register(parent);
    }
    const rootDict = context.lookup(currentRef, PDFDict);
    setEmbeddedFilesRoot(doc, rootDict);
    const pdfBytes = await doc.save();

    const { result, elapsedMs } = await timeBounded(() => extractEmbeddedXml(pdfBytes));

    // 40 levels exceeds the depth cap, so the one real entry (40 levels down) is never
    // reached - the important assertion is that this returns at all, and quickly.
    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(TIME_BOUND_MS);
  });

  it("still finds a genuine attachment through a DAG-shaped tree within the depth bound", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const context = doc.context;

    const xml = "<Invoice>found through the DAG</Invoice>";
    const fileSpecRef = registerFileSpec(context, "factur-x.xml", new TextEncoder().encode(xml));
    let currentRef = context.register(buildNamesLeaf(context, "factur-x.xml", fileSpecRef));
    // 20 levels, well within the depth cap - the visited-set dedup must not prevent the
    // first (and only) encounter of the shared leaf from being explored.
    for (let level = 0; level < 20; level++) {
      const kids = PDFArray.withContext(context);
      kids.push(currentRef);
      kids.push(currentRef);
      const parent = PDFDict.withContext(context);
      parent.set(PDFName.of("Kids"), kids);
      currentRef = context.register(parent);
    }
    const rootDict = context.lookup(currentRef, PDFDict);
    setEmbeddedFilesRoot(doc, rootDict);
    const pdfBytes = await doc.save();

    const { result, elapsedMs } = await timeBounded(() => extractEmbeddedXml(pdfBytes));

    expect(result).not.toBeNull();
    expect(new TextDecoder().decode(result!)).toBe(xml);
    expect(elapsedMs).toBeLessThan(TIME_BOUND_MS);
  });

  it("terminates quickly on a genuine cycle (a node's own Kids pointing back at itself)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const context = doc.context;

    const selfRef = context.nextRef();
    const selfDict = PDFDict.withContext(context);
    const kids = PDFArray.withContext(context);
    kids.push(selfRef); // points back at itself: a genuine cycle, not just a DAG
    selfDict.set(PDFName.of("Kids"), kids);
    context.assign(selfRef, selfDict);

    const rootKids = PDFArray.withContext(context);
    rootKids.push(selfRef);
    const rootDict = PDFDict.withContext(context);
    rootDict.set(PDFName.of("Kids"), rootKids);
    setEmbeddedFilesRoot(doc, rootDict);
    const pdfBytes = await doc.save();

    const { result, elapsedMs } = await timeBounded(() => extractEmbeddedXml(pdfBytes));

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(TIME_BOUND_MS);
  });

  it("terminates quickly on a linear chain deeper than the depth cap, without finding the entry at the bottom", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const context = doc.context;

    const xml = "<Invoice>too deep to reach</Invoice>";
    const fileSpecRef = registerFileSpec(context, "factur-x.xml", new TextEncoder().encode(xml));
    let currentRef = context.register(buildNamesLeaf(context, "factur-x.xml", fileSpecRef));
    for (let level = 0; level < 40; level++) {
      const kids = PDFArray.withContext(context);
      kids.push(currentRef); // a single child per level: depth, not width, is the attack here
      const parent = PDFDict.withContext(context);
      parent.set(PDFName.of("Kids"), kids);
      currentRef = context.register(parent);
    }
    const rootDict = context.lookup(currentRef, PDFDict);
    setEmbeddedFilesRoot(doc, rootDict);
    const pdfBytes = await doc.save();

    const { result, elapsedMs } = await timeBounded(() => extractEmbeddedXml(pdfBytes));

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(TIME_BOUND_MS);
  });

  it("skips an embedded file above the size cap rather than reading it into memory", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const context = doc.context;

    const oversized = new Uint8Array(11 * 1024 * 1024); // above the 10 MB cap
    const fileSpecRef = registerFileSpec(context, "factur-x.xml", oversized);
    const leaf = buildNamesLeaf(context, "factur-x.xml", fileSpecRef);
    setEmbeddedFilesRoot(doc, leaf);
    const pdfBytes = await doc.save();

    const { result, elapsedMs } = await timeBounded(() => extractEmbeddedXml(pdfBytes));

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(TIME_BOUND_MS);
  });
});
