/**
 * Pins the security headers `next.config.ts` sends on every route
 * (WEBAPP_TEMPLATE_SPEC.md §8, "Security-Header ... zentral in next.config.ts, per
 * E2E-Test abgesichert"). `tests/e2e/marketing.spec.ts` proves these headers reach a real
 * response but only checks a loose subset (e.g. `Strict-Transport-Security` just
 * `toContain("max-age=")`); this unit test pins the exact values, in particular that
 * HSTS ships without `includeSubDomains`/`preload` by default (README.md's "Security
 * headers" section explains why and how a project opts into either), so a change here
 * is a deliberate, reviewed diff instead of a silent drift.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("next.config.ts security headers", () => {
  it("sends the expected security headers on every route", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);

    const [{ source, headers }] = rules;
    expect(source).toBe("/(.*)");

    const byKey = Object.fromEntries(headers.map(({ key, value }) => [key, value]));

    expect(byKey["Content-Security-Policy"]).toContain("default-src 'self'");
    // 'self', not 'none' (decisions/0015-documents-and-quotas.md): the document detail page
    // embeds its own PDF via a same-origin iframe, which needs every route's own response -
    // including the file-streaming one - to allow being framed by this same origin.
    expect(byKey["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
    expect(byKey["Content-Security-Policy"]).toContain("connect-src 'self' https://*.sentry.io");
    // `wasm-unsafe-eval` (src/modules/scanner, P2c): scanic's classical detector instantiates
    // its base64-inlined WASM module via `WebAssembly.instantiate`, which needs this token
    // under a CSP Level 3-enforcing browser (Firefox/Safari) - see next.config.ts's comment
    // and src/modules/scanner/README.md's "CSP changes and why".
    expect(byKey["Content-Security-Policy"]).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    // `camera=(self)`, not `camera=()` (src/modules/scanner, P2c): the "Kamera" tab's live
    // preview needs `getUserMedia` from this app's own origin; every other directive is
    // unchanged.
    expect(byKey["Permissions-Policy"]).toContain("camera=(self)");
    // The template default: HSTS with `max-age` only, no `includeSubDomains`, no
    // `preload` (both are hard to undo and this template does not know a project's
    // subdomain layout). README.md documents the opt-in.
    expect(byKey["Strict-Transport-Security"]).toBe("max-age=63072000");
  });
});
