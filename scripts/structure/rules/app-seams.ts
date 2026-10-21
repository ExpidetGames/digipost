/**
 * STRUCTURE.md §7: every file under src/app/** must have one of the declared Next.js
 * convention basenames. Directory/route-segment names are unrestricted (Next's own
 * router governs those).
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { toPosix, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const allowed = new Set(nonBlankLines(doc, "app-seams").map((l) => l.trim()));
  const violations: Violation[] = [];

  // Non-.ts/.tsx assets (favicon.ico, icon.svg, globals.css) never show up in
  // repoSourceFiles() (it only walks JS/TS extensions), so this rule walks src/app/
  // directly instead.
  const appDir = path.join(ctx.root, "src", "app");
  if (!existsSync(appDir)) return violations;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      // Next's own "private folder" convention: any path segment starting with `_`
      // is excluded from routing, used for co-located route helpers that are not
      // themselves a seam.
      if (toPosix(ctx.root, p).split("/").some((seg) => seg.startsWith("_"))) continue;
      if (!allowed.has(entry.name)) {
        violations.push({
          rule: "app-seams",
          file: toPosix(ctx.root, p),
          message: `"${entry.name}" is not a declared Next.js convention filename (STRUCTURE.md §7)`,
        });
      }
    }
  };
  walk(appDir);
  return violations;
}

export const appSeamsRule: Rule = { name: "app-seams", blockNames: ["app-seams"], run };
