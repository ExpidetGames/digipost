// XXE and entity-expansion ("billion laughs") protection for every XML document this module
// parses (decisions/0020-universal-intake.md). Untrusted XML (a bank statement export, an
// embedded ZUGFeRD invoice) must never be handed to a parser that could resolve an external
// entity (XXE: exfiltrate a local file, make an outbound request) or expand a nested internal
// entity chain into gigabytes of memory (billion laughs).
//
// `assertSafeXml` is the actual gate: a fast text scan, BEFORE any parsing happens at all,
// that rejects any document declaring a DOCTYPE or a custom ENTITY - the two building blocks
// both attack classes need. This is necessary, not merely defense in depth: verified against
// this exact `fast-xml-parser` version, it DOES resolve a DTD-declared custom entity
// (`<!DOCTYPE a [<!ENTITY x "hello">]><a>&x;</a>` parses to `{ a: "hello" }`) when entity
// processing is enabled, so nothing about the parser's own configuration protects against
// XXE/billion-laughs on its own - `assertSafeXml` running first is what does. A legitimate
// camt.053/ZUGFeRD export never has a DOCTYPE, so this has no false-positive cost for this
// application's real inputs.
//
// `createSafeXmlParser` enables `processEntities` (fast-xml-parser's default) so the five
// predefined XML entities (`&amp; &lt; &gt; &apos; &quot;`) still decode normally - the only
// entity references any DOCTYPE-free document (which is all `assertSafeXml` ever lets
// through) can legally contain.
import { XMLParser } from "fast-xml-parser";

export class UnsafeXmlError extends Error {
  override readonly name = "UnsafeXmlError";
}

// Matches `<!DOCTYPE` and `<!ENTITY` regardless of case or the whitespace that follows -
// both are illegal in any XML this application expects to receive (ISO 20022 messages and
// ZUGFeRD/Factur-X invoices never declare either).
const DOCTYPE_PATTERN = /<!DOCTYPE\b/i;
const ENTITY_DECLARATION_PATTERN = /<!ENTITY\b/i;

/**
 * Throws `UnsafeXmlError` when `xmlText` declares a DOCTYPE or a custom entity. Call this
 * before any other processing of untrusted XML - `detectCamt053`/`parseCamt053` both call it
 * first, so a malicious upload is rejected before a single byte of it reaches a parser.
 */
export function assertSafeXml(xmlText: string): void {
  if (DOCTYPE_PATTERN.test(xmlText)) {
    throw new UnsafeXmlError("XML document declares a DOCTYPE, which is never processed (XXE protection)");
  }
  if (ENTITY_DECLARATION_PATTERN.test(xmlText)) {
    throw new UnsafeXmlError("XML document declares a custom ENTITY, which is never processed (entity-expansion protection)");
  }
}

/**
 * A `fast-xml-parser` instance configured for this module's needs: attributes are kept
 * (`Ccy` on `<Amt>`, name-tree keys in a ZUGFeRD PDF's `/EmbeddedFiles`), tag values are left
 * as strings (amount parsing needs the original decimal text, never a float). Only ever
 * called after `assertSafeXml` (directly, or via `parseXmlSafely` below) - see this file's
 * own header comment for why that ordering, not a parser option, is what actually matters.
 */
export function createSafeXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
  });
}

/** `assertSafeXml` followed by a parse with `createSafeXmlParser()` - the one call site every
 * XML entry point in this module should use rather than composing the two itself. */
export function parseXmlSafely(xmlText: string): unknown {
  assertSafeXml(xmlText);
  return createSafeXmlParser().parse(xmlText);
}
