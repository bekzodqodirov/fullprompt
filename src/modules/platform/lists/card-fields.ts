import { cookies } from 'next/headers';

/**
 * What a board CARD shows, chosen per person.
 *
 * The last item of the UX programme's batch 4. It is deliberately NOT a
 * permission: the owner's answer was that the deal AMOUNT stays visible to
 * everybody who can open the board today, so this is somebody deciding what
 * they want to look at — attaching `finance.view` to it would have taken money
 * away from people who see it now, which is an access change wearing a layout
 * change's clothes (round 63 refused exactly that on the client card).
 *
 * The card's IDENTITY is not on the list and cannot be turned off — a lead's
 * name, a deal's code and CLIENT. Partly because a card with nothing on it is
 * not a card, and partly because half the Playwright suite finds a board card
 * by its name; the same rule batch 1 gave the link column.
 *
 * A deal's own title is not identity and is not switchable either: it is the
 * optional description of the job, drawn under the client. It used to STAND IN
 * for the client when it was absent, which meant one column mixed two
 * grammars — a titled card naming no client, an untitled one naming the client
 * twice and naming no job.
 */

/** One switchable line on a card. `on` is what the board shows TODAY. */
export interface CardFieldSpec {
  key: string;
  /** Key inside the screen's own i18n namespace. */
  labelKey: string;
  /** In the default set — i.e. what a person sees before they choose anything. */
  on: boolean;
}

export const LEAD_CARD_FIELDS: CardFieldSpec[] = [
  { key: 'company', labelKey: 'company', on: true },
  { key: 'phone', labelKey: 'phone', on: true },
  { key: 'source', labelKey: 'source', on: true },
  { key: 'owner', labelKey: 'owner', on: true },
  { key: 'code', labelKey: 'clientCode', on: true },
  { key: 'chat', labelKey: 'cardChat', on: true },
  { key: 'nextAction', labelKey: 'nextAction', on: true },
  // ON by default, deliberately breaking the «null = today's set» stillness
  // once: the quote IS round 71's feature — the price written after
  // hisoblatish, riding to won/lost — and a filterable number nobody can see
  // on the card is a filter over invisible ink. Stated to the owner.
  { key: 'quote', labelKey: 'quotedAmount', on: true },
];

export const DEAL_CARD_FIELDS: CardFieldSpec[] = [
  // Summa · kub · kg is ONE line under one switch (round 73, the owner:
  // «kartalarning ustiga kubi kg summasi ko'rinsin») — the separate opt-in
  // `volume` switch retired with it, and a cookie still naming it is simply
  // dropped, because a choice outlives a field.
  { key: 'amount', labelKey: 'amount', on: true },
  { key: 'owner', labelKey: 'cardOwner', on: true },
  { key: 'code', labelKey: 'cardClient', on: true },
  { key: 'chat', labelKey: 'cardChat', on: true },
  { key: 'alarms', labelKey: 'cardAlarms', on: true },
];

export const CARD_FIELDS: Record<string, CardFieldSpec[]> = {
  lead: LEAD_CARD_FIELDS,
  deal: DEAL_CARD_FIELDS,
};

/**
 * The one gate, mirroring `visibleColumns`.
 *
 * `null` — nobody has chosen — is the DEFAULT set, not «everything». An
 * unknown key is dropped, because a choice outlives the field it names.
 */
export function visibleCardFields(specs: CardFieldSpec[], chosen: string[] | null): Set<string> {
  if (chosen === null) return new Set(specs.filter((spec) => spec.on).map((spec) => spec.key));
  const known = new Set(specs.map((spec) => spec.key));
  return new Set(chosen.filter((key) => known.has(key)));
}

export const CARD_FIELDS_COOKIE = 'gsr_card_fields';

/**
 * `lead=company.phone|deal=amount` — two boards in one cookie.
 *
 * A cookie, following the theme (`platform/theme/theme.ts`): it is readable on
 * the SERVER, so the first HTML already carries the right card and nothing
 * flashes into place after hydration. It also leaves nothing in the database
 * for the next Playwright spec to inherit (#183), which a saved-view row would.
 * The cost, stated: it is per BROWSER, so the same person's phone and desktop
 * can differ — which is true of the theme and the collapsed sidebar too.
 *
 * A board present with an empty list means «all of them off», which is a real
 * answer and must survive a round trip. A board ABSENT means «never chose»,
 * which is the default set.
 */
export function parseCardFields(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  const out: Record<string, string[]> = {};
  for (const part of raw.split('|')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const board = part.slice(0, at);
    if (!(board in CARD_FIELDS)) continue;
    out[board] = part
      .slice(at + 1)
      .split('.')
      .filter(Boolean);
  }
  return out;
}

export function serializeCardFields(choice: Record<string, string[]>): string {
  return Object.entries(choice)
    .filter(([board]) => board in CARD_FIELDS)
    .map(([board, keys]) => `${board}=${keys.join('.')}`)
    .join('|');
}

/** What this browser has chosen for one board, or null if it never has. */
export async function readCardFields(board: string): Promise<Set<string>> {
  const specs = CARD_FIELDS[board] ?? [];
  const raw = (await cookies()).get(CARD_FIELDS_COOKIE)?.value;
  const parsed = parseCardFields(raw);
  return visibleCardFields(specs, board in parsed ? parsed[board]! : null);
}
