// @vitest-environment jsdom
// No `@testing-library/jest-dom` in this repository's dependencies - see
// `tests/proposal-list.test.tsx`'s header comment for the established alternative.
//
// decisions/0037-correction-buttons.md: "Das sind wir"/"Das ist unsere Bank" are admin-only
// (`canManageCompanyProfile`, backed by `PERMISSIONS.companyProfileManage`) and "Das ist
// unsere Bank" is additionally hidden for a contact with no usable IBAN - both are
// display-only guards, the Server Actions re-check the real permission/IBAN server-side
// (never trust the UI, AGENTS.md), covered separately by `tests/actions.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const deleteMock = vi.fn();
const verifyMock = vi.fn();
const markOwnCompanyMock = vi.fn();
const markOwnBankMock = vi.fn();
vi.mock("../actions", () => ({
  deleteContactAction: (input: unknown) => deleteMock(input),
  verifyContactAction: (input: unknown) => verifyMock(input),
  markContactAsOwnCompanyAction: (input: unknown) => markOwnCompanyMock(input),
  markContactAsOwnBankAction: (input: unknown) => markOwnBankMock(input),
}));

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

import { ContactDetailClient } from "../ui/contact-detail-client";
import type { ContactDetailView } from "../core/view-types";
import { EMPTY_CONTACT_FIELDS } from "../ui/contact-form";

const messages = {
  Contacts: {
    relationTypeValues: {},
    fieldLabels: {},
    detail: {
      unverifiedBadge: "Unbestätigt",
      verifiedAt: "Bestätigt am {date} von {by}",
      neverVerified: "Noch nicht bestätigt.",
      verify: "Bestätigen",
      edit: "Bearbeiten",
      documentsHeading: "Verknüpfte Dokumente",
      documentsEmpty: "Keine verknüpften Dokumente.",
      unlinkDocument: "Entfernen",
      proposalsHeading: "Änderungsvorschläge",
      mergeHeading: "Kontakte zusammenführen",
      merge: "Zusammenführen",
      mergeSearchPlaceholder: "Kontakt suchen…",
      mergeNoResults: "Keine passenden Kontakte gefunden.",
      mergeConfirm: '"{source}" wird mit "{target}" zusammengeführt.',
      mergeConfirmYes: "Ja, zusammenführen",
      cancel: "Abbrechen",
      correctionsHeading: "Korrekturen",
      markOwnCompany: "Das sind wir",
      markOwnCompanyConfirm:
        "Dieser Kontakt ist Ihr eigenes Unternehmen. Der Name wird als weiterer Name Ihres Unternehmens gespeichert und der Kontakt gelöscht. Dokumente bleiben erhalten.",
      markOwnCompanyConfirmYes: "Ja, speichern und löschen",
      markOwnBank: "Das ist unsere Bank",
      markOwnBankConfirm:
        "Dieser Kontakt ist Ihre Bank. Die IBAN wird als Ihr eigenes Konto gespeichert und der Kontakt gelöscht. Dokumente bleiben erhalten.",
      markOwnBankConfirmYes: "Ja, speichern und löschen",
      deleteConfirm: "Diesen Kontakt löschen? Verknüpfte Dokumente bleiben erhalten.",
      deleteConfirmYes: "Ja, löschen",
      delete: "Löschen",
      errors: {
        alias_too_generic: "Dieser Name ist als Markenname zu allgemein oder zu kurz.",
        contact_missing_iban: "Dieser Kontakt hat keine gültige IBAN, die als eigenes Konto gespeichert werden kann.",
        unknown: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.",
      },
    },
  },
};

function buildContact(overrides: Partial<ContactDetailView["fields"]> = {}): ContactDetailView {
  return {
    id: "contact-1",
    fields: { ...EMPTY_CONTACT_FIELDS, name: "Musterfirma", ...overrides },
    verified: true,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verifiedByName: "Admin",
    documents: [],
    pendingProposals: [],
  };
}

