// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import { MAX_SCANNER_PAGES } from "../core/limits";
import type { ScannerPage } from "../core/types";
import { PageStrip } from "../ui/page-strip";

const messages = {
  Scanner: {
    pageStrip: {
      listLabel: "Erfasste Seiten",
      pageAlt: "Seite {number}",
      moveLeft: "Nach links verschieben",
      moveRight: "Nach rechts verschieben",
      retake: "Erneut aufnehmen",
      remove: "Entfernen",
      addPage: "Seite hinzufügen",
      maxPagesReached: "Maximale Seitenzahl erreicht (20).",
    },
  },
};

function makePage(id: string, overrides: Partial<ScannerPage> = {}): ScannerPage {
  return {
    id,
    masterBlob: new Blob([id]),
    width: 100,
    height: 200,
    rotation: 0,
    filter: "document",
    previewUrl: `blob:${id}`,
    ...overrides,
  };
}

function renderStrip(pages: ScannerPage[], overrides: Partial<Parameters<typeof PageStrip>[0]> = {}) {
  const onMoveLeft = vi.fn();
  const onMoveRight = vi.fn();
  const onRemove = vi.fn();
  const onRetake = vi.fn();
  const onAddPage = vi.fn();
  render(
    <NextIntlClientProvider locale="de" messages={messages}>
      <PageStrip
        pages={pages}
        onMoveLeft={onMoveLeft}
        onMoveRight={onMoveRight}
        onRemove={onRemove}
        onRetake={onRetake}
        onAddPage={onAddPage}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { onMoveLeft, onMoveRight, onRemove, onRetake, onAddPage };
}

afterEach(() => cleanup());

describe("PageStrip", () => {
  it("renders one thumbnail per page with a 1-based number", () => {
    renderStrip([makePage("a"), makePage("b")]);
    expect(screen.getByAltText("Seite 1")).not.toBeNull();
    expect(screen.getByAltText("Seite 2")).not.toBeNull();
  });

  it("applies the page's rotation and filter as inline styles", () => {
    renderStrip([makePage("a", { rotation: 90, filter: "document" })]);
    const img = screen.getByAltText("Seite 1") as HTMLImageElement;
    expect(img.style.transform).toBe("rotate(90deg)");
    expect(img.style.filter).toContain("grayscale");
  });

  it("calls onMoveLeft/onMoveRight/onRemove/onRetake with the page id", () => {
    const { onMoveLeft, onMoveRight, onRemove, onRetake } = renderStrip([makePage("a"), makePage("b")]);

    fireEvent.click(screen.getAllByRole("button", { name: "Nach rechts verschieben" })[0]);
    expect(onMoveRight).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getAllByRole("button", { name: "Nach links verschieben" })[1]);
    expect(onMoveLeft).toHaveBeenCalledWith("b");

    fireEvent.click(screen.getAllByRole("button", { name: "Erneut aufnehmen" })[0]);
    expect(onRetake).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getAllByRole("button", { name: "Entfernen" })[1]);
    expect(onRemove).toHaveBeenCalledWith("b");
  });

  it("disables 'move left' on the first page and 'move right' on the last page", () => {
    renderStrip([makePage("a"), makePage("b"), makePage("c")]);
    const moveLeftButtons = screen.getAllByRole("button", { name: "Nach links verschieben" });
    const moveRightButtons = screen.getAllByRole("button", { name: "Nach rechts verschieben" });
    expect((moveLeftButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((moveRightButtons[moveRightButtons.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onAddPage when 'Seite hinzufügen' is clicked", () => {
    const { onAddPage } = renderStrip([makePage("a")]);
    fireEvent.click(screen.getByRole("button", { name: "Seite hinzufügen" }));
    expect(onAddPage).toHaveBeenCalled();
  });

  it("disables the add-page button and shows the limit message at MAX_SCANNER_PAGES", () => {
    const pages = Array.from({ length: MAX_SCANNER_PAGES }, (_, i) => makePage(`p${i}`));
    renderStrip(pages);
    const button = screen.getByRole("button", { name: "Maximale Seitenzahl erreicht (20)." }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
