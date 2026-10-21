// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Pure
// statement-coverage-gap detection for the accounts overview page ("gaps between batches
// highlighted", F2's own scope item 3): given every import batch's own `[statementFrom,
// statementTo]` range for one account, finds every gap of more than one day between two
// chronologically adjacent ranges. A batch missing either date (should not happen for a
// camt.053-derived batch; always happens for one with zero transactions, an edge case) is
// ignored - a gap needs two real dates on both sides to be meaningful.
export type StatementRange = { statementFrom: string | null; statementTo: string | null };
export type CoverageGap = { from: string; to: string };

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function findCoverageGaps(ranges: StatementRange[]): CoverageGap[] {
  const complete = ranges
    .filter((r): r is { statementFrom: string; statementTo: string } => r.statementFrom !== null && r.statementTo !== null)
    .sort((a, b) => a.statementFrom.localeCompare(b.statementFrom));

  const gaps: CoverageGap[] = [];
  for (let i = 1; i < complete.length; i++) {
    const previous = complete[i - 1]!;
    const current = complete[i]!;
    const expectedNext = addDaysIso(previous.statementTo, 1);
    if (current.statementFrom > expectedNext) {
      gaps.push({ from: expectedNext, to: addDaysIso(current.statementFrom, -1) });
    }
  }
  return gaps;
}
