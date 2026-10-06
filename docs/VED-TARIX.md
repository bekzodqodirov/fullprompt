# VED tarixi, «Готово» javoblari, VEDlar bir-birini ko'rishi, VED kartaga o'tishi

Agreed 2026-10-06. His four sentences, verbatim:

> 2 keyin ved hsoblashda muhrlangan narx bor u yerda tarixga tushmayabti
> hisoblangan tovarlar 3 vedda umumiy narxni berib berdim deb ham narx bersa
> bolyabti unda usha ved kartasiga qaytib kirib bolmayabti nega unday bolyabti
> narx berganda ichki ved uchun ozining izoxi talab qilinishi kerak boladi va
> tarixga tushishi kerak kim qancha hisoblagan 4 ved hodimlari bir birini bergan
> narxini bir birini ishini korish imkoniyati bolishi kerak

and, the same day:

> va yana 1 narsa ved hodimi sotuvchini kartasiga kirishga ruxsatni ochishimiz
> kerak ya'ni noaniqliklar bolganda ved hodimi hsoblashdan kartaga otib
> aniqlashtirib oladi sotuvchi bergan narxni ham koraversin ved hodimi

His answers: **7a 8a 9a 10a 11a 12a 13c** and **14a 15a 16a**. Item 1 of the
same message (Telegram topshiriq) is `docs/TELEGRAM-TOPSHIRIQ.md`; the two
rounds share migration **0124** (§9).

## 1. The answers, as rules

