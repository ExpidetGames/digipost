// Shared, pure types for the scanner module. `CornerPoints`/`Point` mirror scanic's own
// shapes (node_modules/scanic/src/scanic.d.ts) structurally so values can be passed to/from
// scanic without conversion, without this module importing scanic's types directly from
// non-lazy-loaded code paths (scanic itself is only ever reached via a dynamic `import()`,
// see `ui/scanic-loader.ts`).

export interface Point {
  x: number;
  y: number;
}

export interface CornerPoints {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export type PageFilter = "document" | "color";

/** Clockwise rotation applied to a captured page, in degrees. */
export type Rotation = 0 | 90 | 180 | 270;

export interface Size {
  width: number;
  height: number;
}

/**
 * One captured, processed page in the current scan session. `masterBlob` is the
 * highest-quality version produced right after capture (perspective-corrected if
 * detection/manual correction succeeded, filtered, rotated) - it is what gets re-encoded at
 * a lower quality/resolution if the final upload would otherwise exceed the size budget
 * (`core/encoding-budget.ts`), so it is never itself the downsized/quality-reduced result.
 * `previewUrl` is an object URL for the thumbnail/review display, revoked by the caller
 * (`ui/page-strip.tsx`/`ui/scanner.tsx`) when the page is removed or replaced.
 */
export interface ScannerPage {
  id: string;
  masterBlob: Blob;
  width: number;
  height: number;
  rotation: Rotation;
  filter: PageFilter;
  previewUrl: string;
}
