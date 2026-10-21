import "server-only";

/**
 * Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The one
 * `exceljs` user in this codebase: writes `uebersicht.xlsx`, three sheets, and nothing else.
 *
 * It knows no German, no business rule and no permission - every header is passed in
 * already translated and every cell value is already resolved
 * (`core/types.ts`'s `ClosingDocumentSheetRow`/`ClosingTransactionSheetRow`). Dates are
 * written as real dates and amounts as real numbers, with a display format, so the advisor's
 * Excel can sort, filter and sum them (decisions/0066: that is the whole reason this is a
 * workbook and not a CSV).
 *
 * The workbook is built in memory on purpose - it is an index, a few hundred kilobytes even
 * for a full year, and is the FIRST entry written to the archive so the advisor sees it at
 * the top. The documents themselves are what actually stream (`export-archive.ts`).
 */
import ExcelJS from "exceljs";

/** German number/date display formats. The underlying cell values stay a real number and a
 * real date; only how Excel renders them is set here. */
const DATE_FORMAT = "dd.mm.yyyy";
const NUMBER_FORMAT = "#,##0.00";

export type ClosingSheetColumn<TRow> = {
  header: string;
  width: number;
  type: "date" | "number" | "text";
  value: (row: TRow) => Date | number | string | null;
};

export type ClosingSheetSpec<TRow> = {
  name: string;
  columns: ClosingSheetColumn<TRow>[];
  rows: TRow[];
};

function addSheet<TRow>(workbook: ExcelJS.Workbook, spec: ClosingSheetSpec<TRow>): void {
  const sheet = workbook.addWorksheet(spec.name);
  sheet.columns = spec.columns.map((column) => ({ header: column.header, width: column.width }));
  sheet.getRow(1).font = { bold: true };
  // The header stays visible while the advisor scrolls a year's worth of rows.
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of spec.rows) {
    const added = sheet.addRow(spec.columns.map((column) => column.value(row)));
    spec.columns.forEach((column, index) => {
      if (column.type === "date") added.getCell(index + 1).numFmt = DATE_FORMAT;
      if (column.type === "number") added.getCell(index + 1).numFmt = NUMBER_FORMAT;
    });
  }

  if (spec.rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };
  }
}

export async function buildClosingOverviewWorkbook<TDocument, TTransaction, TAssignment>(
  documents: ClosingSheetSpec<TDocument>,
  transactions: ClosingSheetSpec<TTransaction>,
  assignments: ClosingSheetSpec<TAssignment>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  addSheet(workbook, documents);
  addSheet(workbook, transactions);
  addSheet(workbook, assignments);
  // `writeBuffer` returns an `ArrayBuffer`-like value typed loosely by exceljs; the archive
  // only ever needs a Node `Buffer`.
  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written as ArrayBuffer);
}
