import type { ColumnDef } from '../../platform/lists/columns';

/**
 * The stock table's columns, as data.
 *
 * They were JSX until round 57, which is why nobody could hide one: the
 * warehouse reads five of these and the accountant reads a different five,
 * and 860 px of table on a phone is most of the reason both complained.
 *
 * Lives outside the page so the XLSX route can build the same set — a
 * spreadsheet that carries a column the screen was hiding is a leak with a
 * filename on it.
 *
 * Emoji labels are literal on purpose: 📦, Σ kg and m³ read the same in all
 * four languages and always have on this screen.
 */
export const STOCK_COLUMNS: ColumnDef[] = [
  { key: 'photo', label: '📷' },
  { key: 'code', labelKey: 'stock.colCode', always: true },
  { key: 'product', labelKey: 'stock.colProduct' },
  { key: 'boxes', label: '📦', numeric: true },
  { key: 'perBoxKg', label: 'kg/📦', numeric: true },
  { key: 'stockKg', label: 'Σ kg', numeric: true },
  { key: 'stockM3', label: 'm³', numeric: true },
  { key: 'density', label: 'kg/m³', numeric: true },
  { key: 'note', label: '📝' },
  { key: 'whCode', labelKey: 'stock.colWh' },
  { key: 'receivedAt', labelKey: 'stock.colDate' },
];
