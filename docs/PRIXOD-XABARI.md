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

Migration **0146** `prixod_xabari` (ledger 147; minted as 0145 — see §E). Sections: §A the client's confirmation, §B the summary's AI
line, §C the one message and its two buttons, §D the pins, §E deploy, §F stated-not-built and questions,
**§G as built — BINDING**.

§A-§C below are the design as it went to its three judges (confirm / fold + summary / collector: 9 + 13 + 13
objections, none refuted). **Where §G says otherwise, §G is what the code does** — it lists every change the
judges and the build made, section by section.

## §A. The client's ✅ / ❌ covers name, cartons, kg and m³ (R1)

Today (0144, `docs/TARKIB-TAKLIFLAR.md` §4) the answer is a snapshot of five things the question printed —
both name spellings, the carton count, the owner and the tarkib's goods (`goods_key`) — and kilos and cubic
metres are printed on the push but are «in no arm». His answer reverses that one sentence and nothing else.

### A.1 The scope of a question

A question has a SCOPE, and everything about it follows the scope — the lines it prints, the words of the
ask, the tag under its buttons, what the answer remembers and what the sentence compares:

- `basic` — name + cartons (+ a tarkib's goods). Every question sent before this release.
- `full` — the same, plus the lot's total weight and total volume. Every question sent from now on, on a
  server whose 0146 has landed (`lotClientMeasuresReady()`, the probe's third answer — §A.6).

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

### A.3 What is remembered (0146)

`lot_client_confirms.shown_kg numeric(12,2)`, `shown_m3 numeric(12,3)` — the lot's two totals AT THE
PRECISION THE CUSTOMER READS THEM (kilos to two places, cubic metres to three — `roundKg` / `roundM3`'s
places), as they stood when the client answered a `full` question; NULL on a `basic` answer (every row
written before 0146, and every press on a button sent before it). A pair CHECK (both or neither), `>= 0`
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
answer, which only a server with 0146 can be asked (§A.1). So the press itself names no new column on a
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
shown_m3 = round(lot.total_volume_m3, 3)))` — on a server with 0146; the 0144 sentence word for word on one
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
  **Superseded 2026-11-13 by his «2 b»** (`docs/PRIXOD-JAVOBLAR.md` §2, §8): the tick remembers kg/m³ too
  (0147) and stops vouching on a re-weigh; a ❌ it had answered is still not brought back.
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
today is switched off by a 0146 that did not land.

Why a probe and not the house's `to_jsonb(row)->>'col'` idiom, which needs none: MEASURED (200,000
evaluations on a 0146 copy) — the comparison over the named columns costs 0.17 µs a row (45 ms against an
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
  (0146, SQL-only): the assistant's loop already receives each call's usage and now sums it; the settle
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

- **State**: one durable wait per chat, kind `receipt_files` (`telegram_chat_waits`, widened by 0146):
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

- The `DealLink` block gets `id="bitim"` (with a scroll margin for the sticky bar) and a `:target` frame (a
  ring as first built, an outline since the merge with the card round — §G.H), so the button lands on the
  picker, not on the top of a long card.
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

## §E. Migration 0146 and the deploy

`0146_prixod_xabari.sql`, `when` …125, ledger **147**. Minted as 0145 (`when` …124) and renumbered on the
merge with main, whose AI-sotuvchi «o‘zi yuborish» round (PR #147, `0145_agent_auto`) took that number and
that `when` first — every «0146» in this document read «0145» until then. Additive only:

1. `lot_client_confirms` + `shown_kg numeric(12,2)`, `shown_m3 numeric(12,3)` — the precision a customer
   reads (§A.3) — and their pair / range CHECK.
2. `ai_questions` + `model text`, four token counters (integer, default 0, `>= 0`).
3. `telegram_chat_waits_kind_check` re-made wider: every kind it holds today plus `receipt_files`.

Every new column is SQL-only on its drizzle table; every reader of one asks a probe or catches, so the code
of this release runs on a 145 schema exactly as the previous release did (#472).

The staff bot must be restarted with the app (it is the same container) — the new callback `pf:` is
parsed by the new code only; a press on a new button reaching an OLD bot is answered by nobody, which is
why the buttons are drawn by the same deploy that parses them. No listener change (`tg-listen` untouched).

Deploy check: the count (147) and `/api/version`.

## §F. Stated, not built — and the questions that go to him

Stated:

- `DealDeviation` («yuk hisob-kitobga to‘g‘ri kelmadi») stays its own message: it is about the deal's
  totals, goes to the deal's owner and carries numbers the prixod message does not. So does `ArrivalDiff`
  (the prixod answered a promise and came out different) — it goes to the promise's author, who is usually
  the same seller: a second message about one prixod that this round does not fold.
- The seller's message goes to the CLIENT's seller (and, where nobody is there to hear a deal problem, the
  admins). The claim door — unclaimed cargo given its owner — tells the new owner's seller alone and alarms
  nobody, as it always did.
- «📎 Fayl qo‘shish» stores photos and files (a video sent as a FILE and a GIF are files and are stored); a
  video, a voice note, a sticker or a place is answered in words and not stored. A typed text is answered in
  words too, and is not sent to the paid assistant while a collection is live. A caption under a file is not
  kept.
- A picture sent through the bot is stored as a FILE on the prixod, never as one of its photos: it is a
  paper. It opens from the «Fayllar» panel like a PDF, and the tarkib's «🤖 Fayldan to‘ldirish» reads it.
- A file sent as a REPLY to the «Prixod keldi» message, without pressing the button first, is not attached
  (the bot answers nothing about it) — the button is the door. With a collection OPEN, a file that
  swipe-replies to another of the bot's messages is not the collection's either, and is told so (§G.G).
- Every file is downloaded on the bot's one sequential poller, as «Hisoblatish» files are: an album of
  thirty holds every customer's cabinet for the sum of its downloads.
- «🔗 Bitim biriktirish» opened in a browser with no session (Telegram's own, the first time) lands on the
  login page and then on Home — the address is not carried through a login. True of every «↗️ Ochish»
  today; the second press works.
- A `basic` ✅ given before this release keeps vouching for the name and the count; it is not re-asked.
- The AI line is list prices, «≈», and is on no screen — the summary is its one place. It does not include
  the deal card's goods-file import (its AI grouping writes no usage row) or an AI-sotuvchi run whose chat
  was purged afterwards.
- Uploads on the SITE still write no History line (`saveAttachment` never has) — «no line» does not mean
  «nobody added it»; only files sent through the bot are named there. (A REMOVED file is named whichever
  way it came — §G.G.)
- `linkReceipt` — and so the card's picker and the new-deal form — asks no READ door of the prixod. It is
  unreachable today: no warehouse-scoped role holds `crm.leads` or `clients.manage`. A scoped role given
  `crm.leads` on /admin/roles could file a prixod it cannot open, and would be sent to a card that refuses
  it. Named by the as-built review; not changed in this round.
- The verifiers of the as-built review confirmed every finding it called a defect (RF-1, RF-2, CARD-1,
  CARD-2, CARD-3, CA-1) by reading the frozen tree; the nits were not sent to a verifier — each was
  reproduced as a failing test before its fix instead.

Questions (⭐ = built):

1. Qayta tortilganda (kg/kub o‘zgarganda) mijozga savol o‘zi qayta borsinmi? ⭐ a) yo‘q — lot «o‘zgardi»
   bo‘lib ❓ ro‘yxatiga tushadi, xodim «Mijozdan so‘rash»ni bosadi · b) ha, o‘zi qayta so‘rasin.
2. Xodim qo‘ygan ✅ (yoki yozilgan tarkib) ham kg/kub o‘zgarsa «o‘zgardi» bo‘lsinmi? ⭐ a) yo‘q, faqat
   mijozning Telegram tasdig‘i · b) ha.
3. Yuk Xitoydan chiqib ketgandan KEYIN (yo‘lda yoki O‘zbekistonda) qayta tortilsa, mijozning ✅ belgisi
   ham olib tashlansinmi? U paytda mijozdan qayta so‘rab bo‘lmaydi (tugma faqat yuk Xitoyda turganda bor).
   ⭐ a) ha, olib tashlansin — tasdiq aynan o‘sha og‘irlikka berilgan · b) yo‘q, kg/kub faqat yuk Xitoyda
   turganida solishtirilsin.
4. Sotuvchi prixod kartasida (saytda) ham fayl QO‘SHA olsinmi? (O‘zi bot orqali yuborganini kartadan
   o‘chira oladi — bu qurildi.) ⭐ a) hozircha faqat bot orqali · b) ha, saytda ham.
5. Fayl qo‘shilganda logist/VED ga xabar borsinmi? ⭐ a) yo‘q, kartada va tarixda ko‘rinadi · b) ha.
6. «Yuk hisob-kitobga to‘g‘ri kelmadi» (bitim narxidan oshib ketganda) va «va’da qilingandan farq qildi»
   xabarlari ham «Prixod keldi» xabariga qo‘shilsinmi? ⭐ a) yo‘q, alohida qolsin · b) ha.
7. Egasiz yuk mijozga biriktirilganda (sotuvchisi yo‘q mijoz bo‘lsa) adminlarga xabar borsinmi? ⭐ a) yo‘q,
   hozirgidek hech kimga · b) ha.

## §G. As built — BINDING (overrides §A-§C where they differ)

### G.A The client's confirmation

- **A narrower answer never replaces a wider one of the same verdict.** `answerClientAsk`: a `basic` ✅ (a
  press on a message sent before 0146 — only the PRESSED message ever loses its buttons, so those stay live
  for ever) on a lot whose row is this owner's ✅ WITH measures is not written (`keeps`) and answers
  «allaqachon»; the lot then still reads «o‘zgardi» after a re-weigh. `same()` compares the measures only
  when the press is `full`. A ❌ is always written.
- **On a 0146 server the two columns are written for EVERY answer** — the figures for `full`, NULL for
  `basic` — by the raw `UPDATE` in the same transaction (`measuresHere`). So a `basic` ❌ over a `full` ✅
  takes the kilos away with the answer that held them. (§A.3's «only for a full answer» is superseded.)
- **`recorded` carries the ANSWER's scope**, and the toast, the staff alert and the History line read it —
  never `facts.scope`. A `basic` answer on a 0146 server is said in words: «bu javob faqat tovar nomi va quti
  soniga tegishli — og‘irlik va hajm so‘ralmagan».
- **The probe's early return is all three flags** (`ready && clientReady && measuresReady`), and the third
  answer is read off `pg_attribute` (0.36 ms warm against `information_schema.columns`' 2.8 ms; it runs on
  every reader call of a server behind). With the first two alone, a process that had seen 0144 and not 0146
  never asked again: a repaired migration switched nothing on until a restart, with the ledger and the build
  stamp both right. Pinned by `tests/unit/lot-check-ready.test.ts` (a faked `db.execute`) and the reader
  fence in `client-confirm-wire.test.ts` (the columns are named in four files; the remembered flag is read
  by the sentence and the card only; the writer asks `clientMeasuresReady()` itself).
- **A full question never goes out without its words.** The «qabul qilindi» push with a photograph carries
  its text as the caption; when the caption cannot hold the (longer) ask line, the photograph YIELDS and the
  message goes as text, question and buttons together (`arrival-jobs.ts`). For a `basic` question the 0144
  rule stands.
- **`measuresMoved` is true only while the five 0144 facts still hold** (`clientFactsHoldSql`): the card
  names the weight or the volume only when THEY are what moved.
- **The card's words** (`lotCheck.*`, four bundles): `clientYesFull` («… — nomi, quti soni, og‘irligi va
  hajmi»), `clientYesBasicNote` under an answer that did not cover them, `clientStaleMeasures` /
  `clientYesOldMeasures` («… og‘irlik yoki hajm o‘zgardi»), `askHintFull` beside «📨 Mijozdan so‘rash»
  (`clientAskCardFor` returns `full`).
- **§A.5's «back on the ❓ worklist while it is askable»** means: while a carton stands on a Chinese shelf.
  Off it, a re-weigh still removes the client's ✅ from the lists and there is no door to ask again — stated,
  and asked of him (§F question 3).

### G.B The summary's AI line

- **The window is the LAST 24 HOURS** on the daily message and on the pull («📊 Holat»), read to the moment
  of reading; the Monday message reads the closed week, whole Tashkent days (`aiSpendWindow`) — and, since
  the as-built review, carries the last 24 hours on a second line (§G.G). A
  Tashkent-day window was the design, and it would never have shown 20:00-24:00 in any daily message — the
  hours the AI sotuvchi answers customers in. Label: «🤖 AI (oxirgi 24 soat): …» / «🤖 AI (hafta): …».
- **«Murojaat» is defined per ledger** (`ai-spend.ts`'s header): a calc row = one answered model call or one
  settled press (`ok` / `failed`; never `reserved` / `no_answer`); an agent RUN that spent tokens, or one
  that ended `error` with none recorded (it may have reached the model — counted, unpriced; `refused`,
  `notice`, `capped`, `stood_down` and `reserved` never called anything); an assistant QUESTION with tokens,
  or an answer with none (asked before 0146).
- **Unpriced** = no list price for its model, or usage never recorded — counted and said, never a $0. A
  settled press with neither a frozen cost nor tokens is a request with nothing to price (`pressToday`'s own
  reading, so the Bojxona tab and the summary agree about one press).
- **The line** (`aiLine`): `≈ $4.20 · 132 murojaat`; `(5 tasining narxi noma’lum)` beside the count;
  **no dollar figure at all** when nothing could be priced; a ledger that could not be read is NAMED (`⚠
  o‘qilmadi: sotuvchi AI`); no request and nothing unread → no line. It does not make a quiet business day
  «not quiet» (`summaryQuiet` is unchanged).
- **The assistant records its own usage**: summed over a question's rounds and written by a SECOND, caught
  `UPDATE` (the answer is already the person's when it runs; a server one migration behind refuses it and
  the question still succeeds).
- **The price map carries the cache's two prices** (`cacheRead`, `cacheWrite`) — the agent ledger's tokens
  are mostly cached context.

### G.C One message, two buttons

- **The deal state has one home, `wms/receipts/deal-state.ts` `receiptDealInTx`**, asked by BOTH doors (the
  confirm and the claim) on their own transaction, and «the prixod's deal» is `ownDealOf`'s: a deal of
  another client — left by a client correction, posted by a stale form — is no deal here, is never named to
  this client's seller and is never compared against (price control is HANDED `{ state, dealId }`).
- **ONE predicate says «this row is the new message»**: `isReceiptArrival(type, payload)` = one of the three
  types AND `payload.dealState` is one of the four strings (`platform/notifications/receipt-arrival.ts`, a
  leaf). The recipients, the renderer, the open button's label and `buttonsFor` all ask it. `folded` lives on
  the alert EVENT only and is an ARGUMENT of `priceControlOnReceipt` (default false): only the caller knows
  it wrote the `ReceiptConfirmed` that carries the alarm. The «alert row without `lots`» sentence of §C.4 is
  withdrawn.
- **The claim door** (`assignReceiptClient`) carries `via: 'assign'`: its own header — «📥 Prixod mijozga
  biriktirildi — N», never «keldi» —, the deal line, the two buttons, and **recipients as before: the new
  owner's seller alone**. `arrivalAlertOf` returns null for it: it has never run price control, emits no
  alert event, and must not start alarming the admins about cargo that came weeks ago.
- **Recipients on the confirm door** (`buildRecipients`): the seller gets ONE row (`ReceiptConfirmed`,
  `alsoType` = the state's alarm when not `priced`). The admins hear the deal problem — typed as the alarm,
  with the client's code and name on their copy — when nobody is there to hear it: no seller, one who can no
  longer log in, or one with no linked staff chat (`reachOf(...) === 'no_chat'`; the seller's own row is
  still written). A MUTE is the person's own choice and never falls back.
- **The mute rule** is `rowTypeFor` (exported, the one place a mute is read when a row is born): silenced
  only by somebody who muted BOTH types; written under the type they still hear; the in-app row and the
  Telegram row carry the same type.
- **The message** (`receiptArrivalText`): header · «Mijoz: CODE (Name)» · the deal line · «Sklad» · blank ·
  one line per lot, kilos to two places and cubic metres to three (what the customer's push prints) · at most
  12 lots, then «… yana N ta» · «Jami» for more than one lot = the printed lines' own sum (`arrivalTotals`,
  `sumRounded`) · blank · the card link alone on the last line. The `none` line reads «⚠️ Narxlangan bitimi
  yo‘q — narxlatib qo‘ying» (a client made since round 111 always has an EMPTY deal, which the card's picker
  offers); `unpriced` reads «💰 B-… bitimida narx yo‘q — narx qo‘ying» (no «Xitoyda turganida»: the claim
  door's cargo may be anywhere); `priced` prints «🔗 Bitim: B-…». The event's payload carries the three
  totals too.
- **Buttons**: «📎 Fayl qo‘shish» (`pf:<receipt>`, lowercased — the one shape the parser takes) on every new
  row under any of its three types; the lifted card link is «🔗 Bitim biriktirish» → `/receipts/<id>#bitim`
  for `none` / `attachable`, «↗️ Ochish» → `/receipts/<id>` otherwise. A prixod message written before the
  fold keeps the keyboard it never had.

