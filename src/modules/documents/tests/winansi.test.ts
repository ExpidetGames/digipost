import { describe, expect, it } from "vitest";

import { sanitizeWinAnsi } from "../core/winansi";

describe("sanitizeWinAnsi", () => {
  it("keeps German umlauts and sharp s unchanged", () => {
    expect(sanitizeWinAnsi("Straße München Köln Über Ärger")).toBe("Straße München Köln Über Ärger");
  });

  it("keeps plain ASCII unchanged", () => {
    expect(sanitizeWinAnsi("Rechnung Nr. 4711 - Betrag: 49,99 EUR")).toBe("Rechnung Nr. 4711 - Betrag: 49,99 EUR");
  });

  it("keeps common WinAnsi punctuation (smart quotes, en dash, ellipsis, euro sign)", () => {
    expect(sanitizeWinAnsi("„zitiert“ – mehr … €")).toBe("„zitiert“ – mehr … €");
  });

  it("replaces characters outside WinAnsi with a placeholder", () => {
    // "😀" is a surrogate pair (two UTF-16 code units), each replaced individually.
    expect(sanitizeWinAnsi("emoji: 😀 CJK: 中文")).toBe("emoji: ?? CJK: ??");
  });

  it("returns an empty string unchanged", () => {
    expect(sanitizeWinAnsi("")).toBe("");
  });
});
