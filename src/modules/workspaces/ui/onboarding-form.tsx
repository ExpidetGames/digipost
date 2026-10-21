"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { createWorkspaceAction } from "../actions";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

/** The `/onboarding` form: a signed-in user without a workspace enters a company name and
 * becomes its admin, then lands on `/dashboard` (WEBAPP_TEMPLATE_SPEC.md §14 "Mandanten").
 * `router.push` (not a Server Action `redirect()`, WEBAPP_TEMPLATE_SPEC.md §8 "Server
 * Actions werfen nur für redirect/notFound; alles andere ist ein ActionResult") runs only
 * after the action's own `ActionResult` reports success. */
/** C2 (decisions/0021-extraction-direction-and-invoice-fields.md): onboarding also collects
 * the new workspace's company address (line 1 required, line 2 optional, postal code and city
 * required, country defaulting to "DE") and an optional VAT id - stored via C1's
 * `updateCompanyProfile`, right after workspace creation, in the same `createWorkspaceAction`
 * call. This is why Digipost can later tell "das sind wir" apart from a real business partner
 * when it extracts parties from a scanned document (`isOwnCompany`,
 * decisions/0019-contacts.md). H1 (decisions/0034-extended-company-profile.md) additionally
 * collects an optional list of brand names/short forms ("aliases") here - onboarding
 * deliberately stays short, so the rest of the extended profile (IBANs, domains, tax/register
 * data, free text) lives in `/dashboard/settings/company`'s `CompanyProfileForm` only. */
export function OnboardingForm() {
  const t = useTranslations("Onboarding");
  const router = useRouter();
  const [name, setName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("DE");
  const [vatId, setVatId] = useState("");
  const [aliasesText, setAliasesText] = useState("");
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await createWorkspaceAction({
        name,
        addressLine1,
        addressLine2,
        postalCode,
        city,
        country,
        vatId,
        // decisions/0034-extended-company-profile.md: one alias per line, blank lines are
        // dropped by `updateCompanyProfile`'s own normalization.
        aliases: aliasesText.split("\n"),
      });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.push("/dashboard");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-name">{t("form.nameLabel")}</Label>
        <Input
          id="workspace-name"
          name="name"
          required
          maxLength={120}
          autoFocus
          placeholder={t("form.namePlaceholder")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={errorCode ? true : undefined}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-address-line1">{t("form.addressLine1Label")}</Label>
        <Input
          id="workspace-address-line1"
          name="addressLine1"
          required
          maxLength={200}
          placeholder={t("form.addressLine1Placeholder")}
          value={addressLine1}
          onChange={(event) => setAddressLine1(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-address-line2">{t("form.addressLine2Label")}</Label>
        <Input
          id="workspace-address-line2"
          name="addressLine2"
          maxLength={200}
          value={addressLine2}
          onChange={(event) => setAddressLine2(event.target.value)}
        />
      </div>
      <div className="flex gap-3">
        <div className="flex w-32 flex-col gap-2">
          <Label htmlFor="workspace-postal-code">{t("form.postalCodeLabel")}</Label>
          <Input
            id="workspace-postal-code"
            name="postalCode"
            required
            maxLength={20}
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="workspace-city">{t("form.cityLabel")}</Label>
          <Input id="workspace-city" name="city" required maxLength={120} value={city} onChange={(event) => setCity(event.target.value)} />
        </div>
        <div className="flex w-24 flex-col gap-2">
          <Label htmlFor="workspace-country">{t("form.countryLabel")}</Label>
          <Input
            id="workspace-country"
            name="country"
            maxLength={2}
            value={country}
            onChange={(event) => setCountry(event.target.value.toUpperCase())}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-vat-id">{t("form.vatIdLabel")}</Label>
        <Input
          id="workspace-vat-id"
          name="vatId"
          maxLength={20}
          placeholder={t("form.vatIdPlaceholder")}
          value={vatId}
          onChange={(event) => setVatId(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-aliases">{t("form.aliasesLabel")}</Label>
        <textarea
          id="workspace-aliases"
          name="aliases"
          rows={2}
          placeholder={t("form.aliasesPlaceholder")}
          value={aliasesText}
          onChange={(event) => setAliasesText(event.target.value)}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-sm text-muted-foreground">{t("form.aliasesHelp")}</p>
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? t("form.submitPending") : t("form.submit")}
      </Button>
    </form>
  );
}
