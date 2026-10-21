"use client";

// Lazy-loads scanic (module-level singleton promise) so `/dashboard/scan`'s bundle - and
// every other page's, since `UploadForm` is reachable from anywhere `src/modules/documents`
// is - never carries scanic's WASM-decoding JS until a user actually opens the "Kamera" tab
// and the camera starts. See src/modules/scanner/README.md's "How scanic is used" for why the
// classical (non-`detector: 'ml'`) detector needs no further asset loading of its own: its
// WASM module ships base64-inlined in scanic's own ESM bundle, decoded and instantiated
// in-memory - no extra network request, no Worker, no `wasm-unsafe-eval`-adjacent CDN
// dependency beyond what `next.config.ts`'s CSP already grants for that instantiation.
import type * as Scanic from "scanic";

let scanicPromise: Promise<typeof Scanic> | null = null;

export function loadScanic(): Promise<typeof Scanic> {
  scanicPromise ??= import("scanic");
  return scanicPromise;
}
