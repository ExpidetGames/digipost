// @vitest-environment jsdom
// No `@testing-library/jest-dom` in this repository's dependencies - presence/absence is
// asserted via `getByText`/`queryByText`/`getByRole` rather than `.toBeInTheDocument()`
// (`src/app/(marketing)/_components/tests/faq-accordion.test.tsx`'s established pattern).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const acceptMock = vi.fn();
const rejectMock = vi.fn();
vi.mock("../actions", () => ({
  acceptProposalAction: (input: unknown) => acceptMock(input),
  rejectProposalAction: (input: unknown) => rejectMock(input),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { ProposalList } from "../ui/proposal-list";
import type { ContactProposalView } from "../core/view-types";

const messages = {
  Contacts: {
    detail: {
      proposalIbanWarning:
        "Die Bankverbindung hat sich in einem Dokument geändert. Prüfen Sie diesen Änderungsvorschlag sorgfältig, bevor Sie ihn annehmen.",
      proposalCurrent: "Bisheriger Wert",
      proposalProposed: "Vorgeschlagener Wert",
      proposalAccept: "Annehmen",
      proposalReject: "Ablehnen",
      errors: {
        unknown: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.",
      },
    },
    fieldLabels: {
      iban: "IBAN",
      phone: "Telefon",
    },
  },
};

function renderList(proposals: ContactProposalView[]) {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <ProposalList proposals={proposals} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  acceptMock.mockReset();
  rejectMock.mockReset();
  refreshMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProposalList", () => {
  it("shows the IBAN warning callout only for an iban field proposal", () => {
    renderList([
      { id: "p1", field: "iban", currentValue: "DE00...OLD", proposedValue: "DE00...NEW", createdAt: new Date().toISOString() },
      { id: "p2", field: "phone", currentValue: "030 1", proposedValue: "030 2", createdAt: new Date().toISOString() },
    ]);

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain("Bankverbindung");
  });

  it("shows current vs proposed values", () => {
    renderList([{ id: "p1", field: "phone", currentValue: "030 1", proposedValue: "030 2", createdAt: new Date().toISOString() }]);

    expect(screen.getByText("030 1")).toBeTruthy();
    expect(screen.getByText("030 2")).toBeTruthy();
  });

  it("accepts a proposal and refreshes", async () => {
    acceptMock.mockResolvedValue({ status: "success", data: undefined });
    renderList([{ id: "p1", field: "phone", currentValue: "030 1", proposedValue: "030 2", createdAt: new Date().toISOString() }]);

    fireEvent.click(screen.getByRole("button", { name: "Annehmen" }));

    await waitFor(() => expect(acceptMock).toHaveBeenCalledWith({ proposalId: "p1" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("rejects a proposal and shows the mapped error on failure", async () => {
    rejectMock.mockResolvedValue({ status: "error", errorCode: "unknown" });
    renderList([{ id: "p1", field: "phone", currentValue: "030 1", proposedValue: "030 2", createdAt: new Date().toISOString() }]);

    fireEvent.click(screen.getByRole("button", { name: "Ablehnen" }));

    await screen.findByText("Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.");
  });

  it("renders nothing when there are no pending proposals", () => {
    const { container } = renderList([]);
    expect(container.innerHTML).toBe("");
  });
});
