// The processing pipeline's branching decision table (decisions/0020-universal-intake.md,
// decisions/0022-intake-wiring.md, decisions/0028-mt940-support.md, decisions/0048-app-store-reports.md) -
// pure, no I/O.
import { describe, expect, it } from "vitest";

import { decideIntakeBranch, type IntakeBranchInput } from "../core/intake-branch";

const BASE: IntakeBranchInput = {
  mimeType: "text/csv",
  isCamt053: false,
  isMt940: false,
  isApplePaymentSummary: false,
  isGooglePlayEarnings: false,
  hasKnownFingerprint: false,
};

describe("decideIntakeBranch", () => {
  it("routes a PDF to the OCR pipeline regardless of the other flags", () => {
    expect(decideIntakeBranch({ ...BASE, mimeType: "application/pdf" })).toBe("ocr");
    expect(decideIntakeBranch({ ...BASE, mimeType: "application/pdf", isCamt053: true, isMt940: true, isApplePaymentSummary: true, isGooglePlayEarnings: true, hasKnownFingerprint: true })).toBe(
      "ocr",
    );
  });

  it("routes a recognized camt.053 XML to the deterministic parse", () => {
    expect(decideIntakeBranch({ ...BASE, mimeType: "application/xml", isCamt053: true })).toBe("camt053");
  });

  it("routes a recognized MT940 file to its own deterministic parse (decisions/0028-mt940-support.md)", () => {
    expect(decideIntakeBranch({ ...BASE, mimeType: "application/vnd.mt940", isMt940: true })).toBe("mt940");
  });

  it("camt.053 wins when (impossibly) both self-identifying flags are set - camt.053 is checked first", () => {
    expect(decideIntakeBranch({ ...BASE, mimeType: "application/xml", isCamt053: true, isMt940: true })).toBe("camt053");
  });

  it("routes a recognized Apple payment summary to its own deterministic parse (decisions/0048-app-store-reports.md)", () => {
    expect(decideIntakeBranch({ ...BASE, isApplePaymentSummary: true })).toBe("apple_payment_summary");
  });

  it("routes a recognized Google Play earnings report to its own deterministic parse", () => {
    expect(decideIntakeBranch({ ...BASE, isGooglePlayEarnings: true })).toBe("google_play_earnings");
  });

  it("mt940 wins over the app-store flags when (impossibly) both are set - self-identifying bank formats are checked first", () => {
    expect(decideIntakeBranch({ ...BASE, mimeType: "application/vnd.mt940", isMt940: true, isApplePaymentSummary: true })).toBe("mt940");
  });

  it("Apple wins over Google when (impossibly) both are set - Apple is checked first", () => {
    expect(decideIntakeBranch({ ...BASE, isApplePaymentSummary: true, isGooglePlayEarnings: true })).toBe("apple_payment_summary");
  });

  it("routes a CSV/TSV with a confirmed fingerprint to the known-source path", () => {
    expect(decideIntakeBranch({ ...BASE, hasKnownFingerprint: true })).toBe("tabular_known_source");
    expect(decideIntakeBranch({ ...BASE, mimeType: "text/tab-separated-values", hasKnownFingerprint: true })).toBe("tabular_known_source");
  });

  it("routes a CSV/TSV with no confirmed fingerprint to the unknown-source proposal path", () => {
    expect(decideIntakeBranch({ ...BASE, hasKnownFingerprint: false })).toBe("tabular_unknown_source");
  });
});
