import type { ColumnDef } from '../lists/columns';

/**
 * How many client rows the book fetches before it admits it stopped.
 *
 * Shared by the screen and its XLSX export so the file and the page can never
 * disagree about what "the list" means — a filtered screen that exports a
 * different set is how somebody sends a customer the wrong file. The screen
 * pages its RENDER separately; this cap is about the set both cover. It lives
 * here rather than in the page because a Next.js route file may only export
 * the handful of names the framework knows.
 */
export const CLIENT_EXPORT_CAP = 5000;

/**
 * The book's core columns, shared by the screen and the spreadsheet.
 *
 * Same reason as the caps above: the file and the page must agree about what
 * a column IS, or a saved view that hides the manager still exports it.
 */
export const CLIENT_COLUMNS: ColumnDef[] = [
  { key: 'code', labelKey: 'clients.code', always: true },
  { key: 'name', labelKey: 'clients.name' },
  { key: 'manager', labelKey: 'clients.salesManager' },
  { key: 'phone', labelKey: 'clients.phones', optional: true },
];
