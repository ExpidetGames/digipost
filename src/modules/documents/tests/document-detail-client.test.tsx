// @vitest-environment jsdom
// H2-wave2.md's self-counterparty check, "make it visible" requirement
// (decisions/0036-guided-extraction.md's wave 2): the unclear-direction hint on the document
// detail page. Testing Library + jsdom, actions mocked (WEBAPP_TEMPLATE_SPEC.md §10.2) - the
// real `de.json` messages are used directly (rather than a hand-rolled subset) since this
// component reads several namespaces (`DocumentDetail`/`DocumentKinds`/`SettlementPlatforms`)
// and a hand-rolled fixture risks silently drifting from the real catalog.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import de from "@/i18n/messages/de.json";

const reclassifyDocumentActionMock = vi.fn();
vi.mock("../actions", () => ({
  deleteDocumentAction: vi.fn(),
  retryProcessingAction: vi.fn(),
  reclassifyDocumentAction: (input: unknown) => reclassifyDocumentActionMock(input),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { DocumentDetailClient } from "../ui/document-detail-client";
import type { DocumentDetailView } from "../core/types";

function baseDocument(overrides: Partial<DocumentDetailView>): DocumentDetailView {
  return {
    id: "doc-1",
    title: "Rechnung",
    originalFileName: "rechnung.pdf",
    mimeType: "application/pdf",
    sender: "Lieferant GmbH",
    documentDate: "2026-04-01",
    createdAt: "2026-04-01T10:00:00.000Z",
    uploadedByEmail: null,
    status: "done",
    errorCode: null,
    ocrText: "Rechnungstext",
    summary: null,
    direction: null,
    invoiceNumber: null,
    totalAmountCents: null,
    currency: null,
    dueDate: null,
    paymentIban: null,
    paymentReference: null,
    paidNote: null,
    contacts: [],
    kind: "letter",
    platform: null,
    intakeStatus: "confirmed",
    intakeResult: null,
    possibleDuplicateOf: null,
    paymentStatus: "not_applicable",
    paidAt: null,
    ...overrides,
  };
}

function renderDetail(document: DocumentDetailView) {
  return render(
    <NextIntlClientProvider locale="de" messages={de}>
      <DocumentDetailClient document={document} isFakeAiProvider={false} kickAction={vi.fn()} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  reclassifyDocumentActionMock.mockReset();
});

describe("DocumentDetailClient's unclear-direction hint", () => {
  it("renders the hint for a derived-mode kind whose direction is unknown (the self-counterparty guard fired)", () => {
    renderDetail(baseDocument({ kind: "outgoing_invoice", direction: "unknown" }));
    const hint = screen.getByText(/Die Richtung dieses Dokuments konnte nicht sicher bestimmt werden/);
    expect(hint.getAttribute("role")).toBe("alert");
  });

  it("does not render the hint when direction resolved normally for a derived-mode kind", () => {
    renderDetail(baseDocument({ kind: "outgoing_invoice", direction: "outgoing" }));
    expect(screen.queryByText(/Die Richtung dieses Dokuments konnte nicht sicher bestimmt werden/)).toBeNull();
  });

  it("does not render the hint for an open-mode kind even when direction is unknown (not a self-counterparty situation)", () => {
    renderDetail(baseDocument({ kind: "letter", direction: "unknown" }));
    expect(screen.queryByText(/Die Richtung dieses Dokuments konnte nicht sicher bestimmt werden/)).toBeNull();
  });

  it("does not render the hint before processing has run (direction still null)", () => {
    renderDetail(baseDocument({ kind: "incoming_invoice", direction: null, status: "processing" }));
    expect(screen.queryByText(/Die Richtung dieses Dokuments konnte nicht sicher bestimmt werden/)).toBeNull();
  });
});

// decisions/0072-correcting-a-document-s-kind.md: "Dokumentart ändern".
describe("DocumentDetailClient's kind correction control", () => {
  it("is offered for a processed PDF", () => {
    renderDetail(baseDocument({ kind: "other", status: "done" }));
    expect(screen.getByRole("button", { name: "Dokumentart ändern" })).toBeTruthy();
  });

  it("is not offered while the document is still processing", () => {
    renderDetail(baseDocument({ kind: "other", status: "processing" }));
    expect(screen.queryByRole("button", { name: "Dokumentart ändern" })).toBeNull();
  });

  it("is not offered for a structured upload (its kind comes from its own intake flow)", () => {
    renderDetail(baseDocument({ kind: "bank_statement", status: "done", mimeType: "application/xml" }));
    expect(screen.queryByRole("button", { name: "Dokumentart ändern" })).toBeNull();
  });

  it("offers only the PDF-selectable kinds, explains the re-analysis, and keeps confirm disabled for the current kind", () => {
    renderDetail(baseDocument({ kind: "other", status: "done" }));
    fireEvent.click(screen.getByRole("button", { name: "Dokumentart ändern" }));

    const select = screen.getByLabelText("Neue Dokumentart") as HTMLSelectElement;
    const labels = [...select.options].map((option) => option.textContent);
    expect(labels).toContain("Eingangsrechnung");
    expect(labels).not.toContain("Kontoauszug");
    expect(labels).not.toContain("Auszahlungsbericht");
    expect(labels).not.toContain("Plattformabrechnung");
    expect(screen.getByText("Das Dokument wird mit dieser Dokumentart neu ausgewertet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Neu auswerten" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("submits the chosen kind and shows a translated error code", async () => {
    reclassifyDocumentActionMock.mockResolvedValue({ status: "error", errorCode: "payment_linked" });
    renderDetail(baseDocument({ id: "doc-9", kind: "other", status: "done" }));
    fireEvent.click(screen.getByRole("button", { name: "Dokumentart ändern" }));
    fireEvent.change(screen.getByLabelText("Neue Dokumentart"), { target: { value: "incoming_invoice" } });
    fireEvent.click(screen.getByRole("button", { name: "Neu auswerten" }));

    await waitFor(() => expect(screen.getByText(/Bitte heben Sie zuerst die Zahlungszuordnung auf/)).toBeTruthy());
    expect(reclassifyDocumentActionMock).toHaveBeenCalledWith({ documentId: "doc-9", kind: "incoming_invoice" });
  });
});
