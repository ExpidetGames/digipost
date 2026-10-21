// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md). Neutral
// validation (WEBAPP_TEMPLATE_SPEC.md §2.5: every boundary is parsed with Zod) for every
// Server Action input this module exposes.
import { z } from "zod";

import { PAYMENT_AUTO_CONFIRM_MODES } from "./auto-confirm";

export const decisionInputSchema = z.object({ documentTransactionId: z.uuid() });
export type DecisionActionInput = z.infer<typeof decisionInputSchema>;

export const linkManuallyInputSchema = z.object({
  documentId: z.uuid(),
  transactionId: z.uuid(),
  /** Optional - omitted, the use case allocates the smaller of the transaction's paid amount
   * and the document's currently open amount. In whole cents, same convention as every other
   * amount field in this codebase. */
  allocatedAmountCents: z.coerce.number().int().positive().optional(),
});
export type LinkManuallyActionInput = z.infer<typeof linkManuallyInputSchema>;

export const markNoDocumentNeededInputSchema = z.object({
  transactionIds: z.array(z.uuid()).min(1),
  forCounterparty: z.boolean().default(false),
});
export type MarkNoDocumentNeededActionInput = z.infer<typeof markNoDocumentNeededInputSchema>;

export const markSettledWithoutPaymentInputSchema = z.object({ documentId: z.uuid() });
export type MarkSettledWithoutPaymentActionInput = z.infer<typeof markSettledWithoutPaymentInputSchema>;

/** decisions/0044: the finance page's auto-confirm mode switch. */
export const paymentAutoConfirmInputSchema = z.object({ mode: z.enum(PAYMENT_AUTO_CONFIRM_MODES) });

/** decisions/0047: removing one learned counterparty name. */
export const deletePaymentAliasInputSchema = z.object({ aliasId: z.string().uuid() });
