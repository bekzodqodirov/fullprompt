/**
 * A `;`-separated list of lost-reason labels as a setting holds it
 * (`agent_no_contact_reasons`, docs/AGENT-FEED.md).
 *
 * Here and not beside the feed that reads it, because the settings screen
 * must refuse an unusable value before it is stored (#472) and platform code
 * may not reach into `wms` — one definition of «the list», two readers (the
 * validator below, and `wms/crm/agent-feed.ts`). Pure, and it never throws:
 * a value that reached the table by hand is still read, not crashed on.
 *
 * Lower-cased and trimmed because the feed compares it with
 * `lower(trim(leads.lost_reason))` — the TEXT chosen at the move — and the
 * owner types «Qayta qilinmasin» while a seller's free-text reason from before
 * the dictionary may say «qayta qilinmasin ». Shorter than two characters is
 * dropped: a stray «;» or a lone letter must not suppress every lead whose
 * reason happens to be «-».
 */
export const REASON_LABEL_MAX = 80;

export function parseReasonList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const label = part.replace(/\s+/g, ' ').trim().toLowerCase();
    if (label.length < 2 || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

/**
 * Does the text hold at least one usable label, none of them absurdly long?
 * The settings screen asks before saving. An EMPTY list is refused on
 * purpose: it would silently stop feeding «Qayta qilinmasin» leads back to
 * the agent, and the one way to mean «suppress no lost lead» is a label no
 * reason carries — said in words, not by a blank box.
 */
export function reasonListValid(raw: string): boolean {
  const labels = parseReasonList(raw);
  return labels.length > 0 && labels.every((label) => label.length <= REASON_LABEL_MAX);
}
