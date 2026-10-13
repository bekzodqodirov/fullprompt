# Yo'lkira tarifi bo'yicha taqsimlash — DRAFT, waiting on his six answers

His request (2026-10-13): «harajatni taqsimlashni ham aynan shunday yolkira puliga nisbatan taqsimlash usulini qoshishimiz kerak» — a truck cost split over the cargo in proportion to each cargo's freight VALUE from his tariff table, instead of by volume or weight.

Status: researched (4 scouts, 2 designs, 2 adversarial lenses, a synthesis); the six questions below were sent to him on 2026-10-13 with ⭐ defaults. NOT BUILT. Build after docs/SARFLAR.md §4 lands (it shares that round's short insert transaction and `mayEnterBatchCost`). The text below is the synthesis verbatim; when his answers arrive, record them at the top and turn the questions into decisions.

## Recommendation
ONE DESIGN: a sixth allocation basis 'freight', shown as «yo‘lkira tarifi bo‘yicha». The cargo's GRAIN is the client's whole cargo on the truck. The tariff is FROZEN onto the bill in a side table. Only TARIFF problems are refused at save. A lot that cannot be priced leaves the bill saved but unsplit, with a visible ⚠. A small re-basis door replaces «void and re-enter».

1. THE RULE (what a share is)
- Which boxes share the bill does not change: `scopeBoxIds` decides (READ costing/service.ts:810-958). The basis only weights the boxes inside that set.
- Grouping. The set's cartons are grouped by `receipts.client_id`. Unclaimed cargo (client NULL) is its own group per PRIXOD. Claiming it folds it into the client's group through the `recomputeForLots` that `assignReceiptClient` already calls (READ receipts/edit.ts:902-911).
- Why the client grain. A truck price is one charge per client per truck (READ finance/service.ts:223-237, pricing-view.ts:151-169). The calc prices freight on the WHOLE consignment's density, never per item (READ DECISIONS #783). Inside a client we split by m³, which is the same shape the revenue side already uses (READ deal-price-hint.ts:26-31, stamp-split.ts:176-192). So the cost side and the revenue side agree at both levels.
- Stable per-box measures. They are NOT boxDims' totals/box_count:
  - a uniform lot uses `box_weight_kg` and `box_length_cm·box_width_cm·box_height_cm/1e6` (READ schema/wms.ts:212-216);
  - a mixed lot uses totals ÷ box_count;
  - a uniform lot with null dims (legacy) falls back to totals.
  This absorbs the money lens's growth defect. `computeLotTotals` re-rounds totals per count (READ receipts/math.ts:31-34), so a 40³ cm / 63.968 kg carton flips band between 32 and 33 cartons. Per-box dims never move. It also fixes the 4×4×3 cm lot whose total rounds to 0.0000 m³: its dims-derived density is finite and lands in the per-kg band.
- Group figures. For each group: Σkg and Σm³ over its boxes in the set; density = Σkg/Σm³; band = pricing.ts's own `bandFor`. One change there: `bandDensityOf` (READ pricing.ts:441) rounds to 1e-6 before `Math.round`. That is one home for both callers. Its effect on the calc is limited to mathematically exact .5 densities that float arithmetic had placed on the wrong side. Drafts only; seals are frozen.
- Rate and value. Group rate per m³ r_c = band price, or band price × density in the per-kg (≥1000) band. The value is unrounded. Each box's weight = r_c × that box's m³. Client share = bill × V_c/ΣV through `allocateEntry`'s largest remainder (READ engine.ts:62-103).
- Only the RATIOS between bands matter. The list level carries margin (READ actuals.ts:9-17) and cancels out.

2. COLUMN («zona»)
- ONE column per bill, chosen on the form from the zones priced on the bill's cost_date. Default: the Xitoy column (cn), drawn as a folded line «ustun: Xitoy ✎». The last pick is remembered per viewer in localStorage inside try/catch.
- The zone is never inferred from a warehouse or a truck's direction. READ: `freight_zone` is «chosen, never inferred» (wms.ts:2621-2622), and no warehouse→zone map exists. His own Q3 answer says the direction changes from leg to leg.
- One zone per bill also avoids double-weighting cn cargo on a KA→TAS truck, because its YW→KA leg arrives separately as «shu reysgacha».
- Words: «Xitoy ustuni» / «Qashqar ustuni» (ru «колонка Китай», en «China column», zh «中国栏»). Never the route words of calc.zones, and never the raw code.

3. TARIFF DAY AND FREEZE
- At save (and at a re-basis), the zone's bands in force on cost_date are read on the POOL, BEFORE any transaction (#714). The read uses `bandsAsOf` with no earliest-row fallback.
- The bands are copied into a SIDE TABLE, `cost_entry_tariffs`, not into cost_entries columns. This absorbs the money blocker: drizzle names every column, so new columns on cost_entries would make every cost read and write throw 42703 one migration behind. READ DECISIONS #1313, drizzle dialect.js:348.
- Recompute, the void guard, the explanation and the breakdown read ONLY that copy, through the tx handle, and only when `allocation_basis='freight'` (a fenced conditional).
- So an /admin/tarif edit never moves a saved bill, including the in-place same-date overwrite and back-dated rows (READ dictionaries.ts:536-576).
- The copy is validated as finite numbers on write and on read, because the table's CHECKs admit NaN.

4. WHERE IT IS OFFERED
- Batch-scope CostPanel only: the truck's Xarajatlar tab and SARFLAR's /accounting/sarflar/kiritish.
- Pre-selected only while the basis select is untouched, and only for cost types whose code is in a new setting `freight_tariff_cost_type_codes` (default ['freight'], the seeded «Дорога / Yo'lkira», READ scripts/seed.ts:157). This mirrors `calc_customs_cost_type_codes`, so a type he mints himself can join the list.
- Hidden for customs codes, and refused in the service as well (#531): /hisoblash/nazorat compares customs per prixod.
- Not offered on receipt or crate scopes (one client, so it would reduce to volume), on pickup (the factory road is not on his CN→UZ table, and the nightly job re-splits every pickup cost, READ cost-recompute.ts:52-56), on the per-prixod grid (stays 'weight', READ service.ts:2279; the grid's yo'lkira column header gains a muted line «tarif bo‘yicha bo‘lish — yuqoridagi hisobdan kiriting»), on the receive wizard, or on the crating fee.
- Offered on internal legs. Their per-carton shares travel unchanged through the basis-blind carriage fence (READ service.ts:1546-1661) to the profit-tracked truck, which is his Q3 rule.

5. REFUSALS AT SAVE (tariff configuration only, each a sentence)
- `freight_batch_only`
- `freight_on_customs`
- `freight_zone_unpriced`: no rows on that date. This covers a bill dated before 2026-01-01 and Horgos before he types prices. The sentence names the date and the column.
- `freight_tariff_gap`: the copied column leaves a whole density ≥1 covered by zero or two bands, or its top band is closed. The sentence names the densities and says «rahbariyat to‘ldirsin». It links to /admin/tarif only for holders of admin.dictionaries.manage.
- These run BEFORE SARFLAR's twin check, so nobody is asked «Baribir saqlash?» about a save that will then be refused.
- Lot DATA never refuses the money (the use lens's defect). The bill is written, recompute runs after commit, and if a group cannot be priced the action returns `{ok:true, unsplit:{group, reason}}` and the panel prints «⚠ bo‘linmadi: GS777 A-1 · 0.3 kg/kub». Given the stable measures and the gap check, this can only be a typo lot under 0.5 kg/m³ or a missing copy.

6. FAIL CLOSED, MADE VISIBLE
- An unpriceable group means NO shares at all for that bill: never weight 0, never a silent fallback.
- One predicate, `unallocatedCostSql` (live, converted, NOT EXISTS share), shared with `profitByBatch.unallocatedUsd` (READ accounting/reports.ts:1327-1331). It is read by:
  - (a) the pricing page, as a ⚠ line beside «kurs yo‘q»: «⚠ $X bu mashina yukiga bo‘linmagan — Xarajatlar →», naming the group;
  - (b) a truck-card «Qolgan ishlar» todo to the xarajat tab, drawn for receipts.edit at the lot's warehouse and for costs.enter_batch;
  - (c) the attention row, which now links per truck to /batches/<id>/xarajatlar (today it links to a tracked-only table, READ attention.ts:387-396).
- The internal-leg «xarajat yozilmagan» warning stops counting an unsplit bill as written.
- The nightly `orphaned` net retries it, and fixing the lot re-splits it by itself.

7. EXPLANATION, BY SIGHT
- Live, NON-blocking preview under the amount. The server passes, per (priced zone × tariff version), each client group's label, stable m³, kg/m³, band and percentage. The browser picks the set by the typed date and multiplies by the typed amount. Cents are re-split by largest remainder so the column adds up to the bill (absorbs the 350.01 nit).
- $/kub and the tarif qiymati are drawn only under `pricingSight==='full'`. Everyone else sees band + %. The VED sees no per-client $ (#791).
- Rows are two lines (360 px).
- After save: `batchClientCostBreakdown` gains allocation_basis in its GROUP BY (READ service.ts:2314-2357). A freight part prints «Yo‘lkira · tarif 501-700 kg/kub $300/kub · $300.00» on the Narx tab, re-derived from the copy by the same pure helper, with a link to the bill.
- The bill row label: «yo‘lkira tarifi bo‘yicha · Xitoy ustuni · 2026-01-01 tarifi».

8. RE-BASIS DOOR (absorbs the money lens's void defect)
- `rebaseCost(id, {basis, zone}, seen)` on every live bill on the four cost cards, gated like entering that bill (`mayEnterBatchCost` for a truck).
- The first press returns a server-computed per-client before→after ($ under full sight, % otherwise) and writes nothing. The second press re-posts with what was SEEN: a compare-and-set, the SARFLAR twin idiom.
- One tx `FOR UPDATE` on the entry: UPDATE `allocation_basis`, upsert or delete the copy (re-read as of cost_date pre-tx), audit before/after {basis, zone, tariffOn}, then recompute.
- It never touches amount, payer, kassa, merge or partner charges. That matters because a void refuses merged costs, needs finance for kassa-paid ones, re-posts firm debt and re-converts dollars (READ service.ts:686-713, 217-238).
- It is also the rollback tool: rebase freight bills to weight before going below 0132.

9. ENGINE AND WIRING
- engine.ts: `ALLOCATION_BASES` as an exported const, with the type derived from it. `AllocBox.freightWeight: number` is REQUIRED, so both pool builders fail to compile until they learn it.
- `weightOf` becomes exhaustive with a `never` check. Today `default: return 1` (READ engine.ts:45-56) would split a new basis evenly by box count with no error.
- For freight, `allocateEntry` returns [] if any weight is ≤0 or non-finite.
- ONE `costPool(entry, dims, factor, copy|null)` → {ok, pool} | {ok:false, group, reason}, used by `recomputeEntry` (READ service.ts:1036-1056) and `costOrphanedByVoid` (READ void-guard.ts:166-177). No new pool read happens inside any transaction, so the three void doors are unchanged.
- New pure `costing/freight-split.ts` imports only calc/pricing.ts (which has zero imports, READ pricing.ts:1-13). It is shared by the server and the browser preview.
- pricing.ts gains `rawFreightOf` (freightFor rounds its result), `columnGaps`, and `bandsAsOf` moved here from dictionaries.ts, which re-exports it.
- `tariffFor`/`tariffHistory` move to a leaf module `calc/tariff-read.ts` (db + schema + pricing only), re-exported from dictionaries. This avoids the dictionaries→service graph cycle with costing (READ calc/upsale-service.ts already imports costing).
- CostActionResult gains `params` and `unsplit`. The panel gains a literal map for every freight code plus `server_behind` (ICU params ×4).
- costs/actions.ts maps 23514 on `cost_entries_basis_check` and 42P01 on `cost_entry_tariffs` to `server_behind` by name (READ actions.ts:100-106 catches only CostError).

10. FENCES AND TESTS
Fences:
- `basis-vocabulary.test.ts`: the const = the zod enum (service.ts:122) = the CostPanel list = the schema CHECK (wms.ts:736-739) = 0132's CHECK, and `costing.bases.<b>` exists in all four bundles, anchored on the const (#163).
- `allocateEntry` is called only from `costPool`.
- costing/** never imports calc/dictionaries.
- `cost_entry_tariffs` is read only behind basis==='freight'.
- The recompute never reads `calc_freight_tariffs`.
- Every `new CostError('…')` code under costing appears in the panel map.
- tx-pool.test.ts stays green.
Pure tests (literal anchors, #1116):
- his example → 300.00/50.00;
- the two-lot client: combined $600 vs per-lot $715;
- the per-kg band;
- unclaimed cargo grouped per prixod;
- 40 cm / 63.968 kg at 32 vs 33 cartons, and 21 cm / 9.256 kg at n = 1/2/3, keeping their band. Red proof by string edit: totals-based density, then raw Math.round;
- the 4×4×3 cm lot is priceable;
- `columnGaps` refuses a closed top;
- the freeze, proven over the copy alone.
Integration tests:
- on a PRIVATE per-run zone `t_<token>`, deleted as a final test, never in afterAll (#824);
- a same-date overwrite and a back-dated row after the save → shares unchanged. Red proof: read the live tariff;
- the void guard agrees with recompute;
- a late unpriceable rider → no shares plus the ⚠ predicate;
- a claim folds the unclaimed prixod in;
- the re-basis preview and its CAS.
Fixtures must span ≥3 bands including ≥1000. On the shaped copies every basis reads 0 difference (READ: 4,000/4,026 lots at 166.67 kg/m³).
e2e: one truck with two clients at different densities, entering a yo‘lkira bill. Assert the preview %, the breakdown band line, and clientWidth == viewport at 360.

11. BUILD ORDER
Build after SARFLAR §4 lands: it shares that round's short insert transaction (the cancelled-truck FOR SHARE), its `mayEnterBatchCost` and its twin flow. If SARFLAR is not built first, open a short tx of its own.
- Nothing is backfilled. Old bills keep their basis (written at insert only, READ service.ts:263).
- Every tannarx, profit, landed-cost, Balans U03, yuk-xavfi, deal-profit and seller-profit reader re-sums cost_allocations and follows with no code of its own.
- P&L, cash, ledgers, KPI, upsale and the cabinet do not move.
- For a truck's own bills, the truck's Partiya foydasi total is conserved. Only client and lot rows move.

## His example, worked
Sizning misolingiz: A mijozda 2 kub yuk, tarifi $300/kub; B mijozda 1 kub yuk, tarifi $100/kub. Yo'lkira qiymati: 2×300 = $600 va 1×100 = $100, jami $700. Siz $400 deb yozgansiz, lekin 2×300 + 1×100 = 700 chiqadi. Bu kichik hisob xatosi, usulga ta'sir qilmaydi. Mashina xarajati: $350.

• Yangi usul — «yo'lkira tarifi bo'yicha»:
  - A = 350 × 600/700 = $300.00, ya'ni $150/kub;
  - B = 350 × 100/700 = $50.00, ya'ni $50/kub.
  Kubiga tushgan xarajat ham 3:1 — tarifdagi nisbat bilan bir xil.
• Hajm bo'yicha (hozirgi usul):
  - A = 350 × 2/3 = $233.33;
  - B = $116.67.
  Ikkalasiga ham kubiga $116.67 tushadi.
• Og'irlik bo'yicha (bugun forma shu usulni o'zi tanlaydi). A 1200 kg (600 kg/kub), B 180 kg (180 kg/kub) deb olsak:
  - A = 350 × 1200/1380 = $304.35;
  - B = $45.65.
Uchala usulda ham jami $350.

Foydaga ta'siri. Ikkala mijoz tarif narxini to'lagan bo'lsin: A $600, B $100.
- Yangi usulda: A foydasi $300 (50 %), B foydasi $50 (50 %). Bir yo'lda ikkalasida bir xil foyda.
- Hajm bo'yicha: A $366.67 (61 %), B −$16.67. To'liq narx to'lagan mijoz zararda bo'lib ko'rinadi.

Diqqat, yo'nalish:
- og'irlikdan tarifga o'tsangiz, xarajat og'ir (zich) yukdan yengil yukka biroz suriladi (bu misolda A −$4.35, B +$4.35);
- hajmdan tarifga o'tsangiz, aksincha, yengil yukdan og'ir yukka suriladi.

Jadvalingizdagi haqiqiy qatorlar bilan:
- $100/kub faqat Qashqar ustunida bor (151-200 kg/kub);
- Xitoy ustunida eng arzoni $110, 151-200 kg/kub esa $160.
Bitta hisob bitta ustundan o'qiladi, shuning uchun:
- Xitoy ustuni: A 2×$300 = 600, B $160 → A $276.32, B $73.68;
- Qashqar ustuni: A 2×$195 = 390, B $100 → A $278.57, B $71.43.

Nega «mijozning butun yuki birga» (1-savol, a)? A ning 2 kubi ikki xil lotdan iborat bo'lsin: 1 kub 100 kg/kub va 1 kub 1100 kg/kub.
- Birga hisoblansa: 1200 kg / 2 kub = 600 kg/kub → $300/kub → $600. Bu VED narx berganidek. A ichida kub bo'yicha 150/150 bo'linadi, A $300.00, B $50.00.
- Har lot alohida hisoblansa: $110 + 1100 kg × $0.55 = $715. Shunda A $307.06, B $42.94 oladi, ya'ni A unga aytilgan narxdan og'irroq tortiladi.

Agar 300 va 100 kubiga narx emas, lotning umumiy narxi bo'lgan bo'lsa: jami $400, bo'linishi $262.50 / $87.50. Usul o'sha.

## Migration
Migration 0132_cost_freight_basis (journal idx 132, when 1785190000111, tag 0132_cost_freight_basis; the ledger must reach 133). It is additive only.

Before minting it:
- `git fetch origin main` and re-read the tail of `_journal.json` and of DECISIONS (#1040/#605). SARFLAR's spec carries no migration (grep of docs/SARFLAR.md), but a parallel round may have taken the number.

SQL:
1. `ALTER TABLE cost_entries DROP CONSTRAINT cost_entries_basis_check;` then `ADD CONSTRAINT cost_entries_basis_check CHECK (allocation_basis IN ('weight','volume','chargeable','boxes','direct_to_client','freight'))`.
   - It is strictly wider and needs no backfill. It was created in 0002_shiny_the_hand.sql:55 and never widened since.
2. Create the side table:
```
CREATE TABLE cost_entry_tariffs (
  cost_entry_id uuid PRIMARY KEY REFERENCES cost_entries(id),
  zone text NOT NULL CHECK (zone ~ '^[a-z][a-z0-9_]{0,31}$'),
  tariff_on date NOT NULL,
  bands jsonb NOT NULL CHECK (jsonb_typeof(bands) = 'array' AND jsonb_array_length(bands) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now()
);
```
   - It is a side table and not columns on cost_entries, so a database one migration behind fails only freight writes (42P01). Every other cost path keeps working (#1313).
   - Restate both in schema/wms.ts.

No migration for the setting `freight_tariff_cost_type_codes` (default ['freight']). It needs a description in all four bundles (settings tripwire).

Code: costs/actions.ts maps 23514 on cost_entries_basis_check and 42P01 on cost_entry_tariffs to server_behind by name.

Deploy:
- take a verified non-zero backup;
- `docker compose build migrate` first, then `up -d --build`;
- count `drizzle.__drizzle_migrations` = 133, and read the migrate container's own output if it is short.

Rollback below 0132: first move every freight bill to weight with the re-basis door. Older code's `default: return 1` would re-split freight bills equally by box count, and its missing `costing.bases.freight` label throws at render.

Docs:
- DECISIONS #1355+ (re-read the tail first; SARFLAR's round may take numbers);
- a CHANGELOG entry in Uzbek;
- CLAUDE.md state with ledger 133.

## Questions sent to him
## Q1. Mashina xarajatini tarif bo'yicha bo'lishda yukning zichligini (kg/kub) qanday o'qiymiz?
  - a) Har bir mijozning shu mashinadagi butun yuki birga: bitta zichlik, tarifdan bitta qator (VED narx berganidek). Mijozning o'z ichida, bir nechta lot yoki prixod bo'lsa, kub bo'yicha bo'linadi.
  - b) Har bir lot o'z zichligi bilan, tarifdan alohida qator bo'yicha.
  REC: a
  WHY: Mashinaga narx har bir mijozga bitta yoziladi, VED ham yo'lkirani butun yukning zichligidan hisoblaydi. (a) bo'lsa tannarx mijoz to'laydigan narx shaklida chiqadi va har bir mijozga bir xil foyda foizi qoladi. Misol: mijozda 1 kub 100 kg/kub va 1 kub 1100 kg/kub yuk bo'lsa, (a) bo'yicha $600 (aytilgan narx), (b) bo'yicha $715, ya'ni mijoz kerakdan og'irroq tortiladi.
## Q2. Tarifning qaysi ustunidan o'qiymiz: Xitoy ustuni yoki Qashqar ustuni?
  - a) Bitta hisobga bitta ustun. Odatda Xitoy ustuni olinadi, kerak bo'lsa xarajat kiritayotganda o'zgartirasiz. Oxirgi tanlov eslab qolinadi.
  - b) Har doim Xitoy ustuni, hech qanday tanlov yo'q.
  - c) Har bir skladga ustun yozib chiqiladi, mashina ustunni o'z skladidan oladi.
  REC: a
  WHY: Bo'lishda faqat ustun ichidagi qatorlar o'rtasidagi nisbat ishlaydi. Xitoy va Qashqar ustunlari deyarli bir xil shaklda (farq odatda 1 foiz atrofida). Siz aytgandek yo'nalish o'zgarib turadi, shuning uchun skladdan avtomatik olishni (c) tavsiya qilmayman.
## Q3. /admin/tarif keyin o'zgarsa, oldin bo'lingan mashinalar nima bo'ladi?
  - a) Ular qimirlamaydi. Hisob saqlanganda o'sha kundagi tarif hisobning o'ziga nusxa qilib yoziladi.
  - b) Har doim hozirgi tarif ishlatiladi. Tarif o'zgarsa, eski mashina tannarxi unga tegadigan keyingi har qanday harakatda (lot tuzatish, skaner, kechki hisob) jimgina o'zgaradi.
  REC: a
  WHY: (b) bo'lsa, narxi allaqachon qo'yilgan mashinadagi mijoz foydasi kimdir bir karobkani skanerlagan kuni o'zgarib qoladi va buni hech kim sezmaydi.
## Q4. Bu usul qayerda bo'ladi va qachon o'zi tanlanadi?
  - a) Faqat mashina (partiya) xarajatida. «Yo'lkira» turida o'zi tanlanadi, siz boshqasini tanlasangiz o'zgaradi. Boshqa turlar og'irlik bo'yicha qoladi. Rastamojkada bu usul bo'lmaydi.
  - b) Faqat mashina xarajatida, lekin hech qachon o'zi tanlanmaydi: har safar qo'lda tanlanadi.
  - c) Mashina xarajatida va zavod reysida ham.
  REC: a
  WHY: Rastamojka deklaratsiya bo'yicha hisoblanadi va nazoratda prixod bo'yicha solishtiriladi. Zavod reysi esa Xitoy→O'zbekiston tarifingizda yo'q yo'l.
## Q5. Oldin kiritilgan yo'lkira hisoblari nima bo'ladi?
  - a) Qanday kiritilgan bo'lsa shunday qoladi. Har bir hisobda «Bo'lish usulini o'zgartirish» tugmasi bo'ladi: saqlashdan oldin qaysi mijoz tannarxi qancha o'zgarishini ko'rsatadi. Pul, kassa va firma qarziga tegilmaydi.
  - b) Qanday bo'lsa shunday qoladi va tugma ham bo'lmaydi. O'zgartirish uchun hisobni bekor qilib qayta kiritasiz.
  - c) Mashinadagi hamma eski yo'lkira hisoblarini birdan tarifga o'tkazadigan tugma (oldindan ko'rsatib).
  REC: a
  WHY: Bekor qilib qayta kiritish oddiy qayta bo'lish emas. Kassadan to'langan hisobni bekor qilish uchun moliya kerak, firma qarzi bekor qilinib qayta yoziladi, dollar esa bugungi kurs bilan qayta hisoblanadi. Tugma faqat bo'linishni o'zgartiradi, o'tgan oylar faqat siz ko'rib saqlagan joyda o'zgaradi.
## Q6. Hisob saqlangandan keyin mashinaga tarif bo'yicha narxlab bo'lmaydigan yuk qo'shilsa nima qilamiz? Masalan, lot xato yozilgan: 3 kubga 1 kg.
  - a) Hisob saqlanadi, lekin mashina yukiga bo'linmay turadi. Narx sahifasida va mashina kartasida «⚠ $X bo'linmagan — GS777 A-1 lotini to'g'irlang» chiqadi. Lot tuzatilishi bilan hisob o'zi bo'linadi.
  - b) O'sha yuk tekinga ketadi ($0), qolgan yukka bo'linadi va ⚠ chiqadi.
  - c) O'sha safar butun hisob hajm bo'yicha bo'linadi va ⚠ chiqadi.
  REC: a
  WHY: (b) va (c) da raqam o'ylab topiladi. (a) da pul yo'qolmaydi, faqat ⚠ turadi, u ham faqat xato yozilgan lotda chiqadi. Agar tarifning o'zi to'liq bo'lmasa (masalan biror zichlik uchun narx yo'q), hisob umuman saqlanmaydi va «rahbariyat tarifni to'ldirsin» deb yoziladi.

## Honest limits
- The effect on his real money is UNMEASURED. There is no gsr_dev here, and gsr_card_perf and gsr_pkg_r2_perf hold the same synthetic data: 4,000 of 4,026 lots at 166.67 kg/m³, every live bill on 'weight'. Every basis reads 0 difference there. Synthetic re-draws (inferred) suggest one client's share moves a median of ~6.5 pp of the bill against weight and ~10 pp against volume, i.e. 40-60 % of that client's bill. Before he decides, he should run the read-only query (scratchpad prod-readonly-measure.sql, four SELECTs, 150 ms on the shaped copy) on his server.
- Direction: today's real default is WEIGHT (cost-panel.tsx:146; the grid hard-codes weight). Moving from weight to tariff shifts cost from dense goods to light goods. He may expect the opposite (the volume→tariff move). The reply must say this with the example.
- For a truck's OWN bills the «Partiya foydasi» total does not move, because the split conserves the bill. The change shows only on client and lot rows (pricing page, Mijoz foydasi, deal profit, seller profit). He may read that as «nothing changed».
- #783 is only partly closed. The grain is the client's cargo on THIS truck, not the VED's job. A client whose consignment is split across trucks, or who has two separately quoted deals on one truck, gets a blended band that need not equal either quote.
- One column per bill. A truck mixing Yiwu and Kashgar cargo uses one column for both. The synthetic difference is median 0.9 pp, p90 4.2 pp, and the gap is largest through the per-kg step (cn 1.83× vs ~1.55× elsewhere).
- His 999→1000 kg/m³ step (cn $320/m³ → $0.55/kg, +72 %) is kept as his tariff. A client whose combined density sits at the edge can jump on a tiny lot correction. The preview prints the band so it is not a surprise.
- The stable-measure fix covers UNIFORM lots only. A mixed lot's density still drifts slightly when growth or edits re-round its totals, and near a band edge it can still change band.
- bandDensityOf's 1e-6 pre-round also changes the CALC at mathematically exact .5 densities that float had on the wrong side. Drafts only, because seals are frozen. Stated and pinned, not hidden.
- Fail-closed: while an unpriceable lot stands, that bill is on no box. Per-client tannarx on that truck is understated and margins look higher. The person who edits the lot is not told at the press (editLot's recompute runs after commit or as a job). It surfaces on the truck-card todo, the pricing page ⚠ and the attention row.
- The live preview is drawn from the riders at page render. A carton that boards between render and save makes the saved split differ slightly from what was previewed.
- The per-prixod grid's yo'lkira cells stay on 'weight'. Inside a multi-lot prixod, per-lot tannarx from a grid cell is still split by weight.
- Internal Uzbek legs (AND→TAS) are split by the shape of his China table. That is the only table he has. The money then returns per carton through «keyingi yo'l», unchanged.
- Old bills keep their basis (no backfill). A month can mix shapes in seller profit and deal profit until he re-bases chosen bills by hand. The CHANGELOG must say so.
- A re-basis re-reads the tariff as of the BILL's date, not today's. To apply a newly typed price to an old truck, the tariff row must be dated on or before that bill's cost_date.
- The pairing «freight basis ⇔ a tariff copy exists» spans two tables and cannot be a DB CHECK. It rests on the single writer, and costPool fails closed with «tarif nusxasi yo'q» when the row is missing.
- Revenue-side splits (deal-price-hint, stamp-split) now match the cost shape only because the grain is the client plus m³ inside the client. KPI, upsale, the P&L, cash, ledgers and the cabinet are untouched by design.
- Not verifiable here: production warehouse codes and names, whether horgos or other zones are priced, and whether he has made dated tariff edits since 2026-01-01. A bill dated before his first tariff row cannot use this basis and is refused in words.
- Owner's arithmetic: 2×$300 + 1×$100 = $700, not $400. In his seeded table $100/m³ exists only in the Qashqar column (Xitoy's cheapest is $110), so his numbers are illustrative. On one real column the same cargo reads 276.32/73.68 (Xitoy) or 278.57/71.43 (Qashqar).

## Critique findings absorbed
- MONEY blocker: freight_zone/date/bands columns on cost_entries would throw 42703 on every cost read and write one migration behind (drizzle names every column). The frozen copy goes in a SIDE TABLE `cost_entry_tariffs`, read with raw SQL only when allocation_basis='freight'. A lagging db fails only freight writes (42P01 → server_behind).
- MONEY defect: band flips from re-rounded lot totals on QR-siz growth or edits, and from x.5 float values (measured: $109.82 moved on an untouched truck). Box measures for the weighting are taken from the uniform lot's own box dims and box weight, which growth never moves. bandDensityOf pre-rounds to 1e-6 (one home, calc effect stated). Pinned with the 40 cm / 63.968 kg (32 vs 33 cartons) and 21 cm / 9.256 kg fixtures. Mixed-dims drift is accepted and stated.
- MONEY defect + USE defect: a bill that splits onto nothing was invisible on the pricing page. One predicate is shared with profitByBatch.unallocatedUsd, shown as a ⚠ line on the pricing page, a truck-card «Qolgan ishlar» todo for whoever can fix the lot, and a per-truck link on the attention row. The internal-leg «xarajat yozilmagan» warning stops counting an unsplit bill as written.
- MONEY defect: a tiny uniform lot with total m³ rounding to 0.0000 got measure_missing. Dims-derived per-box m³ gives it a finite density (a 4×4×3 cm carton lands in the per-kg band). This is better than inventing a top band for kg/0.
- MONEY defect: void-and-re-enter is not a pure re-split (merged costs, kassa needs finance, firm debt re-posted, dollars re-converted). Added a `rebaseCost` door that changes only basis, zone and the tariff copy (as of cost_date), with a server preview and a compare-and-set on what was seen, plus an audit. It is also the rollback tool.
- MONEY nit: the snapshot is read only behind basis==='freight' (fenced), so weight/volume recomputes never touch the side table. `columnGaps` also requires an open top band, so a steel lot cannot fail a bill later.
- MONEY nit (#824): no test writes shared tariff rows. The freeze is proven in pure tests over the copy, and the one integration proof uses a private per-run zone `t_<token>`, deleted as a final test.
- USE defect: the explanation leaked the list rate/value (and the VED's per-unit figure) to the logist/viewer through the Xarajatlar door. $/kub and the tarif qiymati are drawn only under pricingSight==='full'. Others see band + %. The VED gets no per-client $.
- USE defect: a blocking pre-save preview would train him to click through the twin confirm he asked for (his answer 6). The preview is live and non-blocking (server-computed group %, the browser multiplies the typed amount). The twin warning stays the only blocking confirm. Freight refusals run BEFORE the twin check.
- USE defect: no explanation after save. `batchClientCostBreakdown` groups by allocation_basis and prints the client's band and $/kub on the Narx tab, re-derived from the bill's copy by the same pure helper, linked to the bill.
- USE nit: the per-lot fold on the wrong tab, and the 8-column fold overflowing 360 px. No fold is built. The explanation lives in two-line preview rows and on the Narx breakdown. e2e asserts clientWidth == viewport at 360.
- USE defect: freight refusal params and server_behind could not reach the screen (the code printed raw). CostActionResult gains params and unsplit, the panel gets a literal map with ICU params in four bundles, and a derived fence pins every `new CostError` code under costing against that map.
- USE defect: refusing the SAVE over one bad lot pushed the accountant onto 'weight' for good. Only tariff CONFIGURATION is refused at save. Lot data saves the bill, which stays unsplit with ⚠ naming the lot and who fixes it.
- USE nit: zone words. «Xitoy ustuni»/«Qashqar ustuni» (ru колонка Китай, en China column, zh 中国栏), never the route words of calc.zones (his Q3: direction is not a stable fact), never the raw code. U+2018 typography as in the bundles.
- USE nit: a required zone pick on the commonest bill. It defaults to Xitoy and shows as a folded «ustun: Xitoy ✎» line, with the last pick remembered per viewer (localStorage in try/catch).
- USE nit: preselect rules. The new setting `freight_tariff_cost_type_codes` (default ['freight']) lets his own minted types qualify. Preselect happens only while the select is untouched. The option is hidden for customs codes and also refused in the service (#531).
- USE nit: a gap-refusal dead end. The sentence names the hole and «rahbariyat to‘ldirsin». /admin/tarif is linked only for admin.dictionaries.manage holders.
- USE nit: zone options computed for today while the date is edited in the browser. The server passes the % sets per (zone × tariff version). The browser chooses by the typed date, and the save re-validates with a sentence naming the date.
- USE nit: preview cents not adding up (328.13 + 21.88 = 350.01). Cents are re-split by largest remainder, pinned by a literal test.
- USE nit: the per-prixod grid is a second yo'lkira door. A muted line in its yo'lkira column header points to the bill form. The grid stays 'weight'.
- ENGINE trap: `default: return 1` (engine.ts:53-54). The switch becomes exhaustive with a never check. `freightWeight` is REQUIRED on AllocBox, so both pool builders fail to compile until they learn it. allocateEntry returns [] on any non-finite or ≤0 freight weight.
- ENGINE trap: two pool builders (recomputeEntry, costOrphanedByVoid). One `costPool` serves both, and a fence makes it the only caller of allocateEntry.
- ENGINE/TARIFF trap #714: tariffFor runs on the pool. The tariff is read only pre-tx at save/rebase. Recompute and the three void doors read the copy on their tx handle, so no void door changes and tx-pool.test.ts stays green.
- TARIFF trap: the dictionaries.ts import cycle with costing. tariffFor/tariffHistory move to a leaf `calc/tariff-read.ts` and bandsAsOf to pure pricing.ts, both re-exported. A fence forbids costing/** importing calc/dictionaries.
- ENGINE trap: four hand-copied basis lists plus a runtime-built i18n key. `ALLOCATION_BASES` const, and basis-vocabulary.test.ts pins const = zod = panel = schema CHECK = 0132 CHECK, plus `costing.bases.<b>` in all four bundles anchored on the const (#163).
- ENGINE trap: 23514 white page on deploy morning. costs/actions.ts maps cost_entries_basis_check (23514) and cost_entry_tariffs (42P01) to server_behind by name, the 0125 idiom.
- ENGINE/TARIFF trap: history re-split by a later tariff edit, an in-place same-date overwrite, or a back-dated row. The frozen copy as of cost_date makes all three no-ops for a saved bill. Red-proven by reading the live tariff instead.
- TARIFF trap: NaN admitted by calc_freight_tariffs' CHECKs. The copy is validated as finite on write and on read.
- TARIFF trap: an overlap after changed floors gives band_ambiguous. columnGaps refuses at save, and a frozen copy is never affected by later edits.
- TARIFF/ENGINE trap: a zone inferred from a warehouse or guessZone. Never: the zone is chosen per bill, defaulting to the Xitoy column.
- ENGINE trap: pickup's nightly re-split following the tariff, and the factory road not being on the CN→UZ table. The new basis is not offered on pickup.
- ENGINE trap: E1 actuals treating an unsplit customs bill as legitimate. Freight is refused and hidden on customs codes.
- REVENUE trap: per-lot cost shape disagreeing with linear revenue splits inside a client (deal-price-hint, stamp-split by m³ first). The client grain plus the m³ split inside the client makes the cost shape match both.
- REVENUE trap (#783): a per-lot band ≠ the quote's blended density. The client-on-truck grain uses one combined density per client, as the VED quotes it (two-lot client: $600 not $715).
- DATA trap: the shaped copies cannot validate this (every lot 166.67 kg/m³, every bill 'weight'). Fixtures span ≥3 bands including ≥1000, and the effect is measured on his server with the read-only query before he decides.
- REJECTED from design 1: «only a per-lot origin zone reproduces his 300/50». False. His $300 and $100 are illustrative and his numbers reproduce exactly as typed rates. Within the Qashqar column alone, 1000 kg/m³ prices $0.30/kg = $300/m³ (tariff-seed.ts:52-66).
- REJECTED: design 1's «a lot's weight never depends on other cargo» as the deciding virtue. Under the chosen grain a client's own lot edit or a claimed prixod re-prices that client's other cargo on the same truck. That matches his quote and moves nobody else's share ratio, which is stated.
- REJECTED: refusing the save for an unpriceable lot (both designs) and giving that lot weight 0. Both invent or lose money. Fail-closed plus a visible ⚠ is the chosen rule (owner question 6).