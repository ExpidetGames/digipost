import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Security headers (WEBAPP_TEMPLATE_SPEC.md §8), applied to every route via next.config.ts
// (not src/proxy.ts: a static policy here needs no per-request nonce machinery). Compatible with
// next-intl, Better Auth (same-origin fetches under /api/auth/**, no third-party script), and
// Sentry (its browser SDK only needs `connect-src` to its ingest endpoint, added below).
//
// `script-src`/`style-src` keep `'unsafe-inline'` even in production: Next's own App Router
// streams Suspense boundary content (e.g. `loading.tsx`, WEBAPP_TEMPLATE_SPEC.md §8) back in
// via inline `<script>` tags at request time, in every environment, not only dev - this is
// Next's own documented "Without Nonces" CSP recipe
// (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md). A stricter,
// nonce-based policy is possible but needs src/proxy.ts to mint a per-request nonce and forces
// every page to dynamic rendering (that same doc's "Static vs Dynamic Rendering with CSP"),
// which would undo the marketing pages' static prerendering (WEBAPP_TEMPLATE_SPEC.md §8) -
// not a tradeoff this template makes by default. `'unsafe-eval'` is dev-only (React's
// server-error-stack reconstruction, same doc).
//
// `'wasm-unsafe-eval'` (in every environment, not only dev - unlike `'unsafe-eval'` above) is
// required by `src/modules/scanner` (P2c): it lazy-loads `scanic` for camera-based document
// edge detection/perspective correction, whose classical detector ships its WASM module
// base64-inlined in scanic's own JS bundle and instantiates it via
// `WebAssembly.instantiate(bytes, ...)` (confirmed by inspecting
// node_modules/scanic/dist/scanic.js directly - not documented by scanic itself). Per the CSP
// Level 3 spec that call needs `wasm-unsafe-eval` in `script-src`; Chrome currently tolerates
// it without the token but Firefox/Safari enforce it, so this is a real cross-browser
// requirement, not a defensive extra. `wasm-unsafe-eval` only permits WebAssembly
// compilation/instantiation, never arbitrary `eval`/`new Function`, so it does not reopen the
// door `'unsafe-eval'` being dev-only was closing. See
// src/modules/scanner/README.md's "CSP changes and why" for the full reasoning, including why
// no `connect-src`/`worker-src` change was needed alongside it.
//
// `connect-src` includes Sentry's ingest origin unconditionally (not only when a DSN is
// configured): this is a static, build-time policy (src/proxy.ts mints no nonce, see above), so
// gating it on an env value would need the same per-request machinery this template
// deliberately avoids. An unused allowance in the CSP is not itself a leak - Sentry's browser
// SDK (src/instrumentation-client.ts) only ever calls it when NEXT_PUBLIC_SENTRY_DSN is set
// (src/platform/observability's sentryInitOptions, "no DSN, zero instrumentation").
//
// `frame-ancestors 'self'` (not `'none'`, decisions/0015-documents-and-quotas.md): the
// document detail page (`/dashboard/documents/[id]`) embeds its own PDF via a same-origin
// `<iframe src="/api/documents/[id]/file">`. `frame-ancestors` governs whether the *framed*
// response (this policy applies to every route, including that file-streaming one) may be
// embedded by a parent document at all, so `'none'` would block that iframe from rendering
// its own app's PDF. `'self'` keeps this as strict as possible while still allowing that:
// only a page on this same origin may frame any response from it, no third party ever can.
const isDev = process.env.NODE_ENV === "development";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://*.sentry.io",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// `camera=(self)` (P2c, src/modules/scanner): this repository's first camera consumer
// (`getUserMedia` for the "Kamera" tab's live preview). `camera=()` unconditionally blocks
// `getUserMedia` for every origin, including this app's own, so it had to change; `(self)`
// allows only this exact origin - never a third-party iframe - to request the camera, the
// narrowest allowance that still lets the app use it. Every other directive is unchanged.
const PERMISSIONS_POLICY = [
  "camera=(self)",
  "microphone=()",
  "geolocation=()",
  "browsing-topics=()",
  "interest-cohort=()",
].join(", ");

// Next blocks cross-origin requests to dev-only resources (HMR, dev chunks) from any host but
// the one it started on, which leaves a page served through a tunnel (APP_URL pointing at e.g.
// a Cloudflare quick tunnel) unhydrated: forms fall back to a native GET submit. Allowing
// APP_URL's own hostname fixes that; dev-only, ignored by `next build`.
const devAppHost = isDev && process.env.APP_URL ? new URL(process.env.APP_URL).hostname : null;

const nextConfig: NextConfig = {
  ...(devAppHost && devAppHost !== "localhost" ? { allowedDevOrigins: [devAppHost] } : {}),
  // Sentry's browser SDK (src/instrumentation-client.ts) needs its DSN inlined into the
  // client bundle, same as any NEXT_PUBLIC_* value - but `.env.example` only names the
  // one, server-style `SENTRY_DSN` (src/platform/observability), so it is mirrored here
  // instead of duplicating the variable. `env` values are inlined at build time;
  // `undefined` here (no SENTRY_DSN) becomes `undefined` in the bundle, same as any
  // other unset NEXT_PUBLIC_* var - `sentryInitOptions` treats that as "no DSN".
  env: {
    NEXT_PUBLIC_SENTRY_DSN: process.env.SENTRY_DSN,
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
          // `max-age` only: no `includeSubDomains`, no `preload`. Both commit every current
          // and future subdomain of the deploying domain to HTTPS-only and are very hard to
          // undo (`preload` ships inside browsers themselves; removal can take months to
          // propagate) - too aggressive a default for a template that does not know a
          // project's subdomain layout. See README.md's "Security headers" section for when
          // and how a project opts into either.
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
        ],
      },
    ];
  },
};

const configWithIntl = withNextIntl(nextConfig);

/**
 * Source map upload: only wrap the config with `withSentryConfig` when
 * `SENTRY_AUTH_TOKEN` is set - CI, the Docker test stack and local dev never set it,
 * so `next build` there gets `configWithIntl` back untouched, with zero chance of the
 * Sentry build plugin (network calls to Sentry, `@sentry/cli`) breaking or slowing
 * down the build. `org`/`project` are read from `SENTRY_ORG`/`SENTRY_PROJECT` by the
 * plugin itself if set; neither is required by `.env.example` since a project only
 * needs source maps when explicitly opted into for a specific deploy (README "Start a
 * new project from this template").
 */
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(configWithIntl, {
      silent: true,
      telemetry: false,
    })
  : configWithIntl;
