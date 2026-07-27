/**
 * How many client rows a screen shows before it admits it stopped.
 *
 * Shared by the book and its XLSX export so the file and the page can never
 * disagree about what "the list" means — a filtered screen that exports a
 * different set is how somebody sends a customer the wrong file. It lives
 * here rather than in the page because a Next.js route file may only export
 * the handful of names the framework knows.
 */
export const CLIENT_LIST_CAP = 200;

/** The spreadsheet is read at a desk, so it carries more than the phone does. */
export const CLIENT_EXPORT_CAP = 5000;
