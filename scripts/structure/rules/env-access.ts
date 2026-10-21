/**
 * STRUCTURE.md §10: `src/platform/env` is the only owner allowed to read `process.env`
 * for a named, sensitive variable at request time; a small, explicit exemption list
 * covers the root-level config and `src/` instrumentation files Next.js/Sentry conventions
 * require to read a var directly (`next.config.ts`, `drizzle.config.ts`,
 * `instrumentation*.ts`, the three Sentry root files per decisions/0009), plus
 * tooling (`scripts/**`, the `tests/` root, any owner-local `tests/`-segment path,
 * test/build configuration, `.env*`).
 */
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { readCached, toPosix, underDir, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { isToolingFile, repoSourceFiles } from "../lib/module-graph";

type EnvRow = { name: string; prefixes: string[] };

function parseBlock(doc: StructureDoc): EnvRow[] {
  return nonBlankLines(doc, "env-access").map((line) => {
    const [name, ...rest] = line.trim().split(/\s+/);
    const prefixes = rest.join(" ").split(",").map((p) => p.trim()).filter(Boolean);
    return { name, prefixes };
  });
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const rows = parseBlock(doc);
  const violations: Violation[] = [];

  for (const file of repoSourceFiles(ctx.root)) {
    const rel = toPosix(ctx.root, file);
    if (isToolingFile(rel)) continue;
    const source = readCached(file);
    for (const row of rows) {
      if (!source.includes(`process.env.${row.name}`)) continue;
      const allowed = row.prefixes.some((p) => underDir(rel, p) || rel === p);
      if (!allowed) {
        violations.push({
          rule: "env-access",
          file: rel,
          message: `"${row.name}" is read here but is only allowed in ${row.prefixes.join(", ")} (STRUCTURE.md §10)`,
        });
      }
    }
  }

  return violations;
}

export const envAccessRule: Rule = { name: "env-access", blockNames: ["env-access"], run };
