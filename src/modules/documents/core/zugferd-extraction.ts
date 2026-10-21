// Best-effort field extraction from an embedded ZUGFeRD/Factur-X/XRechnung invoice XML
// (decisions/0020-universal-intake.md's other self-identifying format,
// decisions/0022-intake-wiring.md: "the ZUGFeRD attachment is read first via F1a and, when
// present, provides invoice fields and parties with priority over the model"). This is a
// deliberately narrow reader of the CII (Cross Industry Invoice) structure ZUGFeRD/Factur-X
// both use - it extracts the handful of fields this application's own `InvoiceFields`/
// `ExtractedParty` shapes need, not a general-purpose CII parser. Pure, no I/O: `assertSafeXml`
// (`@/modules/intake`) still gates every parse, so a malicious embedded XML is rejected the
// same way a malicious standalone upload is.
import { parseXmlSafely, UnsafeXmlError } from "@/modules/intake";

export type ZugferdExtraction = {
  invoiceNumber: string | null;
  /** Parsed from `GrandTotalAmount`'s own decimal text - CII amounts always use "." as the
   * decimal separator (the ISO 20022/UN-CEFACT convention), never the German-CSV format
   * `@/modules/intake`'s `detectAmountFormat` has to guess at. */
  totalAmountCents: number | null;
  currency: string | null;
  dueDate: string | null;
  paymentIban: string | null;
  sellerName: string | null;
  buyerName: string | null;
};

type XmlObject = Record<string, unknown>;

function isXmlObject(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null;
}

function textOf(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return node.trim().length > 0 ? node.trim() : null;
  if (typeof node === "number") return String(node);
  if (isXmlObject(node) && "#text" in node) {
    const text = node["#text"];
    return text === undefined || text === null ? null : String(text).trim() || null;
  }
  return null;
}

function childOf(node: unknown, path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (!isXmlObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function childText(node: unknown, path: string[]): string | null {
  return textOf(childOf(node, path));
}

/** `12.34` (already "."-decimal, per CII convention) -> `1234`; tolerant of a missing
 * fractional part or a thousands-free integer amount. `null` for anything that does not look
 * like a plain decimal number. */
function decimalTextToCents(text: string): number | null {
  const match = /^-?\d+(\.\d{1,2})?$/.exec(text.trim());
  if (!match) return null;
  const [wholePart = "0", fractionPart = ""] = text.trim().replace("-", "").split(".");
  const magnitude = Number(wholePart) * 100 + Number(`${fractionPart}00`.slice(0, 2));
  return text.trim().startsWith("-") ? -magnitude : magnitude;
}

/** `YYYYMMDD` (CII's `udt:DateTimeString` default `format="102"`) or an already-ISO
 * `YYYY-MM-DD` -> ISO `YYYY-MM-DD`; `null` for anything else. */
function toIsoDate(text: string): string | null {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{8}$/.test(trimmed)) return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  return null;
}

/** Tries every root element name a ZUGFeRD/Factur-X/XRechnung profile's CII document might
 * use, with or without the conventional `rsm:` namespace prefix (`createSafeXmlParser` never
 * strips namespace prefixes, so both forms are real possibilities in practice). */
function findRoot(parsed: XmlObject): XmlObject | null {
  const candidates = ["rsm:CrossIndustryInvoice", "CrossIndustryInvoice", "rsm:CrossIndustryDocument"];
  for (const key of candidates) {
    const value = parsed[key];
    if (isXmlObject(value)) return value;
  }
  return null;
}

/** Reads `ram:`-or-unprefixed children, trying the prefixed name first (the common case for a
 * real ZUGFeRD export) and falling back to the unprefixed name. */
function ramChild(node: unknown, name: string): unknown {
  if (!isXmlObject(node)) return undefined;
  return node[`ram:${name}`] ?? node[name];
}

function ramText(node: unknown, path: string[]): string | null {
  let current: unknown = node;
  for (const segment of path) current = ramChild(current, segment);
  return textOf(current);
}

/**
 * Extracts invoice fields from an embedded ZUGFeRD/Factur-X/XRechnung CII invoice XML.
 * Returns `null` when the XML is not a recognizable CII invoice at all, or when it carries
 * none of the fields this function knows how to read - callers then fall back entirely to the
 * model's own extraction. Never throws for a merely-odd document; a document declaring a
 * DOCTYPE/entity still throws `UnsafeXmlError` via `parseXmlSafely` (the same XXE/entity-
 * expansion protection every other XML entry point in this application uses).
 */
export function extractZugferdInvoiceFields(xmlText: string): ZugferdExtraction | null {
  let parsed: unknown;
  try {
    parsed = parseXmlSafely(xmlText);
  } catch (err) {
    // `UnsafeXmlError` (a DOCTYPE/custom entity) is never swallowed - a malicious embedded
    // attachment must fail loudly, the same "reject outright, never silently fall through"
    // rule every other XML entry point in this application follows. Any other parse failure
    // (a malformed-but-not-malicious embedded XML) degrades to "nothing extracted" instead,
    // rather than letting an attachment-parsing bug fail the whole document's processing.
    if (err instanceof UnsafeXmlError) throw err;
    return null;
  }
  if (!isXmlObject(parsed)) return null;

  const root = findRoot(parsed);
  if (!root) return null;

  const exchangedDocument = root["rsm:ExchangedDocument"] ?? root["ExchangedDocument"];
  const invoiceNumber = ramText(exchangedDocument, ["ID"]);

  const transaction = root["rsm:SupplyChainTradeTransaction"] ?? root["SupplyChainTradeTransaction"];
  const agreement = ramChild(transaction, "ApplicableHeaderTradeAgreement");
  const settlement = ramChild(transaction, "ApplicableHeaderTradeSettlement");

  const sellerName = ramText(agreement, ["SellerTradeParty", "Name"]);
  const buyerName = ramText(agreement, ["BuyerTradeParty", "Name"]);

  const currency = ramText(settlement, ["InvoiceCurrencyCode"]);
  const paymentIban = ramText(settlement, ["SpecifiedTradeSettlementPaymentMeans", "PayeePartyCreditorFinancialAccount", "IBANID"]);

  const paymentTerms = ramChild(settlement, "SpecifiedTradePaymentTerms");
  const dueDateRaw = ramText(paymentTerms, ["DueDateDateTime", "DateTimeString"]) ?? childText(paymentTerms, ["ram:DueDateDateTime", "udt:DateTimeString"]);
  const dueDate = dueDateRaw ? toIsoDate(dueDateRaw) : null;

  const monetarySummation = ramChild(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const grandTotalRaw = ramText(monetarySummation, ["GrandTotalAmount"]);
  const totalAmountCents = grandTotalRaw ? decimalTextToCents(grandTotalRaw) : null;

  const hasAnyField = Boolean(invoiceNumber || totalAmountCents !== null || sellerName || buyerName);
  if (!hasAnyField) return null;

  return { invoiceNumber, totalAmountCents, currency, dueDate, paymentIban, sellerName, buyerName };
}
