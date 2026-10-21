// Self-identifying-format detection for ISO 20022 camt.053 bank statements
// (decisions/0020-universal-intake.md's "the exception": a format that identifies itself
// unambiguously is recognized deterministically, never by asking a model). The namespace
// alone is the identifying signal, so this is a plain text match, not a full parse -
// `parseCamt053` (camt053-parser.ts) does the real structural work once this says yes.
import { assertSafeXml } from "./xml-safety";

/** `camt.053.001.02` through `.08` are the versions this application recognizes (the ISO
 * 20022 message definition has not changed shape in a way that matters to this parser across
 * that range; a version outside it is reported as `null` by `detectCamt053`, not guessed at). */
const CAMT_053_NAMESPACE_PATTERN = /urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.(0[2-8])/;

export type Camt053Detection = {
  version: string;
};

/**
 * Returns `{ version }` when `xmlText`'s root element declares the camt.053 namespace
 * (`urn:iso:std:iso:20022:tech:xsd:camt.053.001.0X`, versions 02-08), `null` when it does
 * not. Throws `UnsafeXmlError` (via `assertSafeXml`) for a document that declares a DOCTYPE
 * or a custom entity - detection must reject a malicious upload outright, never silently
 * fall through to "not camt.053" and let a later step parse it anyway.
 */
export function detectCamt053(xmlText: string): Camt053Detection | null {
  assertSafeXml(xmlText);
  const match = CAMT_053_NAMESPACE_PATTERN.exec(xmlText);
  if (!match) return null;
  return { version: match[1]! };
}
