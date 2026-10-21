"use server";

import { revalidatePath } from "next/cache";

import { PERMISSIONS } from "@/platform/access";
import { requirePermission } from "@/platform/access/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import { CONTACT_ERROR, type Contact } from "@/persistence/use-cases/contacts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { WORKSPACE_ERROR } from "@/persistence/use-cases/workspaces-use-cases";
import type { ActionResult } from "@/shared/action-result";

import { isValidIbanFormat } from "./core/format-checks";
import { COMPARABLE_CONTACT_FIELDS, type ComparableContactField, type ContactRelationType } from "./core/types";
import type { ContactActionErrorCode } from "./core/error-codes";
import {
  acceptProposalInputSchema,
  deleteContactInputSchema,
  manualContactCreateSchema,
  markContactAsOwnBankInputSchema,
  markContactAsOwnCompanyInputSchema,
  mergeContactsInputSchema,
  rejectProposalInputSchema,
  unlinkDocumentInputSchema,
  updateContactInputSchema,
  verifyContactInputSchema,
} from "./core/schemas";

// C3 addition: `src/modules/contacts` had no Server Action layer yet (C1 shipped domain
// only, `README.md`). Follows `src/modules/documents/actions.ts`'s established pattern:
// parse with Zod first (never checks permission on a malformed call), then
// `requirePermission`, then call the use case and map `UseCaseError` to a stable code.
//
// Permission judgment call: `src/platform/access`'s `PERMISSIONS` has no
// `contacts.manage`/similar bundle, and this phase deliberately does not add one -
// `decisions/0019-contacts.md`'s own "Consequences" section already flags that C2 is
// expected to add `PERMISSIONS.companyProfileManage` to that same file
// (`src/platform/access/core/permissions.ts`) for the company-profile settings page, and C2
// runs at the same time as this phase (`C3.md`'s "Parallel work and hard constraints": that
// file is not in this phase's owned list). Adding a second new permission there concurrently
// would risk a needless merge conflict on a file neither phase's file-scope explicitly
// grants. Every contact action below is therefore gated behind the existing
// `PERMISSIONS.documentsWrite` (granted to every workspace member): contacts are populated
// from and linked to documents every member already reads and writes, and the C1 contract's
// own use cases enforce no authorization of their own either way. This is a judgment call
// flagged in this phase's final report for review.
const CONTACTS_PERMISSION = PERMISSIONS.documentsWrite;

function mapUseCaseError(err: unknown): ContactActionErrorCode {
  if (err instanceof UseCaseError) {
    const code = err.code;
    if (
      code === CONTACT_ERROR.invalidInput ||
      code === CONTACT_ERROR.notFound ||
      code === CONTACT_ERROR.documentNotFound ||
      code === CONTACT_ERROR.proposalNotFound ||
      code === CONTACT_ERROR.cannotMergeSelf
    ) {
      return code;
    }
  }
  return "unknown";
}

/** decisions/0037-correction-buttons.md: `markContactAsOwnCompanyAction`/
 * `markContactAsOwnBankAction` call both `src/modules/workspaces`'s `addCompanyAlias`/
 * `addCompanyIban` and this module's own `deleteContact` - a thrown `UseCaseError` can
 * therefore carry either use case's own code. Checked by value (both areas' `not_found` is
 * the literal string `"not_found"` either way), not by re-running `mapUseCaseError` above,
 * since that function does not recognize `WORKSPACE_ERROR`'s own codes. */
const CORRECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  CONTACT_ERROR.notFound,
  WORKSPACE_ERROR.notFound,
  WORKSPACE_ERROR.aliasTooGeneric,
  WORKSPACE_ERROR.invalidIban,
  WORKSPACE_ERROR.invalidInput,
]);

function mapCorrectionError(err: unknown): ContactActionErrorCode {
  if (err instanceof UseCaseError && CORRECTION_ERROR_CODES.has(err.code)) {
    return err.code as ContactActionErrorCode;
  }
  return "unknown";
}

function revalidateContact(id: string) {
  revalidatePath("/dashboard/contacts");
  revalidatePath(`/dashboard/contacts/${id}`);
}

