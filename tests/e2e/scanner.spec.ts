// Camera scanner, end to end (P2c). Two scenarios:
//
// 1. A real (fake) camera device captures two pages with the manual shutter and uploads
//    them, landing on the new document's detail page - Chromium's fake-media flags
//    (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, plus a
//    document-like MJPEG fixture so scanic's live detection has something plausible to look
//    at) are scoped to this spec only via `test.use({ launchOptions })`, since no other spec
//    needs a fake camera device.
// 2. The permission-denied fallback (`PermissionFallback`) and its native
//    `capture="environment"` file input: `getUserMedia` is overridden on the page itself to
//    reject with `NotAllowedError` before the app ever calls it - simulating an actual denial
//    through browser flags is not reliably possible (the fake-ui flag always auto-accepts),
//    so this exercises the same code path (`useCameraStream`'s `DOMException` mapping) the
//    unit-tested `PermissionFallback` component renders for.
//
// Uses the `adminUser` fixture (a fast session with a real workspace, `tests/e2e/helpers/fixtures.ts`)
// since `/dashboard/**` requires workspace membership.
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { expect, test } from "./helpers/fixtures";

const FAKE_VIDEO_FILE = fileURLToPath(new URL("./helpers/fixtures/document-scene.mjpeg", import.meta.url));
const FALLBACK_PHOTO_FILE = fileURLToPath(new URL("./helpers/fixtures/document-photo.jpg", import.meta.url));

/**
 * Confirms the review screen for the page just captured. Automatic perspective correction
 * may or may not find the (synthetic) document in time: when it fails, `ReviewScreen` opens
 * scanic's own corner editor automatically (`src/modules/scanner/ui/corner-editor.tsx`),
 * whose default toolbar labels are scanic's own English defaults ("Apply"/"Cancel"/"Reset" -
 * this module passes no `toolbar.labels` override), not this app's German copy. Handles both
 * outcomes so the test does not depend on the classical detector's success rate against a
 * generated fixture.
 */
async function confirmCapturedPage(page: Page): Promise<void> {
  const applyButton = page.getByRole("button", { name: "Apply" });
  try {
    await applyButton.waitFor({ state: "visible", timeout: 4_000 });
    await applyButton.click();
  } catch {
    // Automatic perspective correction already succeeded - no corner editor to confirm.
  }
  await page.getByRole("button", { name: "Übernehmen" }).click();
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${FAKE_VIDEO_FILE}`,
    ],
  },
});

test(
  "captures two pages with the camera's manual shutter and uploads them",
  { tag: "@smoke" },
  async ({ page, context, baseURL, adminUser }) => {
    await context.grantPermissions(["camera"], { origin: baseURL });

    await page.goto("/dashboard/scan");
    await page.getByRole("tab", { name: "Kamera" }).click();

    // `exact: true`: a plain substring match would also hit the page strip's "Erneut
    // aufnehmen" (retake) button once a page exists.
    const shutter = page.getByRole("button", { name: "Aufnehmen", exact: true });
    await expect(shutter).toBeEnabled({ timeout: 15_000 });

    // Page 1: capture, then confirm the review screen as-is.
    await shutter.click();
    await confirmCapturedPage(page);

    // Back at the live camera view for the second page.
    await expect(shutter).toBeEnabled({ timeout: 15_000 });
    await shutter.click();
    await confirmCapturedPage(page);

    await expect(page.getByRole("list", { name: "Erfasste Seiten" }).getByRole("listitem")).toHaveCount(2);

    await page.getByRole("button", { name: "Hochladen", exact: true }).click();

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // `adminUser`'s workspace stayed the active one throughout.
    await expect(page.getByText(adminUser.workspace.name).first()).toBeVisible();
  },
);

test("falls back to the permission-denied message and its native camera-capture file input", async ({ page, adminUser }) => {
  await page.addInitScript(() => {
    // Simulate the browser denying camera access, the same DOMException `useCameraStream`
    // (src/modules/scanner/ui/hooks/use-camera-stream.ts) maps to the "denied" reason.
    Object.defineProperty(window.navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    });
  });

  await page.goto("/dashboard/scan");
  await page.getByRole("tab", { name: "Kamera" }).click();

  // Next.js's own route announcer (`#__next-route-announcer__`) also carries `role="alert"`,
  // so scope to the fallback's own message text rather than the bare role.
  await expect(page.getByText(/Kamerazugriff wurde verweigert/)).toBeVisible();

  const captureInput = page.locator('input[type="file"][capture="environment"]');
  await captureInput.setInputFiles(FALLBACK_PHOTO_FILE);

  await confirmCapturedPage(page);
  await expect(page.getByRole("list", { name: "Erfasste Seiten" }).getByRole("listitem")).toHaveCount(1);

  await page.getByRole("button", { name: "Hochladen", exact: true }).click();

  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);
  await expect(page.getByText(adminUser.workspace.name).first()).toBeVisible();
});
