// Owner: src/modules/accounts (F4, decisions/0026-platform-settlements.md). Exercises
// `buildSettlementLineDrafts` against F1a's real Stripe/Apple fixtures, routed through the
// SAME pipeline the real import uses: `sampleTabular` -> the fake `IntakeClassifier` (its own
// header-signature table already recognizes both fixtures, `@/modules/intake/core/fake-intake-classifier.ts`)
// -> `validateMapping` -> `buildSettlementLineDrafts`. This is deliberately an end-to-end
// exercise of the whole normalization chain, not a table of hand-built `NormalizedSettlementLine`
// objects, so a drift in any earlier step (the fake classifier's own mapping, `validateMapping`'s
// settlement-line branch) would break this test too.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseCsvSync } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import {
  createFakeIntakeClassifier,
  parseApplePaymentSummary,
  parseGooglePlayEarnings,
  sampleTabular,
  validateMapping,
  type DelimiterChar,
  type NormalizedSettlementLine,
} from "@/modules/intake";

import { buildSettlementLineDrafts } from "../core/settlement-lines";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../intake/tests/fixtures/${name}`, import.meta.url)), "utf8");
}

async function settlementLinesFor(fixtureName: string, delimiter: DelimiterChar): Promise<NormalizedSettlementLine[]> {
  const text = readFixture(fixtureName);
  const sample = sampleTabular(text, { delimiter });
  const records = parseCsvSync(text, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  const rows = records.slice(1);

  const classifier = createFakeIntakeClassifier();
  const classification = await classifier.classify({ kind: "tabular", sample });
  if (!classification.columnMapping) throw new Error(`fake classifier did not recognize ${fixtureName}`);

  const result = validateMapping(sample, rows, classification.columnMapping, classification.amountSign);
  if (!result.ok || result.kind !== "settlement_lines") throw new Error(`expected settlement_lines for ${fixtureName}, got ${JSON.stringify(result)}`);
  return result.lines;
}

describe("buildSettlementLineDrafts - Stripe payout report", () => {
  it("splits each charge row into a revenue line and a fee line, and each refund row into a refund line", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const drafts = buildSettlementLineDrafts(lines);

    const revenue = drafts.filter((d) => d.type === "revenue");
    const fee = drafts.filter((d) => d.type === "fee");
    const refund = drafts.filter((d) => d.type === "refund");
    const payout = drafts.filter((d) => d.type === "payout");

    // 5 rows: 4 charges (gross >= 0) + 1 refund (gross < 0).
    expect(revenue).toHaveLength(4);
    expect(refund).toHaveLength(1);
    // Every row has a non-zero fee except the refund row (fee 0.00 in the fixture).
    expect(fee).toHaveLength(4);
    // Two distinct `automatic_payout_id`s in the fixture.
    expect(payout).toHaveLength(2);
  });

  it("derives a positive credit for a revenue line and a negative debit for a fee/refund line", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const drafts = buildSettlementLineDrafts(lines);

    const firstRevenue = drafts.find((d) => d.type === "revenue" && d.chargeId === "ch_1AbCdEfGh001");
    expect(firstRevenue).toMatchObject({ transactionAmountCents: 9900, remittanceText: "RE-2026-1001" });

    const matchingFee = drafts.find((d) => d.type === "fee" && d.chargeId === "ch_1AbCdEfGh001");
    expect(matchingFee).toMatchObject({ transactionAmountCents: -317 });

    const refund = drafts.find((d) => d.type === "refund");
    expect(refund).toMatchObject({ transactionAmountCents: -4900 });
  });

  it("synthesizes one payout draft per distinct payoutId, summing that group's net amounts as a debit", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const drafts = buildSettlementLineDrafts(lines);
    const payouts = drafts.filter((d) => d.type === "payout").sort((a, b) => a.payoutId!.localeCompare(b.payoutId!));

    // Payout 1: rows 1+2, net 9583 + 4728 = 14311 -> a debit of -14311.
    expect(payouts[0]).toMatchObject({ payoutId: "po_1AbCdEfGhPayout01", transactionAmountCents: -14311 });
    // Payout 2: rows 3+4+5, net -4900 + 24302 + 2785 = 22187 -> a debit of -22187.
    expect(payouts[1]).toMatchObject({ payoutId: "po_1AbCdEfGhPayout02", transactionAmountCents: -22187 });
  });

  it("gives every draft a deterministic externalLineId, stable across a reimport of the identical file", async () => {
    const lines = await settlementLinesFor("stripe-payout.csv", ",");
    const once = buildSettlementLineDrafts(lines).map((d) => d.externalLineId);
    const again = buildSettlementLineDrafts(lines).map((d) => d.externalLineId);
    expect(again).toEqual(once);
    expect(new Set(once).size).toBe(once.length); // no two drafts collide
  });
});

describe("buildSettlementLineDrafts - Apple financial report", () => {
  it("reads a 'Sales or Return' indicator row as a refund (negative), never a revenue line", async () => {
    const lines = await settlementLinesFor("apple-financial-report.tsv", "\t");
    const drafts = buildSettlementLineDrafts(lines);

    const refund = drafts.filter((d) => d.type === "refund");
    const revenue = drafts.filter((d) => d.type === "revenue");
    // 4 rows: 3 sales (S) + 1 return (R).
    expect(revenue).toHaveLength(3);
    expect(refund).toHaveLength(1);
    expect(refund[0]!.transactionAmountCents).toBeLessThan(0);
  });

  it("never synthesizes a payout draft when the report has no payoutId column at all", async () => {
    const lines = await settlementLinesFor("apple-financial-report.tsv", "\t");
    const drafts = buildSettlementLineDrafts(lines);
    expect(drafts.some((d) => d.type === "payout")).toBe(false);
  });
});

// decisions/0048-app-store-reports.md: the real Apple payment-summary/Google Play earnings
// fixtures, routed through the two new DETERMINISTIC readers (no classifier involved at all -
// that is the whole point of these two formats) straight into `buildSettlementLineDrafts`,
// exactly the path `AccountsUseCases.importFromDocument` actually takes.
function readIntakeFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../intake/tests/fixtures/${name}`, import.meta.url)), "utf8");
}

