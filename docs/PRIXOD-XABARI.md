# Prixod xabari — bitta xabar, ikki tugma; mijoz tasdig'ida kg va kub; AI xarajati kechki xulosada

His message of 2026-11-11, after confirming the 0144 deploy («deploy qildim 145 chiqdi»):

> 4 ha tovar nomi, karobka soni, ogirlik va hajimga urgu berilsin tekshirib olsin klient va tasdiqlasin
> togriligini.
> 8 ha
> prixod kelganda bitim tuzilmagan va prizod keldi deb 2 marta sms boryabti us yerga prixod keldi desin
> sotuvchiga klient karobka soni tovar nomlari kg kub shunda ikta button bolsin file qoshish va bitim
> biriktirish. agar file qoshishni bossa fillarni tashlasin boldi vahisobga tashlagandek boldi deb bosganda
> prixodga fillar biriktirilsin. bitim qoshishni bosganda usha us prixodni ichiga kirib bitim qayi
> bitimligini tanlash imkoni bolsin.
> qolgan savollaringa javob ozing bergan taklifing boyicha

…and, minutes later: «va mijozdan tasdix bosmasa xam skladga yuk kelgan zahoti borsin habar».

What that binds (the numbers are the eight questions sent with `docs/TARKIB-TAKLIFLAR.md`):

| | His words | Reading |
|---|---|---|
| R1 | «4 ha … og'irlik va hajmga urg'u berilsin, tekshirib olsin klient va tasdiqlasin» | Q4 = **b**: the client's ✅/❌ covers the goods name, the carton count, the WEIGHT and the VOLUME, and the question says so, loudly. A re-weigh after a ✅ makes it read «o'zgardi» (the consequence he was told with the question). |
| R2 | «8 ha» | Q8 = **b**: the day's AI spending is a line of the 20:00 evening summary. |
| R3 | «2 marta sms boryabti … prixod keldi desin sotuvchiga … ikta button» | ONE message to the seller per prixod — client, cartons, goods names, kg, kub — with «📎 Fayl qo'shish» and «🔗 Bitim biriktirish». |
| R4 | «fillarni tashlasin, boldi … bosganda prixodga fillar biriktirilsin» | «Fayl qo'shish» is a collection in the staff bot, like «Hisoblatish»: send files, press «✅ Bo'ldi», the files are on that prixod. |
| R5 | «usha prixodni ichiga kirib bitim … tanlash» | «Bitim biriktirish» opens that prixod in the system, at its deal picker. |
| R6 | «mijozdan tasdix bosmasa xam skladga yuk kelgan zahoti borsin» | The seller's message never waits for the client's ✅: the warehouse's confirm sends it (as today), and a test now says so. |
| R7 | «qolgan savollaringa … taklifing boyicha» | Q1, Q2, Q3, Q5, Q6, Q7 = ⭐ — checked against the shipped code and pinned (§D). |

Migration **0145** `prixod_xabari` (ledger 146). Sections: §A the client's confirmation, §B the summary's AI
line, §C the one message and its two buttons, §D the pins, §E deploy, §F stated-not-built and questions.

## §A. The client's ✅ / ❌ covers name, cartons, kg and m³ (R1)

Today (0144, `docs/TARKIB-TAKLIFLAR.md` §4) the answer is a snapshot of five things the question printed —
both name spellings, the carton count, the owner and the tarkib's goods (`goods_key`) — and kilos and cubic
metres are printed on the push but are «in no arm». His answer reverses that one sentence and nothing else.

### A.1 The scope of a question

A question has a SCOPE, and everything about it follows the scope — the lines it prints, the words of the
ask, the tag under its buttons, what the answer remembers and what the sentence compares:

