# src/modules/scanner

Document type: reference
Lifecycle: active
Owner: src/modules/scanner
Scope: The client-only camera capture UI behind `/dashboard/scan`'s "Kamera" tab: starting
the rear camera, live edge detection and overlay, manual and automatic capture,
perspective correction, manual corner adjustment, per-page filter/rotation, multi-page
management, and JPEG size-budgeted upload via `@/modules/documents/client`
Canonical responsibility: Everything the "Kamera" tab delegates to, and how it uses scanic
Maintenance triggers:
- scanic's API (`node_modules/scanic/src/scanic.d.ts`) changes in a breaking way
- The upload size/page limits (`core/limits.ts`, mirroring
  `src/modules/documents/core/upload-limits.ts`) change
- `next.config.ts`'s CSP/Permissions-Policy changes in a way that affects camera or WASM
- Browser support for a targeted capability (`getUserMedia`, `createImageBitmap`,
  `canvas.filter`) changes materially
Last verified: 2026-09-19, P2c (camera scanner)

## Purpose

A mobile-first paper-mail scanner: start the rear camera, detect the document's edges live,
capture (manually or automatically once the detected quad holds still), perspective-correct
and lightly enhance the image, let the user fine-tune corners/rotation/filter and manage
multiple pages, then hand the finished JPEG pages to
`src/modules/documents`' existing upload path - this module never talks to
`/api/documents` itself, it only calls `uploadDocument` (`@/modules/documents/client`), the
exact function `src/modules/documents/ui/upload-form.tsx`'s file-input tab already uses.

## Public interfaces

- `client.ts` (`"use client"`): `CameraScanner`, the component
  `src/modules/documents/ui/upload-form.tsx` mounts in its "Kamera" tab (replacing P2a's
  placeholder). Takes one prop, `onSwitchToFileTab`, so the permission-denied/no-camera
  fallback can switch the parent form back to "Datei hochladen".

No `server.ts`/`actions.ts`/`index.ts`: this module has no server-side code at all - every
byte of processing (edge detection, perspective correction, encoding) happens in the
browser, and the only network call it ever makes is the same `POST /api/documents`
`uploadDocument` already makes for the file-upload tab.

## Structure

- `core/types.ts` - `Point`/`CornerPoints` (structurally identical to scanic's own shapes,
  see "How scanic is used" below), `PageFilter`, `Rotation`, `ScannerPage` (one captured page:
  `masterBlob`, dimensions, rotation, filter, and a `previewUrl` object URL the UI owns the
  lifecycle of).
- `core/limits.ts` - `MAX_SCANNER_PAGES` (20) and `MAX_UPLOAD_TOTAL_BYTES` (4 MB), duplicated
  from `src/modules/documents/core/upload-limits.ts` rather than imported: that module's
  limits are published only through its `server.ts` (`import "server-only"`), which a
  client-only module can never import. Keep the two pairs of constants in sync by hand.
