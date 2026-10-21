import "server-only";

import { cache } from "react";

import { listTeamProjection } from "@/modules/workspaces/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { CONTACT_ERROR, type Contact, type ContactDetail, type ContactProposal } from "@/persistence/use-cases/contacts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";

import type { ContactProposalStatus, ContactRelationType } from "../core/types";
import type {
  ContactDetailView,
  ContactDocumentLinkView,
  ContactFieldsView,
  ContactListItem,
  ContactListView,
  ContactMergeOption,
  ContactProposalView,
  PendingProposalSummary,
} from "../core/view-types";

export const CONTACTS_PAGE_SIZE = 30;

export type ListContactsParams = {
  q?: string;
  relationType?: ContactRelationType;
  /** `true` = "Nur unbestätigte" filter on. */
  onlyUnverified?: boolean;
  page: number;
};

function toStringField(value: string | number | null): string {
  if (value === null) return "";
  return String(value);
}

function toFieldsView(contact: Contact): ContactFieldsView {
  return {
    name: contact.name,
    legalForm: toStringField(contact.legalForm),
    addressLine1: toStringField(contact.addressLine1),
    addressLine2: toStringField(contact.addressLine2),
    postalCode: toStringField(contact.postalCode),
    city: toStringField(contact.city),
    country: toStringField(contact.country),
    vatId: toStringField(contact.vatId),
    taxNumber: toStringField(contact.taxNumber),
    registerCourt: toStringField(contact.registerCourt),
    registerNumber: toStringField(contact.registerNumber),
    leitwegId: toStringField(contact.leitwegId),
    iban: toStringField(contact.iban),
    bic: toStringField(contact.bic),
    bankName: toStringField(contact.bankName),
    accountHolder: toStringField(contact.accountHolder),
    sepaCreditorId: toStringField(contact.sepaCreditorId),
    phone: toStringField(contact.phone),
    email: toStringField(contact.email),
    website: toStringField(contact.website),
    contactPerson: toStringField(contact.contactPerson),
    customerNumber: toStringField(contact.customerNumber),
    supplierNumber: toStringField(contact.supplierNumber),
    paymentTermsDays: toStringField(contact.paymentTermsDays),
    relationType: contact.relationType ?? "",
    notes: toStringField(contact.notes),
  };
}

function toProposalView(proposal: ContactProposal): ContactProposalView {
  return {
    id: proposal.id,
    field: proposal.field,
    currentValue: proposal.currentValue,
    proposedValue: proposal.proposedValue,
    createdAt: proposal.createdAt.toISOString(),
  };
}

/**
 * The `/dashboard/contacts` list read model. `documentsCount`/`pendingProposalsCount` are
 * not part of `ContactUseCases.listForWorkspace`'s own return shape (C1's contract,
 * `decisions/0019-contacts.md`, has no count-bearing list method) - this is a known, accepted
 * gap this phase fills with an explicit N+1 (`getById` per row), same "acceptable at this
 * product's scale, a small business's own contact book" reasoning the ADR already applies to
 * `ContactRepository.listAllForWorkspace`. Reported as a judgment call in this phase's own
 * summary rather than silently added to `src/persistence/**`, which is out of this phase's
 * file scope. See `src/modules/contacts/README.md`'s "Known gaps".
 */
export async function listContactsProjection(workspaceId: string, params: ListContactsParams): Promise<ContactListView> {
  const result = await getRequestServices().contacts.listForWorkspace(workspaceId, {
    q: params.q,
    relationType: params.relationType,
    verified: params.onlyUnverified ? false : undefined,
    page: params.page,
    pageSize: CONTACTS_PAGE_SIZE,
  });

  const items: ContactListItem[] = await Promise.all(
    result.items.map(async (contact): Promise<ContactListItem> => {
      const detail = await getRequestServices().contacts.getById(workspaceId, contact.id);
      return {
        id: contact.id,
        name: contact.name,
        relationType: contact.relationType,
        vatId: contact.vatId,
        customerNumber: contact.customerNumber,
        verified: contact.verifiedAt !== null,
        documentsCount: detail.documents.length,
        pendingProposalsCount: detail.pendingProposals.length,
      };
    }),
  );

  return { items, hasMore: result.hasMore, page: params.page };
}

/** `null` when the contact does not exist in this workspace - the `[id]` page 404s. */
export const getContactDetailProjection = cache(
  async (workspaceId: string, id: string): Promise<ContactDetailView | null> => {
    let detail: ContactDetail;
    try {
      detail = await getRequestServices().contacts.getById(workspaceId, id);
    } catch (err) {
      if (err instanceof UseCaseError && err.code === CONTACT_ERROR.notFound) return null;
      throw err;
    }

    const team = await listTeamProjection(workspaceId);
    const memberByUserId = new Map(team.members.map((m) => [m.userId, m]));
    const verifiedBy = detail.verifiedByUserId ? memberByUserId.get(detail.verifiedByUserId) : undefined;

    const documents: ContactDocumentLinkView[] = detail.documents.map((link) => ({
      documentId: link.documentId,
      role: link.role,
      originalFileName: link.originalFileName,
      documentCreatedAt: link.documentCreatedAt.toISOString(),
    }));

    return {
      id: detail.id,
      fields: toFieldsView(detail),
      verified: detail.verifiedAt !== null,
      verifiedAt: detail.verifiedAt ? detail.verifiedAt.toISOString() : null,
      verifiedByName: verifiedBy ? `${verifiedBy.name} (${verifiedBy.email})` : null,
      documents,
      pendingProposals: detail.pendingProposals.map(toProposalView),
    };
  },
);

/** Search options for the "Zusammenführen" (merge) picker - every other contact in the
 * workspace, `id`/`name` only (the whole contact book fits in memory at this product's
 * scale, same reasoning `listAllForWorkspace` already documents). Client-side filters by
 * name as the admin types, no server round trip per keystroke. */
export const listMergeOptionsProjection = cache(
  async (workspaceId: string, excludeId: string): Promise<ContactMergeOption[]> => {
    const rows = await getRequestServices().contacts.listForWorkspace(workspaceId, { page: 1, pageSize: 1000 });
    return rows.items.filter((c) => c.id !== excludeId).map((c) => ({ id: c.id, name: c.name }));
  },
);

/**
 * The contacts list page's global entry point to pending proposals (scope item 3): every
 * pending proposal in the workspace, with its own contact's name resolved so the page never
 * needs a second round trip per row.
 */
export async function listPendingProposalsSummaryProjection(workspaceId: string): Promise<PendingProposalSummary[]> {
  const proposals = await getRequestServices().contacts.listProposals(workspaceId, { status: "pending" as ContactProposalStatus });
  if (proposals.length === 0) return [];

  const contactIds = [...new Set(proposals.map((p) => p.contactId))];
  const contacts = await Promise.all(contactIds.map((id) => getRequestServices().contacts.getById(workspaceId, id).catch(() => null)));
  const nameById = new Map(contacts.filter((c): c is ContactDetail => c !== null).map((c) => [c.id, c.name]));

  return proposals.map((p) => ({
    id: p.id,
    contactId: p.contactId,
    contactName: nameById.get(p.contactId) ?? "",
    field: p.field,
    currentValue: p.currentValue,
    proposedValue: p.proposedValue,
  }));
}
