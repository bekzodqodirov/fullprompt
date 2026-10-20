import { a, b, groupDigits, h, roundM3 } from '../../platform/telegram/format';

/**
 * The staff group's words (0134) — PURE, so every template is rendered by a
 * test with a name that needs escaping. His «zerkarli bolmasin tabriklash
 * ham»: each kind has several sentences and they ROTATE by the number of
 * posts of that kind so far, so two codes in a row never read the same.
 *
 * Nothing money-shaped is ever in here: the group is read by every colleague,
 * warehouse included, and a client's price or balance has its own doors.
 * A client is named by its CODE alone — never its name or phone.
 */

/** The person praised: a tappable mention when they have spoken to the bot, else their name in bold. */
export interface Hero {
  name: string;
  /** Their linked staff chat — in a private chat the chat id IS the Telegram user id. */
  telegramUserId: string | null;
}

/**
 * A `tg://user?id=` mention notifies the person in the group; Telegram shows
 * it as a mention only to someone who has contacted the bot, which is exactly
 * what a linked staff chat is. Anybody else gets their name in bold.
 */
export function heroHtml(hero: Hero): string {
  const name = b(h(hero.name));
  return hero.telegramUserId ? a(`tg://user?id=${hero.telegramUserId}`, name) : name;
}

const code = (value: string) => b(h(value));

type Template<T> = (x: T) => string;

const CLIENT: Template<{ who: string; code: string }>[] = [
  (x) => `🎉 ${x.who} yangi mijoz ochdi — ${x.code}! Tabriklaymiz, shu ruhda davom eting! 💪`,
  (x) => `🔥 Yangi mijoz! ${x.who} jamoaga ${x.code} ni olib keldi. Barakalla!`,
  (x) => `👏 ${x.who} — yangi mijoz ${x.code}. Har bir mijoz — yangi yuk, yangi imkoniyat!`,
  (x) => `🚀 ${x.who} yana bir mijoz ochdi: ${x.code}. Zo'r ish!`,
  (x) => `🌟 Qarsaklar ${x.who} uchun! Yangi mijoz — ${x.code}.`,
];

const WON: Template<{ who: string; code: string | null }>[] = [
  (x) => `🏆 ${x.who} lidni yutdi!${x.code ? ` ${x.code} bilan bitim ochildi.` : ''} Tabriklaymiz!`,
  (x) => `🥳 Yana bir g'alaba! ${x.who} lidni mijozga aylantirdi${x.code ? ` — ${x.code}` : ''}.`,
  (x) => `💥 ${x.who} ishni yopdi: lid yutildi${x.code ? ` (${x.code})` : ''}. Barakalla!`,
  (x) => `🎯 Nishonga tegdi! ${x.who} — lid yutildi${x.code ? `, mijoz ${x.code}` : ''}.`,
  (x) => `👑 ${x.who} bugun g'olib: lid yutildi${x.code ? ` — ${x.code}` : ''}. Shu ruhda!`,
];

const FIRST_CARGO: Template<{ who: string; code: string; cargo: string }>[] = [
  (x) => `🚚 ${x.who} mijozi ${x.code} birinchi yukini topshirdi — ${x.cargo}. Tabriklaymiz!`,
  (x) => `📦 Birinchi yuk keldi! ${x.code} (${x.who} mijozi) — ${x.cargo}.`,
  (x) => `🎊 ${x.who}, mijozingiz ${x.code} birinchi marta yuk berdi: ${x.cargo}. Zo'r boshlanish!`,
  (x) => `💪 ${x.code} — birinchi prixod! ${x.who} olib kelgan mijoz, ${x.cargo}.`,
];

/** The rotation: the n-th post of a kind takes the n-th sentence, round and round. */
function pick<T>(list: Template<T>[], index: number): Template<T> {
  const n = Math.abs(Math.trunc(index)) % list.length;
  return list[n]!;
}

/** «2.45 kub · 1 850 kg» — kub to two places like every staff surface, kg whole. */
export function cargoLine(m3: number, kg: number): string {
  return `${groupDigits(Math.round(roundM3(m3) * 100) / 100)} kub · ${groupDigits(Math.round(kg))} kg`;
}

export function clientMintedHtml(hero: Hero, clientCode: string, index: number): string {
  return pick(CLIENT, index)({ who: heroHtml(hero), code: code(clientCode) });
}

export function leadWonHtml(hero: Hero, clientCode: string | null, index: number): string {
  return pick(WON, index)({ who: heroHtml(hero), code: clientCode ? code(clientCode) : null });
}

export function firstCargoHtml(
  hero: Hero,
  clientCode: string,
  cargo: { m3: number; kg: number; place: string | null },
  index: number,
): string {
  const line = h(cargoLine(cargo.m3, cargo.kg)) + (cargo.place ? ` (${h(cargo.place)})` : '');
  return pick(FIRST_CARGO, index)({ who: heroHtml(hero), code: code(clientCode), cargo: line });
}

/** How many sentences each kind rotates through — the test reads these. */
export const TEMPLATE_COUNTS = { client: CLIENT.length, won: WON.length, first_cargo: FIRST_CARGO.length };
