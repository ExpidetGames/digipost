/**
 * Guards against the same class of drift `src/modules/documents/tests/error-codes-i18n.test.ts`
 * already guards for that module: every `AccountActionErrorCode` must have a German message
 * under both namespaces that render it (`Finance.form.errors`, used by `AccountForm`/
 * `PendingAccountsSection`, and `Finance.detail.errors`, used by `ReimportButton`).
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { ACCOUNT_ACTION_ERROR_CODES } from "../core/error-codes";

describe("Finance.form.errors covers ACCOUNT_ACTION_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Finance.form.errors;

  it.each(ACCOUNT_ACTION_ERROR_CODES)("code %s resolves", (code) => {
    expect(typeof errors[code], `Finance.form.errors.${code} is missing from de.json`).toBe("string");
  });
});

describe("Finance.detail.errors covers ACCOUNT_ACTION_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Finance.detail.errors;

  it.each(ACCOUNT_ACTION_ERROR_CODES)("code %s resolves", (code) => {
    expect(typeof errors[code], `Finance.detail.errors.${code} is missing from de.json`).toBe("string");
  });
});
