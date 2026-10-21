// @vitest-environment jsdom
// No `@testing-library/jest-dom` in this repository's dependencies - see
// `tests/proposal-list.test.tsx`'s header comment for the established alternative.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const mergeMock = vi.fn();
vi.mock("../actions", () => ({
  mergeContactsAction: (input: unknown) => mergeMock(input),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { MergeContactSection } from "../ui/merge-contact-section";

const messages = {
  Contacts: {
    detail: {
      merge: "Zusammenführen",
      mergeSearchPlaceholder: "Kontakt suchen…",
      mergeNoResults: "Keine passenden Kontakte gefunden.",
      mergeConfirm:
        '"{source}" wird mit "{target}" zusammengeführt: Alle verknüpften Dokumente und offenen Änderungsvorschläge werden zu "{target}" verschoben, leere Felder von "{target}" werden aus "{source}" übernommen. "{source}" wird anschließend gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.',
      mergeConfirmYes: "Ja, zusammenführen",
      cancel: "Abbrechen",
      errors: {
        cannot_merge_self: "Sie können einen Kontakt nicht mit sich selbst zusammenführen.",
      },
    },
  },
};

const OPTIONS = [
  { id: "target-1", name: "Ziel GmbH" },
  { id: "target-2", name: "Andere Firma AG" },
];

function renderSection() {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <MergeContactSection sourceId="source-1" sourceName="Quelle GmbH" options={OPTIONS} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  mergeMock.mockReset();
  pushMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("MergeContactSection", () => {
  it("filters options by name as the admin types", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Zusammenführen" }));

    fireEvent.change(screen.getByPlaceholderText("Kontakt suchen…"), { target: { value: "Ziel" } });

    expect(screen.getByText("Ziel GmbH")).toBeTruthy();
    expect(screen.queryByText("Andere Firma AG")).toBeNull();
  });

  it("shows a confirmation dialog naming both contacts and what moves before merging", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Zusammenführen" }));
    fireEvent.click(screen.getByText("Ziel GmbH"));

    const confirmText = screen.getByText(/wird mit/);
    expect(confirmText.textContent).toContain("Quelle GmbH");
    expect(confirmText.textContent).toContain("Ziel GmbH");
    expect(confirmText.textContent).toContain("verknüpften Dokumente");
  });

  it("calls mergeContactsAction and redirects to the target on confirmation", async () => {
    mergeMock.mockResolvedValue({ status: "success", data: { id: "target-1" } });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Zusammenführen" }));
    fireEvent.click(screen.getByText("Ziel GmbH"));
    fireEvent.click(screen.getByRole("button", { name: "Ja, zusammenführen" }));

    await waitFor(() => expect(mergeMock).toHaveBeenCalledWith({ sourceId: "source-1", targetId: "target-1" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard/contacts/target-1"));
  });

  it("shows the mapped error when merging fails", async () => {
    mergeMock.mockResolvedValue({ status: "error", errorCode: "cannot_merge_self" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Zusammenführen" }));
    fireEvent.click(screen.getByText("Ziel GmbH"));
    fireEvent.click(screen.getByRole("button", { name: "Ja, zusammenführen" }));

    await screen.findByText("Sie können einen Kontakt nicht mit sich selbst zusammenführen.");
    expect(pushMock).not.toHaveBeenCalled();
  });
});
