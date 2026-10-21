// Parses a SWIFT MT940 (Customer Statement Message) bank statement into this application's
// own normalized shape (decisions/0020-universal-intake.md, decisions/0028-mt940-support.md).
// Deterministic, no AI involved anywhere in this file - MT940 is a self-identifying format
// exactly like camt.053 (`file-kind.ts`'s structural sniff: `:20:` plus at least one `:61:` at
// a line start), so asking a model to interpret it would only add error.
//
// `Mt940Statement` is a plain alias of `Camt053Statement` - both intake branches produce the
// exact same shape (`NormalizedTransaction`, an opening/closing `Camt053Balance`, an
// account-level IBAN or `null`), so every downstream consumer (`@/modules/accounts`'s
// `mapCamt053StatementsToImportable`, the accounts import service, the idempotency-key
// composite) works on an MT940 statement completely unchanged - no MT940-specific mapping
// code exists anywhere outside this file.
//
// Format reference: "MT940-Format der deutschen Kreditwirtschaft" (the German banking
// industry's own MT940 profile - every bank fixture/known Musterbank export this parser targets
// follows it, in particular the `?nn` structured `:86:` subfields and the SEPA `EREF+`/`KREF+`/
// `MREF+`/`CRED+`/`SVWZ+`/`ABWA+` tags embedded in them) plus the general SWIFT FIN field 61/86
// grammar. See `decisions/0028-mt940-support.md` for the full field-mapping table and every
// judgment call this file makes.
import { parseAmountToCents, PLAIN_COMMA_AMOUNT_FORMAT } from "./amount-parsing";
import type { Camt053Balance, Camt053Statement, CreditDebitIndicator, NormalizedTransaction } from "./camt053-parser";
import { camt053StatementReconciles } from "./camt053-parser";
import { computeIdempotencyKeyV2, normalizeReference, OccurrenceCounter } from "./idempotency-key";

/** MT940 has no formal IANA media type. This application picks one vendor-tree identifier and
 * uses it consistently everywhere a document's stored MIME type needs to distinguish an MT940
 * upload from camt.053 XML/CSV/TSV (`@/modules/documents`'s upload route, `processDocument`'s
 * branching, `@/modules/accounts`'s re-parse on import). */
export const MT940_MIME_TYPE = "application/vnd.mt940";

/** A parsed MT940 statement has exactly camt.053's own shape - see this file's header comment
 * for why no separate mapping code exists anywhere downstream. `statementId` is taken from
 * `:28C:` (Statement Number/Sheet Number, e.g. "00001/001"), falling back to `:20:`
 * (Transaction Reference Number) when `:28C:` is missing. */
export type Mt940Statement = Camt053Statement;

export type Mt940ParseResult = { statements: Mt940Statement[] };

export const MT940_ERROR = {
  /** `parseMt940` called on text that does not contain `:20:` and `:61:` at a line start -
   * callers are expected to have already sniffed this via `sniffFileKind`/`looksLikeMt940`. */
  notMt940: "not_mt940",
  /** Hard limits (in the spirit of `embedded-xml.ts`'s bounded PDF-attachment walk, R1
   * review): reject absurd input early with a stable code rather than looping unbounded on a
   * pathological file. */
  tooManyLines: "mt940_too_many_lines",
  tooManyStatements: "mt940_too_many_statements",
  tooManyTransactions: "mt940_too_many_transactions",
} as const;
export type Mt940ErrorCode = (typeof MT940_ERROR)[keyof typeof MT940_ERROR];

/** Every failure this module can produce is one of these - never an unclassified/raw
 * exception (a malformed individual `:61:` line is skipped instead, see `parseStatementGroup`
 * below; only a structural problem spanning the whole file throws). */
