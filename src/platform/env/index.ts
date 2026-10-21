// Neutral entrypoint of the src/platform/env owner: public env only, safe to import from
// client-reachable code. `process.env.NEXT_PUBLIC_*` is referenced statically (not
// through a computed key or a loop) so Next.js can inline it into client bundles at
// build time; see WEBAPP_TEMPLATE_SPEC.md §9.
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
} as const;