### G.D «📎 Fayl qo‘shish»

- **A collection never ends in silence** (the judge's blocker). Thirty quiet minutes, or another collector
  opening («Hisoblatish», a task draft, a zametka — `closeReceiptFiles` beside each of the three
  `endBurst(chatId)` lines), CLOSE it; the closed entry stays, and the first file that meets it is told once
  — «⌛ Prixod N uchun fayl yig‘ish … yopilgan — bu fayl biriktirilmadi» with a button that opens it again —
  and then goes on down the ladder as if this collector were not there.
- **Both of the collection's buttons carry their prixod** — `pf:ok:<receipt>`, `pf:no:<receipt>`: a press
  under an EARLIER prixod's message closes nothing, and says so as a message.
- **«↩️ Bekor qilish»** (drawn once there is something to take back) removes exactly what THIS collection
  put on the prixod, through the shared delete door under the presser's own right; a file a tarkib already
  cites stays and is counted as kept.
- **The payload carries what was stored** — `files: [{ m: message, a: attachment }]`: the count is the set's
  size, a redelivered file JOINS it (its row is looked up FIRST — the id is `uuidv5(prixod:chat:message)`),
  and the cancel has its ids. A second press for the SAME prixod while it is open is the same collection.
- **A backlog file IS taken** (unlike every other collector): updates are handled in order, so a file handled
  after the press was sent after it — and the file lands visibly, with the cancel under it. The thirty
  minutes re-arm from each file's own date, never the processing clock.
- **Stored as a paper** (`saveAttachment`'s `asPaper` → `kind: 'file'`): a prixod's `kind = 'photo'` rows are
  its carton photos, and the loader's list, the stock table and the Ostatka Excel draw the first of them
  where the cargo should be. `DELETE_RULES.receipt = 'shared'`.
- **One acknowledgement per burst** through `keepLastSoon` + `drawKeptLast` (1.2 s): the collection's ONE
  message — the prompt first, then «N ta fayl biriktirildi» — is edited while still last, else sent below
  and the old copy deleted.
- **A video, a voice note, a sticker, a place** are answered in words before the task door can offer to make
  a task of them; **a typed text** that no free lookup answered is told it is not kept, before the paid
  assistant is asked.
- **The History** names every file: one audit row each under its own key, `fileAdded:<message>`
  (`AUDIT_FIELD_LABELS.fileAdded`, four bundles) — a shared key folded an album of three into one line about
  the last.
- **The card**: the reader's OWN uploads carry a ✕ whoever they are (`AttachmentsPanel removableIds`; the
  delete door has always allowed it).

### G.E «🔗 Bitim biriktirish» on the card

- `DealLink` is `id="bitim"` (`RECEIPT_DEAL_ANCHOR`), with a scroll margin and a `:target` frame (an outline
  with an offset since the merge with the card round — §G.H).
- «+ Yangi bitim ochish» is drawn for a prixod with no deal, for whoever may open one (`mayEditDealTerms` —
  never the VED), and **carries the prixod**: `/bitimlar/new?client=<id>&prixod=<receipt>` → the form says
  «Prixod N shu bitimga biriktiriladi» → the create action links it through `linkReceipt` right after the
  deal exists and returns to `/receipts/<id>?bitim=1` — a QUERY the block reads and scrolls itself into
  view by, because a server action's redirect drops a `#fragment` (found by the browser spec: the card
  opened at its top). A refused link does not un-create the deal: its own card opens instead, and says so
  (§G.G, which also adds the re-proof at the save, the confirmed-only link and the voided line).

