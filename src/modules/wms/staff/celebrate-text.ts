import { a, b, groupDigits, h, roundM3 } from '../../platform/telegram/format';

/**
 * The staff group's words (0134) — PURE, so every template is rendered by a
 * test with a name that needs escaping. His «zerkarli bolmasin tabriklash
 * ham»: each kind has several sentences and they ROTATE by the number of
 * posts of that kind so far, so two codes in a row never read the same.
 *
 * A client is named by its CODE alone — never its name or phone. Money
 * appears in ONE place: a won lead's own price (his 2026-10-20 «lead
 * yutilganda nech pullik necha kub necha kg yuk yutildi»). The group is read
 * by every colleague, the warehouse and the VED included, and that was said to
 * him; a balance, a cost or a margin never appears anywhere here.
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

/**
 * A win is the loudest post (his «yanayam jonliroq bolsin, oddiy tabrikdan
 * ham»): a headline, the price, the cargo, the seller's month so far and a
 * closing line — each headline and each closing rotates on its own.
 */
const WON_HEAD: Template<{ who: string; code: string | null }>[] = [
  (x) => `🏆 <b>G'ALABA!</b> ${x.who} lidni yutdi${x.code ? ` — ${x.code}` : ''}!`,
  (x) => `🥳 <b>YANA BIR G'ALABA!</b> ${x.who} lidni mijozga aylantirdi${x.code ? ` — ${x.code}` : ''}!`,
  (x) => `💥 <b>BITIM YOPILDI!</b> ${x.who} lidni yutdi${x.code ? ` — ${x.code}` : ''}!`,
  (x) => `🎯 <b>NISHONGA TEGDI!</b> ${x.who} — lid yutildi${x.code ? `, mijoz ${x.code}` : ''}!`,
  (x) => `👑 <b>BUGUNNING QAHRAMONI!</b> ${x.who} lidni yutdi${x.code ? ` — ${x.code}` : ''}!`,
];

const WON_TAIL = [
  `Tabriklaymiz! Shu ruhda davom eting! 💪`,
  `Qarsaklar! 👏👏👏`,
  `Barakalla, jamoa faxrlanadi! 🚀`,
  `Keyingisi bundan ham kattaroq bo'lsin! 📈`,
  `Zo'r ish — hammaga o'rnak! 🌟`,
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

/**
 * «$2 450» / «$2 450.50» / «31 000 000 so'm» — a won lead's price as a person
 * writes it: dollars with the sign first and cents only when there are any.
 */
export function moneyText(amount: number, currency: string): string {
  const cents = Math.round(amount * 100) / 100;
  const body = Number.isInteger(cents) ? groupDigits(cents) : groupDigits(cents, 2);
  if (currency === 'USD') return `$${body}`;
  if (currency === 'UZS') return `${groupDigits(Math.round(amount))} so'm`;
  return `${body} ${h(currency)}`;
}

/** «2.45 kub · 1 850 kg» — kub to two places like every staff surface, kg whole. */
export function cargoLine(m3: number, kg: number): string {
  return `${groupDigits(Math.round(roundM3(m3) * 100) / 100)} kub · ${groupDigits(Math.round(kg))} kg`;
}

/** `monthCount` = the minter's codes this Tashkent month, this one included (null = not counted). */
export function clientMintedHtml(hero: Hero, clientCode: string, index: number, monthCount: number | null): string {
  const line = pick(CLIENT, index)({ who: heroHtml(hero), code: code(clientCode) });
  if (monthCount === null || monthCount < 1) return line;
  return `${line}\n${monthCount === 1 ? `📈 Bu oyning birinchi yangi mijozi!` : `📈 Bu oy: ${b(`${monthCount}-mijoz`)}`}`;
}

/** What a win carries besides its hero — every part is left out when it is missing, never printed as 0. */
export interface WonFacts {
  clientCode: string | null;
  /** The lead's own price (the quote the win carries into the deal). */
  amount: number | null;
  currency: string | null;
  m3: number | null;
  kg: number | null;
  /** The hero's wins this Tashkent month, this one included; null when the lead has no owner. */
  monthWins: number | null;
  /** Σ of those wins' DOLLAR prices; null when none carried one. */
  monthUsd: number | null;
}

export function leadWonHtml(hero: Hero, facts: WonFacts, index: number): string {
  const lines = [pick(WON_HEAD, index)({ who: heroHtml(hero), code: facts.clientCode ? code(facts.clientCode) : null })];
  const body: string[] = [];
  if (facts.amount !== null && facts.amount > 0 && facts.currency) {
    body.push(`💰 Narx: ${b(moneyText(facts.amount, facts.currency))}`);
  }
  const cargo: string[] = [];
  if (facts.m3 !== null && facts.m3 > 0) cargo.push(b(`${groupDigits(Math.round(roundM3(facts.m3) * 100) / 100)} kub`));
  if (facts.kg !== null && facts.kg > 0) cargo.push(b(`${groupDigits(Math.round(facts.kg))} kg`));
  if (cargo.length > 0) body.push(`📦 Yuk: ${cargo.join(' · ')}`);
  if (body.length > 0) lines.push('', ...body);
  if (facts.monthWins !== null && facts.monthWins > 0) {
    // The first win's «jami» would only repeat its own price two lines up.
    const sum = facts.monthUsd !== null && facts.monthUsd > 0 ? ` · jami ${b(moneyText(facts.monthUsd, 'USD'))}` : '';
    lines.push(
      '',
      facts.monthWins === 1 ? `🔥 Bu oyning birinchi g'alabasi!` : `🔥 Bu oy: ${b(`${facts.monthWins}-g'alaba`)}${sum}`,
    );
  }
  lines.push(WON_TAIL[Math.abs(Math.trunc(index)) % WON_TAIL.length]!);
  return lines.join('\n');
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
export const TEMPLATE_COUNTS = { client: CLIENT.length, won: WON_HEAD.length, first_cargo: FIRST_CARGO.length };
