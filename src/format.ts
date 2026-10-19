import type { QueryResult } from "./database.js";
import { formatValue, type SqlValue } from "./values.js";

export type OutputMode = "table" | "csv" | "json" | "line";

export interface FormatOptions {
  color?: boolean;
  /** Maximum characters shown per cell in table mode. */
  maxCellWidth?: number;
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Display width of a string, counting East Asian wide characters as two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (cp >= 0x300 && cp <= 0x36f) continue; // combining marks
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function pad(s: string, width: number, right: boolean): string {
  const fill = " ".repeat(Math.max(0, width - displayWidth(s)));
  return right ? fill + s : s + fill;
}

/** Renders a result as a box-drawn table. */
export function formatTable(result: Pick<QueryResult, "columns" | "rows">, options: FormatOptions = {}): string {
  const { color = false, maxCellWidth = 60 } = options;
  const { columns, rows } = result;
  if (columns.length === 0) return "";
  const cells = rows.map((r) => r.map((v) => truncate(formatValue(v).replace(/\n/g, "⏎"), maxCellWidth)));
  const widths = columns.map((c, i) => Math.max(displayWidth(c), ...cells.map((r) => displayWidth(r[i]!))));
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === "number"));

  const line = (l: string, m: string, r: string): string => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const out: string[] = [];
  out.push(line("┌", "┬", "┐"));
  out.push("│" + columns.map((c, i) => ` ${color ? BOLD : ""}${pad(c, widths[i]!, false)}${color ? RESET : ""} `).join("│") + "│");
  out.push(line("├", "┼", "┤"));
  for (let r = 0; r < rows.length; r++) {
    const parts = cells[r]!.map((cell, i) => {
      const padded = pad(cell, widths[i]!, numeric[i]!);
      return ` ${color && rows[r]![i] === null ? DIM + padded + RESET : padded} `;
    });
    out.push("│" + parts.join("│") + "│");
  }
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}

function csvCell(v: SqlValue): string {
  if (v === null) return "";
  const s = formatValue(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatCsv(result: Pick<QueryResult, "columns" | "rows">): string {
  const lines = [result.columns.map((c) => csvCell(c)).join(",")];
  for (const row of result.rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\n");
}

export function formatJson(result: Pick<QueryResult, "columns" | "rows">): string {
  const objects = result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]])));
  return JSON.stringify(objects, null, 2);
}

export function formatLines(result: Pick<QueryResult, "columns" | "rows">): string {
  const width = Math.max(0, ...result.columns.map(displayWidth));
  return result.rows
    .map((row) => result.columns.map((c, i) => `${pad(c, width, true)} = ${formatValue(row[i]!)}`).join("\n"))
    .join("\n\n");
}

export function formatResult(result: Pick<QueryResult, "columns" | "rows">, mode: OutputMode, options: FormatOptions = {}): string {
  switch (mode) {
    case "csv":
      return formatCsv(result);
    case "json":
      return formatJson(result);
    case "line":
      return formatLines(result);
    default:
      return formatTable(result, options);
  }
}
