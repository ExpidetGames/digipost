import type { StructureDoc } from "./doc-parser";
import type { Violation } from "./repo";

export type RuleContext = {
  /** Repo root the rule scans. Fixture tests pass a fixture directory here instead
   *  of the real repo root. */
  root: string;
};

export type Rule = {
  /** Unique rule name, used in violation output and in the checker's block-name
   *  <-> rule-name symmetry check. */
  name: string;
  /** Which ```structure block name(s) this rule consumes from STRUCTURE.md. The
   *  checker requires at least one of them to be present in the doc. */
  blockNames: string[];
  run(doc: StructureDoc, ctx: RuleContext): Violation[];
};
