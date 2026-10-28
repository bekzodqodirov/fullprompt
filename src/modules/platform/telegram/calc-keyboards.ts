import { logger } from '../logger';
import { AI_ZONE_ROUTES, type ZoneStep } from './staff-bot';

/**
 * The collector's shared keyboards and the one question every stage re-asks,
 * MOVED out of staff-handlers.ts (docs/SAKKIZ-R3.md K7) so the dialogue, the
 * reading and the sweep draw the same buttons. Frozen after K: a package that
 * needs a keyboard of its own defines it in its own file.
 */

export const CLIENT_QUESTION =
  'Mijozni yozing: **kodi** (GS777) yoki **telefon raqami**. Kod bo‘lmasa — ismini yozing.';

export const doneKeyboard = {
  inline_keyboard: [
    [{ text: '✅ Bo‘ldi — tahlil qil', callback_data: 'c:done' }],
    [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
  ],
};

export const confirmKeyboard = {
  inline_keyboard: [
    [{ text: '✅ Tasdiqlash', callback_data: 'c:save' }],
    [{ text: '➕ Yana ma’lumot', callback_data: 'c:more' }],
    [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
  ],
};

/**
 * The confirm step of an AI-rastamojka collection carries ONE extra control:
 * the certificate of origin.
 *
 * It is the single answer that changes the duty without changing the cargo —
 * PP-3818's additional duty applies only when there is no certificate — and
 * it is the seller who knows. Default TRUE, so the ordinary job quotes at the
 * ordinary rate and only the exception is a press.
 *
 * The button carries the answer it GIVES (`cert_y` / `cert_n`, K11's
 * durability-2), never «flip»: a press delivered twice is the same answer
 * twice, where a toggle pressed twice undid itself. Its LABEL is the toggle's,
 * the current answer — the summary above it says «o‘zgartirish uchun tugmani
 * bosing» — and its value is the other answer.
 */
export function aiConfirmKeyboard(hasCertificate: boolean) {
  return {
    inline_keyboard: [
      [{ text: '✅ Tasdiqlash', callback_data: 'c:save' }],
      [
        hasCertificate
          ? { text: '📄 Sertifikat: bor', callback_data: 'c:cert_n' }
          : { text: '📄 Sertifikat: yo‘q', callback_data: 'c:cert_y' },
      ],
      [{ text: '➕ Yana ma’lumot', callback_data: 'c:more' }],
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/**
 * A section button pressed while a collection is already live.
 *
 * It used to REPLACE the state silently: a person half-way through forwarding
 * a packing list pressed «🛃 Rastamojka» to re-read the label and lost
 * everything they had sent, with the bot answering as if they had just
 * started. A collection is minutes of somebody's attention — it is not
 * discarded without being asked.
 *
 * «No» re-prompts the stage the collection is in (`c:resume`, product-fit-8).
 * It was `c:more`, which sets the stage to material unconditionally: «no,
 * continue» threw a table-stage collection out of its table, and in the zone
 * or customer stage skipped the very question it was waiting on. ▶️ and not
 * ↩️, which is the undo's mark alone.
 */
export function restartKeyboard(step: string) {
  return {
    inline_keyboard: [
      [{ text: '🔄 Ha, boshqatdan', callback_data: `c:go_${step}` }],
      [{ text: '▶️ Yo‘q, davom etaman', callback_data: 'c:resume' }],
    ],
  };
}

/**
 * «Yuk qayerdan chiqadi?» — his tariff's zones, as buttons. A button and not
 * a typed city: the zone is a 36-58 % difference in the road's price, and
 * `guessZone` over free text is a SUGGESTION the workspace makes a person
 * confirm (workspace.ts). Here the person IS confirming, by pressing.
 *
 * Only the zones the tariff PRICES today are drawn (`priced`, read at the
 * moment the question is asked): «horgos» appears the day he types its
 * prices on /admin/tarif and not before. Pure, so the rule is a test.
 */
export function zoneKeyboard(priced: readonly string[]) {
  return {
    inline_keyboard: [
      ...(Object.entries(AI_ZONE_ROUTES) as [ZoneStep, (typeof AI_ZONE_ROUTES)[ZoneStep]][])
        .filter(([, r]) => priced.includes(r.zone))
        .map(([step, r]) => [{ text: r.label, callback_data: `c:${step}` }]),
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/**
 * The zones the tariff prices today — through a dynamic import, because
 * platform must not import wms statically. A failed read answers his two
 * seeded zones rather than no buttons at all: the question must stay
 * answerable, and the landing still drops a zone that turned out unpriced.
 * Beside `zoneKeyboard`, the one keyboard drawn from it, so every stage that
 * re-asks «qayerdan?» reads the same list.
 */
export async function pricedZonesNow(): Promise<string[]> {
  try {
    const { onDate, tariffZones } = await import('../../wms/calc/dictionaries');
    return await tariffZones(onDate());
  } catch (err) {
    logger.error({ err }, '[staff-bot] tariff zones unreadable — offering the seeded two');
    const { OWNER_TARIFF_ZONES } = await import('../../wms/calc/tariff-seed');
    return [...OWNER_TARIFF_ZONES];
  }
}
