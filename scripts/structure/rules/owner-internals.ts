/**
 * STRUCTURE.md §2: inside src/modules/<owner>/, src/shared/<owner>/, src/platform/<owner>/, a
 * directory name on the block's `forbid` list is a violation at any depth; every
 * directory (any name) must be non-empty.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { isDirEmpty, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";

const OWNER_CONTAINERS = ["src/modules", "src/shared", "src/platform"];

function parseBlock(doc: StructureDoc): { allow: Set<string>; forbid: Set<string> } {
  const allow = new Set<string>();
  const forbid = new Set<string>();
  for (const line of nonBlankLines(doc, "owner-internals")) {
    const [kind, name] = line.trim().split(/\s+/);
    if (kind === "allow") allow.add(name);
    else if (kind === "forbid") forbid.add(name);
  }
  return { allow, forbid };
}

function walk(dir: string, forbid: Set<string>, root: string, violations: Violation[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(dir, entry.name);
    const rel = path.relative(root, p).split(path.sep).join("/");
    if (forbid.has(entry.name)) {
      violations.push({
        rule: "owner-internals",
        file: rel,
        message: `forbidden owner-internal directory name "${entry.name}" (STRUCTURE.md §2)`,
      });
    }
    if (isDirEmpty(p)) {
      violations.push({ rule: "owner-internals", file: rel, message: "empty directory under an owner (STRUCTURE.md §2)" });
    }
    walk(p, forbid, root, violations);
  }
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const { forbid } = parseBlock(doc);
  const violations: Violation[] = [];
  for (const container of OWNER_CONTAINERS) {
    const containerPath = path.join(ctx.root, container);
    if (!existsSync(containerPath) || !statSync(containerPath).isDirectory()) continue;
    for (const owner of readdirSync(containerPath, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      walk(path.join(containerPath, owner.name), forbid, ctx.root, violations);
    }
  }
  return violations;
}

export const ownerInternalsRule: Rule = { name: "owner-internals", blockNames: ["owner-internals"], run };
