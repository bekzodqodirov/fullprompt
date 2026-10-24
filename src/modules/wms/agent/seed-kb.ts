import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentTablesReady } from './config';

/**
 * The knowledge the AI sotuvchi starts with (spec §16.12 / §17.12) — a
 * VENDORED, reviewed list: the website's own words where the website says
 * it (gsrlogistics.uz `src/data/faq.ts` and `services/*.content.ts`, read on
 * 2026-10-24), his own words for what only he said (the Tashkent warehouse,
 * its contact, its map; the three China receiving warehouses with their
 * contacts, verbatim from his fourth set), and nothing else.
 *
 * Deliberately ABSENT, and fenced by `tests/unit/agent-seed-kb.test.ts`:
 *  - every price — a price comes from the calculation, never from a fact the
 *    model could repeat after the table moved (money-3, money-9);
 *  - the site's extras (free storage days, insurance, the photo report,
 *    repacking, door delivery) — his answer 8 ⭐: the AI never states them;
 *  - «omborimiz» — the site writes «Ivu ombori» / «qabul punkti» because who
 *    owns each point is unverified, and so does this list; the ONE exception
 *    is the price rule he dictated himself (his third set «3», 2026-10-24:
 *    «skladlarimizdan narxi shuncha»), in his own words.
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

/**
 * His reminder under the addresses (his fourth set's picture), in his words
 * and in the Chinese the supplier reads: every address fact carries it, so a
 * reply that quotes an address quotes the reminder with it.
 */
export const GS_REMINDER =
  'Yuklaringizni joʻnatishdan oldin GS kodini (markirovka) yozishni unutmang. 发货前请不要忘记标注GS编码（唛头）。';

