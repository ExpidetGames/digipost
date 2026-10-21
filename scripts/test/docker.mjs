#!/usr/bin/env node
// node scripts/test/docker.mjs <service> [extra args for the service's command]
// (behind `pnpm test:docker` -> "tests", `pnpm test:e2e:docker` -> "e2e"; extra CLI
// args after `--` are forwarded, e.g. `pnpm test:e2e:docker -- --grep @smoke`)
//
// Runs one service of the hermetic Docker test stack (docker/compose.test.yml):
//   docker compose -f docker/compose.test.yml --project-directory <root> -p <project> run --rm --build <service> [args]
// and always tears the whole stack down afterwards with
//   docker compose -f docker/compose.test.yml --project-directory <root> -p <project> down -v
// (`--project-directory` so the compose file's relative paths resolve against the
// repository root, not against docker/ where the file lives)
// - on normal completion, on a failing service, and on SIGINT/SIGTERM (Ctrl-C) - so
// a killed or crashed run never leaves containers/volumes behind for the next one.
// Exits with the service's own exit code (130 on a signal), not the cleanup
// command's (decisions/0006-docker-test-stack-as-reference.md).
//
// Per-checkout isolation: <project> defaults to
// `digipost-test-<sha1(repo root path)>` (first 10 hex chars), so two git
// worktrees of this repo - each with a different absolute path - get their own
// containers/networks/volumes and never collide, without either of them touching
// the other's resources. Override with $WEBAPP_TEMPLATE_TEST_PROJECT.
//
// The `e2e` service's image must match the repo's exact `@playwright/test` version
// (docker/compose.test.yml's PLAYWRIGHT_VERSION build arg) - read from the installed
// package, not hardcoded, and passed via the child's environment (compose
// substitutes ${PLAYWRIGHT_VERSION} from its own process env, no .env file
// involved).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE_FILE = join(ROOT, "docker", "compose.test.yml");

const [service, ...rawExtraArgs] = process.argv.slice(2);
// `pnpm test:e2e:docker -- --grep @smoke` keeps the literal `--` in argv (unlike a
// plain `npm run`) - drop one leading `--` so it doesn't end up as a literal
// argument to `docker compose run` (where it gets misinterpreted as end-of-options
// for docker's own CLI, silently swallowing everything after it and running the
// full suite instead of the filtered one).
const extraArgs = rawExtraArgs[0] === "--" ? rawExtraArgs.slice(1) : rawExtraArgs;
if (!service) {
  console.error("usage: node scripts/test/docker.mjs <service> [extra args]");
  process.exit(2);
}

const PROJECT =
  process.env.WEBAPP_TEMPLATE_TEST_PROJECT ||
  `digipost-test-${createHash("sha1").update(ROOT).digest("hex").slice(0, 10)}`;

/**
 * Exact resolved `@playwright/test` version - what the `e2e` service's image must
 * match. Read from `pnpm-lock.yaml` first, so lean CI jobs (Docker only, no `pnpm
 * install`) work; fall back to the installed package.
 */
function playwrightVersion() {
  try {
    const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    const match = lock.match(/'@playwright\/test':\s*\n\s*specifier:[^\n]*\n\s*version:\s*([0-9][0-9A-Za-z.+-]*)/);
    if (match) return match[1];
  } catch {
    // fall through to node_modules
  }
  const pkgPath = join(ROOT, "node_modules", "@playwright", "test", "package.json");
  try {
    const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (typeof version !== "string" || !version) throw new Error("no version field");
    return version;
  } catch (err) {
    throw new Error(`could not find the @playwright/test version in pnpm-lock.yaml or ${pkgPath} (${err.message})`);
  }
}

// docker/compose.test.yml interpolates every service's `args:` (including `e2e`'s) up
// front, regardless of which service is actually run - so this must be set even
// for e.g. `tests`, not only when service === "e2e".
const childEnv = { ...process.env };
try {
  childEnv.PLAYWRIGHT_VERSION = playwrightVersion();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { cwd: ROOT, stdio: "inherit", env: childEnv });
    child.on("error", (err) => {
      console.error(`docker ${args[0]}: failed to start (${err.message})`);
      resolve(1);
    });
    child.on("close", (code, signal) => {
      resolve(signal ? 128 : (code ?? 1));
    });
  });
}

function composeArgs(...rest) {
  return ["compose", "-f", COMPOSE_FILE, "--project-directory", ROOT, "-p", PROJECT, ...rest];
}

async function cleanup() {
  const args = composeArgs("down", "-v");
  console.log(`\n> docker ${args.join(" ")}`);
  await run(args);
}

let cleaningUp = false;

async function cleanupAndExit(code) {
  if (cleaningUp) return;
  cleaningUp = true;
  await cleanup();
  process.exit(code);
}

// Ctrl-C / a container orchestrator's SIGTERM: still run `down -v` before exiting,
// same as a normal failure - only cleanup() itself is allowed to run uninterrupted
// on a repeat signal.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void cleanupAndExit(130);
  });
}

let exitCode = 1;
try {
  const runArgs = composeArgs("run", "--rm", "--build", service, ...extraArgs);
  console.log(`> docker ${runArgs.join(" ")}  (project ${PROJECT})`);
  exitCode = await run(runArgs);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  if (!cleaningUp) {
    cleaningUp = true;
    await cleanup();
  }
}

process.exit(exitCode);
