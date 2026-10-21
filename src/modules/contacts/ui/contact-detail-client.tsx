"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { deleteContactAction, markContactAsOwnBankAction, markContactAsOwnCompanyAction, verifyContactAction } from "../actions";
import { isValidIbanFormat } from "../core/format-checks";
import type { ContactActionErrorCode } from "../core/error-codes";
import type { ContactDetailView, ContactMergeOption } from "../core/view-types";
import { ContactForm } from "./contact-form";
import { LinkedDocumentsList } from "./linked-documents-list";
import { MergeContactSection } from "./merge-contact-section";
import { ProposalList } from "./proposal-list";

const FIELD_ORDER: Array<keyof ContactDetailView["fields"]> = [
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
  "relationType",
  "notes",
];

/**
 * `/dashboard/contacts/[id]` (scope item 2): all fields grouped (view mode below, the same
 * grouped `ContactForm` in edit mode), verification state with who/when and a "Bestätigen"
 * button, linked documents, pending proposals, "Zusammenführen", and "Löschen" with
 * confirmation.
 */
export function ContactDetailClient({
  contact,
  mergeOptions,
  canManageCompanyProfile,
}: {
  contact: ContactDetailView;
  mergeOptions: ContactMergeOption[];
  /** decisions/0037-correction-buttons.md: whether the signed-in user holds
   * `PERMISSIONS.companyProfileManage` - gates "Das sind wir"/"Das ist unsere Bank", which
   * change the shared company profile (a workspace-wide identity decision), unlike every
   * other action on this page (verify/edit/delete/merge), which every member can do. A member
   * never sees these two buttons at all; `markContactAsOwnCompanyAction`/
   * `markContactAsOwnBankAction` re-check the same permission server-side regardless (never
   * trust the UI, AGENTS.md). */
  canManageCompanyProfile: boolean;
}) {
  const t = useTranslations("Contacts.detail");
  const tRelation = useTranslations("Contacts.relationTypeValues");
  const tFields = useTranslations("Contacts.fieldLabels");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingOwnCompany, setConfirmingOwnCompany] = useState(false);
  const [confirmingOwnBank, setConfirmingOwnBank] = useState(false);
  const [verifyError, setVerifyError] = useState<ContactActionErrorCode>();
  const [deleteError, setDeleteError] = useState<ContactActionErrorCode>();
  const [ownCompanyError, setOwnCompanyError] = useState<ContactActionErrorCode>();
  const [ownBankError, setOwnBankError] = useState<ContactActionErrorCode>();
  const [verifyPending, startVerifyTransition] = useTransition();
  const [deletePending, startDeleteTransition] = useTransition();
  const [ownCompanyPending, startOwnCompanyTransition] = useTransition();
  const [ownBankPending, startOwnBankTransition] = useTransition();

  // A fixed time zone: the server (UTC) and the browser must render the same time, or React
  // reports a hydration mismatch. The product is DACH-only (decisions/0013).
  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });
  // decisions/0037-correction-buttons.md rule 3: "Das ist unsere Bank" is hidden entirely for
  // a contact with no usable IBAN (none extracted, or one that fails the mod-97 format
  // check) rather than shown and then failing on click - `markContactAsOwnBankAction` still
  // re-checks this server-side (`contact_missing_iban`) as defense in depth, since a client
  // is never trusted alone.
  const hasUsableIban = Boolean(contact.fields.iban && isValidIbanFormat(contact.fields.iban));

  function handleVerify() {
    setVerifyError(undefined);
    startVerifyTransition(async () => {
      const result = await verifyContactAction({ contactId: contact.id });
      if (result.status === "error") {
        setVerifyError(result.errorCode);
        return;
      }
      router.refresh();
    });
  }

  function handleDelete() {
    setDeleteError(undefined);
    startDeleteTransition(async () => {
      const result = await deleteContactAction({ contactId: contact.id });
      if (result.status === "error") {
        setDeleteError(result.errorCode);
        setConfirmingDelete(false);
        return;
      }
      router.push("/dashboard/contacts");
    });
  }

  function handleMarkOwnCompany() {
    setOwnCompanyError(undefined);
    startOwnCompanyTransition(async () => {
      const result = await markContactAsOwnCompanyAction({ contactId: contact.id });
      if (result.status === "error") {
        setOwnCompanyError(result.errorCode);
        setConfirmingOwnCompany(false);
        return;
      }
      router.push("/dashboard/contacts");
    });
  }

  function handleMarkOwnBank() {
    setOwnBankError(undefined);
    startOwnBankTransition(async () => {
      const result = await markContactAsOwnBankAction({ contactId: contact.id });
      if (result.status === "error") {
        setOwnBankError(result.errorCode);
        setConfirmingOwnBank(false);
        return;
      }
      router.push("/dashboard/contacts");
    });
  }

  function fieldDisplayValue(field: keyof ContactDetailView["fields"]): string | null {
    const value = contact.fields[field];
    if (!value) return null;
    if (field === "relationType") return tRelation(value);
    return value;
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-foreground">{contact.fields.name}</h1>
        <ContactForm
          mode="edit"
          contactId={contact.id}
          initialValues={contact.fields}
          onCancel={() => setEditing(false)}
          onSuccess={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-foreground">{contact.fields.name}</h1>
            {!contact.verified ? (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {t("unverifiedBadge")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {contact.verified
              ? t("verifiedAt", { date: contact.verifiedAt ? dateFormatter.format(new Date(contact.verifiedAt)) : "", by: contact.verifiedByName ?? "" })
              : t("neverVerified")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!contact.verified ? (
            <Button type="button" size="sm" disabled={verifyPending} aria-busy={verifyPending} onClick={handleVerify}>
              {t("verify")}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t("edit")}
          </Button>
        </div>
      </div>
      {verifyError ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${verifyError}`)}
        </p>
      ) : null}

      <section className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {FIELD_ORDER.map((field) => {
          const value = fieldDisplayValue(field);
          if (!value) return null;
          return (
            <div key={field} className="flex justify-between gap-2 border-b border-border py-1.5 text-sm">
              <dt className="text-muted-foreground">{tFields(field)}</dt>
              <dd className="text-right text-foreground">{value}</dd>
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("documentsHeading")}</h2>
        <LinkedDocumentsList contactId={contact.id} documents={contact.documents} />
      </section>

      {contact.pendingProposals.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t("proposalsHeading")}</h2>
          <ProposalList proposals={contact.pendingProposals} />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("mergeHeading")}</h2>
        <MergeContactSection sourceId={contact.id} sourceName={contact.fields.name} options={mergeOptions} />
      </section>

      {canManageCompanyProfile ? (
        <section className="flex flex-col gap-3 border-t border-border pt-4">
          <h2 className="text-sm font-semibold text-foreground">{t("correctionsHeading")}</h2>

          <div className="flex flex-col gap-2">
            {confirmingOwnCompany ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">{t("markOwnCompanyConfirm")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={ownCompanyPending}
                  aria-busy={ownCompanyPending}
                  onClick={handleMarkOwnCompany}
                >
                  {t("markOwnCompanyConfirmYes")}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={ownCompanyPending} onClick={() => setConfirmingOwnCompany(false)}>
                  {t("cancel")}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setConfirmingOwnCompany(true)}>
                {t("markOwnCompany")}
              </Button>
            )}
            {ownCompanyError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${ownCompanyError}`)}
              </p>
            ) : null}
          </div>

          {hasUsableIban ? (
            <div className="flex flex-col gap-2">
              {confirmingOwnBank ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">{t("markOwnBankConfirm")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={ownBankPending}
                    aria-busy={ownBankPending}
                    onClick={handleMarkOwnBank}
                  >
                    {t("markOwnBankConfirmYes")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={ownBankPending} onClick={() => setConfirmingOwnBank(false)}>
                    {t("cancel")}
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setConfirmingOwnBank(true)}>
                  {t("markOwnBank")}
                </Button>
              )}
              {ownBankError ? (
                <p role="alert" className="text-sm text-destructive">
                  {t(`errors.${ownBankError}`)}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        {confirmingDelete ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("deleteConfirm")}</span>
            <Button type="button" variant="destructive" size="sm" disabled={deletePending} aria-busy={deletePending} onClick={handleDelete}>
              {t("deleteConfirmYes")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={deletePending} onClick={() => setConfirmingDelete(false)}>
              {t("cancel")}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
            {t("delete")}
          </Button>
        )}
        {deleteError ? (
          <p role="alert" className="text-sm text-destructive">
            {t(`errors.${deleteError}`)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
