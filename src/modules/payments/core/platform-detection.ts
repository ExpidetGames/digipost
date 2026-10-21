// Owner: src/modules/payments (F4, decisions/0026-platform-settlements.md). Pure heuristics
// wiring `MatchableTransaction.isPlatformPayout` (decisions/0023's own "Hooks for you": real
// detection instead of the hardcoded `false` F3b shipped with) and the fee-invoice detection
// this phase's product model needs ("an incoming invoice whose sender is the platform
// contact"). Deliberately name-based, not a persisted mapping: a workspace's platform contact
// is whichever contact's name mentions the platform - see this file's own "Scope cut" note in
// its header comment on `isPlatformContactName` for why a learned-alias table was not built
// for this instead.
import type { SettlementPlatform } from "@/modules/intake";

/** One or more lowercase substrings that, found anywhere in a counterparty/contact name,
 * identify that name as belonging to this platform - deliberately loose (a legal entity name
 * commonly reads "Stripe Payments Europe, Ltd." or "PayPal (Europe) S.à.r.l."), never an exact
 * match. `other` has none: a workspace using an unlisted platform gets no automatic
 * detection, the same "we cannot generalize a name we do not know" limit `@/modules/intake`'s
 * own closed `SETTLEMENT_PLATFORMS` list already accepts. */
const PLATFORM_NAME_KEYWORDS: Record<SettlementPlatform, string[]> = {
  stripe: ["stripe"],
  apple: ["apple"],
  google: ["google"],
  paypal: ["paypal"],
  amazon: ["amazon"],
  other: [],
};

/**
 * Whether `text` (a bank transaction's counterparty name or remittance text, or a contact's
 * name) names this specific `platform` - case-insensitive substring match against
 * `PLATFORM_NAME_KEYWORDS`. `null`/blank `text` is never a match.
 */
export function textNamesPlatform(text: string | null, platform: SettlementPlatform): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PLATFORM_NAME_KEYWORDS[platform].some((keyword) => lower.includes(keyword));
}

/**
 * Which platform (if any) `text` names - the first match in `SETTLEMENT_PLATFORMS`' own
 * declared order, `other` never matched (it has no keywords). Used both for
 * `looksLikePlatformPayout` (a bank transaction) and fee-invoice detection (a contact's name).
 */
export function detectPlatformFromText(text: string | null): SettlementPlatform | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const platform of Object.keys(PLATFORM_NAME_KEYWORDS) as SettlementPlatform[]) {
    if (platform === "other") continue;
    if (PLATFORM_NAME_KEYWORDS[platform].some((keyword) => lower.includes(keyword))) return platform;
  }
  return null;
}

/**
 * `MatchableTransaction.isPlatformPayout`'s real detection (decisions/0023's own "Hooks for
 * you" note, wired here): a BANK transaction (never a clearing-account one - those are
 * excluded from the matching pool entirely, `@/persistence/repositories/drizzle/accounts-repository.ts`'s
 * `listForMatching`) whose counterparty name or remittance text names a known settlement
 * platform is a platform's payout deposit, not a payment for one specific invoice - the
 * general three-stage engine (`matchByRules`/`findSubsetSums`/the AI arbiter) must never
 * propose matching it against an invoice directly (decisions/0023's own product decision,
 * `core/settlement.ts`'s header comment). Returns the detected platform (or `null`) rather
 * than a bare boolean so a caller can also use it for the "Umbuchung von <Plattform>" UI hint
 * when no settlement report has been imported for this payout yet (decisions/0026's own
 * "period has no report yet" scope note).
 */
export function looksLikePlatformPayout(tx: { counterpartyName: string | null; remittanceText: string | null }): SettlementPlatform | null {
  return detectPlatformFromText(tx.counterpartyName) ?? detectPlatformFromText(tx.remittanceText);
}

/**
 * Fee-invoice detection (decisions/0026's product model): an incoming invoice's resolved
 * primary contact is treated as "the platform" when its name mentions `platform` - a
 * deliberately simple, name-based heuristic rather than a persisted alias table. **Scope
 * cut**: the brief's own wording ("alias-learned") suggested reusing `@/modules/payments`'s
 * existing `payment_aliases` mechanism, but that table maps a counterparty NAME to a CONTACT
 * for ordinary bank-transaction matching - a fee invoice is never itself a bank transaction,
 * so there is no natural alias-learning event to hang a persisted platform-contact mapping
 * off for this phase. A future phase could add one (e.g. learned the first time a human
 * confirms a fee-invoice settlement for a contact this heuristic did not already recognize)
 * once real vendor names show the heuristic needs it.
 */
export function isPlatformContactName(contactName: string | null, platform: SettlementPlatform): boolean {
  return textNamesPlatform(contactName, platform);
}

export type FeeInvoiceReconciliation = {
  feeSumCents: number;
  invoiceTotalCents: number;
  discrepancyCents: number;
  matches: boolean;
};

const DEFAULT_FEE_TOLERANCE_PERCENT = 3;

/**
 * Whether a platform's fee invoice (an incoming invoice, `invoiceTotalCents` its own
 * `abs(totalAmountCents)`) matches the sum of that platform's fee settlement lines for the
 * invoice's own period (`feeSumCents`, always `>= 0` by construction - fee lines are stored as
 * a positive magnitude, `core/settlement.ts`'s `SettlementLine.feeCents` comment) within
 * `tolerancePercent` of the invoice total (default 3%, the same default this module already
 * uses for a Skonto discount, `DEFAULT_SKONTO_TOLERANCE_PERCENT`) - a currency-rounding or a
 * period-boundary difference of a few cents/percent should not block an otherwise-obvious
 * match. Two-sided (unlike `isWithinSkontoTolerance`'s one-sided "paid may be less, never
 * more"): a platform's own invoice can legitimately round its stated total either slightly
 * above or slightly below the sum of the period's individual fee lines.
 */
export function reconcileFeeInvoice(feeSumCents: number, invoiceTotalCents: number, tolerancePercent = DEFAULT_FEE_TOLERANCE_PERCENT): FeeInvoiceReconciliation {
  const discrepancyCents = feeSumCents - invoiceTotalCents;
  const toleranceCents = Math.abs(invoiceTotalCents) * (tolerancePercent / 100);
  return { feeSumCents, invoiceTotalCents, discrepancyCents, matches: Math.abs(discrepancyCents) <= toleranceCents };
}
