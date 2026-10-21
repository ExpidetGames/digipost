// Shared "v2" idempotency-key algorithm for imported bank transactions, used by both
// `camt053-parser.ts` (ISO 20022 camt.053) and `mapping-validator.ts` (a confirmed tabular
// mapping). This exists because of a confirmed data-loss bug in the original ("v1", never
// named as such in code until this fix) key formula: it picked "the most specific reference"
// via `endToEndId ?? accountServicerReference ?? entryReference ?? remittanceInformation ??
// ""`. ISO 20022 / German banks routinely emit the literal placeholder `NOTPROVIDED` as
// `EndToEndId` when the underlying SEPA payment carried none - since `??` only falls through
// on `null`/`undefined`, that placeholder STRING won, and every transaction on the same
// account/day/amount with no real EndToEndId collapsed onto the same key, so
// `ON CONFLICT (account_id, idempotency_key) DO NOTHING` (decisions/0024) silently dropped
// the second, third, ... one. Two ordinary same-day, same-amount direct debits or transfers
// (not even actual duplicates) were enough to lose data.
//
// v2's fix has two independent parts, both required:
// 1. `normalizeReference` maps every known "no reference" placeholder (plus a genuinely empty
//    or whitespace-only value) to `null`, case-insensitively, BEFORE it is ever compared or
//    hashed - so a placeholder can never masquerade as "the" reference again.
// 2. The key hashes a composite of EVERY available discriminator (see the two call sites'
//    own field-order comments), never "the first non-empty one" - two transactions need to
//    differ in only ONE discriminator (say `accountServicerReference`) to get different keys,
//    even when every other field (including a shared `NOTPROVIDED` `EndToEndId`) is identical.
//
// Even the full composite can still collide for two entries that are genuinely
// indistinguishable by every field this application reads (see each fixture's own comment for
// a real example: an unbroken batch of identical bank fees). `OccurrenceCounter` disambiguates
// that remaining case with an occurrence index, so both rows still survive the import rather
// than one silently vanishing - see this module's README, "Idempotency key", "Known limits"
// for the accepted trade-off this introduces (overlapping partial re-exports of the same
// period may number a repeated entry differently across two separate imports).
//
// `ALGORITHM_VERSION` is folded into the hashed input itself (not just a comment) specifically
// so a future v3 change is guaranteed to produce a disjoint key space from v1 and v2 without
// needing any explicit migration step - see the README's "Known limits" for why this
// particular v1 -> v2 transition needs no migration of already-imported data (there is none).
import { createHash } from "node:crypto";

const ALGORITHM_VERSION = "v2";

/** Placeholder values ISO 20022 / German banks routinely emit in a reference field to mean
 * "no reference provided" - never a real reference, so never allowed to stand in for one (or
 * to collide with every other transaction that also has none). Matched case-insensitively
 * after trimming and whitespace-collapsing. */
const PLACEHOLDER_REFERENCES = new Set(["NOTPROVIDED", "NOT PROVIDED", "NONREF", "NOREF"]);

/**
 * Normalizes a reference-like field (`EndToEndId`, `AcctSvcrRef`, `NtryRef`, a mapped
 * reference/remittance column, ...) before it is used in an idempotency-key composite:
 * collapses internal whitespace, trims, and maps a known placeholder or an empty/
 * whitespace-only value to `null` ("no reference"). Two references that differ only in
 * whitespace or letter case (` NOTPROVIDED`, `notprovided `, `NotProvided`) always normalize
 * identically, so neither can accidentally produce a different idempotency key than the
 * other, and neither can accidentally differ from a genuinely absent (`null`) reference.
 */
export function normalizeReference(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (PLACEHOLDER_REFERENCES.has(collapsed.toUpperCase())) return null;
  return collapsed;
}

/** Every composite field, in the caller's own documented order. `null` is mapped to an
 * explicit empty slot (never dropped) so the field count/order is always stable and two
 * composites that differ only by one field shifting position can never accidentally collide.
 * `` (ASCII "unit separator") is used as the join delimiter since it cannot appear in
 * any of these fields' normal text content, unlike "|" or ";" which both do (remittance text,
 * a bank transaction code). */
function joinComposite(fields: readonly (string | number | null)[]): string {
  return fields.map((field) => (field === null ? "" : String(field))).join("");
}

/**
 * Hashes a composite of transaction discriminators into a stable v2 idempotency key. Never
 * called with "the most specific reference" alone - always the full field list the caller's
 * own header comment documents. `occurrenceIndex` (from `OccurrenceCounter`, 0 for the first
 * occurrence of an otherwise-identical composite within one file/import, 1/2/... for the
 * next) disambiguates transactions that are genuinely indistinguishable by every other field,
 * so they still get distinct keys and both survive the idempotent import.
 */
export function computeIdempotencyKeyV2(fields: readonly (string | number | null)[], occurrenceIndex: number): string {
  const composite = joinComposite(fields);
  const input = occurrenceIndex > 0 ? `${ALGORITHM_VERSION}${composite}occurrence:${occurrenceIndex}` : `${ALGORITHM_VERSION}${composite}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Tracks how many times an identical composite (pre-hash, pre-occurrence-index) has already
 * been seen within a single file/import, so the caller can pass the right `occurrenceIndex`
 * to `computeIdempotencyKeyV2` for each transaction in encounter order. Create exactly one
 * instance per parse/validate call and never share it across files: occurrence numbering is
 * only meaningful, and only deterministic, within the boundary of one file (see the README's
 * "Known limits" - overlapping partial exports of the same period may number a repeated entry
 * differently across two separate imports, an accepted trade-off versus the original silent
 * data loss).
 */
export class OccurrenceCounter {
  private readonly seen = new Map<string, number>();

  next(fields: readonly (string | number | null)[]): number {
    const key = joinComposite(fields);
    const occurrenceIndex = this.seen.get(key) ?? 0;
    this.seen.set(key, occurrenceIndex + 1);
    return occurrenceIndex;
  }
}
