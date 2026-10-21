import { describe, expect, it } from "vitest";

import { MAX_SCANNER_PAGES } from "../core/limits";
import { pageListReducer } from "../core/page-list";
import type { ScannerPage } from "../core/types";

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

describe("pageListReducer", () => {
  it("appends a page with 'add'", () => {
    const result = pageListReducer([makePage("a")], { type: "add", page: makePage("b") });
    expect(result.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("refuses to add beyond MAX_SCANNER_PAGES", () => {
    const full = Array.from({ length: MAX_SCANNER_PAGES }, (_, i) => makePage(`p${i}`));
    const result = pageListReducer(full, { type: "add", page: makePage("overflow") });
    expect(result).toBe(full);
    expect(result).toHaveLength(MAX_SCANNER_PAGES);
  });

  it("replaces a page by id (retake)", () => {
    const replacement = makePage("a", { width: 999 });
    const result = pageListReducer([makePage("a"), makePage("b")], { type: "replace", id: "a", page: replacement });
    expect(result[0]).toBe(replacement);
    expect(result[1].id).toBe("b");
  });

  it("removes a page by id", () => {
    const result = pageListReducer([makePage("a"), makePage("b")], { type: "remove", id: "a" });
    expect(result.map((p) => p.id)).toEqual(["b"]);
  });

  it("moves a page left, swapping with its predecessor", () => {
    const result = pageListReducer([makePage("a"), makePage("b"), makePage("c")], { type: "moveLeft", id: "b" });
    expect(result.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("is a no-op moving the first page left", () => {
    const pages = [makePage("a"), makePage("b")];
    const result = pageListReducer(pages, { type: "moveLeft", id: "a" });
    expect(result).toBe(pages);
  });

  it("moves a page right, swapping with its successor", () => {
    const result = pageListReducer([makePage("a"), makePage("b"), makePage("c")], { type: "moveRight", id: "b" });
    expect(result.map((p) => p.id)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op moving the last page right", () => {
    const pages = [makePage("a"), makePage("b")];
    const result = pageListReducer(pages, { type: "moveRight", id: "b" });
    expect(result).toBe(pages);
  });

  it("rotates a page clockwise, wrapping at 360", () => {
    let pages = [makePage("a", { rotation: 0 })];
    pages = pageListReducer(pages, { type: "rotate", id: "a", by: 90 });
    expect(pages[0].rotation).toBe(90);
    pages = pageListReducer(pages, { type: "rotate", id: "a", by: 90 });
    pages = pageListReducer(pages, { type: "rotate", id: "a", by: 90 });
    expect(pages[0].rotation).toBe(270);
    pages = pageListReducer(pages, { type: "rotate", id: "a", by: 90 });
    expect(pages[0].rotation).toBe(0);
  });

  it("rotates counter-clockwise, wrapping below 0", () => {
    const result = pageListReducer([makePage("a", { rotation: 0 })], { type: "rotate", id: "a", by: -90 });
    expect(result[0].rotation).toBe(270);
  });

  it("changes a page's filter", () => {
    const result = pageListReducer([makePage("a", { filter: "document" })], {
      type: "setFilter",
      id: "a",
      filter: "color",
    });
    expect(result[0].filter).toBe("color");
  });

  it("ignores actions for an unknown id", () => {
    const pages = [makePage("a")];
    expect(pageListReducer(pages, { type: "remove", id: "missing" })).toEqual(pages);
    expect(pageListReducer(pages, { type: "rotate", id: "missing", by: 90 })).toEqual(pages);
  });
});
