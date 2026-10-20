import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { contentDisposition } from './http.js';

/** Most rows one export may contain. */
export const EXPORT_LIMIT = 10_000;

export interface Sheet {
  name: string;
  columns: { header: string; key: string; width?: number }[];
  rows: object[];
}

/** Sends an .xlsx file: bold frozen header row with a filter button on every column. */
export async function sendWorkbook(res: Response, fileName: string, sheets: Sheet[]): Promise<void> {
  const book = new ExcelJS.Workbook();
  book.creator = 'Syndic CRM';
  book.created = new Date();
  for (const s of sheets) {
    const ws = book.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
    ws.addRows(s.rows.map((r) => Object.fromEntries(s.columns.map((c) => [c.key, (r as Record<string, unknown>)[c.key] ?? '']))));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } };
    if (s.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
  }
  const buffer = Buffer.from(await book.xlsx.writeBuffer());
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': contentDisposition('attachment', fileName),
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
}

/** e.g. "trips-2026-10-20.xlsx" */
export const exportFileName = (what: string, today: string) => `${what}-${today}.xlsx`;
