/**
 * STRUCTURE.md §1: only declared entries may exist directly under the repo root.
 * `docs/` is separately, always forbidden regardless of the block (STRUCTURE.md
 * §1/§9, DOC_RULES.md §1) - a defense-in-depth duplicate of the documentation rule's
 * own check.
 *
 * A declared entry with a path separator before its end (`src/app/`, `tests/e2e/`)
 * makes its parent a *governed* root: every direct child of `src/` or `tests/` must
 * then be declared too, so moving code under `src/` can never reintroduce a generic
 * `src/lib/` or `src/utils/` the top-level check would have caught.
 *
 * Scans what git tracks (`gitTrackedPaths`), not a raw `readdirSync` of the
 * filesystem: the latter also flags gitignored build/test artifacts (`.next/`,
 * `test-results/`, `playwright-report/`, a locally present `docs/` or `.env.local`,
 * ...) and anything merely uncommitted locally, none of which a fresh CI checkout -
 * what this rule is meant to police - would ever contain. Falls back to `readdirSync`
 * only when `root` is not inside a git working tree at all, so the rule still does
 * something sensible there rather than silently passing everything.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { gitTrackedPaths, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";

/** Top-level names, plus `<governed>/<child>` names for every governed root. */
function presentEntries(root: string, governed: Set<string>): Set<string> {
  const entries = new Set<string>();
  const tracked = gitTrackedPaths(root);
  if (tracked) {
    for (const rel of tracked) {
      const [top, child] = rel.split("/");
      entries.add(top);
      if (governed.has(top) && child !== undefined) entries.add(`${top}/${child}`);
    }
    return entries;
  }
  for (const top of readdirSync(root)) {
    entries.add(top);
    const dir = path.join(root, top);
    if (!governed.has(top) || !statSync(dir).isDirectory()) continue;
    for (const child of readdirSync(dir)) entries.add(`${top}/${child}`);
  }
  return entries;
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const declared = new Set(nonBlankLines(doc, "roots").map((l) => l.trim().replace(/\/$/, "")));
  const governed = new Set([...declared].filter((d) => d.includes("/")).map((d) => d.split("/")[0]));
  const violations: Violation[] = [];

  for (const name of presentEntries(ctx.root, governed)) {
    if (name === "docs") {
      violations.push({ rule: "roots", file: name, message: "top-level docs/ must never exist (DOC_RULES.md §1)" });
      continue;
    }
    if (!declared.has(name)) {
      const where = name.includes("/") ? `entry inside ${name.split("/")[0]}/` : "top-level entry";
      violations.push({
        rule: "roots",
        file: name,
        message: `undeclared ${where} "${name}" (not in STRUCTURE.md §1's roots block)`,
      });
    }
  }
  return violations;
}

export const rootsRule: Rule = { name: "roots", blockNames: ["roots"], run };
