import { describe, expect, it } from "vitest";

import { assertSafeXml, createSafeXmlParser, parseXmlSafely, UnsafeXmlError } from "../core/xml-safety";

describe("assertSafeXml", () => {
  it("allows ordinary XML with no DOCTYPE/ENTITY", () => {
    expect(() => assertSafeXml('<?xml version="1.0"?><Document><Child>text</Child></Document>')).not.toThrow();
  });

  it("rejects a document declaring a DOCTYPE", () => {
    expect(() => assertSafeXml('<?xml version="1.0"?><!DOCTYPE Document><Document/>')).toThrow(UnsafeXmlError);
  });

  it("rejects a document declaring a custom ENTITY", () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE Document [<!ENTITY foo "bar">]><Document>&foo;</Document>';
    expect(() => assertSafeXml(xml)).toThrow(UnsafeXmlError);
  });

  it("is case-insensitive for DOCTYPE/ENTITY", () => {
    expect(() => assertSafeXml("<!doctype Document><Document/>")).toThrow(UnsafeXmlError);
  });
});

describe("parseXmlSafely", () => {
  it("parses ordinary XML into an object tree", () => {
    const result = parseXmlSafely("<Root><Child>value</Child></Root>") as Record<string, unknown>;
    expect(result).toHaveProperty("Root");
  });

  it("throws before parsing a document with a DOCTYPE, never handing it to the parser", () => {
    expect(() => parseXmlSafely('<!DOCTYPE Root [<!ENTITY x "y">]><Root>&x;</Root>')).toThrow(UnsafeXmlError);
  });
});

describe("createSafeXmlParser", () => {
  it("keeps attributes and leaves tag values as strings", () => {
    const parser = createSafeXmlParser();
    const parsed = parser.parse('<Amt Ccy="EUR">100.50</Amt>') as Record<string, unknown>;
    const amt = parsed.Amt as Record<string, unknown>;
    expect(amt["@_Ccy"]).toBe("EUR");
    expect(amt["#text"]).toBe("100.50");
  });
});
