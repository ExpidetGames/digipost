// Unit tests for the Server Actions (WEBAPP_TEMPLATE_SPEC.md §10.2: `vi.mock` on the exact
// module paths `actions.ts` imports, no DB, no network). Mirrors
// `src/modules/documents/tests/actions.test.ts`'s pattern.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/access/server", () => ({
  requirePermission: vi.fn(),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

const contactsUseCases = {
  createManual: vi.fn(),
  updateManual: vi.fn(),
  getById: vi.fn(),
  deleteContact: vi.fn(),
  mergeContacts: vi.fn(),
  acceptProposal: vi.fn(),
  rejectProposal: vi.fn(),
  unlinkDocument: vi.fn(),
};
// decisions/0037-correction-buttons.md: `markContactAsOwnCompanyAction`/
// `markContactAsOwnBankAction` also call `src/modules/workspaces`'s use case - mocked here
// the same way as `contactsUseCases` above, never the real `createWorkspaceUseCases`.
const workspacesUseCases = {
  addCompanyAlias: vi.fn(),
  addCompanyIban: vi.fn(),
};
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ contacts: contactsUseCases, workspaces: workspacesUseCases }),
}));

import { requirePermission } from "@/platform/access/server";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { CONTACT_ERROR } from "@/persistence/use-cases/contacts-use-cases";
import { WORKSPACE_ERROR } from "@/persistence/use-cases/workspaces-use-cases";

import {
  acceptProposalAction,
  createContactAction,
  deleteContactAction,
  markContactAsOwnBankAction,
  markContactAsOwnCompanyAction,
  mergeContactsAction,
  rejectProposalAction,
  unlinkDocumentAction,
  updateContactAction,
  verifyContactAction,
} from "../actions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";

const ACCESS = {
  status: "ok" as const,
  access: {
    user: { id: "u1", email: "member@example.test" },
    membershipId: "m1",
    role: "member" as const,
    workspace: { id: "w1", name: "Muster GmbH", tier: "free" },
    permissions: ["documents.read", "documents.write"] as const,
  },
};

// decisions/0037-correction-buttons.md: "Das sind wir"/"Das ist unsere Bank" require
// `company_profile.manage`, which `ACCESS` above (a plain member) does not carry.
const ADMIN_ACCESS = {
  status: "ok" as const,
  access: {
    user: { id: "admin1", email: "admin@example.test" },
    membershipId: "m2",
    role: "admin" as const,
    workspace: { id: "w1", name: "Muster GmbH", tier: "free" },
    permissions: ["documents.read", "documents.write", "company_profile.manage"] as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createContactAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await createContactAction({ name: "" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("forwards a forbidden result from requirePermission", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });
    const result = await createContactAction({ name: "Muster GmbH" });
    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(contactsUseCases.createManual).not.toHaveBeenCalled();
  });

  it("creates and revalidates on success", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.createManual.mockResolvedValue({ id: CONTACT_ID });

    const result = await createContactAction({ name: "Muster GmbH", vatId: "DE123456789" });

    expect(result).toEqual({ status: "success", data: { id: CONTACT_ID } });
    expect(contactsUseCases.createManual).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", actingUserId: "u1", name: "Muster GmbH", vatId: "DE123456789" }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/contacts");
  });

  it("maps an unrecognized error to unknown", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.createManual.mockRejectedValue(new Error("boom"));

    const result = await createContactAction({ name: "Muster GmbH" });

    expect(result).toEqual({ status: "error", errorCode: "unknown" });
  });
});

