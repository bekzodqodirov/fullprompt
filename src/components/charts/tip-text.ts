/**
 * Builds a `data-tip` string: a heading, then value/label rows — the format
 * `ChartTip` reads. A plain module and not the client file: the charts are
 * server components, and a function exported from a 'use client' file can
 * only be rendered from the server, never called (found in the browser).
 */
export function tipText(heading: string, rows: [value: string, label: string][]): string {
  return [heading, ...rows.map(([value, label]) => `${value}\t${label}`)].join('\n');
}

/**
 * The same tip as one spoken line, for the band's `aria-label`: a screen reader
 * and a keyboard user get the numbers the pointer gets, in the order the tip
 * prints them («27 Sen · 12.4 m³ · 3 prixod»).
 */
export function tipAria(tip: string | undefined): string | undefined {
  return tip?.replace(/\t/g, ' ').replace(/\n/g, ' · ');
}
