import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentTablesReady } from './config';

/**
 * The knowledge the AI sotuvchi starts with (spec §16.12 / §17.12) — a
 * VENDORED, reviewed list: the website's own words where the website says
 * it (gsrlogistics.uz `src/data/faq.ts` and `services/*.content.ts`, read on
 * 2026-10-24), his own words for what only he said (the Tashkent warehouse,
 * its contact, its map), and nothing else.
 *
 * Deliberately ABSENT, and fenced by `tests/unit/agent-seed-kb.test.ts`:
 *  - every price — a price comes from the calculation, never from a fact the
 *    model could repeat after the table moved (money-3, money-9);
 *  - the site's extras (free storage days, insurance, the photo report,
 *    repacking, door delivery) — his answer 8 ⭐: the AI never states them;
 *  - «omborimiz» — the site writes «Ivu ombori» / «qabul punkti» because who
 *    owns each point is unverified, and so does this list.
 *
 * Each fact is keyed (`source_ref.seed`, versioned): a re-run inserts only
 * what is missing, and a fact he RETIRED stays retired — the key still exists.
 * A changed text gets a new version key, which is a new fact he can see.
 */

export interface SeedFact {
  key: string;
  question: string;
  answer: string;
}

export const SEED_FACTS: readonly SeedFact[] = [
  {
    key: 'china_points@1',
    question: 'Xitoyda yukni qayerga yuboraman? Qabul manzillari qayerda?',
    answer:
      'Xitoyda uchta qabul manzili bor: Ivu (义乌), Guanchjou (广州) va Qashqar (喀什). Qaysi biriga joʻnatish kerakligini menejer aytadi. ' +
      'Aniq xitoycha manzil, qabul qiluvchining telefoni va shaxsiy GS kodingiz kelishuvdan keyin beriladi. ' +
      'Yukni faqat qabul manzili va GS kod tasdiqlangandan keyin joʻnating — tovar adashib ketmasligi uchun.',
  },
  {
    key: 'tashkent_warehouse@1',
    question: 'Toshkentdagi sklad qayerda? Yukni qayerdan olaman?',
    answer: 'Toshkentdagi sklad — Chuqursoy sklad. Yukni olish boʻyicha aloqa: Umriddin, +998 95 018 30 33.',
  },
  {
    // Its own fact, so the policy's map rule can allow the link only when the
    // customer asked WHERE (his Q12 ⭐: once per chat per 7 days).
    key: 'tashkent_map@1',
    question: 'Chuqursoy sklad xaritada qayerda?',
    answer: 'Chuqursoy sklad xaritada: https://yandex.uz/maps/-/CXQr78ni',
  },
  {
    key: 'transit@1',
    question: 'Xitoydan Toshkentga yuk necha kunda keladi?',
    answer:
      'Avto kargo (yigʻma yuk) odatda 15–25 kunda keladi — bu taxmin, vaʼda emas. ' +
      'Muddat yuk Xitoydagi qabul punktidan joʻnatilgandan keyin hisoblanadi; chegarada navbat, Xitoy bayramlari va mavsumda kechikishi mumkin.',
  },
  {
    key: 'gs_code@1',
    question: 'GS kod (markirovka) qanday ochiladi?',
    answer:
      'GS kod — har bir qutiga yoziladigan shaxsiy belgingiz (markirovka). U kelishuvdan keyin ochiladi: kodni bizning menejer ochib beradi. ' +
      'Yetkazib beruvchi joʻnatishdan oldin GS kodni har bir qutiga yozadi va yukni qabul manziliga joʻnatadi.',
  },
  {
    key: 'payment@1',
    question: 'Toʻlovni qachon va qanday qilaman?',
    answer:
      'Yuk tashish uchun toʻlov yuk Toshkentga yetib kelganda, yukni olishdan oldin soʻmda qilinadi; narx dollarda kelishiladi, kurs toʻlov kuni belgilanadi. ' +
      'Toʻlov usullari: karta oʻtkazmasi, Click yoki Payme, naqd, yuridik shaxslar uchun hisob-faktura boʻyicha bank oʻtkazmasi.',
  },
  {
    key: 'prohibited@1',
    question: 'Qaysi tovarlarni olib kelib boʻlmaydi?',
    answer:
      'Portlovchi va yonuvchi moddalar; oʻsimlik, hayvon va tez buziladigan mahsulotlar; pul, qimmatbaho metall va toshlar, zargarlik va antiqa buyumlar; ' +
      'toʻlov vositalari, qimmatli qogʻozlar va hujjatlar; qonun bilan taqiqlangan barcha narsalar — narkotik, qurol, kontrafakt. ' +
      'Dronlar jismoniy shaxslar uchun taqiqlangan, ratsiya va radiouzatgichlar uchun ruxsatnoma kerak, dori-darmon tijorat maqsadida faqat roʻyxatdan oʻtgan boʻlsa olib kelinadi. ' +
      'Avia orqali litiy batareya, power bank, suyuqlik, atir va magnit yuborilmaydi — ular faqat avto yoki temir yoʻl bilan ketadi. ' +
      'Shubhangiz boʻlsa, tovar havolasini yuboring — tekshirib javob beramiz.',
  },
];

/** Which seed keys the table already holds — retired ones included (a retired fact stays retired). */
export async function seededKeys(): Promise<Set<string>> {
  const rows = await db.execute<{ key: string }>(sql`
    SELECT source_ref->>'seed' AS key FROM kb_facts
     WHERE source = 'seed' AND source_ref ? 'seed'`);
  return new Set(rows.map((r) => r.key));
}

/**
 * Insert the facts not yet seeded. One statement per fact, each guarded by
 * its own NOT EXISTS, under one advisory lock — two runs at once insert each
 * fact once. Returns the keys it inserted.
 */
export async function seedKb(facts: readonly SeedFact[] = SEED_FACTS): Promise<string[]> {
  if (!(await agentTablesReady())) throw new Error('kb_facts does not exist yet — run the migrations first (0136).');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent_seed_kb'))`);
    const inserted: string[] = [];
    for (const f of facts) {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO kb_facts (id, scope, kind, question, answer, locale, source, source_ref)
        SELECT gen_random_uuid(), 'general', 'fact', ${f.question}, ${f.answer}, 'uz', 'seed',
               jsonb_build_object('seed', ${f.key}::text)
         WHERE NOT EXISTS (
           SELECT 1 FROM kb_facts WHERE source = 'seed' AND source_ref->>'seed' = ${f.key})
        RETURNING id`);
      if (rows.length > 0) inserted.push(f.key);
    }
    return inserted;
  });
}