/** Every `COMPARABLE_CONTACT_FIELDS` entry from an already-loaded `Contact`, `null` mapped
 * to `undefined` - used only by `verifyContactAction` to re-submit a contact's own unchanged
 * values through `updateManual` (there is no dedicated "verify without other changes" use
 * case method in the C1 contract; `updateManual` already "verifies" as a side effect of any
 * save, so resubmitting the same values is the documented way to get that effect with no
 * other change, per `decisions/0019-contacts.md`'s verification semantics). */
function contactToManualFields(contact: Contact): Partial<Record<ComparableContactField, string | number>> & {
  relationType?: ContactRelationType;
} {
  const result: Partial<Record<ComparableContactField, string | number>> = {};
  for (const field of COMPARABLE_CONTACT_FIELDS) {
    const value = contact[field];
    if (value !== null) result[field] = value;
  }
  return { ...result, relationType: contact.relationType ?? undefined };
}

/** Manual create - always counts as verification (`createManual`'s own rule). */
export async function createContactAction(input: unknown): Promise<ActionResult<{ id: string }, ContactActionErrorCode>> {
  const parsed = manualContactCreateSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const { name, ...fields } = parsed.data;
    const contact = await getRequestServices().contacts.createManual({
      workspaceId: access.access.workspace.id,
      actingUserId: access.access.user.id,
      name,
      ...fields,
    });
    revalidatePath("/dashboard/contacts");
    return { status: "success", data: { id: contact.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Manual edit - a full replace of every editable field, always re-verifies. */
export async function updateContactAction(input: unknown): Promise<ActionResult<{ id: string }, ContactActionErrorCode>> {
  const parsed = updateContactInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const { contactId, name, ...fields } = parsed.data;
    const contact = await getRequestServices().contacts.updateManual({
      workspaceId: access.access.workspace.id,
      actingUserId: access.access.user.id,
      contactId,
      name,
      ...fields,
    });
    revalidateContact(contact.id);
    return { status: "success", data: { id: contact.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Bestätigen": verifies an unverified contact without changing any of its fields - see
 * `contactToManualFields`'s doc comment for why this goes through `updateManual`. */
export async function verifyContactAction(input: unknown): Promise<ActionResult<{ id: string }, ContactActionErrorCode>> {
  const parsed = verifyContactInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const workspaceId = access.access.workspace.id;
    const current = await getRequestServices().contacts.getById(workspaceId, parsed.data.contactId);
    const contact = await getRequestServices().contacts.updateManual({
      workspaceId,
      actingUserId: access.access.user.id,
      contactId: current.id,
      name: current.name,
      ...contactToManualFields(current),
    });
    revalidateContact(contact.id);
    return { status: "success", data: { id: contact.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Deletes a contact (links are removed by `on delete cascade`; the documents themselves
 * stay, `decisions/0019-contacts.md`). */
export async function deleteContactAction(input: unknown): Promise<ActionResult<undefined, ContactActionErrorCode>> {
  const parsed = deleteContactInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().contacts.deleteContact({ workspaceId: access.access.workspace.id, contactId: parsed.data.contactId });
    revalidateContact(parsed.data.contactId);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** "Das sind wir" (decisions/0037-correction-buttons.md): the contact is really the
 * workspace's own company under another name (a brand, a short legal form). Admin-only
 * (`PERMISSIONS.companyProfileManage`, not `documentsWrite` like every other action in this
 * file - this changes the shared company profile, a workspace-wide identity decision, the
 * same permission `updateCompanyProfileAction` itself uses). Adds the contact's current name
 * to the company profile's `aliases` (idempotent - a name that is already an alias is a
 * no-op success, so several duplicate contacts sharing one brand name can each be corrected
 * in turn) and only deletes the contact once that succeeds; a rejected alias
 * (`alias_too_generic`, or the 20-entry cap) leaves the contact untouched. */
export async function markContactAsOwnCompanyAction(input: unknown): Promise<ActionResult<undefined, ContactActionErrorCode>> {
  const parsed = markContactAsOwnCompanyInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.companyProfileManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const workspaceId = access.access.workspace.id;
    const contact = await getRequestServices().contacts.getById(workspaceId, parsed.data.contactId);
    await getRequestServices().workspaces.addCompanyAlias({ workspaceId, alias: contact.name });
    await getRequestServices().contacts.deleteContact({ workspaceId, contactId: parsed.data.contactId });
    revalidateContact(parsed.data.contactId);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapCorrectionError(err) };
  }
}

/** "Das ist unsere Bank" (decisions/0037-correction-buttons.md): the contact is really the
 * workspace's own bank (e.g. extracted from a document's own payment-details footer),
 * carrying the workspace's own IBAN. Admin-only, same reasoning as
 * `markContactAsOwnCompanyAction` above. Refuses with `contact_missing_iban` - deleting
 * nothing - when the contact carries no IBAN at all or one that fails the mod-97 format
 * check; the UI additionally never shows this button for such a contact
 * (`ui/contact-detail-client.tsx`), this is the server-side defense-in-depth "never trust
 * the UI" rule (AGENTS.md) applies to every permission check. Otherwise adds the IBAN to the
 * company profile's own `ibans` (idempotent, same as the alias case) and only then deletes
 * the contact. */
export async function markContactAsOwnBankAction(input: unknown): Promise<ActionResult<undefined, ContactActionErrorCode>> {
  const parsed = markContactAsOwnBankInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(PERMISSIONS.companyProfileManage);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const workspaceId = access.access.workspace.id;
    const contact = await getRequestServices().contacts.getById(workspaceId, parsed.data.contactId);
    if (!contact.iban?.trim() || !isValidIbanFormat(contact.iban)) {
      return { status: "error", errorCode: "contact_missing_iban" };
    }
    await getRequestServices().workspaces.addCompanyIban({ workspaceId, iban: contact.iban });
    await getRequestServices().contacts.deleteContact({ workspaceId, contactId: parsed.data.contactId });
    revalidateContact(parsed.data.contactId);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapCorrectionError(err) };
  }
}

/** "Zusammenführen": moves every document link/proposal from `sourceId` to `targetId`,
 * fills `targetId`'s empty fields from `sourceId`, then deletes `sourceId`. */
export async function mergeContactsAction(input: unknown): Promise<ActionResult<{ id: string }, ContactActionErrorCode>> {
  const parsed = mergeContactsInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    const merged = await getRequestServices().contacts.mergeContacts({
      workspaceId: access.access.workspace.id,
      sourceId: parsed.data.sourceId,
      targetId: parsed.data.targetId,
    });
    revalidatePath("/dashboard/contacts");
    revalidatePath(`/dashboard/contacts/${parsed.data.sourceId}`);
    revalidatePath(`/dashboard/contacts/${merged.id}`);
    return { status: "success", data: { id: merged.id } };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Applies the proposed value and re-verifies the contact (`acceptProposal`'s own rule). */
export async function acceptProposalAction(input: unknown): Promise<ActionResult<undefined, ContactActionErrorCode>> {
  const parsed = acceptProposalInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().contacts.acceptProposal({
      workspaceId: access.access.workspace.id,
      proposalId: parsed.data.proposalId,
      decidedByUserId: access.access.user.id,
    });
    revalidatePath("/dashboard/contacts");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Rejects a proposal - never touches the contact's own fields or verification state. */
export async function rejectProposalAction(input: unknown): Promise<ActionResult<undefined, ContactActionErrorCode>> {
  const parsed = rejectProposalInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().contacts.rejectProposal({
      workspaceId: access.access.workspace.id,
      proposalId: parsed.data.proposalId,
      decidedByUserId: access.access.user.id,
    });
    revalidatePath("/dashboard/contacts");
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}

/** Unlinks a document from a contact (the document itself is untouched) - also revalidates
 * the document's own detail page, since it shows its linked contacts too. */
export async function unlinkDocumentAction(input: unknown): Promise<ActionResult<undefined, ContactActionErrorCode>> {
  const parsed = unlinkDocumentInputSchema.safeParse(input);
  if (!parsed.success) return { status: "error", errorCode: "invalid_input" };

  const access = await requirePermission(CONTACTS_PERMISSION);
  if (access.status === "error") return { status: "error", errorCode: access.errorCode };

  try {
    await getRequestServices().contacts.unlinkDocument({
      workspaceId: access.access.workspace.id,
      documentId: parsed.data.documentId,
      contactId: parsed.data.contactId,
      role: parsed.data.role,
    });
    revalidatePath(`/dashboard/contacts/${parsed.data.contactId}`);
    revalidatePath(`/dashboard/documents/${parsed.data.documentId}`);
    return { status: "success", data: undefined };
  } catch (err) {
    return { status: "error", errorCode: mapUseCaseError(err) };
  }
}
