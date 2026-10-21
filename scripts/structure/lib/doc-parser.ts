/**
 * Parser for STRUCTURE.md's machine-readable ```structure <name> ... ``` blocks
 * (STRUCTURE.md §0). Deliberately dumb: it only extracts named fenced blocks and
 * splits them into non-blank lines. Each rule module (under `scripts/structure/rules/`)
 * interprets its own block's lines in whatever shape it needs (a plain path list,
 * `key value` pairs, `key1 key2 key3` tables, or multi-line records separated by
 * blank lines) - this module does not know or care about any block's internal grammar.
 */
import { readFileSync } from "node:fs";

export type StructureBlock = {
  /** The name after ```structure, e.g. "roots" or "narrow-entry". */
  name: string;
  /** Raw lines inside the block, blank lines preserved (some blocks use them as
   *  record separators - see narrow-entry). Never includes the fence lines. */
  lines: string[];
  /** 1-based line number of the opening fence, for error messages. */
  startLine: number;
};

export type StructureDoc = {
  /** Every parsed block, in document order. Multiple blocks may share a name. */
  blocks: StructureBlock[];
  /** Convenience: every distinct block name that appears at least once. */
  names: Set<string>;
};

const FENCE_OPEN = /^```structure\s+(\S+)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

export function parseStructureDoc(filePath: string): StructureDoc {
  const text = readFileSync(filePath, "utf8");
  const rawLines = text.split("\n");
  const blocks: StructureBlock[] = [];

  let i = 0;
  while (i < rawLines.length) {
    const open = FENCE_OPEN.exec(rawLines[i]);
    if (!open) {
      i++;
      continue;
    }
    const name = open[1];
    const startLine = i + 1;
    const content: string[] = [];
    i++;
    while (i < rawLines.length && !FENCE_CLOSE.test(rawLines[i])) {
      content.push(rawLines[i]);
      i++;
    }
    if (i >= rawLines.length) {
      throw new Error(`${filePath}:${startLine}: unterminated \`\`\`structure ${name} block`);
    }
    i++; // skip closing fence
    blocks.push({ name, lines: content, startLine });
  }

  return { blocks, names: new Set(blocks.map((b) => b.name)) };
}

/** All blocks with the given name, in document order. */
export function blocksNamed(doc: StructureDoc, name: string): StructureBlock[] {
  return doc.blocks.filter((b) => b.name === name);
}

/** Non-blank lines of every block with the given name, concatenated. */
export function nonBlankLines(doc: StructureDoc, name: string): string[] {
  return blocksNamed(doc, name).flatMap((b) => b.lines.filter((l) => l.trim() !== ""));
}

/** Splits `lines` into groups separated by one-or-more blank lines. Used by blocks
 *  that hold multiple multi-line records (e.g. narrow-entry). */
export function splitRecords(lines: string[]): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) records.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) records.push(current);
  return records;
}
