// The CSV export must open safely in Excel: no formulas, quotes escaped.

import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv';

describe('toCsv', () => {
  it('quotes every cell, separates with semicolons and ends lines with CRLF', () => {
    expect(toCsv([['a', 'b'], [1, null]])).toBe('"a";"b"\r\n"1";""\r\n');
  });

  it('escapes double quotes and keeps newlines and semicolons inside the cell', () => {
    expect(toCsv([['He said "hi"; then\nleft']])).toBe('"He said ""hi""; then\nleft"\r\n');
  });

  it.each(['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd'])(
    'neutralises a cell that would run as a formula: %j',
    (value) => {
      const out = toCsv([[value]]);
      expect(out.startsWith(`"'`)).toBe(true);
    },
  );

  it('leaves ordinary text, dates and numbers alone', () => {
    expect(toCsv([['Bytt filter', '2026-10-16', 3]])).toBe('"Bytt filter";"2026-10-16";"3"\r\n');
  });
});
