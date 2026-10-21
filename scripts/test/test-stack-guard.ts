// Vitest setup file for the `db` and `integration` projects only (vitest.config.ts), the
// same role `unit-guard.ts` plays for the `unit` project. Earlier agents ran
// `pnpm test:db`/`pnpm test:int` directly on the host, against `docker/compose.yml`'s local
// dev Postgres, and wrote test data into it - there was nothing stopping that. This makes it
// impossible: both projects now refuse to run at all unless `DIGIPOST_TEST_STACK=1` is set.
// `docker/compose.test.yml`'s `x-app-env` sets it for you, so `pnpm test:docker` (the
// hermetic Docker test stack, decisions/0006-docker-test-stack-as-reference.md, the only
// supported way to run these two projects) always has it; running `pnpm test:db`/
// `pnpm test:int` directly on the host never does, and now fails immediately with an
// actionable message instead of silently writing to whatever database the ambient
// `DATABASE_URL`/`DATABASE_URL_PUBLIC`/`DATABASE_URL_MIGRATE` happen to point at.
//
// `pnpm test` (the `unit` project) is unaffected: it never loads this file.
if (process.env.DIGIPOST_TEST_STACK !== "1") {
  throw new Error(
    "pnpm test:db and pnpm test:int must only run inside the hermetic Docker test stack " +
      "(docker/compose.test.yml sets DIGIPOST_TEST_STACK=1 for you). Run `pnpm test:docker` " +
      "instead - never run these two commands directly against your local dev database " +
      "(docker/compose.yml).",
  );
}
