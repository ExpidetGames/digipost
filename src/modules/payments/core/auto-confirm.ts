// Owner: src/modules/payments (decisions/0044). The workspace's auto-confirm mode for payment
// suggestions, chosen by an admin:
// - "all": every unambiguous suggestion is confirmed automatically, AI suggestions included
// - "system": only suggestions found by the deterministic stages (rules, arithmetic)
// - "none": nothing is confirmed automatically, a human accepts every suggestion
// In every mode only an unambiguous suggestion is confirmed: the only open one for its
// transaction and the only open one for its document.
export const PAYMENT_AUTO_CONFIRM_MODES = ["all", "system", "none"] as const;
export type PaymentAutoConfirmMode = (typeof PAYMENT_AUTO_CONFIRM_MODES)[number];
export const DEFAULT_PAYMENT_AUTO_CONFIRM_MODE: PaymentAutoConfirmMode = "system";

export function isPaymentAutoConfirmMode(value: unknown): value is PaymentAutoConfirmMode {
  return typeof value === "string" && (PAYMENT_AUTO_CONFIRM_MODES as readonly string[]).includes(value);
}
