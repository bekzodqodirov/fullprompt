# Sakkiz band — his eight items of 2026-10-20 (diagnosis, NOT yet agreed)

Status: **diagnosed and adversarially verified; his answers in §11 (2026-10-21);
round 1 BUILT (DECISIONS #1455-#1462, CHANGELOG 2026-10-21) and reviewed against a
regression corpus (#1463-#1468, CHANGELOG 2026-10-27); round 2 DESIGNED and judged
(`docs/SAKKIZ-R2.md`, his four new questions at its top); rounds 3-10 open;
4.5 and 6.8 asked back and ANSWERED the same day («2 c / 3 b», §11).**
Below, the diagnosis as written before any code. His message
(verbatim, abridged): AI rastamojka in the bot cannot read goods from files,
photos or typed text and does not analyse everything together; adding missing
information works badly (1); it very often fails to compute customs, and
yo'lkira can come from the table (2); use the newest Claude models and stronger
reasoning (3); an «odnarodka» button on the calculation screen that enters one
whole truck's price (4); VED jobs land on one person instead of the least busy
(5); a Telegram request with a client code must open a NEW deal, not join the
old one (6); a counterparty's card must say what each debt was written for
(zavod reysi etc.) with a link (7); a lot tarkib must work for ONE kind of goods,
not only 2+ (8). He asked for objections and questions BEFORE any work.

Method: one diagnoser per item (item 1 twice: inputs, dialogue), one refuter per
diagnosis, one completeness critic. Read-only; this container had no database,
so every frequency below is reasoned, not measured. The questions sent to him
are §11 — his answers map onto those numbers. `main` was at migration **0134**
(`staff_group`, the other session) when this was written: the first migration
of these rounds is **0135**, numbered in build order (#1040) after a fresh
`git fetch` of the journal tail.

**Rule for every round below:** a model identifier never goes into the repo
(CLAUDE.md hard rule). Item 3 is designed so the model is picked on a settings
screen from Anthropic's live model list (§4), not typed into source.

## 1. Item 1A — the bot does not read what it is sent

Path: «🤖 AI rastamojka» / «🧮 Hisoblatish» share one collector
(`telegram/staff-handlers.ts` + `telegram/calc-intake.ts`) → «Bo'ldi» →
`analyzeCollected` → `calc/intake-ai.ts analyzeIntake` (one model call: images,
ONE PDF, text sliced to 20 000 chars; output `json_schema`).

Confirmed causes (each traced by two agents):

1. **A misread spreadsheet overrules the AI.** `deals/goods-import.ts` picks the
   name column by keyword left to right (`'Item No.'` beats `'Description'`), a
   title row containing «товар/name/名称» becomes the header, and with no header
   in rows 0-9 every row's first text cell becomes a «product» (seller,
   address, «Invoice No»). `calc-intake.ts:307-312` prefers those rows over the
   model's goods unconditionally and the bot says «Fayldan N ta tovar o'qildi».
   `goodsFromFile` (`deals/goods-file.ts:99-112`) has ONE caller (the bot) and no
   test; the VED paste already refuses the headerless fallback
   (`send-rows.ts:368-371`) — the fix is bot-local.
2. **A photo sent as a FILE is never shown to the model**, silently
   (`staff-handlers.ts:1738` isPhoto = `message.photo` only; a JPEG/PNG document
   goes to `readInvoice` → null). HEIC cannot be decoded by prebuilt sharp 0.33:
   needs a refusal in words or a converter.
3. **Silent drops**: `.xls` (BIFF) ignored; only `worksheets[0]` read; CSV as
   utf8 only; `«120KGS»` cells read as null; a second PDF dropped (first wins,
   `:753`); a second xlsx REPLACES the first (`:750`); photos past 6 skipped;
   spreadsheet contents never reach the model at all.
4. **Truncation reads as «AI mavjud emas».** `max_tokens 4096`
   (`intake-ai.ts:159`), the current Opus tier thinks by default and thinking
   counts inside max_tokens; only `stop_reason === 'refusal'` is checked, a cut
   JSON throws, the catch returns null (`:257-279`), and every null prints the
   same «AI mavjud emas» (`staff-handlers.ts:1319-1324`). `maxRetries: 1` doubles
   the wall clock (bot ~120 s, thread door ~40 s) and re-sends every image.
5. **Typed numbers overrule documents**: `intake-manual.ts readNumber` takes the
   single distinct «N kg» in all text («3 kg li paket», one line's weight, a
   per-line answer) as the shipment total, winning over the model
   (`calc-intake.ts:290-291`). Only when 2+ distinct values exist does the model
   win.
6. **Client stage eats material**: the first text becomes `clientHintRaw` and
   never enters material (`:824-831`); ANY text with ≥7 digits is taken as a
   PHONE whose value is the whole text (`intake.ts:734-735`), so a forwarded
   goods list with a TNVED code names AND «phones» the lead.
7. **Race**: material sent during the analysis is erased — the analysis runs on
   a snapshot and writes it back (`calc-intake.ts:316-325`,
   `staff-handlers.ts:1586`); a second «Bo'ldi» starts a second paid call; a
   cancel/restart mid-analysis resurrects the old collection.
8. **Never says why**: the model's `steps` reach only the card note; no per-file
   «o'qiladi» receipt (the spec's `docs/AI-VED-RASTAMOJKA.md:289` was never built).
9. The card's chat door sends TEXT only (`calc/from-thread.ts:124-162`).
10. **The analysis is an unowned `void` promise in the app container**
    (`staff-handlers.ts` 'done'): a deploy kills it and the seller waits on «⏳»
    for ever — sub-round B's #897 shape, fixed there by moving to pg-boss.

Refuted/softened: the 1568 px downscale barely matters (compressed Telegram
photos are ≤1280 px; the loss is image FILES, cause 2).

## 2. Item 1B — adding missing information

Confirmed: the collection is an in-memory Map with a 30-min sliding TTL, lost
on every deploy (`calc-intake.ts:184-185`); in the question stage every text is
written onto the line being asked, whatever it names (`staff-handlers.ts:820-823`,
`1434-1450`); every per-line answer is appended to material (`:1440`) and on the
next «Bo'ldi» becomes a shipment total (cause 5 above); at most 3 LINES are
asked and rastamojka totals are never asked (only AI podklyuch asks,
`:1285-1306`); voice/audio/video during a collection get silence (`:777`);
media in the podklyuch 'section' stage skips the zone and client questions;
«Tasdiqlash» lands facts that were never analysed (no stage check, `:1992-2008`);
re-reads and abandoned collections are never billed (`ai_calc_passes` written
only at landing).

After landing there is no Telegram door to add to THAT job: a re-send opens a
second request (rota may give it to another VED) with a second AI pass. A
text-only same-job channel exists (the card's «Savol-javob», the VED's
«❓ Sotuvchidan so'rash» swipe-reply). Constraints any amend door must respect:
`openCalcRequest` assigns at creation (so «untaken» ≈ never; the real test is
the rev clock / `prefillStanding`); files in calc threads are refused by his
E10 a; a returned request re-opening overturns `recalc_returned`
(`workspace.ts:2360-2372`); Q5 a makes collectors refuse backlog messages.

## 3. Item 2 — customs not computed; freight from the table

Pass: `calc/prefill.ts aiPrefill` (budget 200 model calls/day,
`ai_calc_daily_limit`) → memory codes → grouping model → PP-3818 rates (cover
every heading; `rates_missing` rare) → baza from the SEALED memory, then the
newest READY customs import → model pick by index → `pricing.ts customsFor` →
`requestCustomsFor` returns NULL for the whole request if any row is ungrouped
or any group refuses; `ai-reply.ts:206-216` withholds JAMI (MR-23, deliberate).

Confirmed causes:
- one row without baza/measure refuses its WHOLE group (`pricing.ts:264-312`,
  first bad item returns), and one group kills JAMI;
- memory learns from SEALS only (`memory.ts:151-160`); «Готово»-closed jobs teach
  nothing;
- the import is searched by EXACT 10-digit code (`import-stats-sql.ts:151`); a
  4-6-digit heading finds nothing;
- only ONE batch is searched — the newest READY (`import-service.ts:663-672`): a
  newer partial upload shadows older full quarters;
- names: word_similarity against Russian declarations; Uzbek/Chinese names score
  ~0 (only the model pick bridges);
- unit mismatch: a pieces-only row vs per-kg declarations (74 % of his file) is
  refused by auto-fill and pick;
- the product-baza dictionary `calc_bazas` is NEVER read by the pass although
  spec decision 10 ranks it second (memory → dictionaries → import); it must go
  INSIDE `saveTable`'s fill order, not after the sweep;
- per-line questions are asked BEFORE codes exist, so a law that counts dona
  (ch. 61/62), juft (64) cannot ask its unit; codes from memory/the book are
  stamped only at landing;
- the grouping model sees name + quantity + unit only (`workspace.ts:2934`);
- invoice price is never extracted by the model; xlsx `amount` is stored
  currency-less and read by nothing.
Freight: a yolkira job is never queued (`prefill-queue.ts:18-30`, its comment
cites decision 8, OVERTURNED 2026-09-26); card/thread/plain-bot podklyuch never
set a zone (`guessZone` exists, hint only); the band needs request kg AND m³ and
neither is derived from lines (lines are NETTO, the truck BRUTTO — sum m³ only,
ask kg). The worker stands down silently when the rev moved, a group is
confirmed or the request closed.

Estimate options (only in the chat; VED screen and seal stay exact): the
declaration median of the SAME code (`customs/import-stats.ts`, percentile_disc,
China-only) filtered by the row's unit and the ±25 % weight-per-piece band,
with N shown; invoice price as a comparison line. An AI-invented baza breaches
law 1 in substance — not recommended. A «taxminiy jami» reverses MR-23 for the
chat and re-anchors its tests.

## 4. Item 3 — newest models, stronger reasoning

Six call sites, all non-streaming `messages.create`, constants in
`platform/ai/model.ts:51-52`: `analyzeIntake` (4096), `pickImportRows` (4096),
`proposeGoodsGrouping` (8192, ≤200 goods), `suggestTnved` (2048),
`pickSimilarLots` (1024), the assistant loop (2048, tools auto). No forced
`tool_choice`, no temperature, no thinking param, no prefill → a model swap
throws no 400. SDK `^0.114.0` (bump/typecheck to confirm `effort` typing).

Findings: thinking is ALREADY on (current Opus tier default) and eats the small
max_tokens; the newest Opus tier defaults to effort `medium` (set explicitly per
job; its medium already beats the current tier's high per Anthropic's guide);
timeouts 60 s/20 s with one retry; `AI_CLAIM_STALE_MS` (10 min) must grow with
any longer pass or the workspace lock admits writers mid-pass; the assistant
loop drops thinking blocks between rounds; spend is counted in CALLS, never
dollars; three doors are unmetered and uncapped (deal goods import, Bojxona-tab
🤖, chat door) and recording them needs a migration (`ai_calc_passes` anchor
CHECK, 0119); the deal goods import sends up to 500 goods to a function that
refuses >200; newest tiers add a biology safety filter (refusal → silent manual
path today; a server-side fallback exists for the larger tiers, not the smallest).

Design proposal: a per-JOB profile {effort, max_tokens, timeout, stream} in
code; the MODEL per tier chosen on /admin/settings from Anthropic's live Models
API list (no identifier in source; switches without a deploy); stop_reason
`max_tokens` named and retried once; streaming for big calls; a dollar price
table + monthly ceiling with an 80 % warning; meter the three doors. Must come
AFTER item 1's race fix and the move of the intake analysis to pg-boss — a
slower model widens both.

## 5. Item 4 — «odnarodka»

`calc_freight_tariffs` is per-density bands only; `freightFor` = band × m³ (or
× kg ≥1000); no flat amount exists anywhere. Two zones: 'cn' (Yiwu AND
Guangzhou, one column) and 'kashgar'. Today a truck price can be sealed only
through a DISCOUNT or a BAND OVERRIDE (both kill the upsale, send «Chegirma»,
skip the price channel) or by «Готово» with the zone left unpicked (no version,
no E1). **Never add odnarodka rows to zone 'cn'**: that column splits every
truck's real yo'lkira bill (`freightSplitZone()`); an overlap refuses new
tariff-basis bills AND makes every 'cn' quote at that density `band_ambiguous`;
/admin/tarif has no delete. Per-m³ readers a truck price must teach: upsale
`cargo_factor`/`due_price` (`upsale.ts:233-270`), `DealDeviation`, the
accountant's deal price hint, E1 band check, offer/PDF, price channel, AI reply,
quote history/narxlar/tarix/chain ($/m³ comparisons), recalc copy, bot landing
and zone buttons. Truck capacity presets exist (`truck_presets`, 90 m³/24 t,
130 m³/28 t, owned by planning). Every China truck unloads at Kashgar/Horgos in
the road model (his 21a) — is «1 fura → Toshkent» the whole road? Reading b
(cheaper per-m³ rate for homogeneous cargo) needs no code: a NEW zone code on
/admin/tarif (labels + bot button only).

Recommended: a separate dated `calc_truck_tariffs` table, `freight_basis` +
`truck_count` on requests and versions, a list price owned by
`admin.dictionaries.manage`, every reader above taught in the same round
(no A-lite with known-wrong money readers), a derived fence over freight_zone
writers. Size L, migration. **Overtaken by his 4.5 (2026-10-21):** there is no
preset truck price — one overall price is typed per cargo, so the dated table is
out unless he says otherwise (asked back). And since `main`'s 0135
(`load_mode`, LTL/FTL for KPI) a deal carries an FTL flag: an odnarodka quote is
an FTL job and must set it.

## 6. Item 5 — the VED rota

`calc/service.ts nextVedAssignee` orders by `count(open)`, then
`max(requested_at of OPEN)` nulls first, LIMIT 1, no third key. **When everyone
has 0 open — the normal state when jobs arrive slower than they are done — every
candidate ties and the same person (first aggregate row) wins every time.** The
A13 audit saw exactly this before admins were excluded (the owner won every
fresh request). With equal NON-zero counts the second key does rotate (so night
jobs rotate; the earlier claim that they all hit one person is refuted).
Also: fast closers and hand-backs (↩️ frees a slot) are rewarded; pool = every
`ved.docs` holder minus admin/super_admin roles (no leave switch; ved.docs is a
4-power bundle, #749); corrections return to the pricer regardless of load
(`workspace.ts:2421-2441`); size ignored; a millisecond race (no lock; two
writers: `openCalcRequest` and `recalcFromSealed`); nobody sees «handed per
person» (/hisoblash credits whoever priced). Fix order: tie-break by handed
TODAY (Tashkent), then longest since last handed over all history, then id,
under `pg_advisory_xact_lock` with the count on `tx` (#714, `tx-pool.test.ts`),
`nextVedAssignee(pool?)` for a deterministic test. Then (his answers) a
«Hisoblash navbatida» checkbox (`users.calc_rota`, backfilled), weight by his
30-min-per-line scale, a «Bugun» line.

## 7. Item 6 — a new deal per Telegram request

`calc/intake-land.ts dealFor` returns the client's newest OPEN deal; it mints
only when there is none; both bot doors and the chat door (client entity) use it;
the card form uses its card; corrections keep their parent's card. Pinned by
three integration tests (calc-intake, deal-ved (vii), thread-calc). Seeded
«Skladda/Yo'lda/Yetkazildi» are kind 'open', so a client's deal rarely closes.
Mixing jobs on one deal already costs money: the second seal overwrites the
deal's quote (`workspace.ts:2103-2116`); DealDeviation compares ALL cargo to ONE
job's quote; the upsale factor counts the whole deal's cargo against one job's
m³ (overpay), and a paid «Готово» on the same card reduces a later job (underpay);
`answerFloorStandsSql` drops an earlier answer once another job seals; the
calc↔prixod auto-link suggests nothing once a deal holds two seals.
What his rule creates: one open deal per unaccepted quote (nothing auto-closes;
lost needs a reason FROM HIS DICTIONARY), CRM counts/won rate move, the China
receive picker must tell N «Hisoblatish — rastamojka» deals apart (title must
carry goods), an unlinked prixod pays the seller 0, automation fires per request,
a retried failed save mints twice (state is in memory), the chat door mints
before its `note_taken`/`too_many_open` checks, a top-up re-sent through the bot
becomes a second DEAL (→ the add-to-same-request door must ship first or with
it), the round-111 empty shell deal (only from «+» and the client form) stays
empty unless adopted. Stranger path: `openLeadForPhone` joins ANY lead incl.
LOST (`intake-land.ts:371-385`); `inboundMatch` is the right rule.
`calcDealOwnerFor`: a sender who may edit deal terms keeps the deal, else the
client's seller, else nobody.

## 8. Item 7 — what a counterparty debt was written for

`partners/link.ts chargeForCost` copies only `batchId` and `note`; `batch_id` is
NULL for pickup, crate and ordinary receipt costs, so those debts say nothing.
The only link goes to `/batches/<id>` (contents, not Xarajatlar); no cost type
anywhere; an expense debt is one fixed sentence; the card shows the newest 200
rows (voided ones included) and never says so while the balance counts all; an
offset names no client and its uploaded proof file is shown nowhere (a note
proof is printed). Every derived row already has `cost_entry_id` / `expense_id`
/ `client_tx_id` — no migration. Link rule precedent: `accounting/sarflar.ts
costTargetHref` (needs an explicit pickup door, expense link with
`?from&to&categoryId` + anchor for `finance.expenses` only, crate link only with
`crates.manage`+scope, nothing for a voided source). The VED reads this card
(#1034 recorded it as an open hole in his no-tannarx rule); firm-paid salaries
are already visible here to the VED and the logist. The proposed «kursi yo'q»
block is dropped: no door can create a rate-less partner cost (`fx_missing`) and
`cost_entries` has no partner index.

## 9. Item 8 — tarkib with one line

Only `MIN_LINES = 2` (`receipts/composition-math.ts:233`) + the editor's two
starting rows and its ✕ rule; the DB admits `seq = 1` (0122) — no migration.
It REVERSES his 1a of 2026-10-01 (#1263; the refusal text names the logist;
fenced in `lot-composition-fence.test.ts:221-232`) — though two differently
named lines of one good already pass. The real gap is DONA: an uncomposed lot
prints «кг» with quantity = kg (`documents/ved-xlsx.ts:329-330`); its TNVED
already has a home (Bojxona tab, shared memory, 🤖). Pitfalls of a bare 1-line
tarkib: the invoice then prints ONLY the line's code (empty line code = the code
vanishes), no 🤖 on line rows, a line code never teaches the memory, packing
lists lose the Chinese name, the document is mandatory per prixod, every tarkib
auto-✅ «hujjat bo'yicha» (YUK-TEKSHIRUV 3a), a lot not wholly on the truck is
yellow «taxminiy», a re-weigh makes it stale. Per-JOB piece counts already reach
the prixod (`receipts.calc_request_id` / `deal_id` → calc items / deal_lines) and
could prefill dona. Recommended «A+»: one line with a «Bitta tovar» prefill
(lot name, kg/m³/cartons, TNVED from the memory, dona from the linked job), 🤖
kept, zh/ru name kept on packing lists, auto-✅ only when the line name equals
the lot name, yellow only when dona is written.

## 10. Proposed rounds (order matters)

- **R0 O'lchash** — a paste-in read-only SQL + one log grep on his server, no
  deploy: AI notes with/without JAMI and their ⚠ reasons, seals vs «Готово» per
  VED, AI calls/day vs 200, import batches (status, period, codes; is the newest
  partial?), jobs handed per VED and whether all had 0 open, clients with ≥2 open
  deals, deals with ≥2 requests, `.xls` attachment count, `model tokens` lines
  near 4096. Plus 2-3 of his real failed bot cases (screenshot + the files).
- **R1** Bot stops losing material (1A causes 1-9 minus the redesign, 1B
  stage/race/answer fixes, honest reasons, max_tokens + stop_reason on the
  current model, stand-down message) + the rota tie fix (item 5 minimal). No
  migration.
- **R2** Customs/freight computed more often, deterministically (item 2: yolkira
  instant answer, zone guess, Σm³ + ask kg, `calc_bazas` in the fill order,
  heading search, batch choice if R0 shows shadowing, richer grouping input).
- **R3** Durable collection (24 h) + intake analysis on pg-boss + «➕ Shu so'rovga
  qo'shish» + the law-unit follow-up question. Migration.
- **R4** New deal per request (item 6) — after R3.
- **R5** Models, effort, streaming, dollar metering, settings-screen model pick.
  Migration.
- **R6** One reader over all material (item 1 «umumiy tahlil»); then, only if
  R0/R2 data warrant, the chat-only estimate ladder (item 2).
- Independent, any time: **R7** counterparty card (item 7), **R8** one-line
  tarkib (item 8), **R9** rota checkbox/weights/«Bugun» (item 5 rest);
  **R10** odnarodka after R4.

## 11. The questions sent to him (2026-10-20)

Numbered exactly as in the chat message; ⭐ = the default he can accept with
«hammasi ⭐». His answers to be recorded here verbatim when they arrive.

0.1 real failed cases (screenshot + files) · 0.2 run the read-only measurement ·
0.3 round order.
1.1 typed vs document number · 1.2 who reads Excel · 1.3 `.xls` · 1.4 photos
per request · 1.5 goods-name language · 1.6 what the bot says when it could not
read · 1.7 first message not a code/phone · 1.8 how long a collection waits ·
1.9 info added after the job landed · 1.10 question style · 1.11 how an answer
names its line · 1.12 voice notes · 1.13 two invoices.
2.1 no baza found · 2.2 partial total · 2.3 customs basis in practice · 2.4
estimate on the card lenta · 2.5 instant yolkira answer · 2.6 zone guess · 2.7
missing kub/kg · 2.8 law unit after coding · 2.9 daily AI limit.
3.1 heavy-work model · 3.2 who picks the model · 3.3 monthly $ ceiling · 3.4
acceptable wait · 3.5 chat door shape · 3.6 assistant tiers · 3.7 refusal
fallback · 3.8 paid comparison.
4.1 meaning of odnarodka · 4.2 whole road or China leg · 4.3 routes · 4.4
destination · 4.5 truck size · 4.6 who edits the price · 4.7 under-filled truck ·
4.8 more than one truck · 4.9 discount/upsale · 4.10 kub/kg required · 4.11
offer wording · 4.12 bot button · 4.13 the extras/«Готово» bypass · 4.14 the
prices themselves.
5.1 meaning of «least work» · 5.2 job weight · 5.3 rota checkbox · 5.4
corrections · 5.5 late assigned job · 5.6 «Bugun» line · 5.7 team size/admin
roles · 5.8 AI-door jobs as VED jobs · 5.9 where he saw the skew.
6.1 which doors · 6.2 the empty shell deal · 6.3 phone instead of code · 6.4 deal
title · 6.5 unaccepted quotes · 6.6 release timing vs the add door · 6.7 old
mixed deals · 6.8 owner when a seller sends for a colleague's client · 6.9 push
for an ownerless deal · 6.10 stranger leads.
7.1 line wording · 7.2 the VED's view · 7.3 crate debts · 7.4 firm-paid
expenses/payroll · 7.5 reverse link · 7.6 offsets · 7.7 the 200-row cap · 7.8
paid/open per bill.
8.1 what a one-kind lot needs · 8.2 keep or reverse 1a · 8.3 document · 8.4 TNVED
source · 8.5 packing-list name · 8.6 auto-✅ · 8.7 yellow mark · 8.8 dona from
the linked job.

### His answers (2026-10-21), verbatim

«1 chi band 3 b / 2chi bolim 4 c / 4chi bolim 5 fura olchami boyicha narx qoyish
oldindan biz sotadgan narximiz yoq yukga qarab 1 ta umumiy narx beriladi / 8 b /
10 b / 11 ikkalasi ham chiqsin / 5chi bolim 4 a / 7 adminga ham tushsin agar ved
roli ochiq bolsa / 9 hisoblash royhatidan kordim u yerda faqat murodga tushgan
10foizcha boshqa hodimga tushganini kordim / 6 chi bolim 8 agar boshqa
sotuvchidan kelsa jonatgan sotuvchini CRMiga tushsin yangi klient bolib / 7chi
bolim 1 rasxod qilingan partiya zavod tovar shu rasxodga tegishli hamma
narsalar / 8chi bolim 5 yana 1 column qoshishimiz kerak karobka sonidan oldin
shtuk donasi yozilsin yoqlari bosh qolsin va aynan packing list sklad
excellarida rasimlar kachestvasini ozgartirmasin hozir hira korinyabti / umumiy
savollar 0 1 a» — with one screenshot of a failed bot case (typed «Tovar
синтетическое компрессорное масло 1.1 kub 240 kg» → «Tovarlar: —», «AI mavjud
emas»).

Every number he did not name is the ⭐ (the message's own convention). So:

- **1.3 b** — `.xls` is READ (a library), not refused.
- **2.4 c** — the chat estimate goes on the card's lenta in full, marked for the VED.
- **4.5** — no preset truck price: one overall price per cargo. This reverses
  4.6 ⭐ (an admin list price): the price is typed per job. **Asked back**: who
  types it, whether it is the upsale floor like a «Готово» answer, and how much
  of the cargo «1 fura» covers for 4.8 b.
- **4.8 b** — cargo over one truck = 1 truck's price + the rest by the table.
- **4.10 b** — kub and kg always mandatory for an odnarodka.
- **4.11 b** — the offer prints «1 fura» AND «1 m³ uchun».
- **5.4 a** — a correction returns to its pricer, busy or not (today's rule).
- **5.7** — an admin who also holds the VED ROLE is in the rota; the admin role
  alone (which carries `ved.docs`) is not.
- **5.9 a** — he saw it on /hisoblash: ~90 % on Murod. Matches the tie defect.
- **6.8** — the deal goes to the SENDING seller (option a, not the ⭐ b), «yangi
  klient bo'lib». **Asked back** what «yangi klient» means: a deal in the
  sender's name on the same code (⭐), a new lead, or a new client code.
- **7.1** — everything about the expense: truck, factory trip, goods (≈ c).
- **8.5** — packing lists gain a «шт» column BEFORE the carton count, blank when
  unknown; and the photos in the packing-list/warehouse Excel files must keep
  their quality («hira korinyabti»).
- **0.1 a** — real cases arriving (one so far).

**His answers to the two questions asked back (2026-10-21, «2 c / 3 b»):**

- **4.5 → A1 c: BOTH the VED and the seller may type the odnarodka price.** A2
  and A3 unnamed = ⭐: the price is the upsale floor like a «Готово» answer, and
  how much of the cargo «1 fura» covers (4.8 b) is typed by the VED each time.
  Built as: the VED's figure is the floor (cost side), the seller's is the
  client price (an offer above it) — a seller's own figure on a job with no VED
  figure is a price with NO upsale, since a person cannot set the floor of his
  own commission (law 4). Round 10 states this to him before code.
- **6.8 → b: a request a seller sends for ANOTHER seller's client opens a new
  LEAD in the SENDER's funnel**, not a deal on the client's code. Constraint for
  round 4: a client code carries at most one lead (0021 `leads_client_unique`,
  `client_has_lead`), so this lead cannot be bound to the code — it carries the
  client's name and phone and says whose client it is; the round must decide
  what «won» does with it (attach refused while the code has a lead).

Taken as ⭐ (named here so a later round does not re-ask): 1.1 c, 1.2 b, 1.4 b
(12), 1.5 b, 1.6 a, 1.7 b, 1.8 c, 1.9 a, 1.10 c, 1.11 c, 1.12 a, 1.13 c; 2.1 b,
2.2 b, 2.3 a, 2.5 b, 2.6 b, 2.7 b, 2.8 b, 2.9 c; 3.1 a, 3.2 a, 3.3 b, 3.4 b,
3.5 b, 3.6 a, 3.7 a, 3.8 a; 4.1 a, 4.2 a, 4.3 a, 4.4 a, 4.7 a, 4.9 a, 4.12 b,
4.13 b; 5.1 c, 5.2 b, 5.3 b, 5.5 b, 5.6 a, 5.8 a; 6.1 a-6.7 a, 6.9 a, 6.10 a;
7.2 b-7.7 a, 7.8 b; 8.1 b-8.4 a, 8.6 b, 8.7 a, 8.8 a; 0.2 a, 0.3 a.