describe("updateContactAction", () => {
  it("updates and revalidates both the list and the detail page", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.updateManual.mockResolvedValue({ id: CONTACT_ID });

    const result = await updateContactAction({ contactId: CONTACT_ID, name: "Neuer Name" });

    expect(result).toEqual({ status: "success", data: { id: CONTACT_ID } });
    expect(contactsUseCases.updateManual).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", actingUserId: "u1", contactId: CONTACT_ID, name: "Neuer Name" }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/contacts");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/contacts/${CONTACT_ID}`);
  });

  it("maps not_found from a thrown UseCaseError", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.updateManual.mockRejectedValue(new UseCaseError(CONTACT_ERROR.notFound));

    const result = await updateContactAction({ contactId: CONTACT_ID, name: "Neuer Name" });

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
  });
});

describe("verifyContactAction", () => {
  it("re-submits the contact's own current fields through updateManual", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.getById.mockResolvedValue({
      id: CONTACT_ID,
      name: "Muster GmbH",
      legalForm: "GmbH",
      addressLine1: null,
      vatId: "DE123456789",
      relationType: "supplier",
    });
    contactsUseCases.updateManual.mockResolvedValue({ id: CONTACT_ID });

    const result = await verifyContactAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "success", data: { id: CONTACT_ID } });
    expect(contactsUseCases.updateManual).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        actingUserId: "u1",
        contactId: CONTACT_ID,
        name: "Muster GmbH",
        legalForm: "GmbH",
        vatId: "DE123456789",
        relationType: "supplier",
      }),
    );
    // A `null` field is never re-sent (would fail the update schema's required-string
    // fields) - only fields the contact actually had a value for.
    const call = contactsUseCases.updateManual.mock.calls[0]![0];
    expect(call).not.toHaveProperty("addressLine1");
  });

  it("rejects invalid input without checking permission", async () => {
    const result = await verifyContactAction({ contactId: "not-a-uuid" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });
});

describe("deleteContactAction", () => {
  it("deletes and revalidates", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.deleteContact.mockResolvedValue(undefined);

    const result = await deleteContactAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(contactsUseCases.deleteContact).toHaveBeenCalledWith({ workspaceId: "w1", contactId: CONTACT_ID });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/contacts");
  });

  it("maps not_found", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.deleteContact.mockRejectedValue(new UseCaseError(CONTACT_ERROR.notFound));

    const result = await deleteContactAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
  });
});

describe("mergeContactsAction", () => {
  it("merges and revalidates the source, target, and list paths", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.mergeContacts.mockResolvedValue({ id: OTHER_CONTACT_ID });

    const result = await mergeContactsAction({ sourceId: CONTACT_ID, targetId: OTHER_CONTACT_ID });

    expect(result).toEqual({ status: "success", data: { id: OTHER_CONTACT_ID } });
    expect(contactsUseCases.mergeContacts).toHaveBeenCalledWith({ workspaceId: "w1", sourceId: CONTACT_ID, targetId: OTHER_CONTACT_ID });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/contacts/${CONTACT_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/contacts/${OTHER_CONTACT_ID}`);
  });

  it("maps cannot_merge_self from the use case's own guard", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.mergeContacts.mockRejectedValue(new UseCaseError(CONTACT_ERROR.cannotMergeSelf));

    const result = await mergeContactsAction({ sourceId: CONTACT_ID, targetId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "cannot_merge_self" });
  });
});

describe("acceptProposalAction / rejectProposalAction", () => {
  it("accepts a proposal as the signed-in user", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.acceptProposal.mockResolvedValue(undefined);

    const result = await acceptProposalAction({ proposalId: PROPOSAL_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(contactsUseCases.acceptProposal).toHaveBeenCalledWith({ workspaceId: "w1", proposalId: PROPOSAL_ID, decidedByUserId: "u1" });
  });

  it("maps proposal_not_found on reject", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.rejectProposal.mockRejectedValue(new UseCaseError(CONTACT_ERROR.proposalNotFound));

    const result = await rejectProposalAction({ proposalId: PROPOSAL_ID });

    expect(result).toEqual({ status: "error", errorCode: "proposal_not_found" });
  });
});

describe("markContactAsOwnCompanyAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await markContactAsOwnCompanyAction({ contactId: "not-a-uuid" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("forwards a forbidden result for a member lacking company_profile.manage", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });

    const result = await markContactAsOwnCompanyAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(contactsUseCases.getById).not.toHaveBeenCalled();
  });

  it("adds the contact's current name as an alias, then deletes the contact, for an admin", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockResolvedValue({ id: CONTACT_ID, name: "Musterfirma" });
    workspacesUseCases.addCompanyAlias.mockResolvedValue({});
    contactsUseCases.deleteContact.mockResolvedValue(undefined);

    const result = await markContactAsOwnCompanyAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(contactsUseCases.getById).toHaveBeenCalledWith("w1", CONTACT_ID);
    expect(workspacesUseCases.addCompanyAlias).toHaveBeenCalledWith({ workspaceId: "w1", alias: "Musterfirma" });
    expect(contactsUseCases.deleteContact).toHaveBeenCalledWith({ workspaceId: "w1", contactId: CONTACT_ID });
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/contacts");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/contacts/${CONTACT_ID}`);
  });

  it("does not delete the contact when the profile update rejects a too-generic alias", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockResolvedValue({ id: CONTACT_ID, name: "GbR" });
    workspacesUseCases.addCompanyAlias.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.aliasTooGeneric));

    const result = await markContactAsOwnCompanyAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "alias_too_generic" });
    expect(contactsUseCases.deleteContact).not.toHaveBeenCalled();
  });

  it("maps not_found for a cross-workspace/missing contact id, changing nothing", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockRejectedValue(new UseCaseError(CONTACT_ERROR.notFound));

    const result = await markContactAsOwnCompanyAction({ contactId: OTHER_CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "not_found" });
    expect(workspacesUseCases.addCompanyAlias).not.toHaveBeenCalled();
    expect(contactsUseCases.deleteContact).not.toHaveBeenCalled();
  });
});

