/**
 * STRUCTURE.md §11: a vendor SDK package (prefix-matched specifier) may only be
 * imported from a declared owner path prefix. Tooling files are exempt.
 */
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { readCached, toPosix, underDir, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";
import { importSpecifiers, isToolingFile, repoSourceFiles } from "../lib/module-graph";

type SdkRow = { pkgPrefix: string; pathPrefixes: string[] };

function parseBlock(doc: StructureDoc): SdkRow[] {
  return nonBlankLines(doc, "vendor-sdk").map((line) => {
    const [pkgPrefix, ...rest] = line.trim().split(/\s+/);
    const pathPrefixes = rest.join(" ").split(",").map((p) => p.trim()).filter(Boolean);
    return { pkgPrefix, pathPrefixes };
  });
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const rows = parseBlock(doc);
  const violations: Violation[] = [];

  for (const file of repoSourceFiles(ctx.root)) {
    const rel = toPosix(ctx.root, file);
    if (isToolingFile(rel)) continue;
    const source = readCached(file);
    for (const spec of importSpecifiers(source)) {
      for (const row of rows) {
        if (!(spec === row.pkgPrefix || spec.startsWith(row.pkgPrefix))) continue;
        const allowed = row.pathPrefixes.some((p) => underDir(rel, p) || rel === p);
        if (!allowed) {
          violations.push({
            rule: "vendor-sdk",
            file: rel,
            message: `imports "${spec}" (matches vendor SDK "${row.pkgPrefix}") but is only allowed in ${row.pathPrefixes.join(", ")} (STRUCTURE.md §11)`,
          });
        }
      }
    }
  }
  return violations;
}

export const vendorSdkRule: Rule = { name: "vendor-sdk", blockNames: ["vendor-sdk"], run };