### G.G After the as-built review — BINDING (overrides G.C-G.E where they differ)

Four lenses read the built round (fold · collector · confirm + AI line · the card). What changed:

**The collector**

- **A file that swipe-REPLIES to another of the bot's messages is not the open collection's**
  (`repliesElsewhere`: the reply target is a BOT message and is not the collection's own). It was being
  stored on the open prixod — GS812's packing list on GS777 — and it took a file the «➕ Shu so‘rovga
  qo‘shish» door had always opened on. `receiptFileArrives` declines it; the doors below (a draft, the add
  door, a thread, a task) answer as they always did; and a replied file NONE of them took is told under the
  file — «↩️ Bu fayl boshqa xabarga javob qilib yuborilgan — prixod N ga biriktirilmadi…»
  (`receiptFileRepliedElsewhere`, asked by the ladder after `refuseMediaReply`). A reply to the
  collection's own message, or to a PERSON's message, is the collection's as before.
- **A parked «Hisoblatish» that starts to hold again closes the collection** (`updateIntake`: the intake
  did not hold before this non-quiet update → `closeReceiptFiles`). «Another collector opened» had three
  homes and missed the fourth: «▶️ Davom etamiz», a press on a parked table, a reply to it.
- **A file taken by its own date and drawn after the window passed is SAID** — the debounce's draw finds
  the collection closed by quiet with files in it: the old message is retired and «✅ K ta fayl prixod N
  ga biriktirildi.» is sent as the collection's last word, with no «Yana yuboring». The closed entry stays, so
  the next file is still told that it was not attached.
- **A closed collection answers for two hours, not for as long as the process lives**
  (`RECEIPT_FILES_TOLD_S`; `closedAt` on a collection another collector closed, the wait's own expiry on a
  quiet one). Past it the entry is dropped in silence: Monday's forgotten collection no longer meets
  Tuesday's unrelated photo with «bu fayl biriktirilmadi», and Monday's «↩️ Bekor qilish» removes nothing.
- **The History prints «Fayl qo‘shildi: invoice.pdf · Telegram»** — the key's item (the Telegram message
  id, there for uniqueness alone) is not printed (`ITEM_NOT_PRINTED` in `audit/fields.ts`).

