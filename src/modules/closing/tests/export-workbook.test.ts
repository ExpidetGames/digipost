import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildClosingOverviewWorkbook, type ClosingSheetColumn } from "../server/export-workbook";

type Row = { date: Date; label: string; amount: number | null };

const columns: ClosingSheetColumn<Row>[] = [
  { header: "Datum", width: 12, type: "date", value: (row) => row.date },
  { header: "Name", width: 30, type: "text", value: (row) => row.label },
  { header: "Betrag", width: 14, type: "number", value: (row) => row.amount },
];

async function load(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

describe("buildClosingOverviewWorkbook", () => {
  it("writes all three sheets with their German headers, in order", async () => {
    const buffer = await buildClosingOverviewWorkbook(
      { name: "Dokumente", columns, rows: [] },
      { name: "Buchungen", columns, rows: [] },
      { name: "Zuordnungen", columns, rows: [] },
    );
    const workbook = await load(buffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Dokumente", "Buchungen", "Zuordnungen"]);
    expect(workbook.getWorksheet("Dokumente")!.getRow(1).values).toEqual([undefined, "Datum", "Name", "Betrag"]);
  });

  it("writes dates as real dates and amounts as real numbers, so Excel can sum them", async () => {
    const buffer = await buildClosingOverviewWorkbook(
      {
        name: "Dokumente",
        columns,
        rows: [
          { date: new Date("2026-01-15T12:00:00Z"), label: "Bauwerk Generalbau, 15.01.2026", amount: 1190.5 },
          { date: new Date("2026-01-20T12:00:00Z"), label: "Kontoauszug, 20.01.2026", amount: null },
        ],
      },
      { name: "Buchungen", columns, rows: [] },
      { name: "Zuordnungen", columns, rows: [] },
    );

    const sheet = (await load(buffer)).getWorksheet("Dokumente")!;
    const first = sheet.getRow(2);
    expect(first.getCell(1).value).toBeInstanceOf(Date);
    expect((first.getCell(1).value as Date).toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(first.getCell(1).numFmt).toBe("dd.mm.yyyy");
    expect(first.getCell(2).value).toBe("Bauwerk Generalbau, 15.01.2026");
    expect(first.getCell(3).value).toBe(1190.5);
    expect(typeof first.getCell(3).value).toBe("number");

    // A document with no amount leaves an EMPTY cell, never a misleading 0.
    expect(sheet.getRow(3).getCell(3).value).toBeNull();
  });
});
