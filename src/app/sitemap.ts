import type { MetadataRoute } from "next";

import { publicEnv } from "@/platform/env";

// Only the statically prerendered, publicly indexable marketing routes
// (WEBAPP_TEMPLATE_SPEC.md §8: marketing pages never read cookies/session). /login and
// /dashboard are excluded: the former is a utility page, the latter requires a session.
// Uses the public entrypoint (`publicEnv`, not `serverEnv()`): this file is statically
// generated at build time, and `serverEnv()` requires every runtime secret to be set, which
// a build must not need (`src/platform/env/server/env.ts`'s lazy-validation comment).
export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv.appUrl;
  const lastModified = new Date();

  return [
    { url: base, lastModified, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/legal-notice`, lastModified, changeFrequency: "yearly", priority: 0.2 },
    { url: `${base}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.2 },
  ];
}