**The fold**

- **The admins' copy says WHY it came to them**, on their copy alone: «👤 Mijozning sotuvchisi yo‘q —
  sizga yuborildi» / «👤 Sotuvchi {ism} bu xabarni ololmaydi (Telegrami ulanmagan yoki ishdan ketgan) —
  sizga yuborildi» (`payload.sellerReach` + `sellerName`, written by `buildRecipients` onto the admins'
  rows only). Before the fold an admin received this alarm only for a seller-less client; now it also
  comes for a client whose card names a seller.
- **The claim door is no «first cargo»** (`celebrateFirstCargo` returns for `via: 'assign'` and for the
  older `assignedFromUnclaimed` payloads): the staff group is no longer told a seller brought in cargo that
  came weeks ago. This stood in a comment since 0134 and nothing asked it — found by the review, not made
  by this round.

**The card**

- **A deal of ANOTHER client is not printed as the prixod's** (what a client correction leaves on
  `deal_id`). The block's «current» is the client's OWN deal (`ownDealOf`, the message's own rule); a
  foreign one is named in one muted line — «Boshqa mijozning bitimida qolgan: B-…» —, the picker offers
  this client's deals, «+ Yangi bitim ochish» is drawn, and the new-deal form accepts such a prixod (the
  new deal replaces the foreign one through `linkReceipt`). The seller's message and the block its button
  opens now say the same thing.
