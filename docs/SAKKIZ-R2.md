# Sakkiz band — ROUND 2: customs and freight answered more often, from deterministic sources

Build contract for a kernel commit (K, the lead) and four parallel worktree packages
(P1 «Javob», P2 «Baza», P3 «Kiritish», P4 «Lenta»). Item 2 of his 2026-10-20 message,
diagnosed in `docs/SAKKIZ-BAND.md` §3 (the item-2 diagnosis with file:line evidence).
His answers 2.1-2.9 (2026-10-21, §11) are binding.

- Base: branch `claude/telegram-customs-ai-issues-1c336s`. The lead cuts K from the
  branch head when R2 starts and writes K's hash here. Every package branches from K.
- **K = `4bf1e361246051faa44296fcf0b538350577aa4a`** («Sakkiz R2 K: the kernel — seams moved and added, behaviour unchanged»).
- **No migration.** The ledger stays at **136** (§11 says why).
- DECISIONS numbers are `#R2-1…`. The lead renumbers them at the merge, after fetching
  the tail; the R1 review rounds are writing #1463 onward.
- Judged before code by five lenses (law-money, regression, product-fit, performance,
  concurrency) with refuters. Every confirmed and partial objection is absorbed below;
  §15 lists each id, its verdict and what changed.

## Questions for the owner

These are the decisions his answers 2.1-2.9 do not settle and that change what gets
built. ⭐ = what is built if he does not answer. The Uzbek wording is in §13.

1. **Taxminiy when some rows still have no figure.** His 2.2 question named rows
   «umuman hisoblanmagan», and he chose two totals without saying what Taxminiy is then.
   - a) ⭐ Taxminiy is printed only as a WHOLE figure: every row has an exact baza or a 📊
     median. Otherwise the reply prints «Taxminiy: hisoblab bo‘lmadi — …» and names why.
     This is MR-23's no-partial-sums rule applied to the estimate.
   - b) A partial Taxminiy carrying its own row count:
     «Taxminiy ≈ $Y (10 tadan 9 qator, yig‘imsiz)».
   - The §14.6 measurement reports how often (a) leaves Taxminiy absent on his real data.
2. **The zone on a yo‘lkira-only request.** 2.6 b was asked about podklyuch.
   - a) ⭐ Guessed from the city by the same rule, labelled «taxmin».
   - b) Not guessed: a yolkira job with no zone is answered «zona tanlanmagan».
3. **Other Chinese cities** (Foshan, Shenzhen, Urumqi…).
   - a) ⭐ Not guessed. The reply names the city and says «zona aniqlanmadi». The word
     «Xitoy/Китай/China» with no known city still means the Xitoy zone.
   - b) Every Chinese city that is not Qashg‘ar or Horgos goes to the Xitoy zone.
4. **One goods line whose weight is given only as the shipment total.** The bot now
   asks that total explicitly as BRUTTO.
   - a) ⭐ As today: the total is copied onto the single line and the row note says
     «og‘irlik umumiy (brutto)dan olindi». The Telegram customs line now also says
     «og‘irlik bruttodan». Customs on a per-kg baza is then priced on brutto.
   - b) Not copied: the bot asks for the line's netto weight, and customs waits for it.

---

## 0. His answers, and what each one becomes

