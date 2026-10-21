/**
 * Guards against the "code has no translation" class of bug found elsewhere in P6's
 * review (see documents'/workspaces' equivalent tests): every code
 * `BillingActionErrorCode` can hold must have a message under `de.json`'s `Billing.errors`
 * (the only namespace `ui/*.tsx` surfaces it through, via `t(\`errors.${errorCode}\`)`).
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { BILLING_ACTION_ERROR_CODES } from "../core/error-codes";

describe("Billing.errors covers BILLING_ACTION_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Billing.errors;

  it.each(BILLING_ACTION_ERROR_CODES)("code %s resolves", (code) => {
    expect(typeof errors[code], `Billing.errors.${code} is missing from de.json`).toBe("string");
  });
});