export class Mt940ParseError extends Error {
  override readonly name = "Mt940ParseError";
  constructor(
    readonly code: Mt940ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_LINES = 200_000;
const MAX_STATEMENTS = 1_000;
const MAX_TRANSACTIONS = 50_000;

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Strips the SWIFT block-header/trailer envelope some banks wrap their MT940 export in
 * (`{1:...}{2:...}{3:...}{4:` ... `-}`/`{5:...}`) - a raw per-line dump with no envelope at all
 * (just the `:20:`.../`-` fields, the shape every fixture and the product owner's own Musterbank
 * export use) passes through unchanged. Deliberately duplicated, in miniature, from
 * `file-kind.ts`'s own `looksLikeMt940` detection rather than shared - this codebase's own
 * precedent for a one-off structural regex (`camt053-detect.ts`/`camt053-parser.ts` each keep
 * their own copy of the camt.053 namespace pattern rather than importing one from the other). */
function stripSwiftEnvelope(text: string): string {
  return normalizeLineEndings(text)
    .replace(/\{[1235]:[^{}]*\}/g, "")
    .replace(/\{4:/g, "");
}

type RawField = { tag: string; lines: string[] };

const TAG_LINE_PATTERN = /^:([0-9]{2}[A-Z]?):(.*)$/;

/**
 * Tokenizes the (already envelope-stripped) text into one `RawField` per SWIFT tag
 * (`:20:`, `:25:`, `:28C:`, `:60F:`, `:61:`, `:86:`, `:62F:`, `:64:`, `:65:`, ...) plus every
 * continuation line that follows it - a line NOT starting a new tag and not the lone `-`
 * block-4 terminator some raw dumps use. `:86:`'s own "wraps at 65 characters" convention is
 * exactly this same mechanism; a `:61:` continuation is instead the field's own, structurally
 * distinct "supplementary details" subfield (`parseStatementGroup` peels it off separately).
 */
function tokenizeFields(strippedText: string): RawField[] {
  const lines = strippedText.split("\n");
  if (lines.length > MAX_LINES) {
    throw new Mt940ParseError(MT940_ERROR.tooManyLines, `MT940 file has too many lines (${lines.length}, limit ${MAX_LINES}).`);
  }

  const fields: RawField[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line === "-") continue;
    const match = TAG_LINE_PATTERN.exec(line);
    if (match) {
      fields.push({ tag: match[1]!, lines: [match[2] ?? ""] });
    } else if (fields.length > 0) {
      // A continuation line before any tag has ever been seen is meaningless noise (a stray
      // banner some export tools prepend) - silently dropped rather than throwing.
      fields.at(-1)!.lines.push(line);
    }
  }
  return fields;
}

/** Groups tokenized fields into statements: `:20:` (Transaction Reference Number) is
 * mandatory and starts every new statement/message - a file may concatenate several MT940
 * messages back to back ("multiple statements per file", decisions/0028-mt940-support.md).
 * Fields before the first `:20:` are dropped (should never happen once `looksLikeMt940` has
 * already gated entry into this parser). */
function groupIntoStatements(fields: RawField[]): RawField[][] {
  const groups: RawField[][] = [];
  for (const field of fields) {
    if (field.tag === "20") groups.push([]);
    if (groups.length === 0) continue;
    groups.at(-1)!.push(field);
  }
  return groups;
}

/** Joins every physical line collected for one field with NO separator - the un-wrapping
 * `:86:` needs (banks wrap at 65 characters mid-word/mid-subfield) and a harmless no-op for
 * any other single-line field. */
function joinContinuation(lines: readonly string[]): string {
  return lines.join("");
}

const IBAN_LIKE_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

/** Shape check only (mirrors `tabular-sample.ts`'s own `IBAN_PATTERN` - never a mod-97
 * checksum, that lives in `@/modules/contacts`'s `isValidIbanFormat` and this module has no
 * dependency on that owner). `:25:`/`:31:` frequently carry a German bank-code/account-number
 * pair instead of an IBAN (e.g. "10020030/1234567") - deliberately dropped when it does not
 * look like an IBAN, matching camt.053's own precedent of only ever populating an IBAN field
 * from a genuine `<IBAN>` tag (never `<Othr>`, decisions/0028-mt940-support.md's "Known
 * limits"). */
function asIbanOrNull(raw: string | null): string | null {
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  return IBAN_LIKE_PATTERN.test(compact) ? compact : null;
}

function yyToFullYear(yy: number): number {
  // Bank statements this application processes are never plausibly dated before 2000 nor
  // after 2079 - the same pivot convention widely used for other 2-digit-year banking formats.
  return yy <= 79 ? 2000 + yy : 1900 + yy;
}

function yymmddToIso(digits: string): string {
  const yy = Number(digits.slice(0, 2));
  const mm = digits.slice(2, 4);
  const dd = digits.slice(4, 6);
  return `${yyToFullYear(yy)}-${mm}-${dd}`;
}

/**
 * Resolves `:61:`'s optional 4-digit booking date (`MMDD`, no year of its own) against the
 * value date's year, with a year-end rollover guard: a booking date whose month is far from
 * the value date's own month (more than 6 months away) is assumed to actually fall in the
 * adjacent calendar year (a value date of 2026-12-31 with a booking `MMDD` of "0102" means
 * 2027-01-02, not 2026-01-02) rather than the naive "same year as the value date" guess.
 */
function resolveBookingDate(valueDateIso: string, mmdd: string): string {
  const valueYear = Number(valueDateIso.slice(0, 4));
  const valueMonth = Number(valueDateIso.slice(5, 7));
  const bookingMonth = Number(mmdd.slice(0, 2));
  const bookingDay = mmdd.slice(2, 4);
  let bookingYear = valueYear;
  const diff = bookingMonth - valueMonth;
  if (diff > 6) bookingYear -= 1;
  else if (diff < -6) bookingYear += 1;
  return `${bookingYear}-${mmdd.slice(0, 2)}-${bookingDay}`;
}

const BALANCE_PATTERN = /^(C|D)(\d{6})([A-Z]{3})([\d,]+)$/;

/** `:60F:`/`:60M:` (opening) and `:62F:`/`:62M:` (closing), plus the optional `:64:`
 * (closing available)/`:65:` (forward available): `1!a6!n3!a15d` - a `C`/`D` mark, `YYMMDD`,
 * a 3-letter currency, and a comma-decimal amount. `type` is kept as the raw MT940 tag
 * (`"60F"`, `"62M"`, ...) rather than forced into camt.053's own `OPBD`/`CLBD` vocabulary -
 * the two aren't a semantic match (MT940's F/M distinguish Final/Intermediate, not
 * booked/available) and nothing downstream reads `Camt053Balance.type` for an MT940
 * statement. */
function parseBalanceField(tag: string, rawValue: string): Camt053Balance | null {
  const match = BALANCE_PATTERN.exec(rawValue.trim());
  if (!match) return null;
  const [, mark, dateDigits, currency, amountText] = match;
  const magnitude = Math.abs(parseAmountToCents(amountText!, PLAIN_COMMA_AMOUNT_FORMAT) ?? 0);
  return { type: tag, date: yymmddToIso(dateDigits!), amountCents: mark === "D" ? -magnitude : magnitude, currency: currency! };
}

type Mt940StatementLine = {
  valueDate: string;
  bookingDate: string | null;
  creditDebit: CreditDebitIndicator;
  amountCents: number;
  /** The `N`-plus-3-characters transaction type identification code (`NTRF`, `NDDT`,
   * `NMSC`, ...), or `null` when the line does not carry one at all (a genuinely malformed
   * line this parser still salvaged the amount/date/mark from). */
  transactionType: string | null;
  /** "Reference for the Account Owner" (16x) - `NONREF` is a placeholder some banks emit
   * verbatim when there is none, kept raw here (never normalized away at this point - see
   * `normalizeReference`, called only when building the idempotency-key composite, exactly
   * like camt.053's own `entryReference`). */
  customerReference: string | null;
  /** "//Reference of the Account Servicing Institution" (16x), when present. */
  bankReference: string | null;
};

const MARK_PATTERN = /^(RC|RD|C|D)/;
const FUNDS_CODE_PATTERN = /^([A-Z])(?=[\d,])/;
const AMOUNT_PATTERN = /^(\d+(?:,\d{0,2})?)/;
const TRANSACTION_TYPE_PATTERN = /^([A-Z][A-Z0-9]{3})/;

/**
 * Parses a `:61:` statement line's own fixed-format fields (never its optional continuation
 * line - that is `parseStatementGroup`'s own "supplementary details" concern):
 * `6!n[4!n]2a[1!a]15d1!a3!c16x[//16x]` (value date, optional booking date, debit/credit mark,
 * optional funds code, amount, transaction type, customer reference, optional bank
 * reference). Returns `null` for a line this parser cannot make sense of at all (no leading
 * 6-digit value date, or no recognizable `C`/`D`/`RC`/`RD` mark) - the caller skips that one
 * transaction rather than aborting the whole statement or throwing (this module's "never
 * throw an unclassified error" rule).
 */
function parseStatementLineFields(rawValue: string): Mt940StatementLine | null {
  let rest = rawValue.trim();

  const valueDateMatch = /^(\d{6})/.exec(rest);
  if (!valueDateMatch) return null;
  const valueDate = yymmddToIso(valueDateMatch[1]!);
  rest = rest.slice(6);

  let bookingDate: string | null = null;
  const bookingCandidate = /^(\d{4})/.exec(rest);
  // Only consumed as a booking date when a valid D/C mark still follows right after -
  // otherwise this would misread the first 4 digits of a (malformed) amount as a date.
  if (bookingCandidate && MARK_PATTERN.test(rest.slice(4))) {
    bookingDate = resolveBookingDate(valueDate, bookingCandidate[1]!);
    rest = rest.slice(4);
  }

  const markMatch = MARK_PATTERN.exec(rest);
  if (!markMatch) return null;
  const markRaw = markMatch[1]!;
  rest = rest.slice(markRaw.length);
  const isReversal = markRaw.startsWith("R");
  const baseMark = markRaw.slice(-1);

  // Optional funds code: a single letter immediately before the amount's leading digit.
  if (FUNDS_CODE_PATTERN.test(rest)) rest = rest.slice(1);

  const amountMatch = AMOUNT_PATTERN.exec(rest);
  if (!amountMatch) return null;
  const magnitude = Math.abs(parseAmountToCents(amountMatch[1]!, PLAIN_COMMA_AMOUNT_FORMAT) ?? 0);
  rest = rest.slice(amountMatch[1]!.length);

  const typeMatch = TRANSACTION_TYPE_PATTERN.exec(rest);
  const transactionType = typeMatch ? typeMatch[1]! : null;
  if (typeMatch) rest = rest.slice(4);

  const [customerReferenceRaw, bankReferenceRaw] = rest.split("//");
  const customerReference = customerReferenceRaw && customerReferenceRaw.length > 0 ? customerReferenceRaw : null;
  const bankReference = bankReferenceRaw && bankReferenceRaw.length > 0 ? bankReferenceRaw : null;

  const baseCreditDebit: CreditDebitIndicator = baseMark === "C" ? "credit" : "debit";
  const flippedCreditDebit: CreditDebitIndicator = baseCreditDebit === "credit" ? "debit" : "credit";
  // A reversal flips the effective sign: "RC" (reversal of a credit) behaves like an actual
  // debit, "RD" (reversal of a debit) like an actual credit.
  const creditDebit: CreditDebitIndicator = isReversal ? flippedCreditDebit : baseCreditDebit;
  const amountCents = creditDebit === "debit" ? -magnitude : magnitude;

  return { valueDate, bookingDate, creditDebit, amountCents, transactionType, customerReference, bankReference };
}

type Mt940RemittanceInfo = {
  bookingText: string | null;
  primanota: string | null;
  remittanceText: string | null;
  counterpartyBic: string | null;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  textKeyExtension: string | null;
  /** The German "Geschäftsvorfallcode" (business transaction code) some banks prepend before
   * the first `?nn` subfield (e.g. `:86:105?00SEPA...`) - folded into `bankTransactionCode`
   * alongside `:61:`'s own transaction type. */
  gvcCode: string | null;
};

const EMPTY_REMITTANCE_INFO: Mt940RemittanceInfo = {
  bookingText: null,
  primanota: null,
  remittanceText: null,
  counterpartyBic: null,
  counterpartyAccount: null,
  counterpartyName: null,
  textKeyExtension: null,
  gvcCode: null,
};

const SUBFIELD_PATTERN = /\?(\d{2})([\s\S]*?)(?=\?\d{2}|$)/g;

/**
 * Parses a `:86:` field's already-unwrapped content (`joinContinuation`'s output) into the
 * German structured `?nn` subfields (decisions/0028-mt940-support.md's field-mapping table):
 * `?00` booking text, `?10` Primanota, `?20`-`?29`/`?60`-`?63` remittance parts (concatenated
 * IN ORDER, no separator - that is what German banks intend: SEPA's own `EREF+`/`SVWZ+`/...
 * tags inside them are what actually separates one logical piece from the next), `?30`
 * counterparty BIC, `?31` counterparty account/IBAN, `?32`/`?33` counterparty name
 * (concatenated), `?34` text-key extension. A leading run of digits before the first `?nn`
 * (the GVC) is captured separately. When the content has no `?nn` subfield at all, it is
 * unstructured free text and is kept as `remittanceText` verbatim.
 */
function parseInformationToAccountOwner(rawValue: string): Mt940RemittanceInfo {
  if (!/\?\d{2}/.test(rawValue)) {
    const trimmed = rawValue.trim();
    return { ...EMPTY_REMITTANCE_INFO, remittanceText: trimmed.length > 0 ? trimmed : null };
  }

  const firstTagIndex = rawValue.indexOf("?");
  const gvcCandidate = firstTagIndex > 0 ? rawValue.slice(0, firstTagIndex).trim() : "";
  const gvcCode = gvcCandidate.length > 0 ? gvcCandidate : null;

  const subfields = new Map<string, string>();
  const remittanceParts: string[] = [];
  const nameParts: string[] = [];

  for (const match of rawValue.matchAll(SUBFIELD_PATTERN)) {
    const tag = match[1]!;
    const value = match[2]!.trim();
    const tagNum = Number(tag);
    if ((tagNum >= 20 && tagNum <= 29) || (tagNum >= 60 && tagNum <= 63)) {
      remittanceParts.push(value);
    } else if (tag === "32" || tag === "33") {
      nameParts.push(value);
    } else {
      subfields.set(tag, value);
    }
  }

  return {
    bookingText: subfields.get("00") ?? null,
    primanota: subfields.get("10") ?? null,
    remittanceText: remittanceParts.length > 0 ? remittanceParts.join("") : null,
    counterpartyBic: subfields.get("30") ?? null,
    counterpartyAccount: subfields.get("31") ?? null,
    counterpartyName: nameParts.length > 0 ? nameParts.join("") : null,
    textKeyExtension: subfields.get("34") ?? null,
    gvcCode,
  };
}

const SEPA_TAG_NAMES = ["EREF", "KREF", "MREF", "CRED", "SVWZ", "ABWA"] as const;
type SepaTagName = (typeof SEPA_TAG_NAMES)[number];
// Built from `SEPA_TAG_NAMES` (never a second, hand-duplicated alternation list) so the two
// can never silently drift apart.
const SEPA_TAG_ALTERNATION = SEPA_TAG_NAMES.join("|");
const SEPA_TAG_PATTERN = new RegExp(`(${SEPA_TAG_ALTERNATION})\\+([\\s\\S]*?)(?=(?:${SEPA_TAG_ALTERNATION})\\+|$)`, "g");

/** Extracts the standard German SEPA reference sub-tags a bank embeds inside the concatenated
 * `?20`-`?29`/`?60`-`?63` remittance text (decisions/0028-mt940-support.md): `EREF+` (end-to-end
 * id), `KREF+` (the payer/payee's own customer reference - parsed but not currently surfaced
 * as a dedicated `NormalizedTransaction` field, see the ADR's "Known limits"), `MREF+` (SEPA
 * mandate reference), `CRED+` (SEPA creditor id), `SVWZ+` (the actual free-text Verwendungszweck,
 * already part of `remittanceText` verbatim - extracted here only so a caller could isolate it
 * if ever needed), `ABWA+` (a different originator/payer name than the structured `?32`/`?33`
 * counterparty name - used as an override for a more accurate display name when present). */
function parseSepaTags(text: string | null): Partial<Record<SepaTagName, string>> {
  if (!text) return {};
  const result: Partial<Record<SepaTagName, string>> = {};
  for (const match of text.matchAll(SEPA_TAG_PATTERN)) {
    const tag = match[1]! as SepaTagName;
    const value = match[2]!.trim();
    if (value.length > 0) result[tag] = value;
  }
  return result;
}

/**
 * The v2 composite field order for an MT940 transaction (`idempotency-key.ts`'s
 * `computeIdempotencyKeyV2`) - deliberately the SAME field order/shape as camt.053's own
 * `camt053IdempotencyKeyFields` (`camt053-parser.ts`), so a bank that offers both camt.053 and
 * MT940 exports of the same underlying statement produces the same keys either way (both
 * formats describe the identical underlying transaction).
 */
function mt940IdempotencyKeyFields(tx: {
  accountIban: string | null;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  creditDebit: CreditDebitIndicator;
  endToEndId: string | null;
  accountServicerReference: string | null;
  entryReference: string | null;
  bankTransactionCode: string | null;
  mandateId: string | null;
  counterpartyIban: string | null;
  remittanceInformation: string | null;
}): (string | number | null)[] {
  return [
    tx.accountIban,
    tx.bookingDate,
    tx.valueDate,
    tx.amountCents,
    tx.currency,
    tx.creditDebit,
    normalizeReference(tx.endToEndId),
    normalizeReference(tx.accountServicerReference),
    normalizeReference(tx.entryReference),
    normalizeReference(tx.bankTransactionCode),
    normalizeReference(tx.mandateId),
    normalizeReference(tx.counterpartyIban),
    normalizeReference(tx.remittanceInformation),
  ];
}

function buildTransaction(input: {
  accountIban: string | null;
  currency: string;
  line: Mt940StatementLine;
  remittance: Mt940RemittanceInfo;
  occurrenceCounter: OccurrenceCounter;
}): NormalizedTransaction {
  const { accountIban, currency, line, remittance, occurrenceCounter } = input;

  const sepaTags = parseSepaTags(remittance.remittanceText);
  const endToEndId = sepaTags.EREF ?? null;
  const mandateId = sepaTags.MREF ?? null;
  const creditorId = sepaTags.CRED ?? null;
  // `ABWA+` ("abweichender Auftraggeber/Empfänger") names a party that differs from the
  // account holder the transaction is booked against - preferred over the structured
  // `?32`/`?33` name when present, since it is more specific about who this money actually
  // came from/went to; falls back to the structured name otherwise.
  const counterpartyName = sepaTags.ABWA ?? remittance.counterpartyName;
  const counterpartyIban = asIbanOrNull(remittance.counterpartyAccount);

  const bankTransactionCode =
    [line.transactionType, remittance.gvcCode, remittance.bookingText, remittance.textKeyExtension].filter(
      (part): part is string => Boolean(part),
    ).join("/") || null;

  // The German "Primanota" (`?10`) is the bank's own internal document number for this
  // booking - functionally the same role camt.053's `AcctSvcrRef` plays (a self-identifying
  // bank reference for the entry), so it takes priority; `:61:`'s own `//` bank reference is
  // the fallback for a bank that omits Primanota but still states one there.
  const accountServicerReference = remittance.primanota ?? line.bankReference ?? null;
  const entryReference = line.customerReference ?? null;
  const bookingDate = line.bookingDate ?? line.valueDate;

  const idempotencyKeyFields = mt940IdempotencyKeyFields({
    accountIban,
    bookingDate,
    valueDate: line.valueDate,
    amountCents: line.amountCents,
    currency,
    creditDebit: line.creditDebit,
    endToEndId,
    accountServicerReference,
    entryReference,
    bankTransactionCode,
    mandateId,
    counterpartyIban,
    remittanceInformation: remittance.remittanceText,
  });
  const idempotencyKey = computeIdempotencyKeyV2(idempotencyKeyFields, occurrenceCounter.next(idempotencyKeyFields));

  return {
    idempotencyKey,
    accountIban,
    currency,
    bookingDate,
    valueDate: line.valueDate,
    amountCents: line.amountCents,
    creditDebit: line.creditDebit,
    counterpartyName,
    counterpartyIban,
    counterpartyBic: remittance.counterpartyBic,
    remittanceInformation: remittance.remittanceText,
    endToEndId,
    mandateId,
    creditorId,
    bankTransactionCode,
    accountServicerReference,
    entryReference,
  };
}

function parseStatementGroup(fields: RawField[], occurrenceCounter: OccurrenceCounter): Mt940Statement {
  const referenceField = fields.find((f) => f.tag === "20");
  const statementIdField = fields.find((f) => f.tag === "28C");
  const rawStatementId = statementIdField ?? referenceField;
  const statementId = rawStatementId ? joinContinuation(rawStatementId.lines).trim() || null : null;

  const accountField = fields.find((f) => f.tag === "25");
  const accountIban = accountField ? asIbanOrNull(joinContinuation(accountField.lines).trim()) : null;

  const openingField = fields.find((f) => f.tag === "60F" || f.tag === "60M");
  const closingField = fields.find((f) => f.tag === "62F" || f.tag === "62M");
  const openingBalance = openingField ? parseBalanceField(openingField.tag, joinContinuation(openingField.lines)) : null;
  const closingBalance = closingField ? parseBalanceField(closingField.tag, joinContinuation(closingField.lines)) : null;
  const currency = openingBalance?.currency ?? closingBalance?.currency ?? "EUR";

  const transactions: NormalizedTransaction[] = [];
  fields.forEach((field, index) => {
    if (field.tag !== "61") return;

    const mainLine = field.lines[0] ?? "";
    // Any continuation line collected under this `:61:` (beyond the main line itself) is the
    // field's own, structurally distinct "supplementary details" subfield (up to 34x) - kept,
    // but appended to the transaction's remittance text rather than dropped, since there is no
    // other home for it in `NormalizedTransaction`'s shared shape.
    const supplementaryDetails = field.lines.slice(1).join(" ").trim() || null;

    const parsedLine = parseStatementLineFields(mainLine);
    if (!parsedLine) return; // Malformed `:61:` line: skip it, never throw for this alone.

    // SWIFT's own field order guarantees the `:86:` narrative for this entry, when present,
    // immediately follows its `:61:` - there is no other way to associate the two.
    const infoField = fields[index + 1]?.tag === "86" ? fields[index + 1] : undefined;
    const remittanceRaw = infoField ? joinContinuation(infoField.lines) : "";
    const remittance = parseInformationToAccountOwner(remittanceRaw);
    const remittanceText = [remittance.remittanceText, supplementaryDetails].filter((part): part is string => Boolean(part)).join("; ") || null;

    transactions.push(
      buildTransaction({
        accountIban,
        currency,
        line: parsedLine,
        remittance: { ...remittance, remittanceText },
        occurrenceCounter,
      }),
    );
  });

  return { statementId, accountIban, currency, openingBalance, closingBalance, transactions };
}

/**
 * Parses an MT940 document (already decoded text - `@/modules/intake`'s `decodeTextBytes`,
 * CP1252-aware) into normalized statements/transactions. Callers are expected to have already
 * sniffed this as MT940 (`sniffFileKind`); this still throws `Mt940ParseError` defensively when
 * the structural `:20:`/`:61:` signal is missing, or when the file exceeds this module's hard
 * limits - never an unclassified error for a structural problem spanning the whole file. An
 * individual malformed `:61:` line is instead skipped (see `parseStatementGroup`), so a
 * partially-corrupt file still yields whatever it legitimately can rather than failing outright.
 */
export function parseMt940(text: string): Mt940ParseResult {
  const stripped = stripSwiftEnvelope(text);
  if (!/^:20:/m.test(stripped) || !/^:61:/m.test(stripped)) {
    throw new Mt940ParseError(MT940_ERROR.notMt940, "Not a recognized MT940 document (missing :20:/:61: tags) - sniff the file kind first.");
  }

  const fields = tokenizeFields(stripped);
  const groups = groupIntoStatements(fields);
  if (groups.length > MAX_STATEMENTS) {
    throw new Mt940ParseError(MT940_ERROR.tooManyStatements, `MT940 file has too many statements (${groups.length}, limit ${MAX_STATEMENTS}).`);
  }

  const occurrenceCounter = new OccurrenceCounter();
  const statements = groups.map((group) => parseStatementGroup(group, occurrenceCounter));

  const totalTransactions = statements.reduce((sum, statement) => sum + statement.transactions.length, 0);
  if (totalTransactions > MAX_TRANSACTIONS) {
    throw new Mt940ParseError(
      MT940_ERROR.tooManyTransactions,
      `MT940 file has too many transactions (${totalTransactions}, limit ${MAX_TRANSACTIONS}).`,
    );
  }

  return { statements };
}

/** Pure reconciliation check, identical arithmetic to `camt053StatementReconciles` (opening
 * balance plus the sum of every transaction's signed amount equals the closing balance) -
 * `Mt940Statement` is a plain alias of `Camt053Statement`, so the same function would work
 * unmodified; this thin wrapper exists purely so callers/tests reach it under the name that
 * matches this file's own format, per decisions/0028-mt940-support.md. */
export function mt940StatementReconciles(statement: Mt940Statement): boolean {
  return camt053StatementReconciles(statement);
}