- `basic` — name + cartons (+ a tarkib's goods). Every question sent before this release.
- `full` — the same, plus the lot's total weight and total volume. Every question sent from now on, on a
  server whose 0145 has landed (`lotClientMeasuresReady()`, the probe's third answer — §A.6).

One flag, never re-derived: `ClientAskFacts.scope`, minted by `clientAskFacts`.

### A.2 What the client reads

- The «yukingiz qabul qilindi» push already prints `📦 A · Klaviatura — 50 quti · 200 kg · 1.5 m³` and the
  total line. Under a `full` question its last line becomes (bold — «urg'u»):
  - uz «❓ Tovar nomi, quti soni, og‘irligi (kg) va hajmi (m³) to‘g‘rimi? Tekshirib, tasdiqlang.»
  - ru «❓ Название товара, количество коробок, вес (кг) и объём (м³) указаны верно? Проверьте и подтвердите.»
  - en «❓ Are the goods’ names, the box count, the weight (kg) and the volume (m³) correct? Please check and confirm.»
- «📨 Mijozdan so'rash» (`askText`) prints, per lot, its kilos and cubic metres on the lot's own line — a
  plain lot `📦 A · Klaviatura — 50 quti · 200 kg · 1.5 m³`, a tarkib lot `📦 A — 100 quti · 450 kg · 3.2 m³`
  followed by its goods and pieces as today — and a «Jami» line when the prixod has more than one lot
  (`totalLine`, the push's own). Its ask line, with goods listed: «❓ Tovarlar, ularning donasi, quti soni,
  og‘irligi (kg) va hajmi (m³) to‘g‘rimi? Tekshirib, tasdiqlang.» (ru / en alike).
- The ✅ toast: «Rahmat! Tovar nomi, quti soni, og‘irligi va hajmi tasdiqlandi ✅» for a `full` answer; the
  0144 words for a `basic` one (a press on an old message is thanked for what THAT message asked).
- The figures are the lot's `total_weight_kg` / `total_volume_m3` — what the push has always printed
  (`receivedFacts`), through the cabinet's own rounding (`kgText` / `m3Text`).

### A.3 What is remembered (0145)

`lot_client_confirms.shown_kg numeric(12,2)`, `shown_m3 numeric(12,3)` — the lot's two totals AT THE
PRECISION THE CUSTOMER READS THEM (kilos to two places, cubic metres to three — `roundKg` / `roundM3`'s
places), as they stood when the client answered a `full` question; NULL on a `basic` answer (every row
written before 0145, and every press on a button sent before it). A pair CHECK (both or neither), `>= 0`
and not NaN.

Rounded by the DATABASE — `round(total_weight_kg, 2)`, `round(total_volume_m3, 3)` — in the one statement
that reads the facts, and compared against the same two expressions (§A.5). Never a figure rounded in
JavaScript on one side and in SQL on the other: the two round a half differently, and a lot standing
exactly on one (100.005 kg) would hold a ✅ that could never match. What the message PRINTS still goes
through the cabinet's own `kgText` / `m3Text`; at such a half the printed figure and the remembered one can
differ by one unit of the last place (ten grams) — stated, harmless.

Why display precision and not the stored three and four places: the client confirmed «100 kg · 1.2 m³»,
and a correction that does not move what any list shows them has not unsettled what they said.

SQL-only columns (not on the drizzle table): the upsert stays the drizzle statement it is, and the two
figures are written by a raw `UPDATE` in the same transaction, under the same locks — only for a `full`
answer, which only a server with 0145 can be asked (§A.1). So the press itself names no new column on a
server one migration behind.

### A.4 The tag

`askTag(clientId, lots, scope)`: per lot `[lotId, zh, ru, count, goodsKey]` and, for `full`, the two
figures of §A.3 as the database's own text. `ClientAskFacts` carries `tag` (the scope's) and `basicTag`.

A press is judged against BOTH: `tag` → the answer of the question's own scope; `basicTag` (when the scope
is `full`) → a `basic` answer, measures not remembered. Anything else is «eskirgan». So no button a
customer already holds dies at the deploy, and a press on one means exactly what that message asked.

The push's text and the tag come from two reads (`receivedFacts`, `clientAskFacts`); `clientAskOffer`'s
«as printed» fence, which already ties them by name and count, compares the two totals too (the raw stored
figures of both reads) — a re-weigh landing between them costs the buttons, never records a ✅ for a
weight the client was not shown.

### A.5 The comparison

`clientHoldsSql` gains one term — `(shown_kg IS NULL OR (shown_kg = round(lot.total_weight_kg, 2) AND
shown_m3 = round(lot.total_volume_m3, 3)))` — on a server with 0145; the 0144 sentence word for word on one
without. Placed with the cheap terms, before the shown-name subquery.

- A `full` ✅ stops holding when the lot's weight or volume moves by something a list would show: the ✏️
  lot form (`editLot` — a manager may correct measures at any stage of the journey) and the office count
  doors that grow a lot or take the growth back (`growLotInTx` / `shrinkGrownInTx`). The lot then reads
  «o'zgardi» and is back on the ❓ worklist while it is askable — the consequence he was told. Back to the
  vouched figures = ✅ again by itself (a comparison, never a flag).
- Where it shows: the sentence's arms are in order, and a standing tarkib (arm 1) or a colleague's holding
  tick (arm 3) still vouches before the client's ✅ (arm 4) is asked — such a lot stays ✅ through a
  re-weigh, as today. (A tarkib already stops standing on a re-weigh by itself: its Σ kg / m³ must equal
  the lot's.)
- A `basic` ✅ (NULL) holds exactly as it did: it was asked about the name and the count.
- The ❌ arms do not change. A ❌ still ends four ways and no fifth; a re-weigh alone lifts nothing — a
  colleague ticks after it, the client is asked again and presses ✅, the rejected tarkib goods change, or
  «E'tirozni yopish».
- The colleague's own tick (`lot_checks`) is NOT touched: his answer is about what the client confirms.
- «Already» (`same(lot)` in `answerClientAsk`) compares the measures too, so a `full` ✅ pressed after a
  `basic` one is WRITTEN (it says more) and never answered «allaqachon».

KNOWN, pre-existing, stated: a lot weighed WHOLE (`dims_mode = 'mixed'`) that an office count grew and then
took back one carton per press can end a thousandth of a kilo or a ten-thousandth of a cubic metre away
from where it started (each press rounds the stored total — `grow-lot.ts`), and in some cases that moves
the printed figure. Such a lot's client ✅ reads «o'zgardi» after the walk, as its tarkib already does
today. The count kernel is not touched in this round.

### A.6 One migration behind

`lot-check-ready.ts`' one catalog statement gains a third answer — are `shown_kg` / `shown_m3` there (the
probe sees tables through `to_regclass`; a column needs `information_schema.columns`)?
`lotClientMeasuresReady()` is the sync read the sentence asks — every list reader already awaits the probe
before it builds a statement (`lot-check-wire.test.ts` fences that) — and `clientMeasuresReady()` is the
async probe-then-read the question's own doors ask themselves (`clientAskFacts`: a writer asks the probe,
never a flag another screen remembered — the as-built lesson of 0144).

«No» = scope `basic` everywhere: the 0144 question, the 0144 tag, the 0144 sentence. Nothing that is live
today is switched off by a 0145 that did not land.

Why a probe and not the house's `to_jsonb(row)->>'col'` idiom, which needs none: MEASURED (200,000
evaluations on a 0145 copy) — the comparison over the named columns costs 0.17 µs a row (45 ms against an
11 ms baseline), over `to_jsonb(lot_client)` 12.5 µs a row (2,500 ms). The sentence runs once per carton on
the stock table and the plan editor; once most cargo in China carries a client's answer that is a quarter
of a second on every render.