function renderDetail(options: { contact?: ContactDetailView; canManageCompanyProfile: boolean }) {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <ContactDetailClient
        contact={options.contact ?? buildContact()}
        mergeOptions={[]}
        canManageCompanyProfile={options.canManageCompanyProfile}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  deleteMock.mockReset();
  verifyMock.mockReset();
  markOwnCompanyMock.mockReset();
  markOwnBankMock.mockReset();
  pushMock.mockReset();
  refreshMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ContactDetailClient - correction buttons (decisions/0037-correction-buttons.md)", () => {
  it("hides both correction buttons for a member (canManageCompanyProfile: false)", () => {
    renderDetail({ contact: buildContact({ iban: "DE89370400440532013000" }), canManageCompanyProfile: false });

    expect(screen.queryByRole("button", { name: "Das sind wir" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Das ist unsere Bank" })).toBeNull();
  });

  it("shows 'Das sind wir' for an admin, with a valid IBAN also showing 'Das ist unsere Bank'", () => {
    renderDetail({ contact: buildContact({ iban: "DE89370400440532013000" }), canManageCompanyProfile: true });

    expect(screen.getByRole("button", { name: "Das sind wir" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Das ist unsere Bank" })).toBeTruthy();
  });

  it("hides 'Das ist unsere Bank' for an admin when the contact has no usable IBAN", () => {
    renderDetail({ contact: buildContact({ iban: "" }), canManageCompanyProfile: true });

    expect(screen.getByRole("button", { name: "Das sind wir" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Das ist unsere Bank" })).toBeNull();
  });

  it("hides 'Das ist unsere Bank' for an admin when the contact's IBAN fails the format check", () => {
    renderDetail({ contact: buildContact({ iban: "DE00000000000000000000" }), canManageCompanyProfile: true });

    expect(screen.queryByRole("button", { name: "Das ist unsere Bank" })).toBeNull();
  });

  it("shows the German confirmation copy for 'Das sind wir' before submitting", () => {
    renderDetail({ contact: buildContact(), canManageCompanyProfile: true });

    fireEvent.click(screen.getByRole("button", { name: "Das sind wir" }));

    expect(
      screen.getByText(
        "Dieser Kontakt ist Ihr eigenes Unternehmen. Der Name wird als weiterer Name Ihres Unternehmens gespeichert und der Kontakt gelöscht. Dokumente bleiben erhalten.",
      ),
    ).toBeTruthy();
    expect(markOwnCompanyMock).not.toHaveBeenCalled();
  });

  it("shows the German confirmation copy for 'Das ist unsere Bank' before submitting", () => {
    renderDetail({ contact: buildContact({ iban: "DE89370400440532013000" }), canManageCompanyProfile: true });

    fireEvent.click(screen.getByRole("button", { name: "Das ist unsere Bank" }));

    expect(
      screen.getByText(
        "Dieser Kontakt ist Ihre Bank. Die IBAN wird als Ihr eigenes Konto gespeichert und der Kontakt gelöscht. Dokumente bleiben erhalten.",
      ),
    ).toBeTruthy();
    expect(markOwnBankMock).not.toHaveBeenCalled();
  });

  it("calls markContactAsOwnCompanyAction and redirects to the list on confirmation", async () => {
    markOwnCompanyMock.mockResolvedValue({ status: "success", data: undefined });
    renderDetail({ contact: buildContact(), canManageCompanyProfile: true });

    fireEvent.click(screen.getByRole("button", { name: "Das sind wir" }));
    fireEvent.click(screen.getByRole("button", { name: "Ja, speichern und löschen" }));

    await waitFor(() => expect(markOwnCompanyMock).toHaveBeenCalledWith({ contactId: "contact-1" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard/contacts"));
  });

  it("shows the mapped error and does not redirect when the alias is rejected", async () => {
    markOwnCompanyMock.mockResolvedValue({ status: "error", errorCode: "alias_too_generic" });
    renderDetail({ contact: buildContact(), canManageCompanyProfile: true });

    fireEvent.click(screen.getByRole("button", { name: "Das sind wir" }));
    fireEvent.click(screen.getByRole("button", { name: "Ja, speichern und löschen" }));

    await screen.findByText("Dieser Name ist als Markenname zu allgemein oder zu kurz.");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("calls markContactAsOwnBankAction and redirects to the list on confirmation", async () => {
    markOwnBankMock.mockResolvedValue({ status: "success", data: undefined });
    renderDetail({ contact: buildContact({ iban: "DE89370400440532013000" }), canManageCompanyProfile: true });

    fireEvent.click(screen.getByRole("button", { name: "Das ist unsere Bank" }));
    fireEvent.click(screen.getByRole("button", { name: "Ja, speichern und löschen" }));

    await waitFor(() => expect(markOwnBankMock).toHaveBeenCalledWith({ contactId: "contact-1" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard/contacts"));
  });
});