| # | His answer | What is built | Package |
|---|---|---|---|
| 2.1 **b** | No baza found → the MEDIAN of real declarations of the same code, counting only those whose unit and weight per piece match. Printed «taxminiy, N ta deklaratsiyadan». Never an AI baza, never the invoice price. | A chat-only shadow estimate. `percentile_disc(0.5)` over China declarations of the row's exact 10-digit code, in the file the chooser picks for that code. Uses a unit the row allows; dona must also fall in the ±25 % per-piece band. At least `FEW` = 5 declarations. Read as ONE statement per (code, batch), strictly one after another, under a 10 s budget per pass (§6.6). **Never written to any row.** | P1 |
| 2.2 **b** | Two JAMI in Telegram: «Aniq: $X (10 tadan 7 qator)» and «Taxminiy ≈ $Y». | The reply's customs total becomes two lines when anything is blocked (§2.2). Taxminiy is whole or absent (⭐ of Question 1). The VED screen and the seal keep the kernel's «no partial sums». | P1 |
| 2.3 **a** | Customs is in practice always from the customs baza. | The invoice price is never read, shown or used. The `amount` column stays unread. The median is taken over the file's declared customs value per unit. | all |
| 2.4 **c** (he chose c, not the ⭐ b) | The estimate goes onto the card's LENTA in full, with a separate mark for the VED. | The lenta copy is the full reply with one «🔎 VED uchun:» line directly under its heading (P1). The note's chip says when an estimate is inside (P4). His 2.4 b reason, «taxminiy raqam VED ning rasmiy narxiga ta'sir qilmasin», is kept where it bites: the «Готово» price box prints a reminder that none of these figures is official (P2). | P1 + P2 + P4 |
| 2.5 **b** | A yo'lkira-only request is answered at once from the tariff table, no AI. | Yolkira jobs go to their OWN queue, `calc.tariff-reply`, so a tariff answer never waits behind a customs pass's model calls. The pass makes no model call and replies with the tariff's list price, band and route. Every request gets at most ONE machine message, including on a redelivery. | P1 |
| 2.6 **b** | Podklyuch without a zone: guess from the city (YW/GZ → China zone, Kashgar → Kashgar) and say «taxmin». | `guessZone` in two tiers. A known CITY decides: Yiwu/Guangzhou beat Kashgar/Horgos wherever they stand (his 21a), and Kashgar vs Horgos goes to the leftmost. A country word counts only when no city matched. The reply names what it read («zona «Yiwu»dan taxmin»). A known city whose zone has no tariff price says so. The guess prices the reply only. **It is never stored.** It also applies to yolkira (Question 2). | P1 |
| 2.7 **b** | Total m³ is SUMMED from the lines; brutto kg is ASKED (line kg is netto). | One Σ rule, all-or-nothing (`linesVolumeM3`). The Σ is stored at the INSERT, because MR-9's upsale denominator needs a request m³. It is LABELLED wherever it is printed: the label is derived at read time (`Workspace.volumeFromLines`), never stored. The collector asks brutto kg on every freight section and keeps the answer across re-reads. Line kg is never summed. A per-carton CBM column is no longer read as the line's volume. | K + P3 + P1 + P2 |
| 2.8 b | — | **Not this round** (needs round 3's durable collection). | — |
| 2.9 **c** | AI limit: measure first; a dollar ceiling comes in round 5. This round only fixes the COUNT. | Failed reads now count. A call counts when the model ANSWERED it (§7.5): every re-read, every refused or cut grouping answer, and the pick. The pick's usage is RETURNED and recorded with `await`, not through a fire-and-forget callback. | K + P2 + P3 |
| (no question) | `calc_bazas` goes SECOND, inside `saveTable`'s fill. | One ordered fill: memory → dictionary → import, inside the transaction. A person's clear of a stored baza is respected in that save. A machine save after a person's save is refused by a revision compare-and-set. | P2 |
| (no question) | Import search by a 4-6-digit heading. | `codeMatchSql`: a 10-digit code is matched exactly; a shorter one by a btree RANGE, under a statement time limit. Feeds the AI pick, which recodes the row, says so in the row's reason, and raises the `ai_recode` warning that the ✅ records. Also feeds the VED's 📥 list, judged per candidate by the candidate's own law. The model-free auto-fill and the statistics stay exact. | P2 |
| (no question) | Newest-batch shadowing. | A per-code batch chooser (§7.3), safe without R0's numbers. It is total: a code that no file holds answers from the newest ready file, as today. | K + P2 |
| (no question) | Richer input to the grouping model. | Weight, volume, measure pair and note go into the listing. | P2 |
| (confirmed, NOT this round) | The memory does not learn from «Готово» answers. | Stated, not built (§12). | — |

### 0.1 Interpretations stated to him (in the round's Uzbek report, §13)

1. **2.6 is applied to yolkira too** (⭐ of Question 2). He named podklyuch because the
   question was about podklyuch. A yolkira job has the same freight half and the same
   missing zone, and none of the three doors asks a zone on yolkira. Without the guess,
   2.5 b would answer almost nothing.
2. **The zone guess, in two tiers** (⭐ of Question 3).
   - Tier 1, CITIES. Kashgar's spellings → kashgar. Yiwu and Guangzhou spellings → cn.
     Horgos's spellings → horgos. A cn city wins wherever it stands, because his 21a
     keeps Yiwu/Guangzhou cargo on the China price whichever border the truck takes:
     «Qashqar orqali Yiwu» → cn, «Horgos (Yiwu yuki)» → cn. Between kashgar and horgos,
     the leftmost match wins.
   - Tier 2, the COUNTRY word «Xitoy/Хитой/Китай/China/中国» means cn only when no city
     matched. So «Китай, Кашгар» → kashgar (the ordinary Russian address shape), and
     «Xitoy» alone → cn.
   - Any other Chinese city (Foshan, Shenzhen, Urumqi…) is NOT guessed. «Foshan» → the
     reply names the city and says «zona aniqlanmadi». «Foshan, Xitoy» → cn by tier 2,
     and the reply shows exactly what it read («zona «Foshan, Xitoy»dan taxmin»), so a
     wrong guess is visible to the seller.
   - A known city whose zone has no tariff price («Horgos» today) is told that the price
     is missing, never that the city was not understood.
3. **«Aniq» excludes the declaration fee.** The fee's tier depends on the WHOLE
   declaration (MR-23's own objection), so a fee on 7 of 10 rows could be in the wrong
   tier. The line reads «(10 tadan 7 qator, yig‘imsiz)». «Taxminiy» includes the fee,
   taken on the estimated full value.
4. **«Aniq» means "the number the VED's screen prints today"**, not "official". Its
   bazas stand on the rows (typed, 🧠, 📖, 📥) and the VED can see every one. «Taxminiy»
   stands on at least one 📊 median, which is written onto no row, group, seal, offer or
   price-channel post: it stands only in the chat reply and, as text, in the card's lenta
   note (his 2.4 c). The median itself is the number the 📥 dialog prints as «50 %
   (mediana)» for that row and unit, so the VED who opens the row sees it there.
5. **The lenta chip is shown to every reader of the lenta**, not only the VED (§3). It
   says when the note carries an estimate. The «🔎 VED uchun:» line, directly under the
   note's heading, speaks to the VED. The «🤖 AI taxmini · rasmiy emas» chip stands on
   every customs reply the machine writes, one that priced nothing («Rastamojka jami:
   hozircha hisoblab bo‘lmadi») included — accepted, not missed (late pass, review
   P4-3). Such a note is still the machine's reading for the VED to check — the groups
   and codes it found, each refusal and who fixes it — and its heading says «taxminiy
   rastamojka» (PF-6), so the chip and the note agree. A refused yolkira reply wears no
   chip (PF-9) because nothing in it is the machine's but the missing facts. Taking the
   chip off the AI's non-answer needs a mark the writer prints only on a priced reply
   (PF-9 used the title's «taxminiy»; the chip never reads refusal words, #513), i.e. a
   change to the reply's own words in the seller's chat — the reply's to make, not the
   lenta's.
6. **The Σ m³ is stored at the INSERT, and labelled by derivation.** MR-9 keeps a request
   m³ for the upsale's denominator, and the checklist stops asking a total the lines
   already give. So the Σ is stored. Whether a stored m³ «came from the lines» is
   decided at read time: it equals Σ of the lines at 3 decimals. A total the seller
   typed that happens to equal the Σ is labelled «qatorlardan» too. That is accepted:
   the label then tells the truth about the numbers.
7. **Every refusal says who can fix it.** A fact only the seller or the customer has
   (the city, brutto kg, m³, a missing count) ends «— mijozdan so‘rab, kartadagi lentaga
   yozing». Only what the VED decides (a baza, a tariff hole, a stored number that is
   not a number) ends «— VED xodimi …». Until round 3's «➕ Shu so‘rovga qo‘shish» door,
   the lenta is the seller's one way to add a fact to a landed request.

---

## 1. Laws this round must keep (and the fences that enforce them)

- **Law 1: the model never reaches a number.** No new `baza_source` value. The median
  is a DECLARED price (`percentile_disc`, a price some declaration carries). The model
  still picks only an index into filed declarations. When the pick recodes a row, the
  new code is the declaration's own code, and the code decides the duty law. That
  choice is therefore a MODEL choice of law, the same kind the grouping model already
  makes and the ✅ already confirms. It is flagged like one: the row's reason says
  «AI kodni o‘zgartirdi: 6403 → 6403991000 · …», the derived `ai_recode` warning stands
  until a person ✅s it (recorded in `confirmed_warnings`), and E1 counts the group
  among the AI's (§7.4). Fences:
  - `ai-advisory.test.ts`, re-anchored by K;
  - P1's new `estimate-wire.test.ts`, which also fences the IMPORT DIRECTION: the
    estimate has no reader outside the bot's reply;
  - the 0094/0096 CHECK assertions, unchanged.
- **The machine never writes over a person.** Every machine save after the grouping
  claim is released carries the revision its own previous write left
  (`saveTable(…, { expectRev })`). A person's save in between turns the machine's save
  into `conflict`, which writes nothing (§7.2.7).
- **MR-23 (no partial sums) stays the kernel's law.** Neither `requestCustomsFor`, nor
  `loadWorkspace`, nor the live bar, nor the seal changes.
  - «Aniq» is a NAMED partial: it states its own row count and says it has no fee.
  - «Taxminiy» is a WHOLE figure or nothing. It is computed by `requestCustomsFor` over
    the shadow inputs, so the same no-partial rule decides when it exists.
  - `ai-reply.ts`'s belt (`blocked` → no «Rastamojka jami: ≈») stays.
- **Never $0, never a code.** Every refusal is a sentence. Every new refusal union gets a
  `Record<Union, string>` word map, so a missing entry is a compile error.
- **#714, and the pool of ten.** No pool read inside any transaction.
  - `batchesForCodes`, `bazasFor`, `ratesForCodes` and `getSetting` run before the
    transactions.
  - The median statements run inside `underCeiling` (each statement ≤ 1500 ms) and touch
    only `tx`. They run STRICTLY one after another (`for … of` with `await`). There is no
    `Promise.all` or `Promise.allSettled` in `estimate-read.ts`, because each
    `underCeiling` holds one of the ten pool connections that every page shares.
  - Heading-range candidate reads run under a statement ceiling as well (§7.4).
  - `tx-pool.test.ts` is derived and must stay green. It does not scan `underCeiling`
    bodies, so `estimate-wire.test.ts` pins that body instead.
- **Bounded work.** The customs pass has a wall-clock deadline (`PASS_DEADLINE_MS`). The
  median read has its own budget (`ESTIMATE_BUDGET_MS`). The job's pg-boss expiry is set
  above both, so pg-boss never re-delivers a pass that is still running (§6.8).
- **#513: one home per rule.**

  | Rule | Its one home |
  |---|---|
  | Σ m³ | `linesVolumeM3` (K) |
  | «Did this m³ come from the lines» | `Workspace.volumeFromLines` (K) |
  | Zone guess | `zone-guess.ts` |
  | Row → file units | `unitsForItem` (K) |
  | Which batch | `batchesForCodes` |
  | Heading match | `codeMatchSql` |
  | Fill order | P2's one ordered loop |
  | Stale cutoff | `bazaStaleCutoff` (K) |
  | Machine-reply heads and the VED mark | `reply-heads.ts` (K) |
  | Freight answer, and who fixes a freight refusal | `freightAnswerFor`, `FREIGHT_TAIL` |
  | Estimate | `estimateCustoms` |
  | «Weight copied from the shipment total» | `weightFromTotalNote` (K, beside `LONE_WEIGHT_NOTE`) |
  | One machine message per request | `sayOnce` (P1, `calc/say-once.ts`) |
  | Which queue a job goes to | `queueCalcPrefill` |
  | The AI recode mark | `AI_RECODE_PREFIX` (`warnings.ts`) |

- **Footguns.**
  - drizzle numeric comes back as a string: `Number()` every read.
  - Dates in raw SQL are ISO text cast `::timestamptz` / `::date`.
  - JS arrays go through `inArray` / `sql.join`.
  - Text bounds are bound as strings.
  - i18n keys go into all four bundles (§10).
- **Process.**
  - Red proofs are made and undone by string edit only (#430). Never `git checkout` or
    `git stash`.
  - Each gate runs with its own exit code (#803).
  - Run `pnpm typecheck` before every commit.
  - The model identifier is never written anywhere.
  - Trailers as in the history.

---

## 2. What the bot prints — exact Uzbek

Apostrophe `‘` (U+2018), as `ai-reply.ts` already writes. `money(n)` = `$${n.toFixed(2)}`,
unchanged.

### 2.1 A customs line (one line per GROUP — unchanged rule)

- **Exact group.** Unchanged:
  ```
  1. Kurtka · 6201400000 · 300 kg × $4.10/kg 🧠
     boj 10% · QQS 12% → $180.40
  ```
- **Estimated group.** Every baza-less row got a median, and the shadow `customsFor` is ok:
  ```
  2. Shim, Ko‘ylak · 6203420000 · 120 kg × $3.80/kg 📊
     boj 10% · qo‘shimcha boj 10% (sertifikat yo‘q) · QQS 12% → ≈ $142.30 (taxminiy, 23 ta deklaratsiyadan)
  ```
  - Several medians in one group: `(taxminiy: 23 va 8 ta deklaratsiyadan)`. At most three
    numbers, then ` …`.
  - The batch is older than `BAZA_STALE_DAYS`: ` · eski fayl, 2025-12-31 gacha` goes
    inside the parenthesis.
  - `measureText` is computed on the SHADOW items. When the shadow bazas are not one
    shared value it is `null`, the rule that already applies to exact groups.
  - 📊 is printed after any source mark: `… 🧠 📊` when the group mixes 🧠 and 📊.
- **Weight copied from the shipment total** (⭐ of Question 4). When any priced row of
  the group carries `LONE_WEIGHT_NOTE` in its note (`weightFromTotalNote`, K), the
  measure part gains ` (og‘irlik bruttodan)`:
  `1. Kurtka · 6201400000 · 300 kg (og‘irlik bruttodan) × $4.10/kg 🧠`. The same mark
  goes on an estimated group. The row note already says it to the VED; this says it to
  the seller, who reads the figure.
- **Refused group** (unchanged first line) plus, when its baza-less rows got no median,
  ONE more line:
  ```
     ⚠️ Kurtka: 2-qator «Kurtka qishki»: baza yo‘q — VED xodimi qo‘yadi
     📊 taxmin yo‘q: 2-qator — faqat 3 ta deklaratsiya (kamida 5 kerak)
  ```
  - At most three rows, then ` …`.
  - The first line is the SHADOW's refusal whenever an estimate was attempted for the
    group. It names what still blocks even the estimate.

### 2.2 The customs total (replaces `ai-reply.ts:200-216`)

Rules are tried top to bottom; the first that applies wins:

| State | Printed |
|---|---|
| The workspace has an exact total (`requestCustomsFor` ok) | `Rastamojka jami: ≈ $X` — **unchanged** |
| No row is exact (`exactRows = 0`) AND no Taxminiy | `Rastamojka jami: hozircha hisoblab bo‘lmadi.` — **unchanged**, plus the fee line rule as today |
| Anything else | the three-line block below |

```
Rastamojka jami:
  Aniq: $1234.00 (10 tadan 7 qator, yig‘imsiz)
  Taxminiy ≈ $1980.00 (yig‘im 1.5 BHM ≈ $50.00 bilan)
```
- `10` = every goods row of the request (`ws.groups[].items` + `ws.ungrouped`).
- `7` = rows inside groups whose customs is exact.
- `Aniq` = Σ of those groups' `customsUsd`, **without the fee**.
- When no row is exact: `  Aniq: hali yo‘q (10 tadan 0 qator)`.
- When Taxminiy is absent, one of (tried in this order, first that applies):
  - `  Taxminiy: hisoblab bo‘lmadi — kodsiz qator bor (VED kod qo‘yadi)` (ungrouped rows);
  - `  Taxminiy: hisoblab bo‘lmadi — ⚠️ qatorda soni yoki og‘irligi yo‘q — mijozdan so‘rab, kartadagi lentaga yozing`
    (a group's shadow refuses `measure_missing`: a fact only the seller has);
  - `  Taxminiy: hisoblab bo‘lmadi — vaqt yetmadi, statistika o‘qilmadi` (a baza-less
    row's median miss is `budget` or `timeout`: the median budget, the pass deadline or
    a statement ceiling ran out, §6.6);
  - `  Taxminiy: hisoblab bo‘lmadi — ⚠️ bazasi yo‘q qatorlarni VED to‘ldiradi` (a group
    still refuses on the shadow for any other reason: no median, a law, a floor);
  - `  Taxminiy: hisoblab bo‘lmadi — bojxona yig‘imi: <feeRefusalText>` (only the fee
    refused).
- Taxminiy is WHOLE or absent (⭐ of Question 1). Built as (b) instead, the line would
  read `  Taxminiy ≈ $Y (10 tadan 9 qator, yig‘imsiz)`. In that shape it carries no fee,
  for the same tier reason as Aniq.
- With a typed fee override (`fee_override_usd`): `(yig‘im ≈ $X bilan)`, no BHM.
- No literal «JAMI» appears on a customs-only reply. `ai-reply.test.ts:87-92` stays.

### 2.3 Podklyuch road and JAMI (replaces `ai-reply.ts:217-231`)

- Road priced: `Yo‘lkira (<route>, <band>): ≈ $1920.00`, where:
  - `<route>` = `ZONE_ROUTE[zone]`, plus ` — zona «<read>»dan taxmin` when the zone was
    guessed. `<read>` is the request's `from_city` exactly as stored, cut at 40
    characters with `…`. The VED's workspace hint already prints the city the same way.
  - `<band>` = `180 kg/m³ · $160/m³ × 12 m³`, with ` (qatorlardan)` after the quantity
    when `volumeFromLines` holds (§6.4 step 3).
  - Example: `Yo‘lkira (Xitoy → O‘zbekiston — zona «Yiwu»dan taxmin, 180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)): ≈ $1920.00`
- `small` adds a line: `⚠️ Juda kichik yuk (yo‘lkira $50 dan kam) — VED ko‘rib chiqadi.`
- Road refused: `Yo‘lkira: ⚠️ <words> <tail>`. `<words>` comes from §2.5, and `<tail>` is
  `FREIGHT_TAIL_WORDS[FREIGHT_TAIL[case]]`. Today's single «— VED xodimi hisoblaydi»
  tail is right only for the cases the VED decides.
- JAMI:
  - Exact customs total and stored-zone road both priced:
    `JAMI (rastamojka + yo‘lkira): ≈ $X`. **Unchanged** — and only when the road is the
    workspace's own figure (`exact`, §16 law-money-R2-1): a road on the lines' Σ for a
    cube the request does not hold is «JAMI taxminiy».
  - A road is priced AND a customs figure exists (exact total or Taxminiy), AND at least
    one of them is an estimate (Taxminiy used, or zone guessed):
    `JAMI taxminiy (rastamojka + yo‘lkira): ≈ $Y`.
  - Otherwise: `JAMI: hozircha hisoblab bo‘lmadi — yuqoridagi ⚠️ ni to‘ldiring.`
    **Unchanged.**
- A Σ m³ is DATA (every line states it), not a guess. On its own it does not make the
  JAMI taxminiy, but it is always labelled where it is printed: the bot's reply, the
  tariff reply, and the VED's m³ cell (§7.2.8).

### 2.4 The yolkira reply (2.5 b) — new `tariffReplyText`, starts with `TARIFF_REPLY_HEAD`

```
🧮 Yo‘lkira (tarif bo‘yicha) · taxminiy · GS777 · B-000067
Xitoy → O‘zbekiston — zona «Yiwu»dan taxmin
180 kg/m³ · $160/m³ × 12 m³ (qatorlardan)
Yo‘lkira: ≈ $1920.00
⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.
Karta: https://…
```
- When refused: line 1 without ` · taxminiy`, then `Yo‘lkira: ⚠️ <words> <tail>` (§2.5),
  then `Karta:` (chat only).
- It never mentions «rastamojka», «AI» or the budget. This pass makes no model call,
  and the existing integration test `calc-prefill.integration.test.ts:428` asserts the
  text does not contain «rastamojka».
- The client and card labels come from `requestAbout`. That call is lifted out of its
  customs-only gate.
- **Latency.** The job sits on its own queue (§6.8). It waits one pg-boss polling
  interval (about 2 s), then the notification drain's kick. It never waits behind a
  customs pass, whose model calls can each take up to 2 × 60 s.
- **Order in the chat.** The bot's own «saqlandi» confirmation is sent right after
  `landIntake` returns, and the tariff job needs at least one polling interval. The
  reply almost always arrives second. If it ever arrives first, it is still
  self-describing: it carries the client and card labels. That order is accepted and
  stated, not engineered.

### 2.5 Freight refusal words and who fixes them (`freight-answer.ts`)

`FreightRefusalCase` is a union. `FREIGHT_WORDS: Record<FreightRefusalCase, …>` and
`FREIGHT_TAIL: Record<FreightRefusalCase, 'seller' | 'ved'>` are both keyed on it, so a
case with no words or no tail is a compile error.

| Case | Words | Tail |
|---|---|---|
| `no_city` — no zone, no from-city | `yo‘nalish (zona) tanlanmagan — qaysi shahardan yozilmagan` | seller |
| `city_unplaced` — no zone, the city matches no vocabulary | `yo‘nalish (zona) tanlanmagan — «Foshan»dan zona aniqlanmadi` (city cut at 40 chars) | ved (§16, PF-4; was seller) |
| `zone_unpriced` — the city is known, the tariff has no price for its zone | `«Horgos» → O‘zbekiston narxi tarifda hali yo‘q` (the zone's `ZONE_ROUTE` label) | ved |
| `kg_missing` | `umumiy brutto og‘irlik (kg) yo‘q` | seller |
| `m3_missing` — request and Σ | `umumiy hajm (m³) yo‘q` | seller |
| `both_missing` | `umumiy hajm (m³) va brutto og‘irlik (kg) yo‘q` | seller |
| `band_missing` / `band_ambiguous` / `not_a_number` | `prefill-reply.ts`'s `FREIGHT_REASON`, unchanged | ved |

`FREIGHT_TAIL_WORDS`:
- seller → `— mijozdan so‘rab, kartadagi lentaga yozing`;
- ved → `— VED xodimi hisoblaydi`.

### 2.6 The lenta copy (2.4 c)

- `lentaText` = the chat text without its `Karta:` line.
- PLUS exactly one VED line, placed DIRECTLY UNDER THE HEADING (line 2), only when
  something in the reply is an estimate (any 📊 line, or a guessed zone). It begins with
  K's `VED_ESTIMATE_MARK` (`🔎 VED uchun:`):
  ```
  🔎 VED uchun: bu AI taxmini, rasmiy emas — 📊 baza deklaratsiyalar medianasidan · zona «Yiwu»dan taxmin. Muhrlashdan yoki «Bajarildi» (Готово) bosishdan oldin o‘zingiz tekshiring.
  ```
  - The two middle parts are joined with ` · ` and appear only when they apply.
  - Placed under the heading, not before the legend: a note can run to 25 group lines,
    and the VED skimming the lenta reads its first lines.
  - The condition stays «a 📊 line or a guessed zone». A named partial Aniq says what it
    is on its own face (law-money-2 was refuted, §15).
- On a yolkira reply with a guessed zone the line reads
  `🔎 VED uchun: zona «Yiwu»dan taxmin, rasmiy emas — zonani o‘zingiz tanlang.`
- The legend gains `📊 deklaratsiyalar medianasi (taxminiy)` when a 📊 line is printed.
- P4's chip reads the mark (§9.2): an estimate inside the note is visible from the
  chip alone.

### 2.7 Misses — why a row got no median (`Record<MedianMiss, string>`, `estimate.ts`)

| `MedianMiss` | Words |
|---|---|
| `short_code` | `kod to‘liq emas (10 xona kerak)` |
| `no_batch` | `bojxona fayli yuklanmagan` |
| `no_declarations` | `bu kodda Xitoy deklaratsiyasi yo‘q` |
| `unit_mismatch` | `deklaratsiyalar boshqa o‘lchovda` |
| `few` | `faqat {n} ta deklaratsiya (kamida 5 kerak)` |
| `no_piece_weight` | `bir donasining og‘irligi yo‘q — dona bo‘yicha solishtirib bo‘lmadi` |
| `no_measure` | `qatorda soni ham, og‘irligi ham yo‘q` |
| `timeout` | `statistika o‘qilmadi (fayl katta)` |
| `budget` | `vaqt yetmadi — statistika o‘qilmadi` (the pass's median budget or deadline ran out) |
| `capped` | `juda ko‘p qator — taxmin qilinmadi` |

### 2.8 Worker sentences for a freight-only job (`jobs.ts`)

- Failed: `🧮 Yo‘lkira taxmini chiqmadi — so‘rov VED navbatida, narxni VED beradi.`
- Closed: `🧮 Yo‘lkira taxmini yuborilmadi: so‘rov allaqachon yopilgan.`
- Moved: a job queued as freight-only whose request has since gained a customs half
  (the section was changed) stands down with the customs `STOOD_DOWN.touched` sentence.
  It never runs a customs pass from the tariff queue.
- The customs-section sentences are unchanged.
- **At most one of these, or the reply, per request** (`sayOnce`, §6.8). A redelivered
  job that finds a machine message already queued for its request sends nothing at all:
  no second reply, no second lenta note, no PASS_FAILED after a real answer.

### 2.9 Telegram's 4096-character cap

- The HEAD (heading, and on the lenta the VED line under it) and the TAIL are never cut.
  The tail is: separator, totals, road, JAMI, caveat, certificate, legend, link.
- When the text is over the limit, the line list shrinks (with
  `… va yana N ta qator`) until it fits.
- `slice` is the last resort only: a single head line longer than the limit.

---

## 3. Who sees what (law 4)

| Surface | Who | What |
|---|---|---|
| Telegram reply | The person who sent the job (a seller, or the VED when he sent it) | Exact lines, 📊 lines with N, Aniq/Taxminiy, the road at LIST price with the guess label, JAMI. **No client price, no offer, no upsale, no discount.** |
| Card lenta note | `lentaAdmission` (unchanged): `crm.leads` / `clients.manage` holders, and `ved.docs` holders on calc cards | The same note for every reader, with the «🔎 VED uchun» line under its heading and P4's chip, which says when an estimate is inside. |
| VED workspace `/hisoblash/[id]` | VED | **Exact.** No 📊 figure, no Taxminiy, no guessed zone written. New: the zone hint follows the two-tier `guessZone`; the dictionary fill and its «📖 N qator» save note (P2); the m³ cell says «qatorlardan» when the stored m³ equals Σ of the lines (P2); the `ai_recode` warning (P2). |
| The «Готово» fold on `/hisoblash/[id]` | VED | New (P2): whenever the fold shows its price box (`canSeal` false, the only state an estimate can exist in), it prints `calc.finishNotEstimate`: the Telegram/lenta «Aniq», «Taxminiy» and «JAMI taxminiy» are not official prices and must not be copied there. |
| Seal, offers, PDF, price channel, upsale, narxlar, tarix, E1 nazorat | as today | **Never read the estimate**, fenced by import direction (§6.9 `estimate-wire`). Two things DO reach them, both stated: the Σ m³ stored at the INSERT (§8.2.3), and E1 counting `ai_recode` groups as the AI's (§7.4). |

- **What a figure copied into «Готово» becomes.** That is why the reminder stands at
  the box: the typed figure is written as `answer_amount`. It then becomes the upsale
  floor (`COALESCE(v.total_usd, r.answer_amount)`) and holds the card's quote lock. It is
  posted to the price channel (`queuePriceChannelPost`, kind `answer`), and it is pushed
  to the seller as «✅ Hisoblash tayyor 💵 X» (CalcDone). On every job where an estimate
  exists, `canSeal` is false (no customs total, or no stored zone). «Готово» is then the
  ONLY way to close the job, so the box is where his 2.4 b worry («taxminiy raqam VED ning
  rasmiy narxiga ta'sir qilmasin») would come true.

- **What a VED sees that a seller does not:** nothing new. He keeps the workspace,
  the 📥 dialog and its statistics, unchanged.
- **What a seller sees that a VED does not:** nothing new. Client prices, offers and
  upsale are untouched.
- **Why one chip for every reader:**
  - The lenta is the card's one shared record (round 21).
  - `thread-wire.test.ts` («8. the lenta asks the door’s own gate and restates no
    grant») forbids `permissions.has(` in `client-feed.tsx`.
  - The seller has already read the same figures in Telegram.
  - The per-reader part is the body line, and it is addressed to the VED.

---

## 4. Where every number comes from

| Printed number | Source (deterministic) |
|---|---|
| Duty / additional duty / excise / VAT | The group's law: a `calc_rates` row (PP-3818 seed, or typed) taken through `pricedGroupOf` with the EFFECTIVE certificate. |
| Exact line value | Row baza × row measure through `itemMeasure`. The baza is typed, 🧠 a sealed `calc_request_items` row (`memory_item_id`), 📖 a `calc_bazas` row, or 📥 a `customs_import_rows` row (`import_row_id`). |
| 📊 median baza | `percentile_disc(0.5)` over the CHINA (`chinaOriginSql`, D3 rule) declarations of the row's exact 10-digit code, in the batch `batchesForCodes` chose for that code. Only the first unit in `unitsForItem` order that has n ≥ `FEW`. Dona counts only declarations inside `bandBounds(kg/qty)` (±25 %). The printed N is that series' count. **The same number the 📥 dialog prints as «50 % (mediana)» for that row and unit** (pinned, §7.5). |
| Declaration fee (exact) | `customsFeeFor`: VMQ-55 tiers × setting `bhm_uzs` ÷ the newest UZS `fx_rates` row ≤ today, or `fee_override_usd`. |
| Taxminiy fee | The same function, on the shadow total value (through `requestCustomsFor`). |
| Aniq | Σ of the exact groups' `customsUsd`, no fee. |
| Taxminiy | `requestCustomsFor` over the exact groups' results and the estimated groups' shadow results. |
| Yo'lkira | One `calc_freight_tariffs` row (`tariffFor(onDate())`): zone × band by the whole density, then × m³ (× kg on a per-kg band). Zone = stored, else `guessedZoneFor(from_city, priced zones)` (two tiers). m³ = the request's (for a new request, the Σ stored at the INSERT when the seller typed none), else `linesVolumeM3(items)` for a request landed before this round. kg = the request's BRUTTO, never summed. |
| JAMI | The two printed figures added. |

Never printed: anything the model produced as a number (`ai_duty_pct` stays in its
column), the invoice price, an average or interpolated price, a per-item split of a
group's customs.

---

## 5. K — the lead's kernel commit (before any package; behaviour unchanged)

One commit. Gates: typecheck, lint, the touched unit tests, and the calc/customs
integration suites green on a fresh database. Every package starts from it.

### K1. `src/modules/wms/calc/zone-guess.ts` (new, zero imports)
- Move `guessZone` and `guessedZoneFor` verbatim from `workspace.ts:352-379`.
- `workspace.ts` imports them and re-exports them:
  `export { guessZone, guessedZoneFor } from './zone-guess';`
- `tests/unit/guess-zone.test.ts` imports from `zone-guess`.
- `calc-clock.test.ts` reclassifies them if its export walk needs it.
- Signatures:
  ```ts
  export function guessZone(fromCity: string | null): string | null;
  export function guessedZoneFor(fromCity: string | null, priced: readonly string[]): string | null;
  ```

### K2. `src/modules/wms/calc/line-totals.ts` (new, zero imports, FULL rule)
```ts
/** Σ of the lines' cubic metres — ALL or NOTHING: null when there are no lines or any
 * line lacks a positive, finite volume (a partial Σ looks like a total; groupPerUnit's
 * and the reconcile's `covered` rule). Rounded half-up to 3 decimals (numeric(12,3)). */
export function linesVolumeM3(lines: readonly { volumeM3: number | null }[]): number | null;
```
- Unit test `tests/unit/line-totals.test.ts`:
  - `[1.2, 1.6]` → `2.8`;
  - `[1.2, null]` → `null`;
  - `[]` → `null`;
  - `[0.1, 0.2]` → `0.3` (not 0.30000000000000004);
  - `NaN` → `null`.
- Red proof: drop the all-lines clause → `[1.2, null]` reads 1.2.

### K3. `src/modules/wms/calc/reply-heads.ts` (new, zero imports)
```ts
export const AI_REPLY_HEAD = '🤖 AI-VED';
export const TARIFF_REPLY_HEAD = '🧮 Yo‘lkira';
export type MachineReplyKind = 'ai' | 'tariff';
export const MACHINE_REPLY_HEADS: Readonly<Record<MachineReplyKind, string>> = { ai: AI_REPLY_HEAD, tariff: TARIFF_REPLY_HEAD };
/** The first characters of the lenta's VED line (§2.6) — written by P1, read by P4's chip. */
export const VED_ESTIMATE_MARK = '🔎 VED uchun:';
```
`ai-reply.ts` builds its heading from `AI_REPLY_HEAD`. Its text is byte-identical to today.

### K4. `src/modules/wms/calc/freight-answer.ts` (new)
- Move `ZONE_ROUTE` and `aiFreight` from `prefill.ts:442-470`.
- Update `tests/unit/ai-rastamojka-bot.test.ts:12`'s import.
- Add the seam, with K's body = today's behaviour
  (`input.hasFreight ? aiFreight(input.stored, input) : null`):
  ```ts
  export interface FreightAnswerInput {
    hasFreight: boolean;
    freightZone: string | null;          // stored on the request
    guessedZone: string | null;          // Workspace.guessedZone (priced zones only)
    fromCity: string | null;
    weightKg: number | null;             // the request's (brutto)
    volumeM3: number | null;             // the request's
    volumeFromLines: boolean;            // Workspace.volumeFromLines (K13)
    lines: readonly { volumeM3: number | null }[]; // every item, grouped or not
    stored: FreightResult | null;        // Workspace.freight (stored zone, request totals)
  }
  export function freightAnswerFor(input: FreightAnswerInput, tariff: readonly FreightBand[]): AiVedFreight | null;
  ```
- `prefill.ts` calls it with `tariff = []` in K.

### K5. `src/modules/wms/calc/prefill-steps.ts` (new)
- Move `applyMemory`, `pickBazas` and `MAX_PICK_ROWS` verbatim from `prefill.ts:551-784`
  and export them. Frozen signatures (P2 keeps them). The revision is threaded now
  (K14); K's `prefill.ts` passes `null`, which means «no compare-and-set», today's
  behaviour:
  ```ts
  export async function applyMemory(requestId: string, ctx: AuditContext, expectRev: number | null):
    Promise<{ coded: number; filled: number; rev: number | null }>;
  export async function pickBazas(requestId: string, ctx: AuditContext, pick: NonNullable<PrefillDeps['pick']>,
    expectRev: number | null):
    Promise<{ picked: number; capped: number; refused: number; overtaken: number; timedOut: number; rev: number | null }>;
  ```
- **The pick returns its usage** instead of reporting it through a callback.
  `onUsage?: (usage) => void` was called without `await`, so `void → await` inside it
  could never make the ledger write finish before the pass returned. TypeScript accepts
  an async function where a void return is expected, and lint has no
  `no-misused-promises`, so no gate would have caught it.
  ```ts
  // prefill-ai.ts
  export interface PickOutcome { answers: PickAnswer[] | null; usage: PickUsage | null } // usage null = no answer
  export async function pickImportRows(rows: PickRequest[], opts?: { timeoutMs?: number }): Promise<PickOutcome>;
  // prefill.ts
  pick?: (rows: PickRequest[]) => Promise<PickOutcome>;
  ```
  K moves today's record, still `void`, to after the call in `pickBazas`. K also updates
  every injected test pick mechanically (`calc-prefill.integration`, `proposal-wire`,
  the corpus stand-ins). P2 turns the record into `await` (§7.5).
- Re-anchor `ai-advisory.test.ts` «the prefill writes no provenance of its own»:
  - the ban on source-value strings and `bazaSource:` / `rateSource:` keys reads BOTH
    `prefill.ts` and `prefill-steps.ts`;
  - the `pickBazas` slice reads `prefill-steps.ts`.
  - Reason: the subject moved.

### K6. `ai-reply.ts` types (fields added; K's `aiVedReplyText` ignores them)
```ts
export type FreightTail = 'seller' | 'ved';
export type AiVedFreight =
  | { ok: true; listUsd: number; routeLabel: string; bandText: string;
      zoneGuessed: boolean; zoneReadFrom: string | null; volumeFromLines: boolean; small: boolean }
  | { ok: false; refusal: string; tail: FreightTail };
export type AiVedLineEstimate =
  | { priced: true; customsUsd: number; measureText: string | null;
      declarations: number[]; oldFileEnd: string | null }
  | { priced: false; misses: string[] };          // words, ≤ 3 rows
export interface AiVedEstimate {
  rows: number; exactRows: number; exactUsd: number | null;
  taxminiyUsd: number | null;
  taxminiyFee: { bhm: number | null; usd: number } | null;  // bhm null = override
  taxminiyBlock: string | null;                    // words, when taxminiyUsd is null
}
// AiVedLine gains (required, #790):  estimated: AiVedLineEstimate | null;  weightFromTotal: boolean;
// AiVedReplyInput gains (required):  estimate: AiVedEstimate | null; audience: 'chat' | 'lenta';
```
- K's `aiFreight` sets `zoneGuessed: false`, `zoneReadFrom: null`,
  `volumeFromLines: false`, `small: freight.small`. A refusal carries `tail: 'ved'`,
  today's single tail.
- K's `aiVedReplyText` ignores `weightFromTotal`; K's `prefill.ts` passes `false`.
- K's `prefill.ts` passes `estimate: null`, `estimated: null`, and `audience` 'chat' or
  'lenta'.
- K updates the test fixtures that build `AiVedLine` / `AiVedReplyInput` literals
  mechanically (`ai-reply.test.ts`).

### K7. Fill counts threaded (all zero / unchanged in K)
- `TableSaveResult.dictionaryFilled: number[]`:
  - always `[]` in K;
  - in the audit `after`;
  - in `hisoblash/actions.ts`, the runTable result (`:400`) and the `deleteItemAction`
    literal (`:428`);
  - in `items-table.tsx`, the state type and initial value. No UI line yet.
- `proposeGroups` and `priceProposedGroups` return `memoryFilled: number` and
  `dictionaryFilled: number` (from the save's arrays).
- `PrefillOutcome` gains `dictionaryFilled: number`. `memoryFilled` now sums steps 0, 1
  and 2: the scouted undercount, a count-only fix.

### K8. `src/modules/wms/customs/import-service.ts`
```ts
export interface ChosenBatch { batchId: string; endDate: string; rows: number | null } // rows null = not counted
/** Which READY batch answers each code. TOTAL over the codes asked: every code gets an
 * entry whenever ANY batch is ready, and the map is EMPTY only when none is. «No ready
 * batch» (no_batch, «yuklanmagan») and «no file holds this code» (no_declarations,
 * calc.importNone) stay two different answers.
 * K: today's rule — the newest ready batch for every code (newestReadyBatchId + batchEndSql). */
export async function batchesForCodes(codes: readonly string[]): Promise<Map<string, ChosenBatch>>;
```

### K9. `src/modules/wms/customs/import-stats-sql.ts`
- Move the private `scopedCtes` out of `import-stats.ts:126-142`, verbatim, as
  `export function codeScopeCtes(batchId: string, code: string): SQL` (EXACT code).
- `import-stats.ts` imports it.

### K10. `src/modules/wms/customs/import-baza.ts`
- Add the one row → units mapping:
  ```ts
  export function unitsForItem(
    item: { quantity: number | null; weightKg: number | null; volumeM3: number | null;
            bazaBasis: string | null; measureUnit: string | null; measureQty: number | null },
    dutyUnit: string | null,
  ): ImportUnit[];   // unitsForRow({ dutyUnit, chosen: isBazaBasis(bazaBasis) ? bazaBasis : null,
                     //   hasWeight/hasQuantity/hasVolume: > 0, statedPair: statedPairOf(...) })
  ```
- `prefill-steps.ts`'s `pickBazas` uses it.
- `ImportBazaRow` gains `tnvedCode: string`, selected as `r.tnved_code` in BOTH branches
  of `candidateStatement` and mapped in `queryCandidates`.
- K fixes the `unitMatches:` literal in `calc-prefill.integration.test.ts`.

### K11. `import-stats.ts`
`ImportStatsAnswer.state` gains `'short_code'` (no producer in K).

### K12. `dictionaries.ts`
- Add `export function bazaStaleCutoff(now: Date = new Date()): string`, defined as
  `onDate(new Date(now.getTime() - BAZA_STALE_DAYS * 86_400_000))`.
- `workspace.ts:510` uses it.

### K13. `Workspace.volumeFromLines` (in `workspace.ts`, computed by `loadWorkspace`)
```ts
/** The stored m³ IS the Σ of the lines (at 3 decimals, half-up, linesVolumeM3's own rounding).
 * Derived at read time and never stored; the one home for «did this m³ come from the lines». */
volumeFromLines: boolean;  // request.volumeM3 !== null && linesVolumeM3(all items) === round3(request.volumeM3)
```
- Nothing reads it in K. P1's `freightAnswerFor`, P2's m³ cell and P2's seal snapshot
  read it.
- Unit test in `line-totals.test.ts`: `2.8` stored with lines 1.2 + 1.6 → true; `5`
  stored → false; null stored → false.

### K14. A compare-and-set for machine saves (`workspace.ts`)
```ts
export async function saveTable(requestId: string, input: TableSaveInput, ctx: AuditContext,
  opts?: { expectRev?: number }): Promise<TableSaveResult>;
// TableSaveResult gains: rev: number   (the revision this save left)
```
- Inside the transaction, right after `lockRequestInTx`:
  `if (opts?.expectRev !== undefined && locked.rev !== opts.expectRev) throw new CalcError('conflict')`.
  This is `confirmGroup`'s idiom.
- Screens post no `expectRev`, so their behaviour is unchanged. In K nothing passes one.
- `applyMemory` / `pickBazas` take and return the revision (K5). `aiPrefill` passes
  `null` in K.

### K15. `weightFromTotalNote` (in `intake.ts`, beside `LONE_WEIGHT_NOTE`)
```ts
/** The row note says its weight was copied from the shipment total (itemFacts' lone copy). */
export function weightFromTotalNote(note: string | null): boolean; // (note ?? '').includes(LONE_WEIGHT_NOTE)
```
- A unit test asserts it is true on `itemFacts`'s own note output for a one-line job.

### K16. The job payload carries its section (`jobs.ts`, `prefill-queue.ts`)
- `CalcPrefillJob` gains `section?: string | null`.
- K's `queueCalcPrefill` passes `input.section`, which it already holds. A job queued
  before the deploy has none and reads as a customs job, today's only kind.
- K changes nothing else in the worker.

---

## 6. P1 «Javob» — what the bot says (2.1 b, 2.2 b, 2.4 c body line, 2.5 b, 2.6 b)

### 6.1 Files OWNED
- `src/modules/wms/calc/`: `prefill.ts`, `ai-reply.ts`, `prefill-reply.ts`,
  `prefill-queue.ts`, `jobs.ts`, `freight-answer.ts`, `zone-guess.ts`
- New: `src/modules/wms/calc/estimate.ts`, `src/modules/wms/calc/estimate-read.ts`,
  `src/modules/wms/calc/say-once.ts`, `src/modules/wms/customs/import-median.ts`
- Docs: `docs/AI-VED-RASTAMOJKA.md` («What differed»: two totals in the chat, yolkira
  answered from its own queue, decision 8 fully retired) and one pointer line under
  `docs/RASTAMOJKA-TUZATISH.md`'s MR-23 bullet.
- Tests:
  - re-anchors: `ai-reply.test.ts`, `prefill-reply.test.ts`, `guess-zone.test.ts`,
    `calc-prefill-wire.test.ts`, `calc-prefill-standdown.test.ts`,
    `calc-prefill.integration.test.ts`, `calc-intake-link.integration.test.ts`,
    `ai-rastamojka-bot.test.ts` (import only);
  - re-anchors of the WORKER's pins, each with its reason (regression-4):
    `intake-round1.test.ts:226-236` (the literals `const said = STOOD_DOWN[standing];`
    and `text: PASS_FAILED` now sit inside `sayOnce(…)`), and in `intake-corpus.test.ts`
    ONLY the worker cases: the `prefillStanding` mock at `:36-41` and cases c0220, c0221
    and c0804 (`:1091-1104`, `:1562-1567`). These now mock `./say-once` instead of
    `notifyStaffTelegram`. `intake-corpus.test.ts` is the one file two packages touch:
    P1 owns these hunks, P3 owns any collector or typed case. The hunks are 400+ lines
    apart; a cherry-pick conflict there is expected and resolved by keeping both;
  - new: `estimate.test.ts`, `estimate-wire.test.ts`, `freight-answer.test.ts`,
    `customs-estimate.integration.test.ts`, `calc-prefill-once.integration.test.ts`.

### 6.2 Seams P1 consumes (frozen; no edits outside its files)
- From K: `linesVolumeM3`, `unitsForItem`, `batchesForCodes`, `codeScopeCtes`,
  `bazaStaleCutoff`, `MACHINE_REPLY_HEADS`, `VED_ESTIMATE_MARK`,
  `Workspace.volumeFromLines` (K13), `saveTable`'s `expectRev` and the threaded
  `applyMemory` / `pickBazas` revisions (K14), `weightFromTotalNote` (K15), the job
  payload's `section` (K16), `PickOutcome` (K5).
- From `platform/notifications/staff.ts`, read only: `queueStaffTelegram`,
  `kickTelegramDrain` (for `sayOnce`).
- From `import-stats-sql.ts` / `import-stats-math.ts`, read only: `weightBandSql`,
  `chinaOriginSql`, `bandBounds`, `FEW`.
- From workspace: `loadWorkspace`, `Workspace`. Plus `pricedGroupOf`, `customsFor`,
  `requestCustomsFor`, `freightFor`, `tariffFor`, `onDate`.
- From `prefill-steps.ts`: `applyMemory` and `pickBazas` signatures.

### 6.3 `zone-guess.ts` — the rule (2.6 b), in two tiers
- Normalise: lower-case, then drop `’ʻʼ‘`´'`.
- **Tier 1, cities.** Match the three CITY vocabularies.
  - Any cn city match → `cn`, wherever it stands (his 21a: Yiwu/Guangzhou cargo stays
    on the China price whichever border the truck takes). Today's comment at
    `workspace.ts:363-365` says the same about Horgos; it now also holds for Kashgar.
  - Otherwise, between kashgar and horgos matches, the LEFTMOST wins.
- **Tier 2, the country.** Only when tier 1 matched nothing does a country word mean
  `cn`.
- Otherwise `null`.
- Vocabularies (word-start anchored where needed, so that «gz» does not hit inside a
  word):

  | Tier | Zone | Spellings |
  |---|---|---|
  | 1 | kashgar | `qashqar`, `qashgar` (covers Qashg‘ar after the strip), `kashgar`, `kashi`, `кашгар`, `қашқар`, `қашғар`, `кашкар`, `喀什` |
  | 1 | cn | `yiwu`, `yivu`, `iwu`, `ivu`, `иву`, `иу` (whole word), `义乌`, `guangzhou`, `guanchjou`, `guanjou`, `gonchjou`, `гуанчжоу`, `广州`, `yw` / `gz` (whole words) |
  | 1 | horgos | unchanged (`horgos`, `khorgos`, `xorgos`, `хоргос`, `коргас`, `қорғас`, `霍尔果斯`) |
  | 2 | cn | `xitoy`, `хитой`, `китай` / `китая` / `китае`, `china`, `中国` |

- `guessZone` returns the zone only. A new pure `zoneGuessOf(fromCity)` returns
  `{ zone, tier } | null` for the tests and for the reply's wording.
- `guessedZoneFor` is unchanged (priced zones only).
- The hint on the VED's workspace follows the same rule. It already prints the city it
  read (`calc-workspace.tsx:217-224`). The seal's `freight_zone_required` is untouched.
- Cases pinned in `guess-zone.test.ts`: «Китай, Кашгар» → kashgar; «中国喀什» → kashgar;
  «Хитой, Қашғар» → kashgar; «Xitoy, Qashqar» → kashgar; «Horgos (Yiwu yuki)» → cn;
  «Qashqar orqali Yiwu» → cn; «Yiwu (Qashqar orqali)» → cn; «Guangzhou → Horgos» → cn;
  «Kashgar» → kashgar; «Foshan» → null; «Foshan, Xitoy» → cn; «Xitoy» → cn.

### 6.4 `freight-answer.ts` — `freightAnswerFor` (2.5 b / 2.6 b / 2.7 b)
1. `!hasFreight` → `null`.
2. `zone = freightZone ?? guessedZone`; `zoneGuessed = freightZone === null && guessedZone !== null`;
   `zoneReadFrom = zoneGuessed ? fromCity cut at 40 chars : null`.
3. `m3 = volumeM3 ?? linesVolumeM3(lines)`. Then
   `volumeFromLines = input.volumeFromLines || (volumeM3 === null && m3 !== null)`.
   - The first half is K13's read-time provenance. After P3, a new request stores the Σ
     at the INSERT, so «stored is null» alone would never label it.
   - The second half covers requests landed before this round, whose stored m³ is null.
4. Pre-checks in the order zone → kg → m³ produce the §2.5 refusals, each with its
   `FREIGHT_TAIL`. With no zone: no `fromCity` → `no_city`;
   `guessZone(fromCity) !== null` but not priced → `zone_unpriced`, worded with that
   zone's route label; otherwise → `city_unplaced`.
5. `freightFor(tariff, { zone, weightKg, volumeM3: m3 })`. Its own refusals go through
   `freightRefusalText`, with tail `ved`.
6. On ok: `aiFreight`'s band text + `(qatorlardan)` + `zoneGuessed` + `zoneReadFrom` +
   `small`.

kg is **never** taken from the lines.

Fence (`estimate-wire.test.ts`): `prefill.ts`, `freight-answer.ts` and `zone-guess.ts`
contain no `setFreightZone(`, no `freightZone:` key in an object literal, and no
`.update(`. The guess is never stored (#770(b)).

### 6.5 `estimate.ts` — pure (imports only `pricing.ts`, `basis.ts`, `import-stats-math.ts`, types)
```ts
export type MedianMiss = 'short_code' | 'no_batch' | 'no_declarations' | 'unit_mismatch'
  | 'few' | 'no_piece_weight' | 'no_measure' | 'timeout' | 'budget' | 'capped';
export type RowMedian =
  | { ok: true; bazaUsd: number; basis: BazaBasis; n: number; batchEnd: string; stale: boolean }
  | { ok: false; miss: MedianMiss; n: number | null };
/** One unit's series for one code: the whole series, plus one series per per-piece band asked. */
export interface CodeMedianUnit {
  unit: ImportUnit; n: number; p50: number | null;
  bands: ReadonlyMap<string /* band key */, { n: number; p50: number | null }>;
}
export const MISS_WORDS: Record<MedianMiss, string>;           // §2.7 (few takes {n})

/** The choice rule: the first unit of `allowed` (unitsForItem order) whose series reaches FEW —
 * for 'dona' only the row's own band series counts (`bandKey`), and with no per-piece
 * weight dona is skipped. */
export function medianForRow(input: {
  allowed: readonly ImportUnit[]; bandKey: string | null;
  rows: readonly CodeMedianUnit[]; batch: { endDate: string }; staleCutoff: string;
}): RowMedian;
/** The band a row belongs to: `bandBounds(kg/qty)` rendered to a stable key, or null with no
 * per-piece weight. One home for «which band», shared by the read and the choice. */
export function bandKeyOf(perPieceKg: number | null): { key: string; lo: number; hi: number } | null;

export type GroupEstimate =
  | { kind: 'exact' }
  | { kind: 'estimated'; customs: CustomsBreakdown; items: PricedItem[];
      medians: { seq: number; n: number; stale: boolean; batchEnd: string }[] }
  | { kind: 'refused'; customs: CustomsRefusalDetail;
      misses: { seq: number; label: string; miss: MedianMiss; n: number | null }[] };
export interface CustomsEstimate {
  rows: number; exactRows: number; exactUsd: number | null;
  groups: Map<string /*group id*/, GroupEstimate>;
  taxminiy: { customsUsd: number; fee: FeeBreakdown } | null;
  /** Why taxminiy is null — first that applies, §2.2's order. `refused_measure` = a
   * shadow refused `measure_missing` (the seller's fact); `budget` = a row's median miss
   * is `budget`/`timeout`; `refused` = any other shadow refusal (the VED's). */
  taxminiyBlock: 'ungrouped' | 'refused_measure' | 'budget' | 'refused' | FeeRefusal | null;
}
export const TAXMINIY_BLOCK_WORDS: Record<Exclude<CustomsEstimate['taxminiyBlock'], FeeRefusal | null>, string>; // §2.2
/** ONE mapping from the workspace — through `pricedGroupOf` (the EFFECTIVE certificate;
 * spreading a WorkspaceGroup carries the raw override and drops the add-duty). */
export function estimateInputOf(ws: Workspace): EstimateInput;
export function estimateCustoms(input: EstimateInput & { medians: ReadonlyMap<string /*item id*/, RowMedian> }): CustomsEstimate;
```

Rules:
- A shadow baza is put only on items with **`bazaUsd === null`**. A typed price with a
  null basis is never replaced.
- An exact group stays `exact`.
- For any other group: build the shadow items, run `customsFor(group, shadow)`.
  - ok → `estimated`;
  - otherwise → `refused`, with the shadow's refusal and the misses of its median-less
    rows.
- `taxminiy` = `requestCustomsFor({ customs: <exact or shadow result per group>,
  ungroupedCount, bhmUzs, fxUzsPerUsd, feeOverrideUsd })`.
  - It is set only when that call's `customsUsd !== null` AND at least one group is
    `estimated`. Otherwise the exact total exists and no estimate is needed.
  - It is WHOLE or null (⭐ of Question 1). Built as (b), a second field
    `taxminiyPartial: { customsUsd; rows }` would carry Σ of the exact and estimated
    groups with NO fee. That is a different field, so the whole-figure rule above does
    not bend.
  - `taxminiyBlock` says why it is null, first that applies:
    1. any ungrouped row → `ungrouped`;
    2. any shadow refusal `measure_missing` → `refused_measure`;
    3. any median miss `budget`/`timeout` → `budget`;
    4. any other shadow refusal → `refused`;
    5. the fee refused → its `FeeRefusal`.
- `rows` = all items (grouped + ungrouped). `exactRows` = items in `exact` groups.
  `exactUsd` = round2(Σ exact groups' `customsUsd`); `null` when `exactRows = 0`.

### 6.6 `estimate-read.ts` and `customs/import-median.ts`
```ts
export const MAX_ESTIMATE_ROWS = 40;
export const MAX_BANDS_PER_CODE = 8;
export const ESTIMATE_BUDGET_MS = 10_000;
/** Medians for the workspace's baza-less, grouped rows. Pool: batchesForCodes, before any tx.
 * Then ONE underCeiling transaction per distinct (code, batch), STRICTLY one after another.
 * A cancelled statement (57014) marks every remaining row of ITS code `timeout` and issues
 * nothing more for that code; the pass goes on. Past the budget (or the pass deadline),
 * every remaining row is `budget` and no further statement is issued. */
export async function rowMediansFor(ws: Workspace, opts: { deadline: number }): Promise<Map<string, RowMedian>>;

// customs/import-median.ts — runs only on `tx` (no db, no getSetting):
export async function readCodeMedians(tx: Tx, input: {
  batchId: string; tnvedCode: string; bands: readonly { key: string; lo: number; hi: number }[];
}): Promise<CodeMedianUnit[]>;
```
- **One statement per (code, batch).** The per-row band key made the old shape one
  full-code scan per dona row, and the China-origin regex is this read's costly part
  (~330 ms per 130k-row code, `import-stats.ts:126-133`). The statement is:
  `WITH ${codeScopeCtes(batchId, code)} SELECT s.unit, count(*)::int AS n,
  (percentile_disc(0.5) WITHIN GROUP (ORDER BY s.p))::text AS p50, <band pairs>
  FROM scoped s GROUP BY s.unit`.
  - `<band pairs>` is one pair per distinct band of that code's dona-allowed rows, joined
    with `sql.join`:
    `(count(*) FILTER (WHERE ${weightBandSql(sql`s.unit`, sql`s.w`, b)}))::int AS b${i}_n,
    (percentile_disc(0.5) WITHIN GROUP (ORDER BY s.p) FILTER (WHERE …))::text AS b${i}_p50`.
    The alias is `sql.raw` of a loop INTEGER and never of data.
  - Bands come from `bandKeyOf(perPieceKg)`, only for rows whose `unitsForItem` includes
    `'dona'`. A non-dona row asks for no band.
  - At most `MAX_BANDS_PER_CODE` bands per code; rows past the cap get `capped`.
  - Prices travel as text and are `Number()`ed.
- **Strictly sequential**: `for … of` with `await`. No `Promise.all` and no
  `Promise.allSettled` in `estimate-read.ts` (pinned, §6.9). Each `underCeiling` is a
  `db.transaction` holding one of the ten pool connections every page shares (#714's
  family).
- **Budgets.** The read stops issuing statements once `ESTIMATE_BUDGET_MS` has passed
  since it started, or once `Date.now() > opts.deadline` (the pass deadline, §6.7).
  Every row not yet answered is then `budget`.
- A row's code must be exactly 10 digits, else `short_code`.
- Rows past `MAX_ESTIMATE_ROWS` → `capped`.
- An EMPTY chooser map (no ready batch at all) → `no_batch`. A code the chosen batch
  holds no China declaration of → `no_declarations`.

### 6.7 `prefill.ts` glue (after `loadWorkspace`, today's step 4)
- **Deadline.** `aiPrefill` takes `deadline = start + PASS_DEADLINE_MS` (10 minutes,
  exported). Before the pick and before the median read it checks
  `Date.now() > deadline`. Past it, the pick is skipped (logged, counted in the outcome)
  and the median read returns every row as `budget`, so Taxminiy is refused in words
  (`budget`). A step already running is never interrupted; the job's expiry (§6.8)
  covers the overrun.
- **The revision chain** (K14, concurrency-3). Right after `priceProposedGroups`
  returns, `rev = await prefillTicket(requestId)`. Then
  `applyMemory(…, rev)` returns `rev` → `pickBazas(…, rev)`. A person's save in
  between (the pick's model call takes up to 2 × 60 s) makes the machine's next save
  `conflict`, which writes nothing; the pass goes on to the reply. Stated: the seconds
  between `releaseAiClaim` and the end of `priceProposedGroups` are not under the CAS.
  The claim covers the model call before them, and they hold no model call.
- `medians` are read only when `ws.parts.customs && ws.customsUsd === null`. A failure
  there logs and yields an empty map; it never kills the pass.
- `estimate = estimateCustoms(...)` only in that case.
- `tariff = ws.parts.freight ? await tariffFor(onDate()) : []`.
- `freight = freightAnswerFor({...ws-derived, volumeFromLines: ws.volumeFromLines}, tariff)`.
- `replyLines(ws, estimate)` fills `estimated` per group: priced (shadow `measureText`,
  Ns, `oldFileEnd` when stale) or misses (`MISS_WORDS`). It also fills
  `weightFromTotal = items.some(i => i.bazaUsd !== null && weightFromTotalNote(i.note))`
  over the group's priced rows (⭐ of Question 4).
- Two renderings: `aiVedReplyText({ …, audience: 'chat', link })` and
  `{ …, audience: 'lenta', link: null }`. The lenta one carries the VED line under its
  heading (§2.6).
- **Freight-only:**
  - Skip `aiCalcBudgetLeft`, memory, propose, sweep and pick (as today).
  - Reply with `tariffReplyText` (new, in `prefill-reply.ts`, starting with
    `TARIFF_REPLY_HEAD`), with `requestAbout`'s labels.
  - `prefillReplyText` is DELETED; it has no other caller.
  - Its tests move to `tariffReplyText`, or die with their subject (the customs-on-the-
    summary MR-23 cases have no subject left; the per-blocker words tests stay on
    `blockerText`).
- `PrefillOutcome` gains `taxminiyUsd: number | null`. `customsUsd` stays EXACT.

### 6.8 `prefill-queue.ts` and `jobs.ts`
- **Two queues, one sender.** Delete `if (!parts.customs) return false;`. Rewrite the
  comment: decision 8 was overturned 2026-09-26, and his 2.5 b came on 2026-10-21.
  `queueCalcPrefill` picks the queue by `sectionParts(section).customs`:
  - a customs section → `JOB_CALC_PREFILL`, enqueued with
    `{ expireInSeconds: PASS_EXPIRE_S }` (1800 s). That is above `PASS_DEADLINE_MS`
    plus one worst step (a grouping call or a pick call, each ≤ 2 × 60 s), so pg-boss
    never fails and re-delivers a pass that is still running. The default 15-minute
    expiry would have run a second pass beside the first;
  - a freight-only section → `JOB_CALC_TARIFF_REPLY = 'calc.tariff-reply'`, enqueued
    with `{ expireInSeconds: 300 }`.
  - Why a second queue: pg-boss 10.4.2's worker fetches one job and awaits its handler
    before fetching the next (`batchSize` 1). A tariff lookup that takes milliseconds
    would otherwise wait behind every customs pass in flight. Job priority would not
    help, because it cannot overtake the job already running.
  - Both queues are created and worked inside `registerCalcPrefillWorker`. `boss.ts`
    already calls that function, so `boss.ts` is not edited.
  - Both queues run the SAME handler, with `writes = sectionParts(job.data.section ??
    <customs>).customs`. The section comes from the payload (K16), so there is no
    database read and `prefillStanding` keeps returning a string. A payload with no
    section is a job queued before the deploy, which was customs.
- **A section that moved.** `aiPrefill(…, { expectCustoms: writes })` compares
  `ws.parts.customs` with `writes`. A mismatch (the section was changed after
  queueing) returns the standing `touched`, never a customs pass from the tariff queue
  or a tariff reply from the customs queue.
- `attemptStanding(standing, retryCount, writes: boolean)`.
  - A freight-only pass writes nothing, so `touched` → `ok` and `unfinished` cannot arise.
  - `closed` and `not_found` stand.
- `PASS_FAILED` and `STOOD_DOWN` gain freight-only variants (§2.8), chosen by `writes`.
- **One machine message per request** (`calc/say-once.ts`, concurrency-1):
  ```ts
  /** Queue the request's machine message only if none was queued for it yet. The claim
   * and the rows go in ONE transaction; the drain is kicked after the commit.
   * Returns false when an earlier attempt already spoke. */
  export async function sayOnce(requestId: string, input: StaffTelegramInput): Promise<boolean>;
  ```
  - Inside `db.transaction`: `pg_advisory_xact_lock(hashtext('calc-prefill-reply:' || id))`,
    then `EXISTS (SELECT 1 FROM notifications WHERE user_id = <staffId> AND type =
    'CalcPrefilled' AND payload->>'requestId' = <id>)`. The `user_id` clause rides
    `notifications_user_idx`. If none exists, `queueStaffTelegram(tx, { …input, extra: {
    requestId } })` (`staff.ts:37`, the body `notifyStaffTelegramOnce` already rides).
    `kickTelegramDrain()` runs after the commit.
  - A muted recipient still gets a `muted` row, so the claim holds. A recipient who can
    no longer log in gets no row and no message, which is right.
  - EVERY machine message for a request goes through it: the reply, every `STOOD_DOWN`
    sentence, and `PASS_FAILED`, both variants each.
  - Every request is queued exactly once, right after its own INSERT
    (`intake-land.ts:317`, `from-thread.ts:358`, `hisoblash/actions.ts:285`). So «one
    message per request» is «one per job», with no migration.
  - The lenta note is written ONLY when this call made the claim. A redelivery that finds
    the claim sends nothing: no reply, no lenta note, no PASS_FAILED, no STOOD_DOWN.
  - `telegram_once` cannot carry this key without a migration: its CHECK admits only
    `m:`/`q:` Telegram identities (0130).
- The lenta write is otherwise unchanged: `writeReplyToLenta(requestId, out.lentaText)`
  under `ai_calc_reply_lenta`. Yolkira replies now reach the lenta too, under the same
  setting.

### 6.9 Tests (P1) — new, red proofs by string edit

**`estimate.test.ts`** — pure, every literal written by hand:
- (a) 10 rows: 7 exact in 2 groups, 3 baza-less in 1 group with medians → `exactUsd`,
  `exactRows` 7, `rows` 10. The Taxminiy literal is computed by hand from the law and the
  medians, fee included. **Red proof:** add the fee to `exactUsd`.
- (b) The fee tier on the FULL value: exact $9,000 value + estimated $3,000 → 1.5 BHM in
  Taxminiy, none in Aniq.
- (c) One baza-less row with no median → `taxminiy` null, `taxminiyBlock` 'refused', the
  miss named. **Red proof:** compute Taxminiy over the priced groups only → a smaller
  number appears.
- (d) An ungrouped row → `taxminiy` null, 'ungrouped', counted in `rows`.
- (e) Certificate: raw override `null`, request `true` → no add-duty.
  **Red proof:** build the group by spreading the `WorkspaceGroup`.
- (f) A typed price with a null basis is never shadowed.
- (g) The shadow refuses on the duty floor → the refused line carries the ENGINE's words.
- (h) `medianForRow`:
  - kg first for an advalor row with kg+qty;
  - dona-law row → its OWN band's series (`bandKey`), n ≥ 5;
  - two dona rows of one code in different bands each read their own band from one
    `CodeMedianUnit` (one statement, §6.6);
  - 4 declarations → `few` (n 4). **Red proof:** `FEW` → 1;
  - dona with no per-piece weight → `no_piece_weight`;
  - only m² declarations on a kg row → `unit_mismatch`;
  - stale → `stale: true` at the cutoff boundary, inclusive like `staleFor`.
- (i) `taxminiyBlock`'s order: an ungrouped row AND a `measure_missing` shadow →
  `ungrouped`; a `measure_missing` shadow AND a no-median group → `refused_measure`;
  a `budget` miss → `budget`. **Red proof:** swap two branches.

**`freight-answer.test.ts`** — pure:
- stored zone → equals `freightFor`;
- no zone + «Yiwu» → `zoneGuessed`, `zoneReadFrom` «Yiwu»;
- no zone + «Foshan» → `city_unplaced`, tail `seller`;
- no zone + «Horgos», tariff pricing cn + kashgar only → `zone_unpriced`, worded with
  horgos's route label, tail `ved`, and the text does NOT contain «aniqlanmadi».
  **Red proof:** drop the `zone_unpriced` branch → «aniqlanmadi» appears;
- m³ null + every line → `volumeFromLines`, and Σ is used;
- m³ stored, `input.volumeFromLines: true` → `(qatorlardan)` is carried. **Red proof:**
  compute it as «stored is null» alone → the flag is false;
- one line missing → `umumiy hajm (m³) yo‘q`, tail `seller`;
- kg null with lines carrying kg → `umumiy brutto og‘irlik (kg) yo‘q`, tail `seller`.
  **Red proof:** read Σ line kg → green-to-red;
- `band_missing` → tail `ved`;
- `small` carried.

**`guess-zone.test.ts`** — every case listed in §6.3, plus:
- spellings, including «Qashg‘ar», «Qashg'ar» and «Қашғар»;
- **Red proof (tier 2):** fold the country words into tier 1 with a leftmost rule →
  «Китай, Кашгар» reads cn;
- **Red proof (21a):** decide cn vs kashgar by leftmost → «Qashqar orqali Yiwu» reads
  kashgar;
- **derived:** every `AI_ZONE_ROUTES[z].fromCity` guesses `zone`. That file is imported
  in the test only (platform → test, allowed).

**`ai-reply.test.ts`**:
- the three-line block (§2.2) — **red proof:** print Aniq with the fee;
- Aniq «hali yo‘q»;
- each Taxminiy-absent sentence, including the seller-side `measure_missing` one and
  `budget`;
- the unchanged complete-total line;
- the unchanged «hozircha» line when no row is exact and there is no Taxminiy;
- `JAMI taxminiy` on a guessed zone — **red proof:** drop the guess term → `JAMI (` appears;
- `JAMI taxminiy` on exact customs + guessed zone;
- the guessed route prints `zona «Китай, Кашгар»dan taxmin`, i.e. what was read;
- a seller-side road refusal ends `— mijozdan so‘rab, kartadagi lentaga yozing`, and a
  `band_missing` one ends `— VED xodimi hisoblaydi`;
- `weightFromTotal` prints `(og‘irlik bruttodan)` beside the measure;
- the 📊 legend;
- the lenta-only VED line: present only with an estimate, only for `audience: 'lenta'`,
  and it is LINE 2, directly under the heading. **Red proof:** append it before the
  legend → the line-index assertion fails;
- 60 long lines plus two totals → ≤ 4096 and still contains «Taxminiy» and «Rasmiy emas».
  **Red proof:** restore the trailing `slice`.

**`estimate-wire.test.ts`** — source-shape, comments stripped (#725):
- `estimate.ts`, `estimate-read.ts` and `import-median.ts` contain no `.insert(`,
  `.update(`, `saveTable`, `setItemBaza`, `mutateRequest`, `recordOffer`,
  `finishCalcRequest`, `bazaSource`;
- no `\bai[A-Z]\w*` and no `ai_\w+` (law 1);
- `import-median.ts` speaks `percentile_disc` and never `_cont`, `avg(` or `sum(`, and
  its body has no `db.` and no `getSetting`;
- `estimate-read.ts` contains no `Promise.all` and no `Promise.allSettled` (#714's
  family, §6.6). **Red proof:** wrap the loop in `Promise.all`;
- in `prefill.ts`, the identifier `estimate` never appears inside a `saveTable(` or
  `pickBazas(` argument block;
- `PrefillOutcome.customsUsd` is assigned from the workspace only (`customsUsd =` reads
  `ws.customsUsd`);
- the §6.4 no-store fence;
- **the import direction** (law-money-5; §3's «no reader» promise, fenced here). The
  test walks every `.ts`/`.tsx` under `src/` with TypeScript's parser, comments stripped:
  - the only importers of `calc/estimate.ts` are `estimate-read.ts`, `prefill.ts` and
    `ai-reply.ts` (type-only);
  - the only importer of `calc/estimate-read.ts` is `prefill.ts`;
  - the only importer of `customs/import-median.ts` is `estimate-read.ts`;
  - the identifiers `estimateCustoms`, `rowMediansFor`, `readCodeMedians`, `taxminiyUsd`,
    `taxminiyFee`, `taxminiy`, `taxminiyPartial` appear in no file of `src/` outside
    those five: `estimate.ts`, `estimate-read.ts`, `import-median.ts`, `prefill.ts`,
    `ai-reply.ts`. That covers anyone reading `PrefillOutcome.taxminiyUsd`: a «Готово»
    default, a narxlar hint, the seal, the price channel. `jobs.ts` logs the outcome
    without it.
  - **Red proof:** import `estimateCustoms` into `src/app/(protected)/hisoblash/[id]/page.tsx`
    → red, named by path.

**`customs-estimate.integration.test.ts`**:
- (1) A request with one memory-priced group and one group whose row has no baza; 6 China
  declarations of its code in a fixture batch → `aiPrefill` text contains `Aniq:` with
  `(2 tadan 1 qator, yig‘imsiz)` and `Taxminiy ≈`. After the pass the row's
  `baza_usd IS NULL` and `baza_source IS NULL` (never written).
  **Red proof:** make `prefill.ts` post the median through `saveTable` → the fence and
  this assertion turn red.
- (2) **The median equals the dialog's 50 %.** `readCodeMedians(...).p50 ===
  readImportStats(...).units[unit].all.p50`, and for dona the band series. This anchors
  on a second surface computed a different way (ladder index 49 vs a direct disc, #1116).
- (3) China only: 6 Chinese and 6 Turkish declarations at a different price → the
  Chinese median. **Red proof:** drop the scope CTE's filter.
- (4) Dona ±25 %: a declaration outside the band changes nothing.
  **Red proof:** use the all-dona series.
- (5) A yolkira job, freight `cn` stored, kg + m³ → text starts with `TARIFF_REPLY_HEAD`,
  carries `≈ $<freightFor literal>`, no «rastamojka», and **no `ai_calc_passes` row**.
- (6) Podklyuch, no zone, `fromCity` «Yiwu», tariff cn priced → «zona «Yiwu»dan taxmin»,
  `JAMI taxminiy`. `calc_requests.freight_zone` is STILL null after the pass.
  **Red proof:** have the pass call `setFreightZone` → red.
- (7) **Landed through `openCalcRequest`** (never a hand-nulled fixture, #1116), lines
  1.2 + 1.6 m³, no total typed → the reply contains `× 2.8 m³ (qatorlardan)`. This holds
  in P1's worktree, where the stored m³ is null and the fallback labels it, and after
  P3's merge, where the INSERT stores 2.8 and K13 labels it.
  - (7b) The same lines with a typed total `5` → `× 5 m³` and NO «qatorlardan».
  - **Red proof:** compute `volumeFromLines` as «stored is null» alone → (7) is red after
    the merge (the lead re-runs it then).
- (8) The lenta copy carries the «🔎 VED uchun:» line exactly once, as line 2, when (1)'s
  estimate stands, and `lentaText` = text − `Karta:` + that line.
- (9) The deadline: `aiPrefill` with a deadline already past → no pick, every median
  `budget`, the reply says `Taxminiy: hisoblab bo‘lmadi — vaqt yetmadi …`, and nothing
  throws.

**`calc-prefill-once.integration.test.ts`** (concurrency-1):
- A yolkira job's handler runs twice on one job, `retryCount` 0 then 1 → exactly ONE
  `CalcPrefilled` notification row for the request and ONE machine lenta note.
- A customs job whose first run queued its reply and «died» (the test calls the handler
  again with `retryCount` 1 and the revision moved by the first run's writes) → no
  PASS_FAILED row.
- **Red proof:** drop the `EXISTS` → two rows.

**Queue routing** (in `calc-prefill-wire.test.ts`, re-anchored there):
- a yolkira section is sent to `JOB_CALC_TARIFF_REPLY`; a rastamojka or podklyuch section
  is sent to `JOB_CALC_PREFILL` with `expireInSeconds: PASS_EXPIRE_S`;
- `registerCalcPrefillWorker` creates and works both queues.
- **Red proof:** route every section to `JOB_CALC_PREFILL`.

**Re-anchored (each with the reason in a comment):**
- `calc-prefill-wire.test.ts:55-61` («the sender refuses a freight-only job») → «the
  sender queues every section; the freight-only pass calls no model». The subject was
  reversed by his 2.5 b; zero calls are proven by `calc-prefill.integration:428`, which
  stays.
- `calc-prefill.integration.test.ts:262-279` (no zone → refusal): give the fixture no
  `fromCity`, or assert the new §2.5 words. The guess now answers when a city is placeable.
- `calc-prefill-standdown.test.ts`: the new `writes` parameter. A freight-only `touched`
  → answered, not stood down. A job whose payload says freight-only on a request that
  now has customs → `touched` (the section moved).
- `intake-round1.test.ts:226-236` and `intake-corpus.test.ts` c0220/c0221/c0804 (with
  their `prefillStanding` mock): the worker speaks through `sayOnce`, so the unit
  tests mock `./say-once`. The pinned literals keep their shape inside the call. The
  payloads stay section-less on purpose: they assert the pre-deploy default (customs).
- `ai-reply.test.ts` cases that print «Rastamojka jami: hozircha hisoblab bo‘lmadi.» while
  some groups ARE exact (`:94-143`, `:145-162`) → the §2.2 block. The subject changed:
  his 2.2 b.
- `prefill-reply.test.ts` `prefillReplyText` cases → `tariffReplyText`, or deleted with
  the function (stated in the commit).
- `calc-intake-link.integration.test.ts` L4 is UNCHANGED (its fixture has no estimate, so
  `text − 1` still holds). It is kept as the no-estimate control.

---

## 7. P2 «Baza» — where bazas come from (dictionary second, heading search, batch choice, grouping input, the grouping count)

### 7.1 Files OWNED
- `src/modules/wms/calc/`: `workspace.ts`, `warnings.ts`, `labels.ts`, `prefill-steps.ts`,
  `prefill-ai.ts`
- `src/modules/wms/tnved/service.ts`
- `src/modules/wms/customs/`: `import-service.ts`, `import-baza.ts`, `import-stats-sql.ts`,
  `import-stats.ts`, `picker-item.ts`
- Routes: `src/app/api/calc/import-baza/route.ts`, `…/stats/route.ts`,
  `src/app/api/deals/[id]/lines/import/route.ts`
- Screen: `src/app/(protected)/hisoblash/[id]/items-table.tsx`, `import-baza-dialog.tsx`,
  `baza-stats.tsx`, `calc-actions.tsx` (the «Готово» reminder, law-money-1), the
  workspace's m³ cell (in `calc-workspace.tsx`, the cargo-facts line only);
  `src/app/(protected)/hisoblash/actions.ts`
- Docs: `docs/VED-IMPORT-AI.md` §2.3 and §6. The «EXACT code only» and «prefix fallback
  CUT» pins become «a 10-digit code exact; a shorter one by heading, AI pick and 📥 list
  only, the pick recodes».
- Tests:
  - re-anchors: `customs-import.integration`, `import-stats.integration`,
    `calc-warnings.test`, `baza-provenance.test`, `import-stats-wire.test`,
    `customs-import-parse.test`, `proposal-wire.test`;
  - new: `dictionary-fill.integration.test.ts`, `heading-search.integration.test.ts`,
    `batch-choice.integration.test.ts`, `grouping-listing.test.ts`,
    `grouping-count.integration.test.ts`, `machine-cas.integration.test.ts`,
    `finish-reminder.test.ts`;
  - must stay green UNCHANGED: `calc-basis.integration.test.ts:657-675` (a unit chosen
    on an unpriced row is filled in the same save), named so that `clearedNow` cannot
    quietly break it;
  - e2e: one test appended to `tests/e2e/m9zu-bojxona-import.desktop.spec.ts`.

### 7.2 `calc_bazas` second, INSIDE `saveTable`'s fill
1. **Pre-transaction (pool).** A private, unexported `suggestDictionaryFills({ standing,
   itemEdits, withCodes })` beside `suggestImportFills` / `suggestMemoryFills`.
   - It wants every row that will end the save baza-less. No code is required: the book
     is keyed by NAME.
   - It reads `bazasFor(names, onDate())`, keyed by the existing `productKey`. No fourth
     copy of the name rule.
   - Returns `{ byItemId, byAddIndex }` of `{ bazaUsd, basis, key }`.
   - The book read is one cheap indexed lookup, so it is computed for ALL baza-less wants
     and precedence is decided in the transaction.
   - **The import is asked only for what the book and the memory leave** (performance-7,
     partial). `suggestImportFills` skips a row the pre-transaction memory or dictionary
     suggestion already answers. The import's scan is the costly read of this save, and
     its answer could only be used if the higher source's in-transaction re-check failed.
     Stated: in that rare case (for example the measure pass changes which units the row
     allows, and the book's unit drops out) the row stays empty for this save, and the
     next save fills it.
2. **Insert step.** Re-key `byAddIndex` beside `:4245-4248`. A new row typed with a book
   name is filled on its first save.
3. **ONE ordered fill loop** after the measure pass. It replaces the two loops at
   `:4612-4660`.
   - `const SOURCES = ['memory', 'dictionary', 'import'] as const;` — the order has one
     home, and a fence asserts it.
   - A single `filledNow: Set<itemId>` replaces `memoryFilled.includes(...)`.
   - Per source, the re-checks:
     - the baza is still null in `itemsNow`;
     - not `filledNow`;
     - **not CLEARED by THIS save.** `clearedNow` = item edits posting `bazaUsd: null`
       over a baza that was NOT null when this save began, judged against the rows read
       in the transaction (`standing` / `items`). A null post on a row that was already
       baza-less is a UNIT CHOICE, not a clear: the screen posts exactly that when only
       the unit select moved (`items-table.tsx:968-980`). Since 0125, such a row is
       filled in the chosen unit in the same save (`calc-basis.integration.test.ts:657-675`,
       which stays green unchanged);
     - the basis allowed by `allowedFor(item)` (`unitsForRow`, NOT the 📖 button's
       broader rule; a chosen unit counts, as today);
     - for the dictionary, `productKey(item.name) === fill.key`. `itemsNow` selects `name`;
     - for the import, the code is unchanged.
   - Writes in the provenance fence's shape:
     `.set({ bazaUsd, bazaBasis, bazaSource: 'dictionary', importRowId: null, memoryItemId: null, bazaReason: null })`
     then `touched.add(groupId)`.
4. `dictionaryFilled: number[]` → result, audit `after`, the save note on the screen:
   `📖 ${t('table.dictionaryFilled', { count })}: 2, 5`. New key §10.
5. **Stated consequences.**
   - Every VED «Saqlash» now fills from the book, named in the save note.
   - The owner's order means a fuzzy sealed memory (similarity ≥ 0.6) beats an exact
     book row.
   - A book price «per dona» on a weight-only advalor row stays empty (`unitsForRow`
     never offers dona there). The manual 📖 button keeps its broader rule for the VED.
   - A cleared baza is not refilled IN THE SAME SAVE. A later save by the VED may refill
     it: a persistent «cleared by a person» flag needs a column and is not this round.
     A later MACHINE save cannot refill it behind the person's back: step 7.
6. **`baza_dictionary_moved` warning** (new `CalcWarningKind`, label in `labels.ts`,
   i18n §10). It fires on a `'dictionary'` row whose `bazaUsd` or `bazaBasis` differs from
   today's book row. Reason: `bazaStale` reads the CURRENT book row's date, so an
   auto-filled row whose book moved would read fresh while holding the old price.
7. **The machine's saves carry the revision** (K14, concurrency-3).
   - `applyMemory` and `pickBazas` pass their `expectRev` to `saveTable` and return the
     `rev` it left.
   - A save refused with `conflict` writes nothing and counts every one of its edits as
     `overtaken`. The machine does not retry: a person is working on the request.
   - Why: the fill now runs in EVERY save, and the pick's model call takes up to
     2 × 60 s with no claim held. Without the compare-and-set, a VED who cleared a
     📖/🧠 baza and ✅'d the group during that call would see the pick's save refill the
     row under `actorId: null`. `unconfirmInTx(touched)` would then take his ✅ off, which
     breaks the module's own law at `jobs.ts:169-171` (the machine stands down rather
     than un-ticking a person's ✅).
8. **The Σ m³ on the VED's screen** (law-money-3).
   - The workspace's m³ cell prints `12 m³ · ${t('volumeFromLinesShort')}` when
     `ws.volumeFromLines` holds.
   - The seal's `breakdown` snapshot records `volumeFromLines: boolean` beside the
     volume. That is an additive key in the jsonb, so old seals read `undefined` =
     unknown.
   - Stated: `reconcile.mismatch` compares Σ group m³ with the request m³. On a request
     whose m³ IS the Σ they are equal by construction, so a wrong per-line volume cannot
     trip it. The label is the only signal, and that is why it is on the screen.
9. **The «Готово» reminder** (law-money-1, his 2.4 b reason kept under his 2.4 c).
   - A small exported component `NotAnEstimate` in `calc-actions.tsx` prints
     `t('finishNotEstimate')` as a muted warning line, at the top of the fold's
     price-box branch, i.e. exactly when `canSeal` is false and the fold asks for a
     typed figure.
   - It needs no lenta read and no migration. `canSeal` false is the only state in which
     the bot can have printed an estimate or a guessed zone. The estimate is computed
     only when `ws.customsUsd === null`, and a zone is guessed only when none is stored;
     either one makes `totals` null and `canSeal` false (`workspace.ts:704-741, 2302`).
   - What a copied figure would become is stated in §3: the upsale floor, the quote lock,
     a price-channel post and the seller's CalcDone push.

### 7.3 The batch chooser (`batchesForCodes`, replaces K's body)
- One statement per save, over `VALUES` built with `sql.join`.
- For each code, LATERAL over READY batches with at least one row of the code
  (`codeMatchSql`), with the count capped at `LIMIT 1000` (an index-only range on
  `customs_import_rows_code_idx`).
- Order:
  1. `rows ≥ FEW` first;
  2. newer QUARTER of `batchEndSql` first (`date_trunc('quarter', (<end>)::timestamp)`);
  3. more rows first (a capped 1000 is a tie);
  4. `batchRecencySql` (end, upload, id).
- **Total** (regression-6). A code that no ready batch holds still gets an entry: the
  newest ready batch, by `batchRecencySql`, exactly as today. So:
  - `suggestImportBaza` and the 📥 list route answer «Bu kod uchun importda mos qator
    yo‘q» (`calc.importNone`), as today, and never «Bojxona bazasi hali yuklanmagan»;
  - P1 says `no_declarations`, never `no_batch`.
  - Only an EMPTY map, meaning no ready batch at all, is `no_batch` / `importNoBatch`.
  - The statement is a `LEFT JOIN LATERAL` with a `COALESCE` onto the newest ready batch.
- Effect, stated:
  - The newest file still answers every code it holds ≥ 5 declarations of (his 2b, where
    it speaks).
  - A code the newest file is silent or nearly silent about is answered by the newest
    file that has enough.
  - A full quarter beats a same-quarter sample whichever was uploaded last.
  - An older file's baza wears the existing stale chip, and the reply says «eski fayl».
- **Consumers (one chooser):**
  - `suggestImportFills` (per code);
  - `pickBazas`;
  - `suggestImportBaza`'s default (when no `batchId` is passed);
  - the stats route;
  - P1's `rowMediansFor`.
- `previousReadyBatchId` stays relative to the chosen batch.
- The admin page's «answering» chip stays global (`newestReadyBatchId`); its m9zzz e2e is
  untouched. Stated in the docs.

### 7.4 Heading search
- **`codeMatchSql(r: SQL, code: string): SQL`** in `import-stats-sql.ts`.
  - A 10-digit code → `r.tnved_code = ${code}`.
  - Otherwise → `r.tnved_code BETWEEN ${code} AND ${code.padEnd(10, '9')}`, both bounds
    bound as TEXT.
  - **No `COLLATE "C"` and no LIKE.** Either forfeits the btree on the default collation;
    `C.UTF-8` vs `en_US.utf8` is two oracles (#653).
  - A unit test renders it with `PgDialect`.
  - Used in `candidateStatement`'s LIST branch and in `batchesForCodes`.
  - `codeScopeCtes` (stats and median) stays EXACT. A heading-wide median mixes
    subheadings.
  - **The name-matched series (C1, `named_q`/`named_ex`) stays EXACT too**
    (regression-8, performance-2). `named = dialog && usable && isFullCode(code)`. A
    short code gets the candidate list only, with `namedState: 'short_code'`, which
    `baza-stats.tsx` renders as nothing (its panel already says `short_code`). So no
    heading-wide quartile is computed and thrown away, and none is printed beside a
    panel that refuses statistics.
- **A ceiling on every heading-range read** (performance-1). `candidateStatement`
  scores `word_similarity` on every row the code predicate admits: `count(*) OVER ()`
  and `ORDER BY score` both need every row. On a heading, that is every subheading in
  the batch. The house comment measures the EXACT-code scan at ~7 s on a 130k-row code.
  - The 📥 list route: for a short code the read runs inside
    `underCeiling(HINT_STATEMENT_MS)`. A 57014 answers `state: 'timeout'`, and the dialog
    prints `calc.importListTimeout`. The full-code read is unchanged, with no new
    ceiling: today's giant codes must keep answering the VED.
  - The background pick: a short-code candidate read runs under
    `underCeiling(PICK_HEADING_MS)` (5000 ms). A 57014 skips that row and is counted in
    `timedOut`.
  - `pickBazas` dedupes its `suggestImportBaza` calls by shape (code, name, units,
    perPiece), the memo `suggestImportFills` already keeps. Ten identical rows cost one
    scan.
  - The calls are sequential awaits, never concurrent: one connection at a time.
  - §14.6 measures the widest real heading's scan.
- `isFullCode(code)` = `/^\d{10}$/`, exported from `import-baza.ts`.
- **Auto-fill stays exact.** `suggestImportFills` asks only rows whose final code
  `isFullCode`. The model-free fill never picks a subheading.
- **AI pick** (`prefill-steps.ts` + `prefill-ai.ts`):
  - A short-code row gets heading candidates, each carrying its own `tnvedCode`.
  - The listing prints `(код …)` per candidate when it differs from the row's.
  - The SYSTEM prompt's «с ТЕМ ЖЕ кодом» becomes «с тем же кодом или из той же товарной
    позиции; у каждой строки свой код — выбирай строку, чей код подходит товару».
  - Before posting, read `ratesForCodes(<chosen codes>)` on the pool. The chosen unit must
    be in `unitsForItem(row, <TARGET code's dutyUnit>)`, else it is refused and counted.
  - The edit posts `tnvedCode: chosen.tnvedCode` beside `importRowId`, `bazaUsd`,
    `bazaBasis` and `bazaReason`.
  - **A recode is said and flagged** (law-money-4: the pick now chooses the tariff line,
    and with it the duty %).
    - When `chosen.tnvedCode !== row.tnvedCode`, the posted `bazaReason` is
      `${AI_RECODE_PREFIX}${row code} → ${chosen code} · ${model's reason}`.
      `AI_RECODE_PREFIX = 'AI kodni o‘zgartirdi: '` is exported from `warnings.ts`, and
      that is its one home. The prefix sits at the start, so the 300-char cut
      (`workspace.ts:3843`) cannot drop it.
    - A new derived `CalcWarningKind` `ai_recode` fires on a group holding an item whose
      `baza_reason` starts with `AI_RECODE_PREFIX`. Its label goes in `labels.ts` plus
      four bundles (§10). The ✅ records it in `confirmed_warnings`, so a person has
      looked at a code the machine chose.
    - `baza_reason`'s only writer is the pick, so this needs no migration.
    - A same-code pick is unchanged: `baza_from_import` already records that a person
      looked at a price the machine chose.
    - E1's AI counters (`workspace.ts:1937-1944`, `aiGroupsSealed`) count a group
      `aiProposed OR` holding such an item. Before this, a group minted by a recode's
      regroup had `ai_proposed` false and counted as nobody's model.
    - Memory teaching is unchanged: a recoded group reaches the sealed memory only
      through a ✅ that recorded `ai_recode`.
  - `saveTable` already prices a pick + recode in one press (`:3929-3933`).
    `importRowForCode` stays EXACT, so the id fence is untouched.
  - The still-empty re-check also re-checks the code.
- **📥 dialog:**
  - The list shows a `kod: {code}` chip on a candidate whose code differs.
  - **Each candidate is judged by ITS OWN law** (regression-7). The list route reads
    `ratesForCodes(<distinct candidate codes>)` on the pool. `pickable` and the unit
    label are computed per candidate with `unitsForItem(row, <candidate's dutyUnit>)`
    and `basisConflicts(<candidate's dutyUnit>, …)`, never with the row's current
    (heading) law. A pick recodes the row to the candidate's code, so the candidate's
    law is the one the save will apply.
  - «Tanlash» calls `onPick(itemId, { id, pricePerUnitUsd, basis, tnvedCode })`.
    `items-table.tsx` drafts the code with the pick.
  - The stats route answers `short_code` for a non-10-digit code, and `baza-stats.tsx`
    prints `calc.statsShortCode`.
  - A recode made by a PERSON in the dialog writes no `bazaReason` and raises no
    `ai_recode`: the person chose it.

### 7.5 Richer grouping input + the grouping count (2.9 c)
- `proposeGoodsGrouping(goods: { name; quantity; unit; weightKg: number | null;
  volumeM3: number | null; measure: string | null; note: string | null }[])`. All
  required-nullable (#790).
- The listing comes from a new pure exported `groupingListing(goods)`:
  `0. Kurtka — 300 шт · 150 кг · 1.2 м³ · прим.: 100% полиэстер`. The note is cut at
  120 characters.
- The prompt gains one sentence: «вес, объём и примечание — подсказка о материале и
  назначении, не для цены».
- The deal import route passes its parsed weight and volume, or nulls.
- `TnvedError` gains `usage?: AiUsage`.
  - A refusal, `stop_reason === 'max_tokens'` (named now), an unparseable answer and zero
    valid groups all throw `TnvedError('ai_failed', usage)` from the response.
  - `proposeGroups`'s catch records `err.usage` through `recordAiPass({ kind: 'grouping' })`.
- **Pick:** `pickImportRows` returns `{ answers, usage }` (K5). `pickBazas` then does
  `if (out.usage) await recordAiPass({ kind: 'pick', … })` right after the call and
  before any save. The ledger write therefore finishes before the pass returns, and
  nothing is fire-and-forget. A pick that got no answer (`usage: null`) is not counted
  (the count rule below). In `prefill-ai.ts`, every exit after the model answered
  carries its usage: ok, refused, unparseable, an index out of range. A
  timeout/network/4xx/5xx carries `null`.

**The count rule, stated once:** a call counts when the model ANSWERED it, whatever was
made of the answer. A call with no answer (timeout, network, 4xx/5xx) is logged and not
counted. Those are what cost nothing or cost an unknown amount, and a dead key must not
spend the day's cap as «budget». Round 5 measures dollars.

### 7.6 Tests (P2)

**`dictionary-fill.integration.test.ts`**:
- (a) Book row «Plastik idish» $2/kg; row coded with kg → filled `'dictionary'` with both
  provenance columns null.
- (b) Memory and book both answer → `'memory'`.
  **Red proof:** reorder `SOURCES`.
- (c) Book and import both answer → `'dictionary'`.
  **Red proof:** import before dictionary.
- (d) A NEW row added in the save with a book name → filled on its first save.
  **Red proof:** drop the add re-key.
- (e) A book price per `unit` on a weight-only row → stays empty.
  **Red proof:** use the pull's rule.
- (f) The VED clears a 📖 baza and saves → still empty after that save.
  **Red proof:** drop `clearedNow`.
- (f2) A row with NO baza whose unit alone is chosen (`{ bazaUsd: null, bazaBasis: 'kg' }`,
  the screen's own post) and a book row in kg → filled in that same save. **Red proof:**
  define `clearedNow` as «any `bazaUsd: null` post» → empty.
- (g) The book moves → `baza_dictionary_moved` on the group.
  **Red proof:** drop the clause.
- (h) The audit row carries `dictionaryFilled`.
- (i) A row the memory answers pre-transaction is not asked of the import: a spy on the
  candidate read sees no call for it. **Red proof:** drop the skip.

**`heading-search.integration.test.ts`**:
- (a) A row coded `6403`; declarations under `6403991000` and `6404190000` → candidates
  are only `6403…`.
  **Red proof:** `padEnd(10,'9')` → `padEnd(10,'0')`, or equality.
- (b) The auto-fill never fills a short-code row.
  **Red proof:** let `suggestImportFills` ask short codes.
- (c) An injected pick chooses the 6403991000 row → the item's code becomes 6403991000,
  its price is the FILE's, `baza_source = 'import'`, `baza_reason` starts with
  `AI_RECODE_PREFIX` and names `6403 → 6403991000`, and the group carries `ai_recode`.
  **Red proof:** drop the warning clause → no warning on a recoded group.
- (c2) A same-code pick → no `ai_recode` (only `baza_from_import`, as today).
- (c3) E1: a sealed group minted by a recode counts in `aiGroupsSealed`. **Red proof:**
  restore the `aiProposed`-only filter.
- (d) A candidate whose TARGET law pins `juft`, on a row stating only kg → refused, not
  written.
  **Red proof:** check the unit against the row's own (heading) law.
- (d2) The 📥 list route on the same fixture: that candidate reads `pickable: false`
  with the juft label, and a kg-law candidate of the same heading reads
  `pickable: true`. **Red proof:** compute `pickable` from `item.dutyUnit`.
- (e) The stats route answers `short_code`, and the list route's `namedState` is
  `'short_code'` with no named series.
- (f) A heading read that exceeds its ceiling → the list route answers
  `state: 'timeout'`, and the pick counts the row in `timedOut` without throwing. The
  ceiling is an optional `ceilingMs` argument of `suggestImportBaza`, defaulting to the
  constant; the test passes 1.
- (g) Ten identical heading rows in one pick → one candidate read (spy). **Red proof:**
  drop the shape memo.

**`batch-choice.integration.test.ts`**:
- (a) The newest batch lacks the code → an older batch answers.
  **Red proof:** K's stub body.
- (b) A full Q2 (6 rows) uploaded BEFORE a June sample (2 rows, same end) → Q2 answers.
- (c) Newer quarter with 5 rows vs older with 50 → the newer answers (2b).
- (d) Newer quarter with 3 rows vs older with 50 → the older answers.
- (e) The list route and the stats route answer from the same batch (extends test 12's
  idea to the chooser).
- (f) A code that NO ready batch holds → the chooser still maps it (to the newest ready
  batch); the list route answers `importNone`, never `no_batch`; and with no ready batch
  at all the map is empty. **Red proof:** an INNER LATERAL → the code is absent and the
  route says «yuklanmagan».

**`grouping-listing.test.ts`**: the listing carries weight, volume, measure and note.
**Red proof:** drop weight from the listing.

**`grouping-count.integration.test.ts`**:
- A `vi.mock`ed Anthropic answering a refusal with usage → one `'grouping'` row.
- Answering `max_tokens` → one row.
- **Red proof:** remove the catch's record.
- Pick: an injected pick returning `{ answers: null, usage }` (answered, refused) → one
  `'pick'` row, present when `pickBazas` RETURNS (no wait, no poll). **Red proof:**
  `void` the record → the row is absent at return, at least in the race the test forces
  by delaying the insert through a spy.
- Pick: `{ answers: null, usage: null }` (no answer) → no row.

**`machine-cas.integration.test.ts`** (concurrency-3):
- An injected pick that, before answering, performs a PERSON's save: it clears a
  📖-filled baza and ✅s the group. After the pass the baza and its source are still
  null, the ✅ stands, and the pick reports every edit `overtaken`.
- `saveTable(…, { expectRev: stale })` throws `conflict` and writes nothing, not even
  the audit row.
- A screen save (no `expectRev`) is unchanged.
- **Red proof:** drop `expectRev` from the pick's save → the baza is refilled and the ✅
  is gone.

**`finish-reminder.test.ts`** (law-money-1), the `freight-rows-render.test.ts` pattern:
- `renderToStaticMarkup(<NextIntlClientProvider …><NotAnEstimate/></…>)` prints the uz
  words of `calc.finishNotEstimate`;
- source-shape (comments stripped): `calc-actions.tsx` renders `<NotAnEstimate` inside
  the branch guarded by `!canSeal` / the price box, and nowhere else.
- **Red proof:** move it outside the branch, or delete it → red.

**Re-anchors:**
- `baza-provenance.test.ts`: the writer count `>= 4` becomes whatever the one loop
  yields; update the comment listing the writers.
- `import-stats-wire.test.ts`: `candidateStatement` renders `BETWEEN` for a short code
  and `=` for a full one. For a short code the rendered statement carries no
  `percentile_disc` (the named series is not computed).
- `calc-warnings.test.ts`: both new kinds' cases (`baza_dictionary_moved`, `ai_recode`).
- `customs-import.integration.test.ts` «the NEWEST ready import answers» (`:374`):
  re-run. If the fixture's second batch holds fewer than FEW rows of a code it is asked
  about, re-anchor with the reason (the chooser, his 2b where it speaks).
- `import-stats.integration.test.ts` 7 and 12: re-run. Test 9 asserts `batchRecencySql`
  only, so it is unchanged.
- `proposal-wire.test.ts`: the listing call.

**e2e** — a browser is the only oracle for the client draft (dialog → table → save
posting). Append to `m9zu-bojxona-import.desktop.spec.ts`, using its own file and its
own cleanup:
- a row coded with a 4-digit heading opens 📥;
- the candidate shows its `kod:` chip;
- «Tanlash» → «Saqlash» → the database row carries the 10-digit code and the file's price.

---

## 8. P3 «Kiritish» — what comes in (2.7 b Σm³ and the brutto question, the CBM column, the intake count)

### 8.1 Files OWNED
- `src/modules/wms/deals/goods-import.ts`
- `src/modules/wms/calc/`: `intake.ts`, `intake-ai.ts`, `intake-land.ts`, `service.ts`
  (the `openCalcRequest` INSERT, and the facts flag in `missingFor` / `lineNeeds` at
  `:1426-1445`, nothing else)
- `src/modules/platform/telegram/`: `calc-intake.ts`, `staff-handlers.ts`, `staff-bot.ts`
- `src/components/calc-send-form.tsx`
- Tests:
  - re-anchors: the goods-import corpus, the collector/typed cases of
    `intake-corpus.test.ts` (NOT its worker cases c0220/c0221/c0804 and their mock,
    which are P1's, §6.1), `calc-intake.integration`, `intake-items-wire`;
  - new: `totals-question.test.ts`, `intake-volume.test.ts`,
    `intake-usage.integration.test.ts`, `stored-volume.integration.test.ts`,
    `upsale-lines-volume.integration.test.ts`.

### 8.2 Rules
1. **CBM per carton is not the line's volume** (probe P1, measured 14× short).
   - At `goods-import.ts:620-621`, `claim(VOLUME_KEYS)` becomes
     `claimWhere(t => matchKey(t, VOLUME_KEYS) && !PER_PACKAGE.test(t))`.
   - Header `[Description, Qty, CTNS, CBM/CTN, TOTAL CBM, N.W., G.W.]` → volume = TOTAL CBM.
   - G.W. is still never summed into the request (his 2.7 b: asked).
2. **`factsVolumeM3(facts: CalcFacts): number | null`** in `intake.ts` =
   `facts.volumeM3 ?? (facts.totalsStored ? null : linesVolumeM3(landingItems(facts).map(doorRow)))`.
   It runs over DOOR-ROUTED rows (probe P4: «2 kub» is a quantity until the door). Used by:
   - `missingFields` — `volumeM3` is not missing when derivable; `weightKg` is still
     required;
   - `intakeSummaryText` — `Hajm: 12 m³ (qatorlardan)`;
   - `intakeNoteText`;
   - the collector's totals question.
   - **Stored requests derive nothing** (regression-3). `CalcFacts` gains
     `totalsStored?: boolean`: «the totals were read back from a stored request, and
     what the column holds is what the engine prices». `missingFor` and `lineNeeds`
     (`service.ts:1435, 1445`) set it beside `lineWeightsStated: true`. Without it, the
     VED's stored-request chip «umumiy hajmi» would vanish on a request whose stored m³
     is null (every pre-deploy request, or one the VED cleared through `setCargoFacts`)
     while the seal still refuses freight `measure_missing`. A need and a refusal would
     then disagree, which is #649's shape. The rastamojka requirement exists for the
     upsale's quoted cube (MR-9), so the checklist would also stop guarding that.
3. **`openCalcRequest` INSERT** (`service.ts:414`):
   `volumeM3: num(input.volumeM3 ?? linesVolumeM3(rows))`, where `rows` =
   `input.items.map(doorRow)` (already computed).
   - Why stored, not only derived: the checklist now stops asking a total the lines give
     (rule 2). MR-9 (`intake.ts:52-58`) keeps a request m³ so the upsale's payout scales
     on the quoted cube. A request landed with lines and no stored total would pay the
     whole share on the first carton that arrives, which is MR-9's own failure.
   - Only at the INSERT: a later write would move the rev, and the queued pass would
     stand down.
   - The INSERT's audit `after` records `volumeFromLines: true` when the Σ was used.
   - Its provenance is DERIVED at read time (`Workspace.volumeFromLines`, K13) and
     labelled on every surface that prints it: the bot's reply, the tariff reply, the
     VED's m³ cell, the seal's snapshot (§7.2.8). A typed total equal to the Σ reads
     «qatorlardan» too; that is accepted (§0.1(6)).
   - **CHANGED surfaces, stated, each pinned:**
     - The seal copies the m³ into `calc_versions` and onto the card's `quotedVolumeM3`,
       now with `volumeFromLines` in its breakdown (P2, §7.2.8).
     - The upsale `cargo_factor` (`upsale.ts:238-245`): on an offer anchored on a
       «Готово» answer (no version), `quoted_m3` = `COALESCE(v.volume_m3, r.volume_m3)`
       now finds the Σ. A rastamojka quote with kg and no typed m³ moves from the kg ratio
       (or `ELSE 1`) to the m³ ratio. That is his own 4b rule's stated order («per kg
       when the freight was priced per kg, else per m³, else whichever it has»), fed
       with the cube the seller's own lines state, and the denominator MR-9 asked the
       checklist to collect. It is not a new commission rule, so no question is sent;
       it is said in the report. Pinned by `upsale-lines-volume.integration.test.ts`.
     - The price channel prints the m³ (`channel-post.ts:820`), as it prints any stored
       total.
     - E1's actuals completeness reads a request m³ where there was none.
   - Stated: `reconcile.mismatch` (`workspace.ts:812`) compares Σ group m³ with the
     request m³. On such a request they are equal by construction, so a wrong line
     volume (the 14× CBM case rule 1 fixes in one reader) reaches the seal's freight
     price with no check but the label.
4. **Labels.** `FIELD_LABEL.weightKg` = `umumiy brutto og‘irligi (kg, qadoq bilan)`.
5. **The brutto question** (`askNextOrConfirm`, `staff-handlers.ts:1344-1366`):
   - A new pure exported `totalsQuestion(state): 'kg' | 'm3' | 'both' | null` in
     `calc-intake.ts`. It is not null only when the section has a freight half (yolkira,
     podklyuch; every bot door, AI or not), `!state.totalsAsked`, and kg is missing or m³
     is neither stated nor derivable.
   - `'kg'` when m³ is known or derivable and kg is missing:
     `Yo‘lkira uchun umumiy BRUTTO og‘irlik kerak (qadoq bilan), kg. Masalan: «3500» yoki «3500 kg»`
     plus `\n(hajm: 12 m³ — qatorlardan qo‘shildi)` or `\n(hajm bor: 12 m³)`.
   - `'m3'` when kg is known and m³ is neither stated nor derivable (product-fit-7):
     `Yo‘lkira uchun umumiy hajm (kub) kerak. Masalan: «12» yoki «12 kub»\n(brutto og‘irlik bor: 3500 kg)`.
     The seller who typed 3500 kg is never asked for it again.
   - `'both'`: `Yo‘lkira uchun umumiy hajm va brutto og‘irlik kerak. Masalan: «12 kub 3500 kg»`.
   - `IntakeState` gains `askingTotalsFor: 'kg' | 'm3' | 'both' | null`.
   - In `applyLineAnswer`'s totals branch, an answer that names no unit is read as
     `parseManualFacts(\`${text} kg\`)` when `askingTotalsFor === 'kg'`, or
     `\`${text} kub\`` when it is `'m3'`. The house number reader and its «1,200»
     ambiguity rule decide; there is no second reader. A bare number after a `'both'`
     question is refused in words («kub va kg ni birlik bilan yozing: «12 kub 3500 kg»»).
   - **What was READ is kept across re-reads** (concurrency-4).
     - `IntakeState` gains `totalsAnswer: { weightKg: number | null; volumeM3: number | null }`,
       set from the parsed answer.
     - `analyzeCollected` and `settleAnalysis` merge it on top of the re-read facts, the
       way `mergeLineAnswers` merges `lineAnswers`. A bare «3500» stored as raw material
       would read null on the next «Bo‘ldi», because `readNumber` needs a unit word, and
       the job would land with kg null while `totalsAsked` kept the question silent.
     - `totalsAsked` is cleared when a re-read still leaves the asked figure missing, so
       the question is asked again rather than skipped.
   - **The brutto copy onto a single line** (⭐ of Question 4). `itemFacts`' lone copy is
     unchanged: one line, total known, line weight not stated → the line takes the total,
     labelled `LONE_WEIGHT_NOTE`. The brutto answer is now asked on every freight section,
     so it reaches that copy on single-line podklyuch jobs from every door. That is
     stated, and the Telegram customs line says «og‘irlik bruttodan» (§2.1). Built as
     (b) instead, `itemFacts` would skip the copy when `totalsAnswer.weightKg` set the
     total, and the per-line question would ask the line's netto.
   - **A lost question is said, not paid for** (concurrency-5). The collection lives in
     memory until round 3. A restart, or the TTL, between the question and the answer
     loses it, and the brutto question is not a `WaitKind` (0130's kind CHECK admits four
     kinds; a fifth needs a migration). So a pure `looksLikeTotalsAnswer(text)` in
     `calc-intake.ts` (digits plus optional kg/kub/m³ words, nothing else) is asked by
     `answerStaffText` after the free lookups and before the AI assistant. With no live
     collection, the bot replies `Hisoblatish to‘plami topilmadi (bot qayta ishga
     tushgan bo‘lishi mumkin) — 🧮 ni qayta bosing.` and never calls
     `answerWithAssistant`. This is the same exposure every collector question already
     has; the round widens it, so the round guards it.
6. **The AI intake prompt** (`intake-ai.ts`):
   - The shipment total weight is BRUTTO (with packaging). When the document gives only
     netto → `null` (then the bot asks).
   - A line's volume is the WHOLE line (all cartons), never one carton's; when only a
     per-carton volume is given → `null`.
   - The schema descriptions follow.
7. **The intake count (2.9 c).**
   - `AiIntakeOutcome` carries `answered: AiUsage[]`: the usage of every attempt that got
     a response (ok, refused, truncated, unreadable). Today that is at most one per
     analysis.
   - `IntakeState.usage` → `usages: AiUsage[]`, APPENDED on every analysis.
     `analyzeCollected` re-reads no longer replace earlier ones.
   - `landCollectedIntake` passes `usages`. `landIntake` records each through
     `recordAiPass({ kind: 'intake', requestId })`.
   - **The records never stand in front of the pass** (concurrency-8). Today one
     optional record and `queueCalcPrefill` share one `try` (`intake-land.ts:302-321`),
     so a failed bookkeeping insert skips the queue: the request lands with no pass and
     no reply. With several records, that is several chances. Each record now sits in
     its own `try/catch` (logged `[calc-intake] usage not recorded`), still BEFORE the
     queue, so the soft budget the pass reads already counts the intake's calls. Then
     `queueCalcPrefill` runs whatever the records did.
   - An abandoned collection still records nothing. It has no request to anchor to;
     round 3's durable collection gives it one (stated).
8. **Card form** (`calc-send-form.tsx`): under the m³ box, a muted hint
   `t('sendTable.volumeFromLines')`. The kg label already says brutto.

### 8.3 Tests (P3)

**`intake-volume.test.ts`** — pure:
- `factsVolumeM3` over «2 kub» lines (door-routed) → 2.
  **Red proof:** use `itemFacts` instead of the door rows → null.
- `missingFields('yolkira', …)` does not list `volumeM3` when every line states m³, and
  lists it when one does not.
- `missingFields` with `totalsStored: true`, a null volume and lines stating m³ STILL
  lists `volumeM3`. **Red proof:** drop the `totalsStored` clause.
- `weightKg` is still listed when only line kg exists.
  **Red proof:** Σ line kg.

**`stored-volume.integration.test.ts`** (regression-3): a stored request with
`volume_m3` null and lines carrying m³ → `missingFor` lists the volume chip AND the
workspace freight refuses `measure_missing`. The need and the refusal agree.
**Red proof:** drop `totalsStored` from `missingFor`.

**`upsale-lines-volume.integration.test.ts`** (law-money-3 / regression-2): a
rastamojka request landed through `openCalcRequest` with lines 1.2 + 1.6 m³, 400 kg, and
no typed m³; a «Готово» answer; an offer on it; a confirmed prixod of 2.1 m³ on the deal
→ `cargo_factor` = 2.1 ÷ 2.8 = 0.75, a literal computed by hand. That anchors the
denominator on the request's own lines.

**Goods-import corpus case** — the CBM/CTN header above.
**Red proof:** drop the `PER_PACKAGE` clause → 0.12.

**`totals-question.test.ts`** — pure:
- yolkira on the plain door asks.
  **Red proof:** restore the `state.ai && podklyuch` gate;
- rastamojka never asks;
- `'kg'` vs `'m3'` vs `'both'`; kg known with m³ missing → `'m3'`, and its text does not
  ask for kg. **Red proof:** collapse `'m3'` into `'both'`;
- asked once;
- a bare «3500» after a `'kg'` question → `weightKg` 3500.
  **Red proof:** drop the `kg` suffix read;
- a bare «3500» answered, then «➕ Yana ma’lumot» → «Bo‘ldi» (a re-analysis with new
  material) → `weightKg` is still 3500. **Red proof:** store only the raw text;
- a re-read that leaves the asked figure missing clears `totalsAsked`;
- `looksLikeTotalsAnswer`: «3500», «3500 kg», «12 kub» → true; «Kurtka 300 kg» and
  «GS777» → false. In `answerStaffText` with no live collection, the reply is the «🧮 ni
  qayta bosing» sentence and the assistant spy is not called. **Red proof:** drop the
  guard → the spy is called.

**`calc-intake.integration.test.ts`** — a card-form landing with lines 1.2 + 1.6 m³ and
no total:
- `calc_requests.volume_m3` = 2.8. **Red proof:** drop the INSERT fallback;
- an explicit 5 wins;
- one line missing → null.

**`intake-usage.integration.test.ts`**:
- Two analyses (one `truncated` with usage, one ok) then a landing → two `'intake'` rows.
  **Red proof:** replace instead of append.
- A `network` failure (no answer) → no row.
- A failing record (spy throws on the first insert) → the pass is STILL queued (spy on
  `queueCalcPrefill`), and the second usage is still recorded. **Red proof:** one shared
  `try`.

**Re-anchor:** any test asserting `FIELD_LABEL.weightKg`'s old words, or the AI-podklyuch-
only totals question (grep `Yo‘lkira uchun umumiy hajm`). The reason: his 2.7 b.

---

## 9. P4 «Lenta» — the mark for the VED (2.4 c)

### 9.1 Files OWNED
- `src/modules/wms/crm/feed.ts`
- `src/components/client-feed.tsx`
- Tests: `feed.integration.test.ts` (extended); new `feed-machine-chip.test.ts`

### 9.2 Rules
- **`feed.ts` note meta** gains, tried top to bottom:
  ```sql
  'machineReply', CASE
    WHEN a.created_by IS NULL
     AND (starts_with(a.note, ${AI_REPLY_HEAD}) OR starts_with(a.note, ${TARIFF_REPLY_HEAD}))
     AND strpos(a.note, ${VED_ESTIMATE_MARK}) > 0                      THEN 'estimate'
    WHEN a.created_by IS NULL AND starts_with(a.note, ${AI_REPLY_HEAD})     THEN 'ai'
    WHEN a.created_by IS NULL AND starts_with(a.note, ${TARIFF_REPLY_HEAD}) THEN 'tariff'
  END
  ```
  - The heads and the mark are bound as parameters, from K's `reply-heads.ts`.
  - A person's note that starts with the head is NOT a machine reply. Neither is an
    advert's system note.
  - `'estimate'` (product-fit-5, partial) is the mark he asked for in 2.4 c, visible
    without opening the note: a fully exact reply and one carrying a 📊 median or a
    guessed zone no longer wear the same chip.
- **`client-feed.tsx`:**
  - `FeedRow` prints a chip after the existing marks:
    `<span className="ml-1.5 font-semibold text-warn" data-testid="feed-machine-reply">{marks[machineReply]}</span>`.
  - The tone is a literal class (Tailwind compiles only literals). It is printed for
    every reader.
  - No `permissions.has(` in this file (`thread-wire` 8).
  - `marks` gains `ai`, `tariff` and `estimate` from `threads.feedAiReply` /
    `threads.feedTariffReply` / `threads.feedEstimateReply`. The map is
    `Record<'ai' | 'tariff' | 'estimate', string>`, so a missing word is a compile
    error.
  - `FeedRow` is exported for the render test ("exported for the test alone").

### 9.3 Tests (P4)

**`feed.integration.test.ts`**:
- A system note made by the REAL `aiVedReplyText` (K's version) → `machineReply = 'ai'`.
- A system note starting with `TARIFF_REPLY_HEAD` → `'tariff'`.
- A system note starting with `AI_REPLY_HEAD` whose line 2 starts with
  `VED_ESTIMATE_MARK` → `'estimate'`. The fixture text is built from K's constants, so
  it does not wait on P1's renderer. **Red proof:** drop the `'estimate'` branch → `'ai'`.
- A PERSON's note with the same text → null.
  **Red proof:** drop `created_by IS NULL`.
- An advert's system note → null.

**`feed-machine-chip.test.ts`** — `renderToStaticMarkup`, the `freight-rows-render.test.ts`
pattern: the chip renders with the uz words for 'ai', 'tariff' and 'estimate', and is
absent for a plain note.

`thread-wire.test.ts`'s «every threads.* key … all four bundles» covers the keys.

---

## 10. i18n keys (all four bundles; anchors keep the hunks apart)

| Key | uz | ru | en | zh-CN | Package | Inserted after |
|---|---|---|---|---|---|---|
| `calc.table.dictionaryFilled` | `lug‘atdan to‘ldirilgan baza: {count} ta, qator` | `база из словаря: {count} шт., строки` | `baza from the dictionary: {count}, rows` | `从词典填入的基价：{count} 条，行` | P2 | `calc.table.memoryFilled` |
| `calc.warnings.bazaDictionaryMoved` | `Lug‘atdagi baza o‘zgargan` | `База в словаре изменилась` | `The dictionary baza has changed` | `词典基价已变更` | P2 | `calc.warnings.bazaFromMemory` |
| `calc.statsShortCode` | `Statistika 10 xonali kod bo‘yicha — ro‘yxatdan deklaratsiya tanlang, kodi o‘zi qo‘yiladi` | `Статистика — по 10-значному коду; выберите декларацию из списка, код подставится` | `Statistics need a 10-digit code — pick a declaration from the list and its code is set` | `统计需10位编码——从列表选一条申报，编码自动填入` | P2 | `calc.statsTimeout` |
| `calc.importOtherCode` | `kod: {code}` | `код: {code}` | `code: {code}` | `编码：{code}` | P2 | `calc.statsPick` |
| `calc.sendTable.volumeFromLines` | `Bo‘sh qolsa — qatorlardagi kub qo‘shiladi` | `Если пусто — сложим объём строк` | `Left empty — the lines’ m³ are summed` | `留空则合计各行体积` | P3 | `calc.sendTable.totalVolume` |
| `threads.feedAiReply` | `🤖 AI taxmini · rasmiy emas` | `🤖 Оценка ИИ · не официально` | `🤖 AI estimate · not official` | `🤖 AI 估算 · 非正式` | P4 | `threads.feedViaTelegram` |
| `threads.feedTariffReply` | `🧮 Tarif bo‘yicha taxmin · rasmiy emas` | `🧮 Оценка по тарифу · не официально` | `🧮 Tariff estimate · not official` | `🧮 按运价估算 · 非正式` | P4 | `threads.feedAiReply` |
| `threads.feedEstimateReply` | `📊 Ichida taxmin bor · rasmiy emas — VED tekshiradi` | `📊 Есть оценка · не официально — проверит ВЭД` | `📊 Contains an estimate · not official — the VED checks it` | `📊 含估算 · 非正式 — 由VED核对` | P4 | `threads.feedTariffReply` |
| `calc.finishNotEstimate` | `Telegram va lentadagi «Aniq», «Taxminiy» va «JAMI taxminiy» rasmiy narx emas — ularni bu yerga ko‘chirmang. Bazani 📥 dan tanlang, zonani belgilang va muhrlang.` | `«Aniq», «Taxminiy» и «JAMI taxminiy» из Telegram и ленты — не официальная цена, не копируйте их сюда. Выберите базу через 📥, укажите зону и запечатайте.` | `The «Aniq», «Taxminiy» and «JAMI taxminiy» figures in Telegram and the feed are not official prices — do not copy them here. Pick the baza from 📥, set the zone and seal.` | `Telegram 和动态中的「Aniq」「Taxminiy」「JAMI taxminiy」不是正式价格——请勿抄到这里。请通过 📥 选择基价、设定区域并封存。` | P2 | `calc.answerAmount` |
| `calc.warnings.aiRecode` | `Kodni AI deklaratsiyaga qarab tanlagan — kod va bojni tekshiring` | `Код выбрал ИИ по декларации — проверьте код и пошлину` | `The AI chose the code from a declaration — check the code and the duty` | `编码由AI依据申报选择——请核对编码和关税` | P2 | `calc.warnings.bazaDictionaryMoved` |
| `calc.importListTimeout` | `Bu sarlavha juda keng — ro‘yxat o‘qilmadi. 10 xonali kodni yozing.` | `Эта товарная позиция слишком широкая — список не прочитан. Укажите 10-значный код.` | `This heading is too wide — the list was not read. Type the 10-digit code.` | `该品目范围过大——未能读取列表。请输入10位编码。` | P2 | `calc.statsShortCode` |
| `calc.volumeFromLinesShort` | `qatorlardan` | `из строк` | `from the lines` | `由各行合计` | P2 | `calc.table.dictionaryFilled` |

- The bot's Uzbek strings stay in code. The staff bot speaks Uzbek, per the
  `prefill-reply.ts` convention.
- Each package matches the apostrophe style of the keys around its anchor.

---

## 11. Migration: none

- No new `baza_source` value. The median is never stored.
- No provenance column for a dictionary fill. The `'dictionary'` source already exists
  (0096 CHECK).
- No persistent «cleared by a person» flag (stated).
- No anchor change on `ai_calc_passes`. Abandoned collections and the three unmetered
  doors are round 5's, together with the dollar ceiling. That is the migration item 3
  already owns.
- The guessed zone and the Σ m³ need no column. The Σ goes into the existing
  `volume_m3`, at the INSERT. Its provenance is derived at read time (K13) and recorded
  in the INSERT's audit row and the seal's jsonb snapshot.
- No `WaitKind` for the brutto question: 0130's kind CHECK admits four kinds (§8.2.5).
- No key on `telegram_once` for «one machine message per request»: its CHECK admits only
  `m:`/`q:`. The claim is an advisory lock plus an EXISTS over `notifications` (§6.8).
- The AI recode is flagged through `baza_reason`, which the pick already writes, and a
  DERIVED warning. No `ai_proposed` write on a group minted by a recode.

---

## 12. Not this round (said to him)

- **2.8 b** — asking the law's unit AFTER the codes are known. Needs round 3's durable
  collection and the «➕ Shu so‘rovga qo‘shish» door.
- **The memory learning from «Готово» answers.** Confirmed (`memory.ts:151-160` reads
  seals only), not built. A «Готово» is a typed total with no per-row baza, so it has
  nothing per product to teach without a design of its own.
- **The dollar ceiling, model choice on a settings screen, effort/streaming** — round 5.
- **Metering** the deal goods import, the Bojxona tab's 🤖 and the card-chat door, and
  billing abandoned collections — round 5 (the anchor migration).
- **Calls with no answer** (timeout, network) are not counted; round 5 reads dollars.
- **Russian customs-style names** for matching (Uzbek/Chinese names still score ~0
  against the file). The model still bridges languages only through the pick. Rounds 5-6.
- **The invoice price** — never (his 2.3 a).
- **A heading-wide median, and heading-wide statistics.** The 📊 estimate and the 📥
  statistics need a 10-digit code. A heading row gets a median only after the pick
  recodes it.
- **A durable brutto question.** It lives in the collector's memory until round 3; a
  restart between the question and the answer loses it. This round only guards the
  orphan answer from the paid assistant (§8.2.5).
- **A guard on «Готово» that reads the lenta.** The reminder built this round is
  deterministic (`canSeal` false). It does not compare the typed figure with the
  machine's numbers.
- **The machine's seconds between `releaseAiClaim` and the end of
  `priceProposedGroups`** are not under the compare-and-set (§6.7).
- **Guessing zones for other Chinese cities** (⭐ of Question 3); a persistent
  «cleared» flag; the admin-screen sentence about per-code batches.

---

## 13. For the lead's Uzbek report (⭐ = built default)

### 13.1 Savollar (the four of «Questions for the owner», in his language)

**2.10** Ba'zi qatorlarga na aniq baza, na mediana topilsa, Telegramdagi «Taxminiy»:
- a) chiqmaydi, sababi yoziladi: «Taxminiy: hisoblab bo'lmadi — …» ⭐
- b) shu qatorlarsiz, qator soni bilan chiqadi: «Taxminiy ≈ $Y (10 tadan 9 qator)»

**2.11** Faqat yo'lkira so'rovida zona tanlanmagan bo'lsa (2.6 podklyuch haqida edi):
- a) shahardan taxmin qilinadi, «taxmin» deb yoziladi ⭐
- b) taxmin qilinmaydi, «zona tanlanmagan» deyiladi

**2.12** Boshqa Xitoy shaharlari (Foshan, Shenzhen, Urumchi…):
- a) taxmin qilinmaydi — javob shaharni aytib «zona aniqlanmadi» deydi; faqat «Xitoy»
  so'zi yozilgan bo'lsa (shahar nomisiz) Xitoy zonasi olinadi ⭐
- b) Qashg'ar va Horgosdan boshqa har qanday Xitoy shahri Xitoy zonasiga o'tadi

**2.13** Yuk bitta qatordan iborat, og'irlik faqat umumiy (brutto) berilgan bo'lsa,
rastamojka uchun:
- a) hozirgidek: umumiy og'irlik qatorga yoziladi («og'irlik umumiy (brutto)dan
  olindi»), Telegram javobida ham «og'irlik bruttodan» deb ko'rsatiladi ⭐
- b) yozilmaydi: bot qatorning sof (netto) og'irligini so'raydi, rastamojka shunga qadar
  hisoblanmaydi

### 13.2 Aytiladi, so'ralmaydi (stated in the report, not asked)

1. «Aniq» bojxona yig'imisiz yoziladi («yig'imsiz»): yig'im darajasi butun deklaratsiyaga
   bog'liq. «Taxminiy» yig'im bilan.
2. «Готово» oynasida eslatma turadi: Telegram/lentadagi «Aniq», «Taxminiy», «JAMI
   taxminiy» rasmiy narx emas. Sabab: «Готово»ga yozilgan raqam upsale chegarasi,
   kartadagi narx qulfi, narx kanali posti va sotuvchiga «✅ Hisoblash tayyor» bo'lib
   ketadi.
3. Lug'at har «Saqlash»da avtomatik to'ldiriladi; tartib siz kelishgandek: xotira →
   lug'at → bojxona fayli.
4. Eng yangi faylda shu kod bo'yicha 5 tadan kam deklaratsiya bo'lsa, eski to'liq fayl
   javob beradi («eski fayl» belgisi bilan).
5. 4-6 xonali kod bilan qidiruv: AI deklaratsiya tanlasa, qatorning kodi o'sha
   deklaratsiya kodiga o'zgaradi va VED uchun «kodni AI tanlagan» ogohlantirishi
   chiqadi — ✅ bosilmaguncha muhrlanmaydi.
6. Umumiy kub qatorlardan qo'shilsa, so'rovga yoziladi va hamma joyda «qatorlardan»
   deb ko'rsatiladi. Sotuvchi upsale ulushi shu kub bo'yicha hisoblanadi (sizning
   «kelgan yuk / va'da qilingan kub» qoidangiz).
7. Sotuvchi to'ldirishi kerak bo'lgan narsa (shahar, brutto kg, kub, son) javobda
   «mijozdan so'rab, kartadagi lentaga yozing» deb aytiladi; VED qiladigan narsa —
   «VED xodimi».
8. Faqat yo'lkira so'roviga javob alohida navbatda: rastamojka hisobini kutmaydi
   (taxminan 2-3 soniya).
9. AI chaqiruvlari endi to'liq sanaladi: model javob bergan har bir chaqiruv — qayta
   o'qish, rad etilgan yoki kesilgan guruhlash javobi, bazani tanlash ham. Shuning
   uchun kunlik 200 talik limit avvalgidan tezroq to'lishi, «AI kunlik limiti tugadi»
   ertaroq chiqishi mumkin. Sizning 2.9 c javobingiz bo'yicha avval o'lchaymiz: kunlik
   chaqiruvlar soni turi bo'yicha (o'qish, guruhlash, tanlash) sizga aytiladi.

---

## 14. Merge, gates, verification (the lead)

1. **K first.**
   - Fresh `gsr_ci`: migrate, seed, `seed:demo`.
   - `pnpm typecheck` / `pnpm lint` / the calc + customs unit and integration suites, each
     with its own exit code.
   - K is behaviour-unchanged: every new seam's K value reproduces today (`expectRev`
     never passed, `volumeFromLines` unread, the pick's usage still `void`, the payload's
     `section` unread, every freight refusal tail `ved`). The full calc suite passing
     unchanged, apart from the named mechanical fixture updates, is the proof.
   - Commit, then write the hash at the top of this file.
2. **P1-P4 in worktrees off K, in parallel** (4 CPUs → two workflow agents at a time;
   #1339). Each package:
   - runs typecheck, lint and its touched unit and integration tests against its own
     `gsr_<pkg>` database;
   - shows every red proof by string edit;
   - commits and reports its branch.
3. **Cherry-pick order:** P2 → P1 → P3 → P4.
   - File sets are disjoint except `intake-corpus.test.ts`: P1's worker hunks and P3's
     collector hunks, 400+ lines apart (§6.1, §8.1). On a conflict there, keep both
     sides.
   - The `messages/*.json` hunks are anchored apart.
   - After each pick run `pnpm typecheck`.
   - The cross-package seams all go through K's signatures: P1 consumes P2's chooser
     behaviour (K8), the revision chain (K14) and the pick's returned usage (K5), and
     P1's test (7) consumes P3's INSERT through K13.
4. **On the merge:**
   - `pnpm typecheck`, `pnpm lint`;
   - the full vitest on a fresh `gsr_ci`, seeded once;
   - Playwright **without re-seeding** (CI's order);
   - `fuser -k 3000/tcp` before e2e; no `CI=1`.
   - Also check: `grep -rhoE "https://[a-z.]+/" .next/static/`. No new browser library is
     expected.
5. **Docs:**
   - `docs/SAKKIZ-BAND.md`: §3 status, §10 «R2 SHIPPED» with the DECISIONS range.
   - DECISIONS `#R2-*` renumbered after a fetch.
   - CHANGELOG in Uzbek.
   - CLAUDE.md state paragraph: no migration, ledger 136, code-only round → the deploy
     ends by reading `/api/version`, not the count.
6. **Measured, not argued, before the push:**
   - one real `aiPrefill` on a shaped copy with a customs import loaded;
   - print the reply;
   - time `rowMediansFor` on the fullest code, with dona rows in several bands. There is
     one statement per (code, batch), each ≤ 1.5 s by construction; record the measured
     total against `ESTIMATE_BUDGET_MS`;
   - time the widest real heading's candidate scan (the 📥 list and the pick's), against
     `HINT_STATEMENT_MS` and `PICK_HEADING_MS`. If the common 4-digit headings time out on
     his file, say so in the report: the 📥 list then asks for the 10-digit code;
   - time a whole customs pass's worst case (propose + pick + medians + saves) and
     confirm `PASS_EXPIRE_S` ≥ 2 × that figure;
   - time one VED «Saqlash» on a 30-row request before and after P2 (the dictionary read
     and the skipped import asks);
     - *Measured in the R2 late pass (review regression-19), on a synthetic shaped copy,
       not his file:* 4 ready quarters × 150k rows with ~250-character names, a 30-row
       request whose every row carries a full code the file holds 3,000 declarations of in
       each quarter, every row baza-less and named nothing like the file (the worst case:
       the import is asked about every row), jit off. The chooser for the 30 codes:
       **13-14 ms**, against **2-3 ms** for the pre-P2 `newestReadyBatchId` — about 10 ms,
       0.3 % of the save. The save itself: **3.6-4.1 s on every press** with the import
       scans asked afresh each time (the shipped behaviour; K's per-save memo spared only
       twins inside one save), **3.9 s for the first press and 26-43 ms for every later
       one** with the late pass's cross-save memo (perf-4). The «before P2» save on K's
       code was not re-run: its cost is the same per-row import scans, which P2 did not
       add, plus the chooser's 10 ms above. The candidate scan itself is ~1.6× cheaper
       since perf-1 (30k-row heading 3.4 → 2.2 s; the chooser's two-step count, 12
       quarters, 40 heavy codes 78.7 → 13.9 ms).
   - **count, on the last 200 rastamojka/podklyuch requests replayed read-only**: how
     often Taxminiy comes out whole, how often absent (by `taxminiyBlock`), and how
     often the zone was guessed. The «absent» count is reported to him beside
     Question 1.
   - **AI calls per day, by kind** (late pass, review product-fit-15): his 2.9 c is
     «avval o'lchaymiz», this round makes every answered call count against the cap,
     and nothing in the app reads `ai_calc_passes` but the budget check itself. Read-only,
     on the shaped copy and on his server once deployed — the calc budget's own count,
     on its own Tashkent day:
     `SELECT (created_at AT TIME ZONE 'Asia/Tashkent')::date AS day, kind, count(*)
     FROM ai_calc_passes WHERE kind <> 'similar' GROUP BY 1, 2 ORDER BY 1, 2;`
     Reported to him with §13.2 item 9: the busiest day's total against
     `ai_calc_daily_limit` (200).
7. **Pinned by name on the merge**: `calc-basis.integration.test.ts:657-675` green,
   `customs-estimate.integration` (7) green on the MERGED tree (the label through K13
   after P3's INSERT), and `intake-corpus.test.ts` green with both packages' hunks.

---

## 15. Judged before code

Five lenses, each objection checked by a refuter. **37 objections: 32 confirmed, 4
partial, 1 refuted.** Every confirmed and partial one is absorbed; the refuted one
leaves the spec as it was.

The relayed lists were cut at a fixed length. The counts are of the ids that arrived
with a verdict. Where an objection's own text was cut (law-money-5's fix, regression-8's
fix, regression-9, product-fit-8, performance-7, concurrency-8), the absorption follows
its verdict's reason and says so. An id after a cut, if any existed, was not seen.

| Id | Verdict | What changed |
|---|---|---|
| law-money-1 | confirmed | The «Готово» reminder is BUILT this round (P2, `calc-actions.tsx` `NotAnEstimate`, `calc.finishNotEstimate`), printed whenever the price box shows (`canSeal` false). §3/§13.2 name all four consequences of a copied figure: upsale floor, quote lock, price-channel post, CalcDone push. Old Q4 retired. |
| law-money-2 | refuted | Kept: the VED line's condition stays «a 📊 line or a guessed zone». A named partial Aniq states its row count and «yig‘imsiz» on its own face (§2.6 says so). |
| law-money-3 | confirmed | The INSERT is kept (MR-9). Provenance is derived at read time (`Workspace.volumeFromLines`, K13) and consumed by `freightAnswerFor`, the m³ cell and the seal snapshot; the audit records it. Test (7) lands through `openCalcRequest`. §8.2.3 states that `reconcile.mismatch` cannot catch a wrong line volume. |
| law-money-4 | confirmed | The recode stays (option 2): `AI_RECODE_PREFIX` in `baza_reason`, the derived `ai_recode` warning recorded by the ✅, and E1 counting such groups as the AI's (§1, §7.4). |
| law-money-5 | confirmed | `estimate-wire` gains an import-direction fence over `src/` with TypeScript's parser: who may import the three estimate files and who may name the estimate identifiers (§6.9). §3's «fenced» now points at it. |
| regression-1 | confirmed | `clearedNow` = a null post over a baza that was NOT null in the transaction. A null post on a baza-less row is a unit choice. `calc-basis.integration:657-675` is named as must-stay-green; dictionary-fill (f2) added. |
| regression-2 | confirmed | The INSERT is kept for MR-9; the label is derived (K13) so it survives. Upsale, seal, price channel and E1 are listed as CHANGED surfaces with reasons and a pinned upsale test (§8.2.3). The commission factor follows his own 4b order, so it is stated, not asked. |
| regression-3 | confirmed | `CalcFacts.totalsStored`: `missingFor`/`lineNeeds` derive nothing, so the chip and the engine agree. `stored-volume.integration` pins it. |
| regression-4 | confirmed | `section` rides the job payload (K16); there is no DB read and `prefillStanding` still returns a string. The intake-corpus c0220/c0221/c0804 and intake-round1 re-anchors are named, with their reason (§6.1, §6.9). |
| regression-5 | confirmed | `guessZone` in two tiers: a cn CITY beats kashgar/horgos wherever it stands (his 21a); leftmost only between kashgar and horgos (§6.3). |
| regression-6 | confirmed | The chooser is total: a code no file holds maps to the newest ready batch; only an empty map is `no_batch` (K8, §7.3, batch-choice (f)). |
| regression-7 | confirmed | The 📥 list judges `pickable` and the unit label by each candidate's OWN law (`ratesForCodes` on the pool); heading-search (d2) added. |
| regression-8 | confirmed | The name-matched series is computed only for a 10-digit code (`namedState: 'short_code'`); the wire test pins no `percentile_disc` on a short code (§7.4). |
| regression-9 | confirmed | The pick's usage is RETURNED (`PickOutcome`, K5) and recorded with `await` in `pickBazas`; the `onUsage` callback is gone (§7.5). |
| product-fit-1 | confirmed | Two tiers: the country word counts only when no city matched; `қашғар`/`кашкар` added; the reply prints what it read («zona «Китай, Кашгар»dan taxmin»). §0.1(2) and Question 3 are made consistent; guess-zone cases and two red proofs added. |
| product-fit-2 | confirmed | New `zone_unpriced` case: ««Horgos» → O‘zbekiston narxi tarifda hali yo‘q», never «aniqlanmadi» (§2.5, §6.4, freight-answer test). |
| product-fit-3 | confirmed | Option (b): the label is derived from the numbers (K13) and a typed total equal to the Σ is labelled too, stated in §0.1(6). Test (7) goes through the real door. |
| product-fit-4 | confirmed | Became Question 1 (⭐ whole only, alternative: a partial with its row count) and §0.1; §14.6 counts how often Taxminiy is absent. |
| product-fit-5 | partial | The VED line moved to line 2, under the heading. P4's chip gains `'estimate'` (read off `VED_ESTIMATE_MARK`) with its own words. Not taken: «the VED will not see it», since the note renders whole. |
| product-fit-6 | confirmed | `FREIGHT_TAIL: Record<case, 'seller' \| 'ved'>`: seller-side refusals end «— mijozdan so‘rab, kartadagi lentaga yozing». The Taxminiy block splits `refused_measure` (seller) from `refused` (VED) (§2.2, §2.5). |
| product-fit-7 | confirmed | `totalsQuestion` gains `'m3'` («… umumiy hajm (kub) kerak … (brutto og‘irlik bor: 3500 kg)»); a test proves kg is not re-asked. |
| product-fit-8 | confirmed | The lone brutto copy is stated (§8.2.5) and became Question 4 (⭐ as today, labelled). The Telegram line says «og‘irlik bruttodan» (`weightFromTotalNote`, K15). The objection's text was cut; absorbed from its verdict. |
| performance-1 | confirmed | Heading-range reads run under a ceiling (`HINT_STATEMENT_MS` in the list route → `state: 'timeout'`; `PICK_HEADING_MS` in the pick → `timedOut`). The pick dedupes by shape. §14.6 measures the widest heading. |
| performance-2 | partial | The named series is skipped on a short code (cheap, shared with regression-8). Not taken: «a contradiction on screen», because the panel returns before drawing it. |
| performance-3 | confirmed | Freight-only jobs get their own queue `calc.tariff-reply` (§6.8); the latency is stated in §2.4. |
| performance-4 | confirmed | `PASS_DEADLINE_MS` (skips the pick and the medians past it, said in words) and `expireInSeconds: PASS_EXPIRE_S` on the customs queue; §14.6 measures the worst case. |
| performance-5 | partial | One statement per (code, batch) with FILTERed band series (≤ `MAX_BANDS_PER_CODE`); a 57014 stops that code; `ESTIMATE_BUDGET_MS` stops the read. The «60 s certain» figure was not taken; the budget bounds it whatever the real figure is. |
| performance-6 | confirmed | The median transactions are strictly sequential; `estimate-wire` refuses `Promise.all`/`Promise.allSettled` in `estimate-read.ts`. |
| performance-7 | partial | The import is no longer asked for rows the memory or the book already answer before the transaction. Not a regression (the verdict's point); the save's time is measured in §14.6. The objection's text was cut; absorbed from its verdict. |
| concurrency-1 | confirmed | `sayOnce` (advisory lock + EXISTS over the requester's `CalcPrefilled` rows): one machine message and one lenta note per request, also for the customs mirror; `calc-prefill-once.integration` (§6.8). |
| concurrency-2 | confirmed | Same fix as performance-3: own queue, registered inside `registerCalcPrefillWorker`; routing pinned in `calc-prefill-wire`. |
| concurrency-3 | confirmed | `saveTable(…, { expectRev })` (K14), threaded through sweep → pick; a stale machine save is `conflict` and writes nothing; `machine-cas.integration` (§6.7, §7.2.7). |
| concurrency-4 | confirmed | `IntakeState.totalsAnswer` is merged back on every re-read; `totalsAsked` is cleared when the figure is still missing (§8.2.5, totals-question test). |
| concurrency-5 | confirmed | Stated in §12, and `looksLikeTotalsAnswer` keeps an orphaned «3500» away from the paid assistant (§8.2.5). |
| concurrency-6 | confirmed | Same fix as regression-9 (`PickOutcome`, awaited record). |
| concurrency-7 | confirmed | Same fix as performance-5/6: sequential, one statement per code, a budget. |
| concurrency-8 | confirmed (nit) | Text cut after «landIntake enqueues the pass (intake-land…». Absorbed as the two races at that line this round touches: each intake usage record has its own `try`, so a failed insert never costs the pass (§8.2.7, intake-usage test); and the fast tariff reply arriving before the bot's «saqlandi» is stated as accepted (§2.4). |

---

## 16. The merged review (after the merge, before the push)

The merged round was reviewed again by lenses with refuters; the relayed list was cut
after REG-1 (its text stops mid-sentence), so an id after it, if any existed, was not
seen. Each finding below was verified against the merged tree first; every behavioural
fix carries a red proof made and undone by string edit.

| Id | Verdict | What changed |
|---|---|---|
| law-money-R2-1 | confirmed, defect | `AiVedFreight.exact` (REQUIRED): true only when `freightAnswerFor` passed the workspace's own road through. The plain «JAMI (…)» needs it; otherwise «JAMI taxminiy», and the lenta's VED line says «yo‘lkira hajmi qatorlardan — so‘rovda umumiy hajm yo‘q». The Σ fallback stays, labelled, for pre-round-2 requests (§6.4 step 3) — it no longer claims exactness. Amends §2.3's first JAMI row and §2.6's condition. |
| law-money-R2-2 | confirmed, defect | `AiVedLine.staleBaza` (REQUIRED) from the workspace's `bazaStale`; the line's head says «· ⚠ eski baza» on every shape. Keeps §7.3's «the reply says eski» for a filled baza, not only for a 📊 median. |
| law-money-R2-3 | confirmed, nit | `calc.finishNotEstimate` names every bot figure — «Aniq», «Taxminiy», «JAMI», «Yo‘lkira ≈» — in all four bundles. |
| law-money-R2-4 | confirmed, nit | `docs/VED-IMPORT-AI.md` §6 states the two-tier guess instead of «never guessed». |
| PF-1 | confirmed, defect | A kilo figure labelled NETTO (netto, нетто, N.W., NW, net weight, 净重, sof og‘irlik) never fills the total on a freight section or when no section is named; on a customs job it stands as the total when nothing else is stated, flagged `weightNetto`. The model's half: `weight_netto` in the reading, and `totalWeightFrom` (one rule for the bot and the thread door) does not let a netto reading stand for a freight brutto. The summary and the lenta note say «Og‘irlik (brutto)» on a freight section. Corpus c2382-c2384 (renumbered from c2278-c2280 on the rebase onto 62a23bf, which took those ids). |
| PF-2 | confirmed, defect | When two or more lines read as goods, a figure standing on one of them is that line's, not the shipment's (`typedGoods` returns which lines it read). A figure on any other line («Jami 700 kg 10 kub») still answers. Corpus c2385-c2386 (renumbered from c2281-c2282). |
| PF-3 | confirmed, defect | `CalcFacts.weightNetto`; the lone copy writes `LONE_NETTO_NOTE`; `weightFromTotalNote` answers WHICH total; `AiVedLine.weightFromTotal` is `'brutto' | 'netto' | null` and the line says «og‘irlik nettodan». ⭐ Q4 a stands for the brutto case. |
| PF-4 | partial | `city_unplaced` → tail `ved`: the customer already named the city; the zone is the VED's. Amends §2.5's table. The «two fixers» half was refuted (the VED-zone line appears only on a guessed zone). |
| PF-5 | confirmed, nit | No city AND a missing measure, both the seller's, are said in one sentence; a VED gap is never joined to a seller sentence. |
| PF-6 | confirmed, nit | The heading says «taxminiy», like every other line; the uz settings description too. |
| PF-7 | partial | The VED line names the button as the Uzbek screen does: «Muhrlashdan yoki «Bajarildi» (Готово) bosishdan oldin…». Amends §2.6's sentence. |
| PF-8 | partial | The reminder gives no section-specific instruction; it says to type the VED's own figure. |
| PF-9 | confirmed, nit | The «tariff» chip anchors on the PRICED title (`TARIFF_PRICED_HEAD`, reply-heads.ts); a refused tariff reply wears none. |
| REG-1 | confirmed, defect (fence) | batch-choice (g): a READY file beside a PROCESSING one that wins every other rule — the ready file answers. The clause was right and unfenced. |

## 17. The late pass (what the relays had cut, judged against the merged code)

Three lists reached the build cut in transit: the merged review after REG-1 (§16), the
design judge's objections after the ids in §15, and the four packages' own reviews.
Every one of them was re-read from its source file and checked against the merged tree
at 52171ca by five verifiers: **119 items checked — 60 already fixed by the build, 59
still there, 0 refuted.** The 59 went to four fixers by area (reply, baza, intake,
lenta and the rest), each in its own worktree, each fix red-proven by string edit and
restored by sha: **53 fixed, 6 refused with the reason written where the reader meets
it.** One defect not on any list was found while checking a premise. The four branches
were then picked onto one tree and the one seam between two of them fixed.

The ones a person would meet:

| Id | What changed |
|---|---|
| CONC-1 | The pass stands down when the request closes under it — at any step, not only before it starts. The request's clock is asked before every model step, so no paid call is made on a closed request, and `sayOnce(…, { whileOpen })` reads `completed_at` under the claim, so a VED's «Готово» landing mid-pass is never followed by the machine's reply. |
| CONC-2 | The brutto answer no longer outranks everything after it for good: `totalsAnswer.at` marks where it was typed, and `totalsDoubts` (calc-intake.ts) keeps it only while no LATER material states another figure for that field; a doubted answer is kept and the doubt said, so it lasts across re-reads. |
| CONC-3 / CONC-5 | A live ✨ claim or a person's save before the machine wrote anything is «a person is working» — the pass stands down instead of replying over half-typed numbers. |
| CONC-4 | A requester who can no longer log in still leaves the once-claim (a muted row), so a re-delivery does not answer twice. |
| perf-1 | The candidate scan computes `word_similarity` once per row (an inner select fenced by `OFFSET 0`): a 30k-row heading 3.4 → 2.2 s. |
| perf-2 | One heading timeout stands for every row of that heading, and the pick reads under the pass's deadline; rows the deadline left unread are COUNTED (`pastDeadline`) and said in the reply (the seam below). |
| perf-4 | A bounded per-process memo answers the import fill across saves (a READY batch's rows never change): the 30-row worst-case «Saqlash» 3.9 s once, then 26-43 ms (§14.6). |
| concurrency-10 | Deleting an import batch and a save pointing at its rows exclude each other (batch FOR UPDATE vs FOR KEY SHARE); a vanished row is a refusal in words, never a raw 23503. |
| extra (not listed) | A re-delivered import job wiped a READY quarter's rows before claiming the batch; the wipe now follows the claim. |
| law-money-8 / regression-20 | Every row exact with only the declaration fee refusing prints the old two lines, not a «10 tadan 10 qator» Aniq beside an absent Taxminiy. |
| regression-10 | What the AI pick did not do — capped, refused, overtaken by a person, timed out, past the deadline — is one line under the totals («⚠️ AI bazasini qo‘ymadi: … — VED to‘ldiradi»), no longer only a log line. |
| product-fit-9/11/12/13 | The legend says a 📥 baza is a guess until the VED confirms; the VED line says the 📊 median is «(AI emas)»; three refusal words a seller could not act on were reworded; the road lines are one renderer for both replies. |
| REG-3 / P3-R7 | A bare «777» with no collection gets its own sentence (not «your collection was lost»); «12 3500» answered to a one-unit question is asked again instead of dropping the 12. |
| concurrency-11 | A reading is billed on the Tashkent day the model answered it, and counted against the day's budget while the collection is still unlanded. |
| P4-1 | The tariff chip's priced anchor is pinned by a fixture that would show a widened match. |

**Refused, each with its reason at the place a reader meets it:** law-money-9 (the
country-word tier is his ⭐ 2.12 a in its own words — kept, the false positives it
admitted are anchored away by P1-R5); P2-NIT-6 and P2-NIT-7 (the chooser's FEW count
stays company-wide and a second file of one period is not «newer wins» — the
consequence and what he should do are in `docs/VED-IMPORT-AI.md` §2.3);
product-fit-16 (summing a per-line G.W. column would reverse his 2.7 b «brutto is
ASKED»); P3-6 and P3-R8 (the card-chat door's reading is not billed — owed to round 5
with the anchor migration, §12). CONC-6 is a statement, not a change: a pass killed by a
deploy re-delivers after up to 30 minutes and the seller then reads `PASS_FAILED`.

**The seam:** the baza fixer taught the pick to count `pastDeadline`, the reply fixer
taught the reply to print the pick's counts; neither saw the other, so a row the
deadline left unread mid-pick was said nowhere and looked like a row the file has no
answer for. `pickLeftOf` (ai-reply.ts) is the one mapping; red by dropping
`+ out.pastDeadline`.

**Then main moved** (the other session's Uch band, PRs #128-#130, migration 0136): it
was merged in before the push. Six conflicts, all two additions side by side; the one
with an order in it is the VED rota pick, now taken LAST in `openCalcRequest`'s
transaction, after Uch band's lead row lock and note insert — the order
`recalcFromSealed` already takes them in. Ledger after the deploy: **137**.
