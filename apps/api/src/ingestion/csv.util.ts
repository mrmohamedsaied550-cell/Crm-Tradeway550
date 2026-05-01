/**
 * Tiny RFC 4180 CSV parser.
 *
 * P2-06 keeps the CSV import surface dependency-free: the upload body
 * is a JSON-encoded string, parsed in-process, no multipart and no
 * `csv-parse` dependency. The parser handles:
 *   - comma delimiters, optional surrounding double-quotes,
 *   - escaped quotes (`""` inside a quoted field),
 *   - LF / CRLF newlines (CRLF is normalised on the way in),
 *   - mixed quoted + unquoted cells on the same row,
 *   - trailing newline (silently ignored),
 *   - empty trailing fields (kept as `""`).
 *
 * It does NOT handle:
 *   - non-comma delimiters (TSV, semicolons),
 *   - BOMs (the import endpoint strips the BOM before calling),
 *   - multi-line quoted cells (rejected — we always split by row first
 *     and a quoted newline is treated as a parse error).
 *
 * The simpler "split lines first" strategy is intentional: lead CSVs
 * come from spreadsheets and rarely contain embedded newlines, and
 * rejecting them up-front gives a much clearer error to the importer.
 */

export class CsvParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`CSV parse error at line ${line}: ${message}`);
    this.name = 'CsvParseError';
  }
}

/**
 * Parse a CSV string into an array of header → value records. Returns
 * `{ headers, rows }` where `rows[i][header]` resolves to the cell
 * (or `""` if the column was empty). The first non-blank line is the
 * header row.
 */
export function parseCsv(input: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  // Strip UTF-8 BOM if present.
  const raw = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // Normalise CRLF / CR to LF so the row split below is uniform.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  let headers: string[] | null = null;
  const rows: Record<string, string>[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Skip blank lines (common before/after the header in exported CSVs).
    if (line.trim().length === 0) continue;

    const cells = parseCsvLine(line, i + 1);

    if (headers === null) {
      // Header row — reject duplicates so column-name lookups are unambiguous.
      const seen = new Set<string>();
      for (const h of cells) {
        const trimmed = h.trim();
        if (trimmed.length === 0) {
          throw new CsvParseError('Header column is empty', i + 1);
        }
        if (seen.has(trimmed)) {
          throw new CsvParseError(`Duplicate header column "${trimmed}"`, i + 1);
        }
        seen.add(trimmed);
      }
      headers = cells.map((h) => h.trim());
      continue;
    }

    // Trailing row with FEWER cells than headers → pad with "".
    // Trailing row with MORE cells than headers → drop the extras (not an error;
    // accommodates spreadsheets that add a phantom trailing comma).
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      row[headers[c] as string] = c < cells.length ? (cells[c] ?? '') : '';
    }
    rows.push(row);
  }

  if (headers === null) {
    throw new CsvParseError('CSV is empty (no header row)', 1);
  }

  return { headers, rows };
}

/** Parse a single CSV line into an array of cells. */
function parseCsvLine(line: string, lineNumber: number): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote (`""`) inside a quoted cell.
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        // Closing quote — the next char must be a comma or end-of-line.
        inQuotes = false;
        const next = line[i + 1];
        if (next !== undefined && next !== ',') {
          throw new CsvParseError(
            `Unexpected character after closing quote: "${next}"`,
            lineNumber,
          );
        }
        continue;
      }
      cell += ch;
      continue;
    }

    if (ch === '"') {
      // Opening quote only valid at the start of a cell (cell empty so far).
      if (cell.length !== 0) {
        throw new CsvParseError('Unescaped quote inside an unquoted cell', lineNumber);
      }
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      cells.push(cell);
      cell = '';
      continue;
    }

    cell += ch;
  }

  if (inQuotes) {
    throw new CsvParseError('Unterminated quoted cell', lineNumber);
  }
  cells.push(cell);
  return cells;
}
