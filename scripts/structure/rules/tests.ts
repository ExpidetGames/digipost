/**
 * STRUCTURE.md §8: `.spec.ts` under tests/e2e/ (excluding helpers/), `.integration.test.ts`
 * under tests/integration/, `.test.ts`/`.test.tsx` everywhere else a `tests/` path
 * segment appears (excluding declared exempt subpaths), and no test-suffixed file
 * living outside any of those placements - except a `route.test.ts` file directly
 * beside its `route.ts` under `src/app/` (STRUCTURE.md §7's own `app-seams` block already
 * governs exactly which basenames may exist there; a name declared allowed by that
 * block is this rule's one deliberate exemption for co-located route-handler
 * access-step unit tests, matching actual template practice - the `projects` example
 * module's `src/app/api/cron/purge-archived-projects/route.test.ts` was this rule's worked
 * example until P1 removed that module (`decisions/0014-workspaces-and-access.md`); a
 * later phase's cron route reintroduces one).
 */
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { toPosix, underDir, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { repoSourceFiles } from "../lib/module-graph";

type ScopedSuffix = { suffix: string; scope: string };

type Config = { scoped: ScopedSuffix[]; defaultSuffix: string; exempt: string[] };

function parseBlock(doc: StructureDoc): Config {
  const scoped: ScopedSuffix[] = [];
  let defaultSuffix = ".test.ts";
  const exempt: string[] = [];
  for (const line of nonBlankLines(doc, "tests")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "suffix" && parts[2] === "*") defaultSuffix = parts[1];
    else if (parts[0] === "suffix") scoped.push({ suffix: parts[1], scope: parts[2] });
    else if (parts[0] === "exempt") exempt.push(parts[1]);
  }
  return { scoped, defaultSuffix, exempt };
}

/** `foo.integration.test.ts` -> `.integration.test.ts`-suffix match, etc. Compares
 *  against the extension-stripped basename so `.test.ts` and `.test.tsx` both count
 *  as "the `.test.ts` family" (and likewise for `.spec.ts`/`.spec.tsx`). */
function endsWithSuffix(rel: string, suffix: string): boolean {
  let base: string;
  if (rel.endsWith(".tsx")) base = rel.slice(0, -4);
  else if (rel.endsWith(".ts")) base = rel.slice(0, -3);
  else return false;
  return base.endsWith(suffix.replace(/\.ts$/, ""));
}

function isTestSuffixed(rel: string, cfg: Config): boolean {
  return endsWithSuffix(rel, cfg.defaultSuffix) || cfg.scoped.some((s) => endsWithSuffix(rel, s.suffix));
}

function hasTestsSegment(rel: string): boolean {
  return rel.split("/").includes("tests");
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const cfg = parseBlock(doc);
  const appSeamNames = new Set(nonBlankLines(doc, "app-seams").map((l) => l.trim()));
  const violations: Violation[] = [];

  for (const file of repoSourceFiles(ctx.root)) {
    const rel = toPosix(ctx.root, file);
    if (!(rel.endsWith(".ts") || rel.endsWith(".tsx"))) continue;
    if (cfg.exempt.some((e) => underDir(rel, e))) continue;

    const scopeMatch = cfg.scoped.find((s) => underDir(rel, s.scope));
    if (scopeMatch) {
      if (!endsWithSuffix(rel, scopeMatch.suffix)) {
        violations.push({
          rule: "tests",
          file: rel,
          message: `file under ${scopeMatch.scope}/ must use the ${scopeMatch.suffix} suffix (STRUCTURE.md §8)`,
        });
      }
      continue;
    }

    if (hasTestsSegment(rel)) {
      if (!endsWithSuffix(rel, cfg.defaultSuffix)) {
        violations.push({
          rule: "tests",
          file: rel,
          message: `file under a tests/ segment must use the ${cfg.defaultSuffix} suffix, or be named in the tests block's exempt list (STRUCTURE.md §8)`,
        });
      }
      continue;
    }

    // Outside any recognized test placement entirely.
    if (isTestSuffixed(rel, cfg) && !(rel.startsWith("src/app/") && appSeamNames.has(path.basename(rel)))) {
      violations.push({
        rule: "tests",
        file: rel,
        message: `test file "${rel}" is not under any recognized test root (STRUCTURE.md §8)`,
      });
    }
  }
  return violations;
}

export const testsRule: Rule = { name: "tests", blockNames: ["tests", "app-seams"], run };
