// Zod input schemas for `src/modules/billing/actions.ts`'s two Server Actions
// (decisions/0017-billing-tiers-and-packages.md).
import { z } from "zod";

import { PACKAGE_KEYS, TIERS } from "./plans";

export const changeTierInputSchema = z.object({
  tier: z.enum(TIERS),
});

export const purchasePackageInputSchema = z.object({
  packageKey: z.enum(PACKAGE_KEYS),
});
