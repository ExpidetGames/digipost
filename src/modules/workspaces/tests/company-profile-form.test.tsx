// @vitest-environment jsdom
// Client-component unit test (WEBAPP_TEMPLATE_SPEC.md §10.2): Testing Library + jsdom, the
// Server Action mocked at the module path the component actually imports (`../actions`),
// same technique `onboarding-form.test.tsx` already uses. No `@testing-library/jest-dom` in
// this repository's dependencies - see `src/modules/contacts/tests/proposal-list.test.tsx`'s
// header comment for the established alternative (plain DOM property/`toBeTruthy` checks).
// decisions/0034-extended-company-profile.md (H1): covers the new extended-profile fields
// render and submit correctly, and that the generic-alias error surfaces its German copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const updateMock = vi.fn();
vi.mock("../actions", () => ({
  updateCompanyProfileAction: (input: unknown) => updateMock(input),
}));

import { CompanyProfileForm } from "../ui/company-profile-form";
import type { CompanyProfileView } from "../core/types";

const messages = {
  CompanySettings: {
    workspaceNameLabel: "Firmenname",
    addressLine1Label: "Straße und Hausnummer",
    addressLine2Label: "Adresszusatz",
    postalCodeLabel: "PLZ",
    cityLabel: "Ort",
    countryLabel: "Land",
    vatIdLabel: "USt-IdNr.",
    vatIdPlaceholder: "optional",
    extendedHeading: "Erweiterte Angaben",
    extendedDescription: "Hilft der KI, Sie zu erkennen.",
    aliasesLabel: "Weitere Namen",
    aliasesHelp: "Ein Name pro Zeile.",
    aliasesPlaceholder: "z. B. Musterfirma",
    ibansLabel: "Eigene IBANs",
    ibansHelp: "Eine IBAN pro Zeile.",
    ibansPlaceholder: "DE...",
    domainsLabel: "Eigene Domains",
    domainsHelp: "Eine Domain pro Zeile.",
    domainsPlaceholder: "beispiel.de",
    taxNumberLabel: "Steuernummer",
    registerCourtLabel: "Registergericht",
    registerNumberLabel: "Registernummer",
    profileTextLabel: "Was soll die KI wissen?",
    profileTextHelp: "Hilft der KI.",
    profileTextPlaceholder: "z. B. Wir treten als Musterfirma auf.",
    submit: "Speichern",
    submitPending: "Wird gespeichert…",
    saved: "Gespeichert.",
    errors: {
      invalid_input: "Bitte prüfen Sie Ihre Angaben.",
      not_found: "Dieser Arbeitsbereich existiert nicht mehr.",
      alias_too_generic:
        "Dieser Markenname ist zu allgemein (z. B. nur eine Rechtsform wie \"GmbH\") oder zu kurz. Bitte verwenden Sie einen spezifischeren Namen.",
      invalid_iban: "Eine der eingegebenen IBANs ist ungültig.",
      invalid_domain: "Eine der eingegebenen Domains ist ungültig.",
      unauthenticated: "Bitte melden Sie sich erneut an.",
      no_workspace: "Sie gehören zu keinem Arbeitsbereich.",
      forbidden: "Dafür fehlt Ihnen die Berechtigung.",
      unknown: "Etwas ist schiefgelaufen.",
    },
  },
};

const PROFILE: CompanyProfileView = {
  workspaceName: "Muster GmbH",
  addressLine1: "Musterstraße 1",
  addressLine2: null,
  postalCode: "10115",
  city: "Berlin",
  country: "DE",
  vatId: null,
  aliases: ["Musterfirma"],
  ibans: [],
  domains: [],
  taxNumber: null,
  registerCourt: null,
  registerNumber: null,
  profileText: null,
};

function renderForm(profile: CompanyProfileView = PROFILE) {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <CompanyProfileForm profile={profile} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  updateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CompanyProfileForm", () => {
  it("renders the extended profile fields, pre-filled from the profile", () => {
    renderForm();

    expect((screen.getByLabelText("Weitere Namen") as HTMLTextAreaElement).value).toBe("Musterfirma");
    expect(screen.getByLabelText("Eigene IBANs")).toBeTruthy();
    expect(screen.getByLabelText("Eigene Domains")).toBeTruthy();
    expect(screen.getByLabelText("Steuernummer")).toBeTruthy();
    expect(screen.getByLabelText("Registergericht")).toBeTruthy();
    expect(screen.getByLabelText("Registernummer")).toBeTruthy();
    expect(screen.getByLabelText("Was soll die KI wissen?")).toBeTruthy();
  });

  it("submits the extended profile fields as arrays, one entry per line", async () => {
    updateMock.mockResolvedValue({ status: "success", data: undefined });
    renderForm();

    fireEvent.change(screen.getByLabelText("Weitere Namen"), { target: { value: "Musterfirma\nErika Maria Beispiel GbR" } });
    fireEvent.change(screen.getByLabelText("Eigene IBANs"), { target: { value: "DE89370400440532013000" } });
    fireEvent.change(screen.getByLabelText("Eigene Domains"), { target: { value: "musterfirma.de" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Gespeichert.");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: ["Musterfirma", "Erika Maria Beispiel GbR"],
        ibans: ["DE89370400440532013000"],
        domains: ["musterfirma.de"],
      }),
    );
  });

  it("shows the generic-alias error's German copy when the action rejects it", async () => {
    updateMock.mockResolvedValue({ status: "error", errorCode: "alias_too_generic" });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText(
      'Dieser Markenname ist zu allgemein (z. B. nur eine Rechtsform wie "GmbH") oder zu kurz. Bitte verwenden Sie einen spezifischeren Namen.',
    );
  });

  it("shows the invalid-IBAN error's German copy when the action rejects it", async () => {
    updateMock.mockResolvedValue({ status: "error", errorCode: "invalid_iban" });
    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await screen.findByText("Eine der eingegebenen IBANs ist ungültig.");
  });
});
