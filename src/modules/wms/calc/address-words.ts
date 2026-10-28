/**
 * The words an ADDRESS is written with: a Tashkent district, a quarter, a
 * street, a house, a flat, a shop, an office, a market and its row. ONE home
 * for the three readers that tell a place's number from a goods figure (round
 * 6): the customer line «Chilonzor 12» (`parseClientHint`), the flat «kv: 45»
 * after a house number (`parseGoodsLine`) and a market stall's row and place
 * «Ippodrom 112 15» (`figureRow`). Pure, because the browser asks the kernel
 * too.
 */
const ADDRESS_WORDS = new Set([
  'chilonzor', 'yunusobod', 'sergeli', 'yakkasaroy', 'shayxontohur', 'olmazor', 'uchtepa', 'bektemir', 'mirobod',
  'yashnobod', 'yangihayot', 'qoraqamish', 'чилонзор', 'чиланзар', 'юнусобод', 'юнусабад', 'сергели',
  'яккасарой', 'яккасарай', 'шайхонтохур', 'шайхантахур', 'олмазор', 'алмазар', 'учтепа', 'бектемир', 'миробод',
  'мирабад', 'яшнобод', 'яшнабад', 'янгихаёт', 'каракамыш', 'kvartal', 'квартал', 'mavze', 'мавзе', 'massiv',
  'массив', 'mahalla', 'махалла', 'kocha', 'куча', 'кўча', 'улица', 'ул', 'uy', 'уй', 'dom', 'дом', 'kv', 'кв',
  'kvartira', 'квартира', 'dokon', 'дўкон', 'докон', 'магазин', 'ofis', 'офис', 'office', 'rasta', 'раста', 'ряд',
  'butik', 'бутик', 'pavilyon', 'павильон', 'magazin', 'qavat', 'этаж', 'etaj', 'ippodrom', 'ипподром',
  'chorsu', 'чорсу', 'abusaxiy', 'абусахий', 'saxiy', 'сахий', 'bozor', 'бозор', 'рынок', 'bazar', 'базар',
]);

const POSSESSIVE = ['si', 'си', 'i', 'и'];

/**
 * Is this one word an address word — bare, or in the possessive an Uzbek
 * address puts it in («ko'chasi», «Chorsu bozori», «massivi»)? Compared
 * lower-cased, every apostrophe and a closing dot dropped («ул.»).
 */
export function addressWord(raw: string): boolean {
  const word = raw.toLowerCase().replace(/[’ʻʼ‘`´']/gu, '').replace(/\.+$/u, '');
  if (ADDRESS_WORDS.has(word)) return true;
  return POSSESSIVE.some((end) => word.endsWith(end) && ADDRESS_WORDS.has(word.slice(0, -end.length)));
}
