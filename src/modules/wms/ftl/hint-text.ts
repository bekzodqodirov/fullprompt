import { groupDigits } from '../../platform/telegram/format';

/**
 * The 7a hint as words (0135) — PURE, pinned by a test. Pre-rendered Uzbek
 * (a staff message; the drain bolds a short first line), kub and kg only — no
 * money; the last line is the card link alone, which the drain turns into its
 * «↗️ Ochish» button. The batch code is in the text: the departing tests clean
 * their notifications by it.
 */

export interface HintReceipt {
  number: string | null;
  dealCode: string | null;
  m3: number;
  kg: number;
}

export interface HintFacts {
  batchCode: string;
  clientCode: string | null;
  clientName: string | null;
  sellerNames: string[];
  boxes: number;
  m3: number;
  kg: number;
  /** The plan's capacity, when the truck had a plan. */
  planM3: number | null;
  receipts: HintReceipt[];
  /** The owner's open FTL deal, when there is one — then the step is «link the dealless prixods to it». */
  ftlDealCode: string | null;
  link: string;
}

export const HINT_RECEIPTS = 12;

const kub = (m3: number) => groupDigits(Math.round(m3 * 100) / 100);
const kg = (value: number) => groupDigits(Math.round(value));

export function ftlHintText(f: HintFacts): string {
  const lines = ["🚛 FTL bo'lishi mumkin — tekshiring"];
  lines.push(`${f.batchCode}: mashinada faqat bitta mijozning yuki`);
  const who = [f.clientCode, f.clientName].filter(Boolean).join(' ') || 'egasiz yuk (markirovka)';
  lines.push(`👤 ${who}${f.sellerNames.length > 0 ? ` · sotuvchi: ${f.sellerNames.join(', ')}` : ''}`);
  const plan =
    f.planM3 && f.planM3 > 0 ? ` · reja ${kub(f.planM3)} kub (${Math.round((f.m3 / f.planM3) * 100)} %)` : '';
  lines.push(`📦 ${f.boxes} karobka · ${kub(f.m3)} kub · ${kg(f.kg)} kg${plan}`);
  lines.push('LTL turgan prixodlar:');
  for (const r of f.receipts.slice(0, HINT_RECEIPTS)) {
    lines.push(`• ${r.number ?? '—'} · ${r.dealCode ?? 'bitimsiz'} — ${kub(r.m3)} kub · ${kg(r.kg)} kg`);
  }
  if (f.receipts.length > HINT_RECEIPTS) lines.push(`… +${f.receipts.length - HINT_RECEIPTS}`);
  if (f.ftlDealCode) {
    lines.push(`Mijozning FTL bitimi bor: ${f.ftlDealCode} — bitimsiz prixodlarni shunga biriktiring.`);
  }
  lines.push("FTL bo'lsa: bitimni ✏️ orqali «FTL — butun mashina» qiling yoki prixod kartasida belgilang.");
  lines.push(f.link);
  return lines.join('\n');
}
