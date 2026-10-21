"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { updateCompanyProfileAction } from "../actions";
import type { CompanyProfileActionErrorCode } from "../core/error-codes";
import type { CompanyProfileView } from "../core/types";

/** Turns one line per entry (a textarea's raw value) into a plain string array - blank lines
 * are kept (the use case drops them, `normalizeCompanyAliases`/the IBAN/domain normalizers),
 * so nothing here needs to filter anything out before submitting. */
function linesToList(value: string): string[] {
  return value.split("\n");
}

/**
 * `/dashboard/settings/company`'s ("Firmendaten") edit form (C2,
 * decisions/0021-extraction-direction-and-invoice-fields.md, extended by H1's
 * decisions/0034-extended-company-profile.md with the aliases/IBANs/domains/tax-and-register
 * data/free-text fields) - admin-only, the page seam itself gates access (404 for anyone
 * else, the same pattern every admin-only page in this module follows). Saves instantly on submit
 * (WEBAPP_TEMPLATE_SPEC.md §8's ~100ms feedback rule); the workspace name is shown read-only
 * for context (this form only edits `updateCompanyProfile`'s own fields, never the workspace
 * name itself).
 */
export function CompanyProfileForm({ profile }: { profile: CompanyProfileView }) {
  const t = useTranslations("CompanySettings");
  const [addressLine1, setAddressLine1] = useState(profile.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(profile.addressLine2 ?? "");
  const [postalCode, setPostalCode] = useState(profile.postalCode ?? "");
  const [city, setCity] = useState(profile.city ?? "");
  const [country, setCountry] = useState(profile.country ?? "DE");
  const [vatId, setVatId] = useState(profile.vatId ?? "");
  const [aliasesText, setAliasesText] = useState(profile.aliases.join("\n"));
  const [ibansText, setIbansText] = useState(profile.ibans.join("\n"));
  const [domainsText, setDomainsText] = useState(profile.domains.join("\n"));
  const [taxNumber, setTaxNumber] = useState(profile.taxNumber ?? "");
  const [registerCourt, setRegisterCourt] = useState(profile.registerCourt ?? "");
  const [registerNumber, setRegisterNumber] = useState(profile.registerNumber ?? "");
  const [profileText, setProfileText] = useState(profile.profileText ?? "");
  const [errorCode, setErrorCode] = useState<CompanyProfileActionErrorCode>();
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    setSaved(false);
    startTransition(async () => {
      const result = await updateCompanyProfileAction({
        addressLine1,
        addressLine2,
        postalCode,
        city,
        country,
        vatId,
        aliases: linesToList(aliasesText),
        ibans: linesToList(ibansText),
        domains: linesToList(domainsText),
        taxNumber,
        registerCourt,
        registerNumber,
        profileText,
      });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setSaved(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="company-name">{t("workspaceNameLabel")}</Label>
        <Input id="company-name" value={profile.workspaceName} disabled readOnly />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="company-address-line1">{t("addressLine1Label")}</Label>
        <Input
          id="company-address-line1"
          required
          maxLength={200}
          value={addressLine1}
          onChange={(event) => setAddressLine1(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="company-address-line2">{t("addressLine2Label")}</Label>
        <Input id="company-address-line2" maxLength={200} value={addressLine2} onChange={(event) => setAddressLine2(event.target.value)} />
      </div>
      <div className="flex gap-3">
        <div className="flex w-32 flex-col gap-2">
          <Label htmlFor="company-postal-code">{t("postalCodeLabel")}</Label>
          <Input
            id="company-postal-code"
            required
            maxLength={20}
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="company-city">{t("cityLabel")}</Label>
          <Input id="company-city" required maxLength={120} value={city} onChange={(event) => setCity(event.target.value)} />
        </div>
        <div className="flex w-24 flex-col gap-2">
          <Label htmlFor="company-country">{t("countryLabel")}</Label>
          <Input id="company-country" maxLength={2} value={country} onChange={(event) => setCountry(event.target.value.toUpperCase())} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="company-vat-id">{t("vatIdLabel")}</Label>
        <Input
          id="company-vat-id"
          maxLength={20}
          placeholder={t("vatIdPlaceholder")}
          value={vatId}
          onChange={(event) => setVatId(event.target.value)}
        />
      </div>

      {/* decisions/0034-extended-company-profile.md: the extended profile, settings-only
          (onboarding keeps only the aliases field, kept short on purpose). */}
      <h2 className="mt-2 text-sm font-semibold">{t("extendedHeading")}</h2>
      <p className="text-sm text-muted-foreground">{t("extendedDescription")}</p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="company-aliases">{t("aliasesLabel")}</Label>
        <textarea
          id="company-aliases"
          rows={3}
          placeholder={t("aliasesPlaceholder")}
          value={aliasesText}
          onChange={(event) => setAliasesText(event.target.value)}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-sm text-muted-foreground">{t("aliasesHelp")}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="company-ibans">{t("ibansLabel")}</Label>
        <textarea
          id="company-ibans"
          rows={2}
          placeholder={t("ibansPlaceholder")}
          value={ibansText}
          onChange={(event) => setIbansText(event.target.value)}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-sm text-muted-foreground">{t("ibansHelp")}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="company-domains">{t("domainsLabel")}</Label>
        <textarea
          id="company-domains"
          rows={2}
          placeholder={t("domainsPlaceholder")}
          value={domainsText}
          onChange={(event) => setDomainsText(event.target.value)}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-sm text-muted-foreground">{t("domainsHelp")}</p>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="company-tax-number">{t("taxNumberLabel")}</Label>
          <Input id="company-tax-number" maxLength={30} value={taxNumber} onChange={(event) => setTaxNumber(event.target.value)} />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="company-register-court">{t("registerCourtLabel")}</Label>
          <Input
            id="company-register-court"
            maxLength={120}
            value={registerCourt}
            onChange={(event) => setRegisterCourt(event.target.value)}
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="company-register-number">{t("registerNumberLabel")}</Label>
          <Input
            id="company-register-number"
            maxLength={30}
            value={registerNumber}
            onChange={(event) => setRegisterNumber(event.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="company-profile-text">{t("profileTextLabel")}</Label>
        <textarea
          id="company-profile-text"
          rows={3}
          maxLength={1000}
          placeholder={t("profileTextPlaceholder")}
          value={profileText}
          onChange={(event) => setProfileText(event.target.value)}
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <p className="text-sm text-muted-foreground">{t("profileTextHelp")}</p>
      </div>

      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
      {!errorCode && saved ? <p className="text-sm text-muted-foreground">{t("saved")}</p> : null}
      <Button type="submit" disabled={pending} aria-busy={pending} className="self-start">
        {pending ? t("submitPending") : t("submit")}
      </Button>
    </form>
  );
}
