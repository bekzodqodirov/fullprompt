/**
 * «P-201 (12.10, 30 📦), P-207 (13.10, 12 📦)» — the prixods that may already
 * be a factory line's cargo (`lookalikesFor`, the judge's intent-5). One
 * spelling for the door, the /receive row and the prefill. The date is
 * numeric and in Tashkent's day: Chromium ships no Uzbek month names (#678),
 * and the route hands the date back as a string.
 */
export function lookalikeList(
  items: { number: string | null; confirmedAt: Date | string | null; boxes: number }[],
): string {
  return items
    .map((item) => {
      const at = item.confirmedAt ? new Date(item.confirmedAt) : null;
      const day =
        at && !Number.isNaN(at.getTime())
          ? at.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Tashkent' })
          : '—';
      return `${item.number ?? '—'} (${day}, ${item.boxes} 📦)`;
    })
    .join(', ');
}