### A.7 Where people see it

- The prixod card (`lot-check-panel.tsx`, via `LotCheckView.client`): `measures: boolean` (the answer covered
  kg/m³) and `measuresMoved: boolean` (it did, and they no longer match). «✅ Mijozning o'zi Telegramda
  tasdiqladi» gains its scope — «(nom, quti soni, kg, kub)» / «(nom va quti soni)»; the «o'zgardi» line says
  «og'irlik yoki hajm o'zgardi» when that is what moved (the client's line names no term today).
- «📨 Mijozdan so'rash»'s hint (`lotCheck.askHint`, four bundles) ends «Og'irlik va hajm so'ralmaydi» today:
  it now says they ARE asked.
- The staff alert (`staffText`) and the History value (`shownLine`) print `· 200 kg · 1.5 m³` per lot of a
  `full` answer.
- `client-confirm-text.ts` now prints weights, so it joins the closed list of customer surfaces that must
  round through the cabinet's helpers (`tests/unit/client-push-text.test.ts`).

### A.8 Not changed, on purpose

No reminder, no automatic re-ask after a correction (stated in the last round; asked again in §F). The
Mini App shows nothing of it. A lot whose client pressed ✅ on a `basic` question is not re-asked.

## §B. The day's AI spending on the 20:00 summary (R2)

### B.1 What is recorded today

Three ledgers hold model usage, and one of them holds no tokens:

| Ledger | What it bills | Tokens | Dollars |
|---|---|---|---|
| `ai_calc_passes` | the AI VED's calls (`intake`, `grouping`, `pick`, `invoice`), «Oldingi narx»'s 🤖 (`similar`), the Bojxona 🤖 (`tnved`) and the tarkib's file reading (`tarkib`) | in / out + the model | frozen on the row (`cost_usd`) for the two PRESSED kinds only (0144) |
| `agent_runs` | every run of the AI sotuvchi | in / out / cache read / cache write + the model | none |
| `ai_questions` | the staff AI yordamchi (bot + `/ai`) | **none** — a count and the answer | none |

So a truthful «today's AI cost» is a sum over three places with three levels of knowledge, and the line
must say which part it could not price instead of printing a smaller number as if it were the bill.

### B.2 What this round adds

- `platform/ai/model.ts`: the price table gains the two CACHE rates per model (the published list,
  read 2026-11-11: a cache read at 0.1× and a 5-minute cache write at 1.25× the base input price for both
  models in use — the only duration the code writes, `cache_control: { type: 'ephemeral' }`), and
  `approxMicroUsd` prices all four token counts. Rows with no cache counts price exactly as before.
- `ai_questions` gets `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`
  (0145, SQL-only): the assistant's loop already receives each call's usage and now sums it; the settle
  writes it in a statement of its own, caught — a ledger that cannot be written must not cost the answer
  (`ai-cost.ts`'s rule), and a server one migration behind answers exactly as today.
- `wms/reports/ai-spend.ts` `aiSpend(from, to)` — ONE reader, three grouped statements (one per ledger),
  over the summary's own window (Tashkent days, the window every other figure of the message uses):
  per source the count of calls, the dollars of the priced ones and the count of calls that spent tokens
  under a model with no list price or that carry no tokens at all (an assistant question from before this
  release). `cost_usd` where a row has it (never re-priced), list price × tokens otherwise.
- `SummaryFacts.ai` and one line, after the leads line:
  «🤖 AI: ≈ $4.20 · 132 chaqiruv (hisob-kitob $2.10 · sotuvchi $1.70 · yordamchi $0.40)» and, when some
  calls could not be priced, «   ⚠ 12 ta chaqiruv narxi noma’lum — jamiga kirmagan». No calls → no line.
  On Mondays it is the closed week's, like every other figure.
- It does not make a quiet day loud: `summaryQuiet` is not taught about it (a day on which nothing moved
  but the machine answered three questions is still a quiet day).

### B.3 Who reads it

The summary is composed only behind `ownerSummarySight` (the company's money), for the people who receive
it today; AI spending is company money and reaches nobody new. The Bojxona tab and Sozlamalar keep their
own counts (`pressToday`) unchanged.

### B.4 What the number is, said once

List prices of ANSWERED calls, as the Bojxona line already says («≈»): not an attempt the SDK retried, not
a call that timed out after the provider had worked on it (the two pressed kinds count those, the others
do not record them), not any discount on the account. The real bill is the provider's console.

## §C. One message to the seller per prixod, with two buttons (R3-R6)

### C.1 Today

A prixod of a known client is confirmed → `confirmReceipt` emits, in its transaction:

1. `ReceiptConfirmed` (payload: the lots, `dealLinked`, `openDealCodes`) → `buildRecipients` → the client's
   sales manager: «📥 Prixod N / Mijoz / [📎 Bitimga biriktirilmagan — biriktirib qo‘ying | ⚠️ Bitimi yo‘q —
   narxlatib qo‘ying] / Sklad / the lots / link». Mute group `operations`.
2. `priceControlOnReceipt` → `UnlinkedCargo` (not linked, the client has an attachable open deal) or
   `UnquotedCargo` (not linked and none; or linked to a deal with NO price) → the same sales manager, or —
   when the client has none — the admins. A second message: «📎 Yuk bitimga biriktirilmagan — N …» /
   «💰❓ Narxi kelishilmagan yuk — N …». Mute group `alerts`. Or `DealDeviation` → the deal's owner.

So the seller of a client with no deal on the prixod is told twice — his complaint — and so is the seller
of a prixod linked to an unpriced deal.

### C.2 The deal state, decided once

`receiptDealState` (wms/deals, on the confirm's own transaction handle), from the client, the prixod's deal
and the open-deal codes the confirm already reads:

| state | means | the line in the message |
|---|---|---|
| `none` | no deal on the prixod, and the client has no attachable open deal | «⚠️ Bitimi yo‘q — narxlatib qo‘ying» |
| `attachable` | no deal on the prixod; the client has open deals worth attaching to | «📎 Bitimga biriktirilmagan. Ochiq bitimlar: B-00012, B-00015» |
| `unpriced` | on a deal that carries no price | «💰 B-00012 bitimida narx yo‘q — yuk Xitoyda turganida narx qo‘ying» |
| `priced` | on a priced deal | — (nothing) |

ONE decision, two consumers: the `ReceiptConfirmed` payload carries `dealState` (+ `dealCode`), and
`priceControlOnReceipt` is HANDED the state instead of deriving it again — its three branches (attach /
price / compare) follow it. The two cannot disagree, which is what makes the fold below safe.

`assignReceiptClient` (unclaimed cargo given its owner) emits `ReceiptConfirmed` too: it carries the state
the same way (it has never run price control, and still does not).

### C.3 The fold

- The alert events are STILL EMITTED, exactly as today plus `folded: true` in their payload — both are
  offered automation-rule triggers (`RULE_EVENTS`, `platform/automation/service.ts`), the rules hear the
  EVENT and not the notification rows, and a rule the owner wrote on «narxsiz yuk» must keep firing. The
  six `deals.integration` tests that read the `events` table stay as they are.
- `buildRecipients`:
  - `UnlinkedCargo` / `UnquotedCargo` with `folded: true` → no rows. Without the flag — an event written
    before this release and still queued — as today (and its render case stays, for the same rows).
  - `ReceiptConfirmed` with a `dealState`:
    - the client has a sales manager WHO CAN LOG IN → ONE row for them, `type: 'ReceiptConfirmed'`, and
      when the state is not `priced` also `alsoType: <the alert's type>`;
    - no such person, and the state is not `priced` → the admins and super-admins, `type: <the alert's
      type>` — exactly who hears the alert for a seller-less client today, under the mute that governs it
      today;
    - no such person and `priced` → nobody (as today).
  - `ReceiptConfirmed` without a `dealState` (an old event) → as today.
- A seller who can no longer log in counts as no seller for the fallback. Today their client's alert is
  written for them and settled `muted / user deactivated` at send, so no admin hears a deal-less prixod —
  the silent loss the fallback's own comment says it exists to prevent. (The plain `priced` prixod of such a
  client still goes to nobody, as it does today.)
- **Mutes** (`processEventBatch`, where a mute is read — once, when the row is written): a recipient with
  `alsoType` is muted only when the person muted BOTH types, and the row is written under the type they
  have NOT muted (`ReceiptConfirmed` when both are open). So nobody loses what they hear today: who ticked
  «Operatsiya xabarlari» but kept «Ogohlantirishlar» still hears the prixod that has a deal problem (typed
  as the alarm it is); who ticked «Ogohlantirishlar» still hears every prixod. No type is added, moved or
  made a founder — `mutes.ts` is not touched.
- `DealDeviation` is not folded: it is about the DEAL's totals against its quote, goes to the deal's owner
  (who may be somebody else) and carries numbers the prixod message does not. Stated in §F.
- The event drain stays the sender (nothing is written in `confirmReceipt`'s transaction or right after
  it): the suite's footprint does not move, and R6 is true by construction — the drain is kicked by the
  receive action itself.

### C.4 The message

Rendered by ONE function for `ReceiptConfirmed` and for a row typed as its alert (the payload is the same:
it has `lots` and `dealState` — an alert row WITHOUT `lots` is a pre-release one and renders as it did):

```
📥 Prixod keldi — YW-000123
Mijoz: GS777 (Ali Valiyev)
Sklad: YW

A — 键盘 (Klaviatura): 50 kor., 200 kg, 1.5 m³
B — 鼠标 (Sichqoncha): 50 kor., 100 kg, 0.8 m³
Jami: 100 kor. · 300 kg · 2.3 m³

⚠️ Bitimi yo‘q — narxlatib qo‘ying

https://…/receipts/<id>#bitim          ← lifted into the URL button by the drain
```

- «Prixod keldi» (ru «Приход поступил», zh «货物已入库», en «Receipt arrived») — his words. An event without
  `dealState` keeps the old header and body exactly (#688's rule; `receipt-deal-marker.test.ts` and
  `locales.test.ts` render such payloads).
- «Jami» only when the prixod has more than one lot, summed and ROUNDED (kilos to two places, cubic metres
  to three, as the lines print) — the alert's own totals are raw float sums today («12.450000000000001
  kg»), and the new line must not inherit that.
- At most 12 lot lines, then «… yana N ta».
- Buttons (the drain, at send time):
  - row 1 — «📎 Fayl qo‘shish», callback `pf:<receiptId>` — `buttonsFor`, on every `ReceiptConfirmed` row
    and every folded-state alert row whose `receiptId` is a uuid (drawn only for an id the parser will
    accept — an unparsed callback is answered by nobody, #939). An Uzbek literal, like every other callback
    button of the staff bot.
  - row 2 — the card link the drain already lifts off the foot of the text (`takeOwnLink`): its label is
    «🔗 Bitim biriktirish» (ru «🔗 Привязать сделку», zh «🔗 关联交易», en «🔗 Attach deal») and it points at
    `/receipts/<id>#bitim` when the state is `none` or `attachable`; «↗️ Ochish» → `/receipts/<id>`
    otherwise. One label chosen in `composeStaffMessage`, where the existing one is; the lift's https
    guard and its «a refused button puts the link back into the text» fallback are unchanged, so on a
    non-https `APP_URL` (CI) the link simply stays in the text.
- R6: the row is written by the event drain within the minute of the warehouse's confirm. Nothing in this
  path reads `lot_client_confirms`; a test confirms a prixod, runs the drain and finds the seller's pending
  row while no client has answered anything.

The callback's four homes (each fenced): a `BotCallback` member, its `PRESS_REPEAT` class, a
`parseCallback` branch (`pf:<uuid>` and `pf:ok`), and a dispatcher branch above the approval guard;
`receipt-files.ts` joins the file list `topshiriq-buttons.test.ts` scans for `callback_data` literals.

### C.5 «📎 Fayl qo‘shish» — the collection

`platform/telegram/receipt-files.ts` (state + words, a leaf) and a thin branch in `staff-handlers.ts`;
the door and the audit live in wms (`wms/receipts/files-door.ts`), reached by dynamic import.

**The files are attached AS THEY ARRIVE** — `saveBotFile` with `entityType: 'receipt'`, `entityId` = the
prixod, the uploader = the staff member — and «✅ Bo‘ldi» only closes the collection and says how many. He
asked for «Bo‘ldi bosganda biriktirilsin»; binding on arrival gives him that and one thing more: a restart,
a timeout or a forgotten «Bo‘ldi» loses NOTHING — the files are already on the prixod, where the card's
«Fayllar» panel and the tarkib's «🤖 Fayldan to‘ldirish» find them with no further change. (The other
shape — hold the files aside, bind them at «Bo‘ldi» — needs a cleanup for every abandoned collection and
loses the seller's forwards on a deploy.)

- **State**: one durable wait per chat, kind `receipt_files` (`telegram_chat_waits`, widened by 0145):
  `{ receiptId, number, clientCode, count }`, 30 minutes, re-armed by every file. Memory is the reader, the
  table survives a deploy (`waits.ts`'s own rule), so a collection opened before a restart still takes the
  files sent during it (a backlog file dated inside the wait's window answers it — `waitVerdict`).
- **Open** — the press on `pf:<receiptId>`:
  1. the chat is a linked staff member's (`botActorFor`), or «Ulanmagan»;
  2. another collector holds the chat — a «Hisoblatish» collection that holds, a task draft, a zametka
     capture — → refused in words (its own sentence), nothing opened;
  3. the door (§C.6), asked NOW — the button may be days old;
  4. the wait is armed and the bot says: «📎 Prixod YW-000123 (GS777). Fayllarni shu yerga yuboring yoki
     forward qiling — rasm, PDF, Excel. Tugagach «✅ Bo‘ldi» ni bosing.» with `[✅ Bo‘ldi]` (`pf:ok`).
  A press while a collection for ANOTHER prixod is open closes that one (its count is said) and opens this.
- **A file** (`message:photo` / `message:document`, the collector's own two kinds):
  - taken by this collection only when nothing above it takes it: a holding «Hisoblatish» collection, a
    zametka capture and a live task draft each keep their file (ours is the lowest collector: it holds no
    unsaved work, so it yields and is closed without a word); it is asked BEFORE the task door's «forward →
    topshiriq?» offer and before the burst door;
  - the door is asked again (a prixod voided mid-collection takes nothing more);
  - stored under an id derived from (prixod, chat, message) — a redelivered update finds its row and
    stores nothing twice;
  - a refusal is said in words, and names its reason (past Telegram's 20 MB, a type storage does not keep,
    a failed download — `BotFileRefusal`'s four);
  - at most 30 files a collection;
  - acknowledged ONCE per burst (an album of ten is one line, 1.2 s after its last part): «📎 YW-000123:
    3 ta fayl biriktirildi. Yana yuboring yoki «✅ Bo‘ldi».» with the button; the previous acknowledgement
    loses its button.
  - each stored file writes one audit row on the prixod (`after: { file: 'invoice.pdf · Telegram' }`), so
    the History says who added what — and the History's own grouping folds a burst into one entry.
- **Text** is not this collection's: it goes down the ladder as if the collection were not there.
- **«✅ Bo‘ldi»** (`pf:ok`): the wait is dropped; «✅ 3 ta fayl prixod YW-000123 ga biriktirildi.» with an
  «↗️ Prixodni ochish» URL button — or «Fayl qo‘shilmadi.» for none. No live collection → the toast
  «Yig‘ish allaqachon tugagan».
- **Thirty quiet minutes** end it silently (the files are attached).

### C.6 Who may add files to a prixod from the bot

`receiptFilesDoor(actor, receiptId)` (wms) — asked at the press and again at every file:

1. the prixod exists, is `confirmed` and not voided;
2. the person may open it — `mayReadReceipt`, the receipt card's own read door.

That is EXACTLY what the web's upload route asks for a prixod's file today (`/api/files/upload`: «a receipt
that exists asks the receipt card's own read door»), so the bot opens nothing the web has not already
opened — it only puts a button where the seller is. A seller is not warehouse-scoped and passes; a scoped
operator passes for their own warehouse's prixod or cargo standing where they are.

Refusals, each a sentence: «Bu prixod topilmadi», «Bu prixod bekor qilingan — fayl qo‘shib bo‘lmaydi»,
«Bu prixodni ochishga huquqingiz yo‘q».

Removing a wrong file stays the web's rule (`deleteAttachment`: the uploader, or `receipts.edit`); the
card draws its ✕ only for `receipts.edit` today, so in practice the logist removes it — stated in §F.

### C.7 «🔗 Bitim biriktirish» — the prixod card

- The `DealLink` block gets `id="bitim"` (with a scroll margin for the sticky bar) and a `:target` ring, so
  the button lands on the picker, not on the top of a long card.
- The picker today offers the client's open deals. When there are none and the prixod has no deal, the
  block says so and links «+ Yangi bitim ochish» → `/bitimlar/new?client=<id>` (the deal form with the
  client preset; the new deal's own card then offers this prixod in its «Prixod biriktirish» picker).
- Who sees the block is unchanged (`canWriteDeal` — a seller holds it).

## §D. The six ⭐ answers (R7)

«qolgan savollaringa javob ozing bergan taklifing boyicha» — each checked against the SHIPPED code before
it is called answered (#1229), and pinned by a test that names it where only reading proved it:

| Q | ⭐ | Where it lives |
|---|---|---|
| 1 | the ✅/❌ row rides the «qabul qilindi» push by itself | `client_confirm_on_receipt` ships `true`; `clientAskOffer` |
| 2 | the client's ❌ outranks a colleague's ✅ | `lotCheckStateSql` arm 3 |
| 3 | a ❌ is told to the client's seller, the logists and the admins | `answerClientAsk` (`alarmed`) |
| 5 | one ❌ is written on every lot of the message | `answerClientAsk`'s one upsert over `facts.lots` |
| 6 | a Chinese name on the paper gets the AI's Russian name | `tarkib-proposal.ts` |
| 7 | 300 Bojxona 🤖 presses and 50 file readings a day | the two settings' defaults |

## §E. Migration 0145 and the deploy

`0145_prixod_xabari.sql`, `when` …124, ledger **146**. Additive only:

1. `lot_client_confirms` + `shown_kg numeric(12,3)`, `shown_m3 numeric(12,4)` and their pair / range CHECK.
2. `ai_questions` + `model text`, four token counters (integer, default 0, `>= 0`).
3. `telegram_chat_waits_kind_check` re-made wider: every kind it holds today plus `receipt_files`.

Every new column is SQL-only on its drizzle table; every reader of one asks a probe or catches, so the code
of this release runs on a 145 schema exactly as the previous release did (#472).

The staff bot must be restarted with the app (it is the same container) — the new callback `pf:` is
parsed by the new code only; a press on a new button reaching an OLD bot is answered by nobody, which is
why the buttons are drawn by the same deploy that parses them. No listener change (`tg-listen` untouched).

Deploy check: the count (146) and `/api/version`.

## §F. Stated, not built — and the questions that go to him

Stated:

- `DealDeviation` («yuk hisob-kitobga to‘g‘ri kelmadi») stays its own message: it is about the deal's
  totals, goes to the deal's owner and carries numbers the prixod message does not.
- A file added through the bot is removed on the web by whoever may edit the prixod (the logist); the
  seller's card has no ✕.
- «Fayl qo‘shish» takes photos and documents (what «Hisoblatish» takes); a video or a voice note is
  answered in words and not stored.
- Text typed during a file collection is not stored on the prixod.
- A `basic` ✅ given before this release keeps vouching for the name and the count; it is not re-asked.
- The AI line is list prices of answered calls; assistant questions asked before this release have no
  tokens and are counted as «narxi noma’lum» until they age out of the window.

Questions (⭐ = built):

1. Qayta tortilganda (kg/kub o‘zgarganda) mijozga savol o‘zi qayta borsinmi? ⭐ a) yo‘q — lot «o‘zgardi»
   bo‘lib ❓ ro‘yxatiga tushadi, xodim «Mijozdan so‘rash»ni bosadi · b) ha, o‘zi qayta so‘rasin.
2. Xodim qo‘ygan ✅ ham kg/kub o‘zgarsa «o‘zgardi» bo‘lsinmi? ⭐ a) yo‘q, faqat mijozning Telegram tasdig‘i ·
   b) ha.
3. Sotuvchi prixod kartasida (saytda) ham fayl qo‘sha olsin va o‘zi qo‘shganini o‘chira olsinmi? ⭐ a)
   hozircha faqat bot orqali qo‘shadi · b) ha, saytda ham.
4. Fayl qo‘shilganda logist/VED ga xabar borsinmi? ⭐ a) yo‘q, kartada va tarixda ko‘rinadi · b) ha.
5. «Narxi kelishilmagan / bitimga biriktirilmagan» ogohlantirishi endi «Prixod keldi» xabarining ichida.
   Bitim narxdan oshib ketganda keladigan alohida xabar («Yuk hisob-kitobga to‘g‘ri kelmadi») ham shu
   xabarga qo‘shilsinmi? ⭐ a) yo‘q, alohida qolsin · b) ha.
