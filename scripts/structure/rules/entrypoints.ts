/**
 * STRUCTURE.md §3: directives/markers on index.ts/client.ts/server.ts/actions.ts (or
 * *-actions.ts), no empty entrypoints, extra owner-root files must be named in the
 * owner's README.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { nonBlankLines, type StructureDoc } from "../lib/doc-parser";
import { firstStatementLine, readCached, type Violation } from "../lib/repo";
import type { Rule, RuleContext } from "../lib/rule";

export const OWNER_CONTAINERS = ["src/modules", "src/shared", "src/platform"];
const KNOWN_NAMES = new Set(["index.ts", "client.ts", "server.ts", "actions.ts"]);

function requirementFor(basename: string, block: Map<string, string>): string | null {
  if (block.has(basename)) return block.get(basename)!;
  if (basename.endsWith("-actions.ts") && block.has("*-actions.ts")) return block.get("*-actions.ts")!;
  return null;
}

function checkDirective(file: string, rel: string, requirement: string, violations: Violation[]): void {
  const text = readCached(file);
  if (text.trim() === "") {
    violations.push({ rule: "entrypoints", file: rel, message: "empty entrypoint file (STRUCTURE.md §3)" });
    return;
  }
  const first = firstStatementLine(text);
  if (requirement === "neutral") {
    if (first === '"use client";' || first === "'use client';" || first === '"use server";' || first === "'use server';") {
      violations.push({ rule: "entrypoints", file: rel, message: `neutral entrypoint must not start with a client/server directive (found ${first})` });
    }
    if (/^import\s+["']server-only["']/m.test(text)) {
      violations.push({ rule: "entrypoints", file: rel, message: "neutral entrypoint must not import server-only" });
    }
  } else if (requirement === "use-client") {
    if (first !== '"use client";' && first !== "'use client';") {
      violations.push({ rule: "entrypoints", file: rel, message: `client entrypoint must start with "use client"; (found ${first ?? "nothing"})` });
    }
  } else if (requirement === "server-only") {
    // A literal import is the normal case; a file whose header comment merely
    // *mentions* the word is accepted too - a documented, deliberate omission
    // (STRUCTURE.md §3/§14). This is a weak check on purpose: it cannot tell a
    // genuine, considered omission from an accidental one that happens to mention
    // the word, but it catches the case that matters mechanically - a server.ts
    // that never considered the guard at all.
    if (!text.includes("server-only")) {
      violations.push({ rule: "entrypoints", file: rel, message: 'server entrypoint must import "server-only" (or document why not, mentioning "server-only")' });
    }
  } else if (requirement === "use-server") {
    if (first !== '"use server";' && first !== "'use server';") {
      violations.push({ rule: "entrypoints", file: rel, message: `actions entrypoint must start with "use server"; (found ${first ?? "nothing"})` });
    }
    checkActionsExports(text, rel, violations);
  }
}

const ALLOWED_EXPORT_STARTS = [/^export\s+type\b/, /^export\s+interface\b/, /^export\s+async\s+function\b/, /^export\s+function\b/, /^export\s*\{/];

function checkActionsExports(text: string, rel: string, violations: Violation[]): void {
  for (const raw of text.split("\n")) {
    if (!raw.startsWith("export ")) continue;
    if (ALLOWED_EXPORT_STARTS.some((re) => re.test(raw))) continue;
    violations.push({
      rule: "entrypoints",
      file: rel,
      message: `actions entrypoint exports something other than an async function/type/re-export: "${raw.trim()}"`,
    });
  }
}

/** Whether `ownerDir`'s own README.md mentions `basename` anywhere - the "named in
 *  the owner README" justification STRUCTURE.md §3 requires for an extra top-level
 *  owner file. Exported so `direction.ts` can reuse the exact same check: a README-
 *  justified extra entrypoint is also a legitimate owner-boundary crossing point
 *  (e.g. `src/platform/auth/proxy-gate.ts`, imported by `src/proxy.ts`). */
export function ownerReadmeMentions(ownerDir: string, basename: string): boolean {
  const readme = path.join(ownerDir, "README.md");
  if (!existsSync(readme)) return false;
  return readCached(readme).includes(basename);
}

function run(doc: StructureDoc, ctx: RuleContext): Violation[] {
  const block = new Map<string, string>();
  for (const line of nonBlankLines(doc, "entrypoints")) {
    const [name, requirement] = line.trim().split(/\s+/);
    block.set(name, requirement);
  }

  const violations: Violation[] = [];
  for (const container of OWNER_CONTAINERS) {
    const containerPath = path.join(ctx.root, container);
    if (!existsSync(containerPath) || !statSync(containerPath).isDirectory()) continue;
    for (const owner of readdirSync(containerPath, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const ownerDir = path.join(containerPath, owner.name);
      for (const entry of readdirSync(ownerDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const rel = path.relative(ctx.root, path.join(ownerDir, entry.name)).split(path.sep).join("/");
        const requirement = requirementFor(entry.name, block);
        if (requirement) {
          checkDirective(path.join(ownerDir, entry.name), rel, requirement, violations);
          continue;
        }
        if (KNOWN_NAMES.has(entry.name) || entry.name.endsWith(".d.ts")) continue;
        if (entry.name === "README.md") continue;
        if (!ownerReadmeMentions(ownerDir, entry.name)) {
          violations.push({
            rule: "entrypoints",
            file: rel,
            message: `extra top-level owner file "${entry.name}" is not mentioned in ${container}/${owner.name}/README.md (STRUCTURE.md §3)`,
          });
        }
      }
    }
  }
  return violations;
}

export const entrypointsRule: Rule = { name: "entrypoints", blockNames: ["entrypoints"], run };
