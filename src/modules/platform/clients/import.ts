/**
 * Parsing the owner's client spreadsheet.
 *
 * The list is real office data, not a clean export: phones written eight
 * different ways, codes that are not codes ("kassa", "mebel", "12131"),
 * missing names, a truncated number, the same code entered twice. Every one
 * of those rules lives here as a pure function so it can be tested without a
 * database — an import that silently mangles 300 client cards is much worse
 * than one that refuses a row and says why.
 */

export interface RawClientRow {
  n: string;
  name: string;
  phone: string;
  code: string;
  seller: string;
}

export interface ParsedClientRow {
  line: number;
  code: string;
  name: string;
  phone: string | null;
  seller: string;
  /** Set when the row cannot be imported at all. */
  error?: string;
  /** Set when the row IS imported but something deserves a human's eye. */
  warning?: string;
}

const PLACEHOLDERS = new Set(['', '-', '—', 'xxx', 'x', 'no name', 'noname', 'n/a']);

const isPlaceholder = (value: string) => PLACEHOLDERS.has(value.trim().toLowerCase());

/**
 * A code the system will accept: uppercase alphanumerics, 2–10 characters.
 *
 * Inner spaces are removed rather than rejected — "erik odk" is one marking
 * written with a space, and refusing it would leave real cargo unimportable.
 */
export function normalizeCode(raw: string): { code: string; error?: string } {
  const code = raw.trim().replace(/\s+/g, '').toUpperCase();
  if (!code) return { code: '', error: 'code_missing' };
  if (!/^[A-Z0-9]{2,10}$/.test(code)) return { code, error: 'code_format' };
  return { code };
}

/**
 * Uzbek numbers are 9 digits after the country code, however they are typed.
 *
 * Everything else is kept as digits with a `+` rather than guessed at: the
 * cabinet's phone check compares the last 9 digits (DECISIONS #111), so a
 * missing country code never breaks matching, while an invented one could
 * link a client to the wrong person.
 */
export function normalizePhone(raw: string): { phone: string | null; warning?: string } {
  const value = raw.trim();
  if (isPlaceholder(value)) return { phone: null };
  // "86 156..." — the number was cut off in the spreadsheet.
  if (value.includes('...')) return { phone: null, warning: 'phone_truncated' };

  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return { phone: null };
  if (digits.length === 9) return { phone: `+998${digits}` };
  if (digits.length === 12 && digits.startsWith('998')) return { phone: `+${digits}` };
  // A mainland Chinese mobile: 11 digits starting with 1.
  if (digits.length === 11 && digits.startsWith('1')) return { phone: `+86${digits}` };
  return { phone: `+${digits}`, warning: 'phone_unusual' };
}

/** A card with no name at all is unusable in a list; fall back to the code. */
export function normalizeName(raw: string, code: string): { name: string; warning?: string } {
  const value = raw.trim();
  if (isPlaceholder(value)) return { name: code, warning: 'name_missing' };
  return { name: value };
}

export function parseRow(row: RawClientRow, line: number): ParsedClientRow {
  const { code, error } = normalizeCode(row.code);
  const { name, warning: nameWarning } = normalizeName(row.name, code || row.code);
  const { phone, warning: phoneWarning } = normalizePhone(row.phone);
  return {
    line,
    code,
    name,
    phone,
    seller: row.seller.trim(),
    error,
    warning: nameWarning ?? phoneWarning,
  };
}

/** Tab-separated, first line is the header. */
export function parseTsv(text: string): ParsedClientRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [header, ...body] = lines;
  const columns = (header ?? '').split('\t').map((name) => name.trim().toLowerCase());
  const index = (name: string) => columns.indexOf(name);

  return body.map((line, position) => {
    const cells = line.split('\t');
    const at = (name: string) => cells[index(name)] ?? '';
    return parseRow(
      { n: at('n'), name: at('name'), phone: at('phone'), code: at('code'), seller: at('seller') },
      position + 2,
    );
  });
}

/**
 * Codes repeated inside the sheet itself.
 *
 * The FIRST occurrence wins and the rest are reported: two rows sharing a
 * code are one card entered twice, and importing both would either fail on
 * the unique index or overwrite the name from the earlier row.
 */
export function markDuplicates(rows: ParsedClientRow[]): ParsedClientRow[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.error || !row.code) return row;
    if (seen.has(row.code)) return { ...row, error: 'duplicate_in_file' };
    seen.add(row.code);
    return row;
  });
}
