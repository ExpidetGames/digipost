// Neutral validation for the sign-in form's input (WEBAPP_TEMPLATE_SPEC.md §2.5:
// every boundary is parsed with Zod). Better Auth validates the address again
// server-side; this only produces a normalized value and a stable `invalid_email`
// error code before the request ever reaches it.
import { z } from "zod";

export const magicLinkEmailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());
