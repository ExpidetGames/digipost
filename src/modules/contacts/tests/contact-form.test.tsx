// @vitest-environment jsdom
// Client-component unit test (WEBAPP_TEMPLATE_SPEC.md §10.2): Testing Library + jsdom, the
// Server Action mocked at the module path the component actually imports (`../actions`),
// mirroring `src/modules/workspaces/tests/onboarding-form.test.tsx`'s established pattern.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const createMock = vi.fn();
const updateMock = vi.fn();
vi.mock("../actions", () => ({
  createContactAction: (input: unknown) => createMock(input),
  updateContactAction: (input: unknown) => updateMock(input),
}));

import { ContactForm, EMPTY_CONTACT_FIELDS } from "../ui/contact-form";

const messages = {
  Contacts: {
    form: {
      sections: {
        identity: "Identität",
        tax: "Steuer und Register",
        bank: "Bank",
        communication: "Kommunikation",
        relationship: "Geschäftsbeziehung",
        notes: "Notizen",
      },
      fields: {
        name: "Name",
        legalForm: "Rechtsform",
        addressLine1: "Adresszeile 1",
        addressLine2: "Adresszeile 2",
        postalCode: "PLZ",
        city: "Ort",
        country: "Land",
        vatId: "USt-IdNr.",
        taxNumber: "Steuernummer",
        registerCourt: "Registergericht",
        registerNumber: "Registernummer",
        leitwegId: "Leitweg-ID",
        iban: "IBAN",
        bic: "BIC",
        bankName: "Bank",
        accountHolder: "Kontoinhaber",
        sepaCreditorId: "SEPA-Gläubiger-ID",
        phone: "Telefon",
        email: "E-Mail",
        website: "Website",
        contactPerson: "Ansprechpartner",
        customerNumber: "Kundennummer",
        supplierNumber: "Lieferantennummer",
        paymentTermsDays: "Zahlungsziel (Tage)",
        relationType: "Beziehungstyp",
        relationTypeNone: "Kein Beziehungstyp",
        notes: "Notizen",
      },
      submitCreate: "Kontakt anlegen",
      submitUpdate: "Speichern",
      submitPending: "Wird gespeichert…",
      cancel: "Abbrechen",
      errors: {
        invalid_input: "Ungültige Eingabe. Bitte prüfen Sie Ihre Angaben.",
        unknown: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.",
      },
    },
    relationTypeValues: {
      supplier: "Lieferant",
      customer: "Kunde",
      authority: "Behörde",
      insurance: "Versicherung",
      bank: "Bank",
      other: "Sonstiges",
    },
  },
};

function renderForm(props: Partial<Parameters<typeof ContactForm>[0]> = {}) {
  const onSuccess = props.onSuccess ?? vi.fn();
  return {
    onSuccess,
    ...render(
      <NextIntlClientProvider locale="de" messages={messages}>
        <ContactForm mode="create" onSuccess={onSuccess} {...props} />
      </NextIntlClientProvider>,
    ),
  };
}

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ContactForm", () => {
  it("requires a name before the browser allows submission", () => {
    renderForm();
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.required).toBe(true);
  });

  it("submits the entered name and calls onSuccess on success", async () => {
    createMock.mockResolvedValue({ status: "success", data: { id: "c1" } });
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Muster GmbH" } });
    fireEvent.click(screen.getByRole("button", { name: "Kontakt anlegen" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("c1"));
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: "Muster GmbH" }));
  });

  it("shows the mapped error message and does not call onSuccess when the action returns an error", async () => {
    createMock.mockResolvedValue({ status: "error", errorCode: "invalid_input" });
    const { onSuccess } = renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Muster GmbH" } });
    fireEvent.click(screen.getByRole("button", { name: "Kontakt anlegen" }));

    await screen.findByText("Ungültige Eingabe. Bitte prüfen Sie Ihre Angaben.");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("drops an empty paymentTermsDays/relationType rather than sending an empty string", async () => {
    createMock.mockResolvedValue({ status: "success", data: { id: "c1" } });
    renderForm();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Muster GmbH" } });
    fireEvent.click(screen.getByRole("button", { name: "Kontakt anlegen" }));

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const payload = createMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("paymentTermsDays");
    expect(payload).not.toHaveProperty("relationType");
  });

  it("edit mode prefills values and calls updateContactAction with the contactId", async () => {
    updateMock.mockResolvedValue({ status: "success", data: { id: "c1" } });
    const onSuccess = vi.fn();
    renderForm({
      mode: "edit",
      contactId: "c1",
      initialValues: { ...EMPTY_CONTACT_FIELDS, name: "Bestehender Kontakt" },
      onSuccess,
    });

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Bestehender Kontakt");

    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("c1"));
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ contactId: "c1", name: "Bestehender Kontakt" }));
  });
});