- **«Born with the prixod» is re-proved at the SAVE** (`bornWithVerdict`, `wms/receipts/deal-state.ts`:
  this client's prixod, confirmed, on no deal of its OWN). ONE rule asked three times: by the new-deal page
  when it draws «📦 Prixod N shu bitimga biriktiriladi»; by `createDealAction` BEFORE the deal exists
  (`bornWithRefusal`, which also answers `receipt_not_found` and `upsale_paid`) — a form older than the
  prixod's deal is refused in words and mints nothing; and by `linkReceipt(…, { bornWith: true })` under
  the prixod's row lock (`FOR NO KEY UPDATE`, after the deal and KPI locks; the row alone, then its deal —
  #1585). Before, a stale form MOVED the prixod off the deal a colleague had just chosen and erased its
  confirmed calculation link, silently. Every other caller of `linkReceipt` chose the move and passes
  nothing. Words: `deals.errors.receipt_has_deal / receipt_not_confirmed / upsale_paid` (four bundles).
- **Past the deal's creation nothing becomes an error page.** The link is caught whole (a dropped
  connection used to rethrow over a form whose next press minted a second deal) and logged; a deal that
  was opened for a prixod which did not land on it opens its own card with `?prixod=yoq`, and that card
  says so in one line (`deals.receiptNotLinked`).
