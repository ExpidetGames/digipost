// The narrow composition seam for unauthenticated public paths
// (WEBAPP_TEMPLATE_SPEC.md §5.8, decisions/0004-three-database-roles.md). Only this
// file and `src/persistence/foundation/**` may use the public connection
// (`getPublicDb()`, `DATABASE_URL_PUBLIC`, the `app_public` role): a bug in an
// unauthenticated path must never be able to reach anything this seam does not
// explicitly expose.
//
// No unauthenticated public path exists in this template yet, so this graph is
// empty. The first one (e.g. reading a table served without a session, or a public
// rate-limit table) adds its repository/use case here, never through
// `createRequestServices` (that graph runs as `app_runtime`, a wider-privileged
// role than a public path should get).
import "server-only";

import { cache } from "react";

export function createPublicServices() {
  return {};
}

export type PublicServices = ReturnType<typeof createPublicServices>;

/** The one allowed `cache(createPublicServices)`, mirroring `request-services.ts`. */
export const getPublicServices = cache(createPublicServices);