describe("markContactAsOwnBankAction", () => {
  it("rejects invalid input without checking permission", async () => {
    const result = await markContactAsOwnBankAction({ contactId: "not-a-uuid" });
    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(requirePermission).not.toHaveBeenCalled();
  });

  it("forwards a forbidden result for a member lacking company_profile.manage", async () => {
    vi.mocked(requirePermission).mockResolvedValue({ status: "error", errorCode: "forbidden" });

    const result = await markContactAsOwnBankAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "forbidden" });
    expect(contactsUseCases.getById).not.toHaveBeenCalled();
  });

  it("refuses with contact_missing_iban and deletes nothing when the contact has no IBAN", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockResolvedValue({ id: CONTACT_ID, iban: null });

    const result = await markContactAsOwnBankAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "contact_missing_iban" });
    expect(workspacesUseCases.addCompanyIban).not.toHaveBeenCalled();
    expect(contactsUseCases.deleteContact).not.toHaveBeenCalled();
  });

  it("refuses with contact_missing_iban for a malformed IBAN", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockResolvedValue({ id: CONTACT_ID, iban: "not an iban" });

    const result = await markContactAsOwnBankAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "contact_missing_iban" });
    expect(workspacesUseCases.addCompanyIban).not.toHaveBeenCalled();
  });

  it("adds the IBAN to the company profile, then deletes the contact, for an admin", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockResolvedValue({ id: CONTACT_ID, iban: "DE89370400440532013000" });
    workspacesUseCases.addCompanyIban.mockResolvedValue({});
    contactsUseCases.deleteContact.mockResolvedValue(undefined);

    const result = await markContactAsOwnBankAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(workspacesUseCases.addCompanyIban).toHaveBeenCalledWith({ workspaceId: "w1", iban: "DE89370400440532013000" });
    expect(contactsUseCases.deleteContact).toHaveBeenCalledWith({ workspaceId: "w1", contactId: CONTACT_ID });
  });

  it("does not delete the contact when the profile update rejects the IBAN", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ADMIN_ACCESS);
    contactsUseCases.getById.mockResolvedValue({ id: CONTACT_ID, iban: "DE89370400440532013000" });
    workspacesUseCases.addCompanyIban.mockRejectedValue(new UseCaseError(WORKSPACE_ERROR.invalidInput));

    const result = await markContactAsOwnBankAction({ contactId: CONTACT_ID });

    expect(result).toEqual({ status: "error", errorCode: "invalid_input" });
    expect(contactsUseCases.deleteContact).not.toHaveBeenCalled();
  });
});

describe("unlinkDocumentAction", () => {
  it("unlinks and revalidates both the contact and the document detail page", async () => {
    vi.mocked(requirePermission).mockResolvedValue(ACCESS);
    contactsUseCases.unlinkDocument.mockResolvedValue(undefined);

    const result = await unlinkDocumentAction({ documentId: DOCUMENT_ID, contactId: CONTACT_ID, role: "sender" });

    expect(result).toEqual({ status: "success", data: undefined });
    expect(contactsUseCases.unlinkDocument).toHaveBeenCalledWith({
      workspaceId: "w1",
      documentId: DOCUMENT_ID,
      contactId: CONTACT_ID,
      role: "sender",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/contacts/${CONTACT_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledWith(`/dashboard/documents/${DOCUMENT_ID}`);
  });
});
