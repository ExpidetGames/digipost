// @vitest-environment jsdom
// Client-component unit test (WEBAPP_TEMPLATE_SPEC.md §10.2): Testing Library + jsdom, the
// Server Action mocked at the module path the component actually imports (`../actions`),
// same technique the former `projects` example module's `create-project-form.test.tsx` used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const createMock = vi.fn();
vi.mock("../actions", () => ({
  createWorkspaceAction: (input: unknown) => createMock(input),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { OnboardingForm } from "../ui/onboarding-form";

const messages = {
  Onboarding: {
    form: {
      nameLabel: "Firmenname",
      namePlaceholder: "z. B. Muster GmbH",
      addressLine1Label: "Straße und Hausnummer",
      addressLine1Placeholder: "z. B. Musterstraße 1",
      addressLine2Label: "Adresszusatz",
      postalCodeLabel: "PLZ",
      cityLabel: "Ort",
      countryLabel: "Land",
      vatIdLabel: "USt-IdNr.",
      vatIdPlaceholder: "optional",
      aliasesLabel: "Weitere Namen",
      aliasesHelp: "Ein Name pro Zeile.",
      aliasesPlaceholder: "z. B. Musterfirma",
      submit: "Arbeitsbereich anlegen",
      submitPending: "Wird angelegt…",
    },
    errors: {
      invalid_input: "Bitte geben Sie einen Firmennamen ein.",
      already_in_workspace: "Sie gehören bereits zu einem Arbeitsbereich.",
      unknown: "Etwas ist schiefgelaufen.",
    },
  },
};

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("Firmenname"), { target: { value: "Muster GmbH" } });
  fireEvent.change(screen.getByLabelText("Straße und Hausnummer"), { target: { value: "Musterstraße 1" } });
  fireEvent.change(screen.getByLabelText("PLZ"), { target: { value: "10115" } });
  fireEvent.change(screen.getByLabelText("Ort"), { target: { value: "Berlin" } });
}

function renderForm() {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <OnboardingForm />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  createMock.mockReset();
  pushMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("OnboardingForm", () => {
  it("submits the entered name/address and redirects to /dashboard on success", async () => {
    createMock.mockResolvedValue({ status: "success", data: { id: "w1", name: "Muster GmbH" } });
    renderForm();

    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Arbeitsbereich anlegen" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
    expect(createMock).toHaveBeenCalledWith({
      name: "Muster GmbH",
      addressLine1: "Musterstraße 1",
      addressLine2: "",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
      vatId: "",
      // decisions/0034-extended-company-profile.md: an untouched textarea's raw value is the
      // empty string, which `linesToList`-equivalent `split("\n")` turns into `[""]` - the
      // use case's own `normalizeCompanyAliases` drops it, so this is not sent as raw user
      // intent, just this component's un-optimized default.
      aliases: [""],
    });
  });

  it("shows the mapped error message and does not redirect when the action returns an error", async () => {
    createMock.mockResolvedValue({ status: "error", errorCode: "already_in_workspace" });
    renderForm();

    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Arbeitsbereich anlegen" }));

    await screen.findByText("Sie gehören bereits zu einem Arbeitsbereich.");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("disables the submit button while the action is pending", async () => {
    let resolveAction: (value: unknown) => void = () => {};
    createMock.mockReturnValue(new Promise((resolve) => (resolveAction = resolve)));
    renderForm();

    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Arbeitsbereich anlegen" }));

    const pendingButton = await screen.findByRole("button", { name: "Wird angelegt…" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);

    resolveAction({ status: "success", data: { id: "w1", name: "Muster GmbH" } });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
  });
});
