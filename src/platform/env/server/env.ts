// Owner: src/platform/env. Privileged: only imported from src/platform/env/server.ts.
import "server-only";

import { z } from "zod";

const ServerEnv = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  // Only present once a project has an unauthenticated public path that needs its own,
  // narrowly-privileged connection (decisions/0004-three-database-roles.md).
  DATABASE_URL_PUBLIC: z.url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  // smtp(s)://user:pass@host:port
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  CRON_SECRET: z.string().min(32),
  // Object storage (src/platform/object-storage, decisions/0012-object-storage.md): the
  // only other reader of these variables. S3_ENDPOINT is optional (unset means the AWS
  // default endpoint for S3_REGION; set for MinIO, Cloudflare R2, etc).
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  // Optional boolean, default false; "true" for MinIO. z.coerce.boolean() would treat
  // the string "false" as truthy, so this is parsed explicitly instead.
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  // AI (src/platform/mistral, decisions/0016-processing-pipeline-and-ai.md): the only other
  // reader of MISTRAL_API_KEY. AI_PROVIDER picks the adapter explicitly ("mistral" | "fake");
  // when unset, the composition root defaults to "mistral" once a key is present, otherwise
  // to a deterministic fake outside production, and to a hard `ai_not_configured` failure in
  // production (a misconfigured production deploy must never silently fall back to fake
  // data). MISTRAL_OCR_MODEL/MISTRAL_CHAT_MODEL default to Mistral's own model names when unset.
  MISTRAL_API_KEY: z.string().min(1).optional(),
  AI_PROVIDER: z.enum(["mistral", "fake"]).optional(),
  MISTRAL_OCR_MODEL: z.string().min(1).optional(),
  MISTRAL_CHAT_MODEL: z.string().min(1).optional(),
  // Billing (src/modules/billing, decisions/0017-billing-tiers-and-packages.md): no Stripe
  // keys exist (architecture brief's product decision 3), so a tier change or package
  // purchase only works when this is explicitly "true" - local dev and the hermetic test
  // stack set it, production never does. Optional boolean, default false; parsed like
  // S3_FORCE_PATH_STYLE (z.coerce.boolean() would treat the string "false" as truthy).
  BILLING_TEST_MODE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  SENTRY_DSN: z.url().optional(),
  // decisions/0074-sign-up-by-invitation-only.md: new accounts need a pending invitation. This
  // comma-separated list is the one exception, for the first admin of a fresh database whom
  // nobody can invite yet. Leave it empty once that admin exists.
  AUTH_BOOTSTRAP_EMAILS: z.string().optional(),
  // Set only by the deploy workflow's build step (.github/workflows/deploy-production.yml,
  // WEBAPP_TEMPLATE_SPEC.md §13.4), never locally: the commit SHA being deployed, so
  // GET /api/health can report it and the post-deploy check can confirm the running
  // build is the one that was just pushed. Optional so `next build`/tests never need it.
  APP_COMMIT_SHA: z.string().optional(),
});

export type ServerEnv = z.infer<typeof ServerEnv>;

let cached: ServerEnv | undefined;

/**
 * Next.js loads `KEY=` (a variable declared with no value, `.env.example`'s own convention
 * for every optional variable: `MISTRAL_OCR_MODEL=`, `SENTRY_DSN=`, ...) as `process.env.KEY
 * === ""`, never `undefined` - so `cp .env.example .env.local` followed by filling in only
 * the variables the README calls out as required left every OTHER optional field as an
 * empty string. `z.string().min(1).optional()`/`z.url().optional()`/an optional `z.enum(...)`
 * all reject `""` (it is a defined value, just an invalid one for those schemas), so the
 * whole `ServerEnv.parse` threw and every request 500'd (D4, P7's defect list) even though
 * every one of those variables is legitimately optional.
 *
 * Blanking every empty string to `undefined` before validation, once, here, fixes this for
 * every optional field uniformly (a shared helper rather than an `.optional()` fix repeated
 * per field, which would be easy to forget on the next one added). A REQUIRED field is
 * unaffected in the only way that matters: turning its `""` into `undefined` changes the
 * resulting Zod error from "invalid format" to "required" - it still throws, exactly as
 * before (proven by `tests/env.test.ts`'s per-required-field cases, run with `""` as well as
 * with the key entirely absent).
 */
function blankStringsToUndefined(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value === "" ? undefined : value;
  }
  return result;
}

/**
 * Lazily validated: only parsed on first access, so `next build` and unit tests that
 * never touch a privileged code path can run without every runtime secret set.
 */
export function serverEnv(): ServerEnv {
  return (cached ??= ServerEnv.parse(blankStringsToUndefined(process.env)));
}

/** Test-only: clears the cache so a test can re-validate against a different env. */
export function resetServerEnvCacheForTests(): void {
  cached = undefined;
}
