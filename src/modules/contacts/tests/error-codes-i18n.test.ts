/**
 * Guards against the same class of drift `src/modules/documents/tests/error-codes-i18n.test.ts`
 * already guards for that module: every reachable `ContactActionErrorCode` must have a
 * German message under both namespaces that render it (`Contacts.form.errors`, used by
 * `ui/contact-form.tsx`'s create/update flow, and `Contacts.detail.errors`, used by every
 * other contact action on the detail page: verify/delete/merge/accept/reject/unlink).
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { CONTACT_ACTION_ERROR_CODES } from "../core/error-codes";

describe("Contacts.form.errors covers CONTACT_ACTION_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Contacts.form.errors;

  it.each(CONTACT_ACTION_ERROR_CODES)("code %s resolves", (code) => {
    expect(typeof errors[code], `Contacts.form.errors.${code} is missing from de.json`).toBe("string");
  });
});

describe("Contacts.detail.errors covers CONTACT_ACTION_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Contacts.detail.errors;

  it.each(CONTACT_ACTION_ERROR_CODES)("code %s resolves", (code) => {
    expect(typeof errors[code], `Contacts.detail.errors.${code} is missing from de.json`).toBe("string");
  });
});

describe("Contacts.fieldLabels covers every COMPARABLE_CONTACT_FIELDS entry", () => {
  const labels: Record<string, unknown> = de.Contacts.fieldLabels;
  const fields = [
    "legalForm",
    "addressLine1",
    "addressLine2",
    "postalCode",
    "city",
    "country",
    "vatId",
    "taxNumber",
    "registerCourt",
    "registerNumber",
    "leitwegId",
    "iban",
    "bic",
    "bankName",
    "accountHolder",
    "sepaCreditorId",
    "phone",
    "email",
    "website",
    "contactPerson",
    "customerNumber",
    "supplierNumber",
    "paymentTermsDays",
    "notes",
    "relationType",
  ];

  it.each(fields)("field %s resolves", (field) => {
    expect(typeof labels[field], `Contacts.fieldLabels.${field} is missing from de.json`).toBe("string");
  });
});
