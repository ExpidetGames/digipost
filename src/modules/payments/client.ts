"use client";

/**
 * Public client entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). The `(app)` pages under
 * `/dashboard/documents/[id]` and `/dashboard/finance/zuordnung` import from here, never from
 * `src/modules/payments/ui/**` directly.
 */
export { PaymentSection, type ManualLinkCandidate } from "./ui/payment-section";
export { ZuordnungClient } from "./ui/zuordnung-client";
export { AutoConfirmModeSelect } from "./ui/auto-confirm-mode";
export { ContactPaymentAliases } from "./ui/contact-payment-aliases";
export { SettlementReportSection } from "./ui/settlement-report-section";