export const SEED_FACTS: readonly SeedFact[] = [
  {
    // His 10 b (2026-10-24): the AI GIVES the China receiving address. @1
    // deferred the customer («kelishuvdan keyin»), @2 named three cities and
    // still ANSWERED «manzil tashlang» (ident fix F4), @3 told the model the
    // street addresses were missing and to ask him. His fourth set (the same
    // night) GAVE them — three receiving warehouses, each a fact of its own
    // below — so @4 points at those facts. Qashqar is no longer named: his list
    // is Ivu, Guanchjou and Xorgos.
    // His «2 yukini infosini menga bersang men adres beraman telegramda
    // sorasin»: the flight's address is his to give, so the fact says so where
    // every run reads it — and says no more than he did (review D7: «avia is
    // not for these addresses» was a claim about his warehouses he never made).
    key: 'china_points@4',
    question: 'Xitoyda yukni qayerga yuboraman? Qabul omborlari qayerda?',
    answer:
      'Xitoyda uchta qabul ombori bor: Ivu (YW, 义乌), Guanchjou (GZ, 广州 — ombor Foshan shahrida, 佛山) va Xorgos (HRG, 霍尔果斯). ' +
      'Har birining aniq manzili, qabul qiluvchisi va telefoni alohida bilimda: mijoz qaysi omborga yuborishini aytsa — oʻshaning manzilini bilimdagidek bering; ' +
      'aytmasa — qaysi shahardan joʻnatishini soʻrang. ' +
      "Avia uchun manzilni AI aytmaydi (bilimdagi ombor manzilini ham): yuk maʼlumotini (tovar, ogʻirlik, qayerdan) yigʻib, akkaunt egasidan soʻraydi (needs_owner=true) — manzilni u beradi.",
  },
  // His fourth set, verbatim (the Chinese text is the supplier's to read and is
  // never translated or re-spelled). One fact per warehouse, so a reply quotes
  // the one it was asked for. Dropped from his Horgos line, on purpose: «距你
  // 966.0公里» («966 km from you») — the map app's distance from where HE stood
  // when he copied it, wrong for every customer who reads it.
  {
    key: 'china_address_yiwu@1',
    question: 'Ivu (义乌, YW) qabul omborining manzili qanday?',
    answer: `Ivu (YW) qabul ombori: 浙江省 义乌市 稠江街道 荷花南街 2255号，周先生，小周 13429089596. ${GS_REMINDER}`,
  },
  {
    key: 'china_address_guangzhou@1',
    question: 'Guanchjou (广州, GZ) qabul omborining manzili qanday?',
    answer:
      'Guanchjou (GZ) qabul ombori: 广东省佛山市南海区里水镇胜利社区胜利工业区29号3栋 拓派国际物流有限公司. ' +
      `Yukni olib kelish (mashina) boʻyicha telefon: 提货调车电话：王红 13266376775. ${GS_REMINDER}`,
  },
  {
    key: 'china_address_horgos@1',
    question: 'Xorgos (霍尔果斯, HRG) qabul omborining manzili qanday?',
    answer:
      'Xorgos (HRG) qabul ombori: 霍尔果斯金亿国际物流中心 新疆维吾尔自治区伊犁哈萨克自治州霍尔果斯市南京路与宁波路交叉口正东方向168米左右. ' +
      `Qabul qiluvchi: ASQAR 18309082036. ${GS_REMINDER}`,
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
  // His 2026-10-24 answers, «buni yozib qo'y»: what the company accepts and
  // what it arranges itself — each a fact, none a price (the avia rate lives
  // on agent_config, where the tool multiplies it, never in the kb).
  {
    key: 'min_shipment@1',
    question: 'Eng kamida qancha yuk qabul qilasizlar?',
    answer: 'Avto orqali eng kamida 1 kub yoki 100 kg dan yuk qabul qilamiz.',
  },
  {
    key: 'avia@1',
    question: 'Avia orqali yuborsa boʻladimi? Necha kunda keladi?',
    answer: 'Avia orqali 1 kg dan qabul qilamiz; yetib borishi taxminan 2–5 kun, reys boʻlsa 2 kun — bu taxmin, vaʼda emas.',
  },
  {
    key: 'certificate@1',
    question: 'Kelib chiqish sertifikati kerakmi?',
    answer: 'Kelib chiqish sertifikatini kompaniyamiz oʻzi rasmiylashtiradi — mijozdan talab qilinmaydi.',
  },
  // His third set «3» (the same evening): «agar skladimizga jo'natib bersangiz
  // skladlarimizdan narxi shuncha deb aytsin. Va zavotidan olib skladga olib
  // kelish alohida hisoblanadi». No money — the figure is still the tool's.
  // His words answered the TRUCK question, so the fact says «avto» (review
  // D6): served into an avia chat, «Narx omborlarimizdan» read as the flight's
  // price too, and the flight is weight × rate from wherever it starts.
  {
    key: 'china_warehouse_price@1',
    question: 'Mashina (avto) narxi qayerdan hisoblanadi? Zavoddan olib kelish narxga kiradimi?',
    answer: 'Avto (mashina) narxi Xitoydagi omborlarimizdan hisoblanadi; zavoddan omborgacha olib kelish alohida hisoblanadi.',
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
 * Insert the facts not yet seeded, and retire the untouched older versions
 * of each. One statement per fact, each guarded by its own NOT EXISTS, under
 * one advisory lock — two runs at once insert each fact once. Returns the
 * keys it inserted.
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
      // A newer version supersedes the older ones the seed wrote and nobody
      // touched (china_points@3 → @4): two answers to one question would both
      // sit in every prompt. A copy he EDITED is his own row (`editKbFact`
      // writes it as source 'owner') and is never touched here.
      const [base, version] = f.key.split('@') as [string, string];
      await tx.execute(sql`
        UPDATE kb_facts SET retired_at = now()
         WHERE source = 'seed' AND retired_at IS NULL AND source_ref ? 'seed'
           AND split_part(source_ref->>'seed', '@', 1) = ${base}
           AND split_part(source_ref->>'seed', '@', 2)::int < ${Number(version)}`);
    }
    return inserted;
  });
}