describe("buildSettlementLineDrafts - Apple payment summary (real report)", () => {
  it("produces one revenue draft per region, no fee drafts, and no synthesized payout draft", () => {
    const parsed = parseApplePaymentSummary(readIntakeFixture("apple-payment-summary.csv"));
    const drafts = buildSettlementLineDrafts(parsed.lines);

    expect(drafts.filter((d) => d.type === "revenue")).toHaveLength(4);
    expect(drafts.filter((d) => d.type === "fee")).toHaveLength(0);
    expect(drafts.filter((d) => d.type === "payout")).toHaveLength(0);
    const revenueSum = drafts.filter((d) => d.type === "revenue").reduce((sum, d) => sum + d.transactionAmountCents, 0);
    expect(revenueSum).toBe(parsed.payoutAmountCents);
  });
});

describe("buildSettlementLineDrafts - Google Play earnings (real report)", () => {
  it("produces one revenue draft per Charge and one fee draft per Google fee, no payout draft", () => {
    const parsed = parseGooglePlayEarnings(readIntakeFixture("google-play-earnings.csv"));
    const drafts = buildSettlementLineDrafts(parsed.lines);

    expect(drafts.filter((d) => d.type === "revenue")).toHaveLength(4);
    expect(drafts.filter((d) => d.type === "fee")).toHaveLength(4);
    expect(drafts.filter((d) => d.type === "payout")).toHaveLength(0);

    const netSum = drafts.reduce((sum, d) => sum + d.transactionAmountCents, 0);
    expect(netSum).toBe(parsed.netAmountCents);
  });
});