- **The new-deal link is drawn only for a CONFIRMED prixod**, and a VOIDED prixod's deal block says so in
  its own first line (`receipts.dealVoided`): the Telegram button outlives the prixod — a wrong prixod is
  voided and received again, and the button under the FIRST message still opens this block, with the
  void's only marks scrolled under the sticky bar.
- **The History prints a removed file's name** (`removedFile`, `audit/history.ts`; label
  `audit.fields.fileName`): `deleteAttachment` audits on the file's parent with `before` only, so a
  prixod's card printed a bare «o‘chirdi» — which reads as cargo data deleted — for the seller's ✕ and for
  every file of a «↩️ Bekor qilish». A bot file is recorded under the name it is STORED under
  (`SavedBotFile.fileName`), the one its tile reads; a photo used to be recorded as «rasm».

**The confirmation and the AI line**

- **The five 0144 facts are written once in SQL** (`clientFactTerms`, `lot-check-sql.ts`):
  `clientHoldsSql` and `clientFactsHoldSql` were two hand copies of the same five terms.
- **Monday's message carries TWO AI lines**: «🤖 AI (hafta): …» and, under it, «🤖 AI (oxirgi 24 soat): …»
  (`SummaryFacts.aiDay`, a second `aiSpend` read). On a Monday there is no daily message, so with the
  week's line alone Monday's own working hours were on no evening's «oxirgi 24 soat» line — a twenty-hour
  hole in the rolling series every week. This supersedes G.B's «the Monday message reads the closed week»
  where it implies one line; the pull on a Monday shows both too.