- `core/coordinate-mapping.ts` - `scalePoint`/`scaleCorners`: maps points between two pixel
  spaces of the same scene (a downscaled detection frame vs. the video's full resolution, or
  the video's intrinsic resolution vs. its displayed CSS size).
- `core/corner-clamp.ts` - `clampPoint`/`clampCorners` (keeps a quad inside the image bounds)
  and `defaultInsetCorners` (the manual corner editor's fallback default when no detection
  exists at all).
- `core/frame-downscale.ts` - `computeDownscaleSize`: the live-detection loop's "how small
  should the detection frame be" math (never upscales).
- `core/quad-stability.ts` - `isQuadStable`/`cornerDrift`/`pruneHistory`: the optional
  auto-capture toggle's "has the detected quad stopped moving for ~1s" logic, driven by a
  rolling history of per-tick detection samples.
- `core/encoding-budget.ts` - `nextEncodingAttempt`/`hasMoreEncodingAttempts`/
  `perPageByteBudget`: the pure quality/resolution-stepping policy the (impure) encode loop in
  `ui/canvas-pipeline.ts` calls between attempts to keep every page's JPEG under its share of
  the 4 MB upload budget.
- `core/page-list.ts` - `pageListReducer`: add/replace(retake)/remove/moveLeft/moveRight/
  rotate/setFilter over a `ScannerPage[]`, enforcing `MAX_SCANNER_PAGES` on `add`.
- `ui/scanic-loader.ts` - `loadScanic()`: the one `import("scanic")` call site (module-level
  cached promise), so scanic's code only ever loads once the user opens "Kamera" - see "How
  scanic is used" below for why this needs no further asset loading.
- `ui/canvas-pipeline.ts` - the impure image-processing half: capturing a video frame,
  downscaling it for detection, calling scanic's `extractDocument`/`scanDocument`, baking in
  rotation/filter (`FILTER_CSS`, using canvas 2D's `ctx.filter`, which accepts the same CSS
  filter syntax the review screen's live preview uses - what you see is what gets uploaded),
  and `encodePageForUpload`, which runs the `core/encoding-budget.ts` stepping loop against a
  real `canvas.toBlob`.
- `ui/hooks/use-camera-stream.ts` - `useCameraStream`: the `getUserMedia` lifecycle (rear
  camera, `facingMode: { ideal: "environment" }`), mapping `DOMException` names to
  `CameraErrorReason` (`insecure-context`/`unsupported`/`denied`/`not-found`/`unknown`), and
  always stopping every track on cleanup.
- `ui/hooks/use-live-detection.ts` - `useLiveDetection`: the throttled (400 ms) detection
  loop, using scanic's `Scanner` class (persists its WASM instance across calls, the
  "Optimized Usage" pattern from scanic's own README) against a downscaled frame, feeding
  `core/quad-stability.ts` and triggering auto-capture at most once per stability episode.
- `ui/camera-view.tsx` - the live preview: video element, quad overlay canvas, the
  auto-capture toggle and manual shutter button, and `PermissionFallback` when the camera
  could not start.
- `ui/permission-fallback.tsx` - the permission-denied/no-camera/insecure-context message,
  a retry button (only for retryable reasons), a "Datei hochladen verwenden" button, and a
  native `<input type="file" accept="image/*" capture="environment">` fallback that works
  even when `getUserMedia` itself is unavailable.
- `ui/corner-editor.tsx` - thin wrapper around scanic's `createCornerEditor` (an imperative
  DOM API: mount into a container ref, tear down on unmount/prop change).
- `ui/review-screen.tsx` - post-capture: attempts extraction automatically, opens the corner
  editor automatically on failure or on request, the "Dokument"/"Farbe" filter toggle, the
  rotate button, and retake/confirm.
- `ui/page-strip.tsx` - the multi-page thumbnail strip: reorder (move left/right), delete,
  retake, "Seite hinzufügen" (disabled at `MAX_SCANNER_PAGES`).
- `ui/upload-panel.tsx` - the optional document-name field and "Hochladen" button: re-encodes
  every page at its per-page budget, refuses to submit if the total would still exceed
  `MAX_UPLOAD_TOTAL_BYTES`, then calls `uploadDocument` and navigates to the new document on
  success. Reuses `src/i18n/messages/de.json`'s `Scan.errors` namespace for error messages
  (`uploadDocument` returns the exact same `DocumentUploadErrorCode` union in both places, so
  the same message keys apply without duplicating them).
- `ui/scanner.tsx` - `CameraScanner`: owns the page list and switches between the camera view
  and the review screen; a retake replaces the page in place (`pageListReducer`'s `replace`
  action) rather than appending a new one at the end.

## How scanic is used

`node_modules/scanic/src/scanic.d.ts` is this module's contract with the library; the
classical (default, non-`detector: 'ml'`) detector is used throughout - the optional ML
corner detector (`detector: 'ml'`) is never opted into, since it lazy-loads a ~2 MB model
plus a custom ONNX runtime from a CDN on first use (`scanic-ml`, jsDelivr by default), which
would need its own CSP `connect-src`/`script-src` allowance and a network dependency this
module has no product requirement to take on. The classical detector's own WASM module ships
**base64-inlined inside scanic's ESM bundle** (`node_modules/scanic/dist/scanic.js`, a ~58 KB
base64 string decoded and passed to `WebAssembly.instantiate` as bytes) - confirmed by
inspecting the bundle directly, since scanic's own docs do not spell this out. That means:

- No extra network request for the classical detector: `loadScanic()`'s dynamic `import()`
  is the only thing that needs to load lazily, and it is the only such import in the whole
  module (`ui/scanic-loader.ts`).
- No Worker: scanic's classical pipeline runs synchronously to its own async API on the main
  thread (confirmed: no `new Worker(...)` anywhere in `dist/scanic.js`). `next.config.ts`'s
  CSP therefore needed no `worker-src` change.
- `WebAssembly.instantiate(bytes, imports)` (not `instantiateStreaming` from a URL, since the
  bytes come from a decoded base64 string, not a `Response`) still needs the CSP `wasm-unsafe-eval`
  script-src token per the CSP Level 3 spec - Chrome currently tolerates
  `WebAssembly.instantiate` without it, but Firefox/Safari enforce it, so relying on
  Chromium's leniency would be a silent cross-browser break. This is the one CSP change this
  phase made (see "CSP changes" below).
