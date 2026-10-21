// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3). Proves the two request-time
// roles are exactly as privileged as decisions/0004-three-database-roles.md says:
// `app_runtime` (DATABASE_URL) has DML but no DDL, `app_public` (DATABASE_URL_PUBLIC)
// has neither yet (no unauthenticated public path exists in this template).
//
// Connects directly with `pg`, not through src/persistence/foundation/client.ts: this
// test's whole point is to exercise each role's raw privileges outside the app's
// own pool (which always connects as `app_runtime`). Reads DATABASE_URL* straight
// from the environment rather than `src/platform/env` for the same reason.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is not set (the db test project's env should provide it)`);
  return value;
}

describe("app_runtime (DATABASE_URL)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: requireEnv("DATABASE_URL") });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("has DML on the workspaces table", async () => {
    await expect(client.query("select 1 from workspaces limit 0")).resolves.toBeDefined();
  });

  it("cannot create a table (no DDL, decisions/0004-three-database-roles.md)", async () => {
    await expect(client.query("create table app_runtime_ddl_probe (id int)")).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot drop the workspaces table", async () => {
    await expect(client.query("drop table workspaces")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("app_public (DATABASE_URL_PUBLIC)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: requireEnv("DATABASE_URL_PUBLIC") });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("cannot read the workspaces table (no unauthenticated public path needs it yet)", async () => {
    await expect(client.query("select 1 from workspaces limit 0")).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot read the auth.user table either", async () => {
    await expect(client.query('select 1 from auth."user" limit 0')).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot create a table", async () => {
    await expect(client.query("create table app_public_ddl_probe (id int)")).rejects.toMatchObject({ code: "42501" });
  });
});
