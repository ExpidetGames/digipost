// @vitest-environment jsdom
// The permission-denied/no-camera/insecure-context fallback (product requirement 1).
// `navigator.mediaDevices` and the scanic module are irrelevant to this component directly,
// but it is exercised the way `ui/scanner.tsx` actually renders it: driven purely by a
// `CameraErrorReason`, with no camera or scanic access of its own - this test proves it never
// needs either, which is exactly why the "no camera" fallback path is safe to render even
// when both are entirely unavailable (mocked here as absent, matching a locked-down or
// insecure-context browser).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

vi.mock("scanic", () => {
  throw new Error("scanic must never be imported by the permission fallback path");
});

const messages = {
  Scanner: {
    permission: {
      insecureContext: "Die Kamera ist nur über eine sichere Verbindung (HTTPS) verfügbar.",
      unsupported: "Ihr Browser unterstützt den Kamerazugriff nicht.",
      denied: "Der Kamerazugriff wurde verweigert.",
      notFound: "Es wurde keine Kamera gefunden.",
      unknown: "Die Kamera konnte nicht gestartet werden.",
      retry: "Erneut versuchen",
      switchToFile: "Datei hochladen verwenden",
      captureFallback: "Foto mit der Kamera-App aufnehmen",
    },
  },
};

import { PermissionFallback } from "../ui/permission-fallback";

beforeEach(() => {
  // Simulate a browser with no camera API at all - `navigator.mediaDevices` absent.
  Object.defineProperty(window.navigator, "mediaDevices", { value: undefined, configurable: true });
});

afterEach(() => cleanup());

function renderFallback(reason: Parameters<typeof PermissionFallback>[0]["reason"]) {
  const onRetry = vi.fn();
  const onSwitchToFileTab = vi.fn();
  const onCaptureFallbackFiles = vi.fn();
  render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <PermissionFallback
        reason={reason}
        onRetry={onRetry}
        onSwitchToFileTab={onSwitchToFileTab}
        onCaptureFallbackFiles={onCaptureFallbackFiles}
      />
    </NextIntlClientProvider>,
  );
  return { onRetry, onSwitchToFileTab, onCaptureFallbackFiles };
}

describe("PermissionFallback", () => {
  it("shows the denied message and a retry button for 'denied'", () => {
    const { onRetry } = renderFallback("denied");
    expect(screen.getByRole("alert").textContent).toBe("Der Kamerazugriff wurde verweigert.");
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows the insecure-context message without offering a retry (nothing to retry)", () => {
    renderFallback("insecure-context");
    expect(screen.getByRole("alert").textContent).toBe("Die Kamera ist nur über eine sichere Verbindung (HTTPS) verfügbar.");
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).toBeNull();
  });

  it("shows the unsupported message without offering a retry", () => {
    renderFallback("unsupported");
    expect(screen.getByRole("alert").textContent).toBe("Ihr Browser unterstützt den Kamerazugriff nicht.");
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).toBeNull();
  });

  it("shows the not-found message with a retry button", () => {
    renderFallback("not-found");
    expect(screen.getByRole("alert").textContent).toBe("Es wurde keine Kamera gefunden.");
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeNull();
  });

  it("always offers switching to the file-upload tab", () => {
    const { onSwitchToFileTab } = renderFallback("unsupported");
    fireEvent.click(screen.getByRole("button", { name: "Datei hochladen verwenden" }));
    expect(onSwitchToFileTab).toHaveBeenCalled();
  });

  it("always offers the native camera-capture file input as a fallback", () => {
    const { onCaptureFallbackFiles } = renderFallback("insecure-context");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute("capture")).toBe("environment");
    expect(input.getAttribute("accept")).toBe("image/*");

    const file = new File(["data"], "foto.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onCaptureFallbackFiles).toHaveBeenCalled();
  });
});