**Tests that could not see their subject, re-anchored** (each shown red with its subject stripped)

- The «0146 has not landed» press test spied on the POOL's `unsafe`; a drizzle transaction runs on a
  scoped client with an `unsafe` of its own, so the two statements 0146 added to the press were invisible
  and the test held with their guard deleted. It records the transaction's statements now, and its control
  is the press's own upsert.
- The browser spec's «opens AT the deal block» held with the anchor and the scroll effect deleted (for a
  seller the block sat at ~295 px with no scrolling — on the card as it stood before the merge with the card
  round). It asserts the scroll (`landsOnBlock`; its two outcomes since that merge: §G.H).
- `measuresMoved` with the name AND the weight moved; the FULL tag recipe as a literal (`3795624c`, beside
  the basic `5a0ae98c`); `client-confirm-text.ts` on the rounding fence (§A.7 promised it).
- The AI line's wire through `composeOwnerSummary` (daily and Monday), an unreadable ledger NAMED on the
  line, the assistant's refused usage write still answering, its ledger read through the row's json.

Pinned: `receipt-files-bot` (the reply, the parked resume, the two-hour life, the late draw, the busy
collectors, the ceiling, the cancel's kept half, a redelivery that joins the set, the stored name),
`receipt-arrival` (the why-line on the admins' copy and its absence on the seller's; a leaver who keeps a
linked chat; an admin who is the seller; the bell row's type; the claim door's deal; no celebration; the
born-with rule at both asks), `receipt-files-wire`, `audit-fields`, `ai-spend` (unit and integration),
`client-confirm` (integration and wire), `client-push-text`, and the browser spec's four new walks (the
scroll, a stale form, a voided prixod, a foreign deal). Red proofs by string edit, in the second worktree:
37 for the review's fixes — 32 by vitest, 5 in a browser (the spec is serial, so one build per strip) — all
red; three of the review's own new tests first stayed green and were re-anchored (DECISIONS #1735).

### G.H After the merge with «Prixod kartasi» — BINDING (overrides G.E and G.G where they differ)

Main's PR #146 rewrote `/receipts/[id]` while this round added to it (`docs/PRIXOD-KARTA.md`, its §7 binding).
The card's ORDER is that round's; what this round put on the card was re-seated in it (DECISIONS #1738-#1742).

- **The deal block is the «Bitim» cell of the ties card** (`receipt-links`): label → one value line → the
  control row, «Saqlash» only once the answer differs, no card of its own. Its root keeps `id="bitim"` and
  `data-testid="receipt-deal-block"` (main's root testid `receipt-deal` had no reader and gave way).
- **The landing frame is an OUTLINE with a 4 px offset** (`target:outline…`): a ring on a bare cell sits on its
  letters. `?bitim=1` adds the same four classes, written out — Tailwind compiles only what it can read.
- **On a phone the ties card follows the cargo** (`max-md:order-1`), so on a short prixod the block is low on
  the page and the browser cannot bring it under the bar. The landing has TWO honest outcomes —
  `landsOnBlock` (`tests/e2e/prixod-xabari-landing.ts`, one home for the phone and desktop files): «under the
  bar» (top within 56-110 px), or «page end» (scrolled as far as the page goes, the block WHOLE between the
  app bar and the tab bar) — always behind `scrollY > 0`. The scroll margin itself is asserted at 360×420,
  where the page is long enough to show it; «page end» on a desktop at 1280×900 (the seller).
- **Layout chrome never scrolls the window**: the workspace tab strip brought its lit tab into view with
  `scrollIntoView`, which pulled every anchored address (`#bitim`, `#lot-…`, `#ichki`) back to the top a frame
  after the browser landed — on a desktop, for whoever's strip lights a tab on the page (322 → 63 px at
  1280). It moves its own row's `scrollLeft` now (#1739; `tests/unit/anchor-landing.test.ts`,
  `m9zzzi-prixod-xabari.desktop`).
