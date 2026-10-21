// Barrel merging every owner's schema file (WEBAPP_TEMPLATE_SPEC.md §5.7). This is
// the file `drizzle.config.ts` points `schema:` at, and the only import
// `src/persistence/foundation/client.ts` needs for `drizzle({ schema, ... })`.
//
// Ownership (src/persistence/README.md has the full table): auth.ts -> src/platform/auth,
// workspaces.ts -> src/modules/workspaces, documents.ts -> src/modules/documents,
// billing.ts -> src/modules/billing, jobs.ts -> src/platform/jobs, contacts.ts ->
// src/modules/contacts (decisions/0019-contacts.md), intake-fingerprints.ts ->
// src/modules/documents (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md),
// accounts.ts -> src/modules/accounts (decisions/0024-accounts-and-transactions.md),
// payments.ts -> src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md). Load
// order matters here: contacts.ts, intake-fingerprints.ts, and accounts.ts each reference
// workspaces.ts (and/or documents.ts), so all three are exported last; payments.ts references
// accounts.ts/contacts.ts/documents.ts in turn, so it is exported last of all.
export * from "./auth";
export * from "./workspaces";
export * from "./documents";
export * from "./billing";
export * from "./jobs";
export * from "./contacts";
export * from "./intake-fingerprints";
export * from "./accounts";
export * from "./payments";
