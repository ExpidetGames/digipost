"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { createContactAction, updateContactAction } from "../actions";
import { CONTACT_RELATION_TYPES } from "../core/types";
import type { ContactActionErrorCode } from "../core/error-codes";
import type { ContactFieldsView } from "../core/view-types";

const SELECT_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

export const EMPTY_CONTACT_FIELDS: ContactFieldsView = {
  name: "",
  legalForm: "",
  addressLine1: "",
  addressLine2: "",
  postalCode: "",
  city: "",
  country: "DE",
  vatId: "",
  taxNumber: "",
  registerCourt: "",
  registerNumber: "",
  leitwegId: "",
  iban: "",
  bic: "",
  bankName: "",
  accountHolder: "",
  sepaCreditorId: "",
  phone: "",
  email: "",
  website: "",
  contactPerson: "",
  customerNumber: "",
  supplierNumber: "",
  paymentTermsDays: "",
  relationType: "",
  notes: "",
};

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-semibold text-foreground">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  required,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  maxLength?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * The manual create/edit form (scope item 1: "Kontakt anlegen", scope item 2's inline edit).
 * Only `name` is required, matching `manualContactCreateSchema`/`manualContactUpdateSchema`
 * (`@/modules/contacts`) - grouped into the same sections both routes' scope calls for:
 * Identität, Steuer und Register, Bank, Kommunikation, Geschäftsbeziehung, Notizen. A manual
 * save always counts as verification (`createManual`/`updateManual`'s own rule,
 * decisions/0019-contacts.md).
 */
export function ContactForm({
  mode,
  contactId,
  initialValues,
  onCancel,
  onSuccess,
}: {
  mode: "create" | "edit";
  contactId?: string;
  initialValues?: ContactFieldsView;
  onCancel?: () => void;
  onSuccess: (id: string) => void;
}) {
  const t = useTranslations("Contacts.form");
  const tRelation = useTranslations("Contacts.relationTypeValues");
  const [values, setValues] = useState<ContactFieldsView>(initialValues ?? EMPTY_CONTACT_FIELDS);
  const [errorCode, setErrorCode] = useState<ContactActionErrorCode>();
  const [pending, startTransition] = useTransition();
  const submitLabel = mode === "create" ? t("submitCreate") : t("submitUpdate");

  function set<K extends keyof ContactFieldsView>(key: K) {
    return (value: ContactFieldsView[K]) => setValues((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    startTransition(async () => {
      const payload: Record<string, unknown> = { ...values };
      if (!values.paymentTermsDays) delete payload.paymentTermsDays;
      if (!values.relationType) delete payload.relationType;

      const result =
        mode === "create" ? await createContactAction(payload) : await updateContactAction({ ...payload, contactId });

      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      onSuccess(result.data.id);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormSection title={t("sections.identity")}>
        <Field id="contact-name" label={t("fields.name")} value={values.name} onChange={set("name")} required maxLength={200} />
        <Field id="contact-legalForm" label={t("fields.legalForm")} value={values.legalForm} onChange={set("legalForm")} maxLength={60} />
        <Field
          id="contact-addressLine1"
          label={t("fields.addressLine1")}
          value={values.addressLine1}
          onChange={set("addressLine1")}
          maxLength={200}
        />
        <Field
          id="contact-addressLine2"
          label={t("fields.addressLine2")}
          value={values.addressLine2}
          onChange={set("addressLine2")}
          maxLength={200}
        />
        <Field id="contact-postalCode" label={t("fields.postalCode")} value={values.postalCode} onChange={set("postalCode")} maxLength={20} />
        <Field id="contact-city" label={t("fields.city")} value={values.city} onChange={set("city")} maxLength={120} />
        <Field id="contact-country" label={t("fields.country")} value={values.country} onChange={set("country")} maxLength={2} />
      </FormSection>

      <FormSection title={t("sections.tax")}>
        <Field id="contact-vatId" label={t("fields.vatId")} value={values.vatId} onChange={set("vatId")} maxLength={20} />
        <Field id="contact-taxNumber" label={t("fields.taxNumber")} value={values.taxNumber} onChange={set("taxNumber")} maxLength={30} />
        <Field
          id="contact-registerCourt"
          label={t("fields.registerCourt")}
          value={values.registerCourt}
          onChange={set("registerCourt")}
          maxLength={120}
        />
        <Field
          id="contact-registerNumber"
          label={t("fields.registerNumber")}
          value={values.registerNumber}
          onChange={set("registerNumber")}
          maxLength={30}
        />
        <Field id="contact-leitwegId" label={t("fields.leitwegId")} value={values.leitwegId} onChange={set("leitwegId")} maxLength={60} />
      </FormSection>

      <FormSection title={t("sections.bank")}>
        <Field id="contact-iban" label={t("fields.iban")} value={values.iban} onChange={set("iban")} maxLength={34} />
        <Field id="contact-bic" label={t("fields.bic")} value={values.bic} onChange={set("bic")} maxLength={11} />
        <Field id="contact-bankName" label={t("fields.bankName")} value={values.bankName} onChange={set("bankName")} maxLength={120} />
        <Field
          id="contact-accountHolder"
          label={t("fields.accountHolder")}
          value={values.accountHolder}
          onChange={set("accountHolder")}
          maxLength={200}
        />
        <Field
          id="contact-sepaCreditorId"
          label={t("fields.sepaCreditorId")}
          value={values.sepaCreditorId}
          onChange={set("sepaCreditorId")}
          maxLength={35}
        />
      </FormSection>

      <FormSection title={t("sections.communication")}>
        <Field id="contact-phone" label={t("fields.phone")} value={values.phone} onChange={set("phone")} maxLength={40} />
        <Field id="contact-email" label={t("fields.email")} value={values.email} onChange={set("email")} type="email" maxLength={320} />
        <Field id="contact-website" label={t("fields.website")} value={values.website} onChange={set("website")} maxLength={200} />
        <Field
          id="contact-contactPerson"
          label={t("fields.contactPerson")}
          value={values.contactPerson}
          onChange={set("contactPerson")}
          maxLength={120}
        />
      </FormSection>

      <FormSection title={t("sections.relationship")}>
        <Field
          id="contact-customerNumber"
          label={t("fields.customerNumber")}
          value={values.customerNumber}
          onChange={set("customerNumber")}
          maxLength={60}
        />
        <Field
          id="contact-supplierNumber"
          label={t("fields.supplierNumber")}
          value={values.supplierNumber}
          onChange={set("supplierNumber")}
          maxLength={60}
        />
        <Field
          id="contact-paymentTermsDays"
          label={t("fields.paymentTermsDays")}
          value={values.paymentTermsDays}
          onChange={set("paymentTermsDays")}
          type="number"
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="contact-relationType">{t("fields.relationType")}</Label>
          <select
            id="contact-relationType"
            className={SELECT_CLASSES}
            value={values.relationType}
            onChange={(event) => set("relationType")(event.target.value as ContactFieldsView["relationType"])}
          >
            <option value="">{t("fields.relationTypeNone")}</option>
            {CONTACT_RELATION_TYPES.map((type) => (
              <option key={type} value={type}>
                {tRelation(type)}
              </option>
            ))}
          </select>
        </div>
      </FormSection>

      <FormSection title={t("sections.notes")}>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="contact-notes">{t("fields.notes")}</Label>
          <textarea
            id="contact-notes"
            className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            value={values.notes}
            maxLength={2000}
            onChange={(event) => set("notes")(event.target.value)}
          />
        </div>
      </FormSection>

      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? t("submitPending") : submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