| # | Question (as sent) | Answer | Rule |
|---|---|---|---|
| 7 | «tarixga tushmayapti» — goods on the history row | **a** — a goods summary on every row («3 tovar: klaviatura, sichqoncha…»); a press opens the full list frozen at seal (name, TNVED, qty/kg, baza, boj %, rastamojka); search by goods name and TNVED | §3 |
| 8 | Where the «Готово» answer goes | **a** — the SAME history, chip «✍️ umumiy narx»: who, when, how much, internal note; filter Hammasi / Muhrlangan / Umumiy narx | §4. **This reverses his 1A of 2026-09-04** («faqat muhrlangan»), and the hint saying so is rewritten in all four locales. |
| 9 | The internal note | **a** — two boxes on Готово: «Sotuvchiga izoh» (optional, as today) and «Ichki izoh» (REQUIRED, seen only by the VED and leadership) | §5. A NEW column: `answer_note` goes to the seller in Telegram and on the card, so it can never be the internal one. «VED va rahbar» = `ved.docs` (held by ved_manager, admin, super_admin); the accountant reads the history and NOT the internal note. |
| 10 | Correcting an answered job | **a** — it opens READ-ONLY; «Qayta hisoblash» makes a new request that supersedes it, the old one stays in history. «Muhrlanganlar bilan bir xil qoida» | §6. Same gate as a sealed recalc (`admin.settings.manage`). |
| 11 | Does the Готово path stay | **a** — as today: forbidden while the job can be sealed (`seal_instead`, #880) | Unchanged. Consequence stated in §8: every door that closes a calc job must obey 9a. |
| 12 | VEDs see each other | **a** — every VED sees everything: the queue (already), the history (sealed + answers, «kim» filter), the «Nazorat» page; any VED edits an open job (already) | §7. Nazorat READS widen to all; the link ✅/❌ stays the sealer's own (it scores a person). |
| 13 | «kim qancha hisoblagan» | **c** — both: who and how much on every row, AND per-VED totals (this month: sealed / answered counts, average time) | §7. ONE credit rule for every surface. |
| 14 | What the VED may do on the seller's card | **a** — sees the lead or deal card, lenta, Telegram, calls and the seller's price; may write a lenta note (a question or a remark); may NOT edit (stage, phone, price) | §10 |
| 15 | Which cards open | **a** — only cards that carry a calculation request, through «Kartaga o'tish» from the calc page and from the history | §10 |
| 16 | The seller's price | **a** — the price the seller told the customer (offer price + date) on the card and on the calc page; NOT the upsale amount, NOT the payouts | §10. **This reverses law 4 for the client price**, at his word; `upsaleScopeFor` stays `'none'` for the VED, so /upsale and every payout stay shut. |

## 2. One vocabulary — `src/modules/wms/calc/credit.ts` (new)

Three places disagree today about «who calculated this job»
(`staff/my-month.ts` credits the presser, `calcSpeed` credits the HOLDER and
counts a price-less close as «done», nazorat keys on `sealed_by`) — measured on
gsr_verify: the speed block credits «VED Demo» with 4 jobs while Bekzod sealed
all 4 (#513). One module, every reader asks it:

- `isAnswerSql(r)` — a calc request that ended with a typed price:
  `r.completed_at IS NOT NULL AND r.completed_via = 'task' AND r.answer_amount IS NOT NULL`.
  `my-month.ts` already says exactly this; it moves here and is imported.
  `dealCalcSheets`' display rule = `isAnswerSql` + its own «not replaced»
  clause, re-expressed on top of it. `answerFloorStandsSql` (the MONEY rule)
  is untouched.
- **credit** — a sealed version credits `calc_versions.sealed_by` at
  `sealed_at`; an answer credits `calc_requests.completed_by` at
  `completed_at`. A return, a «lines» ending and a price-less task close credit
  nobody. The owner's own seals count like anybody's (stated).
- **time to price** — `price moment − r.requested_at` (a correction's
  `requested_at` is the recalc press).

## 3. Item 2 — the goods on the history row (7a)

`/hisoblash/tarix` rows gain:

- **Summary line** «3 tovar: klaviatura, sichqoncha, …» — ONE grouped query
  for the page's rows over `calc_request_items` (first three names by `seq`,
  plus the count), never per row (#432). A closed request's items are frozen
  (every writer refuses `already_closed`), so for a sealed version they ARE
  the breakdown's goods, and for an answer they are the only goods there are.
- **«Tovarlar ▾»** — a client `<details>` that fetches on first open (200
  eager sheets is ~8 000 hidden nodes on a phone, round 68's /stock):
  `GET /api/calc/registry/[requestId]/goods`, gated `mayReadCalcRegistry`,
  minting `calcRegistrySight(actor)` (the sheet door fence,
  `calc-sheet-door.test.ts`, is extended to name the route). It returns the
  sheet projection that already exists (`sheet.ts`, structurally no client
  price):
  - a SEALED version — `breakdown.groups[]`: code, law, value, boj %, QQS,
    yig'im, rastamojka per group, and each group's items (name, qty + unit,
    kg, baza) — the figures AS SEALED;
  - an ANSWER — items from `calc_request_items` with their group's code,
    boj % and baza from `calc_groups`, and **no per-group rastamojka**: an
    answer has no breakdown, and recomputing one would read today's FX and
    today's `bhm_uzs` and print a figure nobody ever gave. The sheet says
    «Umumiy narx — guruh bo'yicha summa yo'q». Ungrouped or uncoded items
    (every Готово job has a blocker, by #880's construction) list with «—».
- **Search** — `q` also matches goods: `EXISTS` over the request's items on
  `name_norm` (the needle normalised with `itemNameNorm`) and, for a needle of
  4+ digits, a TNVED PREFIX on the item's code or its group's code. Inside
  `registryWhere`, so rows and counts agree (#513). The lead-name fence stays
  on every branch (§10 changes WHO is fenced, not that it is fenced).

## 4. Item 3 — answers in the history (8a)

The registry becomes a UNION of two row kinds under ONE `registryWhere`, ONE
order (the price moment, newest first) and ONE `REGISTRY_CAP` (200, said
only when it bites):

| | sealed version | answer |
|---|---|---|
| testid | `registry-row` + `registry-version` «V2» | `registry-answer` (never `registry-version`, so m9zv's `/^V\d+$/` first-row assertion keeps meaning what it says, #154) |
| chip | the chain chip | «✍️ umumiy narx» (+ «o'rniga yangi hisob» when a correction supersedes it) |
| money | `$total`, $/m³, $/kg | `amount currency` as typed (USD/UZS/CNY), no per-unit columns |
| who / when | sealer · `sealed_at` | answerer · `completed_at` |
| notes | — | seller note; internal note for `ved.docs` readers only; an old answer reads «ichki izoh yozilmagan (eski)» |
| V number | rank among the chain's SEALED versions (`treeSql` unchanged) | none — an answer is never V-ranked |

- **Filter «Turi»** `?turi=hammasi|muhr|javob` (validated, garbage → hammasi,
  #514), and **«Kim»** `?ved=<uuid>` over `registryPeople` = DISTINCT credit
  holders of both kinds (replaces `registrySealers`; the old `?ved=` keeps
  working).
- **Counts name three things**: «N ta hisob-kitob · M ta versiya · K ta umumiy
  narx» (#913), jobs counted over the request tree.
- **The hint** (`calc.registryHint` ×4) is wrong today — it says the excluded
  answers were typed «botda», while the amount is typed in the web fold — and
  is rewritten anyway because 8a reverses 1A.
- Raw-execute timestamps are coerced (#923/#925 — a TEXT timestamp is a
  `FORMATTING_ERROR` per row with every test green).
- Partial index (0124) `calc_requests (completed_at DESC) WHERE completed_via = 'task' AND answer_amount IS NOT NULL` for the answer branch.

## 5. Item 3 — the Готово fold and its note (9a, 11a)

- The fold: amount (REQUIRED), currency (USD/UZS/CNY as today), «Sotuvchiga
  izoh (ixtiyoriy)» = `answer_note`, «Ichki izoh — qanday hisobladim
  (majburiy, sotuvchi ko'rmaydi)» = `answer_internal_note`. Controlled inputs,
  held on a refusal (#377/#463). NEW keys — `calc.finish` is also the closed
  chip and `calc.answerNote` the seller's request placeholder, so neither is
  re-texted.
- `finishCalcRequest` refuses, in words ×4:
  - `answer_amount_required` — empty;
  - `answer_amount_unreadable` — today `parseTypedMoney('1200$')` is null and
    the job CLOSES with no price and no error (a live defect);
  - `answer_positive` — 0 or negative (today a 23514 white page);
  - `internal_note_required` — blank after trim (≤ 2000 chars);
  - `seal_instead` — unchanged (11a).
- The internal note NEVER reaches: the `CalcDone` Telegram, the card's 🧮
  panel, the offer text/PDF, the card-entity audit row (sellers read the
  card's History tab). It is written to the column and audited under
  `entity_type = 'calc_request'`. A fence test reads every one of those
  surfaces for the column name.
- 0124: `answer_internal_note text NULL CHECK (answer_internal_note IS NULL OR btrim(answer_internal_note) <> '')`
  — VALID, never NOT VALID: `rekeyLeadCalcRequests` re-UPDATEs every closed
  request of a won lead in ONE statement and its failure is only logged, so a
  NOT VALID check on old rows would silently stop every seal and offer
  following a won lead (#778/#789).

## 6. Item 3 — getting back in, and correcting (10a)

**The closed request page** `/hisoblash/[id]` (read-only, as now) says what
happened and by whom: the header names the ending — «Muhrlangan» (sealer,
time), «✍️ Javob berildi» (answerer, time, amount, both notes), «↩️
Qaytarildi» (who, reason) — with NEW chip keys. The goods show as the frozen
sheet of §3 (today a closed page shows name/qty/TNVED/kg/m³ only, and the
VED's groups, duties and bazas vanish from view).

**Doors back**: the history rows (§4, every row links `/hisoblash/<id>` for
`ved.docs`); a fold «Oxirgi yakunlanganlar» on the queue page (the last 20
closed jobs — sealed, answered, returned — who / when / ending, each a link);
the card panel's «Javob berildi» line gains the answerer's name (the seal line
already prints the sealer to sellers) and a «#» link for `ved.docs`.

**«Qayta hisoblash» on an answered job** — `recalcFromSealed` widens to an
ANSWER parent (`isAnswerSql`) beside a sealed one; same gate
(`admin.settings.manage`, «bir xil qoida»). Refused, in words: an open
parent, a returned parent, a price-less parent (`not_priced`), a parent that
already has an open correction (`recalc_open`) or a standing one
(`recalc_superseded`). Fixed for BOTH kinds while here:

- `requestedBy` stays the ORIGINAL seller (today it becomes the admin who
  pressed, so the corrected `CalcDone` and the discount audience went to the
  wrong person);
- the correction lands in the queue like any request: assigned to the person
  who priced the parent when they can still sign in and hold `ved.docs`, else
  the rota; its task opens through `createTask` with `origin: 'calc'`;
- the seller is told «GS777: narx qayta hisoblanmoqda — eski narx endi amal
  qilmaydi» (new `CalcRecalc` type in `MUTE_GROUPS.tasks`, never `FOUNDERS`).
  That sentence is true by the money rules as they stand: the edge
  supersedes, so the old floor stops standing at the press
  (`answerFloorStandsSql`, `payableOffersSql` — unchanged, proven by tests).

**`chain.ts` `recalc_open`** today = «a child with no version», so a
correction that ends in Готово or a return reads «qayta hisoblanmoqda» for
ever. Now: a child that is still OPEN. A child closed by an answer reads «o'rniga
umumiy narx»; by a return, «tuzatish qaytarildi».

**The card panel** stops letting «any seal» outrank the answer
(`calc-panel.tsx`, `!seal && anchor`): it shows the door of whichever price
STANDS by the chain's edge, so a sealed V1 corrected by a Готово answer
offers the answer, not the dead seal.

## 7. Item 4 — everybody's work, and the totals (12a, 13c)

- Queue: already company-wide with the taker's name — unchanged.
- History: company-wide (unchanged), now with answers and the «Kim» filter.
- **Nazorat**: `calcControlScopeFor` splits into a READ scope
  (`finance.reports` → all, `ved.docs` → **all**, else none) for the three
  lists and `pendingLinkSql`'s list, and the existing WRITE scope
  (`ved.docs` → own) for the link ✅/❌ and `assertMine`, because confirming a
  link scores the colleague. The VED home count «tasdiqlash kerak: N» stays
  own. `calc-control-scope.test.ts` is edited DELIBERATELY (its own-scope
  assertions move to the write scope).
- **Per-VED totals** — a block on top of `/hisoblash/tarix`, «Kim qancha
  hisobladi — oktyabr»: one row per credit holder — muhrlangan N · umumiy narx
  M · o'rtacha vaqt (his 13b names exactly these; an «o'z vaqtida %» column
  was drafted here and CUT, review ved-money-5 — he never asked for it);
  Tashkent month (`tashkentDay()`),
  `?oy=YYYY-MM` validated, default this month. Counts only, never a money sum
  (answers are in three currencies). The queue's «tezlik» block is rebuilt on
  the same function — `calcSpeed` stops crediting the holder and stops
  counting a price-less close; its «ochiq» column stays per HOLDER (that is
  what open means).

## 8. The calc job's task — every door obeys 9a

A calc job is an ordinary task (`createTask`, assignee = the VED), so today
three doors close it with NO price and NO note: the Telegram ✅, the /bugun
and dock ✅, and the card's TasksPanel ✅ — `completeTask` →
`completeCalcForTask` → `endRequest({via:'task'})`. The visibility review
measured worse: after a takeover the PREVIOUS holder's old ✅ still closes the
colleague's job, stamped with the previous holder's name. With 9a the note is
required, and a guard on one screen leaves the action accepting it (#531), so:

- `completeTask` asks, before closing anything, through the existing dynamic
  hook (`platform` never imports `wms` statically): a task BOUND to an OPEN
  calc request is refused `calc_use_screen` — «Hisobni hisoblash sahifasida
  yakunlang» + the link. A bound task whose request is already closed closes
  normally (that is the stale-task path).
- Every task list draws an origin-`calc` task's action as «🧮 Hisobni ochish»
  → `/hisoblash/<bound_id>` instead of the ✅ form, and its about-link goes
  there too — which also ends the VED's dead end: today the link is the LEAD
  card, and the lead page sends anybody without `crm.leads` home.
- The Telegram side (TELEGRAM-TOPSHIRIQ §4): an origin-`calc` task carries ONE
  URL button «🧮 Ochish» and none of ✅ / Natijasiz / 👀 / ⏰ / 💬 — ⏰ would
  move `tasks.due_at` while the SLA sweep reads `calc_requests.due_at`
  (round 28: «the two clocks cannot drift»), and 👀 duplicates «Olaman».
- **Defect fixed on the way**: `releaseCalcRequest` sets `task_id = NULL` and
  reads `taskId` back from `RETURNING`, which on PostgreSQL 16 is the NEW row —
  so the cancel branch is dead and every «Bo'shatish» ever pressed left an open
  priority-1 ghost «Hisoblash: …» on the old holder's /bugun and 08:00 digest
  (gsr_verify holds two). `UPDATE … FROM (SELECT … FOR UPDATE) old RETURNING
  old.task_id`, with a test that a released request's task is `cancelled`.
  The existing `pnpm close-stale-calc-tasks` joins on `r.task_id`, so it cannot
  see the ghosts; it learns them (open, origin `calc`, not pointed at by any
  request) — dry-run by default, `--apply` only on his word.

## 9. Data — migration 0124 (shared with TELEGRAM-TOPSHIRIQ)

`when` 1785190000103; the ledger must reach **125**. Written by the lead
BEFORE either package forks (#1040).

```
calc_requests.answer_internal_note  text NULL  CHECK (… IS NULL OR btrim(…) <> '')
CREATE INDEX calc_requests_answer_idx ON calc_requests (completed_at DESC)
  WHERE completed_via = 'task' AND answer_amount IS NOT NULL

tasks.origin    text NULL  CHECK (origin IN ('hand','calc','calc_return','promise','automation'))
tasks.bound_id  uuid NULL  -- the calc request (origin calc) or the payment promise (origin promise)
  CHECK (bound_id IS NULL OR origin IN ('calc','promise'))
tasks.accepted_at, tasks.reminded_at   timestamptz NULL
tasks.source_messages  jsonb NULL  CHECK (… IS NULL OR jsonb_typeof(…) = 'array')
CREATE INDEX tasks_author_idx ON tasks (created_by, status)

-- backfill, deterministic, open AND closed rows:
UPDATE tasks SET origin='calc', bound_id=r.id FROM calc_requests r WHERE r.task_id = tasks.id;
UPDATE tasks SET origin='promise', bound_id=p.id FROM payment_promises p WHERE p.task_id = tasks.id;
-- and the fixed machine titles the code writes (release ghosts, hand-backs):
--   'Hisoblash: %' → calc (no bound_id), '↩️ Ma''lumot to''ldiring: %' → calc_return
```

`origin` NULL means «before 0124, unknown» and reads as a hand-given task.
`createTask(input, ctx, opts)` takes `origin` as a REQUIRED option — never from
the form schema (a forged post must not mark a task `calc`) — so every caller
turns into a compile error that names itself; a repeat's next occurrence copies
`origin` and `bound_id`.

## 10. Item 5 — the VED on the seller's card (14a 15a 16a)

What is true today, measured: a `ved_manager` (no `crm.leads`) is sent home by
`crm/layout.tsx` from every lead card, so «Kartani ochish» on the queue, the
workspace and the history is a dead end for exactly the person it is drawn
for; on a DEAL card (open to him by `canWriteDeal`) the lenta does not render
(`ClientFeed` asks `crm.leads || clients.manage`) and a note is refused
(`addFeedNoteAction` asks `crm.leads`); the offers list is hidden
(`upsaleScopeFor` = `'none'`).

**ONE door** — `src/modules/wms/calc/card-door.ts`:
`mayOpenCalcCard(actor, {entityType, entityId})` = `ved.docs` AND a
`calc_requests` row exists on that card (any status; `calc_requests_entity_idx`).
Asked by the VED card route, `ClientFeed`, `addFeedNoteAction`, the
`crm_activity` attachment branch, and every «Kartaga o'tish» drawer.

- **Lead** — `/hisoblash/[id]/karta` (the request's own card; a deal request
  redirects to `/bitimlar/<id>`): gate `ved.docs` + the request exists; a
  reader who holds `crm.leads` is sent to the real `/crm/leads/<id>`. It draws,
  read-only: the lead's facts (name, phones, company, source, the seller who
  owns it, stage, next call), «Sotuvchi narxi» (the lead's own quote: summa ·
  kub · kg), the 🧮 panel, the lenta WITH the note box, the Telegram thread
  (no reply box — `replyAccountFor` is own-account), the calls. No ✏️ form, no
  stage mover, no win dialog, no tasks form. The CRM layout is NOT relaxed:
  its gate protects every /crm page.
- **Deal** — `/bitimlar/<id>` as today. On a calc card the lenta now renders
  for the VED and takes his note. The deal card's existing edit powers for
  `ved.docs` (it is in `DEAL_WRITE_PERMISSIONS` on purpose — lines/TNVED,
  receipt linking) are NOT changed this round; stated to him with the list.
- **Lenta note** — `addFeedNoteAction` admits `crm.leads` as now, OR
  `mayOpenCalcCard` on the posted entity (a lead/deal; a `client` entity is
  admitted when the form names the calc request whose card resolves to that
  client). Mentions ping as for anybody (a VED's question reaches the seller
  as `MentionedInNote`). Text only for the VED in v1: the 📎 is not drawn on
  the VED's box (the upload route is not widened), stated.
- **Lenta files** — the `crm_activity` read branch admits `ved.docs` for an
  activity whose entity is a calc card (or that card's client), so the
  seller's photos in the lenta open for the person reading it.
- **Money on the lenta** — `clientFeed(money)` stays the card's own rule
  (`mayOpenClientLedger`).
- **The seller's price (16a)** — a third sight beside `upsaleScopeFor`:
  `offerPriceSightFor(actor)` = the upsale scope's answer, or `'price'` for
  `ved.docs`. `'price'` draws the offers list — client price, currency, date,
  the seller's name, «tasdiq kutilmoqda» — on the card's 🧮 panel and in a
  «Sotuvchi mijozga aytgan narx» block on `/hisoblash/[id]`, and NOTHING else:
  no offer form, no approve button, no offer PDF (its door stays
  `upsaleScopeFor`), no upsale figure, no /upsale, no payout.
  `upsaleScopeFor(ved) === 'none'` stays pinned by `upsale-scope.test.ts`.
- **Lead names on calc surfaces** — every row of the queue and the history is
  a calc card by construction, so `leadsReadable` there becomes `crm.leads ||
  ved.docs`; the accountant (neither) keeps reading «Lid».

## 11. Fences and proofs

- `credit.ts` is the only home of the answer predicate and the credit rule: a
  source fence finds `answer_amount IS NOT NULL` written anywhere else.
- Internal-note fence: the column name appears in no seller-facing file
  (calc-panel, offer text/PDF, CalcDone builder, card audit writers).
- Behavioural, over every seeded role: who sees the internal note (`ved.docs`
  only), who sees offers (`offerPriceSightFor`), who opens `/hisoblash/[id]/karta`.
- Integration: a VED reads a colleague's answer in the history with the
  name; `?turi` and `?ved` filters; counts; the lead fence for the accountant;
  goods search by name and TNVED prefix; recalc from an answer keeps the
  seller and stops the old floor standing; the release cancels its task; the
  task door refuses an open calc job; `'1200$'` and `0` are refused.
- Red proofs by string edit, never `git checkout` (#430).
- Every new export in `workspace.ts` is classified in `calc-clock.test.ts`.
- e2e: m9zo/m9zt fill the internal note; m9zv sees an answer row and the
  «Turi» filter; a VED walks queue → «Kartaga o'tish» → the lead card → writes
  a note → sees the seller's offer price, and is refused the lead's ✏️.

## 12. Never

- The internal note never reaches a seller's screen or Telegram.
- An answer row never carries a V number or a recomputed customs sum.
- The VED never sees an upsale amount or a payout; never edits a lead.
- No per-item money column (#780).
- No new permission code (#170).

## 13. The review before code, and what went back to him

`docs/TOPSHIRIQ-VED-REVIEW.md` holds the five-lens review of this spec and
TELEGRAM-TOPSHIRIQ (115 objections, 88 confirmed, 25 partial, 2 refuted).
Its fixes are BINDING: where a fix there and the text above disagree, the fix
wins. The ones that change the shape of this round:

- **14a on the DEAL card** (access-money-1, a blocker). §10 kept every
  deal-card write the VED has today (`DEAL_WRITE_PERMISSIONS` carries
  `ved.docs`), which contradicts his own «may NOT edit stage, phone, price»;
  and DEALS.md answer 2 (2026-07) says «both the seller and the VED re-price».
  The two answers disagree, so the choice went BACK to him before the build
  (question 17); nothing on the deal card's write side is built until he
  answers.
- **The calc task doors** are keyed on `origin = 'calc' AND bound_id IS NOT
  NULL AND the request is OPEN` (a pointed NULL-origin row counts as bound) —
  an unbound ghost or a task bound to a closed request keeps its ordinary ✅;
  the pre-check sits BEFORE the UPDATE and fails CLOSED; `reassignTask`,
  `rescheduleTask` and `updateTask`'s due change obey it too; the rendering
  depends on the READER (a `ved.docs` reader gets «🧮 Hisobni ochish», everyone
  else keeps the card link and a «VED hisoblamoqda» chip); the fourth door —
  `saveLines` ending an untouched request as 'lines' — no longer ends a
  request that carries a section.
- **Recalc** assigns like the rota (never the owner or an admin), keeps the
  ROOT request's seller, refuses `recalc_returned` in words, and every
  display surface speaks one «stands» vocabulary (`calcRecalcOpen` ×4 stops
  saying «eski narx turibdi»; `ranked0` gains `child_state`;
  `standingAnchorsFor(entity)` feeds the panel, `quoteLockedFor` and the
  «Javob berildi» line).
- **Nazorat**: `calcControlScopeFor` stays the WRITE scope for all six of its
  callers; a new `calcControlReadScopeFor` serves the page's reads; the queue
  splits «Meniki (N)» — N = the home count — from «Hamkasblarniki», read-only.
- **The internal note** has its own sight (`mayReadCalcInternalNote` =
  `ved.docs`, a branded value): the accountant reads the history and never the
  note; the fence works on EXPRESSIONS, not files.
- **Item 5**: `CalcPanel` and `TelegramThread` (read-only, no ThreadCalc) and
  the lead chat pulse join the card door; one `calcCardHref(actor, row)` names
  every link; the VED's note is forced onto the lead/deal entity and is text
  only (the action refuses a pre-bound file id); note and mention pings link a
  recipient to the karta when that is the door they have; the 16a reader is a
  PROJECTION (`offerPricesFor`) that cannot carry a payout; the sight is two
  facts, `{mayOffer, seesOfferPrices}`, never one ranked value.
- **Answers** are `completed_via = 'task' AND answer_amount > 0 AND
  answer_amount <> 'NaN'` (0093's own body); the amount travels as TEXT to
  the server so `answer_amount_unreadable` can exist; the refusal order is
  `already_closed`, `seal_instead`, then the amount, then the note.

Stated to him rather than built: the gross upsale is never PRINTED to the
VED, but client price minus his own floor is one subtraction away; after a
lead is won its lenta (the VED's question and the seller's answer) stays on
the lead, where the VED's door no longer reaches; task files are readable by
everyone who reads colleagues' tasks on /kalendar.
