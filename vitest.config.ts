import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

/**
 * Env for the `db`/`integration` projects: `.env.local` (points at `docker/compose.yml`'s
 * local Postgres/Mailpit). Variables already set in the process env (CI, the Docker
 * test stack) win. Both projects also refuse a DB host outside `LOCAL_ALLOWED_HOSTS`
 * below, whichever source set it.
 */
function loadLocalEnv(): Record<string, string> {
  const file = `${root}.env.local`;
  if (!existsSync(file)) return {};
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const out: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    out[key] = rawValue.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** Hosts a `db`/`integration` test run may connect to (WEBAPP_TEMPLATE_SPEC.md §10.6). */
const LOCAL_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);

function assertLocalHost(url: string | undefined, envVar: string): void {
  if (!url) return;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`${envVar} is not a valid connection string: ${url}`);
  }
  if (!LOCAL_ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `${envVar} points at host "${host}", which is not in the db/integration test allowlist ` +
        `(${[...LOCAL_ALLOWED_HOSTS].join(", ")}). Refusing to run against a non-local database.`,
    );
  }
}

const dbEnv = loadLocalEnv();
for (const envVar of ["DATABASE_URL", "DATABASE_URL_PUBLIC", "DATABASE_URL_MIGRATE"]) {
  assertLocalHost(dbEnv[envVar] ?? process.env[envVar], envVar);
}

export default defineConfig({
  resolve: {
    alias: {
      "@/": `${root}src/`,
      // `server-only` throws outside the react-server condition; make it a no-op in tests.
      "server-only": `${root}node_modules/server-only/empty.js`,
    },
  },
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "src/app/**/*.{ts,tsx}",
        "src/platform/**/*.{ts,tsx}",
        "src/shared/**/*.{ts,tsx}",
        "src/modules/**/*.{ts,tsx}",
        "src/persistence/**/*.{ts,tsx}",
      ],
    },
    projects: [
      {
        // `pnpm test`: no DB, no network (scripts/test/unit-guard.ts enforces this).
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.{ts,tsx}"],
          exclude: [
            "**/node_modules/**",
            ".next/**",
            // Git worktrees of parallel agents live here; they are separate checkouts.
            ".claude/**",
            "**/*.db.test.{ts,tsx}",
            "tests/integration/**",
            "tests/e2e/**",
          ],
          setupFiles: ["./scripts/test/unit-guard.ts"],
        },
      },
      {
        // `pnpm test:db` (host, against docker/compose.yml) / part of `pnpm test:docker`
        // (docker/compose.test.yml, the reference run, decisions/0006). Real Postgres,
        // WEBAPP_TEMPLATE_SPEC.md §10.1/§10.6: no file parallelism (tests share one
        // database), 30s timeout for the container/connection setup.
        extends: true,
        test: {
          name: "db",
          include: ["**/*.db.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", ".next/**", ".claude/**"],
          env: dbEnv,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Refuses to run outside the hermetic Docker test stack - see the file's own
          // header comment for why.
          setupFiles: ["./scripts/test/test-stack-guard.ts"],
        },
      },
      {
        // `pnpm test:int` (host) / part of `pnpm test:docker` (reference run).
        // Owner-crossing, route-handler, and wiring-level tests against real
        // Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1).
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.integration.test.{ts,tsx}"],
          env: dbEnv,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Same DIGIPOST_TEST_STACK=1 guard as the `db` project above.
          setupFiles: ["./scripts/test/test-stack-guard.ts"],
        },
      },
    ],
  },
});
