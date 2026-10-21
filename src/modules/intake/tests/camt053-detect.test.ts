import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { detectCamt053 } from "../core/camt053-detect";
import { UnsafeXmlError } from "../core/xml-safety";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("detectCamt053", () => {
  it("recognizes the valid camt.053.001.02 fixture and reports its version", () => {
    const xml = readFixture("camt053-valid.xml");
    expect(detectCamt053(xml)).toEqual({ version: "02" });
  });

  it("returns null for XML with an unrelated namespace", () => {
    const xml = '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"/>';
    expect(detectCamt053(xml)).toBeNull();
  });

  it("returns null for XML with no namespace at all", () => {
    expect(detectCamt053("<Root><Child/></Root>")).toBeNull();
  });

  it("recognizes every supported version 02 through 08", () => {
    for (const version of ["02", "03", "04", "05", "06", "07", "08"]) {
      const xml = `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.${version}"/>`;
      expect(detectCamt053(xml)).toEqual({ version });
    }
  });

  it("throws UnsafeXmlError for the XXE fixture instead of returning null", () => {
    const xml = readFixture("malicious-xxe.xml");
    expect(() => detectCamt053(xml)).toThrow(UnsafeXmlError);
  });

  it("throws UnsafeXmlError for the billion-laughs fixture instead of returning null", () => {
    const xml = readFixture("malicious-billion-laughs.xml");
    expect(() => detectCamt053(xml)).toThrow(UnsafeXmlError);
  });
});