- **A deal of ANOTHER client**: its sentence sits UNDER the control row (between the value line and the select
  it pushed «Bitim»'s select below «Zavod reysi»'s on a VED's desktop card), and «Saqlash» stands while it
  does, whatever the select holds — the empty option «— uzish» takes the prixod off that deal, which before had
  no door at all (the select opened on it, so it never «differed»). For a reader with no new-deal door the
  sentence offers only pick or unlink (`receipts.dealForeignPick`). The VOID line stays ABOVE the row: on a
  voided prixod there is no factory-trip select to stand level with (`canLinkPickup` asks a confirmed prixod),
  and it is what the landing must show first.
- **The «Fayllar» card leaves with a non-editor's last file**: main draws it only while there is something to
  list or to attach; `AttachmentsPanel refreshWhenEmpty` (the prixod card alone passes it) asks the page again
  when a reader who cannot attach removes the last file (the delete is a plain fetch that revalidates nothing).

Pinned: `receipt-files-wire` (the save condition, the cell's order, the sentence's offer in four bundles, the
outline, `refreshWhenEmpty`), `anchor-landing`, the phone spec (the scroll margin at 360×420, the save in the
foreign state, the VED taking the prixod off a foreign deal, the last file) and `m9zzzi-prixod-xabari.desktop`.
Red proofs: 8 by vitest (six for #1741's findings, two for the strip's fence), 4 in a browser (the save while
foreign, the last file, the window pull-back, the desktop floor) — each red in the test it names.

**After the second review of the merged card** (DECISIONS #1743) — three states only the card's own actions make:

- **Both cells of the left stack are keyed on what is STORED** (`deal:<client>:<deal>`, `calc:<own deal>:<link>`):
  a client correction through «Boshqa amallar» revalidates without remounting them, and the deal cell used to
  keep the deal it had chosen before — «Saqlash» over «— Uzish» sent the old deal back and nothing moved.
- **«Hisob» is about the prixod's OWN deal**: it lists that deal's calculations, stays drawn while a link
  stands (so «—» clears a left-over one), and shows a link its list does not hold as a disabled, selected
  option of its own. `calc/link.ts` asks `ownDealOf` at the seal's guess, `setCalcLink`, the ✓ and the bot's ✅;
  «—» and the bot's ❌ — taking a link off — are never refused.
- **«Fayllar» leaves with the last file however fast the ✕ are pressed**: decided in an effect over the list the
  deletes leave, not from the render a press closed over.

Pinned: `receipt-files-wire` (the keys, the options' deal, the row's condition, the effect — comment-stripped),
`calc-link-render`, `anchor-landing` (now the layout's whole import closure), `calc-link-ask`, and two browser
tests in the phone spec (the correction on the mounted card; two ✕ inside one slow delete). Red proofs: 12 by
vitest, 2 in a browser.

### G.F Tests

Unit: `receipt-arrival` (the message, the predicate, the alarm, `rowTypeFor`, the buttons, the wait kind's
three homes), `receipt-files-wire` (the ladder's order, the three collector openings, the leaf, the anchor),
`ai-spend`, `lot-check-ready`, `lot-check-panel-render`, `client-confirm-wire`, `anchor-landing`,
`calc-link-render`. Integration:
`receipt-arrival` (who is told, per person and mute list; the claim door; a foreign deal; R6),
`receipt-files-bot` (the whole handler chain), `ai-spend` (the three ledgers' real rows, the assistant's
usage), `client-confirm` (96 combinations; the measures), `client-confirm-bot`, `calc-link-ask` (a prixod
left on another client's deal). Browser:
`m9zzzi-prixod-xabari` and `m9zzzi-prixod-xabari.desktop`, over `prixod-xabari-fixture.ts` and
`prixod-xabari-landing.ts`. Not verifiable here: real Telegram — the first real «Prixod keldi», the first press
of each button and the first file are the proof.
