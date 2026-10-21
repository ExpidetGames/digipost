// @vitest-environment jsdom
// Client-component unit test (WEBAPP_TEMPLATE_SPEC.md §10.2): Testing Library + jsdom, the
// upload helper mocked at the module path the component actually imports.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

const uploadMock = vi.fn();
vi.mock("../core/upload-client", () => ({
  uploadDocument: (files: unknown, fileName?: string) => uploadMock(files, fileName),
}));

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

// The Kamera tab mounts P2c's real camera capture UI
// (`src/modules/scanner/ui/camera-scanner.tsx`); this test only proves the tab switch
// itself mounts it, not the scanner's own internal behavior (covered by
// `src/modules/scanner/tests/**` and `tests/e2e/scanner.spec.ts`).
vi.mock("@/modules/scanner/client", () => ({
  CameraScanner: () => <div data-testid="camera-scanner-stub" />,
}));

import { UploadForm } from "../ui/upload-form";

const messages = {
  Scan: {
    tabs: { label: "Erfassungsart", camera: "Kamera", file: "Datei hochladen" },
    dropzone: "Dateien hierher ziehen oder klicken",
    fileNameLabel: "Bezeichnung (optional)",
    fileNamePlaceholder: "z. B. Rechnung",
    submit: "Hochladen",
    submitPending: "Wird hochgeladen…",
    errors: {
      no_file: "Bitte wählen Sie mindestens eine Datei aus.",
      unsupported_file_type: "Nicht unterstützter Dateityp.",
      file_too_large: "Die Datei ist zu groß (maximal 4 MB).",
      fileTooLargeStructuredHint: "Bitte exportieren Sie Kontoauszüge monatsweise.",
      quota_total_exceeded: "Ihr Speicherlimit ist erreicht.",
      quota_monthly_exceeded: "Ihr monatliches Limit ist erreicht.",
      quotaLink: "Zum Tarif",
      quotaMemberHint: "Wenden Sie sich an Ihren Administrator.",
      unknown: "Der Upload ist fehlgeschlagen.",
    },
    bulk: {
      splitImagesSwitch: "Jede Datei ist ein eigenes Dokument",
      counter: "{done} von {total}",
      stoppedByQuota: "Der Upload wurde gestoppt, weil Ihr Limit erreicht ist.",
      status: {
        waiting: "wartet",
        uploading: "lädt hoch",
        done: "fertig",
        error: "Fehler",
        skipped: "übersprungen",
      },
    },
  },
};

function renderForm(canManageBilling = true) {
  return render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <UploadForm canManageBilling={canManageBilling} />
    </NextIntlClientProvider>,
  );
}

function pdfFile(name = "brief.pdf"): File {
  return new File(["%PDF-1.7"], name, { type: "application/pdf" });
}

function csvFile(name = "kontoauszug.csv"): File {
  return new File(["a,b,c"], name, { type: "text/csv" });
}

function fileNamed(name: string): File {
  return new File(["content"], name);
}

function imageFile(name = "seite.jpg"): File {
  return new File(["jpeg-bytes"], name, { type: "image/jpeg" });
}

