// Env for host-mode e2e (`pnpm test:e2e`, playwright.config.ts): loads `.env.local`
// (docker/compose.yml's local Postgres/Mailpit) into `process.env`, never overriding a
// variable already set (CI sets the environment directly). The Docker test stack
// (`pnpm test:e2e:docker`) never calls this: docker/compose.test.yml sets every variable
// directly.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");

export function loadLocalEnv(): void {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^"(.*)"$/, "$1");
  }
}

/** Required env var (data factories, Mailpit/BETTER_AUTH_SECRET helpers) - throws with a clear message if missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (expected in .env.local or the Docker test stack's env).`);
  return value;
}

/** Optional env var with a default (e.g. MAILPIT_API_URL's host-mode default). */
export function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
