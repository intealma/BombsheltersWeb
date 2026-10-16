// CSV for Swedish Excel: semicolon separated, UTF-8 with BOM (so å ä ö show
// correctly), CRLF line endings.

/**
 * A cell starting with = + - @ (or tab/CR) can run as a formula when opened
 * in Excel (CSV injection). Prefixing an apostrophe makes it plain text.
 */
function cell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

export function downloadCsv(content: string, filename: string) {
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
