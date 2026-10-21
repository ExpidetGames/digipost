// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Neutral
// validation (WEBAPP_TEMPLATE_SPEC.md §2.5: every boundary is parsed with Zod) for the
// account detail page's filter state (URL search params, same convention as
// `@/modules/contacts`'s `contactListQuerySchema`/`@/modules/documents`'s
// `documentListQuerySchema`) and for manual account create/edit.
import { z } from "zod";

import { normalizeIban } from "@/modules/contacts";
import { ACCOUNT_TYPES, CREDIT_DEBIT_INDICATORS } from "@/persistence/repositories/contracts";

/** `/dashboard/finance/[accountId]` search params: free-text search (counterparty/remittance
 * text), a date range, an amount range (in whole euros - the form's own convenience unit,
 * converted to cents by `manualAccountCreateSchema`'s sibling in the action layer... actually
 * converted right here since the amount fields are cents-typed at every other boundary in this
 * codebase, `AGENTS.md`'s "Code" - a filter is not an exception), and the credit/debit toggle. */

/** decisions/0062-an-empty-search-param-means-absent.md: a `method="get"` filter form submits
 * EVERY field, so an untouched `<select>` or text input arrives as `""`. Without this, `""`
 * fails the field's own validation (`z.uuid()`, `z.enum()`, a date regex), the whole
 * `safeParse` fails, and the page falls back to "no filters at all" - the user picks one
 * filter, presses the button, and watches every filter disappear. Applied to the whole object
 * so a field added later is covered without anyone remembering this. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, raw === "" ? undefined : raw]));
}

export const transactionListQuerySchema = z.preprocess(
  blankToUndefined,
  z.object({
    q: z.string().trim().max(200).optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    minAmountCents: z.coerce.number().int().optional(),
    maxAmountCents: z.coerce.number().int().optional(),
    creditDebit: z.enum(CREDIT_DEBIT_INDICATORS).optional(),
    page: z.coerce.number().int().min(1).catch(1),
  }),
);
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
}

/** A human creating/editing an account by hand gets a hard validation error for a malformed
 * IBAN (mod-97 checksum) - they are present to fix it immediately, same rationale
 * `@/modules/contacts`'s `manualContactCreateSchema` already documents for the identical
 * tradeoff. IBAN is normalized here (uppercase, no spaces) before it ever reaches the use
 * case - the use case/repository never normalize on their own behalf. */
const ibanField = optionalText(34)
  .refine((value) => value === undefined || isValidIbanChecksum(value), { message: "invalid_iban_format" })
  .transform((value) => (value === undefined ? undefined : normalizeIban(value)));

function isValidIbanChecksum(raw: string): boolean {
  const iban = raw.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const accountFieldsSchema = {
  type: z.enum(ACCOUNT_TYPES),
  name: z.string().trim().min(1).max(200),
  iban: ibanField,
  bic: optionalText(11),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3)
    .optional()
    .transform((value) => value ?? "EUR"),
  holder: optionalText(200),
  platform: optionalText(60),
};

export const manualAccountCreateSchema = z.object(accountFieldsSchema);
export type ManualAccountCreateInput = z.infer<typeof manualAccountCreateSchema>;

export const manualAccountUpdateSchema = z.object(accountFieldsSchema).extend({ accountId: z.uuid() });
export type ManualAccountUpdateInput = z.infer<typeof manualAccountUpdateSchema>;

/** decisions/0068-supplier-clearing-accounts.md: "Verrechnungskonto anlegen" on a contact.
 * `paymentName` is the optional merchant name as the bank statement writes it ("FACEBK") -
 * a supplier settled through a clearing account never gets a confirmed match, so there is no
 * other moment at which its payment name could ever be learned (decisions/0047), and without
 * one its charges cannot be resolved to the contact at all. */
export const createContactClearingAccountSchema = z.object({
  contactId: z.uuid(),
  paymentName: optionalText(200),
});
export type CreateContactClearingAccountInput = z.infer<typeof createContactClearingAccountSchema>;

export const importFromDocumentInputSchema = z.object({
  documentId: z.uuid(),
  accountId: z.uuid().optional(),
});