beforeEach(() => {
  uploadMock.mockReset();
  pushMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("UploadForm", () => {
  it("shows a no_file error when submitting without selecting a file", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));
    expect(screen.queryByText("Bitte wählen Sie mindestens eine Datei aus.")).not.toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uploads the selected file and redirects to the document detail page on success", async () => {
    uploadMock.mockResolvedValue({ status: "success", documentId: "doc-1" });
    renderForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard/documents/doc-1"));
    expect(uploadMock).toHaveBeenCalledWith([pdfFile()], "");
  });

  it("shows the mapped error message returned by the upload helper", async () => {
    uploadMock.mockResolvedValue({ status: "error", errorCode: "unsupported_file_type" });
    renderForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

    await screen.findByText("Nicht unterstützter Dateityp.");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it(
    "shows the 'export monthly' hint for a file_too_large error on a structured (CSV/XML/TSV) file " +
      "(F5, decisions/0027-hardening-and-deletion.md: the 4 MB cap is not raised, only explained)",
    async () => {
      uploadMock.mockResolvedValue({ status: "error", errorCode: "file_too_large" });
      renderForm();

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [csvFile()] } });
      fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

      await screen.findByText("Die Datei ist zu groß (maximal 4 MB).", { exact: false });
      expect(screen.queryByText("Bitte exportieren Sie Kontoauszüge monatsweise.", { exact: false })).not.toBeNull();
    },
  );

  it(
    "shows the same hint for a .mt940 file and a version-suffixed .camt053v08 file " +
      "(decisions/0028-mt940-support.md: the file picker no longer decides acceptance by extension)",
    async () => {
      uploadMock.mockResolvedValue({ status: "error", errorCode: "file_too_large" });
      renderForm();

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [fileNamed("umsaetze.mt940")] } });
      fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));
      await screen.findByText("Bitte exportieren Sie Kontoauszüge monatsweise.", { exact: false });

      fireEvent.change(input, { target: { files: [fileNamed("OLD_Musterbank_statement_21092026.camt053v08")] } });
      fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));
      await screen.findByText("Bitte exportieren Sie Kontoauszüge monatsweise.", { exact: false });
    },
  );

  it("the file input has no accept attribute - the server sniffs content, the picker never hides a real export by extension", () => {
    renderForm();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.hasAttribute("accept")).toBe(false);
  });

  it("never shows the structured-file hint for a file_too_large error on a plain PDF/image upload", async () => {
    uploadMock.mockResolvedValue({ status: "error", errorCode: "file_too_large" });
    renderForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

    await screen.findByText("Die Datei ist zu groß (maximal 4 MB).", { exact: false });
    expect(screen.queryByText("Bitte exportieren Sie Kontoauszüge monatsweise.", { exact: false })).toBeNull();
  });

  it("shows a link to the tarif page for a quota error", async () => {
    uploadMock.mockResolvedValue({ status: "error", errorCode: "quota_total_exceeded" });
    renderForm();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

    await screen.findByText("Ihr Speicherlimit ist erreicht.", { exact: false });
    const link = screen.getByRole("link", { name: "Zum Tarif" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/dashboard/billing");
  });

  it("tells a member without billing.manage to contact their admin on a quota error", async () => {
    uploadMock.mockResolvedValue({ status: "error", errorCode: "quota_monthly_exceeded" });
    renderForm(false);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

    await screen.findByText("Wenden Sie sich an Ihren Administrator.", { exact: false });
  });

  it("switches to the Kamera tab and mounts the camera scanner", () => {
    renderForm();
    fireEvent.click(screen.getByRole("tab", { name: "Kamera" }));
    expect(screen.queryByTestId("camera-scanner-stub")).not.toBeNull();
  });

  // G2 (decisions/0030-bulk-upload.md).
  describe("bulk upload", () => {
    it("shows the image-split switch only once 2+ images are selected, not for a single PDF or a single image", () => {
      renderForm();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      const switchLabel = "Jede Datei ist ein eigenes Dokument";

      fireEvent.change(input, { target: { files: [pdfFile()] } });
      expect(screen.queryByText(switchLabel)).toBeNull();

      fireEvent.change(input, { target: { files: [imageFile("p1.jpg")] } });
      expect(screen.queryByText(switchLabel)).toBeNull();

      fireEvent.change(input, { target: { files: [imageFile("p1.jpg"), imageFile("p2.jpg")] } });
      expect(screen.queryByText(switchLabel)).not.toBeNull();
    });

    it(
      "several PDFs each become their own document: uploads sequentially, renders a per-file list with a counter, " +
        "keeps a per-file error on its own row and continues the queue, and never redirects",
      async () => {
        uploadMock.mockResolvedValueOnce({ status: "success", documentId: "doc-1" });
        uploadMock.mockResolvedValueOnce({ status: "error", errorCode: "unsupported_file_type" });
        renderForm();

        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [pdfFile("a.pdf"), pdfFile("b.pdf")] } });
        fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

        await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
        expect(screen.getByText("a.pdf").nextSibling?.textContent).toBe("fertig");
        expect(screen.getByText("b.pdf").nextSibling?.textContent).toBe("Fehler: Nicht unterstützter Dateityp.");
        expect(screen.getByText("2 von 2")).not.toBeNull();
        expect(pushMock).not.toHaveBeenCalled();
      },
    );

    it("splits several images into one document each when the switch is on", async () => {
      uploadMock.mockResolvedValue({ status: "success", documentId: "doc-x" });
      renderForm();

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [imageFile("p1.jpg"), imageFile("p2.jpg")] } });
      fireEvent.click(screen.getByLabelText("Jede Datei ist ein eigenes Dokument"));
      fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2));
      expect(uploadMock.mock.calls[0]![0]).toHaveLength(1);
      expect(uploadMock.mock.calls[1]![0]).toHaveLength(1);
    });

    it("a quota error stops the queue: later rows are skipped and a short summary is shown", async () => {
      uploadMock.mockResolvedValueOnce({ status: "success", documentId: "doc-1" });
      uploadMock.mockResolvedValueOnce({ status: "error", errorCode: "quota_total_exceeded" });
      renderForm();

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(input, { target: { files: [pdfFile("a.pdf"), pdfFile("b.pdf"), pdfFile("c.pdf")] } });
      fireEvent.click(screen.getByRole("button", { name: "Hochladen" }));

      await screen.findByText("übersprungen");
      expect(uploadMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText("c.pdf").nextSibling?.textContent).toBe("übersprungen");
      await screen.findByText("Der Upload wurde gestoppt, weil Ihr Limit erreicht ist.", { exact: false });
    });
  });
});