- `Scanner` (the persistent-WASM-instance class, "Optimized Usage" in scanic's own README) is
  used for the live-detection loop, since it runs many times per session; the one-shot
  `scanDocument`/`extractDocument` free functions are used for the actual capture/extraction,
  since those only run once per page.

## Browser support notes

- `getUserMedia` requires a secure context (HTTPS or `localhost`) - `useCameraStream` checks
  `window.isSecureContext` itself and reports `insecure-context` distinctly from `unsupported`
  (the API missing entirely, e.g. an old browser or a locked-down WebView).
- `capture="environment"` on the fallback `<input type="file">` is honored by mobile Chrome
  and Safari (opens the device's own camera app) but is a no-op hint on desktop browsers,
  which just show a normal file picker - harmless either way, and it is only ever the
  fallback path, never the primary one.
- `canvas.toBlob` and `createImageBitmap` are required (broadly supported since ~2019) and
  not feature-detected further; a browser missing either is already too old for `getUserMedia`
  with the constraints this module uses.
- `ctx.filter` (Canvas 2D context, CSS-filter-syntax) is required for the document/color
  enhancement; not feature-detected separately since every browser new enough for the above
  also supports it.

## CSP changes and why (`next.config.ts`)

Two changes, both scoped to exactly what scanic's classical detector needs (see above):

- `script-src` gained the `'wasm-unsafe-eval'` token (in every environment, not only dev):
  required for `WebAssembly.instantiate` under a CSP Level 3-enforcing browser (Firefox,
  Safari). Deliberately not `'unsafe-eval'` (already dev-only in this policy, for React's
  error-stack reconstruction): `wasm-unsafe-eval` only permits WebAssembly compilation, not
  arbitrary `eval`/`new Function`, so it does not weaken the policy beyond what scanic itself
  needs.
- No `connect-src`/`worker-src` change: the classical detector fetches nothing and spawns no
  Worker (see "How scanic is used" above). If a later phase opts into `detector: 'ml'`, it
  would need `connect-src` widened for the `scanic-ml` CDN origin at that point - not done
  here since this phase never uses it.

`Permissions-Policy`'s `camera=()` became `camera=(self)`: this module is this repository's
first camera consumer, and `camera=()` unconditionally blocks `getUserMedia` for every origin
including the app's own. `(self)` allows only this origin (never a third-party iframe) to
request the camera - every other directive is unchanged. `tests/config/next.config.test.ts`
and `README.md`'s "Security headers" section were updated alongside.

## Non-destructive edits and the master image

`ScannerPage.masterBlob` is the perspective-corrected (or raw, if extraction failed and the
user chose not to manually correct) capture, encoded once at high quality/resolution
(`ui/canvas-pipeline.ts`'s `encodeMaster`, quality 0.92, long edge capped at 2600px).
Rotation and the document/color filter are metadata on `ScannerPage`, not baked into
`masterBlob`: they render live via CSS (`transform`/`filter`, `FILTER_CSS`) in the page strip
and review screen, and are only baked into the actual raster once, at upload time
(`encodePageForUpload`), together with the size-budget stepping. Toggling rotation/filter
repeatedly therefore never re-compresses the image or degrades it generation over generation;
retaking a page produces an entirely new master rather than editing the old one.

## Known limits

- The camera stream is re-requested (a fresh `getUserMedia` call) every time the review
  screen is dismissed back to the camera view, rather than kept alive underneath it. Once a
  user has granted permission, the browser does not re-prompt, so this is a brief internal
  restart, not a second permission dialog - simpler than keeping the video element mounted
  and layering the review screen on top of it, at the cost of a small pause between pages.
- No dedicated component test exercises `CameraView`/`ReviewScreen`/`CornerEditor`/
  `UploadPanel`/`CameraScanner` directly (unlike `PageStrip`/`PermissionFallback`): each needs
  either a real camera/WASM or extensive mocking of `getUserMedia`/scanic/`canvas.toBlob`/
  `createImageBitmap` together, which `tests/e2e/scanner.spec.ts` (Chromium's fake camera
  device, a real browser) covers more faithfully than a jsdom mock stack would.

## Consumers

`src/modules/documents/ui/upload-form.tsx` (seam boundary crossing via `client.ts`): mounts
`CameraScanner` in the "Kamera" tab. No other module consumes this one.

## Tests

`tests/frame-downscale.test.ts`, `tests/corner-clamp.test.ts`, `tests/coordinate-mapping.test.ts`,
`tests/quad-stability.test.ts`, `tests/encoding-budget.test.ts`, `tests/page-list.test.ts`
(table-driven, no DOM). `tests/page-strip.test.tsx`, `tests/permission-fallback.test.tsx`
(jsdom, Testing Library, mocked `navigator.mediaDevices`/scanic where relevant). End-to-end
capture (manual shutter, a second page, upload, navigation to the document detail page) and
the file-input fallback path: `tests/e2e/scanner.spec.ts`, run with Chromium's fake camera
device flags (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`), scoped to
that spec only via `test.use({ launchOptions: { args: [...] } })`.
