import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). C3 addition: this module had no
 * `server.ts` yet (C1 shipped domain-only, see `README.md`). Only Next seams
 * (`src/app/(app)/dashboard/contacts/**`) import from here, never from
 * `src/modules/contacts/core/**`/`server/**` directly.
 */
export {
  CONTACTS_PAGE_SIZE,
  getContactDetailProjection,
  listContactsProjection,
  listMergeOptionsProjection,
  listPendingProposalsSummaryProjection,
  type ListContactsParams,
} from "./server/read-models";
