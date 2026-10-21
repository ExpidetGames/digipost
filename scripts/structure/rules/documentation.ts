/**
 * STRUCTURE.md §9: governed docs must carry the metadata header keys and must never
 * contain a broken relative Markdown link; `docs/` must never exist anywhere in the
 * repo (defense-in-depth duplicate of the roots rule).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { expandGlob, listDirsRecursive, readCached, toPosix, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";

function parseBlock(doc: StructureDoc): { requires: string[]; keys: string[] } {
  const requires: string[] = [];
  const keys: string[] = [];
  for (const line of nonBlankLines(doc, "documentation")) {
    const [kw, ...rest] = line.trim().split(/\s+/);
    if (kw === "require") requires.push(rest.join(" "));
    else if (kw === "key") keys.push(line.trim().slice("key ".length));
  }
  return { requires, keys };
}

function markdownDocs(root: string, patterns: string[]): string[] {
  const files = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      for (const f of expandGlob(root, pattern)) files.add(f);
    } else if (existsSync(path.join(root, pattern))) {
      files.add(pattern);
    }
  }
  return [...files];
}

/**
 * DOC_RULES.md §4's metadata block convention: an optional `# Title` line, then
 * `Document type:` ... `Last verified:` (possibly several lines each for
 * `Scope`/`Canonical responsibility`/`Maintenance triggers`), then the document's
 * body starting at its first heading. Bounded by the first heading rather than a
 * blank line or a fixed line count - both are too fragile in practice.
 */
function metadataBlock(text: string): string {
  const lines = text.split("\n");
  const searchFrom = lines[0]?.startsWith("# ") ? 1 : 0;
  for (let i = searchFrom; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) return lines.slice(0, i).join("\n");
  }
  return text;
}

const LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;

function checkLinks(root: string, rel: string, violations: Violation[]): void {
  const text = readCached(path.join(root, rel));
  const dir = path.dirname(rel);
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1].trim();
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) continue;
    if (target.startsWith("#")) continue;
    const withoutFragment = target.split("#")[0];
    if (!withoutFragment) continue;
    const resolved = path.normalize(path.join(root, dir, withoutFragment));
    if (!existsSync(resolved)) {
      violations.push({
        rule: "documentation",
        file: rel,
        message: `broken relative link "${target}" (resolves to ${path.relative(root, resolved)}, STRUCTURE.md §9)`,
      });
    }
  }
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const { requires, keys } = parseBlock(doc);
  const violations: Violation[] = [];

  for (const rel of markdownDocs(ctx.root, requires)) {
    const text = readCached(path.join(ctx.root, rel));
    const head = metadataBlock(text);
    for (const key of keys) {
      if (!head.includes(key)) {
        violations.push({ rule: "documentation", file: rel, message: `missing metadata key "${key}" (STRUCTURE.md §9)` });
      }
    }
    checkLinks(ctx.root, rel, violations);
  }

  for (const dir of listDirsRecursive(ctx.root)) {
    if (path.basename(dir) === "docs") {
      violations.push({ rule: "documentation", file: toPosix(ctx.root, dir), message: "docs/ must never exist (DOC_RULES.md §1)" });
    }
  }

  return violations;
}

export const documentationRule: Rule = { name: "documentation", blockNames: ["documentation"], run };
