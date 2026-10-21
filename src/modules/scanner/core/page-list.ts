// Pure page-list reducer backing the multi-page capture flow (`ui/scanner.tsx`'s
// `useReducer`): add/replace/remove/reorder/rotate. No browser APIs here - `ScannerPage`'s
// `masterBlob`/`previewUrl` are treated as opaque values; creating/revoking the object URL is
// the caller's side effect, not this reducer's.
import { MAX_SCANNER_PAGES } from "./limits";
import type { Rotation, ScannerPage } from "./types";

export type PageListAction =
  | { type: "add"; page: ScannerPage }
  | { type: "replace"; id: string; page: ScannerPage }
  | { type: "remove"; id: string }
  | { type: "moveLeft"; id: string }
  | { type: "moveRight"; id: string }
  | { type: "rotate"; id: string; by: 90 | -90 }
  | { type: "setFilter"; id: string; filter: ScannerPage["filter"] };

function normalizeRotation(rotation: number): Rotation {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized as Rotation;
}

function swap<T>(items: T[], indexA: number, indexB: number): T[] {
  const copy = items.slice();
  [copy[indexA], copy[indexB]] = [copy[indexB], copy[indexA]];
  return copy;
}

/** `pages.length >= MAX_SCANNER_PAGES` after this action is a no-op for "add": the caller
 * (`ui/scanner.tsx`) disables its own "Seite hinzufügen" affordance at that point, but the
 * reducer enforces the limit unconditionally so it can never be exceeded by a race (e.g. a
 * queued capture completing after the button was already disabled). */
export function pageListReducer(pages: ScannerPage[], action: PageListAction): ScannerPage[] {
  switch (action.type) {
    case "add": {
      if (pages.length >= MAX_SCANNER_PAGES) return pages;
      return [...pages, action.page];
    }
    case "replace":
      return pages.map((page) => (page.id === action.id ? action.page : page));
    case "remove":
      return pages.filter((page) => page.id !== action.id);
    case "moveLeft": {
      const index = pages.findIndex((page) => page.id === action.id);
      if (index <= 0) return pages;
      return swap(pages, index, index - 1);
    }
    case "moveRight": {
      const index = pages.findIndex((page) => page.id === action.id);
      if (index === -1 || index >= pages.length - 1) return pages;
      return swap(pages, index, index + 1);
    }
    case "rotate":
      return pages.map((page) =>
        page.id === action.id ? { ...page, rotation: normalizeRotation(page.rotation + action.by) } : page,
      );
    case "setFilter":
      return pages.map((page) => (page.id === action.id ? { ...page, filter: action.filter } : page));
    default:
      return pages;
  }
}
