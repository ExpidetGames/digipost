"use client";

/**
 * Public client entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). `CameraScanner` is mounted by
 * `src/modules/documents/ui/upload-form.tsx`'s "Kamera" tab in place of P2a's placeholder; it
 * hands its captured, perspective-corrected JPEG pages to
 * `@/modules/documents/client`'s `uploadDocument` itself (`ui/upload-panel.tsx`), so the
 * documents module needs no change beyond mounting this component.
 */
export { CameraScanner } from "./ui/scanner";
