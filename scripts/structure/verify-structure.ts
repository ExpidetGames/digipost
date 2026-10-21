#!/usr/bin/env node
/**
 * `pnpm verify:structure` - interprets STRUCTURE.md's ```structure blocks
 * (STRUCTURE.md §0) and runs every rule in `scripts/structure/rules/` against the
 * repository. Exit 1 on any violation, any stale exception, or any block/rule-name
 * asymmetry (a block with no implementing rule, or a rule with none of its blocks
 * present - STRUCTURE.md §0/§11.5's "a block keyword without an implementation and
 * an implementation without a block are both hard errors").
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStructureDoc } from "./lib/doc-parser";
import { filterExceptions, parseExceptions, staleExceptions } from "./lib/exceptions";
import type { Violation } from "./lib/repo";
import type { Rule } from "./lib/rule";

import { rootsRule } from "./rules/roots";
import { ownerInternalsRule } from "./rules/owner-internals";
import { entrypointsRule } from "./rules/entrypoints";
import { directionRule } from "./rules/direction";
import { persistenceRule } from "./rules/persistence";
import { requestServicesRule } from "./rules/request-services";
import { appSeamsRule } from "./rules/app-seams";
import { testsRule } from "./rules/tests";
import { documentationRule } from "./rules/documentation";
import { envAccessRule } from "./rules/env-access";
import { vendorSdkRule } from "./rules/vendor-sdk";
import { e2eRule } from "./rules/e2e";

export const RULES: Rule[] = [
  rootsRule,
  ownerInternalsRule,
  entrypointsRule,
  directionRule,
  persistenceRule,
  requestServicesRule,
  appSeamsRule,
  testsRule,
  documentationRule,
  envAccessRule,
  vendorSdkRule,
  e2eRule,
];

/** Block names that are data for rules, not a rule of their own. */
const NON_RULE_BLOCKS = new Set(["exceptions"]);

export function symmetryErrors(blockNames: Set<string>, rules: Rule[]): string[] {
  const errors: string[] = [];
  const claimedBlocks = new Set(rules.flatMap((r) => r.blockNames));

  for (const name of blockNames) {
    if (NON_RULE_BLOCKS.has(name)) continue;
    if (!claimedBlocks.has(name)) {
      errors.push(`\`\`\`structure ${name}\`\`\` block has no implementing rule in scripts/structure/rules/`);
    }
  }
  for (const rule of rules) {
    if (!rule.blockNames.some((b) => blockNames.has(b))) {
      errors.push(`rule "${rule.name}" is implemented but STRUCTURE.md has none of its blocks (${rule.blockNames.join(", ")})`);
    }
  }
  return errors;
}

export function runChecker(structureMdPath: string, root: string): { ok: boolean; output: string[] } {
  const doc = parseStructureDoc(structureMdPath);
  const output: string[] = [];
  let ok = true;

  const symErrors = symmetryErrors(doc.names, RULES);
  if (symErrors.length) {
    ok = false;
    for (const e of symErrors) output.push(`STRUCTURE.md: registry: ${e}`);
  }

  const exceptions = parseExceptions(doc);
  const stale = staleExceptions(exceptions, root);
  if (stale.length) {
    ok = false;
    for (const e of stale) {
      output.push(`STRUCTURE.md: exceptions: stale exception "${e.pattern}" matches nothing in the repository anymore`);
    }
  }

  let violations: Violation[] = [];
  for (const rule of RULES) {
    violations.push(...rule.run(doc, { root }));
  }
  violations = filterExceptions(violations, exceptions);
  violations.sort((a, b) => (a.file === b.file ? a.message.localeCompare(b.message) : a.file.localeCompare(b.file)));

  if (violations.length) {
    ok = false;
    for (const v of violations) output.push(`${v.file}: ${v.rule}: ${v.message}`);
  }

  return { ok, output };
}

function main(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "../..");
  const structureMdPath = path.join(root, "STRUCTURE.md");

  const { ok, output } = runChecker(structureMdPath, root);
  for (const line of output) console.error(line);

  if (ok) {
    console.log(`verify:structure: ok (${RULES.length} rules, 0 violations)`);
    process.exit(0);
  } else {
    console.error(`verify:structure: ${output.length} problem(s)`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported by the fixture tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
