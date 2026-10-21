import type { MetadataRoute } from "next";

import { publicEnv } from "@/platform/env";

// Marketing pages are public and indexable; the dashboard sits behind auth and API routes
// carry no content worth indexing, so both are disallowed. Uses the public entrypoint
// (`publicEnv`, not `serverEnv()`): this file is statically generated at build time, and
// `serverEnv()` requires every runtime secret to be set, which a build must not need
// (`src/platform/env/server/env.ts`'s lazy-validation comment).
export default function robots(): MetadataRoute.Robots {
  const base = publicEnv.appUrl;

  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/dashboard", "/api/"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
