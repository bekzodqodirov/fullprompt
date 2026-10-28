# Sakkiz band — ROUND 3: the collection survives, the questions are one table, and «➕ Shu so‘rovga qo‘shish»

Build contract for a kernel commit (K, the lead) and six parallel worktree packages:
P1 «Saqlash» (the durable collection), P2 «O‘qish» (the reading on pg-boss), P3 «Jadval»
(the line table, its addresses, the echo and the undo), P4 «Qo‘shish» (the add door),
P5 «Son» (the law's count after the AI answer, and the machine's side of the add door), and
P6 «Ko‘rdim» (the VED's four doors refuse a press made over a screen a seller's addition has
since changed).
This is item 1B of his 2026-10-20 message (`docs/SAKKIZ-BAND.md` §2, the collector's causes
in §1, the plan in §10 «R3») plus his 2.8 b. His answers are binding (§0).

- **Base:** 0373bd2 — round 2 merged (K = 1131998, P1-P4, the merged review §16 and the late
  pass §17, to 89cff69) with the other session's Uch band merged in (a697164;
  docs/UCH-BAND.md; migration 0136; DECISIONS #1469-#1478). Every «today» below is read off
  0373bd2; where this spec and the code disagree, the code wins. Where both rounds touch one
  function, the section names the version on 0373bd2. (re-check laws-print-2)
- **K = e0f9b61 + its review's fixes** (2026-10-28, §17.1): the kernel, three commits on
  r3-work — 1133ecc (K1, K2, K13-K15), dbcb221 (K3-K10) and e0f9b61 (K11, K12, K16) — then
  two lenses reviewed it and «Sakkiz R3 K: the review's fixes — …» (the commit that wrote
  this line, the next code commit after 6754530) fixed what they confirmed; the spec lines
  marked (K-review …) are what changed. Every package branches from THAT commit, not from
  e0f9b61. Gates at e0f9b61 on a database of its own: typecheck, lint, the full vitest
  (726 files, 10717 tests).
- **Migration `calc_intake_durable` is 0138** (K-review spec-5; renamed at the merge of main
  `e669e7d`, 2026-10-28). main had moved past 0136: it holds the other session's `0137_plan_road`
  (`when` 1785190000116, journal idx 137). K took `when` 1785190000117 under the name
  `0137_calc_intake_durable.sql` / idx 137, because the branch had no 0137 of main's and the
  journal fence refuses a hole; the merge of main into r3-work renamed it
  `0138_calc_intake_durable.sql` (idx 138, `when` …117 unchanged). The ledger must reach
  **139**. A «0137» below that names this round's migration means 0138 (the spec's older lines
  are kept as they were judged); every count a person reads after the deploy is **139**. 0136 is
  Uch band's `lead_client_many` (`when` …115, DECISIONS #1469-#1478), one-way. R2 adds none (R2
  §11). (re-check kernel-1)
- **Base after the merge:** main `e669e7d` (PR #127, rounds 1-2 of «Sakkiz band», merged
  2026-10-28) carries R2's late fixes after 0373bd2 — the second merge with main (`69a4330`:
  the other session's offer PDF, download links and road plan, 0137, DECISIONS #1479-#1502,
  which moved R2's decisions to #1503-#1511) and the corpus case c0425's time bound
  (`c2869d4`, 3,000 → 10,000 ms). The code the packages touch is unchanged by it apart from
  `wms.ts`, `workspace.ts` and the journal, which merged cleanly.
- DECISIONS numbers are `#R3-1…`. On 0373bd2 the tail is #1487; main's tail on 2026-10-28 is
  #1511, so round 3 starts at #1512 unless main moves again; the lead renumbers at the merge
  after fetching the tail. (re-check laws-print-3, K-review spec-5)
- **Judged before code** by five lenses (durability, regression, product-fit, law-money,
  performance) with refuters: 87 objections, 63 confirmed, 12 partial, 12 refuted. Every
  confirmed and partial objection is absorbed below; §18 lists each id, its verdict and what
  changed.

## Questions for the owner — ANSWERED 2026-10-27: «14 a, qolgani seni taklifing»

**Binding: 1.14 a (the widening — every unit the law pins is asked), 1.15-1.20 a (the ⭐).**
Question 1's ⭐ now sits on (a), his answer: §10.2.6's `LAW_ASK_UNITS` filter is NOT applied,
and the Kafel row of §10.3 is asked m². (re-check laws-print-23)

His answers 1.8 c, 1.9 a, 1.10 c, 1.11 c and 2.8 b leave seven decisions open that change what
gets built. ⭐ = what is built if he does not answer. The Uzbek wording is in §16.1, numbered
1.14-1.20 to follow his own list.

1. **Which counts 2.8 b asks.** His question 2.8 named dona and juft («qonun dona yoki juft
   so‘rasa»), and his 2.8 b accepted it as worded.
   - a) ⭐ — JAVOB: 1.14 a. Every figure the code's law pins and the row does not state:
     dona, juft, and also kg, m², litr when the law's floor or excise is in that unit. One
     rule with the VED's own chips (`lineNeeds`). This is the WIDENING, and it is what gets
     built. (re-check laws-print-23)
   - b) Only dona, 1000 dona and juft: his 2.8 as he worded it («qonun dona yoki juft
     so‘rasa»). A per-kg floor on a row that states only pieces stays the VED's
     (product-fit-21 starred this; his 1.14 a chose the widening).
2. **What «VED boshlagan» means** (his 1.9 a).
   - a) ⭐ The VED saved anything on the job's screen, or ticked a group's ✅. Pressing
     «Olaman», opening the page or asking the seller a question in the thread does not
     count: none of them changes the job.
   - b) As (a), and also when the VED asked a question in the job's thread.
3. **A TNVED code the seller sends for a row that already has one.**
   - a) ⭐ Not written. It goes to the VED as text («sotuvchi kodi 6402…, so‘rovda
     6403… — VED hal qiladi»). An EMPTY code is filled.
   - b) Written over the row's code, and the AI computes again.
4. **The 2-hour reminder at night.**
   - a) ⭐ Sent without sound between 22:00 and 08:00 Tashkent — the bot's one night
     (`quietHour`), so the reminder is silent exactly when every other silent message is.
     (The first draft said 21:00; a second night window beside the shipped one would
     disagree with every other silent message, #513. re-check laws-print-17)
   - b) Held until 08:00.
5. **When 24 hours pass.**
   - a) ⭐ One line: «⌛ … o‘chirildi». An empty collection (nothing was sent) ends without
     a word.
   - b) Ends silently.
6. **«➕» on a request the VED RETURNED to the seller** («ma’lumot yetishmayapti»). The
   returned request is closed, and the code cannot reopen it (`recalcFromSealed` refuses a
   returned parent: the way on is a NEW request).
   - a) ⭐ «➕» opens a NEW «🧮 Hisoblatish» collection, already filled with that request's
     rows, figures, codes and customer. The seller adds only what the VED asked for, and
     «✅ Tasdiqlash» sends it as a new request, exactly as «🧮» does. Which card it lands on is
     the landing's rule — Uch band's (round 4, shipped, docs/UCH-BAND.md) — not the add
     door's: a coded client's re-send is a NEW deal (a colleague's client: a lead in the
     sender's funnel), a stranger joins the open lead by phone or opens a new one; the
     returned request, its note and its files stay on the old card. In his words: yangi
     so‘rov Uch band qoidasi bo‘yicha yangi bitim bo‘lib ochiladi; qaytarilgan bitim ochiq
     qoladi — kerak bo‘lmasa yopiladi. (re-check laws-print-12)
   - b) «➕» refuses with words, and the seller sends everything again through «🧮».
7. **The re-run's answer to a seller who muted «✅ Mening vazifalarim»** (product-fit-15). R2
   puts the AI answer (`CalcPrefilled`) in that mute group (`MUTE_GROUPS.tasks`,
   mutes.ts:42-50; /profile's `notifMuteTasks`), so a muted seller never sees it. After
   «✅ Qo‘shish» he has just asked for a re-run, and the words promise «natija shu yerga
   keladi». (re-check laws-print-5)
   - a) ⭐ The answer to a re-run HE started with «✅ Qo‘shish» reaches him in the chat even
     when the group is muted, exactly as the reading after «Bo‘ldi» does (§7.2.5). Every
     other AI answer keeps his mute.
   - b) The mute holds for the re-run too, and the words after «✅ Qo‘shish» say so: «natija
     kartadagi lentada; AI javoblari o‘chirilgan bo‘lsa chatga kelmaydi».

---

## 0. His answers, and what each one becomes

| # | His answer (binding) | What is built | Package |
|---|---|---|---|
| 1.8 **c** | An unfinished collection waits 24 hours; after 2 hours the bot asks «davom etamizmi?». | The collection is a ROW (`telegram_calc_intakes`), written behind memory like 0130's waits and hydrated before the first `getUpdates`, so a deploy loses nothing. TTL 24 h from the seller's last action; one reminder after 2 h idle, with «▶️ Davom etamiz» / «✖️ Bekor qilish». **It waits, but it does not hold the chat**: after 30 minutes idle (`HOLD_MS`, today's TTL) it is PARKED. A parked collection takes no free text, file or contact, so lookups, notes, tasks and the assistant work again. It resumes on «▶️ Davom etamiz», on its own buttons, or on a reply to its own table or echo. Every applied message is recorded by its Telegram id (`takenUpTo`), so a redelivered message is applied once. A backlog message dated after a hydrated collection opened, while it was holding, is that collection's (Q5 a). | P1 |
| 1.9 **a** | Information after the job landed: VED not started → added to the same job and the AI computes again; VED started → it goes to the VED as text. | «➕ Shu so‘rovga qo‘shish» opens an ADD collection on the stored request. «✅ Qo‘shish» enqueues a durable job (`calc.amend-save`) that runs ONE writer (`amendRequest`). Four outcomes: <br>• **open** — nobody but the machine and this seller has moved the request (`handsoff_rev = rev`, judged by `prefillStanding`). The change goes into the rows under a compare-and-set and the AI pass is queued again. <br>• **started / closed** — nothing is written; the change goes to the job's thread for the VED, in words. <br>• **waiting** — a machine pass is still running. The addition is STORED and written by the job itself the moment the pass ends, so the promise «AI tugatgach yoziladi» is kept. <br>• **noted** — a file or text that changes no row: it goes onto the card and to the VED, with no write and no re-pass. | P4 + P5 |
| 1.10 **c** | The questions are ONE table (every line ✅/⚠️); the seller fills any line in one message. | After the reading, the bot sends one table message: every line ✅ or ⚠️ with the reason under it, the totals rows, and how to answer. It is EDITED in place as answers arrive. Every echo that wrote something says what is still missing and carries the confirm button. The one-line-at-a-time loop, its three-round cap and «⏭» per line are retired. | P3 |
| 1.11 **c** | A line is named by its number OR its name; the bot echoes «3-qator Sumka: 50 dona yozildi» with a «bekor» button. | One pure address parser (`parseTableAnswer`): a number («3:», «3.», «3 -», «3-qator», «3-qatorga»), a name (folded, Cyrillic→Latin, unique match), or a totals word («jami»). A stored row's number is its `seq`, the same number the VED's screen and the 2.8 b ask print. Several lines in one message. A short answer that carries a unit («40 juft») goes to the one open row it fits. Every answer message, and every offer button pressed, gets ONE echo listing what it wrote, with «↩️ Shu javobni bekor qilish». | P3 |
| 2.8 **b** | After the AI answer, when the code's law asks a count the seller did not give, the bot asks exactly that number and computes again. | The AI answer carries a «❓» block naming each such row by its `seq` and unit (never cut by the 4096 fit). The seller answers by REPLYING to that message, or presses «➕ Shu so‘rovga qo‘shish». Both open the add collection on that request. There an unaddressed answer goes to the ASKED rows first, and a unit picks among them («40 juft» → the juft row). «✅ Qo‘shish» writes them and the pass runs again. | P5 + P4 |
| proposal 2 (accepted) | «➕ Shu so‘rovga qo‘shish» under the ✅ and under the AI answer. | Under the landing's ✅ (when the job reached the queue) and under every machine message about a request that is not closed: the reply, «hisoblay olmadi», and the stand-downs except «yopilgan». On a request the VED returned, «➕» follows Question 6. And where extra information actually arrives (product-fit-16): a FORWARD gets «➕ {card} so‘roviga qo‘shish» beside Door B's «📌 Topshiriq qilamizmi?», and a plain photo or file sent with nothing open gets one offer line, while the seller has an open request he sent in the last 7 days. The press takes that very message as the add collection's first material. | P4 + P5 |
| proposal (accepted) | The intake reading on pg-boss. | «Bo‘ldi» enqueues `calc.intake-read` and returns. A job reads the stored files (the model-sized copy saved at arrival), calls the model, settles against the live collection, stores its reply durably, then sends it, all under ONE wall clock that ends before pg-boss's expiry. A deploy mid-reading re-delivers the job. Four workers. | P2 |
| 1.12 **a** ⭐ | Voice: «yozib yuboring». | Unchanged. Also inside an add collection. | — |
| 1.13 **c** ⭐ | A second invoice is asked. | Unchanged. Also inside an add collection. The same file redelivered is not a second invoice: it is the same message id and the same attachment. | — |
| Q5 **a** ⭐ | Backlog messages after a restart are processed, never by the AI. | A hydrated collection takes the backlog dated after it opened and while it was holding. A message it already applied (`takenUpTo`) is dropped silently. Destructive presses act only on their own collection. Everything else keeps 0130's rules. The orphan-answer guard (R2's, widened) keeps a lost answer from the paid assistant. | P1 + P3 |

### 0.1 Interpretations stated to him (in the round's Uzbek report, §16)

1. **«VED boshlagan» is read off the revision clock** (⭐ of Question 2). Every write a
   person makes on the job's screen moves `calc_requests.rev`. Each save of the machine's
   pass, and each of the seller's own additions, moves `handsoff_rev` along with `rev` in
   its own transaction, so a pass cut off half-way leaves no false «started». «Not started» is
   `handsoff_rev = rev` and no group ✅. The VED's «Olaman», opening the page and a thread
   question move nothing. A request landed before this deploy has no stamp and reads as
   «started»: its additions go to the VED as text.
2. **The add door never writes a price, a rate, a zone or a certificate.** It writes the
   seller's figures (count, weight, volume, m²/juft/litr), an empty code, new goods lines,
   and the totals or cities only when they are answered in the table («jami 3500 kg»).
   Totals the reader finds in new material are NOT written: a packing list sent as a
   top-up may be the top-up's own totals or the whole truck's, and nobody can tell which.
   One total follows by ARITHMETIC: when the stored m³ is the Σ of the lines (R2's 2.7 b),
   it stays that Σ after the addition. A total that was TYPED is not re-derived. When lines
   were added and it is not re-answered, its row is ⚠️ («yangilansinmi?»), and the re-run
   reply does not price the road on it. Brutto has no Σ rule, so an added line always asks it.
3. **A table answer is never material.** In the table stage a typed text is an answer or
   it is refused in words. A short text with a unit and no goods name («40 juft», «3500 kg»)
   is an ANSWER, to the one open row it fits. Only a forward, a file, «➕ Yana ma’lumot», or a
   typed goods list of several lines whose names meet no row becomes material. This closes
   the defect the line-table scout reproduced: «3: 50 dona\n5: 20 kg» typed after the summary
   became a 20 kg shipment on the next «Bo‘ldi». A numbered list of OTHER goods
   («1. Kurtka 300 dona») never overwrites rows 1 and 2: a number whose words name a
   different row is asked, and in the material stage only «N:» and «N-qator» address a row.
4. **«Bekor» undoes what ONE message wrote**, while the collection is open. After
   «✅ Tasdiqlash» or «✅ Qo‘shish», the change is on the job and the seller changes it with
   another «➕». The button under an echo then answers «Bu tugma eskirgan».
5. **The 2.8 b count is asked once per AI answer, not in a loop.** If the seller answers
   only some rows, the pass runs again and its answer asks the rest.
6. **The reminder is the person's own work and does not go through notification mutes.**
   A muted «✅ Mening vazifalarim» group still gets the reminder: it is about a collection he
   is holding open. The AI answer stays in its mute group, as in R2, with one exception under
   ⭐ of Question 7: the answer to a re-run he started himself with «✅ Qo‘shish» reaches him
   like the reading does. It still goes through the notification DRAIN, never a second
   sender: its one claim row is queued `pending` with `direct: true` instead of `muted`
   (`StaffTelegramInput.ignoreMute`, set only by `sayOnce`'s `direct`), the drain sends it
   with its 429/botDown pauses and writes `payload.tg` as for every sent row, so a reply to
   it reaches the reply door like any sent ping (no reply-door change). (re-check
   laws-print-5, laws-print-6)
7. **«Waits 24 hours» does not mean «owns the chat for 24 hours».** After 30 minutes
   without his action the collection is parked. It is still there, the 2 h reminder still
   comes, and «▶️ Davom etamiz», any of its buttons, or a reply to its table brings it back.
   Meanwhile a typed «GS777», a note name, «➕ Topshiriq» and the assistant work as if no
   collection existed. A table-shaped text («3: 50 dona») sent while it is parked gets one
   line saying the collection is paused, with the resume button. It is never silently added.
8. **When the AI is still computing, an addition waits for it.** «✅ Qo‘shish» stores it, the
   seller is told it will be written when the AI finishes, and the job writes it then: into
   the rows if the VED has still not started, otherwise to the VED as text. Nobody presses
   anything a second time.
9. **A file that changes no row is not an addition to the numbers.** It goes onto the card
   and to the VED («sotuvchi fayl yubordi — qatorlar o‘zgarmadi»), and the AI does not
   compute again for it. A file that states a DIFFERENT figure for a row already on the job
   («faylda 200 dona, so‘rovda 300») makes that row ⚠️ and asks with his own 1.13 c buttons:
   «qo‘shilsin» (500), «o‘rniga» (200) or «VED hal qilsin». A second factory's top-up is the
   commonest case, so adding them up is offered first. Left unanswered, the VED decides. It
   is never dropped and never written on its own (product-fit-17).
10. **The VED's screen cannot be overtaken silently.** If a seller's addition was written
    after the VED opened the page, «Готово», a group's ✅, «✅ Hammasini» and «Muhrlash»
    refuse: «Sotuvchi qo‘shimcha yubordi — sahifani yangilang». His own saves never trigger it.
11. **A landing cut off halfway is finished, not dropped.** If the note reached the card but
    the request did not reach the VED's queue (a crash between the two writes), the next
    sweep or the next «Tasdiqlash» completes it on the SAME card — Uch band's landing is
    already idempotent by note (`cardOfNote`, `rootRequestOfNote`) — and says the landing's
    ✅ with Uch band's retried words («✅ Saqlandi — oldingi urinishda ochilgan …»).
    (re-check laws-print-10)
12. **«✖️ Bekor qilish» asks once when there is something to lose** (product-fit-12). A
    collection now holds up to a day of files and answers, so from the table, the add table
    or an echo the press first says what goes («3 ta xabar, 2 ta fayl o‘chadi») with
    «🗑 Ha, o‘chirish» / «▶️ Yo‘q, davom etaman». From the reminder or the pause notice, which
    ask «davom etamizmi?» themselves, it ends at once. The undo under an echo is now called
    «↩️ Shu javobni bekor qilish», so it cannot be read as the other one.
13. **The echo says what will really happen.** When the VED has already started on the job,
    the add collection's echo says «📝 VED ga yuboriladi» and its button is «📨 VED ga
    yuborish», not «yozildi» / «✅ Qo‘shish» (product-fit-18). A figure the code's law drops
    on save («40 juft» on a row whose law needs no juft) is named «yozilmadi» in the words,
    never «yozildi» (regression-16).

---

## 1. Laws this round keeps (and the fences that hold them)

- **Law 1, the model never reaches a number.** Unchanged. The add door adds no
  `baza_source` value and posts no `bazaUsd`, rate or zone (§9.7 fence). The re-run pass is
  R2's pass: memory → dictionary → import → model pick by index.
- **The machine never writes over a person.** Every machine save carries the revision the
  machine's own previous write left (R2's K14 chain), and the chain STARTS from the job's
  ticket, never from a second read (law-money-2). R2's late pass (P1-R2) already built the
  chain end to end: `aiPrefill(…, { expectCustoms, expectRev: data.rev ?? null })`
  (jobs.ts:295), and the claim (`proposeGroups`, workspace.ts:2941), `applyProposal`
  (:1663), `pullRatesFromDictionary` (:1321, through `setGroupRates`' `mutateRequest`) and
  `priceProposedGroups`' `saveTable` (:3173) each take `expectRev`; the claim and
  `applyProposal` return their own `rev`, `pullRatesFromDictionary` returns nothing and its
  caller counts its one revision (`chain += 1`, :3211). This round adds only `handsOff`
  beside each `expectRev` (K15) and deletes the two `prefillTicket` fallbacks (prefill.ts:327,
  :411), so a job with no ticket rev runs with no chain. (re-check laws-print-15)
  `amendRequest`'s save carries `expectRev = handsoff_rev` and, per row, `expect` = the
  values read at save time. A person's save in between turns it into the VED branch, never
  into a write.
- **The hands-off stamp moves inside the save that earns it.** Every machine save, and the
  add door's save, advances `handsoff_rev` in its OWN transaction, from the revision it
  expected to the one it wrote (`advanceHandsOffInTx`, one home). A pass killed mid-way
  leaves the stamp at its last committed write, never behind it (durability-6). The
  worker's settle only clears the ticket.
- **The seller never writes over the VED** (his 1.9 a): the standing is read at save time,
  under the same compare-and-set, never trusted from the moment the door opened. The VED's
  four official doors refuse a press made over a screen a seller's addition has since
  changed (P6).
- **#714.** Every pool read runs before a transaction. `amendRequest`'s in-transaction hook
  (`inTx`) touches only `tx`, and so does the thread writer it calls (§9.7 fence). The
  reading job reads storage and the book's laws before it settles. The store's write chain
  runs on the pool and never inside a transaction.
- **#706.** Nothing long is awaited on the poller. The reading is a pg-boss job, and so is
  the add door's save (`calc.amend-save`). Each press awaits only THIS chat's write
  (`flushIntakeWrites(chatId)`) and `enqueue` (one insert), never another chat's pending
  write (performance-10). The reminder runs in a pg-boss sweep. The table edit after an
  answer is dispatched per chat, latest wins, and an identical text is never sent.
  `storedRequestFacts`, which the press and the reply door await, is at most four
  statements and never `loadWorkspace` (performance-9).
- **Q5 a.** Every effect that a redelivery or a repeated tap could repeat has a key or a
  compare-and-set:
  - a collector MESSAGE (text, file, contact, a reply that opens or resumes it): the
    collection's `takenUpTo`, the highest Telegram message id it applied. It is written in
    the same state as the effect, so a write lost in a crash is redone and a write that
    landed is not. A file's attachment id is `uuidv5(noteId:messageId)`, so a re-run never
    mints a second attachment;
  - a collector PRESS: `cert_y`/`cert_n` SET the answer (no toggle). `cancel`, `cancel_y`,
    `save`, `more`, `done`/`reread`, the conflict buttons and the cert pair act only on the
    collection whose message carries the button; `pick_N` only from the message that drew
    the live offers (regression-23). A restart (`go_*`, `cg:`) that would open the collection already
    live RESUMES it (`pressKey(…, 'restart')`);
  - the landing: Uch band's own idempotence by note — «landed» is a root `calc_requests`
    row carrying the note id (`rootRequestOfNote`, intake-land.ts:216), and the note's card
    is `cardOfNote` (:178, sender-fenced, outcome `'retried'`). A note with no request is a
    landing cut off halfway; the sweep or the next press FINISHES it by calling
    `landCollectedIntake` → `landIntake` again with the same collection, which lands on the
    note's own card. K2's per-note advisory lock, first in `openCalcRequest`'s transaction,
    keeps two concurrent finishers to one request (`rootRequestOfNote` is a pooled
    pre-check). No second «card of the note» reader (re-check laws-print-10);
  - the add door's save: `calc_amendments.note_id` UNIQUE, inserted in the save's own
    transaction together with the job's thread message and, right after that INSERT returned
    a row, the card note (`insertActivityTx`). A repeat finds it and redoes only what is
    missing: the re-pass, the ping, the seller's words (re-check laws-print-13);
  - a reading: its token, then its stored reply; a second run of the same token in one
    process stands down. A stored reply that a Telegram flood wait kept from delivery is
    sent by a delivery-only follow-up at Telegram's `retry_after`, and the sweep's
    `deliver_pending` is the net; the reading itself is never re-run for it (durability-16);
  - the add door's job: an in-process set of note ids in flight (a second run of the same
    note in one process returns); the card note is written only after `calc_amendments`'
    INSERT returned a row, in that transaction, so its primary key never collides and no
    `ON CONFLICT` seam is needed on `addActivity` or `insertActivityTx` (durability-15;
    re-check laws-print-13);
  - a job fetched before this process hydrated: it waits for the hydrate (bounded) and reads
    MEMORY only, never the table, so it can neither miss a collection nor resurrect an ended
    one (durability-9, performance-7);
  - the stop: an update whose collection change is not yet written is NOT confirmed, so it
    is redelivered and applied once (durability-10, regression-25). This holds only while
    grammy is still inside that update's batch: once a batch ends, grammy's next
    `getUpdates` confirms every update of it, and nothing can un-confirm one. So the
    collector WRITES a message's change before its handler returns (P1, §6.2.2), and an
    unwritten change of an update already confirmed is logged lost by the stop, never
    claimed (K-review spec-2);
  - an undo: the echo's `undone` flag;
  - a machine message: `sayOnce(requestId, pass, input, opts)`, per pass — `pass` positional
    (`'landing'` for the landing's pass; every row written before this round coalesces to
    it), R2's `whileOpen` (CONC-1), the CONC-4 holder row and the perf-5 floor kept
    (re-check laws-print-4).
- **A refusal is words.** Every new union has a `Record<Union, string>`:
  `AmendOutcome['kind']`, `AmendStanding`, `TableRefusal`, `SweepAction`,
  `SaveTableRefusal` (`AMEND_REFUSAL`). A missing entry is a compile error. The VED's new
  refusal is `calc.errors.amended_since` in all four bundles — a runtime key, so the fence is
  `tests/unit/calc-error-words.test.ts` (every literal `new CalcError('…')`), never
  i18n-keys.test.ts (re-check p5-p6-17).
- **Telegram's 64-byte `callback_data` parses.** Four new prefixes (`ca:`, `cg:`, `cu:`,
  `cf:`) and new calc steps (`resume`, `cert_y`, `cert_n`, `cancel_y`, and the conflict
  family `conf_N_add` / `conf_N_rep` / `conf_N_ved`). The derived fences
  (`topshiriq-buttons.test.ts`, `calc-intake-lines.test.ts`) read every new collector file
  (K16). Every calc step has a redelivery class: `CALC_STEP_REPEAT: Record<CalcStep, …>`, so
  a step with no class does not compile; redelivery-wire.test.ts (10) is re-anchored to it,
  no second test (re-check kernel-18).
- **#513, one home per rule.**

  | Rule | Its one home |
  |---|---|
  | Is there a live collection | `calc-store.ts` `activeIntake` |
  | Does it hold the chat (not parked) | `calc-store.ts` `intakeHolds` / `holdingIntake` — asked by the ladder and by every door that refuses beside a collection (task draft, zametka «Yangi», 💬, a shared contact) |
  | Has a collection expired, and who says «⌛ … o‘chirildi» | `calc-store.ts` `expireIntake` — the sweep AND a read that finds it expired both end it through this one function, which sends the line (durability-12) |
  | May a job read the store yet | `calc-store.ts` `intakesHydrated(timeoutMs)` |
  | Which update's collection change is not yet written | `calc-store.ts` `oldestUnwrittenUpdate()` — the stop confirms only before it |
  | What a backlog text with nothing to take it is told | `backlog.ts` `backlogSentence(hasCollection)`; `tellBacklogOnce` decides it itself from `collectionSurvived(chatId)` (a live collection opened before this boot), no caller changes (re-check p1-p2-6) |
  | Does a message belong to it, and was it applied already | `calc-store.ts` `intakeTakes` → `'take' \| 'seen' \| 'pass'` |
  | Does a press act on this collection | `calc-store.ts` `ownsPress(state, pressedMessageId)` |
  | When to remind, when to end, when to resume a cut-off landing | `calc-intake-sweep.ts` `sweepAction` (pure) |
  | What the seller is shown after a reading or an answer | `calc-dialog.ts` `intakeNextStep` (pure) |
  | The table's rows | `intake.ts` `intakeTableText` (pure) |
  | A row's number | `TableRow.no`: `seq` for a stored row, position for a new request's line, `max(seq)+k` for a line an add collection adds |
  | How a typed answer names its row | `line-address.ts` `parseTableAnswer` (pure) |
  | The words a totals answer may start with | `line-address.ts` `TOTALS_WORDS` — the table's own labels included; the parser and the orphan guard ask the same list (product-fit-14) |
  | Is a text table-shaped (for the pause line and the orphan guard) | `line-address.ts` `looksLikeTableAnswer` = `totalsAnswerShape(text) === 'worded'` ∨ a totals word + figures ∨ `looksLikeLineAnswer` (every segment an address + figures, regression-21); a BARE figure is R2's REG-3 shape, answered apart (§2.8). The totals-shape helpers move verbatim to the zero-import `platform/telegram/totals-shape.ts` (re-check laws-print-8) |
  | Which totals rows are ⚠️ | `tableRowsOf`: `missingFields` minus `LINE_FIELDS` on every section (regression-22). R2's `totalsQuestion` is retired (§8.2 rule 1); an unaddressed bare figure goes to the single open totals target by its own unit (re-check p3-5) |
  | Where an answer lands after a re-read, and the index it then carries | `calc-intake.ts` `placeByName` (pure; its placement is written back) |
  | Fit to Telegram's 4096 | `fit-telegram.ts` `fitTelegram` (moved by K from R2's `ai-reply.ts`, which re-exports it with `TELEGRAM_LIMIT` and `MAX_REPLY_LINES`; `maxLines` an option) (re-check kernel-26) |
  | A stored request's rows, laws and stamps | `service.ts` `storedRequestFacts` (K; ≤ 4 statements, never `loadWorkspace`) |
  | A row's group law | `needs.ts` `groupLawsOf` (K, lifted from `/hisoblash/[id]/page.tsx`) |
  | What a stored request still owes (⚠️ rows, the 2.8 b asks, the card form's ✅) | `lineNeeds` over `storedRequestFacts` (`lawAsksOf` filters it) |
  | Has a person moved the request since the machine | `prefillStanding(id, handsoff_rev)`, asked by `amendStanding` |
  | Is a machine pass owed or running | `amendStanding`'s `busy` clause: a ticket whose pg-boss job is alive (`jobState`) |
  | The hands-off stamp | `advanceHandsOffInTx` (inside every machine save and the add door's save); `openCalcRequest`'s INSERT writes 0 |
  | What the add door writes, and how a number reaches its column | `amendDiff` (pure, every line and unit/code answer through `doorRow`) + `amendRequest` (the one writer) |
  | Which totals an addition leaves stale | `amendTotalsStale` (pure) — the add table, `amendDiff` and the re-run reply read it |
  | One machine message per PASS | `sayOnce(requestId: string, pass: string, input: StaffTelegramInput, opts: { whileOpen?: boolean; direct?: boolean } = {}): Promise<boolean>` — the seam is K15's; `claimed()`'s WHERE gains `coalesce(payload->>'pass', 'landing') = ${pass}` (re-check laws-print-4) |
  | Does the re-run's answer reach a muted seller | `sayOnce`'s `direct` → `StaffTelegramInput.ignoreMute`: `queueStaffTelegram` writes the muted requester's row `pending` with `direct: true` and the DRAIN sends it; set only for an `amend:*` pass (⭐ of Question 7) (re-check laws-print-5) |
  | How a stored row and a re-read file disagree, and what the seller may answer | `amend.ts` `conflictOf` → `IntakeState.conflicts`; the answers `conf_N_add` / `conf_N_rep` / `conf_N_ved` or a typed figure (product-fit-17) |
  | Where a plain forward or file meets the add door | `calc-amend.ts` `addOfferRows` (Door B's keyboard) and `offerAddForMedia` (the media handler) |
  | Which machine messages carry ➕ | `addFor(standing)` in `jobs.ts` |
  | A reading's bill | the reading job, once the model answered (`recordAiPass` with `intakeNoteId`, `createdAt = new Date(u.at)` — R2's concurrency-11 day, `AnsweredUsage.at`); `attachIntakePasses` at landing. The ledger alone counts readings from then on: P2's same commit deletes the collector's `- state.usages.length` (calc-intake.ts:1483) and the landing's per-usage loop (intake-land.ts:574) (re-check laws-print-14) |
  | Did a note's landing happen, and on which card | Uch band's `rootRequestOfNote` / `cardOfNote` (intake-land.ts:216, :178); P1's `landingState` composes the two and has no SQL of its own (re-check laws-print-10) |
  | Did a seller's addition land after the VED's screen was drawn | `amendedSinceSql(requestId, sawRev)` (P6), asked by the four VED doors |

- **Footguns.**
  - drizzle numeric comes back as a string: `Number()` every read.
  - Dates in raw SQL are ISO text cast `::timestamptz`.
  - JS arrays go through `inArray` / `sql.join`.
  - `to_jsonb` / raw `db.execute` timestamps are TEXT.
  - A Buffer never reaches the jsonb (K4 stores attachment ids).
- **Process.**
  - Red proofs are made and undone by string edit only (#430). Never `git checkout` or
    `git stash`.
  - Each gate runs with its own exit code (#803).
  - Run `pnpm typecheck` before every commit.
  - The model identifier is never written anywhere.
  - Trailers as in the history.

---

## 2. What the bot prints — exact Uzbek

Apostrophes as the collector already writes them: `o‘`, `g‘`, `so‘rov` with U+2018;
`ma’lumot` with U+2019. Plain text, no `parse_mode`, unless a line says otherwise.
`{SECTION}` = `SECTION_LABEL[section]` (`🛃 Rastamojka`, `🚚 Yo‘lkira`,
`🔑 Podklyuch (yo‘lkira + rastamojka)`). `{mijoz}` = `intakeClientSummary(clientHintRaw)` or
`mijoz hali yozilmagan`. `{card}` = the request's card label (deal code, or the lead's name).

### 2.1 The table (P3) — replaces `intakeSummaryText` as the message after a reading

A new request:
```
🛃 Rastamojka
Mijoz: GS777 · Ali aka
Fayllar: 2

Tovarlar (4):
✅ 1. Kurtka qishki — 300 dona · 150 kg · 6201400000
⚠️ 2. Krossovka — 12.5 kg · 6403990000
   ↳ juft soni — boj kamida $3/juft
✅ 3. Sumka — 50 dona · 20 kg
⚠️ 4. Shapka
   ↳ soni (dona) yoki sof og‘irligi (kg)

Umumiy:
⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan
✅ Hajm: 12 m³ (qatorlardan)

⚠️ 2 ta qatorda va umumiyda ma’lumot yetishmayapti.
✍️ Bir xabarda istalgan qatorni to‘ldiring: «2: 40 juft», «Shapka 30 dona» yoki «jami 3500 kg».
Bir nechta bo‘lsa — har birini alohida satrga yozing (yoki «;» bilan).
Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham bosishingiz mumkin.
```
(product-fit-19 a: «qator» named both a table row and a text line, and on Telegram Desktop
Enter sends; «satr» is the text line, and «;» splits a segment like a newline does.)
- A row: `{✅|⚠️} {n}. {clipText(name, 40)}` + ` — {lineFiguresText}` when it states any
  figure + ` · {tnvedCode}` when coded. `{n}` is `TableRow.no`: the line's position in a new
  request; a stored row's `seq` in an add collection (gaps after a VED deletion stay gaps:
  1, 3, 4 — the same numbers the VED's screen and the 2.8 b ask print); a line the add
  collection added is `max(seq) + k`.
- Under a ⚠️ row: `   ↳ ` + the row's needs joined by `; `, each
  `${needWhatUz(unit)} — ${needWhyUz(need)}`. A row that states nothing reads
  `soni (dona) yoki sof og‘irligi (kg)`: `lineNeedText`'s any-measure branch VERBATIM
  (`needWhatUz('dona') yoki needWhatUz('kg')`, and `needs.ts` spells kg «sof og‘irligi»).
  The first draft dropped «sof», so the row's netto read like the table's brutto total
  (product-fit-19 c).
- On a freight-only section the line rows carry no mark and no ↳ (`lineNeeds` is empty
  there): `· {n}. {name} — {figures}`.
- `Umumiy:` lists every non-line field of `REQUIRED_FIELDS[section]` (ONE home, regression-22:
  `missingFields` minus `LINE_FIELDS` decides which totals rows are ⚠️ on EVERY section,
  rastamojka included, where MR-9 asks brutto and m³; R2's `totalsQuestion`, which said
  «rastamojka never asks», is retired with its readers — an unaddressed bare figure goes to
  the single open totals target by its own unit, re-check p3-5), in this order:
  - weight: `✅ ${weightLabel(section, facts)}: {kg} kg` (R2's PF-1/PF-3 label, intake.ts:729
    — the one the lenta note prints; never a fixed «(brutto)») /
    `⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan` (`FIELD_LABEL.weightKg`); a
    doubted weight reads the doubt row below. (re-check laws-print-9)
  - volume: `✅ Hajm: {m3} m³` + ` (qatorlardan)` when R2's `factsVolumeM3` derived it /
    `⚠️ umumiy hajmi (kub) — yozilmagan`;
  - non-rastamojka: `✅ Yo‘nalish: {from} → {to}`, or one `⚠️ qaysi shahardan — yozilmagan`
    / `⚠️ qaysi shaharga — yozilmagan` per missing end.
  - `goods` (in `REQUIRED_FIELDS` on every section) is not an `Umumiy` row: with no line
    read, `Tovarlar (0):` is followed by `⚠️ tovar nomi — yozilmagan` (`FIELD_LABEL.goods`),
    and the closing line is
    `⚠️ Tovar nomi yozilmagan — tovarlarni «➕ Yana ma’lumot» bilan yuboring.`
    in place of the count line and its `✍️` examples (no row to build them from; in the table
    stage a typed text is an answer, §0.1(3), so goods arrive through «➕ Yana ma’lumot»).
    (re-check laws-print-21)
- The doubts are R2's `TotalDoubt` (`AmbiguousTotal | ContradictedTotal`, intake.ts:656;
  `IntakeState.ambiguousTotals`, CONC-2), each printed by `ambiguousTotalText` on its own `⚠️`
  line after `Umumiy`, unchanged. A totals field a `TotalDoubt` names reads
  `⚠️ ${FIELD_LABEL[field]} — ikki xil yozilgan (pastda)` instead of `— yozilmagan` (e.g.
  `⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — ikki xil yozilgan (pastda)`): a doubted
  field is EMPTIED by `factsWithAnswer`, and «yozilmagan» would be false about a figure the
  seller did write. The doubt's own line follows. (re-check laws-print-22)
- Closing line:
  - every row ✅ → `✅ Ma’lumot to‘liq. Tasdiqlaysizmi?`;
  - otherwise the count line, built from the counts: `⚠️ {k} ta qatorda ma’lumot yetishmayapti.` /
    `⚠️ Umumiyda ma’lumot yetishmayapti.` / `⚠️ {k} ta qatorda va umumiyda ma’lumot yetishmayapti.`
    — then the two `✍️` lines, then the «Bilmagan qatoringizni VED to‘ldiradi …» line (⏭ is
    gone, and nothing else tells him he may confirm with gaps; in an add collection it names
    «✅ Qo‘shish»). The examples are built from THIS table: the first ⚠️ line's
    number and its first unit (`figureLabel(300|150, unit)`), the first ⚠️ line's first name
    word, and `jami 3500 kg` only when the weight row is ⚠️ (else `jami 12 kub` when only
    the volume is).
  - In an add collection, two more ↳ reasons can make a row ⚠️:
    - a CONFLICT (law-money-5, product-fit-17): the new material restates a stored row with a
      different figure, or with a figure in a field the row has empty —
      `   ↳ faylda 200 dona, so‘rovda 300 — qo‘shilsinmi (500), o‘rniga (200) yoki VED hal qilsinmi?`
      / `   ↳ faylda 120 kg, so‘rovda og‘irlik yo‘q — yozilsinmi yoki VED hal qilsinmi?`.
      The add table's keyboard carries, per conflict (at most 3; more are answered by typing),
      one row of buttons: `➕ 3-qator: 500 dona` (`c:conf_N_add`), `🔁 3-qator: 200 dona`
      (`c:conf_N_rep`), `📨 3-qator: VED` (`c:conf_N_ved`). An empty stored field offers only
      `✅ 3-qator: 120 kg yozilsin` (`rep`) and `📨 VED`. A typed «3: 500 dona» resolves it too.
      A press goes through `applyTableAnswer`, so it gets an echo and its ↩️. `N` is the
      conflict's index in `state.conflicts`, judged against the live list (`'own'` + the
      table's own message, §8.2.6);
    - a STALE TOTAL (law-money-1, `amendTotalsStale`): lines were added —
      `⚠️ umumiy brutto og‘irligi (kg) — yangi tovar qo‘shildi, yangilansinmi? «jami … kg»` /
      `⚠️ umumiy hajmi (kub) — yangi tovar qo‘shildi, yangilansinmi? «jami … kub»`. A stored
      m³ that is the Σ of the lines is re-summed instead and stays ✅ with ` (qatorlardan)`.
- Then, unchanged from today's summary, each on its own block: the bot's `notes`, the AI
  failure words (`AI_READ_FAILURE[failure].text` + «Faqat Excel va yozilganidan o‘qildi.» /
  «Faqat yozilganidan o‘qildi.») or `aiStepsText(steps)`, and on the AI door
  `📄 Sertifikat: bor|yo‘q (o‘zgartirish uchun tugmani bosing)`.
- **Over 4096** (the probe: ten 227-character names make today's summary 4,711 characters):
  every ⚠️ row is always shown. ✅ rows are shown while `fitTelegram` fits; the rest
  collapse into one line `✅ yana {n} ta qator to‘liq: 1, 3, 5–9, 12` (number ranges). Next,
  ⚠️ rows that share an IDENTICAL ↳ lose their own ↳ and get one grouped line under the
  last of them: `   ↳ 3, 5–12, 20: soni (dona) — boj kamida $2/dona` (a 60-line clothing
  invoice priced only in kg repeats one reason sixty times, product-fit-10). Only then are
  ⚠️ rows shortened, by `fitTelegram`'s own `… va yana {n} ta qator`, and the closing line
  gains `Qatorlar ko‘p — sonlar bor Excel yoki packing listni «➕ Yana ma’lumot» bilan yuboring.`
  The table passes `maxLines: Infinity`: R2's reply cap of 25 lines (`MAX_REPLY_LINES`) is
  a rule about the AI answer, and on the table it would cut row 26 of a short 40-row table
  that fits in 4096 (product-fit-10). A ⚠️ row and its ↳ are ONE entry of `lines`, so a cut
  never separates them.
- Keyboard: unchanged `reviewKeyboard(base, retry)`. The base is `confirmKeyboard`
  (`✅ Tasdiqlash` / `➕ Yana ma’lumot` / `✖️ Bekor qilish`), `aiConfirmKeyboard(cert)` on the
  AI door, or `amendKeyboard` in an add collection (§2.4).

### 2.2 The echo (P3)

One message per answer message. Single row:
```
✅ 3-qator «Sumka»: 50 dona yozildi
```
Several:
```
✅ Yozildi:
· 3-qator «Sumka»: 50 dona
· 5-qator «Shim»: 20 kg
· umumiy brutto: 3500 kg
⚠️ 7-qator yo‘q (jami 5 ta qator)
```
- The figures are `figureLabel(value, unit)` per field written, joined by ` · `. A code is
  ` · kod 6403990000`. The route is `· yo‘nalish: Yiwu → Toshkent`. Volume is
  `· umumiy hajm: 12 m³`.
- Refused segments, each on its own `⚠️` line, in the order written (`TABLE_REFUSAL`):

  | `TableRefusal` | Words |
  |---|---|
  | `no_line` | `{n}-qator yo‘q (jami {N} ta qator)` |
  | `name_many` | `«{typed}» — {a}, {b}-qatorda bor: raqam bilan yozing, masalan «{b}: {example}»` |
  | `name_none` | `«{typed}» — jadvalda bunday qator yo‘q. Yangi tovar bo‘lsa «➕ Yana ma’lumot» ni bosing; qator bo‘lsa raqami bilan yozing: «3: 50 dona»` |
  | `no_address` | `Qaysi qatorga? Raqami bilan yozing: «3: 50 dona». Umumiy og‘irlik bo‘lsa: «jami 3500 kg».` |
  | `address_unclear` | `«{typed}» — {n}-qatorgami yoki {n} tami? Ikki nuqta bilan yozing: «{n}: {rest}».` |
  | `totals_unit` | `Umumiy uchun birlik bilan yozing: «jami 3500 kg» yoki «jami 12 kub».` |
  | `code_kept` | `{n}-qatorda kod bor ({stored}) — yangi kod yozilmadi, VED ga aytiladi.` (only in an ADD collection, ⭐ of Question 3) |
  | `name_mismatch` | `{n}-qator «{row}», siz «{typed}» yozdingiz — yangi tovar bo‘lsa «➕ Yana ma’lumot» ni bosing; shu qator bo‘lsa faqat sonini yozing: «{n}: {example}».` (regression-3) |
  | `line` + `LineAnswerRefusal` | `{n}-qator: ` + `LINE_REFUSAL[reason](detail)` (R1's words, unchanged) |

- **In an add collection whose request the VED has started** (`standingAtOpen === 'started'`,
  product-fit-18), nothing will be written to the job, so the echo never says «yozildi»:
  `📝 VED ga yuboriladi: 3-qator «Sumka»: 50 dona` (several: `📝 VED ga yuboriladi:` + the
  same `· …` lines), and its confirm button is `📨 VED ga yuborish` (`c:save`). The marks stay
  ⚠️/✅ by the figures, because the VED reads the same table. The standing can still move
  between the open and the save; the job's outcome words (§2.4) are the final say.
- The echo ends with what is still missing (product-fit-2). When the answer leaves every
  row ✅, the line is
  `✅ Hamma qator to‘liq — «✅ Tasdiqlash» ni bosing.` (add collection: `«✅ Qo‘shish» ni bosing.`).
  Otherwise it is `⚠️ Yana {k} ta: {list}. Bilmasangiz — «✅ Tasdiqlash», qolganini VED to‘ldiradi.`.
  `{list}` is the ⚠️ targets by number, then `umumiy brutto` / `umumiy hajm` / `yo‘nalish`,
  with at most 6 named, then `va yana {m} ta`. In an add collection the line names
  «✅ Qo‘shish» and adds `Qayta hisoblash uchun «✅ Qo‘shish» ni bosing.` When the collection
  was opened by a reply to the 2.8 b block and every ASKED row is now answered, it says so
  first: `✅ So‘ralgan sonlar yozildi.`.
- Buttons: `↩️ Shu javobni bekor qilish` → `cu:<tag>` (only when something was written; the
  label names THIS answer, so it is never mistaken for «✖️ Bekor qilish», which ends the whole
  collection — product-fit-12), plus the confirm on EVERY echo that wrote something:
  `✅ Tasdiqlash` → `c:save` (add collection: `✅ Qo‘shish` → `c:save`; started: `📨 VED ga
  yuborish`). The table it confirms is the message just above, so the button never has to be
  scrolled to.
- **On the AI door, every echo that carries «✅ Tasdiqlash» also carries the certificate**
  (product-fit-20): a line `📄 Sertifikat: bor` (or `yo‘q`) above the buttons, and the toggle
  button (K11's pairing: labelled with the CURRENT answer, carrying the other answer's
  `c:cert_y` / `c:cert_n`; K-review spec-4). The certificate
  changes the duty without changing the cargo, and after a few answers the table that held
  the toggle is scrolled far up. A press SETS the value (K11), edits the pressed echo's line
  and keyboard, and edits the table.
- A bare or ambiguous number keeps R1's words (`{n} — qaysi birlikda?`, `{a} mi yoki {b} mi?`).
  `lineOfferKeyboard` loses its `⏭` (product-fit-9): a fresh offer would otherwise carry a
  button that always answers «eskirgan». Each offer carries its TARGET row (§8.2). When one
  message's offers span several rows, each button names its row: `3-qator: 50 dona` /
  `3-qator: 50 kg` / `4-qator: 50 dona` … A press is applied exactly like a typed answer: it
  gets its own echo, with its own `↩️` and the missing-line.
- An offer button acts only from the message that drew the LIVE offers
  (`offersMessageId`): `pick_N` is `'own'` (K12), judged against that one message. An older offer message —
  another collection's, or this one's before a newer answer replaced its offers — answers
  «Bu tugma eskirgan.» and never applies the live state's `offers[n]` to a row it was not
  drawn for (regression-23).
- After the echo, the table message is EDITED in place (`tableMessageId`), off the poller,
  per chat, latest wins (performance-5):
  - the text is compared with the last one drawn (`tableHash`, a quiet field); an identical
    table is not sent at all;
  - Telegram's 400 `message is not modified` counts as success, never as a reason to send
    again;
  - only a refused edit for another reason (too old, deleted) sends a fresh table, and its
    id is kept.

### 2.3 The undo (P3)

- The echo is edited to `↩️ Bekor qilindi: 3-qator «Sumka» — 50 dona` (several:
  `↩️ Bekor qilindi:` + the same `· …` lines), keyboard removed. The table is edited too.
- A row a LATER answer has changed again is not reverted: the edited echo gains
  `⚠️ 3-qator keyin o‘zgartirilgan — u bekor qilinmadi.`
- The row is found where the answer is NOW, never at the echo's old index (product-fit-11):
  by `itemId`, else by the `lineAnswers` entry the echo wrote, as the last reading placed it
  (`placeByName`'s written-back index). After «➕ Yana ma’lumot» → «Bo‘ldi» moved «Sumka»
  from row 3 to row 5, the undo reverts row 5 and says `↩️ Bekor qilindi: 5-qator «Sumka» — 50 dona`.
  An entry the last reading placed nowhere (`index: -1`) is reverted in `lineAnswers` alone,
  and the echo gains `⚠️ «Sumka» oxirgi o‘qishda topilmadi — javobi o‘chirildi.`
- Second press (`undone`): the press is answered `Allaqachon bekor qilingan`.
- No live collection, another collection, or an unknown tag:
  `Bu tugma eskirgan.` (the press answer and a reply).

### 2.4 The add door (P4)

Opening (the ➕ press, or a reply to the AI answer):
```
➕ Qo‘shimcha · B-000067 · 🛃 Rastamojka
Mijoz: GS777 · Ali aka

So‘rovdagi qatorlar (4):
✅ 1. Kurtka qishki — 300 dona · 150 kg · 6201400000
⚠️ 2. Krossovka — 12.5 kg · 6403990000
   ↳ juft soni — boj kamida $3/juft
…
✍️ Yetishmaganini yozing: «2: 40 juft». Yangi tovar yoki fayl — «➕ Yana ma’lumot».
```
- This is the same `intakeTableText` with `amend` set: the head line names the card. Rows are
  numbered by `seq`. A line the add collection added reads `✅ 🆕 5. Shim — 20 kg`.
- `amendKeyboard`: `✅ Qo‘shish` (`c:save`), `➕ Yana ma’lumot` (`c:more`), `✖️ Bekor qilish`
  (`c:cancel`).
- When it opens, one line above the table, by `amendStanding` (§9.3), kept in the state as
  `standingAtOpen` (quiet) so the echo and the confirm button say the same (§2.2):
  - `started`: `ℹ️ VED bu so‘rov ustida ishlayapti — qo‘shimchangiz VED ga yuboriladi, o‘zgartirishni VED o‘zi kiritadi.`
    The keyboard's first button is then `📨 VED ga yuborish` (`c:save`) instead of `✅ Qo‘shish`.
  - `busy`: `⏳ AI hali hisoblayapti — «✅ Qo‘shish» dan keyin qo‘shimchangiz saqlanadi va AI tugatgach so‘rovga avtomatik yoziladi.`
  - `open`: nothing.
- Opened by a reply to the 2.8 b block, or by the ➕ under it: the rows the block asked
  are the ones an unaddressed answer goes to (§8.2.4), and the ✍️ line names them:
  `✍️ So‘ralgan: 2-qator juft soni, 5-qator soni (dona). Yozing: «2: 40 juft».`

Refused at the press (the press is answered with the same words, and they are sent):

| Case | Words |
|---|---|
| not linked | `Ulanmagan` |
| not the requester | `Bu so‘rov sizniki emas — qo‘shimchani so‘rovni yuborgan xodim qo‘sha oladi.` |
| not found | `So‘rov topilmadi (o‘chirilgan bo‘lishi mumkin).` |
| closed, answered or sealed (`ending` `answered` / `sealed`, `endingOf`) | `Bu so‘rov yopilgan (javob berilgan). Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring; VED ga savol bo‘lsa — kartadagi «Savol-javob».` |
| closed with no price (`ending` `unpriced_lines` / `unpriced_task`) | `Bu so‘rov narxsiz yopilgan. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.` (re-check kernel-15) |
| closed, returned — ⭐ of Question 6 | not a refusal: a NEW collection opens, filled from the request (§9.2), with one line above its table: `📨 VED bu so‘rovni qaytargan: «{reason}». Yetishmaganini qo‘shing — «✅ Tasdiqlash» yangi so‘rov bo‘lib VED ga boradi.` It lands where Uch band puts it: a coded client's request on a NEW deal (the returned one stays open); a lead — the sender's open lead about a colleague's client (`about_joined`, intake-land.ts:283-295) or a stranger's open lead by phone (`lead_joined`, :502-504) — is joined, so there the new request can sit on the returned request's own lead. The returned request, its note and its files are never touched (re-check laws-print-12, v1-5) |
| closed, returned — if he answers 6 b | `VED bu so‘rovni sizga qaytargan: «{reason}». Kerakli ma’lumotni «🧮 Hisoblatish» bilan qayta yuboring yoki kartadagi «Savol-javob» da yozing.` |
| the request's card is a closed lead (`AmendBase.leadOpen === false`, `leadTakesJobs`' rule) | `Lid yopilgan — unga qo‘shimcha yozilmaydi; yutilgan bo‘lsa, uning bitimidan yuboring.` (Uch band's rule: a closed lead takes no job at any door; asked again inside `amendRequest`'s transaction, request then lead — re-check laws-print-13) |
| a task draft is live | `Hozir topshiriq yozilyapti. ` + `BUSY_DRAFT` (today's words, task-handlers.ts:105) |
| a zametka is live | `refuseWhileCapturing`'s words (today's; K moves it to note-capture.ts, exported) |
| another collection is live (holding or parked) | `Sizda tugallanmagan yig‘ish bor. Uni o‘chirib, {card} so‘roviga qo‘shimcha boshlaymizmi? Yuborilgan hamma narsa o‘chadi.` with `🗑 Ha, uni o‘chirib qo‘shimchaga o‘tamiz` (`cg:<requestId>`; the first draft's «🔄 Ha, boshqatdan» meant «start over», which this press is not — product-fit-19 d) and `▶️ Yo‘q, davom etaman` (`c:resume` — never `c:more`, which throws a table-stage collection back to material, product-fit-8). Today's `restartKeyboard` reads `↩️ Yo‘q, davom etaman` → `c:more` (staff-handlers.ts:323-330); K renames it to this one label and callback in the same edit, so ↩️ means only the undo (re-check laws-print-20) |
| the same request's add collection is live | `Shu so‘rovga qo‘shimcha yig‘ilmoqda — davom eting.` then the table again (a resume; it un-parks) |

A text that REPLIES to another request's AI answer (or to the ➕ under it) while a collection
is live is not written anywhere (regression-5, product-fit-5):
`Sizda {card A} bo‘yicha yig‘ish ochiq — bu javob {card B} so‘roviga tegishli, hech narsa yozilmadi. {card B} ga qo‘shish uchun:`
with `🔄 Ha, ochiq yig‘ishni o‘chirib {card B} ga qo‘shamiz` (`cg:<B>`) and `▶️ Yo‘q, davom etaman`
(`c:resume`). After the restart he sends the answer again; it is not replayed.

**Where extra information arrives with nothing open** (product-fit-16). His 1.9 is about
«qo‘shimcha ma’lumot kelsa», not about finding a button far up the chat. While the staff
member has an OPEN request he sent (`requested_by` = him, not closed, `requested_at` in the
last `ADD_OFFER_DAYS = 7` days — `calc_requests` has no `created_at`; no index on
`requested_by`, stated, re-check p4-1), at most the two newest:
- a FORWARD reaches Door B as today, and its «📌 Topshiriq qilamizmi?» keyboard gains one row
  per request: `➕ {card} so‘roviga qo‘shish` (`cf:<requestId>`);
- a plain photo or document (not a reply, no collector, no draft, not backlog) — which today
  gets silence, because the cabinet answers a staff chat with nothing — gets, as a reply to
  it: `➕ Bu faylni so‘rovga qo‘shamizmi?` with the same `cf:` buttons. With no open request,
  silence stays.
- The press (`pressAdd(ctx, chatId, requestId, 'replied', null)`) runs the door's own checks
  (§9.2), opens (or resumes) the add collection, and takes the message the offer REPLIES to
  (`callbackQuery.message.reply_to_message`, Door B's own stateless idiom) as its first
  material: a text into `material`, a photo or document through
  `saveIntakeFile(ctx, noteId, staffId, fileOf(part))`. For a forward, the album's other
  parts come from `forwardAlbumOf(chatId, media_group_id)` (task-draft.ts:471) exactly as
  `handleForwardCallback` takes them; `offerAddForMedia` makes one offer per
  `media_group_id`, as a reply to the album's first part. Then the add table, with
  `📎 Albom bo‘lsa, qolgan rasmlarni shu yerga yuboring.` only when the album is no longer in
  memory. (re-check p4-9)
- A voice note, sticker or location is never offered (1.12 a: «yozib yuboring»).

«✅ Qo‘shish» (`saveAmendment`): first `⏳ Qo‘shilmoqda…`, then the job (`calc.amend-save`)
sends one of these by chat id. While the job runs, the collection is frozen: a text or file
gets `⏳ Qo‘shimcha yozilmoqda — natija kelgach yozing.`, and «✖️ Bekor qilish» gets
`⏳ Qo‘shimcha yozilmoqda — endi bekor qilib bo‘lmaydi.`. If the queue refuses the job:
`Qo‘shib bo‘lmadi — «✅ Qo‘shish» ni qayta bosing.` and the collection is kept.

| `AmendOutcome` | Words |
|---|---|
| `applied`, re-pass queued | `✅ So‘rovga qo‘shildi ({card}):` + the change lines + `\n🤖 AI qayta hisoblayapti — natija shu yerga keladi.` (true under ⭐ of Question 7, which sends this answer to him even when «✅ Mening vazifalarim» is muted — re-check laws-print-5; under 7 b the line reads `\n🤖 AI qayta hisoblayapti — natija kartadagi lentada (AI javoblari o‘chirilgan bo‘lsa, chatga kelmaydi).` when his group is muted). On a section with no customs part (`sectionParts(section).customs` false — yolkira, whose re-run is the tariff reply on `calc.tariff-reply`, jobs.ts:20, with no AI asked) the line reads `\n🧮 Yo‘lkira tarif bo‘yicha qayta hisoblanmoqda — natija shu yerga keladi.` (re-check laws-print-24) |
| `applied`, queue refused | the same head and lines + `\n⚠️ Qayta hisoblash navbatga tushmadi — narxni VED beradi.` |
| `to_ved` / `started` | `📨 VED bu so‘rov ustida ishlayapti — qo‘shimchangiz VED ga yuborildi, o‘zgartirishni VED o‘zi kiritadi:` + the change lines («unga» could be read as «the request», product-fit-18) |
| `to_ved` / `closed` (answered or sealed) | `📨 Bu so‘rov yopilgan (javob berilgan) — qo‘shimchangiz VED ga yozildi. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.` |
| `to_ved` / `closed` (returned between the open and the save) | `📨 VED bu so‘rovni sizga qaytargan — qo‘shimchangiz VED ga yozildi. Hisob qayta kerak bo‘lsa «🧮 Hisoblatish» dan yangi so‘rov yuboring.` (product-fit-7: the code cannot reopen a returned request, so the words never promise it). The `closed` words key on `ending` (K14's `storedRequestFacts`, `endingOf`); a price-less ending (`unpriced_*`, legacy shapes only) reads `📨 Bu so‘rov narxsiz yopilgan — qo‘shimchangiz VED ga yozildi. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.` (re-check kernel-15) |
| `to_ved` / `lead_closed` (the lead closed between the open and the save) | `📨 Lid yopilgan — qo‘shimchangiz so‘rovga yozilmadi, VED ga yozildi.` + the change lines; no row write, no re-pass; its thread message is the `closed` sentence (re-check laws-print-13) |
| `waiting` (the pass is still running; collection ended) | `⏳ AI hali hisoblayapti — qo‘shimchangiz saqlandi va AI tugatgach so‘rovga avtomatik yoziladi ({card}):` + the change lines |
| …then, when the job writes it | `✅ Kutib turgan qo‘shimchangiz so‘rovga yozildi ({card}).` + `\n🤖 AI qayta hisoblayapti — natija shu yerga keladi.` (the yolkira line of the `applied` row on a section with no customs part), or the `to_ved` words above with `Kutib turgan qo‘shimchangiz` in place of `qo‘shimchangiz` |
| `noted` (only material, files or file conflicts — no row changed; collection ended) | `📎 Qo‘shimcha kartaga qo‘shildi va VED ga yozildi ({card}) — so‘rovdagi qatorlar o‘zgarmadi, AI qayta hisoblamaydi.` + the change lines |
| `empty` (collection kept) | `Hech narsa o‘zgarmadi — qatorga javob yozing («3: 50 dona») yoki «➕ Yana ma’lumot» bilan fayl yoki tovar yuboring.` |
| `duplicate` | the words of the outcome stored on the row when they were never sent (§9.5's redo); otherwise `✅ Bu qo‘shimcha allaqachon yuborilgan.` |
| `not_yours` / `not_found` | the press words above |
| `refused` (a `SaveTableRefusal`; collection kept) | `Qo‘shib bo‘lmadi: ` + `AMEND_REFUSAL[code]` |
| the job's last attempt failed (collection kept, frozen lifted) | `Qo‘shib bo‘lmadi — «✅ Qo‘shish» ni qayta bosing.` |

`AMEND_REFUSAL` is a `Record<SaveTableRefusal, string>` (law-money-4). `SaveTableRefusal`
is the union of every code `saveTable` can throw, exported by K and pinned by a test that
reads the throw sites:
- `too_many_items`: `tovarlar juda ko‘p (1000 dan ortiq).`
- `server_behind`: `tizim yangilanmoqda — birozdan keyin qayta bosing.` (not a `saveTable`
  throw site: the job's catch names a non-`CalcError` so, as the landing does at
  intake-land.ts:603 — re-check laws-print-18)
- `name_required` (workspace.ts:4182, :4189): `yangi qatorga tovar nomi yozing.`
- `not_found`: never reaches the seller (the `not_found` outcome); the entry reads
  `so‘rov topilmadi.`
- `import_row_missing`, `bad_basis`, `baza_positive`, `basis_shown_changed`
  (workspace.ts:4268-4339, 5197-5222, 4902): unreachable from the add door — it posts no
  `importRowId`, `bazaUsd`, `bazaBasis` or `shownBasis`, and `doorRow` gives `measureUnit`
  only from its own list. Their entries (never shown; the comment beside each says why) read
  `bojxona bazasi qatori topilmadi.` / `birlik noto‘g‘ri.` / `baza 0 dan katta bo‘lishi kerak.`
  / `birlik o‘zgargan — qatorni qayta yozing.` (re-check laws-print-18)
- `bad_number`: `son noto‘g‘ri — qatorni qayta yozing.`
- `measure_positive`: `son 0 dan katta bo‘lishi kerak.`
- `bad_code`: `TNVED kod noto‘g‘ri — 10 ta raqam bo‘lishi kerak, masalan «3: kod 6403990000».`
- `ai_running`: never reaches the seller (law-money-7). The standing is read again: a
  machine pass's ticket standing → the `waiting` branch (stored, written when it ends);
  otherwise a person pressed ✨, which is a person starting work → `to_ved` / `started`.
  Nothing was written either way. The entry reads `AI yoki VED shu so‘rovni guruhlayapti.`
- `already_closed`: never reaches the seller (mapped to `to_ved` / `closed`, re-reading
  `completedVia`); the entry reads `so‘rov yopilgan.`
- `conflict` / `changed_under`: never reach the seller (mapped to `to_ved` / `started`);
  the entry reads `VED shu paytda saqladi.`
- Any code K finds that is not listed here gets its own sentence in K. The `??` fallback is
  gone.

Change lines (`amendChangeText`, one home for the seller's reply, the thread message and the
VED branch). On the `applied` branch they are built from what the SAVE wrote, not from what
was posted: `saveTable` drops or clears a measure the law cannot hold (`measuresDropped`,
`measuresCleared`, `basisConflict`) and used to name that only on the VED's screen
(regression-16):
- `· 3-qator «Sumka»: 50 dona` (a field written on a stored row);
- `· 2-qator «Krossovka»: 40 juft — yozilmadi (kod juft so‘ramaydi)` (a measure the save
  dropped) / `· 2-qator «Krossovka»: 40 m² — yozilmadi (qatorning birligi boshqa)` (cleared
  or a basis conflict);
- `· yangi qator: «Shim» — 20 kg · 6203420000`;
- `· umumiy brutto: 3500 kg`, `· umumiy hajm: 12 m³`, `· yo‘nalish: Yiwu → Toshkent`;
- `· umumiy brutto: 3500 kg so‘ralgan, faylda 4200 kg — VED hal qiladi` (a total a
  `TotalDoubt` names is never written; re-check p4-6);
- `· 3-qator «Sumka»: sotuvchi kodi 6402990000 (so‘rovda 6403990000 — VED hal qiladi)`
  (⭐ of Question 3);
- `· 3-qator «Sumka»: faylda 200 dona (so‘rovda 300) — sotuvchi tanlamadi, VED hal qiladi`
  (an unresolved conflict, or one he sent to the VED with `📨`, law-money-5; never written,
  always named);
- `· 3-qator «Sumka»: 300 + 200 = 500 dona (ikkinchi fayl qo‘shildi)` (a conflict he answered
  `➕`; written as 500, product-fit-17);
- `· umumiy hajm: 15 m³ (qatorlardan qayta hisoblandi)` (the Σ that followed the lines);
- `· ⚠️ umumiy brutto yangilanmagan — yangi tovar qo‘shildi` / `· ⚠️ umumiy hajm yangilanmagan — yangi tovar qo‘shildi`
  (`amendTotalsStale`);
- `· 📎 {n} ta fayl kartadagi lentada`;
- at most 20 lines, then `· … yana {n} ta o‘zgarish`.

The job's thread (on `{ kind: 'calc', id }`, under the seller's name). The message is written
INSIDE the transaction that records the amendment (`insertThreadMessageInTx`, K's extraction
of `addThreadMessage`'s transaction body, wms/crm/thread.ts:199; durability-5), so it can
never be missing; only the ping that announces it (`announceNote`, wms/crm/internal-chat.ts)
and the author's read mark run after the commit (re-check p4-3):
- applied: `➕ Sotuvchi qo‘shimcha yubordi — so‘rovga yozildi, AI qayta hisoblaydi:` + lines
  (from the save's result, as above; the message is written last in the transaction, after
  the measure pass, so it can read it — K15's `inTx` receives `applied`);
- started: `➕ Sotuvchi qo‘shimcha yubordi — so‘rovga avtomatik yozilmadi (siz ishlayapsiz), o‘zgartirishni kiriting:` + lines;
- closed: `➕ Sotuvchi qo‘shimcha yubordi — so‘rov yopilgan, avtomatik yozilmadi:` + lines;
- waiting: `➕ Sotuvchi qo‘shimcha yubordi — AI hisobi tugagach so‘rovga avtomatik yoziladi (agar siz boshlamagan bo‘lsangiz):` + lines;
  and when the job then writes it: `➕ Kutib turgan qo‘shimcha so‘rovga yozildi, AI qayta hisoblaydi.`
  (or, when the VED had started meanwhile, the `started` sentence);
- noted: `➕ Sotuvchi fayl yoki matn yubordi — so‘rov qatorlari o‘zgarmadi, kartadagi lentada:` + lines.

The card's lenta note (only when the add collection carried material or files — the files are
pre-bound to it). It is written in the amendment's own transaction, through Uch band's
`insertActivityTx` (crm/service.ts:1545), right after the `calc_amendments` row, on the card
read off the LOCKED request row — never one the add collection remembered: Uch band's win
split moves a won lead's requests onto its deal (`rekeyLeadCalcJobsTx`, calc/service.ts:1134).
(re-check laws-print-13)
```
➕ Qo‘shimcha — 🛃 Rastamojka · B-000067
Yig‘di: Ali (Telegram bot)
Fayllar: 2

Sotuvchi yuborgani (asl matn):
{material and answers, verbatim, cut at MATERIAL_NOTE_CAP}
```

The landing's ✅ (P4's `landedReplyMarkup`): the text is UNCHANGED — Uch band's words
(`landedWords`, `TARIFF_FOLLOWS`, `queueRefusal`, staff-handlers.ts:2840-2925), which K moves
verbatim into `calc-dialog.ts`
`landingReplyText(target: IntakeTarget, opts: { link: string | null; tariffFollows: boolean }): string`
(pure; the caller awaits `landingLinkFor(staff.id, target)` and computes `tariffFollows` as
today, §14). (re-check laws-print-11) When
`target.queued && target.requestId`, its `reply_markup` is
`[[{ text: '➕ Shu so‘rovga qo‘shish', callback_data: 'ca:<requestId>' }]]` instead of the
persistent keyboard re-send. Nothing in the collector removes the persistent keyboard, so the
re-send there changed nothing on the phone. When the job did not reach the queue, the re-send
stays.

### 2.5 The 2.8 b block in the AI answer (P5)

In the CHAT rendering, in `fitTelegram`'s `fixed` part (never cut), after the group lines and
before the totals:
```
❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak — qonun shuni so‘raydi:
· 2-qator «Krossovka»: juft soni — boj kamida $3/juft
· 5-qator «Kurtka»: soni (dona) — boj kamida $2/dona
✍️ Shu xabarga reply qilib yozing: «2: 40 juft; 5: 300 dona» — yoki «➕ Shu so‘rovga qo‘shish» ni bosing.
```
- The heading says «o‘lchov» because his 1.14 a asks every unit the law pins (dona, 1000
  dona, juft, kg, m², litr) (product-fit-19 b). (re-check laws-print-23)
- Rows are numbered by `seq`, the same number the add table prints (`TableRow.no`), so
  «3: 40 juft» typed from this block lands on the row this block named. The words are
  `needWhatUz` / `needWhyUz`. The example uses each row's first pinned unit and
  `figureLabel`.
- When the re-run follows an addition whose totals are stale (`change.totalsStale`, §9.5) and
  the section prices the road, the freight line is replaced (law-money-1):
  `🚚 Yo‘lkira: qo‘shimchadan keyin umumiy hajm/og‘irlik yangilanmagan — yo‘lkirani VED hisoblaydi.`
- At most 8 rows, then `· … yana {n} ta qator — «➕» jadvalida`.
- The LENTA rendering carries one line under the heading instead:
  `❓ Sotuvchidan so‘raldi: 2, 5-qator o‘lchovi (qonun so‘raydi).` (re-check laws-print-23)
- A re-run pass's heading: R2's title with ` · ${RERUN_WORD}` (`RERUN_WORD = 'qayta hisob'`,
  reply-heads.ts) after the title phrase and before the labels:
  `🤖 AI-VED · taxminiy rastamojka · qayta hisob · GS777 · B-000067`; podklyuch
  `🤖 AI-VED · taxminiy podklyuch (rastamojka + yo‘lkira) · qayta hisob · GS777 · B-000067`; a
  priced tariff reply `🧮 Yo‘lkira (tarif bo‘yicha) · taxminiy · qayta hisob · …`; a refused one
  `🧮 Yo‘lkira (tarif bo‘yicha) · qayta hisob · …`. Each still starts with
  `MACHINE_REPLY_HEADS[kind]`, and a priced tariff re-run with `TARIFF_PRICED_HEAD`, so R2's
  lenta chip (feed.ts:243-244, PF-9) classifies them unchanged. (re-check p5-p6-10)
- The seller's refusal tails, audience-keyed in the files that hold them: R2's
  `FREIGHT_TAIL_WORDS.seller` (ai-reply.ts:288), `CUSTOMS_TAIL_WORDS.seller` (ai-reply.ts:300,
  which follows it) and estimate.ts's `TAXMINIY_BLOCK_WORDS.refused_measure` (:279). In the
  CHAT rendering all three read `— mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring`
  (refused_measure:
  `⚠️ qatorda soni yoki og‘irligi yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring`).
  The LENTA keeps R2's `— mijozdan so‘rab, kartadagi lentaga yozing`. (re-check
  laws-print-19)

### 2.6 The reading (P2)

- The press: unchanged `⏳ AI o‘qiyapti… (3 daqiqagacha)`. Its message id is now KEPT.
- The queue refused: `Tahlilni boshlab bo‘lmadi — «Bo‘ldi» ni qayta bosing.` + `doneKeyboard`.
- A second press while a reading is live (not stale): `⏳ Tahlil davom etmoqda — natijani kuting.`
  (today's words).
- After delivery the notice is edited to `✅ O‘qildi — natija pastda ⬇️` (best-effort).
- Material arrived while it read: today's
  `Tahlil paytida yana {n} ta xabar/fayl keldi — ular hali o‘qilmagan.\nHammasini birga o‘qish uchun «Bo‘ldi» ni yana bosing.`
- A stored file storage cannot return in time (missing, or not answering within the job's
  file budget) joins the bot's own `notes`:
  `⚠️ {n} ta fayl o‘qilmadi — saqlangan joydan olib bo‘lmadi. Kerak bo‘lsa qayta yuboring.`
- The last attempt failed, or the sweep finds the reading's job dead: today's
  `Tahlil qilib bo‘lmadi. «Bo‘ldi» ni qayta bosing.` + `doneKeyboard`. Said once
  (`readingSaidDead`, a quiet field). NEVER said when the reading SUCCEEDED and only its
  delivery is waiting (a `pendingReply` stored for this token): that is a Telegram flood
  wait, and the stored table is sent by the delivery-only follow-up at Telegram's
  `retry_after`, or by the sweep's `deliver_pending` (durability-16). The seller then gets
  the table late, never «bo‘lmadi» about a reading that worked.

### 2.7 The reminder and the end (P1)

Reminder (2 h after the seller's last action, once per idle stretch):
```
⏸ Tugallanmagan hisoblatish: 🛃 Rastamojka · GS777 · Ali aka
Yuborilgan: 3 ta xabar · 2 ta fayl
Davom etamizmi? Tugatilmasa soat 14:30 da o‘chiriladi.
```
- An add collection's first line: `⏸ Tugallanmagan qo‘shimcha: ➕ B-000067 · 🛃 Rastamojka`.
- The `Yuborilgan:` line lists only non-zero parts: `{n} ta xabar` (material + answers),
  `{f} ta fayl`.
- The time is Tashkent `HH:MM` of `touchedAt + 24 h`; when that is not today, it reads
  `ertaga soat 14:30 da`.
- Buttons: `▶️ Davom etamiz` (`c:resume`), `✖️ Bekor qilish` (`c:cancel`).
- `silent: quietHour()` (platform/telegram/send.ts:121 — Tashkent 22:00-08:00, the bot's one
  night, the same one every other silent message uses; ⭐ of Question 4). (re-check
  laws-print-17)
- A collection with nothing in it (no material, no file, no customer named) is NOT reminded.
- Its `✖️ Bekor qilish` ends at once: the message asks «davom etamizmi?» itself, so the press
  IS the answer. So does the pause notice's.

«✖️ Bekor qilish» from the table, the add table or the restart question, when the collection
holds material, files or answers (product-fit-12), asks first:
```
🗑 Hammasi o‘chadi: 3 ta xabar, 2 ta fayl. O‘chiramizmi?
```
with `🗑 Ha, o‘chirish` (`c:cancel_y`) and `▶️ Yo‘q, davom etaman` (`c:resume`). The parts
listed are the reminder's (non-zero only). An empty collection ends at once, as today.

«▶️ Davom etamiz»: the stage's own prompt again, as the collector already words it. It
touches the collection, so it un-parks it:
- `section`: `Avval yuk qayerdan chiqishini tanlang:` + zone keyboard;
- `client`: `CLIENT_QUESTION` with `parse_mode: 'Markdown'`, as today (it carries `**kodi**`;
  re-check laws-print-25);
- `material`: `showIntakePrompt`;
- `review`: the table, sent fresh.
- No live collection: today's no-collection answer, Uch band's conc-13 sentence
  (staff-handlers.ts:2631), verbatim:
  `Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.`
  No second sentence for resume. (re-check laws-print-16)
- A task draft or a zametka capture is live (they work while the collection is parked):
  `Avval topshiriqni (zametkani) tugating yoki bekor qiling — keyin «▶️ Davom etamiz».`

The pause (regression-1). The collection is parked after 30 minutes without his action. A
TABLE-SHAPED text (`looksLikeTableAnswer`, §2.8) or a BARE figure that arrives then gets one
line (a collection exists, so «not found» would be false; re-check laws-print-8). Any other text goes on down the ladder as if no collection existed:
```
⏸ Hisoblatish to‘xtab turibdi (30 daqiqa yozilmadi) — bu xabar unga qo‘shilmadi.
Davom etish uchun «▶️ Davom etamiz» ni bosing yoki jadvalga reply qilib yozing.
```
with `▶️ Davom etamiz` (`c:resume`) and `✖️ Bekor qilish` (`c:cancel`). The notice's id joins
the collection's own messages (quiet), so its buttons act on it.

The end (24 h after the last action; ⭐ of Question 5; not sent for an empty collection):
- `⌛ Hisoblatish 24 soat ichida tugatilmadi va o‘chirildi: 🛃 Rastamojka · GS777. Kerak bo‘lsa «🧮 Hisoblatish» dan qaytadan boshlang.`
- an add collection: `⌛ Qo‘shimcha 24 soat ichida yuborilmadi va o‘chirildi: ➕ B-000067. Kerak bo‘lsa ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni qayta bosing.`
  (product-fit-19 e: a collection opened from the ✅, or a muted seller, has no ➕ under an AI answer.)
- Said whoever finds the end first (durability-12): the sweep, or a read that meets an
  expired collection (`expireIntake`, one function, once). The first draft ended it silently
  on any read, so a seller writing in the ≤ 5 minutes before the sweep never got the line.

A «Tasdiqlash» pressed again after the job landed (a crash or a redelivery between the
landing's commit and the end of the collection), and a landing cut off between its note and
its request (durability-3; finished by the next press or by the sweep, on the note's own
card), are answered by the landing's own ✅ (`landingReplyText`), whose first line is Uch
band's `landedWords` for a retried card:
`✅ Saqlandi — oldingi urinishda ochilgan {bitim|lid}: {label}` + the link line
(`landingLinkFor`), and its ➕. One sentence for both. P1's `landedAlreadyReply` is only
`resuming.has(chatId)`: a press while the sweep is finishing THIS chat's landing says nothing,
and the sweep's ✅ answers it. (re-check laws-print-10)

The backlog sentence (`backlog.ts` `backlogSentence(hasCollection)`, regression-24). A
collection can still be lost: on the deploy that introduces durability (the old process is
memory-only), when the readiness probe answers false, or after a write that failed. So
«Hisoblatish» leaves the sentence ONLY for a chat whose collection was opened before this boot
(hydrated): `tellBacklogOnce` (backlog.ts:32) decides it itself from `collectionSurvived(chatId)`
= a live collection whose `openedAt < bootedAtSec() * 1000`, read from calc-store.ts; no caller
changes, and the once-per-chat-per-boot key is unchanged (re-check p1-p2-6):
- such a chat: `⏸ Bu xabar bot yangilanayotgan paytda yozilgan — u nimaga javob ekanini bot bilmaydi. Zametka yoki topshiriq yozayotgan bo‘lsangiz, qaytadan boshlang; savol bo‘lsa, qaytadan yuboring.`
- any other chat (no collection, or one opened after this boot): today's sentence,
  «Hisoblatish» kept.

### 2.8 The orphan answer (P3 — R2's guard, widened and reworded)

A text typed in this chat (`messageId !== null`) that no ⏰ wait declined (`!waitDeclined`),
with no HOLDING collection, after the free lookups, the notes and the backlog check, and
before the paid assistant — R2 P3-R1's gate, kept (staff-handlers.ts:1208-1212), with
`!holdingIntake(chatId)` in place of `!activeIntake(chatId)` (re-check laws-print-8). A text
that looks like a table answer (`looksLikeTableAnswer`: a WORDED figure,
`totalsAnswerShape(text) === 'worded'`; a `TOTALS_WORDS` word followed only by figures and
units — «jami 3500 kg», «og‘irligi 3500 kg», «брутто 3500 кг», the forms the table itself
teaches (product-fit-14); or `looksLikeLineAnswer`, true only when EVERY segment is an address
followed by figures and units, with at most a two-word row name (regression-21): «1) 2026
oktyabr hisoboti» and «1. Kurtka 300 dona, 2. Shim 200 dona — boj qancha?» are NOT, and reach
the assistant) gets:

`Ochiq hisoblatish yo‘q (24 soatdan oshgan yoki tugatilgan). Qo‘shimcha bo‘lsa — ✅ yoki AI javobi ostidagi «➕ Shu so‘rovga qo‘shish» ni bosing, yoki AI javobiga reply qilib yozing. Yangi hisob — «🧮 Hisoblatish».`
(product-fit-19 e.)

A BARE figure («777», as often a code typed without its letters) keeps R2's REG-3 answer,
`BARE_FIGURE_NOT_FOUND` (staff-handlers.ts:1122), unchanged — never this sentence.

With a PARKED collection, any of them — a bare figure included — gets §2.7's pause line
instead. `orphanAnswerSentence(text, parked)` is the one home for all three answers; it is
async (P3 reaches the wms `line-address.ts` by dynamic import), and its caller passes
`activeIntake(chatId)` as `parked`.

Retired: R2's `LOST_TOTALS_ANSWER` («… bot qayta ishga tushgan bo‘lishi mumkin …»,
staff-handlers.ts:1109) only: after this round a restart does not lose the collection.

---

## 3. What happens on a deploy — stated plainly

| Moment | What survives | What the seller sees |
|---|---|---|
| **Mid-collection, graceful deploy** (stage section, client, material or review) | Everything. Each change is in memory at once, and is written to `telegram_calc_intakes` after one second of quiet (at most five seconds while changes keep coming). The graceful stop (`stopTelegramBot`) awaits `flushIntakeWrites()` with whatever is left of its 5 s budget before the confirm (not a fixed 1 s: a collection is the whole state, up to megabytes), then SEALS the store (`sealIntakeWrites`): from then on this process writes no row, so a late effect of an update still in flight can never overwrite what the new process hydrates. **A change still unwritten when the flush ends (too slow, or a write that failed) keeps its update UNCONFIRMED** — while that update is still in the batch grammy is handling (in flight, or the batch's next update held): the stop confirms only through the update before `oldestUnwrittenUpdate()` (durability-10, regression-25). The first draft confirmed anyway and lost the seller's last minutes. An update whose batch has ENDED is already confirmed by grammy's own next `getUpdates`, so the collector awaits its chat's write before a collection-changing message's handler returns (§6.2.2): its change is in the row before Telegram can drop the update. A write that fails even then (the database down) is retried by the timer, and if the stop comes first it is logged lost — the new process could not have hydrated it either (K-review spec-2). A failed write keeps its chat dirty and is retried, never dropped. The new process hydrates every row before its first `getUpdates`. An update that was still in flight past the 3 s budget, or held back by an unwritten change, is unconfirmed, so it is redelivered. If its effect reached the flushed row, `takenUpTo` drops it as `seen`. Otherwise it is applied once. | Messages written DURING the outage come as the backlog. A text or file dated after the collection opened, while it was holding, is that collection's (`intakeTakes`). A press on its buttons works. The 2 h / 24 h clocks are the seller's own actions, so the downtime counts as idle. |
| **Mid-collection, crash** (not a deploy) | Everything except the changes of the last second or so (the write's quiet window). Telegram redelivers up to 20 handled updates (grammy confirms a batch only on the next `getUpdates`). An update whose effect is in the row is `seen` and dropped. An update whose effect was lost is applied once. A file is saved under `uuidv5(noteId:messageId)`, so its re-run finds the attachment and mints no second one (durability-1, regression-6). | Nothing doubled: no text twice in the material, no file counted twice, no «ikkinchi invoys» question about the same file. A press redelivered acts only on its own collection: a cancel cannot end a newer collection, and a restart that would open the collection already live resumes it (durability-2). |
| **Mid-reading** (after «Bo‘ldi», before the table) | The job is on `calc.intake-read`. Its handler runs under ONE wall clock that ends before pg-boss's 300 s expiry: files ≤ 30 s, model ≤ 150 s, delivery ≤ 70 s (performance-1). A killed process leaves the job `active` until the expiry, and pg-boss maintenance (every 120 s) fails it and re-delivers. The new process finds the collection (the job waits for this process's hydrate first, and reads memory only — durability-9), the token still matches, and the model is called AGAIN. That is a second paid call: Anthropic charges both, but the killed call wrote no `ai_calc_passes` row (the bill is recorded only after the model answers), so the ledger and the day's soft budget count ONE (durability-20). | «⏳ AI o‘qiyapti…» lasts longer: up to ~7 minutes after a deploy (expiry + one maintenance + the read), and then the table arrives. A second «Bo‘ldi» in that window says «Tahlil davom etmoqda». If the job dies for good, the sweep sees its pg-boss state, releases the token and says «Tahlil qilib bo‘lmadi …» (the 2 h reminder is the backstop). |
| **Mid-reading, after the reply was stored** | The job stores the reply DURABLY (a flush of THIS chat that must succeed) before it sends. If the store is sealed or the write failed, it does not send: it throws, and the redelivery sends. A redelivery re-sends the stored reply and never calls the model or re-decides. A Telegram flood wait longer than the brief retry is not a failure: the job enqueues a delivery-only follow-up at `retry_after + 1 s` and returns, so no retry is spent inside one flood wait (durability-16). | The table arrives once, possibly late. Never «Tahlil qilib bo‘lmadi» about a reading that worked. The one exception: a kill in the milliseconds between Telegram's 200 and the clearing of `pendingReply` sends it twice. Telegram offers no idempotent send; stated. |
| **Mid-question** (table stage, waiting for answers) | The table stage is a collection like any other. | An answer typed during the outage is a backlog text dated after the collection opened. It is applied when the bot is back, with its echo. |
| **The 2.8 b ask, before an answer** | The ask is in the AI answer, a `notifications` row with `payload.tg` — no wait to lose. | A reply to it written during the outage reaches the reply door after the restart (backlog replies already do: «a swipe-reply names its own target»). The add collection opens and the answer is applied. |
| **Mid-«✅ Qo‘shish»** | The press flushes the collection (with `saving`) and enqueues `calc.amend-save`, so the submission is durable before the press is confirmed (durability-4). The job's `amendRequest` is one transaction holding the rows, the `calc_amendments` row, the card note (`insertActivityTx`, re-check laws-print-13) and the job's thread message. A kill before the commit writes nothing, and pg-boss re-delivers the job. A kill after the commit: the redelivered job finds the row (`duplicate`) and redoes only what is missing (durability-5): <br>• the re-pass, if no ticket stands and the pass never spoke; <br>• the ping, if `announced_at` is null; <br>• the seller's words, if `outcome_sent_at` is null. <br>Hydrate keeps an add collection whose amendment was never told, and re-enqueues its job. | «⏳ Qo‘shilmoqda…», and then the outcome, at most a few minutes late after a deploy. Never twice, never lost. |
| **Mid-«Tasdiqlash»** (landing) | `landIntake` writes the note (a coded client: the card and the note in ONE commit, Uch band's `landCodedCard`), then the request. A kill between them leaves a note with no request: hydrate KEEPS that collection (no root request on its note, `rootRequestOfNote`), and the sweep or the next press calls `landCollectedIntake` → `landIntake` again — `cardOfNote` finds the note's own card, `openCalcRequest` (K2's per-note lock) finishes the request on it, and the retry queues its pass (durability-3). The stranger path still commits `createLead` and the note separately (intake-land.ts:505-519): a kill between THOSE two, then «Tasdiqlash», joins the same lead when a phone was typed (`openLeadForPhone`) and mints a second, phone-less lead otherwise; round 3 does not touch that block (stated). (re-check laws-print-10) | The landing's ✅, late, with Uch band's retried words (`✅ Saqlandi — oldingi urinishda ochilgan …`). A press repeated after a full landing says the same; one sentence for both. |
| **A machine pass killed mid-way** | Every machine save advanced `handsoff_rev` in its own transaction, so the stamp stands at the machine's last committed write (durability-6). The redelivered pass stands down as `unfinished` (R2), and its settle clears the ticket. | «🤖 AI bu so‘rovni hisoblay olmadi …» with «➕». A ➕ then opens `open`, never «VED ishlayapti» about a person nobody saw. |
| **The reminder** | `remindedAt` is in the stored state. | Not repeated after a restart. A reminder whose send failed for any reason but 403/400 is released and retried at the next tick (durability-19). |
| **A job fetched before hydrate** (pg-boss starts its workers before the bot hydrates, `instrumentation-node.ts`) | The reading job and the save job first await `intakesHydrated(INTAKE_HYDRATE_WAIT_MS)`. Ready → memory. Not ready in time, or no bot in this process → the job THROWS and pg-boss re-delivers; it never completes silently on an empty memory (durability-9). | Nothing. |
| **A collection that expired during the outage** | Hydrate loads rows that expired in the last 24 h as well (`expires_at > now() - interval '24 hours'`), so the sweep ends them WITH the «⌛ … o‘chirildi» line; the nightly prune deletes rows a day past expiry (durability-12). A backlog message is judged by the date it was WRITTEN: one written before the 24 h ran out still belongs to the collection. The sweep ends nothing in its first `BOOT_GRACE_MS = 2 min` after boot, so the backlog is applied first. | The line once. A PRESS made during the outage cannot be dated (Telegram gives a callback no time of its own), so a press that crossed the end meets Uch band's no-collection sentence «Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.» (staff-handlers.ts:2631; re-check laws-print-16); stated. |

---

## 4. Who sees what (law 4)

| Surface | Who | What |
|---|---|---|
| The table, echoes, undo, reminder | The collecting person, in their own chat | The goods, their figures and codes, what is missing. No price, no baza, no rate. |
| The add door | Only `calc_requests.requested_by` — the same person the AI answer is sent to, for all three doors (`openCalcRequest` sets it from the actor) | The stored request's rows, figures and codes. A colleague's request refuses at the press. |
| The job's thread message | Whoever `mayReadThread` admits on that request (the VED, the requester, the card's readers) | The change in words. |
| The card's lenta note | `lentaAdmission`, unchanged | The seller's verbatim material and the files. |
| The VED's workspace | The VED | The rows as written, unchanged rendering. A press made over a screen drawn before a seller's applied addition is refused in words (P6). |
| A pending («waiting») addition | The seller (his words), the thread's readers (the thread message) | The same change lines; nothing new. |
| The ➕ offers under a forward or a plain file (product-fit-16) | The staff member, in his own chat | His OWN open requests' card labels (`requested_by` = him), at most two. Nothing about a colleague's request. |
| The re-run's answer to a muted seller (⭐ of Question 7) | The requester only — his own claim row, queued `pending` with `direct: true` and sent by the drain like any other row (re-check laws-print-5) | The same chat rendering the drain sends every unmuted seller; nothing the AI answer does not already show. |

Nothing new reaches a seller that the AI answer did not already show. The 2.8 b block names a
row's missing unit and the law's reason (the floor's unit and amount, already in the AI
answer's group lines), never a price.

---

## 5. K — the lead's kernel commit (before any package; behaviour unchanged but three stated presses)

One commit, cut from 0373bd2 (round 2 merged, Uch band merged in; re-check laws-print-2).
Gates: typecheck, lint, the touched unit tests, the calc and telegram integration suites, and
`intake-corpus.test.ts`, green on a fresh database. Every
re-anchor listed in K16 is mechanical and says «the subject moved». Every package branches
from K. K is behaviour-unchanged with THREE stated exceptions, each with its own red proof:
- the certificate buttons carry their value (K11);
- a restart pressed from the message that opened the live collection resumes it instead of
  wiping it (K11);
- the restart question's «↩️ Yo‘q, davom etaman» becomes «▶️ Yo‘q, davom etaman» and re-prompts the live stage (`c:resume`) (re-check v1-8)
  instead of `c:more`, which threw a table-stage collection back to material (K7, K9;
  product-fit-8).

K2's note lock also changes one RACE, not a press: two landings of one note in flight at once
open two requests today and one after K (the second returns `existing`). (re-check kernel-3)

Two machine-visible changes that are not presses, named by K's review (K-review U2, U6):
- **the reading reads the files back from storage** (K5): a file storage cannot hand over
  within the reading's deadline is counted in `missing`, and the count is SAID — §2.6's
  sentence joins the reading's `notes` (`filesMissingNote`, in `analyzeCollected`), so the
  summary and the lenta carry it. Before K the bytes were in memory and always reached the
  model; a silent `missing` would have read text alone under a prompt that promised photos;
- **the stop's flush budget** is the rest of the 5 s minus the confirm's share (up to 4 s
  idle), not a fixed 1 s (K15) — so `flushWaitWrites` alone, bot.ts's only flush in K, may
  hold the stop up to 4 s on a database blip, still inside the 5 s.

### K1. Migration 0137 `calc_intake_durable` + the drizzle schema (re-check kernel-1)
- The SQL is §13, verbatim: journal idx 137, `when` 1785190000117 (main's `0137_plan_road`
  holds …116), after Uch band's `0136_lead_client_many` (`when` …115). The merge renames the
  file 0138 (idx 138); the ledger then reaches **139**. (re-check kernel-1, K-review spec-5)
- `platform/db/schema/platform.ts`: `telegramCalcIntakes`.
- `platform/db/schema/wms.ts`: `calcRequests.handsoffRev` / `aiPassRev` / `aiPassAt` /
  `aiPassJob`, `calcAmendments`, `aiCalcPasses.intakeNoteId`.
- `Workspace` gains `handsoffRev: number | null`, read by `loadWorkspace`'s first query beside
  `rev` (a column, no extra statement). (re-check kernel-15)
- `tests/unit/migration-journal.test.ts` (derived) covers the journal entry (it refuses a
  `when` not later than the one before, and a hole).
- **Deploy order is the standing rule** (migrate before app; compose starts `app` only after
  `migrate` completes). What a failed `migrate` looks like on the bot paths — the landing's
  catch turning a missing column or table into `queueError: 'server_behind'`, `isServerBehind`
  answering 42P01 and 42703 only where a path asks it — is §13's deploy paragraph, the one
  home. (re-check kernel-30)

### K2. `openCalcRequest` stamps the landing and is idempotent per note (`service.ts`)
- The INSERT writes `handsoffRev: 0`. `rev` is 0 at insert (0092's default), so a request
  nobody has touched reads hands-off from birth.
- `recalcFromSealed`'s INSERT (workspace.ts:2568) does NOT: a correction is the VED's job.
  `handsoff-writers.test.ts` asserts both: no `handsoffRev` there, and `handsoffRev: 0` in
  `openCalcRequest`'s INSERT after the lead lock and the rota pick. (re-check kernel-3)
- **The note lock** (durability-3). When the resolved note id (`input.noteId ?? input.note?.id`,
  service.ts:377-384) is set — the bot's landing, the thread door's both paths, the card form —
  the FIRST statement of `openCalcRequest`'s transaction is
  `SELECT pg_advisory_xact_lock(hashtext('calc-note:' || ${noteId}))`, the second reads
  `rootOfNoteSql(noteId)` = `note_id = $note AND supersedes_request_id IS NULL ORDER BY
  requested_at LIMIT 1` (exported from service.ts; intake-land.ts's `rootRequestOfNote` uses the
  same fragment), and a found row (`SELECT id, assignee_id …`) makes `openCalcRequest` return
  `{ id, assigneeId, existing: true }` at once: nothing is inserted and nothing after the
  transaction runs — no `createTask` (service.ts:541-563; the first call made the bound task)
  and no unassigned-owner ping (:570-580) (re-check v1-0). Then Uch band's order, unchanged: the lead `FOR SHARE OF l` check, the card-path
  note insert, the rota pick LAST, the INSERT carrying `handsoffRev: 0`. Return type
  `Promise<{ id: string; assigneeId: string | null; existing: boolean }>`. The pooled refusals
  (`calcOpenRefusal`, the card read, the lead-open check, the card path's committed
  `note_taken`) stay before the transaction: Uch band's callers ask `rootRequestOfNote` before
  `openCalcRequest`, so only a concurrent twin reaches the in-tx check. (re-check kernel-3)
- `landIntake` and `threadCalcSend` treat `opened.existing` exactly as their
  `rootRequestOfNote` early return (intake-land.ts:525-526, from-thread.ts:389-390; K15's
  `retried`), skipping the bill and the queue after `openCalcRequest`. The card form's
  action (hisoblash/actions.ts:262) returns `{ error: 'note_taken' }` on `opened.existing` —
  what a twin of one form got from the note's key until now (service.ts:535) — and queues no
  second pass. (re-check kernel-3) The three exits are fenced by source shape in
  calc-r3-kernel.test.ts: in each caller `if (opened.existing) return` comes before
  `recordAiPass(` / `queueCalcPrefill(` / `requestAsks(` (K-review U7).
- Not a unique index: a correction copies its parent's `note_id` by design
  (workspace.ts:2581), and a partial unique index could meet an unknown production duplicate
  on deploy morning (#472) — §13 «Why each». §17 counts ROOT duplicates on the shaped copy.
- Nothing reads `handsoffRev` in K.

### K3. `platform/telegram/calc-store.ts` (new) — the store, MOVED from `calc-intake.ts:1378-1454`
`calc-intake.ts` re-exports `startIntake`, `activeIntake`, `updateIntake`, `endIntake`, so
every importer and test keeps its import. The private `TTL_MS` becomes the exported
`INTAKE_TTL_MS`; calc-store.ts also exports `expireIntake(chatId, state)`; `intake-ended.ts`
is reached by `await import('../../wms/calc/intake-ended')`. (re-check kernel-21) Frozen
signatures (P1 implements durability behind them):
```ts
export const INTAKE_TTL_MS: number;           // K: 30 * 60_000 (today's private TTL_MS). P1: 24 * 3_600_000.
/** How long without his action the collection still HOLDS the chat. K: = INTAKE_TTL_MS. P1: 30 * 60_000. */
export const HOLD_MS: number;
export const REMIND_AFTER_MS = 2 * 3_600_000; // unread in K
export function startIntake(
  chatId: bigint,
  section: CalcSection,
  opts: { ai?: boolean; staffId: string; amend?: AmendBase | null; openedBy?: number | null },
): IntakeState;
/** `atMs`: the moment the question is asked FOR — the ladder passes a backlog message's
 * written date, so a message written before the 24 h ran out still finds its collection
 * (durability-12 c). An entry found expired is handed to `expireIntake` (P1: it ends it and
 * says «⌛ … o‘chirildi» once — the sweep calls the same function). K: `atMs` ignored. */
export function activeIntake(chatId: bigint, atMs?: number): IntakeState | null;
/** Pure: does the collection hold the chat at `atMs` (not parked)? K: true. */
export function intakeHolds(state: IntakeState, atMs: number): boolean;
/** The live collection when it HOLDS the chat now, else null. Asked by every door that refuses
 * beside a collection (task draft, zametka «Yangi», 💬, a shared contact). K: `activeIntake`. */
export function holdingIntake(chatId: bigint): IntakeState | null;
/** `quiet`: a bookkeeping write (a message id, the job's settle, the reminder's mark) —
 * it does not slide the 24 h clock. K accepts and ignores it (today every patch slides). */
export function updateIntake(chatId: bigint, patch: Partial<IntakeState>, opts?: { quiet?: boolean }): IntakeState | null;
export function endIntake(chatId: bigint): void;
/** The job's read. P1: awaits `intakesHydrated(INTAKE_HYDRATE_WAIT_MS)`, then MEMORY only —
 * never the table, which after hydration could resurrect a collection whose DELETE is still
 * pending or failed (performance-7). Not hydrated in time, or no bot in this process →
 * throws `IntakesNotReady`, so pg-boss re-delivers instead of completing on an empty memory
 * (durability-9). K: `activeIntake`. */
export function loadIntake(chatId: bigint): Promise<IntakeState | null>;
/** Resolves true once this process's `hydrateIntakes()` has finished; false at `timeoutMs`,
 * or at once when this process runs no bot (no token, `TELEGRAM_POLLING=0`). K: true. */
export function intakesHydrated(timeoutMs: number): Promise<boolean>;
/** Every live collection, for the sweep. */
export function liveIntakes(): ReadonlyArray<readonly [bigint, IntakeState]>;
export interface IntakeMessage {
  date: number;                 // seconds, Telegram's
  messageId: number;
  /** The bot message this one replies to, when it is a reply to the bot. */
  replyTo: number | null;
}
/** Does this message belong to the collection, and was it applied already?
 * 'take' = apply it (and advance `takenUpTo` in the same patch); 'seen' = it was applied
 * before (a redelivery) — the ladder drops it silently; 'pass' = not this collection's —
 * the ladder goes on. K: `isBacklog(date) ? 'pass' : 'take'` (today's rule). */
export function intakeTakes(state: IntakeState, msg: IntakeMessage): 'take' | 'seen' | 'pass';
/** Pure: is the pressed message one of this collection's own (opening, prompt, table,
 * echoes, reminder, pause notice)? K: true. */
export function ownsPress(state: IntakeState, pressedMessageId: number | null): boolean;
/** Join a message this collection sent to its own (`ownMessageIds`, last 40), quietly. K: the
 * same (inert: nothing calls it with a keyboard in K). (re-check v2-8) */
export function noteOwnMessage(chatId: bigint, messageId: number): void;
export function setDurableIntakes(on: boolean): void;  // K: stores the flag
/** Write what is dirty now: with `chatId`, THAT chat's pending write only, and the answer
 * speaks for that chat alone (performance-10: a press never waits on another chat's
 * megabytes, and one chat's refused row never fails another chat's reading); without it,
 * every chat (the stop, tests). False = the store is sealed or that write failed (the
 * reading job then does not send). A failed write keeps its chat dirty and is retried by
 * the next timer, never dropped (durability-10). K: resolves true at once. */
export function flushIntakeWrites(chatId?: bigint): Promise<boolean>;
/** The lowest update id whose collection change is not yet written, or null. The stop asks
 * it after the flush and, while that update's batch is still being handled, confirms only
 * through the update before it (durability-10); an update of an ended batch is already
 * confirmed and is logged lost (K15, K-review spec-2). The id is the one the update was
 * handled under (`currentUpdateId()`, K15). K: null. */
export function oldestUnwrittenUpdate(): number | null;
/** After the stop's flush: this process writes no more rows. K: no-op. */
export function sealIntakeWrites(): void;
export function hydrateIntakes(): Promise<number>;      // K: 0
```
- `startIntake`'s callers pass `staffId`, and `openedBy` = the pressed message's id (the zone
  keyboard, the ➕ message, the reply that opened it). The opening presses resolve `staffId`
  through `staffForChat` (today `mayCollect` does the same read). `ai-rastamojka-bot.test.ts`'s
  two literals are re-anchored.
- The ladder (`staff-handlers.ts`): the three `!late` collector checks become one
  `intakeTakes(intake, { date, messageId, replyTo })` verdict. `'seen'` returns silently;
  `'pass'` goes on down the ladder; `'take'` applies. K's body is today's rule, so behaviour is
  identical. `redelivery-wire.test.ts` («every collector asks it») is re-anchored to the
  predicate.
- The four doors that refuse beside a collection (`task-handlers.ts:127`, the zametka
  «Yangi» step, the 💬 door, the shared-contact branch) ask `holdingIntake` instead of
  `activeIntake`. K's body is `activeIntake`, so behaviour is identical. So does the orphan
  guard in `answerStaffText` (K6), a «holds» site that hands `activeIntake` as `parked`
  (re-check kernel-7). A derived fence
  (`intake-holds-wire.test.ts`, P1) classifies every `activeIntake(` call site in `src/` as
  «presence» or «holds».

### K4. `IntakeState` — fields added, two retyped, P3's retired ones optional (all inert in K)
```ts
staffId: string;
openedAt: number;        // ms
touchedAt: number;       // ms — the seller's last action
remindedAt: number | null;
/** The highest Telegram message id this collection applied (durability-1, regression-6). */
takenUpTo: number;
/** The message whose press (or reply) opened it — a restart pressed from it again resumes. */
openedBy: number | null;
/** This collection's own bot messages: prompt, table, echoes, reminder, pause notice (last 40). */
ownMessageIds: number[];
amend: AmendBase | null;                 // non-null = an add collection (P4)
/** Question 6 a: a returned request's rows, kept through every reading like an add
 * collection's stored rows, but landed as a NEW request through `landIntake` — Uch band
 * decides its card (a coded client's re-send is a new deal), E §9.2 (P4;
 * re-check corpus-mig-seam-8). */
seed: CalcGoodsFact[] | null;
/** Seqs the law asks a count for (P5's lawAsksOf), when an add collection opens (P4). */
askedSeqs: number[] | null;
/** A stored row the new material restates with another figure, or with a figure in a field
 * the row has empty (`stored: null`) (P4, law-money-5, product-fit-17). `choice` is the
 * seller's answer: 'add' (stored + read), 'rep' (read), 'ved' (named to the VED, not
 * written); null = unanswered, which is 'ved' at the save. */
conflicts: { itemId: string; seq: number; field: 'quantity' | 'weightKg' | 'volumeM3' | 'measureQty';
             unit: string; stored: number | null; read: number; choice: 'add' | 'rep' | 'ved' | null }[];
/** «✅ Qo‘shish» pressed: the save job owns the collection until it answers (P4). */
saving: { token: string; at: number; jobId: string | null } | null;
/** The add door's standing when it opened (P4): 'started' makes the echo say «VED ga
 * yuboriladi» and the button «📨 VED ga yuborish» (product-fit-18). */
standingAtOpen: 'open' | 'started' | 'busy' | null;
/** The message that drew the LIVE `offers` (P3): a pick from any other message is stale
 * (regression-23). */
offersMessageId: number | null;
/** Messages taken through a `cf:` offer press (P4, product-fit-16): older than `takenUpTo`
 * by nature, so deduped by id here (last 20). */
repliedTaken: number[];
/** A route answered in the table (P3): kept beside R2's `totalsAnswer` so a re-read cannot
 * erase it (durability-17), and marked like it (R2's CONC-2 `TotalsMark`,
 * calc-intake.ts:301) so later material can doubt it. Present keys only. (re-check kernel-8) */
routeAnswer: { fromCity?: string; toCity?: string; at: TotalsMark } | null;
tableMessageId: number | null;           // the table, for edit-in-place (P3)
tableHash: string | null;                // the last table text drawn (P3, performance-5)
analysingAt: number | null;              // when the token was minted (P2's staleness)
analysingJob: string | null;             // the reading's pg-boss job id (P2, performance-1)
readingSaidDead: boolean;                // «Tahlil qilib bo‘lmadi» already said for this token
/** P2. `at` = when it was stored; `jobId` = the delivery-only follow-up's job, when a flood
 * wait sent the delivery there (durability-16). */
pendingReply: { token: string; text: string; keyboard: InlineKeyboard | null; at: number; jobId: string | null } | null;
echoes: IntakeEcho[];                    // P3
/** Was: { data: Buffer; mediaType }[] — the bytes never reach the jsonb. */
images: { attachmentId: string; mediaType: 'image/jpeg' }[];
/** Was: { data: Buffer; name }[]. `bytes` keeps the cap arithmetic. */
pdfs: { attachmentId: string; name: string; bytes: number }[];
// lineAnswers entries gain:  itemId?: string | null
// and their `index` is the line they were PLACED on by the last reading (placeByName writes
// it back; -1 = not placed this reading, kept by name for a later one — regression-7)
```
```ts
export interface IntakeEcho {
  tag: string;                     // 8 hex, random — `cu:<tag>`
  messageId: number | null;        // the echo's own message (joins ownMessageIds)
  lines: { index: number; no: number; itemId: string | null; name: string;
           before: Partial<CalcGoodsFact>; patch: Partial<CalcGoodsFact> }[];
  /** The undo restores the previous answer WHOLE (figures and `at`) and the doubts it
   * retired (§8.2.7; re-check kernel-8). */
  totals: { before: Partial<CalcFacts>; patch: Partial<CalcFacts>;
            answerBefore: IntakeState['totalsAnswer']; doubtsBefore: TotalDoubt[] } | null;
  undone: boolean;
}
export type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
```
`expires` stays in K (= `touchedAt + INTAKE_TTL_MS`). P1 derives it.

Also in K4 (re-check p3-4): `IntakeStage` keeps the `'question'` literal (P3 removes it);
`offers: { unit: NeedUnit; value: number; target?: TableTarget }[]` (`target` optional in K,
required by P3; `TableTarget` is §8.2.4's type, which K declares in `wms/calc/line-address.ts`
so the field types — P3 fills that file); the fields P3 retires (§8.2 rule 1) become optional.
`mergeLineAnswers(goods, answers): goods` is unchanged; P3 ADDS `placeByName(goods, entries):
{ goods; entries }` (entries with `index` rewritten, -1 when unplaced).

### K5. `platform/telegram/calc-files.ts` (new) — MOVED from `staff-handlers.ts`
- Moved: `readIntakeFile`, `receivePdf`, `receiveSheetText`, `receiveGoodsSheet`,
  `invoiceChoice`, `otherFilesChoice`, `saveBotFile`, `saveIntakeFile`, `reduceForModel`,
  `SHEET_REFUSAL`, `invoiceChoiceKeyboard`, `otherFilesKeyboard`, `FileAnswer`.
  calc-files.ts is `saveBotFile`'s one home (the zametka capture imports it).
- `staff-handlers.ts` re-exports every one a test imports today.
- `saveBotFile(ctx, target, file: BotFile)` with `type BotFile = { fileId: string; isPhoto:
  boolean; fileName?: string; mime?: string; messageId?: number }` (the message the file CAME
  in — K-review spec-1) calls `botCall('getFile', { file_id:
  file.fileId }, FILE_DOWNLOAD_MS)` (platform/telegram/send.ts:178 — the idiom
  tasks/files-job.ts:111 already uses; today `ctx.getFile()`, staff-handlers.ts:2436-2473,
  which can reach only the update's own message), so it needs no `ctx.api`: the ctx is read
  only for the default `fileOf(ctx.message)`, and the `cf:` press's `PressCtx` (K6) passes its
  `file` explicitly (re-check v1-2). `saveIntakeFile(ctx, noteId, uploadedBy, file: BotFile =
  fileOf(ctx.message)!)` returns `attachmentId` (it was dropped, :2475-2486); the add door's
  `cf:` press passes the message its offer REPLIES to (product-fit-16). K: every caller passes
  none. (re-check kernel-25)
- The `getFile` keeps what grammy's `ctx.getFile()` gave it (K-review U3): a 429 asking
  ≤ `BRIEF_RETRY_MAX_S` is waited out, at most twice (bot.api's `briefRetry` did it), and a
  refusal is logged `[bot-file] getFile refused` with Telegram's status, description and
  `retryAfter` (it used to THROW into the handler's logged catch) — a document past 20 MB
  answers 400 «file is too big», an ordinary case the log must name.
- New beside it (calc-files.ts): `export function fileOf(src: { photo?: { file_id: string }[];
  document?: { file_id: string; file_name?: string; mime_type?: string } } | ForwardPart):
  BotFile | null` — a message's largest photo, else its document; an album part's `file`
  (`fileId`, `name ?? undefined` → `fileName`, `mime ?? undefined`, `isPhoto: kind ===
  'photo'`); null for a part with no file or any kind but photo/document (voice, audio, video,
  contact — 1.12 a). §2.4 and §9.2 skip a null. (re-check v1-3) `messageId` = the message's
  `message_id`, or the part's `messageId`.
- **The attachment id is the message's** (durability-1): `saveIntakeFile` mints
  `uuidv5(`${noteId}:${messageId}`, INTAKE_FILE_NS)`, `messageId = file.messageId ??
  ctx.message?.message_id` — read off the FILE first, because on a press (`PressCtx` has no
  `message`) and for an album part the update's message is not the file's; read off the update
  alone, the id was minted at random on exactly the paths §2.4/§9.2's
  `saveIntakeFile(ctx, noteId, staffId, fileOf(part))` takes, and a re-run stored the file
  twice (K-review spec-1). It reads that id first: when the row
  exists, it returns it and downloads nothing. Otherwise it saves with that id. `saveAttachment`
  (files/service.ts:119) gains `opts.id?: string` beside `opts.keyName` (the retry idiom
  tasks/files-job.ts uses), and `saveIntakeFile` passes both (keyName from the message id), so
  the object key is deterministic too. A re-run of the same message after a state write lost
  in a crash therefore finds its attachment and mints no second one. (re-check kernel-25)
- `readIntakeFile(saved: { isPhoto: boolean; body: Buffer; attachmentId: string }, …)`:
  - a photo still runs `reduceForModel` ONCE at arrival, to say «o‘qib bo‘lmadi» at once;
  - it stores `{ attachmentId, mediaType }` and drops the bytes.
- `receivePdf(state, pdf: { attachmentId: string; name: string; bytes: number }, label)`: the
  same caps, arithmetic on `bytes`.
- New:
  ```ts
  export interface IntakeFiles {
    images: { data: Buffer; mediaType: 'image/jpeg' }[];
    pdfs: { data: Buffer; name: string }[];
    missing: number;
  }
  /** The bytes the model reads, from storage. Every get goes through `readWithin` (no
   * read may outlive `deadline`); a photo prefers its model-sized copy (P2). An object
   * storage no longer has, or does not hand over in time, is counted, never thrown.
   * The deadline is the WHOLE load's (K-review U2): each read gets min(PHOTO_READ_MS, what
   * is left), and a file whose turn comes after it is counted, not read. K: no derived
   * copy — so K runs `reduceForModel` on every image it reads and counts a null as `missing`
   * (the stored attachment is the ORIGINAL 3-5 MB photo, and the model refuses past ~5 MB);
   * only P2's model-sized copy removes that work. (re-check kernel-24) */
  export async function loadIntakeFiles(state: IntakeState, opts: { deadline: number }): Promise<IntakeFiles>;
  ```
- `calc-intake.ts` `analyzeCollected(state: IntakeState, files: IntakeFiles = NO_FILES, opts?: { timeoutMs?: number })`
  (today `analyzeCollected(state)`, calc-intake.ts:1464)
  sends `files.images` / `files.pdfs` to the model where it sent `state.images` /
  `state.pdfs`. `timeoutMs` is passed to `analyzeIntake`; absent, it is R1's
  `INTAKE_TIMEOUT_MS`. It returns `IntakeState & { answered: AnsweredUsage[] }` (`answered =
  outcome.answered ?? []`, `AnsweredUsage` from intake-ai.ts:160). In K it still appends to
  `usages` and keeps the `- state.usages.length` subtraction (:1483), so behaviour is
  identical; P2 deletes both in the commit that bills at the answer (§7.2.10).
  (re-check kernel-12)
- K's in-process analysis calls `loadIntakeFiles` first. Behaviour is identical except for
  one storage read and one `reduceForModel` per image read (the arrival no longer keeps its
  reduced copy), and a file that read could not return: `analyzeCollected` puts §2.6's
  sentence (`filesMissingNote(files.missing)`, calc-intake.ts) into the reading's `notes`, so
  the summary and the lenta say it — named in §5's opening. P2 reuses it; it adds no second
  sentence. (re-check kernel-24, K-review U2)

### K6. `platform/telegram/calc-dialog.ts` (new) — the dialogue, MOVED from `staff-handlers.ts`
- Moved verbatim (R2's versions): `askNextOrConfirm`, `applyLineAnswer`, `refuseLine`,
  `applyLinePatch`, `aiStepsText`, `reviewKeyboard`, `skipKeyboard`, `lineOfferKeyboard`,
  `intakeLaws`, `LINE_REFUSAL`, `showIntakePrompt`, `needUnitOfSeller` (staff-handlers.ts:1701;
  re-check p3-5); and Uch band's `landedWords`, `TARIFF_FOLLOWS`, `QUEUE_REFUSAL`, `queueRefusal`
  (staff-handlers.ts:2866-2924; staff-handlers.ts re-exports `landedWords` and `TARIFF_FOLLOWS`,
  so calc-landed-words.test.ts and intake-confirm.test.ts keep their import; re-check kernel-6).
- With them, the words they read move verbatim into calc-dialog.ts: `TOTALS_NOT_READ`
  (staff-handlers.ts:1125, read by `applyLineAnswer` at :1622), `LOST_TOTALS_ANSWER` (:1109),
  `NOT_FOUND_HINT` (:1113, private today — exported, and imported back by staff-handlers.ts
  for :1223 and :2000) and `BARE_FIGURE_NOT_FOUND` (:1122); `orphanAnswerSentence`'s K body
  returns the second and the fourth. staff-handlers.ts re-exports `LOST_TOTALS_ANSWER` and
  `BARE_FIGURE_NOT_FOUND`, so totals-question.test.ts:61-62 keeps its import. Without the move
  calc-dialog.ts would import them back from its own importer. (re-check v1-4, v2-2)
- R2's totals-shape helpers — `TOTALS_NUMBER`, `TOTALS_UNIT`, `bareTotalsNumber`,
  `totalsFigureCount`, `totalsAnswerShape`, `looksLikeTotalsAnswer` (calc-intake.ts:374-430) —
  move VERBATIM into a new zero-import `platform/telegram/totals-shape.ts`; calc-intake.ts
  re-exports them, so P3's pure wms `line-address.ts` can import them (calc-intake.ts imports
  staff-bot). (re-check kernel-7)
- `refuseWhileCapturing` (private, staff-handlers.ts:3050) moves to note-capture.ts, exported,
  with `captureKeyboard`; `BUSY_DRAFT` stays exported from task-handlers.ts:105;
  staff-handlers.ts imports the moved one, so calc-amend.ts and P1's `pressResume` import
  leaves only. (re-check p4-14)
- The ladder's collector branch body (`staff-handlers.ts:827-866`) moves into
  `routeCollectorText`. (re-check kernel-21)
- The `skip` / `pick_N` press branches move into `pressSkip` / `pressPick`.
- `askNextOrConfirm` is SPLIT into a pure decision and its delivery (same words, same patches).
  It reaches `nextLineToAsk`, `lineQuestionText`, `intakeSummaryText` and their siblings by a
  DYNAMIC import of wms/calc/intake (staff-handlers.ts:1361-1362, «platform never imports wms
  statically»), so the pure half is handed that module (re-check kernel-29):
  ```ts
  export type CollectorReply = { reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }> };
  export type EditApi = { editMessageText: (chatId: string, messageId: number, text: string, extra?: Record<string, unknown>) => Promise<unknown> };
  /** Every `calc` step's ctx. The dispatcher has already answered the press through
   * `answerPress` (staff-handlers.ts:359-361), so these speak only through `ctx.reply`
   * («Bu tugma eskirgan.» in the chat). Optional `callbackQuery`, so the six tests' `{ reply }`
   * fakes keep compiling — five already return `{ message_id }`; intake-confirm.test.ts:54's
   * inline fake returns `replies.push(text)` (a number) and is re-anchored by K16.
   * (re-check kernel-19, v1-1) */
  export type CalcPressCtx = CollectorReply & { callbackQuery?: { message?: { message_id: number } } };
  /** Only the NEW kinds' handlers (`pressAdd`, `pressUndo`): not pre-answered, they answer only
   * through `answerPress(ctx, toast)` (press-fence.test.ts). (re-check kernel-19) */
  export type PressCtx = CollectorReply & {
    answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
    callbackQuery?: { message?: { message_id: number; reply_to_message?: import('grammy/types').Message } };
  };
  export interface NextStep { patch: Partial<IntakeState>; text: string; keyboard: InlineKeyboard | null }
  /** Pure: what to write and what to send after a reading or an answer. `intake` = the module
   * `deliverNextStep` imported dynamically. */
  export function intakeNextStep(
    state: IntakeState,
    laws: ReadonlyMap<string, NeedLaw>,
    intake: typeof import('../../wms/calc/intake'),
  ): NextStep;
  /** laws on the pool → intakeNextStep → updateIntake → ctx.reply (the one in-handler path).
   * A REVIEW step's summary is printed from what `updateIntake` returned (the store after the
   * patch), never from `state`: the laws are awaited on the pool and the reading runs off the
   * poller, so a press can land in between (a certificate answer from an earlier summary) —
   * the pre-K code printed from the store, and K's first cut from the snapshot (K-review U4).
   * A question's words are the decision's own. P3's table keeps the rule. */
  export async function deliverNextStep(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void>;
  export async function routeCollectorText(
    ctx: CollectorReply & { api: EditApi },
    chatId: bigint,
    intake: IntakeState,
    text: string,
    /** `replyTo`: the bot message this text replies to, or null (regression-5). */
    msg: { date: number; messageId: number; forwarded: boolean; replyTo: number | null },
  ): Promise<void>;
  export async function pressSkip(ctx: CalcPressCtx, chatId: bigint, state: IntakeState): Promise<void>;
  /** «✖️ Bekor qilish» (`confirmed` = the `cancel_y` press). K: today's body for both — the
   * collection ends at once. P3 adds the one confirmation (product-fit-12). `state` is the
   * LIVE collection or null: the frozen dispatcher passes `activeIntake(chatId)`, and a
   * cancel with nothing live still hears «Bekor qilindi.» (K-review spec-3). */
  export async function pressCancel(ctx: CalcPressCtx, chatId: bigint, state: IntakeState | null, confirmed: boolean): Promise<void>;
  /** A conflict button (`conf_N_add|rep|ved`). K: «Bu tugma eskirgan.» in the chat (no conflict exists in K). */
  export async function pressConflict(ctx: CalcPressCtx, chatId: bigint, state: IntakeState, n: number, choice: 'add' | 'rep' | 'ved'): Promise<void>;
  export async function pressPick(ctx: CalcPressCtx, chatId: bigint, state: IntakeState, n: number): Promise<void>;
  /** K: `answerPress(ctx, 'Bu tugma eskirgan.')` (no echo has a tag yet). */
  export async function pressUndo(ctx: PressCtx, chatId: bigint, tag: string): Promise<void>;
  /** The words (and buttons) for a table-shaped text with no HOLDING collection, or null.
   * `parked` = the live collection when it is parked. Async: P3 reaches the wms
   * `line-address.ts` by dynamic import. K body (R2's REG-3 split, kept):
   * `const shape = totalsAnswerShape(text); return shape === 'worded' ? { text: LOST_TOTALS_ANSWER,
   * keyboard: null } : shape === 'bare' ? { text: BARE_FIGURE_NOT_FOUND, keyboard: null } : null;`
   * (`parked` is always null in K, where `holdingIntake` = `activeIntake`). (re-check kernel-7) */
  export async function orphanAnswerSentence(text: string, parked: IntakeState | null):
    Promise<{ text: string; keyboard: InlineKeyboard | null } | null>;
  ```
- `answerStaffText` asks `orphanAnswerSentence` where R2 asks `totalsAnswerShape`
  (staff-handlers.ts:1208-1213). The call site keeps R2's gate:
  `opts.messageId !== null && !opts.waitDeclined && !holdingIntake(chatId) ? await
  orphanAnswerSentence(text, activeIntake(chatId)) : null`; on a non-null answer it sends
  `out.text` with `out.keyboard` and, when a keyboard was sent, calls `noteOwnMessage(chatId,
  sent.message_id)` (the pause notice, §2.7), then returns (re-check v2-8). (`looksLikeTotalsAnswer` has no
  caller left in src.) (re-check kernel-7)
- `reply-door.ts` `threadReplyFromBot` returns `{ text: string | null } | null`. A non-null
  object means HANDLED, and the caller returns on it, sending `text` only when it is non-null
  (regression-2). Null still means «not handled, go on». K returns `{ text }` where it returns
  today, so behaviour is identical. Both callers (re-check kernel-27): the ladder,
  staff-handlers.ts:1010-1018 → `if (out) { if (out.text !== null) await ctx.reply(out.text);
  return; }`; the 💬 wait, task-handlers.ts:922-931 → `if (!out) await
  ctx.reply(REPLY_SENTENCES.waitNoTarget); else if (out.text !== null) await ctx.reply(out.text);`.

### K7. `platform/telegram/calc-keyboards.ts` (new, frozen after K)
`CLIENT_QUESTION`, `doneKeyboard`, `confirmKeyboard`, `aiConfirmKeyboard`, `restartKeyboard`,
`zoneKeyboard`, moved verbatim, with two changes:
- `aiConfirmKeyboard` builds `c:cert_y` / `c:cert_n` (K11);
- `restartKeyboard`'s «↩️ Yo‘q, davom etaman» → `c:more` becomes «▶️ Yo‘q, davom etaman» → `c:resume` (product-fit-8; ↩️ is the undo's mark alone, §2.4, re-check laws-print-20, v1-8).
  `c:more` sets the stage to `material` unconditionally, so «no, continue» threw a
  table-stage collection out of its table, and in the section or client stage it skipped the
  zone and customer questions.

A package that needs a keyboard of its own defines it in its own file.

### K8. `platform/telegram/calc-read.ts` (new) — the reading, MOVED and seamed
- Moved verbatim: `analyseIntakeAndReply`, `settleAnalysis` (re-exported from
  `staff-handlers.ts`).
- The `done` / `reread` press body becomes:
  ```ts
  export async function pressAnalyse(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void>; // K: today's body
  export const JOB_CALC_INTAKE_READ = 'calc.intake-read';
  export interface IntakeReadJob {
    chatId: string; noteId: string; token: string; noticeMessageId: number | null;
    /** A follow-up that only sends the stored reply (a flood wait, durability-16). */
    deliverOnly?: boolean;
  }
  /** Nothing enqueues it in K. P2 enqueues it with `{ id, expireInSeconds: 300, retryLimit:
   * INTAKE_READ_RETRY }` — never pg-boss's 15-minute default (boss.ts) — and the follow-up adds
   * `startAfter` (§7.2.2). (re-check kernel-31) */
  export async function runIntakeRead(data: IntakeReadJob, retryCount: number): Promise<void>; // K: returns (nothing enqueues)
  export async function registerCalcIntakeReadWorker(boss: PgBoss): Promise<void>; // K: createQueue + one boss.work → runIntakeRead
  /** For the sweep: is this collection's reading alive (its pg-boss job not terminal)? K: true. */
  export async function readingAlive(state: IntakeState): Promise<boolean>;
  /** For the sweep: release a dead reading's token and say «Tahlil qilib bo‘lmadi…» once. K: no-op. */
  export async function releaseDeadReading(chatId: bigint, state: IntakeState): Promise<void>;
  /** For the sweep: send a stored `pendingReply` whose delivery never happened (a flood wait
   * outlived the job's retries, durability-16), bounded like the job's step 7. K: no-op. */
  export async function deliverStoredReply(chatId: bigint, state: IntakeState): Promise<void>;
  /** For the sweep: is a delivery-only follow-up of this stored reply alive? K: false. */
  export async function pendingDeliveryAlive(state: IntakeState): Promise<boolean>;
  ```

### K9. `platform/telegram/calc-intake-sweep.ts` (new)
```ts
export const JOB_CALC_INTAKE_SWEEP = 'calc.intake-sweep';
export async function registerCalcIntakeSweep(boss: PgBoss): Promise<void>;  // K: createQueue only — no schedule, no worker
/** «▶️ Davom etamiz» and the restart question's «Yo‘q». K: re-prompts the live stage (section →
 * the zone keyboard, client → CLIENT_QUESTION, material → showIntakePrompt, review →
 * deliverNextStep). At `'question'` it re-sends the pending question (`lineQuestionText` for
 * `askingIndex`, `totalsQuestionText` for `askingTotalsFor`) with `skipKeyboard` and writes
 * nothing — `askNextOrConfirm` bumps `round` on every ask (staff-handlers.ts:1388, capped at
 * MAX_QUESTION_ROUNDS), so routing a resume through it would skip lines (re-check kernel-23).
 * With no live collection: Uch band's conc-13 sentence, verbatim (staff-handlers.ts:2631),
 * «Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish»
 * tugmasidan boshlang.» (re-check kernel-22). While a reading runs (`state.analysing`) it
 * answers the reading's own line, «⏳ Tahlil davom etmoqda — natijani kuting.», and re-sends
 * nothing: the restart question is reachable during «AI o‘qiyapti», and a stale summary's
 * «✅ Tasdiqlash» would only answer that same line (K-review U5). P1 adds the un-park and the
 * draft refusal (§6.2.14), after that guard. */
export async function pressResume(ctx: CalcPressCtx, chatId: bigint): Promise<void>;
/** True = the sweep is resuming THIS chat's landing right now (`resuming`), so the press says
 * nothing and the sweep's ✅ answers it. K: false. A re-press after the job landed, and a
 * landing cut off between its note and its request, need nothing here: `landIntake` converges
 * by itself (`cardOfNote`, `rootRequestOfNote`) and answers with Uch band's 'retried' words
 * (§6.2.15). (re-check kernel-4) */
export async function landedAlreadyReply(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<boolean>;
```

### K10. `platform/telegram/calc-amend.ts` (new)
```ts
/** «➕ Shu so‘rovga qo‘shish». `mode`: 'plain' (`ca:`), 'restart' (`cg:`, the «🗑 Ha, uni
 * o‘chirib …» twin), 'replied' (`cf:`, an offer under a forward or a plain file — the message
 * the offer replies to becomes the first material). `restartKey`: the dispatcher's claim for
 * the restart form (K11). K: `answerPress(ctx, 'Bu tugma eskirgan.')`. (re-check kernel-17) */
export async function pressAdd(
  ctx: PressCtx, chatId: bigint, requestId: string, mode: 'plain' | 'restart' | 'replied',
  restartKey: OnceKey | null,
): Promise<void>;
/** Door B's extra rows: one `➕ {card} so‘roviga qo‘shish` (`cf:<id>`) per open request the
 * staff member sent in the last `ADD_OFFER_DAYS` (at most two, newest first). K body
 * `async () => []`. */
export async function addOfferRows(chatId: bigint): Promise<{ text: string; callback_data: string }[][]>;
/** A plain photo or document with nothing to take it: the one offer line, as a reply to it,
 * when such a request exists. True = answered. K: false (today's silence). */
export async function offerAddForMedia(ctx: CollectorReply & { message: unknown }, chatId: bigint): Promise<boolean>;
/** «✅ Qo‘shish» on an add collection: flush + enqueue `calc.amend-save`. K: Uch band's
 * conc-13 sentence, «Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini
 * «🧮 Hisoblatish» tugmasidan boshlang.» — unreachable, `amend` is always null in K.
 * (re-check kernel-22) */
export async function saveAmendment(ctx: CollectorReply, chatId: bigint, state: IntakeState): Promise<void>;
/** The sweep's view of a frozen add collection (§6.2.13, re-check v2-6). */
export async function savingAlive(state: IntakeState): Promise<boolean>;                     // K: true
export async function releaseDeadSave(chatId: bigint, state: IntakeState): Promise<void>;    // K: no-op
export const JOB_CALC_AMEND_SAVE = 'calc.amend-save';
export interface AmendSaveJob {
  chatId: string; staffId: string; requestId: string; noteId: string;
  /** A fresh press carries the submission; a stored («waiting») one carries its row id. */
  submission: AmendSubmission | null; amendmentId: string | null; savingToken: string | null;
}
export async function runAmendSave(data: AmendSaveJob, retryCount: number): Promise<void>;      // K: returns
export async function registerCalcAmendSaveWorker(boss: PgBoss): Promise<void>;                // K: createQueue + boss.work
/** The ✅ landing reply's inline markup, or null = today's persistent-keyboard re-send. K: null. */
export function landedReplyMarkup(target: { queued?: boolean; requestId?: string | null }): InlineKeyboard | null;
/** A TEXT sent as a REPLY to an AI answer that carries ➕ (a photo or file replied to one goes
 * through `refuseMediaReply`, §9.6, which holds the ctx to save it; re-check v1-9). It always handles the
 * message (it sends everything itself, by chat id), so the reply door answers HANDLED with
 * no text (regression-2). K: never called. */
export async function openAmendFromReply(
  chatId: bigint,
  requestId: string,
  msg: { text: string | null; date: number; messageId: number },
): Promise<void>;
/** A text replying to ANOTHER request's ➕-bearing message while a collection is live:
 * words naming both, nothing written. True = handled. K: false. */
export async function foreignAddReply(
  ctx: CollectorReply, chatId: bigint, intake: IntakeState, replyTo: number | null,
): Promise<boolean>;
```
And in `wms/calc/amend.ts` (K stub): `requeueWaitingAmendments(requestId?: string): Promise<number>`
(K: 0). The settle (P5) and the sweep (P1) call it; P4 implements it.

### K11. `staff-handlers.ts` — the dispatcher (frozen after K)
- The callback switch (the `calc` kind keeps today's `answerPress(ctx)` before
  `handleCalcCallback`, staff-handlers.ts:359-361, which now takes `CalcPressCtx`; the two NEW
  kinds are not pre-answered and answer through `answerPress` with their own words —
  re-check kernel-19):
  - `calc_add` → `const restartKey = parsed.mode === 'restart' ? await pressKey(ctx, 'restart')
    : null; await pressAdd(ctx, chatId, parsed.requestId, parsed.mode, restartKey);` — the claim
    sits in the branch, where redelivery-wire.test.ts (10) requires `pressKey(ctx, ` for every
    keyed kind (re-check kernel-17);
  - `calc_undo` → `pressUndo(ctx, chatId, tag)`;
  - the `resume` step → `pressResume`;
  - `skip` / `pick_N` → `pressSkip` / `pressPick`;
  - `cancel` / `cancel_y` → `pressCancel(…, confirmed)` (today's body moved verbatim);
  - `conf_N_add|rep|ved` → `pressConflict`;
  - `done` / `reread` → `pressAnalyse`.
- The photo/document handler, right before its final `return next()`:
  `if (await offerAddForMedia(ctx, chatId)) return;` (product-fit-16). K's body answers false,
  so behaviour is identical.
- Door B (`task-handlers.ts` `offerForwardTask`, its keyboard at :553): it becomes
  `[...forwardKeyboard(), ...(await addOfferRows(chatId))]`. K's rows are empty, so the
  keyboard is identical. Door B's own buttons and their `reply_to_message` reading are
  untouched.
- The `save` branch, in THIS order (regression-4):
  1. today's analysing guard («⏳ Tahlil davom etmoqda»);
  2. today's stage guard, verbatim: `if (state.stage !== 'review' && state.stage !== 'question') {`
     (staff-handlers.ts:2792) → «avval «Bo‘ldi»». In K the `'question'` stage is still live,
     so narrowing it here would answer a «Tasdiqlash» pressed beside an open question «avval
     Bo‘ldi». P3's commit narrows it to `if (state.stage !== 'review') {` and re-anchors
     intake-round1.test.ts:204. (re-check kernel-5)
  3. `saving` → `⏳ Qo‘shimcha yozilmoqda — natijani kuting.`;
  4. `if (state.amend) { await saveAmendment(ctx, chatId, state); return; }`;
  5. `if (await landedAlreadyReply(ctx, chatId, state)) return;` — after the cheap guards,
     so a press they refuse costs no database read;
  6. today's landing;
  - the ✅'s text moves verbatim into `calc-dialog.ts` `export function
    landingReplyText(target: IntakeTarget, opts: { link: string | null; tariffFollows: boolean
    }): string` — pure, no awaits: the line «✅ Saqlandi — ${landedWords(target)}», then the link
    line when `opts.link` is set, then an empty line, then the queue line (`TARIFF_FOLLOWS` /
    `🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.` / `⚠️ Hisoblash navbatiga
    tushmadi: ${queueRefusal(target.queueError)}`) — today's string, the `ctx.reply` at
    staff-handlers.ts:2849-2863. The save branch keeps `const link = await landingLinkFor(staff.id,
    target);` and `const tariffFollows = target.replyQueued === true &&
    !sectionParts(state.section).customs;` at the call site (:2842, :2847-2848); P1's resume
    computes both the same way. Its markup becomes
    `landedReplyMarkup(target) ?? (await replyKeyboardFor(chatId))`. The words are Uch band's
    and R2's and are not reworded. (re-check kernel-6)
  - intake-reply-link.test.ts keeps its slice for `landingLinkFor(staff.id, target)` and
    re-points its `(link ? …)` needle at `landingReplyText`'s body; bot-both-modes.test.ts pins
    only `await replyKeyboardFor(chatId)` and needs no re-anchor; intake-confirm.test.ts
    (presses 'save' with no callbackQuery) needs no expectation change. (re-check kernel-6)
- Every collector press of K12's `'own'` class (`save`, `more`, `cancel`, `cancel_y`,
  `done`/`reread`, `cert_y`/`cert_n`, `pick_N`, `conf_N_*`, the four invoice/other-file
  answers) first asks `ownsPress(state, pressedMessageId)`. NOT `resume` (K-review spec-6):
  it is `'prompt'` (K12) and the frozen dispatcher sends it straight to `pressResume`. A ▶️
  under an older collection's pause notice re-prompts whatever is live and writes nothing but
  P1's un-parking touch — what a «continue» means — and the restart question's ▶️, a message
  no collection owns, must keep working; calc-stated-presses.test.ts pins «a prompt-class
  press is not gated». The pressed id being
  `ctx.callbackQuery?.message?.message_id ?? null` (P1 decides what null means). A press from
  another collection's message answers «Bu tugma eskirgan.» in the chat (the press is already
  answered) and changes nothing. K's `ownsPress` is `true`, so behaviour is identical (P1 fills
  it). (re-check kernel-19)
- **The certificate buttons carry their value** (durability-2) — K's one behaviour change:
  `aiConfirmKeyboard(cert)` keeps the toggle's LABEL, the current answer, and gives it the
  OTHER answer's value — with a certificate it draws `📄 Sertifikat: bor` → `c:cert_n`,
  without one `📄 Sertifikat: yo‘q` → `c:cert_y` — so the summary's «📄 Sertifikat: bor
  (o‘zgartirish uchun tugmani bosing)» reads as it always did (K-review spec-4: the first
  wording paired each label with the value it names; the tree and this line are the one
  pairing, and every echo that carries the button (§2.2, §8.2.6) draws it through
  `aiConfirmKeyboard`). The handler SETS `hasCertificate` from the step. A
  repeated or redelivered press is therefore the same answer, never a flip. An old `c:cert`
  answers «Bu tugma eskirgan.». Red proof: restore the toggle → a press delivered twice
  leaves `hasCertificate` false.
- **A restart resumes when it would reopen what is live** (durability-2) — K's second
  behaviour change. A `go_*` press whose pressed message is `state.openedBy` re-prompts the
  live collection instead of restarting it. The restart confirmation («🔄 Ha») claims
  `pressKey(ctx, 'restart')` first; a claim already held resumes. The claim is taken in the
  dispatcher's `calc` branch, on grammy's own ctx (`pressKey` needs `callbackQuery.from`, which
  `CalcPressCtx` does not carry), for a `go_*` step only, and handed down:
  `handleCalcCallback(ctx, chatId, parsed.step, restartKey)`, the fourth parameter
  `restartKey: OnceKey | null = null`, so the six tests' three-argument calls compile.
  (re-check kernel-19) Red proof: drop the
  `openedBy` check → a zone button tapped twice empties the material.
- The ladder's collector branch:
  - `saving` → `⏳ Qo‘shimcha yozilmoqda — natija kelgach yozing.`;
  - `foreignAddReply(…)` — a text replying to another request's ➕-bearing message;
  - then `routeCollectorText(…)`;
  - the reply door's call returns on any non-null result, replying only when `text` is
    non-null (regression-2).
- Every new branch sits BEFORE `if (parsed.kind !== 'approval') return;` (#939).

### K12. `staff-bot.ts` — the callback vocabulary
- `BotCallback` gains
  `| { kind: 'calc_add'; requestId: string; mode: 'plain' | 'restart' | 'replied' } | { kind: 'calc_undo'; tag: string }`.
- `parseCallback`:
  - `^ca:([0-9a-f-]{36})$` → `{ kind: 'calc_add', mode: 'plain' }`;
  - `^cg:([0-9a-f-]{36})$` → `{ kind: 'calc_add', mode: 'restart' }`;
  - `^cu:([0-9a-f]{8})$` → `{ kind: 'calc_undo' }`;
  - `^cf:([0-9a-f-]{36})$` → `{ kind: 'calc_add', mode: 'replied' }` (product-fit-16).
  - None collides: `c:` is anchored to one word; `cl:` / `lc:` are their own letters; the
    cabinet's `lang:` / `ph:` / `mg` are distinct.
- `PRESS_REPEAT` (staff-bot.ts:396): `calc_add: 'keyed'` — the dispatcher's `calc_add` branch
  claims `pressKey(ctx, 'restart')` for the restart form (K11), and the plain form resumes the
  same request's collection; `calc_undo: 'cas'` (`undone`). The `calc` kind keeps its entry
  and gains a per-STEP class beside it (re-check kernel-18):
  `export const CALC_STEP_REPEAT: Record<CalcStep, 'prompt' | 'cas' | 'keyed' | 'own'>`
  (staff-bot.ts, beside `PRESS_REPEAT`; `CALC_STEPS` itself, :462-507, stays private). `'own'`
  = acts only on the collection whose message carries it (`ownsPress`): `cancel`, `cancel_y`,
  `save`, `more`, `done`, `reread`, `cert_y`, `cert_n`, `conf_<n>_<add|rep|ved>`, `pick_N` (its
  message must be `offersMessageId`, regression-23; the first draft's `'cas'` let an old offer
  apply the live `offers[n]`), `inv_add`, `inv_replace`, `other_add`, `other_same` (they rewrite
  the live collection's goods; `invoiceChoice`/`otherFilesChoice` already refuse with nothing
  pending); `'keyed'`: `go_*` (`openedBy` + the restart claim); `'prompt'`: `resume`, `skip`,
  the legacy `cert` («Bu tugma eskirgan.»), the section pickers (`yolkira`, `rastamojka`,
  `podklyuch`, `ai`, `aipk`) and the zone steps (`zone_*`). The fence is the `Record` type (a
  new step without a class does not compile); redelivery-wire.test.ts (10) is re-anchored to
  also require `pressKey(ctx, ` for every step classed `'keyed'`, read through
  `collectorSource()`. No test reads `CALC_STEPS`: topshiriq-buttons.test.ts scans
  `callback_data` literals, and only needs K16's files added.
- `once.ts` (:30): `OnceEffect` gains `'restart'` (a press key, `q:<chat>:<message>:restart`;
  not in `MESSAGE_EFFECTS_DONE`). (re-check kernel-28)
- `CALC_STEPS` gains `'resume'`, `'cert_y'`, `'cert_n'`, `'cancel_y'` and the
  `conf_<n>_<add|rep|ved>` family (parsed like `pick_N`, `n` ≤ 2). `'skip'` and `'cert'` STAY in the
  vocabulary: old messages carry them, and both answer «Bu tugma eskirgan.» (#939: an
  unparsed press spins for 15 s).
- `buttonsFor` is unchanged in K.

### K13. `wms/calc/amend-types.ts` (new, type-only imports)
```ts
export interface AmendBaseItem {
  itemId: string; seq: number; name: string;
  quantity: number | null; weightKg: number | null; volumeM3: number | null;
  measureUnit: MeasureUnit | null; measureQty: number | null; tnvedCode: string | null;
  /** The group's law (judge S9) when grouped, else the book's; null = no law known. */
  law: NeedLaw | null;
  /** In a group a person has ✅'d. */
  confirmed: boolean;
}
export interface AmendBase {
  requestId: string;
  cardLabel: string;
  entityType: 'deal' | 'lead';
  entityId: string;
  /** Does the card still take a job (null on a deal) — `leadTakesJobs`' rule (service.ts:300),
   * read in `storedRequestFacts`; asked again under the lock at the save (§9.5).
   * (re-check kernel-16) */
  leadOpen: boolean | null;
  section: CalcSection;
  clientLabel: string | null;
  openedRev: number;
  items: AmendBaseItem[];               // seq order
  weightKg: number | null; volumeM3: number | null; fromCity: string | null; toCity: string | null;
}
/** What an add collection hands the wms writer — built from the collection by P4's pure
 * `amendSubmissionOf(state)`, so wms never names the bot's `IntakeState`. */
export interface AmendSubmission {
  /** Answered fields of STORED rows, by item id. */
  rowAnswers: { itemId: string; patch: Partial<Pick<CalcGoodsFact,
    'quantity' | 'weightKg' | 'volumeM3' | 'measureUnit' | 'measureQty' | 'tnvedCode'>> }[];
  /** Lines the add collection read or was told, in table order. Raw as read: `amendDiff`
   * hands every one through `doorRow`, like every other door (law-money-4). */
  newLines: CalcGoodsFact[];
  /** Only what a table answer set («jami …», a route) — never what a reading found. A key
   * that is absent is untouched; there is no `null` (an addition never clears a total or a
   * city — law-money-6). */
  totals: { weightKg?: number; volumeM3?: number } | null;
  route: { fromCity?: string; toCity?: string } | null;
  /** Stored rows the new material restated with another figure, still unanswered or sent to
   * the VED with 📨 (law-money-5). An answered 'add' / 'rep' is a `rowAnswers` entry instead. */
  conflicts: { itemId: string; seq: number; name: string; field: string; unit: string; stored: number | null; read: number }[];
  /** Totals answers that later material doubts (CONC-2, R2): absent from `totals` and named to
   * the VED as «· umumiy brutto: 3500 kg so‘ralgan, faylda 4200 kg — VED hal qiladi» (§9.5;
   * re-check p4-6, v2-0). */
  doubtedTotals: { field: 'weightKg' | 'volumeM3'; asked: number; read: number }[];
  /** Law 11: the verbatim words (material, then the answers) and the file count. */
  material: string[];
  fileCount: number;
}
```

Also in K13, stubs that one package fills and another calls (K: inert bodies):
- `wms/calc/amend.ts` (P4 fills): `amendTotalsStale(…)` (K: `{ stale: [], resummedM3: null }`),
  `requeueWaitingAmendments(requestId?)` (K: 0). P3's table and P1's sweep call them;
- `wms/calc/law-asks.ts` (P5 fills): `lawAsksOf(…)` (K: `[]`). P4's `pressAdd` calls it;
- `wms/calc/prefill-queue.ts` (P5 fills): `ticketStanding(requestId)` (K: `'none'`). P4's
  `amendStanding` calls it.

### K14. `service.ts` + `needs.ts` — one reader of a stored request
- `needs.ts`:
  ```ts
  export function groupLawsOf(
    groups: readonly (Parameters<typeof needLawOf>[0] & { items: readonly { seq: number }[] })[],
  ): Map<number, NeedLaw>;
  ```
  lifted from `/hisoblash/[id]/page.tsx:161-163`; the page calls it.
- `service.ts` — it already has the stored-request reader (`goodsByRequest` :1536 over
  `storedGoodsFact` :1524, `bookLawsFor`, `requestAsks` :1592, `checklistFor` :1658), and
  `storedRequestFacts` is built ON it, never beside it (re-check kernel-15):
  - `storedGoodsFact` gains `itemId` (its `GoodsFact` already carries `seq`, :1522);
    `CalcGoodsFact` (wms/calc/intake.ts) gains `itemId?: string | null; seq?: number`;
  - new:
    ```ts
    /** One stored request as the bot reads it: rows in seq order with their law (group's by
     * `groupLawsOf` exactly as `checklistFor` uses them, else the book's), the totals, the
     * clocks, the ending, the pass's job. Pool reads only (#714). */
    export async function storedRequestFacts(requestId: string): Promise<{
      base: AmendBase; facts: CalcFacts;   // goods carry seq, itemId and `law`
      rev: number; handsoffRev: number | null; aiPassRev: number | null; aiPassAt: Date | null;
      aiPassJob: string | null; requestedBy: string; completedAt: Date | null;
      completedVia: string | null; returnReason: string | null; ending: CalcEnding | null;
    } | null>;
    ```
  - `facts.lineWeightsStated = true` and `facts.totalsStored = true` (R2 regression-3 — the
    flags `missingFor`/`lineNeedsFor` force, :1567-1584), so no consumer derives Σ m³ or a lone
    weight from stored rows; `ending = endingOf(row)` (:1433). (re-check kernel-15)
  - **At most four statements, never `loadWorkspace`** (performance-9): `calc_requests` by id,
    `calc_request_items` by `request_id` (`goodsByRequest`), `calc_groups` by `request_id`, and
    one `bookLawsFor` over the ungrouped codes. `loadWorkspace` is ~15 statements (bazas over
    every name, the tariff, fx, import ends), and the press and the reply door await this on the
    poller. `amend-wire.test.ts` pins that the function names no `loadWorkspace`.
  - Nothing calls it in K except its integration test. P5 rebuilds `requestAsks` over it
    (F rule 7), so the stored request has one reader (#513).

### K15. Smaller seams (each inert in K)
- `workspace.ts` `saveTable`:
  - `input.cargo?: { weightKg?: number; volumeM3?: number; fromCity?: string; toCity?: string }`.
    It is applied right after `lockRequestInTx` as a PATCH: only the keys present are written,
    and each is validated by `setCargoFacts`' own rules (`cargoPatchOf`, the validation lifted
    out of `setCargoFacts` so both share it). An absent key is untouched, and the type admits
    no `null` (law-money-6);
  - `opts.inTx?: (tx: TxHandle, rev: number, applied: SaveTableApplied) => Promise<void>`, run
    LAST inside the same transaction, after the clock moves and after the measure pass.
    `SaveTableApplied` = the `measuresDropped` / `measuresCleared` / `basisConflict` the save
    already returns, so the add door's words and thread message say what was really written
    (regression-16);
  - `opts.handsOff?: boolean`, beside R2's `opts?: { expectRev?: number }` (workspace.ts:4155).
    With `expectRev`, after the clock moves: `advanceHandsOffInTx(tx, requestId, expectRev,
    newRev)`;
  - Nothing passes any of them in K.
- `wms/calc/hands-off.ts` (new, one home): `advanceHandsOffInTx(tx, id, from, to)` =
  `UPDATE calc_requests SET handsoff_rev = $to WHERE id = $id AND handsoff_rev = $from`. The
  stamp moves only along an unbroken machine/seller chain. A person's write in between leaves
  it behind `rev` for good, which is «started».
- **The grouping step under the chain** (law-money-2): R2 already chains `expectRev` through
  `proposeGroups`, `applyProposal`, `pullRatesFromDictionary`, `priceProposedGroups` and
  `saveTable` (workspace.ts:2941, :1663, :1321, :3173, :4143). K adds only `handsOff?: boolean`
  beside each existing `expectRev` option, and right after each write that bumps `rev` under
  `locked.rev === expectRev`, `advanceHandsOffInTx(tx, requestId, expectRev, newRev)` when
  `handsOff` — for `pullRatesFromDictionary` inside `setGroupRates`' `mutateRequest`
  transaction, its caller still counting its one revision (`chain += 1`). Inert when nothing
  passes `handsOff`. (re-check kernel-9)
- `wms/calc/workspace.ts` exports `SaveTableRefusal` — the union of every `CalcError` code
  `saveTable` and its callees can throw — read off the throw sites, and pinned by a test that
  parses them.
- `wms/crm/thread.ts` (`addThreadMessage`, :199; there is no platform/collab):
  `insertThreadMessageInTx(tx: Tx, input: { id?: string; ref: ThreadRef; body: string; actorId:
  string | null; tg?: { chatId: bigint; messageId: number }; writtenAt?: string | null }):
  Promise<{ activityId: string; entityType: CardKind; entityId: string; calcRequestId: string |
  null; createdAt: string | null; duplicate: boolean }>` = today's transaction body (targetOf +
  INSERT + audit, its duplicate branch included, `THREAD_TEXT_MAX` asserted), reading nothing
  from the pool; `addThreadMessage` = `db.transaction` of that + the read mark (:263-269),
  unchanged. The announce (`announceNote`, wms/crm/internal-chat.ts:697) stays its callers'.
  (re-check kernel-14)
- `platform/jobs/boss.ts` (re-check kernel-31): `EnqueueOptions` (:191-196) gains `id?: string`
  and `startAfter?: number` (seconds), both passed to `boss.send`; `enqueue(…)` returns
  `Promise<string | null>` (`boss.send`'s id; every existing caller ignores it);
  `jobState(queue: string, id: string): Promise<'created' | 'retry' | 'active' | 'completed' |
  'failed' | 'expired' | 'cancelled' | null>` (`boss.getJobById`; null = no such job). No
  `singletonKey`. `startAfter` lets the reading's delivery-only follow-up wait out Telegram's
  `retry_after` (durability-16). pg-boss's default expiry stays 15 minutes, so every job this
  round adds names its own `expireInSeconds`.
- `platform/telegram/lifecycle.ts` (one seam, inert in K):
  - the update middleware runs `next()` inside an `AsyncLocalStorage` holding the update id,
    and exports `currentUpdateId(): number | null`. The store reads it to know which update
    an unwritten change belongs to;
  - `stopTelegramBot` (:136) gains an OPTIONAL dep `unwritten?: () => number | null` (default
    `() => null`), asked after the flush settles or times out. While grammy is still inside
    the batch (an update in flight, or the next one held by the guard), a number `n` sends the
    stop down the explicit-confirm path through `min(lastDone, n - 1)`, so the update whose
    change is unwritten, and every later one of the batch, is redelivered (durability-10,
    regression-25). Idle — the batch ended, grammy's open `getUpdates` has confirmed every
    update it handled — the stop is the ORDINARY one (`bot.stop()`), `n` is logged
    («an unwritten change belongs to an update already confirmed — lost») and returned as
    `StopOutcome.unwrittenLost`, never claimed as a confirm: an explicit lower offset cannot
    un-confirm anything, and sent while grammy's poll is open it only ends that poll with a
    409 and skips the stop (K-review spec-2). That is why P1's collector writes a message's
    change before its handler returns (§6.2.2). K passes nothing, so the stop's confirm is the
    one that shipped and bot-lifecycle.test.ts's six calls (and bot.ts:131's) compile
    unchanged. P1's call: `stopTelegramBot({ bot, flush: async () => { await
    Promise.allSettled([flushWaitWrites(), flushIntakeWrites()]); }, drain: membershipSettled,
    unwritten: () => { const n = oldestUnwrittenUpdate(); sealIntakeWrites(); return n; } })`.
    (re-check p1-p2-8);
  - the flush's budget is what is left of `BOT_STOP_DEADLINE_MS` minus `CONFIRM_MS` (up to
    4 s when idle), not a fixed `FLUSH_MS = 1 s`: a wait row is bytes, a collection is the
    whole state. §17 measures the worst-case UPSERT against it. In K this applies to
    bot.ts's one flush (`flushWaitWrites`), so it is a stated machine-visible change (§5's
    opening; K-review U6).
- `intake-land.ts`: no extraction (re-check kernel-4). Uch band already makes the landing
  converge per note — `cardOfNote` (:178) finds the note's own card (outcome `'retried'`) and
  `rootRequestOfNote` (:216) its request — so a landing cut off between note and request is
  finished by calling `landCollectedIntake` → `landIntake` again with the same collection.
  K only turns `landIntake`'s two «already queued» exits — `rootRequestOfNote` (:525-526) and
  K2's `opened.existing` — into one local `retried(requestId)`, K body today's `return {
  ...target, queued: true, requestId, queueError: null }`; P2 adds the attach line and P5 the
  queue and the stage move (F rule 1 quotes it whole).
- `ai-cost.ts` (re-check kernel-12):
  ```ts
  type AiPassAnchor =
    | { kind: 'similar'; requestId: null }
    | { kind: 'intake'; requestId: string; intakeNoteId?: string | null }
    | { kind: 'intake'; requestId: string | null; intakeNoteId: string }
    | { kind: Exclude<AiPassKind, 'similar' | 'intake'>; requestId: string };
  export async function attachIntakePasses(noteId: string, requestId: string): Promise<number>; // K: real UPDATE, never throws
  ```
  The third member's `requestId: string | null` lets the reading job pass
  `state.amend?.requestId ?? null` without a branch. `recordAiPass` writes `intakeNoteId` and
  keeps its `createdAt?` input (:53). `attachIntakePasses` = `UPDATE ai_calc_passes SET
  request_id = $request WHERE intake_note_id = $note AND request_id IS NULL`. In K nobody bills
  on the note anchor: the landing still bills `input.usages` (intake-land.ts:574-590) until P2's
  one commit moves billing to the reading job and deletes that loop.
- `prefill-queue.ts` (re-check kernel-31): `export function passQueueOf(section: string | null):
  typeof JOB_CALC_PREFILL | typeof JOB_CALC_TARIFF_REPLY` — the routing `queueCalcPrefill` does
  today (`sectionParts`, prefill-queue.ts:31-46), its one home; `queueCalcPrefill(input: {
  requestId: string; staffId: string; section: string | null; pass?: string; atRev?: number }):
  Promise<boolean>`; `CalcPrefillJob` (jobs.ts:45) gains `pass?: string`, on BOTH queues
  (`calc.prefill`, `calc.tariff-reply`). Inert in K.
- `wms/calc/say-once.ts` — the pass seam is K's (re-check kernel-10):
  `export async function sayOnce(requestId: string, pass: string, input: StaffTelegramInput,
  opts: { whileOpen?: boolean; direct?: boolean } = {}): Promise<boolean>;` (today
  `sayOnce(requestId, input, opts: { whileOpen?: boolean } = {})`, say-once.ts:48-52).
  `claimed()`'s WHERE gains `sql\`coalesce(${notifications}.payload->>'pass', 'landing') =
  ${pass}\`` beside `payload->>'requestId'` — one closure, so both of its reads carry it.
  `extra` becomes `{ ...(input.extra ?? {}), requestId, pass }`, so the queued rows AND the
  CONC-4 `muted / cannot log in` holder row carry the pass. The advisory lock, the
  `requested_at - 1 day` floor (perf-5) and `whileOpen` (CONC-1) are unchanged. K passes
  `'landing'` at jobs.ts:277, :302, :309 (still `{ whileOpen: true }`), :315 and :353: every
  existing row has no `pass` and coalesces to `'landing'`, so behaviour is identical. `direct`
  only for an `amend:*` pass (P5); nothing in K sets it.
- `wms/calc/fit-telegram.ts` (new, zero imports): `fitTelegram`, `TELEGRAM_LIMIT`,
  `MAX_REPLY_LINES`, moved from R2's `ai-reply.ts`. `ai-reply.ts` imports them AND re-exports
  them, so prefill-reply.ts:11 and ai-reply.test.ts keep their imports (re-check kernel-26).
  `fitTelegram(head, lines, fixed, tail, opts?: { maxLines?: number })`, with
  `maxLines` defaulting to `MAX_REPLY_LINES`. The reply keeps the default; the table passes
  `Infinity` (product-fit-10).
- No `onConflict` seam on `addActivity` or `insertActivityTx` (re-check kernel-13): the add
  door writes its card note through Uch band's `insertActivityTx(exec, input, ctx)`
  (crm/service.ts:1545) inside the transaction that records the amendment, right AFTER that
  row's `INSERT … ON CONFLICT (note_id) DO NOTHING RETURNING id` returned a row — no row =
  duplicate, nothing written (durability-15, §9.5).
- `platform/notifications/staff.ts`: `StaffTelegramInput` gains `ignoreMute?: boolean`. With
  it, `queueStaffTelegram` writes a muted person's row `status: 'pending', error: null` and
  adds `direct: true` to its payload (a person who cannot log in still gets no row). Only
  `sayOnce`'s `direct` sets it; nothing in K. Mutes are decided at QUEUE time there
  (staff.ts:37-60), never by the drain, and there is no `mutedFor`. (re-check kernel-11)
- **`routeAnswer` is merged the way R2 merges `totalsAnswer` under CONC-2** (durability-17):
  in `analyzeCollected` (both the new-request and the add branch) a `routeAnswer` key is
  applied only while no material after `at` names a different city for it
  (`parseManualFacts(material.slice(at.material).join('\n'), section)` — a SLICE, not R2's
  `since` call: that passes the whole text with `{ from }` (calc-intake.ts:1549-1553), and
  `readRoute` ignores `from` (intake-manual.ts:182), so the offset form would let the city
  text the answer corrected doubt it; re-check v1-7); otherwise the reading's city stands. It sits above `manual` in
  the fromCity/toCity chain (today `manual ?? ai ?? state.route`, :1531-1532). `settleAnalysis`
  re-merges the live `routeAnswer` only when it differs from the snapshot's (the
  `sameTotalsAnswer` rule, :495). Inert in K: nothing writes it. P3 writes it (§8.2.6), P3's
  undo reverts it, P4's `amendSubmissionOf` reads it. Without it a typed «Yiwu → Toshkent»
  answer lived only in `facts`, and the next reading rebuilt `facts` from the material and
  erased it. (re-check kernel-8)
- `boss.ts` `WORKER_REGISTRATIONS` gains
  `['calc-intake-read', … registerCalcIntakeReadWorker]`,
  `['calc-intake-sweep', … registerCalcIntakeSweep]` and
  `['calc-amend-save', … registerCalcAmendSaveWorker]`. All three are in K so P1, P2 and P4
  never touch `boss.ts`.

### K16. The collector's files, one list for every source-shape fence
- New `tests/fixtures/calc-collector-source.ts`, beside `tests/fixtures/source-shape.ts` (there
  is no tests/unit/helpers/; P2's `driveReading` goes to `tests/fixtures/calc-read-drive.ts`)
  (re-check kernel-20):
  ```ts
  export const CALC_COLLECTOR_FILES = ['staff-handlers.ts', 'calc-store.ts', 'calc-files.ts',
    'calc-dialog.ts', 'calc-keyboards.ts', 'calc-read.ts', 'calc-intake-sweep.ts', 'calc-amend.ts'];
  export function collectorSource(): string;  // the files concatenated
  ```
- Re-anchored to read `collectorSource()` where they read `staff-handlers.ts` for a MOVED
  literal (reason: the subject moved; the reading set is derived so a ninth file joins every
  fence at once):
  - `calc-intake-lines.test.ts` (the derived `c:` buttons, the merge on the analysis path);
  - `intake-images.test.ts` (`reduceForModel`, `MAX_INTAKE_IMAGES`; `images: state.images`
    becomes `files.images`);
  - `intake-round1.test.ts` (`AI_READ_FAILURE[failure].text`, not «AI mavjud emas»);
  - `bot-ai-dispatch.test.ts`'s analysis half (`void analyseIntakeAndReply(` in
    `calc-read.ts`);
  - `ai-rastamojka-bot.test.ts` (the `startIntake` literals with `staffId`, `isZoneStep`,
    `zoneKeyboard`), and :159's `if (intake && !escapesIntake(ctx.message.text) && !late)` →
    the ladder's new `!escapesIntake(ctx.message.text)` guard beside `intakeTakes(` (K3; the
    test anchors on the predicate's name) (re-check v1-6);
  - `intake-customer-name.test.ts:105-107` reads `collectorSource()` and its two needles become
    `readCustomerText(text, await clientCodePrefix())` and `clientAnswer(intake, text, read)` —
    `routeCollectorText`'s `text` parameter (K6), where `ctx.message.text` cannot appear
    (re-check kernel-20, v1-6);
  - `redelivery-wire.test.ts` (8) and (10) — (10) also requires `pressKey(ctx, ` for every
    step `CALC_STEP_REPEAT` classes `'keyed'` (K12) (re-check kernel-20);
  - `topshiriq-buttons.test.ts`'s derived scan (:106-110) adds `CALC_COLLECTOR_FILES` to its
    three sources, or the moved calc keyboards leave the #939 fence (re-check kernel-18).
- Re-anchored with the moved import path (re-exports keep most): `intake-corpus.test.ts`,
  `intake-collector*.test.ts`, `calc-kiritish.integration`, `bot-redelivery.integration`.
- Re-anchored because K changes `sayOnce`'s signature (re-check kernel-10), to K's literal
  `'landing'` (P5 later moves them to `pass`, F §10.3): calc-prefill-once.integration's three
  direct `sayOnce` calls take `'landing'` (its other three tests drive the worker; re-check v3-3); calc-prefill-standdown.test.ts — every `toHaveBeenCalledWith('r1', …)`
  gains `'landing'` second, `call[1]`→`call[2]`, `call[2]`→`call[3]`; calc-prefill-wire.test.ts
  :172 and intake-round1.test.ts:244/:246 → `sayOnce(requestId, 'landing', {`; intake-corpus
  c0220 reads `call[2].text`, c0221 → `toHaveBeenCalledWith('r1', 'landing',
  expect.objectContaining({ text: STOOD_DOWN.touched }))`. CONC-1, CONC-4 and perf-5 keep their
  assertions.
- On the list with no expectation change: totals-question.test.ts (its `fakeCtx` already
  returns `{ message_id }` and compiles against `CalcPressCtx`, K6), intake-confirm.test.ts
  (mechanical: its inline fake at :54 becomes `async (text: string) => { replies.push(text);
  return { message_id: replies.length }; }` — `CollectorReply.reply` returns the sent message;
  no expectation changes) (re-check v1-1),
  calc-landed-words.test.ts (`landedWords` re-exported, K6). (re-check kernel-20)
- `readIntakeFile` drives gain `attachmentId: 'a-…'`. `receivePdf` drives pass
  `{ attachmentId, name, bytes }`. `startIntake` drives pass `staffId`. All mechanical; every
  `said` untouched.
- **The re-anchor list is DERIVED, not remembered** (regression-9). Before K is cut, the
  lead runs one grep over `tests/` for every identifier and literal this round moves or
  retires:
  - `askingIndex`, `reasked`, `lineDone`, `MAX_QUESTION_ROUNDS`, `placeLineDone`,
    `nextLineToAsk`, `lineQuestionText`, `resolveLineDone`, `carryLineDone`, `doneLine`;
  - `totalsAsked`, `askingTotalsFor`, `totalsQuestion`, `totalsQuestionText`,
    `totalsStillAsked`, `TotalsAsk`, `TOTALS_NOT_READ`, `intakeSummaryText` (re-check p3-5,
    p3-13, v2-5);
  - the ladder's `!late` / `escapesIntake(ctx.message.text)` and `ctx.message.text` inside the
    branch K6 moves (re-check v1-6);
  - the stage literal `'question'` inside the collector's tests;
  - `skipKeyboard`, `lineOfferKeyboard`, `analyseIntakeAndReply`, `askNextOrConfirm`,
    `mergeLineAnswers`;
  - the `c:cert` literal (press.test.ts uses it only as a press string; it stays parseable);
    `INTAKE_TTL_MS` is not on it — nothing in tests/ names it (re-check kernel-21);
  - R2's totals-shape helpers K6 moves (`totalsAnswerShape`, `looksLikeTotalsAnswer`) and
    `LOST_TOTALS_ANSWER`, which P3 retires; `sayOnce`; `landedWords`, `TARIFF_FOLLOWS`;
    `usages` (P2's billing);
  - the retyped state shapes in FIXTURES (regression-9): `pdfs: [{ data`, `images: [{ data`,
    `data: Buffer` inside an `IntakeState` literal;
  - drives that reach the summary or a question through a retired press: `'skip'` handed to
    `handleCalcCallback`, `c:skip`, `stage: 'question'`;
  - drives that press `'done'` / `c:done` and then wait for `stage: 'review'` or
    `analysing: null` (regression-10): «Bo‘ldi» only enqueues after P2, so each such drive
    needs the job helper (§11, `tests/fixtures/calc-read-drive.ts`).

  The output is pasted into §11 as the list, and each hit gets its package and reason. Run on
  R2's P3 tree (`61f6ec1`), it named files the first draft missed:
  `intake-round1.test.ts` (`reasked`, the save guard's `'question'` literal at :204),
  `intake-collector-r4.test.ts` (`resolveLineDone`, `carryLineDone`), and `intake-facts.test.ts`,
  `intake-volume.test.ts` and `calc-intake.integration.test.ts` (`intakeSummaryText`, which this
  round deletes). Re-run on 0373bd2 it adds (re-check kernel-20): `totals-question.test.ts:342`
  and `intake-weight-basis.test.ts:129` (`intakeSummaryText` — FIVE files, §8.1), the files of
  the bullets above (intake-customer-name, redelivery-wire (8)/(10), intake-confirm,
  totals-question's ctx, intake-own-budget and intake-usage.integration for P2's billing, the
  `sayOnce` re-anchors), and `calc-kiritish.integration` (`lineDone`, `resolveLineDone`). A test that
  goes red in K or in a package and is NOT on the derived list is a defect report, not a
  re-anchor.

---

## 6. P1 «Saqlash» — the collection survives (1.8 c, Q5 a)

### 6.1 Files OWNED
- `src/modules/platform/telegram/calc-store.ts` (with the test hooks `__forgetIntakeMemory()`
  and `__intakeWriteCount()`, waits.ts's `__forgetWaitMemory` idiom, :182),
  `calc-intake-sweep.ts`, `bot.ts` (the hydrate, `markIntakesHydrated`, and the stop's flush,
  seal and `unwritten` dep), `backlog.ts`. P3 owns one hunk in calc-store.ts, `startIntake`'s
  defaults for its fields, and one in calc-intake-sweep.ts, `pressResume`'s `'question'`
  branch (K9); the lead applies both at the P3 pick (re-check p1-p2-9, p3-13, v2-1).
- `src/modules/platform/telegram/once.ts`: ONE hunk, the nightly prune's extra `DELETE`
  (rule 17).
- New `src/modules/wms/calc/intake-ended.ts`. Platform reaches it only by
  `await import('../../wms/calc/intake-ended')` (calc-store.ts's hydrate, the sweep), the
  collector's rule that platform never imports wms statically (re-check p1-p2-10).
- Tests:
  - new: `calc-store-durable.integration.test.ts`, `calc-intake-sweep.test.ts`,
    `calc-intake-takes.test.ts`, `calc-landed-already.integration.test.ts`,
    `intake-holds-wire.test.ts`;
  - re-anchors: `bot-redelivery.integration.test.ts` (eight new blocks, §6.3);
    `redelivery-wire.test.ts` (6), rule 10; `tests/fixtures/bot-harness.ts`, whose flush
    (:147) flushes intakes beside waits. `BACKLOG_SENTENCE`'s existing pins stay: today's
    sentence is kept wherever no collection survived (rule 16), I20b included
    (re-check p1-p2-9, p1-p2-7).

### 6.2 Rules
1. **Memory stays the reader**, the 0130 idiom (`waits.ts`). Every read on the ladder stays
   synchronous; the table only has to outlive the process.
   - The map lives on `globalThis` (`globalForIntakes.collections`), like
     `globalForBoss`/`globalForBot`, so the pg-boss jobs and the poller in the app process
     read ONE map whatever chunk imports the module.
   - `setDurableIntakes(true)` in `startTelegramBot` beside `setDurableWaits(true)`; a test
     opts in.
2. **Writes are DEBOUNCED, per chat, latest wins** (performance-2). The first draft scheduled
   one chain step per change. At the poller's real cadence (an awaited Telegram call after
   every update) that step runs DURING the await, so it was one full-state UPSERT per message.
   Probe `r3/probe/perf-coalesce.mjs`: 20 messages → 20 writes.
   - `updateIntake` / `startIntake` / `endIntake` mark the chat dirty and (re)arm its timer:
     write after `INTAKE_WRITE_QUIET_MS = 1_000` of quiet, and at the latest
     `INTAKE_WRITE_MAX_MS = 5_000` after the first unwritten change.
   - The write takes whatever memory holds at that moment: an UPSERT, or a DELETE when memory
     has no entry.
   - `flushIntakeWrites(chatId)` cancels THAT chat's timer and awaits THAT chat's write; its
     boolean speaks for that chat only (performance-10). `pressAnalyse`, `saveAmendment` and
     both jobs pass their chat. `flushIntakeWrites()` with no chat (the stop, tests) writes
     every dirty chat. Either returns `false` when the store is sealed or a write failed.
   - **A collection-changing MESSAGE is written before its handler returns** (K-review
     spec-2): the collector's text, file, contact and reply paths end with `await
     flushIntakeWrites(chatId)` whenever they changed the collection. grammy confirms a batch
     with the `getUpdates` that follows it, at once, so a change left to the 1 s timer belongs
     to an update Telegram has already dropped, and the stop's `unwritten` can no longer hold
     it back (K15). The cost is THIS chat's one UPSERT per such message, awaited where the
     handler already awaits its Telegram reply (#706 allows a chat's own write, as for
     presses); the debounce still coalesces everything off the poller (the jobs, the sweep)
     and repeated changes inside one handler. A `false` (the database down) is logged once and
     the timer retries; the message is answered as before.
   - **A failed write keeps the chat DIRTY** and is retried by the next timer (5 s), never
     dropped (durability-10). It logs once per process (the waits idiom); memory still
     answers. The first draft copied the waits idiom's «log once and forget», under which a
     seller's change that failed to write was lost at the next deploy with its update
     confirmed.
   - Each dirty chat keeps `dirtyFrom` = the lowest `currentUpdateId()` (K15) among its
     unwritten changes; a job's change (no update) records none. `oldestUnwrittenUpdate()` is
     the minimum over the dirty chats, cleared per chat when its write lands.
3. **The seal** (durability-1). After the stop's flush, `sealIntakeWrites()`: this process
   writes no more rows and every later `flushIntakeWrites()` answers `false`. An update still
   running in the old process past the 3 s in-flight budget (an Excel parse, an upload) is
   unconfirmed and redelivered to the new process. Its late effect here must never overwrite
   the row the new process hydrated.
4. **The row**:
   ```sql
   INSERT INTO telegram_calc_intakes (chat_id, staff_id, note_id, state, opened_at, touched_at, expires_at)
   VALUES (…) ON CONFLICT (chat_id) DO UPDATE SET staff_id = EXCLUDED.staff_id, note_id = EXCLUDED.note_id,
     state = EXCLUDED.state, opened_at = EXCLUDED.opened_at, touched_at = EXCLUDED.touched_at,
     expires_at = EXCLUDED.expires_at
   ```
   - `state` = `JSON.stringify(state)` minus `expires`.
   - A state over 2 MB logs `[calc-intake] large collection` with its size and is written
     anyway. §17 measures the worst case; it is written once per collection-changing message
     (§6.2.2) and otherwise, with the debounce, at most once a second.
5. **Readiness** (#472): `intakeTableReady()` is `to_regclass('public.telegram_calc_intakes')`,
   caching TRUE only (`redelivery-ready.ts`'s shape). Code ahead of the migration is today's
   memory-only store.
6. **The clocks.**
   - `INTAKE_TTL_MS = 24 h` from `touchedAt`; `HOLD_MS = 30 min` from `touchedAt`.
   - Every update slides `touchedAt` and clears `remindedAt`, EXCEPT `{ quiet: true }`.
   - P1 marks quiet: the reminder's own mark (and its release after a failed send), the
     pause notice's id (`noteOwnMessage`, called by K6's `answerStaffText` call site; re-check
     v2-8). P2, P3 and P4 mark theirs (§7.2, §8.2, §9.6): `tableMessageId`,
     `tableHash`, `promptMessageId`, `offersMessageId`, `standingAtOpen`, `repliedTaken`,
     echo and `ownMessageIds` entries, the job's settle, stored reply and `pendingReply.jobId`,
     `analysingAt` released by the job, `saving` released by the save job.
   - `activeIntake(chatId, atMs = now)` treats an entry whose `touchedAt + INTAKE_TTL_MS <= atMs`
     as ended, and hands it to `expireIntake(chatId, state)`: the ONE end path, shared with the
     sweep, so calc-store.ts exports it (the sweep is another file; re-check p1-p2-10). It
     deletes the entry (memory, then the row) and, when the collection is not empty, sends §2.7's «⌛ … o‘chirildi» line by chat id (`void`, off the ladder). The first draft
     ended it silently on any read, so a seller writing in the ≤ 5 minutes before the sweep's
     tick never got the line (durability-12 a). The deletion goes first, so the sweep and a
     read can never both send it.
   - The ladder passes `atMs` = the message's WRITTEN date for a backlog message
     (`isBacklog(date) ? date * 1000 : now`), the 0130 rule that judges a wait by the message
     date: an answer written at 23 h 50 m and processed at 24 h 10 m still belongs to its
     collection (durability-12 c).
7. **Parking — waits 24 h, holds 30 min** (regression-1).
   - `intakeHolds(state, atMs) = atMs - state.touchedAt < HOLD_MS`.
   - `holdingIntake(chatId)` = the live collection when it holds now. It is asked by the four
     doors that refuse beside a collection: «➕ Topshiriq» (`startTaskDraft`,
     task-handlers.ts:127), the zametka «Yangi» step, the 💬 door (`handleThreadReplyPress`),
     and the shared-contact branch. A parked collection does not refuse them. The ladder judges
     the hold per message, at the message's date, through `intakeTakes` (rule 8.4).
   - The orphan guard in `answerStaffText` (K6, today staff-handlers.ts:1208-1212) is a
     «holds» site too: R2's gate stays (`opts.messageId !== null && !opts.waitDeclined`), with
     `!holdingIntake(chatId)` for «no collection» and `activeIntake(chatId)` handed to
     `orphanAnswerSentence` as `parked`. A parked collection's table-shaped text therefore
     gets `orphanAnswerSentence`'s answer (§2.7's pause line once P3 lands), never the paid
     assistant (re-check p1-p2-5).
   - A text, file or contact a parked collection does not take goes on down the ladder. It
     never touches the collection, so it never slides the clock. A seller who uses the bot
     every day still lets an abandoned collection expire.
   - What un-parks it: «▶️ Davom etamiz», any of its own buttons (a press touches), a reply to
     one of its own messages (`ownMessageIds`), the ➕ resume of the same request.
   - `intake-holds-wire.test.ts` (derived; src read through `tests/fixtures/source-shape.ts`
     `srcFiles()` with `strip` — comments stripped, #725) lists every `activeIntake(` call in
     `src/` by file and function, and requires each to be on one of two named lists
     (re-check p1-p2-4):
     - «presence»: the sweep; calc-store.ts's own reads (`updateIntake`, `expireIntake`,
       `liveIntakes`, `collectionSurvived`); the restart question; `handleCalcCallback`'s own
       state read and `pressResume` (a collection's own button un-parks it); calc-read.ts's
       settle and release (§7.2.4.6, §7.2.4.8); `landCollectedIntake` (staff-bot.ts:1296);
       `pressAdd`'s «another collection» check;
     - «holds»: the text ladder, the file ladder and the voice/audio handler (K3's three
       `!late` checks, now one `intakeTakes` verdict); the four doors; the orphan guard.
     A «holds» site must also ask `holdingIntake(` or `intakeTakes(`: one that asks
     `activeIntake` alone fails it, and so does an unlisted call. A package adding a call
     adds it to a list with its reason (a press is «presence»).
8. **`intakeTakes(state, msg)`** (pure; one home; the ladder asks it for every text, file,
   contact and reply):
   1. `msg.messageId <= state.takenUpTo` → `'seen'`. The ladder drops it silently: it was
      applied before a crash, or by the old process before its flush.
   2. `isBacklog(msg.date) && msg.date < Math.floor(state.openedAt / 1000)` → `'pass'`.
   3. `msg.replyTo !== null && state.ownMessageIds.includes(msg.replyTo)` → `'take'`.
   4. `!intakeHolds(state, msg.date * 1000)` → `'pass'` (parked at the message's own date).
      For a backlog message that is the date it was WRITTEN: a collection holding then takes
      it.
   5. else `'take'`.
   - Every `'take'` writes `takenUpTo: max(takenUpTo, messageId)` in the SAME patch as its
     effect. The row carries both or neither, so a write lost in a crash is redone and a
     write that landed is not (exactly-once relative to the durable state).
   - A file's attachment is keyed by the message (K5), so a redone file is the same attachment.
   - The backlog sentence loses «Hisoblatish» only in a chat whose collection survived the
     restart (rule 16, §2.7); `BACKLOG_SENTENCE` itself stays today's (re-check p1-p2-7).
9. **`ownsPress(state, pressedMessageId)`** = `pressedMessageId` is `state.openedBy` or in
   `state.ownMessageIds`. Every message the collection sends itself joins `ownMessageIds`
   quietly (last 40): the prompt, the table (each fresh send), every echo, the reminder, the
   pause notice. A press from an older collection's message, including a crash-redelivered
   «✖️ Bekor qilish», changes nothing (durability-2).
10. **Hydrate** before the first `getUpdates`: in `bot.ts`,
    `void Promise.allSettled([hydrateWaits().catch(log), hydrateIntakes().catch(log)]).finally(() => { markIntakesHydrated(); startPolling(30_000); })`.
    The first draft's `Promise.all` dropped today's `.catch` (an unhandled rejection) and
    settled on the FIRST failure, so polling could start while the other hydrate was still
    loading, and the backlog met half-restored memory: the very failure the order pin exists
    for (regression-20, durability-11). `markIntakesHydrated()` resolves `intakesHydrated`
    for the jobs (durability-9); a hydrate that failed still resolves it, because memory is
    then the only truth this process has.
    - It loads every row with `expires_at > now() - interval '24 hours'`; memory wins on an
      existing key. A row already expired is loaded so that the sweep ends it WITH the line
      (durability-12 b); the first draft loaded only unexpired rows and nothing ever deleted
      the others, so a customer's name, phone and material sat in `state` for ever.
    - Then it asks `intake-ended.ts` `endedCollections(rows)` (dynamic import, §6.1) which ones
      are over, and DELETEs those:
      - a new-request collection is over when a ROOT `calc_requests` row carries its note id
        («landed»): `rootRequestOfNote`'s predicate (`note_id = … AND supersedes_request_id IS
        NULL`, the WHERE of K2's `rootOfNoteSql`), asked in ONE statement over the hydrated
        note ids — one home for «landed», shared with the sweep's `landingState` (rule 15). A
        note on a card with NO request is a landing cut off halfway (durability-3): the
        collection is KEPT, and the sweep resumes it (rule 13) (re-check p1-p2-1);
      - an add collection is over when its `calc_amendments` row exists AND
        `outcome_sent_at IS NOT NULL`. An amendment that exists but was never told is KEPT,
        and its save job is re-enqueued with the save job's own options (`{ id, expireInSeconds:
        120, retryLimit: 3 }`, §9.5). No `singletonKey`: pg-boss 10.4.2 dedupes it only on a
        non-standard queue, and `enqueue` creates standard ones. A duplicate job is harmless:
        it answers `duplicate` off `calc_amendments_note_unique` and redoes only what is missing
        (§9.5, durability-4) (re-check p1-p2-13).
    - `redelivery-wire.test.ts` (6) is re-anchored (reason: two tables restore now, and neither
      may start polling early): its order pin gains `setDurableIntakes(true);` after
      `setDurableWaits(true);` and ends at `void Promise.allSettled([` instead of
      `void hydrateWaits()`; «the first getUpdates waits for the restored waits» requires
      `markIntakesHydrated(); startPolling(` inside that statement's `.finally` (read to the
      statement's end — the body now holds a `;`) (re-check p1-p2-9).
11. **The stop** (bot.ts:131; `stopTelegramBot`, lifecycle.ts:136, whose `unwritten` dep K15
    makes OPTIONAL, default `() => null`, so bot-lifecycle.test.ts's calls compile unchanged):
    `stopTelegramBot({ bot, flush: async () => { await Promise.allSettled([flushWaitWrites(),
    flushIntakeWrites()]); }, drain: membershipSettled, unwritten: () => { const n =
    oldestUnwrittenUpdate(); sealIntakeWrites(); return n; } })` (re-check p1-p2-8). The seal
    is taken at the moment the stop reads the answer, so nothing written after it can disagree
    with what was confirmed. K15's lifecycle seam then confirms only through the
    update before `n` (durability-10, regression-25) while `n`'s batch is still being handled;
    an `n` of an ended batch is already confirmed and comes back as `unwrittenLost`, logged
    (K-review spec-2) — rule 2's write-before-return is what keeps that rare. The flush's
    budget is the rest of the 5 s (K15).
12. **`loadIntake(chatId)`**: `await intakesHydrated(INTAKE_HYDRATE_WAIT_MS)` (10 s); not ready
    → throw `IntakesNotReady`; ready → memory, else null. NEVER the table (performance-7: a
    table read after hydration resurrected a collection whose DELETE was pending or had
    failed, and the next write UPSERTed it back). pg-boss starts its workers before the bot
    hydrates (`instrumentation-node.ts`: `startBoss()` first), so a job fetched in that window
    used to find nothing and complete silently (durability-9). Only the reading job and the
    save job call it.
13. **The sweep** (`calc.intake-sweep`, `*/5 * * * *`, registered by
    `registerCalcIntakeSweep`). It does nothing when `!durable` (the bot is not running in
    this process). For `BOOT_GRACE_MS = 2 min` after boot it ends nothing, so the backlog is
    applied before an expiry is judged (durability-12 c).
    - It iterates `liveIntakes()`. For each entry, the pure
      `sweepAction(state, now, facts): SweepAction` decides. `facts` =
      `{ readingAlive, landing, pendingDeliveryAlive, savingAlive, pressLandingMs, sinceBootMs }`,
      read before the call (`savingAlive` = P4's `savingAlive(state)`, re-check v2-6;
      `pressLandingMs` = ms since rule 15's `landingPressAt` stamp for the chat, or null,
      re-check v2-11);
      `landing` = rule 15's `landingState(noteId, staffId)` for a new-request collection
      (`amend === null` — an add collection's note is its save job's, §9.5), else `'none'`.
      `SweepAction` = `'none' | 'remind' | 'end_silent' | 'end_said' | 'release_reading' |
      'release_saving' | 'resume_landing' | 'deliver_pending'`:
      - `resume_landing` when `facts.landing !== 'none'` and no press landed this chat in the
        last 60 s (`facts.pressLandingMs === null || facts.pressLandingMs >= 60_000`, re-check
        v2-11) (rule 10's kept collection, or one that
        landed and survived; rule 15) (re-check p1-p2-1);
      - `end_*` when `now >= touchedAt + INTAKE_TTL_MS`: `_said` when the collection holds
        material, a file, answers or a named customer, else `_silent`;
      - `release_reading` when `analysing !== null` and its job is dead
        (`!facts.readingAlive`, P2's `readingAlive`, performance-1);
      - `deliver_pending` when `pendingReply !== null`, it is older than 60 s
        (`pendingReply.at`), and no delivery job of it is alive
        (`!facts.pendingDeliveryAlive`): the stored, paid table is sent by P2's
        `deliverStoredReply(chatId, state)` (durability-16). The first draft's
        `release_reading` needed `analysing !== null`, which the settle had already cleared,
        so such a table was never sent;
      - `release_saving` when `saving !== null` and `!facts.savingAlive` (P4's
        `savingAlive(state)` = `jobState(JOB_CALC_AMEND_SAVE, saving.jobId)` is `created |
        retry | active`) (re-check v2-6);
      - `remind` when `remindedAt === null && now - touchedAt >= REMIND_AFTER_MS`, the
        collection is not empty, not `saving`, and no LIVE reading;
      - else `none`.
    - On `remind`: the claim first — `updateIntake(chatId, { remindedAt: now }, { quiet: true })`
      — then `sendText({ chatId, text, replyMarkup, silent })` (§2.7; `sendText`, because a sweep
      never sleeps — send.ts:337-344). Its message id joins `ownMessageIds`. `result.permanent`
      (400/403 — the bot blocked, no such chat) is logged and stays claimed; no retry storm.
      Any other failure — a 429, `botDown`, a 5xx, no answer — RELEASES the claim (quiet), so the
      next tick tries again: the first draft kept it claimed, and that idle stretch was never
      reminded (durability-19) (re-check p1-p2-11).
    - On `end_*`: `expireIntake(chatId, state)` (rule 6), which sends the line when `_said`.
    - On `release_reading`: P2's `releaseDeadReading(chatId, state)`.
    - On `release_saving`: P4's `releaseDeadSave(chatId, state)` — `saving: null` (quiet) and
      «Qo‘shib bo‘lmadi — «✅ Qo‘shish» ni qayta bosing.» (§2.4's last-attempt words)
      (re-check v2-6).
    - On `resume_landing`: rule 15's resume, by chat id.
    - On `deliver_pending`: P2's `deliverStoredReply` (bounded, like the job's step 7).
    - Then, once per tick, P4's `requeueWaitingAmendments()`: a stored «waiting» addition
      whose request has no live ticket is enqueued again. This covers a settle whose own
      enqueue was lost (§9.5).
    - `silent: quietHour()` (platform/telegram/send.ts:121 — Tashkent 22:00-08:00, the bot's one
      night, the same one every other silent message uses; no second hour test in
      `platform/time/tashkent.ts`, which has none) (re-check p1-p2-11).
14. **`pressResume(ctx: CalcPressCtx, chatId)`** (K9; it speaks only through `ctx.reply`, the
    press already answered — re-check kernel-19): refused in words while a task draft or a
    zametka capture is live (§2.7). Otherwise `updateIntake(chatId, {})` (a touch, which un-parks) and the stage's
    prompt (§2.7). The `review` stage calls P3's `deliverNextStep` through the frozen K6 seam.
15. **`landedAlreadyReply`** = `resuming.has(chatId)` (a per-chat in-memory set, shared by the
    press and the sweep, which run in one process). Otherwise the press lands normally: P1's
    `landedAlreadyReply` also stamps `landingPressAt.set(chatId, now)` before it answers false,
    and the sweep's `resume_landing` waits while that stamp is under 60 s old
    (`facts.pressLandingMs`), so a tick during a live press's landing leaves it to the press
    (K11's save branch is frozen, so the press cannot join `resuming` itself; re-check v2-11);
    `landCollectedIntake` → `landIntake`, which converges by itself — Uch band (round 4 and 8,
    shipped, docs/UCH-BAND.md) already makes the landing idempotent per note: `cardOfNote`
    (intake-land.ts:178, sender-fenced) finds the note's own card (outcome `'retried'`), and
    `rootRequestOfNote` (:216) the request if one exists (`landIntake`'s `retried` exit,
    :525-526, §7.2.9). No extraction, no second `crm_activities` reader (re-check p1-p2-1,
    p1-p2-2).
    - The sweep's `resume_landing` asks `intake-ended.ts` `landingState(noteId: string, staffId:
      string): Promise<'none' | 'landed' | 'note_only'>` = `'landed'` when
      `rootRequestOfNote(noteId) !== null`, `'note_only'` when `cardOfNote(noteId, staffId,
      null)` is a target (not null, not `'foreign'`), else `'none'` — two calls, no SQL of its
      own.
    - On `'landed'` or `'note_only'`: add to `resuming`; `target = await
      landCollectedIntake(chatId, state.staffId, staffName)` (`staffName` from
      `staffForChat(chatId)`); send `landingReplyText(target, { link, tariffFollows })` —
      `link = await landingLinkFor(state.staffId, target)`, `tariffFollows =
      target.replyQueued === true && !sectionParts(state.section).customs`, computed as the
      save branch does (K11) — with `landedReplyMarkup(target) ?? await
      replyKeyboardFor(chatId)`; `endIntake`; remove from `resuming`. The ✅'s first line is
      Uch band's `landedWords` for a retried card, «✅ Saqlandi — oldingi urinishda ochilgan …»
      (§2.7), the same sentence a re-press after a full landing gets. A collection that landed
      and survived (a kill between the commit and `endIntake`) therefore gets one more ✅,
      never one fewer (stated).
    - The «landed» check (`rootRequestOfNote`) comes first, before any refusal — Uch band's
      order — so a landed note never meets «lid yopilgan». Two resumes cannot both run in one
      process (`resuming`); a concurrent twin across processes is caught by K2's per-note lock
      at the top of `openCalcRequest`'s transaction (`existing` → `retried`), and the ticket's
      «no ticket standing» clause (§10.2.1) makes them one pass (re-check p1-p2-3).
    - Stated, not changed: a landing whose note committed but whose request was REFUSED
      (`queueError`, e.g. `server_behind` one migration behind) ends the collection as today
      (the save branch's `endIntake`, staff-handlers.ts:2829, K11's); only a crash is resumed
      (§15) (re-check p1-p2-26).
16. **`backlogSentence(hasCollection: boolean)`** (`backlog.ts`, regression-24): with a
    collection that survived the restart, the sentence without «Hisoblatish» (§2.7); otherwise
    today's `BACKLOG_SENTENCE`, «Hisoblatish» kept, because a collection CAN still be lost (the
    deploy that introduces durability, a readiness probe answering false, a write that failed).
    `tellBacklogOnce` (backlog.ts:32, five callers: staff-handlers.ts:715, :801, :1035, :1191,
    task-handlers.ts:527) decides it itself: it passes `collectionSurvived(chatId)` = a live
    collection whose `openedAt < bootedAtSec() * 1000` (opened before this boot = hydrated),
    read from calc-store.ts (platform → platform); no caller changes, and the once-per-chat-per-
    boot key is unchanged. A collection a LATE press opened after boot is not a survivor: its
    chat keeps today's sentence (I20b). Red proof: use `activeIntake(chatId) !== null` → I20b
    red (re-check p1-p2-6, p1-p2-7).
17. **The prune** (`once.ts`'s nightly job, ONE hunk): `DELETE FROM telegram_calc_intakes
    WHERE expires_at < now() - interval '1 day'` beside its two existing deletes
    (durability-12 b), only when `intakeTableReady()` — `pruneTelegramRedelivery`
    (once.ts:138-145) is guarded by `redeliveryReady()` alone, 0130's two tables, so one
    migration behind the third DELETE would throw 42P01 after the first two ran. The return
    gains `intakes` (`{ once, waits, intakes }`) and the log condition sums all three
    (once.ts:156) (re-check p1-p2-12, v2-14). A row past the hydrate's 24 h reach is one no process
    will ever end with a line, and it holds a customer's name and phone.

### 6.3 Tests (P1) — red proofs by string edit
**`calc-store-durable.integration.test.ts`** (durable on, a real database):
- (a) start, three updates, `flushIntakeWrites`, forget memory, `hydrateIntakes` → the same
  state back, field for field.
  **Red proof:** make the write a no-op → hydrate returns 0.
- (b) the stored jsonb has no `"type":"Buffer"` and its images are `{ attachmentId }`.
  **Red proof:** store K's pre-K4 shape → the assertion finds the Buffer.
- (c) twenty updates, each followed by an AWAITED fake Telegram call of ~50 ms (the poller's
  real cadence, not one tick) → at most 3 statements (`__intakeWriteCount`). This is the
  STORE's debounce, which still coalesces every change off the poller; the collector's
  message paths flush their own chat per message (§6.2.2, K-review spec-2).
  **Red proof:** schedule a write per update (the first draft's chain) → 20.
- (d) `endIntake` → the row is gone after the flush.
- (e) the readiness probe answering false → memory works, no write, no throw.
- (f) hydrate drops a collection whose note id is on a REQUEST, and an add collection whose
  amendment was told; it KEEPS a note-only one and an untold amendment's.
  **Red proof:** test only `crm_activities` (the first draft) → the note-only collection is
  dropped.
- (g) seal: flush, seal, one more `updateIntake` → no statement; `flushIntakeWrites()` is
  `false`.
  **Red proof:** drop the seal check → the late write lands over the row.
- (h) two chats dirty; chat B's row is refused (a CHECK made to fail) → `flushIntakeWrites(A)`
  is `true` and returns without waiting for B (performance-10).
  **Red proof:** flush the module-wide chain for A → `false`.
- (i) a write that fails is retried by the next timer and lands; until it lands,
  `oldestUnwrittenUpdate()` names the update it came from (durability-10).
  **Red proof:** drop the dirty mark on failure (the waits idiom) → the change never reaches
  the row and `oldestUnwrittenUpdate()` is null.
- (j) a job's `loadIntake` before `markIntakesHydrated` waits, and after it returns memory;
  a row in the table whose memory entry was ended (its DELETE made to fail) is NOT resurrected
  (performance-7). Not hydrated within the wait → `IntakesNotReady` thrown (durability-9).
  **Red proof:** fall back to the table (the first draft) → the ended collection comes back
  and the next write UPSERTs it.
- (k) hydrate with one row expired 3 h ago → loaded; the next sweep ends it with the line
  once. A row expired 30 h ago is not loaded, and the prune deletes it (durability-12 b).
  **Red proof:** load only `expires_at > now()` → no line, and the row stays.

**`calc-intake-sweep.test.ts`** (pure `sweepAction` + the sweep with a fake clock and a send
spy):
- reminded once at 2 h, not at 1 h 59 min;
- not reminded again 5 minutes later;
  **Red proof:** drop `quiet` from the reminder's own mark → the mark slides `touchedAt` and
  clears `remindedAt`, and the next tick reminds again;
- a seller's update after the reminder → reminded again 2 h later;
- a live reading → no reminder; a reading whose job is dead → `release_reading`;
- `saving` → no reminder; `saving` whose job is `failed` → `release_saving`, the words once,
  the collection unfrozen; a live save job → none (re-check v2-6);
- 24 h → `end_said` and the line; an empty collection → `end_silent`, no send;
- a read that meets an expired collection 2 minutes before the tick → the line once; the tick
  then sends nothing (durability-12 a).
  **Red proof:** end it silently in `activeIntake` (the first draft) → no line at all;
- a backlog answer written 10 minutes before the 24 h ran out, processed 20 minutes after →
  taken by the collection; the first tick after boot ends nothing (`BOOT_GRACE_MS`)
  (durability-12 c);
- a reminder whose send answers 429 (or `botDown`, or no answer) → released, sent at the next
  tick; a 403 → claimed, not retried (durability-19) (re-check p1-p2-11).
  **Red proof:** keep every failure claimed → the second tick sends nothing;
- a stored `pendingReply` 2 minutes old, `analysing` null, no live delivery job →
  `deliver_pending` sends it once; with a live delivery job → none (durability-16);
- 22:30 Tashkent → `silent: true`; 21:30 and 10:00 → false (`quietHour`, re-check p1-p2-11);
- an add collection's reminder carries `➕ {card}`;
- a note-only landing → `resume_landing`, one request, one ✅ with the 'retried' words even
  when a press lands in the same tick (the press sees `resuming` and says nothing); an add
  collection is never `resume_landing` (re-check p1-p2-1).

**`calc-intake-takes.test.ts`** (pure):
- hydrated collection opened at T0, boot at T1 > T0: a message at T0+5 → `take`; T0−5 → `pass`;
- a collection opened after boot and a backlog message → `pass`.
  **Red proof:** return `!isBacklog(date)` → the first case fails;
- `messageId <= takenUpTo` → `seen`.
  **Red proof:** drop rule 1 → `take`;
- touched at T, a message at T + 31 min → `pass`; a reply to its table at T + 3 h → `take`.
  **Red proof:** drop the hold → `take`.

**`intake-holds-wire.test.ts`** (derived): every `activeIntake(` in `src/` is on one of the two
lists, and every «holds» site also asks `holdingIntake(` or `intakeTakes(` (rule 7;
re-check p1-p2-4). **Red proof:** switch `task-handlers.ts` back to `activeIntake` → the fence
names the file.

**`bot-redelivery.integration.test.ts`** (the real handler chain, `registerBotHandlers`), new
blocks:
- «a collection survives a restart»: open → material → simulate the restart (forget memory, a
  later `markBoot`, hydrate) → a backlog text dated after the opening → it is in `material`,
  and `BACKLOG_SENTENCE` is NOT sent.
  **Red proof:** hydrate after `startPolling` → the text is the backlog sentence.
- «a redelivered update is applied once» (durability-1, regression-6): deliver one text update
  and one document update, flush, simulate a crash (forget memory, hydrate), deliver the SAME
  two updates again → `material.length` 1, `fileCount` 1, ONE attachment row, no «ikkinchi
  invoys» question.
  **Red proof:** drop the `takenUpTo` clause → two lines, two files.
- «a crash-lost write is redone, without a second attachment»: deliver a document, crash BEFORE
  the flush, redeliver → `fileCount` 1, one attachment row.
  **Red proof:** mint a random attachment id → two rows.
- «a parked collection does not swallow the chat» (regression-1): open, wait 31 minutes (fake
  clock), type «GS777» → the free lookup answers; `material` unchanged; `touchedAt` unchanged.
  «➕ Topshiriq» opens a draft. A reply to the table then takes the text.
  **Red proof:** ask `activeIntake` in the ladder → «GS777» is material.
  Then «3500 kg» typed in that parked chat → no `ai_questions` row, and ONE sentence from
  `orphanAnswerSentence` (R2's `LOST_TOTALS_ANSWER` on P1's branch, the pause line once P3
  lands). **Red proof:** ask `activeIntake` in the guard → an `ai_questions` row
  (re-check p1-p2-5).
- «a redelivered cancel ends only its own collection»: cancel from collection A's message
  after B opened → B is untouched, «Bu tugma eskirgan».
- «an unwritten change keeps its update unconfirmed» (durability-10, regression-25): a text
  into a collection whose handler is still IN FLIGHT (its awaited write made to hang), or
  whose batch's next update is held, then the stop → `confirmedThrough` is the update BEFORE
  it; the new process receives it and applies it once. A fake bot whose batch has ENDED
  (idle) proves nothing here — grammy has confirmed that update already — and K pins the idle
  branch as `unwrittenLost` instead (calc-r3-kernel.test.ts, K-review spec-2).
  **Red proof:** pass `unwritten: () => null` → the update is confirmed and the text is lost.
- «a collection-changing message is written before its handler returns» (§6.2.2): a text into
  a collection, the handler awaited → the row holds it with no timer having fired.
  **Red proof:** drop the `await flushIntakeWrites(chatId)` → the row is still the old one
  when the handler returns.
- «a failed hydrate never starts polling early» (regression-20, durability-11):
  `hydrateWaits` rejects, `hydrateIntakes` resolves 200 ms later → polling starts after BOTH,
  and the rejection is logged, not unhandled.
  **Red proof:** `Promise.all` (the first draft) → polling starts before `hydrateIntakes`
  finishes.
- «the backlog sentence keeps «Hisoblatish» only where nothing survived»: a chat with a
  hydrated collection (opened before this boot) gets the sentence without it; a chat with
  none, and I20b's chat (a collection a late press opened after boot), get today's
  `BACKLOG_SENTENCE` (regression-24).
  **Red proof:** pass `activeIntake(chatId) !== null` → I20b red (re-check p1-p2-7).

**`calc-landed-already.integration.test.ts`**:
- a press whose landing is in flight (note committed, request not yet) → the sweep tick in the
  same second sends no second ✅ (re-check v2-11);
- (a) land, keep the collection (simulate the crash), press save again → the ✅ names the same
  card with the 'retried' words («✅ Saqlandi — oldingi urinishda ochilgan …»), and exactly one
  `calc_requests` row carries the note.
  **Red proof:** remove the `queuedBefore` early return in `landIntake` AND K2's
  in-transaction root check → two requests on the note. Either alone keeps one (two fences:
  K2's catches the concurrent twin). K's `false` body is NOT a red proof: a retry never
  reaches the PK refusal (re-check p1-p2-2).
- (b) land with `openCalcRequest` made to throw ONCE (a cut between note and request), put the
  collection back as a crash leaves it (its row written, memory forgotten, `hydrateIntakes`) →
  the hydrate KEEPS it; press save again → ONE request on the note's own card, the 'retried'
  ✅, the pass queued once (durability-3).
  **Red proof:** treat «the note exists» as landed in `endedCollections` (the first draft) →
  the hydrate drops the collection and NO request exists (re-check p1-p2-2).

---

## 7. P2 «O‘qish» — the reading on pg-boss

### 7.1 Files OWNED
- `src/modules/platform/telegram/calc-read.ts`. (`ai-cost.ts`'s anchor and
  `attachIntakePasses` are K's, K15; P2 only calls them.) P3 owns one hunk here,
  `settleAnalysis`'s line answers (`placeByName(...).entries` from the LIVE answers, §8.2
  rule 1); the lead applies it at the P3 pick (re-check p3-13).
- `src/modules/platform/telegram/calc-files.ts`: `loadIntakeFiles` and the model-sized copy
  written at arrival (the rest of the file is K's move and stays frozen).
- `src/modules/platform/telegram/calc-intake.ts`: ONE hunk in `analyzeCollected`, the
  budget's `- state.usages.length` (:1483) and the `usages` append (:1571), §7.2.10
  (re-check p1-p2-16).
- `src/modules/wms/calc/intake-land.ts`: the §7.2.9 lines — Uch band (round 4 and 8, shipped,
  docs/UCH-BAND.md)'s landing, §14.
- `src/modules/platform/telegram/staff-bot.ts`: ONE hunk, `landCollectedIntake` stops
  passing `usages` (staff-bot.ts:1334).
- Tests: new `calc-read-job.integration.test.ts`, `calc-read-press.test.ts`,
  `intake-billing.integration.test.ts`, and the ONE drive helper every collector test that
  presses «Bo‘ldi» uses (regression-10): `tests/fixtures/calc-read-drive.ts`, beside
  `source-shape.ts` (there is no tests/unit/helpers/; re-check p1-p2-14) —
  `vi.mock` of `platform/jobs/boss`'s `enqueue` (capturing the payload, never reaching
  `ensureListening()` / `boss.start` against the test database), then
  `driveReading(chatId)` = `runIntakeRead(captured, 0)`. Re-anchors onto it: every case §11
  lists under «the reading is a job» — corpus c0012, c0234, c0599, c0774, c1722, c1892,
  c1893, the `skipThenReread` helper (c1375, c1721), `intake-collector-r3.test.ts:334`,
  `intake-collector-r4.test.ts:209` — plus `bot-ai-dispatch.test.ts` (analysis half),
  `intake-collector.test.ts` («a refused «⏳» notice cannot strand the lock»), R2's
  `intake-usage.integration.test.ts` and `totals-question.test.ts`'s `pressDone` (:108-114,
  five callers; reason: «Bo‘ldi» only enqueues, the reading is the job) (re-check p1-p2-20,
  v2-13).
  They stay: corpus c0016, c0769, c0775 and `intake-collector.test.ts:183` press «Bo‘ldi» but
  a guard answers before any enqueue. The derived grep (K16) is the list of record; a drive
  it finds that is not here joins it with the same reason.
- Billing re-anchors (§7.2.10; reason: the ledger holds a collection's readings from the
  moment the model answered) (re-check p1-p2-16, p1-p2-17):
  - `intake-own-budget.test.ts`: a collection with one billed reading and the ledger saying 1
    left reads once more. **Red proof:** restore the subtraction → refused `'budget'`;
  - `intake-usage.integration.test.ts`: :177 → billed by the job on the day the model
    answered (`createdAt = at`), on the note anchor, then attached at the landing; :191 «a
    bill that cannot be written…» → «a failing attach never skips the queue»; :156 and :186
    hold, driven through the job.

### 7.2 Rules
1. **ONE wall clock for the whole handler** (performance-1, durability-7). The first draft
   pinned only the model's leash against the expiry. But pg-boss 10.4.2 RACES the handler
   against `expireInSeconds`: on a loss it fails and retries the job while the first handler
   keeps running. The retry carries the same token and calls the paid model a second time.
   Every other step of the handler had no bound at all: up to 12 photos and 3 PDFs read from
   MinIO with no deadline, `sharp`, the laws read, and a delivery of up to 3 × 20 s + 5 s +
   3 × 20 s. «The token is the fence» was false, and that sentence is deleted. Constants
   (exported):
   - `INTAKE_READ_EXPIRE_S = 300`;
   - `INTAKE_READ_RETRY = 2`;
   - `INTAKE_READ_WORKERS = 4` (performance-3);
   - `INTAKE_FILES_BUDGET_MS = 30_000` — every storage read through `readWithin`, the sum
     capped;
   - `INTAKE_DELIVERY_RESERVE_MS = 70_000` — one send at `timeoutMs: 10_000`, its HTML→plain
     and keyboard fallbacks at 10 s each, one brief 429 wait ≤ 5 s, the same once more;
   - `INTAKE_STEP_SLACK_MS = 30_000` — the laws read, the settle's flush, the bill;
   - `INTAKE_HYDRATE_WAIT_MS = 10_000` — `loadIntake`'s wait for this process's hydrate
     (durability-9; normally milliseconds, and only a job fetched in the boot window waits);
   - `ANALYSIS_STALE_MS = (INTAKE_READ_EXPIRE_S * (INTAKE_READ_RETRY + 1) + 120 + 300) * 1000`
     (22 min; the last 300 s allow for queue wait, since `analysingAt` is the PRESS's time).
     It is only the backstop: the sweep releases a dead job's token by its pg-boss state.
   - **The pin** (a unit test, of the SUM):
     `INTAKE_HYDRATE_WAIT_MS + INTAKE_FILES_BUDGET_MS + INTAKE_TIMEOUT_MS + INTAKE_DELIVERY_RESERVE_MS + INTAKE_STEP_SLACK_MS <= INTAKE_READ_EXPIRE_S * 1000 - 10_000`
     (10 + 30 + 150 + 70 + 30 = 290 ≤ 290 s, the last 10 s being the handler's own
     deadline margin). **Red proof:** set the expiry to 240 → red.
   - The handler computes `deadline = start + INTAKE_READ_EXPIRE_S * 1000 - 10_000` and checks
     it between steps. The model's leash is
     `min(INTAKE_TIMEOUT_MS, deadline - now - INTAKE_DELIVERY_RESERVE_MS)`, passed as
     `analyzeIntake`'s `timeoutMs`. Under 30 s left, the model is not called, and the reading
     settles as R1's `timeout` failure in words. By construction the handler ends before the
     expiry.
2. **Its own queue.** `calc.intake-read` is NOT R2's `calc.prefill`: a ten-minute customs pass
   would hold a seller's «⏳».
   - Four workers (`boss.work` called four times — pg-boss 10.4.2's worker is a serial loop;
     `batchSize` stays 1 because pg-boss fails a whole batch for one job's error). The fifth
     seller pressing within one reading's time waits; today's unbounded `void` is the shape
     this replaces. Each worker costs one fetch every 2 s on pg-boss's own pool. The worker
     count is pinned beside the expiry.
   - The wiring (re-check p1-p2-23): `JOB_CALC_INTAKE_READ` is enqueued with `{ id,
     expireInSeconds: 300, retryLimit: INTAKE_READ_RETRY }` (never pg-boss's 15-minute default);
     the delivery-only follow-up adds `startAfter`; `registerCalcIntakeReadWorker` makes four
     `boss.work(JOB_CALC_INTAKE_READ, { includeMetadata: true }, handler)` calls, each passing
     `job.retryCount` to `runIntakeRead` (without `includeMetadata` the handler cannot know its
     last attempt — customs/jobs.ts:66-69, :92-93).
   - **In-process fence**: a `globalThis` set of tokens whose run is in flight. A second run
     of the same token in the same process returns at once, and the first one delivers.
     Across processes the old one is dead or sealed (§6.2.3).
   - **The job's id is kept**: `pressAnalyse` mints it (`enqueue(…, { id })`, K15) and stores
     it in `analysingJob`. `readingAlive(state)` = `jobState(JOB_CALC_INTAKE_READ, analysingJob)`
     is `created | retry | active`. `releaseDeadReading` releases the token when it is still
     ours and says «Tahlil qilib bo‘lmadi …» once (`readingSaidDead`). The release is today's
     (staff-handlers.ts:1801-1803, `stage: 'material'` included) plus K4's fields, quiet:
     `{ analysing: null, analysingAt: null, analysingJob: null, stage: 'material',
     readingSaidDead: true }` (re-check p1-p2-24). The sweep asks both (§6.2.13).
3. **The press** (`pressAnalyse`):
   - The guards stay in order (live reading, client/section stage, pending invoice, `aiGoods`
     'ask', empty). «Live» = `analysing !== null && now - analysingAt <= ANALYSIS_STALE_MS`;
     a stale token is taken over.
   - `token = randomUUID()`, `jobId = randomUUID()`;
     `updateIntake(chatId, { analysing: token, analysingAt: now, analysingJob: jobId, readingSaidDead: false })`
     (a seller's press: it slides).
   - `notice = await ctx.reply('⏳ AI o‘qiyapti… (3 daqiqagacha)').catch(→ null)`; its id joins
     `ownMessageIds`.
   - `await flushIntakeWrites(chatId)` — this chat's write only (performance-10); the token is in the table BEFORE the job can exist, so a
     redelivered job in a new process finds it.
   - `await enqueue(JOB_CALC_INTAKE_READ, { chatId, noteId, token, noticeMessageId },
     { id: jobId, expireInSeconds: INTAKE_READ_EXPIRE_S, retryLimit: INTAKE_READ_RETRY })`.
   - On throw: `updateIntake(chatId, { analysing: null, analysingAt: null, analysingJob: null }, { quiet: true })`
     and §2.6's words. Otherwise every later press says «Tahlil davom etmoqda» for nothing
     (round-1 review c3's stranded lock).
   - The handler never calls the model: `bot-ai-dispatch` pins no `analyzeCollected(` in
     `pressAnalyse`.
4. **The job** (`runIntakeRead(data, retryCount)`):
   1. `state = await loadIntake(chatId)` — it waits for this process's hydrate, and throws
      `IntakesNotReady` when the hydrate does not come (durability-9): the throw goes to
      pg-boss, which re-delivers, and the in-process fence is released. Gone, or `noteId`
      differs → return silently. A `deliverOnly` job goes straight to step 7 with the stored
      reply (and returns when there is none for its token).
   2. `state.analysing !== token`:
      - if `state.pendingReply?.token === token` → go to step 7 (deliver the STORED reply);
      - else return (a newer press, a cancel, or an earlier attempt that settled).
      - A token already in this process's in-flight set → return.
   3. `files = await loadIntakeFiles(state, { deadline: start + INTAKE_FILES_BUDGET_MS })`.
      A photo reads its model-sized copy `<key>.model.jpg` first (performance-4). That copy is
      written at ARRIVAL, where `reduceForModel` already runs once to say «o‘qib bo‘lmadi»; it
      is a derived storage object, not an `attachments` row, so it needs no authz and no backup
      change. A copy that is missing is re-reduced from the original. Every get goes through
      `readWithin`; a stalled or missing object is counted in `missing`, never awaited for
      ever (#915: a dead stream is a hang). `files.missing > 0` → §2.6's sentence joins `notes`
      — K's `analyzeCollected` already does it (`filesMissingNote`, K-review U2), so P2 only
      hands it `files`.
   4. `analysed = await analyzeCollected(state, files, { timeoutMs: leash })` (R2's version:
      `totalsAnswer` merged under CONC-2; K5 makes it return `IntakeState & { answered:
      AnsweredUsage[] }`, `answered = outcome.answered ?? []`, `AnsweredUsage` from
      intake-ai.ts:160 — today the attempts are only folded into `usages`, calc-intake.ts:1571)
      (re-check p1-p2-15).
   5. **Bill now**: for each `u` of `analysed.answered`, in its own `try` (R2's rule:
      bookkeeping never stands in front of the work):
      `recordAiPass({ kind: 'intake', requestId: state.amend?.requestId ?? null, intakeNoteId: state.noteId, staffId: state.staffId, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, createdAt: new Date(u.at) })`
      — concurrency-11's day kept (a reading can run 150 s and cross Tashkent midnight). The
      literal typechecks against K15's third anchor member, `{ kind: 'intake'; requestId:
      string | null; intakeNoteId: string }` (re-check p1-p2-19). A collection abandoned after
      this point is billed — R2 §8.2.7's stated hole closes.
   6. `laws = await intakeLaws(analysed)` (pool). `live = activeIntake(chatId)`.
      `outcome = settleAnalysis(live, state, analysed, token)`:
      - `gone` → return (billed, nothing sent);
      - `arrived` → text = §2.6's arrived words, keyboard `doneKeyboard`, patch = `outcome.state`;
      - `done` → `step = intakeNextStep(outcome.state, laws, await import('../../wms/calc/intake'))`
        (K6's third parameter; re-check v2-7);
        patch = `{ ...outcome.state, ...step.patch }`.
      - Then `updateIntake(chatId, { ...patch, pendingReply: { token, text, keyboard, at: Date.now(), jobId: null } }, { quiet: true })`
        (K4's shape; `at` is what §6.2.13's `deliver_pending` ages; re-check v2-10).
      - **Then `const stored = await flushIntakeWrites(chatId)`. When the store is durable and
        `stored` is false (sealed by a stop, or the write failed), the job THROWS without
        sending.** The redelivery in the new process sends from a durable row. Sending from
        memory alone would send the table a second time after the redelivery
        (durability-1's sibling).
   7. **Deliver** (bounded, §7.2.1):
      `sent = await sendTextBriefRetry({ chatId, text: pendingReply.text, replyMarkup: pendingReply.keyboard, timeoutMs: 10_000 })`.
      - `sent.ok` → `updateIntake(chatId, { pendingReply: null, tableMessageId: sent.messageId, tableHash, ownMessageIds+ }, { quiet: true })`;
        `void editText({ chatId, messageId: data.noticeMessageId, html: '✅ O‘qildi — natija pastda ⬇️' })`
        when `data.noticeMessageId !== null` (editText takes HTML only, send.ts:487; the text
        holds no markup character; it never throws) (re-check p1-p2-22).
      - 403 or 400 → log, clear `pendingReply`, return.
      - **429 past the brief retry** (durability-16): `enqueue(JOB_CALC_INTAKE_READ,
        { …data, deliverOnly: true }, { id: followId, startAfter: retryAfter + 1, expireInSeconds: INTAKE_READ_EXPIRE_S, retryLimit: INTAKE_READ_RETRY })`
        (every job this round adds names its expiry, K15; re-check p1-p2-23),
        store `pendingReply.jobId = followId` (quiet), and RETURN. No retry is spent inside one
        flood wait: pg-boss's backoff (1 s, doubling) would have spent all of them within
        ~10 s, and the last attempt would then have said «bo‘lmadi» about a reading that
        worked. An enqueue that throws leaves `jobId` null, and the sweep's `deliver_pending`
        sends it.
      - Anything else (5xx, network) → throw: pg-boss re-delivers, and step 2 re-sends the
        stored reply WITHOUT a model call.
   8. **Last attempt** (`retryCount >= INTAKE_READ_RETRY`, `job.retryCount` from
      `includeMetadata`, §7.2.2; in the worker's catch, the `customs/jobs.ts:66-104` shape):
      when a `pendingReply` for THIS token is stored, the
      reading succeeded and only its delivery failed — say nothing, leave the reply for the
      sweep's `deliver_pending`, and return (durability-16). Otherwise release the token if it
      is still ours — `releaseDeadReading`'s patch, `stage: 'material'` included (§7.2.2;
      re-check p1-p2-24) — send today's «Tahlil qilib bo‘lmadi…» + `doneKeyboard` (setting
      `readingSaidDead`), and never rethrow. Before the last attempt: rethrow. An attempt
      that dies by EXPIRY never reaches this catch. That is why the sweep's
      `releaseDeadReading` exists (§7.2.2).
   - A MODEL failure is not an exception (`analyzeIntake` returns words): it settles into the
     table with `AI_READ_FAILURE`'s line, as today.
5. **Delivery is direct, not through the notification drain** (the `answerWithAssistant`
   precedent). The seller pressed «Bo‘ldi» and is looking at the chat. A `CalcPrefilled` row
   would be `muted` for a seller who muted «✅ Mening vazifalarim» (the `tasks` group,
   mutes.ts:42-50, where `CalcPrefilled` lives; /profile's `notifMuteTasks`), and the table
   would vanish (re-check p1-p2-21).
6. **No collector keyboard is built in the job**: it sends `step.keyboard` from
   `intakeNextStep`, so the derived `c:` fence still reads every button where it is built.
7. **`analysing` and the sweep**: §6.2.13 skips a live reading and releases a dead one.
8. **The model-sized copy is the only new storage object.** It is keyed off the original's
   storage key. Purging the attachment leaves it behind, the same as today's orphan files of
   an abandoned collection (§15).
9. **Landing attaches, never records** (Uch band's landing; no extraction, K15). In
   `landIntake` (intake-land.ts:438), R2's per-usage loop (:574-591, each in its own `try`,
   before `queueCalcPrefill`) is REPLACED by one
   `await attachIntakePasses(input.noteId, opened.id).catch(log)` at the same spot.
   - The same line opens K's local `retried(requestId)` — the exit both «already queued»
     paths take: Uch band's `rootRequestOfNote` early return (:525-526) and K2's
     `opened.existing`. A landing cut after `openCalcRequest` committed, or whose attach logged
     and failed, is retried or resumed through that exit, so without it the readings kept
     `request_id` NULL for ever (re-check p1-p2-18):
     ```ts
     async function retried(requestId: string): Promise<IntakeTarget> {
       await attachIntakePasses(input.noteId, requestId).catch((err: unknown) => logger.warn({ err, requestId }, '[calc-intake] readings not attached')); // P2
       // P5 adds the queue (atRev: 0) and the stage move here (§10, F rule 1); at the merge keep both, in this order.
       return { ...target, queued: true, requestId, queueError: null };
     }
     ```
   - `landIntake`'s input loses `usages`; `landCollectedIntake` stops passing it. The hunk
     replaces the `recordAiPass` import (:20) with `attachIntakePasses` and deletes the
     `AiUsage` import (:21), or lint goes red (#803) (re-check p1-p2-25).
   - `attachIntakePasses` = `UPDATE ai_calc_passes SET request_id = $request
     WHERE intake_note_id = $note AND request_id IS NULL` — idempotent, so the retry may run
     it again.
   - The soft budget already counted these rows at answer time.
10. **`settleAnalysis` keeps R2's merges** (`lineAnswers`, `totalsAnswer`, and K15's
    `routeAnswer`). The usage list goes in the SAME commit that bills at the answer, or every
    reading is counted twice — once in the ledger, once by R2's concurrency-11 subtraction
    (calc-intake.ts:1483) (re-check p1-p2-16). P2's commit deletes:
    - `settleAnalysis`'s `usages: analysed.usages` (staff-handlers.ts:1975, calc-read.ts after
      K8);
    - in `analyzeCollected`, the `- state.usages.length` (the budget is `aiCalcBudgetLeft()`
      alone) and the `usages` append (:1571);
    - `landCollectedIntake`'s `usages: state.usages` (staff-bot.ts:1334), and `landIntake`'s
      `usages` input and loop (rule 9).
    `IntakeState.usages` becomes optional and unread for one release (hydrated rows), then is
    removed; `AnsweredUsage.at` is read by the job's bill (step 5).

### 7.3 Tests (P2)
**`calc-read-press.test.ts`** (handler fakes, `enqueue` mocked):
- a press → one `enqueue` with `{ chatId, noteId, token }`, `id` = the stored `analysingJob`,
  and `expireInSeconds: 300`; the model spy is NOT called.
  **Red proof:** call `analyseIntakeAndReply` in the press → the spy is called.
- `enqueue` throws → the token is released and the words are sent; the next press enqueues.
  **Red proof:** drop the release → the next press says «Tahlil davom etmoqda».
- a token minted 23 minutes ago → a press takes it over.
- the SUM pin (§7.2.1) and the worker count, each `boss.work` carrying
  `{ includeMetadata: true }` (re-check p1-p2-23). **Red proof:** set the expiry to 240.

**`calc-read-job.integration.test.ts`** (`analyzeIntake` and the sender mocked, storage real):
- a normal job → the table is sent once, `pendingReply` cleared, `tableMessageId` stored.
- a token mismatch → nothing sent, no model call.
- the redelivery after the settle (`pendingReply` set, `analysing` null) → the STORED text is
  sent again, the model is NOT called.
  **Red proof:** re-decide on redelivery → the model spy counts 2.
- two runs of one token in one process (the expiry race, simulated) → the model spy counts 1.
  **Red proof:** drop the in-flight set → 2.
- a storage get that never answers → the job settles within `INTAKE_FILES_BUDGET_MS`, with
  `notes` carrying «1 ta fayl o‘qilmadi».
  **Red proof:** read without `readWithin` → the test's own timeout fails it.
- the model leash shrinks to what is left: a job started with 200 s already spent →
  `analyzeIntake` receives `timeoutMs` ≤ 30 s, or is not called.
- a sealed store → the job throws before sending; nothing sent.
  **Red proof:** ignore the flush's answer → sent from memory.
- material arriving while it runs → the arrived words.
- the last attempt with a throwing sender → the token is released, the stage is back at
  `'material'` (re-check p1-p2-24), and «Tahlil qilib bo‘lmadi» is sent. **Red proof:** drop
  the `retryCount` check → nothing is sent.
- a 429 with `retry_after` 30 at delivery → ONE delivery-only follow-up enqueued with
  `startAfter` 31, nothing thrown, no «bo‘lmadi»; the follow-up sends the stored table and
  calls no model (durability-16).
  **Red proof:** throw on the 429 (the first draft) → three attempts inside the flood wait,
  then «Tahlil qilib bo‘lmadi» about a stored table;
- a job fetched before `markIntakesHydrated` → it waits; hydrated within 10 s → it proceeds;
  never hydrated → it throws (pg-boss re-delivers) and sends nothing (durability-9).
  **Red proof:** read memory without waiting → «gone», the job completes silently;
- a dead job (`jobState` → `failed`) → `releaseDeadReading` releases and says it once; a second
  sweep says nothing.
- a photo with its model-sized copy → no `sharp` call in the job; without it → one.

**`intake-billing.integration.test.ts`**:
- a reading that answered (`truncated` with usage) → one `'intake'` row with
  `intake_note_id`, `request_id` NULL, `created_at` = the answer's `at` (re-check p1-p2-17);
- abandon the collection → the row stays: the day's budget counts it;
- a second collection lands → its rows gain `request_id`.
  **Red proof:** record at the landing instead (R2's shape) → the abandoned collection's
  row is absent.
- an add collection's reading → `request_id` set at once.
- `openCalcRequest` commits, the attach is made to throw once, «Saqlash» again (the
  `retried` exit) → the rows gain `request_id`.
  **Red proof:** attach only after `openCalcRequest` → `request_id` stays NULL
  (re-check p1-p2-18).
- The file deletes its note-anchored rows in cleanup: `intake_note_id` has no FK, so a row
  never attached is not taken by the request's CASCADE.

---

## 8. P3 «Jadval» — one table, any line, the echo and the undo (1.10 c, 1.11 c)

### 8.1 Files OWNED
- `src/modules/platform/telegram/calc-dialog.ts`
- `src/modules/wms/calc/intake.ts` (the table renderer; R2's `weightLabel` (:729),
  `volumeText` / `volumeFromLines` (:466, :457), `FIELD_LABEL` and `ambiguousTotalText` (:659)
  are consumed, not restated; `intakeSummaryText` (:680) is deleted) (re-check p3-1, p3-18)
- `src/modules/wms/calc/line-address.ts` (K declares `TableTarget` there, K4; P3 fills the file).
  It imports R2's totals-shape helpers from the zero-import `platform/telegram/totals-shape.ts`
  K6 moves them into (wms→platform), never from calc-intake.ts, which imports staff-bot
  (re-check p3-10)
- new `src/modules/platform/telegram/name-tiers.ts` (zero imports): `TIER_WORDS` and
  `tierWords` MOVED verbatim from calc-intake.ts:1086-1100 (private there today), imported back
  by calc-intake.ts's `otherName` and by line-address.ts — one home for #1468's tier rule
  (re-check p3-16)
- `src/modules/wms/calc/fit-telegram.ts` (after K)
- `src/modules/platform/telegram/calc-intake.ts`, P3's hunks (re-check p3-4, p3-11): the
  `IntakeStage` literal and the retired `IntakeState` fields (:22, :109-151; `offers`' `target`
  made required, :171); the retired helpers (:295-662: `MAX_QUESTION_ROUNDS`, `TotalsAsk`,
  `totalsQuestion`, `totalsQuestionText`, `totalsStillAsked`, `doneLine`, `placeLineDone`,
  `resolveLineDone`, `carryLineDone`); `placeByName` beside `mergeLineAnswers` (near `:576`);
  `otherName`'s import of `name-tiers.ts` (:1086-1100); and `analyzeCollected`'s BASE branch
  (`goods`/`lineAnswers` from `placeByName`, `totalsAsked` dropped: :1540, :1572 today; the
  function is at :1464, ~`:1385` after K3's store move). P4 holds the ADD-branch hunk of
  `analyzeCollected` (§9.4), beside the base branch, and P2 deletes the `usages` append on the
  line above P3's `totalsAsked` (:1571, §7.2.10); a cherry-pick conflict there keeps every
  package's change (re-check v2-12).
- P3-owned hunks in OTHER packages' files (re-check p3-4), applied by the lead at the P3 pick
  when packages are cherry-picked in parallel: calc-store.ts `startIntake`'s defaults for the
  retired and new fields (P1's file, §6.1); calc-read.ts `settleAnalysis` (P2's file, §7.2.10):
  `lineAnswers` = `placeByName(...).entries` over the LIVE answers, `totalsAsked` dropped
  (staff-handlers.ts:1955, :1968 today); calc-intake-sweep.ts `pressResume`'s `'question'`
  branch (P1's file, K9). It re-sends through `lineQuestionText` / `totalsQuestionText`, both
  retired here, so it is deleted, and a resume in the table stage goes through
  `deliverNextStep` (re-check kernel-23, v2-1).
- `src/modules/platform/telegram/staff-handlers.ts` (frozen after K): two P3 lines. The save
  guard is narrowed to `if (state.stage !== 'review') {` (K11 step 2, re-anchoring
  intake-round1.test.ts:204), and the `LOST_TOTALS_ANSWER` re-export is dropped.
  `LOST_TOTALS_ANSWER`, `TOTALS_NOT_READ` and `TotalsAsk` themselves retire in calc-dialog.ts
  and calc-intake.ts, where K6 left them (re-check kernel-5, v2-2).
- Tests:
  - new: `line-address.test.ts`, `intake-table.test.ts`, `calc-dialog.test.ts`,
    `calc-undo.test.ts`;
  - re-anchors (each with its reason, §11): the corpus cases, `resolveLineDoneCases`,
    `intake-questions.test.ts`, `intake-collector.test.ts`, `intake-collector-r3.test.ts`,
    `intake-collector-r4.test.ts`, `intake-round1.test.ts`, `intake-facts.test.ts`,
    `intake-volume.test.ts`, `calc-intake.integration` (the summary), `calc-intake-lines.test.ts`,
    R2's `intake-weight-basis.test.ts` (its «the summary says which weight the seller
    confirms» block, :126-134 → the table's weight row, re-check p3-8),
    R2's `totals-question.test.ts` (including `:130`, «rastamojka never does», regression-22;
    `:342`, the two-way cube's ⚠️ row, never «to‘liq», → `intakeTableText`). Its late-pass
    blocks keep their assertions, re-driven through the table (re-check p3-12): CONC-2
    (:373-514, the one doubt rule `totalsDoubts`, which the table reads, p3-3), P3-R7 (:201,
    p3-6), the orphan block (:516-615: :536, :549, :562 keep their gates, their `not.toContain`
    (:545, :558, :571) re-pointed from the retired `LOST_TOTALS_ANSWER` to §2.8's sentence;
    the file's imports of `LOST_TOTALS_ANSWER`, `totalsQuestion` and `totalsQuestionText`
    (:55-56, :62) and the `ask` helper (:105) go with the retirement (re-check v2-3);
    :575 asserts §2.8's sentence for a WORDED figure (it asserted `LOST_TOTALS_ANSWER`); :586
    keeps `BARE_FIGURE_NOT_FOUND`, its «never «to‘plam topilmadi»» becoming «never «Ochiq
    hisoblatish yo‘q»»; :602, the worded/bare shape test, is unchanged (calc-intake.ts
    re-exports `totalsAnswerShape`); p3-2),
    `calc-kiritish.integration` («➕ Yana ma’lumot keeps the per-line answers»).

### 8.2 Rules
1. **The stages.** `IntakeStage` drops `'question'`; `'review'` is the TABLE stage. Retired,
   with every reader:
   - `askingIndex`, `round`, `reasked`, `lineDone`, `MAX_QUESTION_ROUNDS`,
     `nextLineToAsk`, `lineQuestionText`, `resolveLineDone`, `carryLineDone`, `doneLine`,
     `placeLineDone` (re-check p3-13);
   - R2's `totalsAsked`, `askingTotalsFor`, `totalsQuestion` (calc-intake.ts:324),
     `totalsStillAsked` (:558), `totalsQuestionText` (:345), `TotalsAsk` (:298) and
     `TOTALS_NOT_READ` (staff-handlers.ts:1125 today, calc-dialog.ts after K6) (re-check p3-5,
     p3-13, v2-2).
   - KEPT: R2's `totalsAnswer` (CONC-2's `{ weightKg, volumeM3, at: TotalsMark }`,
     calc-intake.ts:130), its doubt rule `totalsDoubts` / `factsWithAnswer` /
     `mergeTotalsAnswer` / `unansweredAmbiguity` (:439-552 — the ONE rule; the table reads it),
     `totalsAnswerShape` and its helpers (moved to `platform/telegram/totals-shape.ts` by K6),
     `factsVolumeM3`, `volumeFromLines`, `volumeText`, `weightLabel`.
   - An unaddressed bare figure goes to the single open TOTALS target by that target's own
     unit (weightKg → kg, volumeM3 → m³) — the table's `open` list decides, on every section,
     rastamojka included; `bareUnitFor(line)` stays the LINE rule (re-check p3-5). WHICH totals
     rows are ⚠️ is `missingFields` minus `LINE_FIELDS`, the one home (regression-22). The
     first draft gave the rule two homes, and they disagree on rastamojka: R2's
     `totalsQuestion` is null there («never asks»), while MR-9's `REQUIRED_FIELDS.rastamojka`
     asks brutto and m³, and §2.1's own example is a rastamojka table with ⚠️ brutto.
   - **`carryLineDone`'s rule is carried over, not retired** (regression-7): its whole point
     was writing the PLACED list back after a re-read, and that rule now applies to
     `lineAnswers` (rule 8).
2. **`intakeNextStep(state, laws, intake)`** (re-check v2-7) after a reading always yields the table (§2.1):
   `patch = { stage: 'review', offers: [] }`, text = `intakeTableText(…)`, keyboard = the
   review keyboard. The arrived case stays P2's.
3. **`intakeTableText(input)`** (pure, `intake.ts`):
   ```ts
   export function intakeTableText(input: {
     section: CalcSection; facts: CalcFacts; laws: ReadonlyMap<string, NeedLaw>;
     clientLabel: string | null; fileCount: number;
     ambiguous: readonly TotalDoubt[];   // R2's doubts (intake.ts:656), IntakeState.ambiguousTotals (re-check p3-7)
     amend: { cardLabel: string; storedCount: number; totalsStale: readonly ('weightKg' | 'volumeM3')[];
              conflicts: IntakeState['conflicts']; askedSeqs: readonly number[] | null } | null;
     tail: string;   // notes + AI words + certificate, already rendered — fixed, never cut
   }): string;
   export function tableRowsOf(input: …): TableRow[];   // the ONE numbering (§1's table)
   ```
   - ✅/⚠️ per row from `lineNeeds(section, facts, laws)`, plus an add collection's conflicts;
     ↳ from `needWhatUz`/`needWhyUz` and the conflict words (§2.1).
   - Totals rows from `missingFields` minus `LINE_FIELDS` (the ONE home, regression-22), plus
     `amend.totalsStale` (P4's `amendTotalsStale`, §9.5). The route row reads `routeAnswer`
     over `facts`.
     - The weight row's ✅ text is `✅ ${weightLabel(section, facts)}: {kg} kg`, never a fixed
       «(brutto)» (A §2.1); the ⚠️ text stays `FIELD_LABEL.weightKg` (re-check p3-1).
     - The volume row prints R2's `volumeText(facts)` (intake.ts:466), whose «(qatorlardan)» is
       `volumeFromLines(facts)`'s answer (:457) — R2's one label rule, never a second test on
       `factsVolumeM3` (re-check p3-18).
     - The doubts are `ambiguous: readonly TotalDoubt[]` (type import from wms/calc/intake.ts),
       each printed by `ambiguousTotalText` on its own `⚠️` line after `Umumiy`, unchanged. A
       totals field a `TotalDoubt` names reads
       `⚠️ ${FIELD_LABEL[field]} — ikki xil yozilgan (pastda)` instead of `— yozilmagan` (e.g.
       `⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — ikki xil yozilgan (pastda)`):
       `factsWithAnswer` EMPTIES a doubted field, and «yozilmagan» would be false about a figure
       the seller did write; the doubt's own line follows (re-check p3-7).
   - Numbering: `tableRowsOf` gives every row its `no` (a stored row's `seq`; a new request's
     position; an added line `max(seq) + k`) — the table, the echo, the undo, the offers and
     the address parser all read `TableRow.no` (product-fit-4, regression-8).
   - The 4096 rule of §2.1 via K15's
     `fitTelegram(head, lines, fixed, tail, { maxLines: Infinity })` (head = the header lines;
     lines = the rows; fixed = Umumiy + closing; tail =
     `input.tail ? input.tail.split('\n') : []` — the parameter is a `string[]`, re-check p3-19).
   - `intakeSummaryText` is DELETED (its one caller was `askNextOrConfirm`). Its FIVE test
     files are re-anchored onto `intakeTableText` (§11): intake-facts.test.ts (:70, :164, :186),
     intake-volume.test.ts (:103-123), calc-intake.integration.test.ts (:131, :145),
     totals-question.test.ts:342 (the two-way cube's ⚠️ row, never «to‘liq»), and
     intake-weight-basis.test.ts:129 (PF-1/PF-3's «Og‘irlik (brutto)» on a freight section and
     the netto label → the table's weight row). Nothing asserted is dropped (re-check p3-8).
     `intakeNoteText` (the card's note) is untouched.
4. **`parseTableAnswer(text, table)`** (pure, `line-address.ts`):
   ```ts
   export interface TableRow { no: number; index: number; seq: number | null; name: string; needs: readonly NeedUnit[] }
   export type TableTarget = { line: number } | { totals: 'weightKg' | 'volumeM3' } | { route: true };
   export interface TableRef {
     rows: readonly TableRow[];          // every line, numbered as shown (`no`)
     open: readonly TableTarget[];       // every ⚠️ target
     /** What an UNADDRESSED answer may mean: the asked rows still ⚠️ when the collection was
      * opened from the 2.8 b block (product-fit-3), else `open`. */
     preferred: readonly TableTarget[];
     stage: 'review' | 'material';
   }
   export type TableRefusal = 'no_line' | 'name_many' | 'name_none' | 'name_mismatch' | 'no_address' | 'address_unclear' | 'totals_unit';
   export interface TableSegment {
     raw: string;
     at: TableTarget | null;
     refused: { reason: TableRefusal; detail: string; candidates?: number[] } | null;
     answer: LineAnswer | null;        // `parseLineAnswer(remainder)` for a line
     totals: { weightKg: number | null; volumeM3: number | null; ambiguous: AmbiguousTotal[] } | null;
     route: { fromCity: string | null; toCity: string | null } | null;
   }
   export function parseTableAnswer(text: string, table: TableRef): { segments: TableSegment[]; material: boolean };
   /** The words a totals answer may start with — the table's own labels included, so every
    * form the table teaches is understood (product-fit-14). Folded like names. */
   export const TOTALS_WORDS: readonly string[];
   /** True only when EVERY segment is a number address followed by figures and units, with at
    * most a two-word row name (regression-21). */
   export function looksLikeLineAnswer(text: string): boolean;
   /** The guard the pause line and the orphan sentence ask: `totalsAnswerShape(text) ===
    * 'worded'` (R2's REG-3 shape, from totals-shape.ts), a `TOTALS_WORDS` word followed only
    * by figures and units, or `looksLikeLineAnswer(text)`. A BARE figure («777») is not table-
    * shaped: it is answered apart (rule 11). (re-check p3-2, p3-10) */
   export function looksLikeTableAnswer(text: string): boolean;
   ```
   - **Segments**: split on newlines and `;`. Split on `,` only when EVERY comma-part starts
     with an address. «Kurtka (qora, XL) 50 dona» stays one segment.
   - **Number address**, stripped BEFORE `parseLineAnswer`. These are probe-proven defects:
     «3: 6403990000 40 juft» read q = 3, and «3 - 50 dona» was refused by the minus guard.
     The pattern:
     `^\s*(?:#|№)?\s*(\d{1,4})(?:-?(?:chi|nchi))?(?:\s*[:)]|\.(?=\s)|\s+[-–—](?=\s)|\s*-?\s*(?:qator|строк)\p{L}*(?=[\s:,.]|$)|(?<=chi)(?=\s))\s*`
     plus the word-first form `^\s*(?:qator|строка|стр\.?)\s*(\d{1,4})(?=[\s:,.]|$)[:\s]*`
     (flags `iu` on both; `\p{L}` needs `u`).
     - «3:», «3)», «3.» (a full stop then a SPACE — «3.5 kg» is a figure), «3 - …»,
       «3-qator», «3-qatorga», «3-qatordagi» (any suffix after «qator»: the first revision's
       `qator(?:ga|da|ning)?` still refused «-dagi», product-fit-13), «3 qator», «#3», «№3:»;
     - ordinals: «3-chi qator …», «3chi …», «3-nchi: …» (product-fit-13);
     - Russian: «3 строка», «строка 3: …», «стр. 3 …» (product-fit-13).
     - **In the `material` stage only «N:», «N-qator…» (ordinal or not) and «строка N»
       address a row** (regression-3). A hand-typed numbered list («1. Kurtka 300 dona /
       2. Shim 200 dona», corpus c1524-c1526) stays material there, which is where
       «➕ Yana ma’lumot» leaves the seller.
     - **The words after the number must not name ANOTHER row** (regression-3). If the
       remainder holds a word of ≥ 3 letters that meets no word of the addressed row's name
       (the name fold below) while it names a goods thing, the segment is `name_mismatch`:
       asked, never written. «3: 50 dona» and «3: Sumka 50 dona» on row 3 Sumka are answers;
       «1. Kurtka 300 dona» on row 1 Krossovka is asked.
     - «3 50 dona» (no separator) is NOT an address. When the segment then holds two
       numbers, the first ≤ the row count and the second carrying the unit, it is
       `address_unclear` and asked, never guessed.
     - A number that is no row's `no` → `no_line`.
   - **Totals address**: a segment that starts with a `TOTALS_WORDS` word, then
     `(?=[\s:]|$)[:\s]*` (flags `iu`) → `totals`. `TOTALS_WORDS` (product-fit-14) = `jami`,
     `jamisi`, `umumiy`, `obshiy`, `brutto`, `og‘irlik`, `og‘irligi`, `vazn`, `vazni`, `hajm`,
     `hajmi`, `итого`, `всего`, `общий вес`, `брутто`, `вес`, `объём`, `объем`, `total`,
     `gross` — the table's own labels («umumiy brutto og‘irligi», «umumiy hajmi») included, so
     «og‘irligi 3500 kg» and «hajmi 12 kub» are totals answers, never `name_none`. Matched on
     the folded text (apostrophes removed, Cyrillic kept for the Russian words). A word that
     names a unit's field («hajmi») with no unit after it takes that field («hajmi 12» → m³).
     A segment that starts «sof …» / «netto» / «нетто» is NOT totals: «sof og‘irligi» is the
     ROW's netto in `lineNeedText`'s own words, so it goes through the no-address rule to the
     single row needing kg. A lookahead and not `\b`: JS `\b` is ASCII-only, so «итого\b»
     never matches (round 37's «120кг» lesson). The remainder is read as R2's answer path
     reads it (staff-handlers.ts:1593): `parseManualFacts(remainder)`, NO section — so a
     netto-labelled kilo («jami netto 1200 kg») answers no total, R2's PF-1
     (`mergeTotalsAnswer` takes an answered weight as BRUTTO and drops `weightNetto`); such a
     segment is `totals_unit`, kept in `answers`, never stored in `totalsAnswer`
     (re-check p3-20). A bare number → the unit of the single ⚠️ totals row; with both rows
     ⚠️ → `totals_unit`. A bare remainder holding two or more figures
     (`bareTotalsNumber(remainder) && totalsFigureCount(remainder) > 1`; «3 500» and «1 200 000»
     count as ONE) is `totals_unit`, kept in `answers`, never one weight — R2's P3-R7
     (staff-handlers.ts:1585-1592); the same for an UNADDRESSED bare text sent to the single
     open totals target (re-check p3-6).
   - **Route**: a segment whose `parseManualFacts` gives a `fromCity` or `toCity` and no
     figure → `route`.
   - **Name address**: the goods words left after the figures, units and field words are
     removed, BEFORE or AFTER the number (product-fit-13: «50 dona sumka» and «40 juft
     krossovka» are ordinary Uzbek word order, and «the words before the first digit» read
     no name in them). An address word and a totals word are never a name.
     - Fold both sides: lower, NFKC, apostrophes (`ʻ’'`‘ˈ`) removed, punctuation to space,
       then Cyrillic → Latin by one table:
       а a, б b, в v, г g, д d, е e, ё yo, ж j, з z, и i, й y, к k, л l, м m, н n, о o, п p,
       р r, с s, т t, у u, ф f, х x, ц ts, ч ch, ш sh, щ sh, ъ —, ы i, ь —, э e, ю yu, я ya,
       ў o, қ q, ғ g, ҳ h.
     - Each typed word of ≥ 3 letters (minus `uchun|для|for`) must meet a word of the line:
       `lcp(w, v) >= max(3, min(|w|, |v|) - 2)`. That makes «krossovka»/«krossovki»,
       «sumka»/«sumkalar» and «sumka»/«Сумка» meet; «kurtka»/«kepka» do not.
     - A Han run meets as a substring.
     - A typed digit run left in the name part (a figure's digits are the answer's, removed
       with it) or a model tier word after it (`tierWords`, name-tiers.ts) that a met row's
       name does not hold drops that row — `otherName`'s rule (#1468, calc-intake.ts:1115):
       «iPhone 14» is not «iPhone 15», «iPhone 15» is not «iPhone 15 Pro». Rows met by their
       words and ALL dropped so → `name_mismatch` (re-check p3-16).
     - Exactly one line → that line. Several → `name_many` with their numbers. None →
       `name_none`.
     - The stored answer carries the line's FULL read name, so `placeByName`'s exact-name
       re-placement keeps working.
   - **No address** (product-fit-1). The first draft asked R1's `looksLikeMaterial` FIRST, and
     that is true for any single line with a unit word: `r3/probe/pf-material.ts` shows
     «40 juft», «50 dona», «3500 kg», «12 kub», «3.5 kg» all → material. So the commonest
     one-row answer was sent back to «Bo‘ldi». The order is now:
     1. `parseLineAnswer(text)` reads figures and NO goods word is left over (only unit and
        field words) → an ANSWER. Its target is the single `preferred` target. If there are
        several, it is the single one whose `needs` contain the answer's unit («40 juft» → the
        one juft row; a bare kg answer → the single kg-needing row or the weight total). If
        there is none, a bare number with ONE target goes by that target's unit: a row's
        `bareUnitFor(line)` (else its buttons), a totals target's own unit (weightKg → kg,
        volumeM3 → m³, rule 1; re-check p3-5). Otherwise `no_address`.
     2. A single segment with goods words → the name address above (an answer, `name_none`,
        `name_many` or `name_mismatch`).
     3. Several segments, none addressed, none naming a row, and R1's
        `looksLikeMaterial(text)` → `material: true` (a typed goods list). In the `review`
        stage that is the ONLY way a typed text becomes material.
     4. else `no_address`.
5. **Routing a text in `routeCollectorText`**:
   - **A reply to a bot message that is not this collection's own** (`msg.replyTo` set and not
     in `ownMessageIds`) is never a table answer (regression-5): it is material in the
     `material` stage and `no_address` in the `review` stage. A reply to ANOTHER request's
     ➕-bearing message never reaches here: the ladder's `foreignAddReply` (P4) answers it
     first, in words.
   - stage `review`:
     - a forwarded message → material (stage `material`, `showIntakePrompt`);
     - else `parseTableAnswer`: `material` → material; otherwise the segments are applied,
       ONE echo is sent, and the table is edited.
     - Nothing typed in the table stage reaches `material` except rule 4's typed list. The
       orphan-weight defect (§0.1(3)) is a red proof.
     - While the collection is `saving`, or a conflict button is the only thing asked, the
       rules above are unchanged; `saving` is answered before this function (K11).
   - stage `material`, after a first reading (`facts.goods` non-empty): a segment with an
     EXPLICIT «N:», «N-qator» or totals address is an answer (echo, stage stays `material`).
     A forwarded message is material here too — a customer's «brutto 4200 kg» is his words,
     never the seller's answer (R2 P3-R1), and as material it DOUBTS a standing totals answer
     (CONC-2, rule 6) instead of replacing it (re-check p3-3). Anything else is material, as
     today.
   - stages `section` and `client`: unchanged.
   - The text of every answer message is appended to `answers` once (law 11), saying where it
     went as R2's entries do (staff-handlers.ts:1589, 1613, 1636 — they reach the card's note
     as material at the landing): `{no}-qator: {text}` when every segment went to one row
     (`TableRow.no`), `Umumiy: {text}` when every segment was a totals answer, else the
     verbatim text (re-check p3-14).
6. **Applying an answer** (one function, `applyTableAnswer(ctx, chatId, state, text, msg)`):
   - a line: R1's `applyLinePatch` arithmetic without its re-ask. The patch merges into
     `lineAnswers` keyed by `itemId` when the row carries one, else by the CURRENT placed
     `index` (rule 8). An entry placed nowhere this reading (`index: -1`) is never matched by
     index, so answering row 1 cannot delete another line's kept answer (regression-7).
   - totals:
     `totalsAnswer = { weightKg: read.weightKg ?? prev.weightKg, volumeM3: read.volumeM3 ?? prev.volumeM3, at: { material: state.material.length, files: state.fileCount } }`
     (R2's CONC-2 mark; `read` = the segment's `totals`, `prev` = `state.totalsAnswer`),
     `facts = mergeTotalsAnswer(totalsAnswer, facts)`,
     `ambiguousTotals = unansweredAmbiguity(state.ambiguousTotals, totalsAnswer)` — the body of
     staff-handlers.ts:1601-1613. Without the mark the next reading's own figure doubts the
     answer the seller gave from those very documents (`totalsDoubts`), and his brutto is
     emptied and asked for ever. (re-check p3-3)
   - route: `routeAnswer` (present keys only, `at` = the same mark) — the carrier every reading
     re-applies while no material after `at` names a different city for that key (K15,
     durability-17) — and `facts.fromCity` / `toCity` for this render.
   - The offers' units come from `needUnitOfSeller` (staff-handlers.ts:1701, moved into
     calc-dialog.ts by K6) and stay capped by R2's `MAX_OFFERS` (calc-intake.ts:567)
     (re-check p3-17).
   - **Code on a stored row** (an add collection): an EMPTY code is written; a different code
     is NOT written and the segment reads `code_kept` (⭐ of Question 3). The amend diff
     names it to the VED (§9.5).
   - A stored row with a conflict (§2.1): any answer to that row resolves it.
   - Each write records its `before` into the echo (`IntakeEcho`, `tag` = 8 random hex).
     `echoes` keeps the last 30.
   - `offers` (bare/ambiguous buttons) carry `target: TableTarget`; `pressPick` applies
     `offers[n]` to its target THROUGH `applyTableAnswer`, so a press gets the same echo, the
     same ↩️ and the same missing-line as typing (product-fit-9). The message that drew the
     offers is stored as `offersMessageId` (quiet); a pick pressed from ANY other message
     answers «Bu tugma eskirgan.» and applies nothing (regression-23: `ownsPress` alone let
     collection A's old offer apply B's live `offers[1]` to B's row).
   - **A conflict** (§2.1, product-fit-17): `pressConflict(n, choice)` and a typed answer to
     the row resolve it through `applyTableAnswer`: `add` writes `stored + read` into the
     row's answer, `rep` writes `read`, `ved` marks `choice: 'ved'` and writes nothing. Each
     gets an echo («✅ 3-qator «Kurtka»: 300 + 200 = 500 dona», «📨 3-qator «Kurtka»: VED hal
     qiladi») with its ↩️, which puts the conflict back to unanswered. `n` is judged against
     the live `state.conflicts` and the table's own message; a conflict already answered
     answers «Bu tugma eskirgan.».
   - **The certificate on the echo** (product-fit-20): on the AI door, an echo that carries
     «✅ Tasdiqlash» renders `📄 Sertifikat: {bor|yo‘q}` and the `cert_y`/`cert_n` button;
     the cert press edits the pressed message and the table.
   - **The started standing** (product-fit-18): in an add collection with
     `standingAtOpen === 'started'` the echo's head is `📝 VED ga yuboriladi:` and its confirm
     is `📨 VED ga yuborish`; nothing else changes.
   - `lineOfferKeyboard` drops `skipKeyboard()`; when the offers span several rows, each label
     names its row (§2.2).
   - The echo's message id joins `ownMessageIds` (quiet).
7. **`pressUndo(tag)`**: find the echo, refuse if `undone`. Per entry, FIND THE ROW where the
   answer is now (product-fit-11): by `itemId`; else by the `lineAnswers` entry the echo
   wrote, at the index the last reading WROTE BACK (`placeByName`, rule 8) — never the echo's
   stored `index`, which a re-read after «➕ Yana ma’lumot» may have moved onto other goods.
   Restore `before` ONLY when that row still holds the echo's `patch` values; otherwise report
   it (§2.3). An entry placed nowhere this reading (`-1`) is reverted in `lineAnswers` only,
   and the echo says so. Then `undone = true`; `lineAnswers` / `routeAnswer` and a conflict's
   `choice` lose the reverted fields (a `routeAnswer` left with no key is null). Undoing a
   totals entry restores the previous `totalsAnswer` WHOLE (figures AND `at`) and the
   `ambiguousTotals` entries that answer retired — `IntakeEcho.totals.answerBefore` /
   `doubtsBefore` (K4); nulling a figure alone would keep the newer mark and silence a
   standing CONC-2 doubt (re-check p3-3). The echo is edited, the table is edited.
8. **`placeByName(goods, entries): { goods; entries }`** (pure, exported, `calc-intake.ts`,
   ADDED beside `mergeLineAnswers` near `:576`; re-check p3-4) is the one placement rule:
   - `itemId` first (a stored row);
   - else the same index while the name holds;
   - else the first UNCLAIMED line of that name;
   - else nowhere.
   - A line is claimed once (round-3 review R3-C5's rule, which only `lineDone` had).
   - **Its placement is WRITTEN BACK** (regression-7, round 4's C-r2 lesson that
     `carryLineDone` held): `placeByName` returns the entries with each `index` rewritten
     to where it landed (`-1` when nowhere this reading, the name kept for a later one), and
     the two readers that store answers store THAT list in `lineAnswers`: `analyzeCollected`'s
     base branch (calc-intake.ts:1540) and `settleAnalysis` (calc-read.ts after K8;
     staff-handlers.ts:1955 today), over the LIVE answers (§8.1's P3 hunks; re-check p3-4).
     The probe: [Kurtka] answered; a re-read gives
     [Shim, Kurtka]; answering row 1 Shim now keeps Kurtka's answer, which sits on index 1.
   - `mergeLineAnswers(goods, answers): goods` keeps its signature (K4), so no caller breaks
     at the merge; its body places through `placeByName(goods, answers).goods`. The probe case
     (answers Kurtka 100 and Kurtka 200, re-read [Shim, Kurtka, Kurtka]) now lands
     100 → 2 and 200 → 3; before, one answer was lost and the other mis-landed.
9. **The table edit** (performance-5). `editTable(chatId, state)` is dispatched `void`, per
   chat, latest wins: only the newest pending text is sent, and an edit a newer answer
   superseded is dropped. It renders, compares the hash with `tableHash`, and skips an
   identical text. Telegram's `message is not modified` is success. Only another refusal sends
   a fresh table. The echo stays the awaited reply. A 429's brief retry then never holds the
   poller for a table nobody needs twice.
10. **`pressSkip`** and an old `c:cert`: always `Bu tugma eskirgan.` (old messages carry them).
11. **`orphanAnswerSentence(text, parked)`** (async — K6's signature returns a `Promise`; it
    reaches the wms `line-address.ts` by dynamic import, the collector's rule that platform
    never imports wms statically; re-check p3-10): with
    `parked` a collection and the text table-shaped OR a bare figure
    (`totalsAnswerShape === 'bare'`) → §2.7's pause line with ▶️ (a collection exists; «not
    found» would be false); with none: `looksLikeTableAnswer(text)` → §2.8's sentence; a bare
    figure → `BARE_FIGURE_NOT_FOUND` unchanged (R2's REG-3: «777» is as often a code typed
    without its letters); otherwise null. P3 retires `LOST_TOTALS_ANSWER`
    (staff-handlers.ts:1109 today, calc-dialog.ts after K6; re-check v2-2) only. `answerStaffText` keeps R2 P3-R1's gate — asked only when
    `opts.messageId !== null && !opts.waitDeclined` (never Door B's «🔍» replay of a forward,
    never a ⏰-declined text) — with `!holdingIntake(chatId)` in place of
    `!activeIntake(chatId)` and `activeIntake(chatId)` handed in as `parked`; the guard is a
    «holds» site in P1's `intake-holds-wire` list (K6, §6.2). (re-check p3-2, p3-9) Both
    halves of the guard read ONE list (`TOTALS_WORDS`), so «jami 3500 kg», the form the table
    teaches, is caught after expiry and never reaches the paid assistant (product-fit-14);
    and `looksLikeLineAnswer` is narrow, so a numbered QUESTION to the assistant still reaches
    it (regression-21).
12. **`pressCancel(state, confirmed)`** (product-fit-12): pressed from the table, the add
    table, an echo or the restart question, with material, files or answers in the
    collection and `confirmed` false → §2.7's «🗑 Hammasi o‘chadi …» question (its id joins
    `ownMessageIds`), nothing ended. `cancel_y`, or a press from the reminder or the pause
    notice, or an empty collection → today's end. While `saving`, refused (§2.4). `state` is
    `IntakeState | null` (K6): null — nothing live — answers «Bekor qilindi.» and ends
    nothing (K-review spec-3).

### 8.3 Tests (P3)
**`line-address.test.ts`** (pure; the probe table, every literal by hand, a 5-row table):

| Input | Expected |
|---|---|
| «3: 50 dona» | line 3, q = 50 |
| «3 - 50 dona» | line 3, q = 50 |
| «3-qator 40 juft» | line 3, juft 40 |
| «3-qatorga 50 dona» | line 3, q = 50 |
| «3: 6403990000 40 juft» | line 3, code 6403990000, juft 40 — never q = 3 |
| «3: 1,200 kg» | line 3, ambiguous 1.2 / 1200 kg |
| «3: 50 dona\n5: 20 kg» | two segments |
| «sumka 50 dona, kurtka 20 kg» | two segments by name |
| «Kurtka (qora, XL) 50 dona» | one segment |
| «3 50 dona» | `address_unclear` |
| «7: 5 kg» (5 rows) | `no_line` |
| «kurtka 20 kg» with rows 2 and 5 «Kurtka» | `name_many` [2, 5] |
| «sumka 50 dona» vs row «Сумка женская (Ladies bag)» | that row |
| «jami 3500 kg» | totals kg |
| bare «300» with one ⚠️ row whose law pins juft | that row, juft |
| bare «300» with two ⚠️ rows | `no_address` |
| «3.5 kg» with one ⚠️ row | 3.5 kg on that row (not line 3) |
| «40 juft» with one ⚠️ row | 40 juft on that row — an answer, NOT material |
| «3500 kg» with one ⚠️ row and the weight total ⚠️, the row needing juft | the weight total |
| «40 juft» with a juft row and a dona row ⚠️ | the juft row |
| «40 juft» with `preferred` = [row 2] and row 4 + brutto also ⚠️ | row 2 |
| c1524-c1526's numbered lists, `review` stage, rows that do NOT meet their names | the numbered segments `name_mismatch`; c1524's «Karobka 45 ta» `no_address` (unaddressed, and a carton word is a unit, units.ts:51, never a name); nothing patched (re-check p3-15) |
| c1524-c1526's numbered lists, `material` stage after a reading | `material: true`, nothing patched |
| rows numbered by seq 1, 3, 4 (a VED deletion): «3: 40 juft» | the seq-3 row |
| a 6-line forwarded goods list | `material: true` |
| «3-qatordagi Sumka 50 dona» | line 3, q = 50 (product-fit-13) |
| «3-chi qator 50 dona», «3chi: 50 dona» | line 3, q = 50 |
| «строка 3: 50 шт», «3 строка 50 шт» | line 3, q = 50 |
| «50 dona sumka» (row 3 Sumka the only Sumka) | line 3, q = 50 — the name read AFTER the figure |
| «40 juft krossovka» | the Krossovka row, juft 40 |
| «og‘irligi 3500 kg», «брутто 3500 кг», «vazni 3500» (weight row ⚠️) | totals kg 3500 (product-fit-14) |
| «hajmi 12 kub», «объём 12 м3» | totals m³ 12 |
| «sof og‘irligi 20 kg» (one ⚠️ row needing kg, brutto ⚠️ too) | that row, 20 kg — the row's netto, never the brutto total |
| «jami 12 3500» (weight row ⚠️) | `totals_unit`, nothing written (R2 P3-R7; re-check p3-6) |
| bare «12 3500», only the weight row ⚠️ | `totals_unit`, nothing written |
| «jami 3 500» (weight row ⚠️) | totals kg 3500 — one figure |
| «jami netto 1200 kg» (rastamojka, weight row ⚠️) | `totals_unit`, nothing in `totalsAnswer` (PF-1; re-check p3-20) |
| «iPhone 15 Pro 40 dona» vs the only phone row «iPhone 14» | `name_mismatch` (re-check p3-16) |
| «iPhone 15 Pro 40 dona» with rows «iPhone 15» and «iPhone 15 Pro» | the «iPhone 15 Pro» row |

`looksLikeLineAnswer` / `looksLikeTableAnswer` (regression-21, product-fit-14):

| Input | `looksLikeLineAnswer` | `looksLikeTableAnswer` |
|---|---|---|
| «3: 50 dona\n5: 20 kg» | true | true |
| «1) 2026 oktyabr hisoboti» | false | false |
| «1. Kurtka 300 dona, 2. Shim 200 dona — boj qancha?» | false | false |
| «jami 3500 kg» | false | true |
| «og‘irligi 3500 kg» | false | true |
| «3500 kg» | false | true (`totalsAnswerShape` 'worded') |
| «777» | false | false (a bare figure: rule 11 answers it apart; re-check p3-2) |

- **Red proofs:**
  - hand the address to `parseLineAnswer` → «3: 6403990000 40 juft» reads q = 3;
  - drop the Cyrillic fold → «sumka» finds nothing;
  - split on every comma → the «Kurtka (qora, XL)» case splits;
  - allow «\d\.» without the space → «3.5 kg» addresses line 3;
  - ask `looksLikeMaterial` first (the first draft) → «40 juft» is material;
  - accept «N.» in the material stage → c1524 patches rows 1 and 2;
  - number by position → «3: 40 juft» after a deletion lands on seq 4;
  - restore `qator(?:ga|da|ning)?` → «3-qatordagi …» is `name_none`;
  - read the name only before the first digit → «50 dona sumka» is refused;
  - drop the table's label words from `TOTALS_WORDS` → «og‘irligi 3500 kg» is `name_none`,
    and after expiry it reaches the assistant;
  - widen `looksLikeLineAnswer` back to «an address then a figure» → «1) 2026 oktyabr
    hisoboti» is answered «Ochiq hisoblatish yo‘q» instead of reaching the assistant;
  - drop the figure count from the totals address → «jami 12 3500» reads 3500 kg and the 12
    is lost;
  - read the totals remainder with `state.section` → «jami netto 1200 kg» is stored as the
    brutto answer;
  - drop the digit/tier rule → «iPhone 15 Pro 40 dona» lands on «iPhone 14».

**`intake-table.test.ts`** (pure):
- the §2.1 example literally;
- freight-only rows unmarked;
- the closing line's three forms, and the «Bilmagan qatoringizni VED to‘ldiradi» line;
- the examples built from the table (first ⚠️ row's number and unit);
- ten 227-character names → ≤ 4096 and every ⚠️ row present.
  **Red proof:** no 40-point cap → over 4096;
- 60 rows with 3 ⚠️ → the ✅ collapse line with ranges.
  **Red proof:** collapse ⚠️ rows too → one disappears;
- 40 short rows, under 4096 → all 40 shown (product-fit-10).
  **Red proof:** leave `fitTelegram` at its default 25 → row 26 is cut;
- an add table: seq numbering with gaps; a conflict row's ↳ and its three buttons; an
  empty-field conflict's two buttons; a stale-brutto row;
- a rastamojka table with no brutto → the brutto row ⚠️ (`missingFields` minus `LINE_FIELDS`),
  and a bare «3500» goes to it as kg (regression-22).
  **Red proof:** decide the ⚠️ totals by section, R2's retired `totalsQuestion` rule
  (freight sections only) → no brutto row on rastamojka, and «3500» is `no_address`
  (re-check p3-5);
- the weight row's name, three cases re-anchored from intake-weight-basis.test.ts:129-134
  (R2's PF-1/PF-3, `weightLabel`): podklyuch `✅ Og‘irlik (brutto): 3500 kg`, rastamojka
  netto-only `✅ Og‘irlik (netto): 1200 kg`, rastamojka plain `✅ Og‘irlik: 1200 kg`.
  **Red proof:** hard-code «(brutto)» → the netto case reads brutto (re-check p3-1);
- one `ContradictedTotal` (answered 3500, stated 4200): the weight row reads
  `⚠️ umumiy brutto og‘irligi (kg, qadoq bilan) — ikki xil yozilgan (pastda)` and the line
  «Siz 3500 kg deb javob bergansiz, keyin … 4200 kg — qaysi biri? …» follows (re-check p3-7);
- a cube summed from the lines → `✅ Hajm: 12 m³ (qatorlardan)`, `volumeText`'s own words
  (re-check p3-18);
- 60 kg-only rows all needing «soni (dona) — boj kamida $2/dona», over 4096 → one grouped ↳
  line with ranges, every ⚠️ row's number present (product-fit-10).
  **Red proof:** no grouping → rows cut;
- a row that states nothing reads «soni (dona) yoki sof og‘irligi (kg)», literally
  `lineNeedText`'s words (product-fit-19 c).

**`calc-dialog.test.ts`** (handler fakes, the real pure functions):
- an answer in the table stage → echo text exact, `lineAnswers` set, table edited;
- the probe «3: 50 dona\n5: 20 kg» in the table stage → the material is unchanged and the
  next `analyzeCollected` reads `weightKg` from the totals, never 20.
  **Red proof:** route the table stage's text to material (today's branch) → `weightKg` 20;
- an unaddressed short text with two open rows and no unit fit → `no_address` words,
  nothing written;
- an addressed answer in the `material` stage → an answer, not material;
- a forward in the table stage → material;
- a reply to a foreign bot message «2: 40 juft» → not a table answer (regression-5).
  **Red proof:** ignore `replyTo` → row 2 is written;
- every echo that wrote something carries the confirm button and the «⚠️ Yana {k} ta: …» line;
  the completing one says «Hamma qator to‘liq» (product-fit-2);
- `pressPick` applies to the offer's target row, sends an echo with ↩️, and the offer keyboard
  has no ⏭ (product-fit-9);
- the table edit: an identical render sends nothing; a `message is not modified` refusal
  sends no fresh table (performance-5).
  **Red proof:** treat every refusal as «send fresh» → a second table appears;
- `placeByName`'s probe case.
  **Red proof:** restore `findIndex` without the claim → line 3 gets nothing;
- a pick pressed from an OLDER offer message while newer offers are live → «Bu tugma
  eskirgan», no row written (regression-23).
  **Red proof:** drop the `offersMessageId` check → the live `offers[n]` is applied;
- a conflict «faylda 200, so‘rovda 300»: `conf_0_add` → the row's answer 500, an echo with ↩️;
  ↩️ → unanswered again; `conf_0_ved` → nothing written, named for the VED (product-fit-17);
- on the AI door an echo carrying «✅ Tasdiqlash» shows «📄 Sertifikat: bor» and the toggle;
  pressing «yo‘q» there sets it and edits the table (product-fit-20);
- an add collection opened `started` → the echo's head «📝 VED ga yuboriladi», its button
  «📨 VED ga yuborish» (product-fit-18);
- «✖️ Bekor qilish» from the table with 3 messages and 2 files → the question, nothing ended;
  `cancel_y` → ended; from the reminder → ended at once (product-fit-12).
  **Red proof:** end on the first press (today's body) → the files are gone after one tap;
- a yolkira route answered «Yiwu → Toshkent», then «➕ Yana ma’lumot» + «Bo‘ldi» → the route
  is still there; undo it → gone (durability-17).
  **Red proof:** write the route to `facts` only (the first draft) → the re-read erases it;
- the write-back probe: [Kurtka] answered → re-read [Shim, Kurtka] → answer row 1 → the next
  reading still carries Kurtka's figure (regression-7).
  **Red proof:** store the unplaced list → Kurtka's answer is lost;
- a table answer «jami 3500 kg», then «Bo‘ldi» over the same material → 3500 kept, no doubt.
  **Red proof:** leave `at` unmoved → the reading's own figure doubts it (re-check p3-3);
- R2's CONC-2 block re-driven through the table, its rule kept (re-check p3-3): answer
  «jami 3500 kg», then «➕ Yana ma’lumot» and «brutto 4200 kg» arriving as MATERIAL (a
  forward), «Bo‘ldi» → ⚠️ with both figures, never 3500 in silence. The same «brutto 4200 kg»
  TYPED in the `material` stage is a totals address (rule 5): a new answer, its echo «3500 →
  4200» and its ↩️ — never a silent replace;
- `answers` says where each answer went: «2: 40 juft» → `2-qator: 2: 40 juft`, «jami 3500 kg»
  → `Umumiy: jami 3500 kg` (re-check p3-14);
- the orphan (`orphanAnswerSentence`, re-check p3-2): «777» with no collection →
  `BARE_FIGURE_NOT_FOUND`, never §2.8's sentence; «777» with a parked collection → the pause
  line; «3500 kg» with none → §2.8's sentence; «jami 3500 kg» with none → §2.8's sentence.
  **Red proof:** answer every orphan as worded → the «777» case red. The parked block of
  `bot-redelivery.integration` (P1's file, §6.3) gains P3's assertion: open, 31 minutes,
  «3500 kg» → no `ai_questions` row and the pause line. **Red proof:** ask `activeIntake` in
  the guard → an `ai_questions` row.

**`calc-undo.test.ts`**:
- undo restores `before` and edits both messages;
- undo twice → «Allaqachon bekor qilingan»;
- an answer, then a second answer to the same row, then undo the FIRST → that row is kept and
  named.
  **Red proof:** restore unconditionally → the second answer is lost;
- undo a picked offer → restored like a typed answer.
- «3: 50 dona» on Sumka, then «➕ Yana ma’lumot» + «Bo‘ldi» moves Sumka to row 5, then the
  OLD echo's ↩️ → row 5 is reverted and named «5-qator «Sumka»»; the goods now on row 3 are
  untouched (product-fit-11).
  **Red proof:** locate by the echo's stored `index` → row 3's new goods are reported
  «keyin o‘zgartirilgan» and Sumka keeps 50;
- answer «jami 3500 kg», ➕ and a forwarded «brutto 4200 kg», re-read (the doubt), answer
  «jami 4200 kg», undo that answer → the doubt line is back and `weightKg` is empty
  (re-check p3-3).
  **Red proof:** undo by nulling the figure only → no doubt line, and the forward's 4200
  stands in silence.

---

## 9. P4 «Qo‘shish» — the add door (1.9 a)

### 9.1 Files OWNED
- `src/modules/platform/telegram/calc-amend.ts` (the press, the save job's platform half,
  `foreignAddReply`, and the offers where extra information arrives: `addOfferRows`,
  `offerAddForMedia` — K wires both call sites, so P4 touches neither `task-handlers.ts` nor
  `staff-handlers.ts`), `src/modules/platform/telegram/reply-door.ts`
- new `src/modules/wms/calc/amend.ts` (`amendStanding`, `amendDiff`, `amendTotalsStale`,
  `amendRequest`, `requeueWaitingAmendments`)
- `src/modules/platform/telegram/calc-intake.ts`: TWO hunks — `analyzeCollected`'s add branch
  (§9.4), and `sameGoodsLine(kept, read)` lifted out of `pickGoods`' `carried` closure
  (calc-intake.ts:1259-1260; `pickGoods` calls it, nothing else moves). Collector code: the
  whole corpus runs before P4 merges (#1463-#1468). (re-check p4-10)
- `src/modules/wms/calc/intake-ai.ts`: ONE hunk, the request's names block (§9.4).
  (re-check p4-16)
- platform reaches wms by the collector's dynamic-import idiom (`await import('../../wms/calc/amend')`,
  as `landCollectedIntake` does, staff-bot.ts:1298-1299) — never a static import (platform must
  not import wms).
- The draft and zametka words are imported, never restated: `BUSY_DRAFT` (task-handlers.ts:105,
  exported today) and `refuseWhileCapturing` (K moves it to note-capture.ts, exported with
  `captureKeyboard`). Both are read at press time, never at module load, so task-handlers.ts
  importing `addOfferRows` back is a harmless cycle. (re-check p4-14)
- Tests: new `amend.integration.test.ts`, `amend-diff.test.ts`, `calc-amend-press.test.ts`,
  `amend-save-job.integration.test.ts`, `amend-wire.test.ts`, `amend-offer.test.ts`. Re-anchors
  (reply-door.test.ts has no verdict switch; it pins `jy`, `buttonsFor` and the thread-ref
  validator, and P4 adds nothing there — re-check p4-13):
  - `cargo-thread.test.ts:355-366` (describe 11): `mediaSentenceFor({ kind: 'calc_add', requestId })`
    is null;
  - `cargo-thread-wire.test.ts` (b) (:165): `mediaSentenceFor`'s switch keeps its `never`
    default with the new case;
  - `thread-reply.integration.test.ts` describe 15 (:324-339): a `calc_add` reply answers
    `{ text: null }`; the not-handled cases still answer null;
  - `thread-reply.integration.test.ts:341-352` stays green unchanged (Q2 a: CalcDone,
    CalcSealed, CalcReturned and CalcTaken stay not replyable).

### 9.2 The door (`pressAdd`)
- The checks run in §2.4's order: linked; the request (`storedRequestFacts`); requester;
  closed, keyed on its `ending` (`endingOf`, service.ts:1433 — five endings, not three):
  `answered` / `sealed` → refused, `unpriced_lines` / `unpriced_task` → refused with
  «Bu so‘rov narxsiz yopilgan. Yangi hisob kerak bo‘lsa «🧮 Hisoblatish» dan yuboring.»,
  `returned` → Question 6 (re-check p4-15); a closed lead (`AmendBase.leadOpen === false`,
  `leadTakesJobs`' rule, service.ts:300) → refused with §2.4's closed-lead words (re-check
  p4-4); draft; zametka; another collection (holding or parked → the `cg:` / `c:resume`
  question); the same request's (resume, which un-parks).
- `mode: 'replied'` (`cf:`, product-fit-16): the same checks, then the offer's
  `ctx.callbackQuery.message.reply_to_message` (grammy's `Message`, `PressCtx` K6) becomes
  the add collection's first material after the open: its text into `material`, a photo or
  document through `saveIntakeFile(ctx, noteId, staffId, fileOf(part))` + `readIntakeFile`. For
  a forward, the other album parts come from `forwardAlbumOf(chatId, original.media_group_id)`
  (task-draft.ts:471) exactly as `handleForwardCallback` takes them (task-handlers.ts:565-604),
  each file through `saveIntakeFile(ctx, noteId, staffId, fileOf(part))`; the «Albom bo‘lsa…»
  line only when the album is no longer in memory. (re-check p4-9) A
  voice note, sticker or location is not taken (1.12 a). The replied message is OLDER than
  messages the collection may already have taken, so `takenUpTo` (a high-water mark) is not
  asked for it: the collection keeps `repliedTaken` (the ids taken through a `cf:` press,
  last 20, quiet), a redelivered or repeated press finds its id there and adds nothing, and
  the file's attachment id is the message's (K5) either way. A missing `reply_to_message` (the original deleted) opens the
  collection with nothing and says `Asl xabar topilmadi — qaytadan yuboring.`
- **`addOfferRows(chatId)` / `offerAddForMedia`** read the staff member's open requests in
  ONE query: `SELECT r.id, … FROM calc_requests r WHERE r.requested_by = $staff AND
  r.completed_at IS NULL AND r.requested_at > now() - interval '7 days' ORDER BY
  r.requested_at DESC LIMIT 2` (the card label joined from deals/leads; `calc_requests` has no
  `created_at` — its clock is `requested_at`, schema wms.ts:2741), cached per chat for 60 s,
  because Door B and the media handler are on the poller. `addOfferRows` catches every error
  and answers `[]` (logged `[calc-amend] offer rows failed`), so Door B's own buttons never
  depend on it. No index on `requested_by` (stated; a few thousand rows). (re-check p4-1)
  Neither offers anything to a chat with a live collection, draft or capture (those take the
  message first), nor for a backlog message. `offerAddForMedia` makes one offer per
  `media_group_id` (a per-chat 10-minute memory like `noteForwardPart`, task-draft.ts:448), as
  a reply to the album's first part. (re-check p4-9)
- On open:
  `startIntake(chatId, base.section, { ai: true, staffId, amend: base, openedBy: pressedMessageId })`,
  then `updateIntake(chatId, { stage: 'review', facts, clientHintRaw: base.clientLabel ?? '', askedSeqs, standingAtOpen })`
  (`standingAtOpen` = the `amendStanding` the opening line was chosen by, product-fit-18).
  - `facts.goods` are the stored rows with `seq`, `itemId` and `law`.
  - `storedRequestFacts` hands the facts with R2's regression-3 flags (`lineWeightsStated:
    true, totalsStored: true`, the ones `missingFor`/`lineNeedsFor` force, service.ts:1567-1585).
    The open keeps `lineWeightsStated = true` always (a stored row's weight is its own; never
    one copied from the brutto, intake.ts:361-386) and sets `totalsStored = false` only in the
    Σ case below. (re-check p4-11)
  - When the stored m³ is the Σ of the stored lines (`volumeIsLinesSum`, line-totals.ts:60),
    `facts.volumeM3` is left null and `totalsStored` false, so R2's `factsVolumeM3` derives it
    from the lines and the table shows the Σ as lines are added (law-money-1). A typed m³ is
    kept as it is.
  - `askedSeqs` = `lawAsksOf(stored).map(a => a.seq)` (P5's, the SAME function that wrote the
    ❓ block), or null when empty. It is recomputed rather than read from the message: the
    ask is what the law asks NOW (product-fit-3).
- Then the standing line (§2.4) and `deliverNextStep` (the table).
- `ai: true`: the certificate toggle is NOT offered (`amendKeyboard`).
- `restart` (`cg:<id>`): when the live collection is already this request's add collection,
  it RESUMES (durability-2). Otherwise it claims `pressKey(ctx, 'restart')` (a claim already
  held → resume), then `endIntake`, then opens.
- **A returned request — ⭐ of Question 6** (product-fit-7): a NEW collection, not an add one:
  `startIntake(chatId, base.section, { ai: true, staffId, amend: null, openedBy })` with
  `facts.goods` = the stored rows as NEW lines (no `itemId`, no `seq`), the stored totals and
  cities, `seed` = those rows, stage `review` (`client` when `clientHintRaw` below is empty),
  and §2.4's returned line above the table.
  The seeded collection lands through `landIntake` like any «🧮»: Uch band decides the card (a
  coded client's re-send is a NEW deal, a colleague's client a lead in the sender's funnel, a
  stranger joins the open lead by phone or opens a new one). The returned request, its note
  and the files pre-bound to it stay on the old card. `clientHintRaw` = the deal's client
  code; for a lead, `lead_about_client`'s client code (only when `leadAboutReady()`), else the
  lead's phone; never the lead's name alone — with neither, the collection opens at the client
  stage and `CLIENT_QUESTION` asks him. (re-check p4-5)
  Under 6 b: §2.4's refusal.

### 9.3 `amendStanding` (wms, `amend.ts`)
```ts
export type AmendStanding = 'open' | 'started' | 'busy' | 'closed' | 'not_found';
export async function amendStanding(requestId: string): Promise<{
  standing: AmendStanding; rev: number | null; handsoffRev: number | null;
  completedVia: string | null; returnReason: string | null;
  /** `endingOf` (service.ts:1433) over completedAt/completedVia/answerAmount; null while open.
   * The door and the to_ved/closed words key on it (re-check p4-15). */
  ending: CalcEnding | null;
}>;
```
- not found → `not_found`;
- `completed_at` → `closed`;
- a machine pass's ticket STANDS → `busy`. «Stands» is P5's `ticketStanding(requestId)`:
  `ai_pass_rev IS NOT NULL` and the ticket's pg-boss job (`ai_pass_job`, asked as
  `jobState(passQueueOf(section), ai_pass_job)`, K15) is `created | retry | active`
  (performance-6, product-fit-6). A ticket whose job
  is terminal or missing is cleared there and then, conditionally on the same job id. No time
  window decides it: under a deep queue, the first draft's 35-minute window cleared `busy`
  before the landing pass had even started, the addition applied, and the landing pass then
  told the seller «VED allaqachon ishlayapti» about his own addition. The cost, stated: a pass
  KILLED by a deploy keeps its job `active` until its expiry — `PASS_EXPIRE_S` 1800 s
  (jobs.ts:41, R2 CONC-6), `TARIFF_EXPIRE_S` 300 s (:43) on the tariff queue — so an addition
  pressed then waits up to 30 minutes. The `waiting` words stay true (§2.4: he is told within
  the save job's minutes that it is stored), and the redelivered pass's settle (its
  `unfinished` stand-down, F rule 2) calls `requeueWaitingAmendments(requestId)`, which writes
  it then (re-check p4-18);
- `handsoff_rev IS NULL` → `started` (a request from before this deploy, or a correction);
- `prefillStanding(id, handsoff_rev)`: `ok` → `open`; `touched` / `confirmed` → `started`;
  `closed` → `closed`.
- ONE home: «has a person moved it» is `prefillStanding`'s, asked with the stamp.

### 9.4 The add collection's reading (`analyzeCollected`, the add branch)
- It runs for an add collection (`state.amend`) and for Question 6's seeded collection
  (`state.seed`). The kept rows are `state.amend?.items ?? state.seed`.
- The model is told the kept rows' names, so it lists only NEW goods. Today's `knownGoods`
  block says the names came from an Excel («Эти товары уже взяты из таблицы Excel…»,
  `knownGoodsText`, intake-ai.ts:425-441) and is passed the INVOICE's names when
  `aiGoods === 'add'` (calc-intake.ts:1505), which an add collection that receives an Excel
  beside a PDF still needs. So `analyzeIntake` gains `requestGoods?: readonly string[]` (the
  kept rows' names), printed before the Excel block, inside the same `KNOWN_GOODS_CHARS`
  (intake-ai.ts:412) budget, by `knownGoodsText(names, budget, source: 'invoice' | 'request')`
  — the request form's heading «Эти товары уже есть в заявке — НЕ повторяй их в goods,
  перечисли только новые:» and its «…и ещё N строк» tail say «заявки», not «таблицы»;
  `knownGoods` stays the invoice's. A prompt change: the corpus runs. (re-check p4-16)
- The NEW lines = `pickGoods` over the new material, MINUS any line `sameGoodsLine(kept, read)`
  matches against a kept row — `pickGoods`' own `carried` rule (calc-intake.ts:1259-1260: the
  same whole name, or `namesMeet` with `figuresAgree`), so a top-up read as «Куртка женская
  (Ladies jacket)» against a stored «Ladies jacket» is the stored row, never a second one
  priced twice. A matched line that states a different figure is the conflict below; a WIDE
  match whose figures disagree (`figuresAgree` false) is not matched at all and stays a NEW
  line (pickGoods' own reading: two factories, one name).
  (re-check p4-10)
- **A removed line that states a DIFFERENT figure becomes a CONFLICT** (law-money-5,
  product-fit-17). The first draft dropped it «for the VED», and both the seller and the VED
  were told it was written. `conflictOf(kept, read)` (pure, `amend.ts`, reached from
  `analyzeCollected` by the dynamic-import idiom of §9.1) is the one rule: per
  field the read line states (quantity, weight, volume, measure quantity), a conflict when
  the kept row's figure in that field DIFFERS, or when the kept row has that field EMPTY
  (`stored: null`; the first revision said such a line «changes nothing», so a packing list
  stating 120 kg for a row with no weight vanished). It goes into `state.conflicts`
  (`choice: null`) → the row is ⚠️ with the three-way question (§2.1). The default when he
  never answers is the VED's: named, never written. A removed line with the SAME figures
  changes nothing. Conflicts are recorded only for kept rows with an `itemId` (an add
  collection; `CalcGoodsFact` gains `itemId?` and `seq?`, K14): a seeded Question 6
  collection's rows are plain lines, handled by `pickGoods`. (re-check p4-11)
- A second conflict for the same row and field (a re-read) REPLACES the first; an answered
  one keeps its `choice` only while `read` is unchanged.
- `facts.goods` = the kept rows (answers re-applied by `placeByName`, `itemId` first) +
  the new lines.
- **Totals and cities are NOT read from new material** (§0.1(2)): the stored values stand;
  only a table answer («jami 3500 kg», a route) changes them, and `amendTotalsStale` names
  what the new lines left stale.
- A table answer is still judged against LATER material, as R2's CONC-2 judges it on any
  collection (`totalsDoubts` + `factsWithAnswer`, calc-intake.ts:469-532, :1550-1569): in the
  add branch `totalsDoubts` is given `reading` = what the NEW material's reading states (never
  the stored totals, which are not a statement made after the answer) and `since` as today. A
  doubted field is emptied in the table and asked, the answer kept. (re-check p4-6)

### 9.5 `amendDiff` (pure) and `amendRequest` (the one writer)
`amendSubmissionOf(state)` (pure, `calc-amend.ts`):
- `rowAnswers` = the `lineAnswers` entries that carry an `itemId`;
- `newLines` = the `facts.goods` entries with no `itemId`, answers applied;
- `totals` / `route` = what table answers set (R2's `totalsAnswer`, the `routeAnswer`
  carrier — durability-17), present keys only. `totals` omits every field
  `state.ambiguousTotals` names: a doubted answer is not written; it reaches the VED as a
  change line `· umumiy brutto: 3500 kg so‘ralgan, faylda 4200 kg — VED hal qiladi`, carried
  as K13's `AmendSubmission.doubtedTotals` (re-check p4-6, v2-0);
- a conflict answered `add` / `rep` is a `rowAnswers` entry (`stored + read`, or `read`), so
  it is written like any answer and its `expect` is the stored value;
- `conflicts` = `state.conflicts` with `choice` null or `'ved'` (both go to the VED by name);
- `material` = `[...state.material, ...state.answers]`; `fileCount` = `state.fileCount`.

```ts
export interface AmendChange {
  edits: { itemId: string; seq: number; name: string;
           set: Partial<{ quantity: number | null; weightKg: number | null; volumeM3: number | null;
                          measureUnit: MeasureUnit | null; measureQty: number | null; tnvedCode: string }>;
           expect: TableExpect }[];
  codesKept: { seq: number; name: string; typed: string; stored: string }[];   // for the VED only
  conflicts: AmendSubmission['conflicts'];                                     // for the VED only
  doubtedTotals: AmendSubmission['doubtedTotals'];                             // for the VED only (re-check p4-6)
  adds: TableNewItem[];                                                          // clientId set, through doorRow
  /** Present keys only; no null (law-money-6). */
  cargo: { weightKg?: number; volumeM3?: number; fromCity?: string; toCity?: string } | null;
  /** Totals the new lines left behind, not re-answered (law-money-1). */
  totalsStale: ('weightKg' | 'volumeM3')[];
  /** Set by the `to_ved` write: what the redo's words key on (§2.4; re-check v2-9). */
  told?: { reason: 'started' | 'closed' | 'lead_closed'; ending: CalcEnding | null; returnReason: string | null };
}
/** The seller's answers over a FRESH base: `set` = every answered field that differs from the
 * stored value now; `expect` = those stored values (row CAS); a new line's
 * `clientId` = uuidv5(noteId, String(index)) — a retried save is the same row. */
export function amendDiff(fresh: AmendBase, sub: AmendSubmission, noteId: string): AmendChange;
/** One home for «which totals does this addition leave stale» — the add table, amendDiff
 * and the re-run reply read it. */
export function amendTotalsStale(input: {
  section: CalcSection; stored: { weightKg: number | null; volumeM3: number | null; items: readonly { volumeM3: number | null }[] };
  linesAfter: readonly { volumeM3: number | null }[]; added: number;
  answered: { weightKg: boolean; volumeM3: boolean };
}): { stale: ('weightKg' | 'volumeM3')[]; resummedM3: number | null };
/** §2.4's lines. `applied` (the open branch only) names what the save dropped or cleared. */
export function amendChangeText(change: AmendChange, fileCount: number, applied?: SaveTableApplied): string[];
export type AmendOutcome =
  | { kind: 'applied'; amendmentId: string; rev: number; queued: boolean; lines: string[] }
  | { kind: 'to_ved'; amendmentId: string; reason: 'started' | 'closed' | 'lead_closed'; ending: CalcEnding | null; returnReason: string | null; lines: string[] }   // re-check p4-15, p4-4
  | { kind: 'waiting'; amendmentId: string; lines: string[] }
  | { kind: 'noted'; amendmentId: string; lines: string[] }
  | { kind: 'empty' } | { kind: 'duplicate'; row: CalcAmendmentRow }
  | { kind: 'not_yours' } | { kind: 'not_found' } | { kind: 'refused'; code: SaveTableRefusal };
export async function amendRequest(input: {
  requestId: string; staffId: string; staffName: string; noteId: string; chatId: bigint;
  submission: AmendSubmission;
  /** Writing a stored «waiting» addition: its row id (the row must still be 'waiting'). */
  waitingId?: string;
}): Promise<AmendOutcome>;
```
**Every number reaches its column through `doorRow`** (law-money-4). That is the «ONE
normalisation at the door» every other door applies (`openCalcRequest` maps its items through
it). `amendDiff` builds every add through `doorRow`, and every row answer that carries a unit
word or a code through the same rule (`doorPatch`, a thin wrapper over `doorRow`'s routing):
- «Kafel 120 m2» lands as `measure_unit m2 / measure_qty 120`, never as 120 pieces;
- an ADD keeps the seller's words in its note (a moved number, a non-code — never to
  `tnved_code`; `saveTable`'s adds path routes nothing itself, and its heal reads only rows AS
  STORED before the save);
- a row answer on a STORED row posts no `note`: an edit's note REPLACES the stored one
  (`TableItemEdit.note`, workspace.ts:3295, :4167, :4485), which would erase the landing's
  «og‘irlik umumiy (brutto)dan olindi» that `weightFromTotalNote` reads (intake.ts:313,
  :332-335). A non-code answered on a stored row is not written: it is a change line
  «… — yozilmadi» and the seller's words reach the VED in the thread message (the material,
  law 11). (re-check p4-17)

**The Σ rule and stale totals** (law-money-1). `amendTotalsStale` decides, and `amendDiff`
applies it:
- **volume**, when the section needs it, the seller did not answer «jami … kub», and a line was
  added or a line's volume changed:
  - if the stored m³ is null or the Σ of the stored lines (`volumeIsLinesSum`), then
    `resummedM3 = linesVolumeM3(linesAfter)`;
    - a whole Σ that differs → `cargo.volumeM3 = resummedM3` (R2's 2.7 b kept after the
      addition);
    - no whole Σ → `stale` gets `volumeM3`;
  - a TYPED stored m³ → `stale` gets `volumeM3`;
- **weight** (brutto), when the section needs it, the seller did not answer «jami … kg», and a
  line was added → `stale` gets `weightKg`. Brutto has no Σ rule (R2 MR-8).
- `change.totalsStale` is stored on the amendment. The re-run pass reads it (P5, §10.2.9):
  freight is not priced on a stale total. The VED's m³ reconcile chip still shows the
  mismatch, and P6's refusal makes the VED reload over it.
- The upsale's denominator follows: `quoted_m3 = COALESCE(v.volume_m3, r.volume_m3)` reads
  the re-summed `r.volume_m3` for an answer offer.

Order inside `amendRequest`:
1. `stored = await storedRequestFacts(requestId)`.
   - `null` → `not_found`; `requestedBy !== staffId` → `not_yours`.
2. `SELECT * FROM calc_amendments WHERE note_id = $noteId`:
   - a row and no `waitingId` → `{ kind: 'duplicate', row }`;
   - with `waitingId`: the row must be that id and still `'waiting'`, else `duplicate`; its
     stored `submission` is used.
3. `change = amendDiff(stored.base, submission, noteId)`. Nothing to write, no conflict, no
   doubted total, no kept code, no material, no file → `empty`.
4. `standing = await amendStanding(requestId)`.
   - `busy`, on a FRESH save → ONE short transaction in step 5's order: the request row and the
     lead check, INSERT `calc_amendments` (outcome `'waiting'`, `rev` NULL, `submission`,
     `change`, `chat_id`) `ON CONFLICT (note_id) DO NOTHING RETURNING id` (no row →
     `duplicate`), the card note, then `insertThreadMessageInTx` (the waiting sentence) →
     `waiting`. (re-check p4-4)
   - `busy`, on a WAITING row → nothing; the row stays `'waiting'` and the next settle
     re-enqueues it.
5. The card note (only when the add collection carried material or files) is written INSIDE
   the transaction that records the amendment, through
   `insertActivityTx(tx, { id: noteId, entityType, entityId, kind: 'note', note: amendNoteText(…) }, { actorId: staffId })`
   (Uch band's, crm/service.ts:1545), right AFTER `INSERT INTO calc_amendments … ON CONFLICT
   (note_id) DO NOTHING RETURNING id` returned a row (no row = `duplicate`, nothing else
   written, so the note's primary key can never collide). `entityType/entityId` come from the
   request row under the lock: in the `open` branch inside saveTable's `inTx`, read through
   `tx` from the row `lockRequestInTx` already holds FOR UPDATE (it returns only `{ rev }`,
   workspace.ts:3544-3567); in the waiting / noted / to_ved transactions from
   `SELECT entity_type, entity_id FROM calc_requests WHERE id = $id FOR UPDATE`, taken FIRST
   (the one lock order, `mutateRequest`'s: the request row before anything else, so a waiting
   run and an open run of one note cannot deadlock on the request row and the note key) — Uch
   band's win split re-keys a won lead's requests onto its deal (`rekeyLeadCalcJobsTx`,
   calc/service.ts:1134), so the card is never the one `storedRequestFacts` read on the pool.
   For a lead, the next statement is `SELECT 1 FROM leads l JOIN lead_stages s ON s.id =
   l.stage_id WHERE l.id = $entity AND s.kind = 'open' FOR SHARE OF l` (recalcFromSealed's
   order, workspace.ts:2541-2556); none → `CalcError('lead_closed')` → that transaction rolls
   back and the amendment is recorded `to_ved` with reason `lead_closed` in its own transaction
   (step 8, which does not ask the lead again) — never a row write, never a re-pass. A waiting
   row's note was written by its `'waiting'` INSERT; its later UPDATE writes none (the lead is
   still asked). Two runs of one job overlap when pg-boss expires the first while it still runs
   (durability-15): the second's INSERT waits on the first's key and returns no row →
   `duplicate`. (re-check p4-4)
6. **noted** (law-money-5): `change` writes nothing to the rows (no edits, adds or cargo) but
   carries material, files, conflicts, doubted totals or kept codes. ONE short transaction:
   INSERT (or, for a waiting row, `UPDATE … SET outcome = 'noted', outcome_sent_at = NULL WHERE id = $id AND outcome = 'waiting' RETURNING id`)
   + the card note and the lead check (step 5) + the thread message. No `saveTable`, no rev
   move, no re-pass → `noted`.
7. **open**:
   ```ts
   saveTable(requestId, { items: edits(→TableItemEdit with expect), adds: change.adds, cargo: change.cargo },
     { actorId: staffId, ip: null, userAgent: null },
     { expectRev: standing.handsoffRev!, handsOff: true, inTx: async (tx, rev, applied) => {
         // a fresh save INSERTs; a waiting row is UPDATEd WHERE outcome = 'waiting' (0 rows → throw → duplicate)
         await recordAmendmentInTx(tx, { id, requestId, noteId, staffId, chatId, outcome: 'applied', rev, submission, change, waitingId });
         // step 5: the card read through tx, the lead check, then the card note (fresh save only)
         await insertThreadMessageInTx(tx, { id: threadId, ref: { kind: 'calc', id: requestId }, body, actorId: staffId });
     } })
   ```
   - The stamp moves inside the save itself (`handsOff`, K15). The `inTx` no longer writes
     `handsoff_rev`.
   - `CalcError('conflict')` / `CalcError('changed_under')` → a person moved it between the
     read and the lock → the `to_ved` branch (`reason: 'started'`).
   - `already_closed` → the `to_ved` branch (`reason: 'closed'`, `ending` re-read —
     re-check p4-15).
   - `lead_closed` (thrown by step 5's lead check inside `inTx`, so the whole save rolled back)
     → the `to_ved` branch (`reason: 'lead_closed'`). (re-check p4-4)
   - `ai_running` (law-money-7) → read `amendStanding` again: `busy` (a machine pass's
     ticket) → the `waiting` branch; otherwise a person pressed ✨ → the `to_ved` branch
     (`reason: 'started'`). The first draft told the seller «birozdan keyin qayta bosing»
     about a job a person had taken, and every retry failed the same way.
   - Any other `SaveTableRefusal` → `refused` (words from `AMEND_REFUSAL`, §2.4).
   - The outcome's `lines` (and the thread message, which `inTx` now writes LAST with the
     save's `applied` in hand, K15) come from `amendChangeText(change, fileCount, applied)`:
     a measure the save dropped or cleared is named «yozilmadi», never «yozildi»
     (regression-16).
   - On commit: `queued = await queueCalcPrefill({ requestId, staffId, section, pass: \`amend:${id}\`, atRev: rev })`.
     `atRev` means the ticket is taken only while `rev` is still the addition's own revision.
     A person who saved in the milliseconds since gets the job, not the machine.
8. **started / closed / lead_closed**: ONE short transaction: INSERT (or UPDATE a waiting row)
   with outcome `'to_ved'`, `rev` NULL, `change.told` = `{ reason, ending, returnReason }`
   (re-check v2-9), the card note (step 5's rule; the `lead_closed`
   transaction does not ask the lead again, and its thread message is the `closed` sentence,
   §2.4), plus `insertThreadMessageInTx` (durability-5: the thread message IS the VED's
   delivery, so it rides in the transaction that records the addition).
9. After the commit: `void announceNote({ entityType, entityId, note: body, authorId: staffId, activityId, calcRequestId: requestId }).then(() => stampAnnounced(amendmentId)).catch(log)`
   (wms/crm/internal-chat.ts:697 — there is no `announceThread`; `entityType`, `entityId`,
   `activityId` and `createdAt` are what `insertThreadMessageInTx` returns, K15) and
   `markThreadRead(staffId, { kind: 'calc', id: requestId }, createdAt)` as `addThreadMessage`
   does (wms/crm/thread.ts:263-269); the redo calls the same pair. `amendChangeText` fits the
   thread body to `THREAD_TEXT_MAX` (4000, platform/notifications/thread-ref.ts:51; lines
   dropped from the end into «· … yana {n} ta o‘zgarish»), and `insertThreadMessageInTx`
   asserts the same cap. (re-check p4-3, p4-19)
- **Allowed fields** are only `edits[].set`'s keys. Never `bazaUsd`, `bazaBasis`,
  `importRowId`, rates, `freightZone` or `hasCertificate`.
- `tnvedCode` only where the stored code is null (`codesKept` otherwise).

**A repeat redoes only what is missing** (durability-5). On `duplicate`, the save job
(`runAmendSave`) reads the row and redoes, each step idempotent:
1. the re-pass: `outcome = 'applied'`, no ticket standing, and no `CalcPrefilled` row whose
   `payload->>'pass' = 'amend:<id>'` (K15's `sayOnce(requestId, pass, input, opts)` writes
   `pass` into every claim row's payload, the CONC-4 holder row included — re-check kernel-10)
   → `queueCalcPrefill({ …, pass, atRev: row.rev })`. If `rev` has moved since, the ticket is
   refused and the VED has the job;
2. the ping: `announced_at IS NULL` → `announceNote` + the read mark again (step 9's pair,
   rebuilt from the thread message the row's transaction wrote) (re-check p4-3);
3. the seller's words: `outcome_sent_at IS NULL` → the outcome's words, rebuilt from
   `row.outcome`, `row.change.told` for a `'to_ved'` row (re-check p4-4, p4-15, v2-9), and
   `amendChangeText(row.change)`, then the stamp;
4. `endIntake` (the collection, if still live).

**`requeueWaitingAmendments(requestId?)`**: every `'waiting'` row (of that request, or all)
whose request has no ticket standing is enqueued on `calc.amend-save` with its `amendmentId`,
`{ id: jobId, expireInSeconds: 120, retryLimit: 3 }` like the press. There is no
`singletonKey` (`EnqueueOptions`, boss.ts:191-196, gains only `id` and `startAfter`; on
pg-boss 10.4.2 a key without `singletonSeconds` dedupes nothing on the standard queue
`createQueue` makes): the once-fence of an addition is `calc_amendments.note_id`, and a
duplicate job is harmless — it answers `duplicate` off `calc_amendments_note_unique` and
redoes only what is missing. (re-check p4-2) The settle (P5) calls it per request; the sweep
(P1) calls it for all, as the net under a lost enqueue.

### 9.6 `saveAmendment`, the save job and the reply door
- **`saveAmendment`** (the press; durability-4 — the first draft's `void runAmendSave` died
  with every graceful deploy, because nothing drains `void` work on SIGTERM):
  - the save branch's guards have run (K11's order);
  - `token = randomUUID()`, `jobId = randomUUID()`;
    `updateIntake(chatId, { saving: { token, at: now, jobId } })`; `await flushIntakeWrites(chatId)`;
  - `await enqueue(JOB_CALC_AMEND_SAVE, { chatId, staffId, requestId, noteId, submission: amendSubmissionOf(state), amendmentId: null, savingToken: token },
    { id: jobId, expireInSeconds: 120, retryLimit: 3 })` — no `singletonKey` (§9.5: the
    once-fence is `calc_amendments.note_id`; re-check p4-2);
  - reply `⏳ Qo‘shilmoqda…` (its id joins `ownMessageIds`);
  - on an enqueue throw: release `saving` (quiet) and §2.4's words.
- **`runAmendSave(data, retryCount)`** (the job) — under the reading's two fences
  (durability-15): an in-process `globalThis` set of note ids in flight (a second run of the
  same note in this process returns at once; the first one answers), and ONE wall clock,
  `AMEND_SAVE_EXPIRE_S = 120` with `deadline = start + 110 s`, checked between steps, its
  sends at `timeoutMs: 10_000`. It first awaits `intakesHydrated` like the reading
  (durability-9). Then `amendRequest(…)`, and by outcome:
  - `applied`, `to_ved`, `noted`, `waiting` → send the words by chat id, stamp
    `outcome_sent_at`, `endIntake` when the live collection carries this `noteId`;
  - `duplicate` → the redo above;
  - `empty`, `refused` → the words, release `saving`, keep the collection;
  - a throw → rethrow (pg-boss retries). On the last attempt: release `saving`, and say
    `Qo‘shib bo‘lmadi — «✅ Qo‘shish» ni qayta bosing.`
  - A waiting row's run (`amendmentId` set) sends the «Kutib turgan …» words (§2.4) by the
    row's `chat_id` and touches no collection.
- **A frozen collection.** While `saving` is set, the ladder answers a text or file with §2.4's
  words and «✖️ Bekor qilish» is refused. The sweep never reminds it. A `saving` whose job is
  dead (`jobState(JOB_CALC_AMEND_SAVE, saving.jobId)` terminal or null, K15) is released by
  the sweep, through P1's `sweepAction`, with the last-attempt words.
- **`foreignAddReply`** (regression-5, product-fit-5): `replyTo` resolves (`replyVerdictFor`)
  to `calc_add` for request B, and the live collection is not B's add collection. Then §2.4's
  two-card words with `cg:<B>` / `c:resume`, and nothing is written. B's own add collection
  takes the reply as a table answer.
- **`reply-door.ts`**:
  - `ReplyVerdict` gains `{ kind: 'calc_add'; requestId: string }`. `replyVerdictFor` returns
    it for a `CalcPrefilled` row whose `payload.add === true` and `payload.requestId` is a
    uuid. Without `add` it stays `not_replyable`. CalcDone / CalcSealed / CalcReturned /
    CalcTaken are untouched (Q2 a).
  - No change to which rows it reads (`status = 'sent'` with the drain's `payload.tg`,
    reply-door.ts:96-121). The re-run's answer to a seller who muted «✅ Mening vazifalarim»
    (⭐ of Question 7, P5 §10.2.5) is one such row: `sayOnce`'s `direct` → `ignoreMute` queues
    it `pending` with `direct: true`, and the DRAIN sends it and writes `payload.tg`, so a reply
    «2: 40 juft» to it resolves to `calc_add` like any sent ping. (re-check p4-7)
  - `mediaSentenceFor` / `verdictSentence` return null for it.
  - `threadReplyFromBot` → `await openAmendFromReply(chatId, requestId, { text, date, messageId })`
    → returns `{ text: null }`: HANDLED, nothing more to say (regression-2). The first draft
    returned null, which the ladder reads as «not handled». The same text then reached
    Door B, then `takeTaskPending` (which deletes on read and would close an armed task with
    «2: 40 juft» as its result), then the paid assistant.
  - `openAmendFromReply`: the door's checks (§9.2); then open (or resume) the add collection
    in the `review` stage, with `takenUpTo` = this message's id (so a redelivery is `seen`);
    then the text goes through K6's `routeCollectorText` — P3's table-answer path, with a
    chat-id sender as its `ctx`. No second answer path. Messages go by chat id.
  - `refuseMediaReply`: a photo or file replied to a `calc_add` message opens the collection
    and files the media as material, through K5's `saveIntakeFile` / `readIntakeFile`. A
    VOICE note, audio or video replied to one (the same function serves the voice handler)
    opens nothing: it answers `🎤 Ovozli xabar o‘qilmaydi — yozib yuboring.` and returns true
    (regression-18, his 1.12 a). The first draft opened a 24-hour collection with nothing in
    it, or fell through to the cabinet's silence.
  - A BACKLOG file or voice note (`isBacklog(ctx.message.date)`) replied to a `calc_add`
    message opens nothing: the `calc_add` branch returns false, and the handler's own
    `tellBacklogOnce` answers as today (Q5 a: only a hydrated collection takes backlog). Both
    handlers reach `refuseMediaReply` before their `late` check (staff-handlers.ts:711, :799),
    so the branch asks it itself. (re-check p4-8)
  - A HOLDING collection in that chat takes a TEXT reply first only when it is that request's
    own; another request's is `foreignAddReply`'s (K11 wires it in the text ladder only). A
    FILE replied to another request's ➕ message while a collection holds joins the holding
    collection: the photo/document handler files into a live collection before anything reads
    what it replies to (staff-handlers.ts:691-726), and P4 touches neither handler — stated
    (re-check p4-8). A PARKED collection does not take the reply at all: the reply reaches the
    door, and the door asks the «another collection» question.

### 9.7 Tests (P4)
**`amend.integration.test.ts`** (a real database; the pass simulated by a stamp):
- (a) land → stamp `handsoff_rev = rev` → `amendRequest` with «3: 50 dona» on a stored row,
  one new line and «jami 3500 kg» → `applied`:
  - the row's quantity is 50; the new line is present; `weight_kg` is 3500;
  - `handsoff_rev = rev` (moved by the save itself); one `calc_amendments` row with that rev;
  - one thread message, written in the same transaction;
  - `queueCalcPrefill` spied with `pass: 'amend:<id>'` and `atRev = rev`.
- (b) a VED's screen save after the stamp → `to_ved`, the rows unchanged, the thread message
  carries the change lines.
  **Red proof:** read the standing with `prefillStanding(id, null)` → applied over the VED.
- (c) a person saving between `amendStanding` and the lock (holder FOR UPDATE, the
  pg_stat_activity observer idiom) → `conflict` → `to_ved`, nothing written.
- (d) a closed request (answered) → `to_ved`/`closed` with `ending` `answered`; a returned one
  with `returnReason`, and the words never promise a reopen; one closed with no price
  (`unpriced_task`) → the price-less words, never «javob berilgan» (re-check p4-15).
- (e) a ticket whose job is `active` → `busy` → a `'waiting'` row + its thread message; a
  ticket whose job is `failed` → cleared and NOT busy.
  **Red proof:** decide busy by a 35-minute window (the first draft) → a deep-queue ticket
  reads not busy.
- (f) the same note id twice → `duplicate`, one row, no second write.
  **Red proof:** drop the `calc_amendments` insert from `inTx` → the second call writes again
  (or refuses `changed_under`).
- (g) not the requester → `not_yours`.
- (h) a code on a coded row → not written, named in `codesKept` and in the thread.
- (i) `handsoff_rev` NULL → `started`.
- (j) «Kafel 120 m2» as a new line → `measure_unit m2`, `measure_qty 120` (law-money-4).
  **Red proof:** pass the line to `saveTable` raw → 120 pieces.
- (k) a stored Σ m³ of 12, a new line of 3 m³ → `calc_requests.volume_m3` 15, and
  `upsaleRows`' `quoted_m3` for an answer offer reads 15 (law-money-1).
  **Red proof:** skip the re-sum → 12.
- (l) a typed m³ and a new line → not re-summed, `totalsStale` holds `volumeM3`, the change
  lines say so; a new line → `weightKg` stale.
- (m) only a file and the same figures → `noted`: no rev move, no ticket, the thread message
  says the rows did not change (law-money-5).
  **Red proof:** route it through the open branch → rev moves and a pass is queued.
- (n) a waiting row, then the ticket clears → `requeueWaitingAmendments` → the row becomes
  `applied` (or `to_ved` when a VED saved meanwhile), told once.
- (o) `cargo` with only `weightKg` → the stored cities and m³ are untouched (law-money-6).
- (p) a request sealed between `amendStanding` and the lock → `to_ved`/`closed`, nothing
  written; a VED's ✨ claim held → `to_ved`/`started`; a machine claim (ticket standing) →
  `waiting` (law-money-7).
  **Red proof:** leave `ai_running` in `refused` → «birozdan keyin qayta bosing».
- (q) «2: 40 juft» on a row whose law needs no juft → the save drops it; the seller's words
  and the thread say «2-qator «Krossovka»: 40 juft — yozilmadi …» (regression-16).
  **Red proof:** build the lines from the submission (the first draft) → «yozildi».
- (r) a conflict answered `add` (stored 300, read 200) → the row reads 500; answered `ved` →
  the row unchanged, named in the thread; a read 120 kg on a row with no weight, unanswered →
  not written, named (product-fit-17).
- (s) a lead WON between `storedRequestFacts` and the save (the request re-keyed onto its
  deal by `rekeyLeadCalcJobsTx`) → the card note and the thread land on the DEAL; a lead LOST
  between them → `to_ved`/`lead_closed`: no row written, no pass queued, the note on the lost
  lead (re-check p4-4).
  **Red proof:** take `entityType/entityId` from `storedRequestFacts` (the pooled read) →
  the note lands on the won lead.

**`amend-save-job.integration.test.ts`** (the job, the sender mocked):
- a press → the collection is `saving`, the row flushed, one job enqueued; the job runs →
  words once, `outcome_sent_at` set, the collection ended.
- two enqueues of one note (no `singletonKey` — re-check p4-2) → ONE `calc_amendments` row,
  ONE card note and ONE seller reply; the second job answers `duplicate`.
- kill after the commit (throw after `amendRequest`, before the words) → the redelivery says
  the words once; the re-pass queued once; the ping once (durability-5).
  **Red proof:** answer `duplicate` with the fixed sentence (the first draft) → no words of
  the outcome, no re-pass.
- hydrate with an amendment that exists and was never told → the collection kept, the job
  re-enqueued, the words sent once (durability-4).
- a text while `saving` → the frozen words, nothing appended.
- two runs of one save job in one process (the expiry race, simulated) → one `amendRequest`,
  one card note, the words once (durability-15).
  **Red proof:** drop the in-flight set and write the card note BEFORE the `calc_amendments`
  INSERT (the first draft's order) → the second run throws on the primary key (re-check
  p4-4).
- a save job fetched before hydrate → waits; never hydrated → throws, no words (durability-9).

**`amend-diff.test.ts`** (pure; `amendDiff`, `amendTotalsStale` and P4's `amendSubmissionOf`):
- an answer over a fresh base whose row the machine changed since the open → `expect` holds
  the FRESH values;
- a new line repeating a stored name with the same figures → not in `adds`, no conflict;
  with a different figure → a conflict, not in `adds`;
- `clientId` is deterministic per note and index;
- the Σ cases (k)/(l) as pure inputs;
- a totals answer «jami 3500 kg» that later material doubts (4200 kg) → `totals` carries no
  `weightKg`, `doubtedTotals` names both figures, the change line reads
  `· umumiy brutto: 3500 kg so‘ralgan, faylda 4200 kg — VED hal qiladi` (re-check p4-6);
- a row answer on a stored row whose note is `LONE_WEIGHT_NOTE` → the edit carries no `note`,
  the stored note survives (re-check p4-17);
- the change text lines literally, and a body over `THREAD_TEXT_MAX` cut from the end into
  «· … yana {n} ta o‘zgarish» (re-check p4-19).

**The corpus** (re-check p4-10): the add branch's cases join `intake-corpus.json` — a top-up
read as «Куртка женская (Ladies jacket)» against a stored «Ladies jacket» (the stored row, not
a new one), a bracketed colour «Kurtka (qora)» 200 against a stored «Kurtka» 300 (a NEW line),
a Han half — and the whole corpus runs before P4 merges (#1463-#1468).
**Red proof:** subtract by `goodsNameKey` equality (the first draft) → the bilingual top-up
lands as a second row.

**`calc-amend-press.test.ts`** (handler fakes):
- every refusal of §2.4 with its words — the closed lead (`leadOpen: false`, re-check p4-4)
  and the price-less ending (re-check p4-15) among them;
- the restart (`cg:`) ends the old collection; a `cg:` for the request already live resumes
  it; a redelivered `cg:` resumes (durability-2);
- the resume of the same request;
- «▶️ Yo‘q, davom etaman» is `c:resume` (product-fit-8; re-check v1-8);
- the open table starts with `➕ Qo‘shimcha · {card}`, numbers rows by `seq`, and carries
  `amendKeyboard`;
- a reply «2: 40 juft» to an AI answer with `add` → the collection opens with row 2 written
  and echoed, and the ladder STOPS there: an armed «✅ Bajarildi» task stays open, and the
  assistant spy is never called (regression-2).
  **Red proof:** return `not_replyable` for `CalcPrefilled` → «Bu xabarga javob tizimga
  tushmaydi»; return null from the door (the first draft) → the task closes with «2: 40 juft».
- a reply to B's AI answer while A's collection holds → the two-card words, A unchanged.
- a returned request → a new collection filled with its rows (⭐ of Question 6).
- a voice note replied to an AI answer with `add` → «🎤 Ovozli xabar o‘qilmaydi …», no
  collection opened (regression-18).
  **Red proof:** treat voice like a photo → a collection opens with nothing in it.
- a BACKLOG photo replied to an AI answer with `add` → no collection opened, `tellBacklogOnce`
  answers (re-check p4-8).
  **Red proof:** drop the `isBacklog` clause → a 24-hour add collection opens off the backlog.

**`amend-offer.test.ts`** (product-fit-16; handler fakes, the real Door B):
- a forward with one open request of his → Door B's keyboard carries «📌 …» and
  `➕ B-000067 so‘roviga qo‘shish` (`cf:<id>`); the press opens the add collection with the
  forwarded text as its material;
- a forwarded ALBUM with one open request → the press files every part the album memory holds
  (`forwardAlbumOf`), one attachment each (re-check p4-9);
- a plain document with one open request → the offer line as a reply to it; the press files
  that document (one attachment) into the add collection; a plain album of ten photos → ONE
  offer line, as a reply to its first part (re-check p4-9);
- no open request (or one older than 7 days, or a closed one, or a colleague's) → Door B
  unchanged and the plain document gets today's silence;
- a live collection → no offer (the collection takes the file first).
  **Red proof:** drop the 7-day clause → a month-old request is offered.
- the offer query throws → Door B's own two buttons still come (`addOfferRows` answers `[]`)
  (re-check p4-1).

**`amend-wire.test.ts`** (source shape):
- `amend.ts` and `calc-amend.ts` name none of `landIntake`, `landCodedRequest`,
  `landCodedCard`, `calcCardFor`, `cardOfNote`, `rootRequestOfNote`, `shellCandidate`,
  `openLeadForPhone`, `calcDealOwnerFor`, `clientSellerFor`, `resolveIntakeClient`,
  `calcStageMove`, `moveToCalcStage`, `openCalcRequest`, `createDealInTx`, `insertLeadTx` (Uch
  band's landing, shipped, docs/UCH-BAND.md, §14; `dealFor` no longer exists, so a fence on it
  is vacuous, and there is no `landRequestHalf`) (re-check p4-12);
- the card note goes through `insertActivityTx(tx,`, never `addActivity(` (re-check p4-4);
- the `saveTable` call in `amendRequest` posts no `bazaUsd`, `bazaBasis`, `importRowId`,
  `bazaReason`, `rateSource` or `freightZone` (the `ai-advisory.test.ts` pattern);
- `amendDiff`'s adds and unit answers pass through `doorRow` (the name is in the function);
- the `inTx` body, `recordAmendmentInTx` and `insertThreadMessageInTx` name `tx.` and no
  `db.` (#714 — `tx-pool.test.ts` does not see a callback executed inside another function's
  transaction);
- `AMEND_REFUSAL` is typed `Record<SaveTableRefusal, string>`;
- `storedRequestFacts` names no `loadWorkspace` (performance-9);
- `aiPrefill` builds `lawAsksOf`'s input from the `ws` it already loaded, through the pure
  `lawAsksInputOf(ws)`, and calls no `storedRequestFacts` (performance-9).
  **Red proof:** put `bazaUsd: null` in an edit → the fence names it.

---

## 10. P5 «Son» — the law's count after the AI answer (2.8 b), and the machine's side of the door

### 10.1 Files OWNED
- `src/modules/wms/calc/`: `jobs.ts`, `say-once.ts` (the `direct` → `ignoreMute` line; K made
  the signature, K15), `prefill-queue.ts`, `prefill.ts`, `prefill-steps.ts` (passing
  `expectRev` / `handsOff`), `ai-reply.ts` (the tails, the re-run heading), `prefill-reply.ts`
  (`tariffReplyText`: `pass`, the audience into `roadRefusalLine`, the heading),
  `reply-heads.ts` (`RERUN_WORD`), `estimate.ts` (one word), `service.ts` (`requestAsks`
  only). `freight-answer.ts` is not P5's: it holds only `FREIGHT_TAIL` and `FREIGHT_WORDS`.
  (re-check p5-p6-9, p5-p6-10)
- `intake-land.ts`: P5's lines of K's `retried()` (the queue, the stage move, `replyQueued`;
  P2's attach line goes before them), and `from-thread.ts`'s two retry exits (the root branch :389-390 and K2's
  `opened.existing`), rule 1 (re-check v3-0).
  (re-check p5-p6-6)
- new `src/modules/wms/calc/law-asks.ts`
- `src/modules/platform/telegram/staff-bot.ts`: ONE hunk, `buttonsFor`'s `CalcPrefilled`
  branch, beside `CalcLinkAsk` before the function's last `return null` (staff-bot.ts:642-709; re-check v3-4).
  P2 holds the `landCollectedIntake` hunk (:1274).
- `workspace.ts`'s grouping seams are K's (K15); P5 only passes them.
- Tests: new `law-asks.test.ts`, `calc-pass-settle.integration.test.ts`,
  `calc-add-buttons.test.ts`, `handsoff-writers.test.ts`. Re-anchors (re-check p5-p6-4):
  - `calc-prefill-once.integration.test.ts`: its six tests: the three that call `sayOnce`
    directly (:187, :221, :224, :278) take K's `'landing'` second; the three that drive the
    worker (:129, :150, :231) change nothing (their jobs carry no `pass`) — they reach the real
    `settlePass` with non-uuid job ids ('j1'…'j3'; `ai_pass_job` is uuid), whose 22P02 its own
    catch logs (or give the jobs uuid ids) (re-check v3-3); CONC-1, CONC-4 and perf-5 keep their assertions;
  - `calc-prefill-wire.test.ts`: `sayOnce(requestId, pass, {` (:172); the `expected` line
    (:213) unchanged, the call (:214) becomes `aiPrefill(requestId, { actorId: null }, {
    replyTo: staffId }, { ...expected, pass })`; :195-196 pin the ticket (`SET ai_pass_rev =
    rev`, `enqueue(passQueueOf(`) instead of `prefillTicket(`; the two routing cases (:86-111)
    move to `calc-pass-settle.integration` (the ticket is a statement, nothing to stand in),
    with `pass` in the payload and `id` in the options; the expiries (:117, :127) and «not
    rethrown» (:220-229, the settle included) unchanged;
  - `calc-prefill-standdown.test.ts` and `intake-corpus.test.ts` (c0220, c0221): K's
    `'landing'` stays (their jobs carry no `pass`); standdown's two `prefill.run` assertions
    (:103, :146) gain `pass: 'landing'` in the fourth argument; both files mock
    `@/modules/wms/calc/prefill-queue` (`settlePass: vi.fn()`) beside `./say-once`; c0789 and
    c0804 unchanged;
  - `intake-round1.test.ts:226-248`: its two literals (:244, :246) become
    `await sayOnce(requestId, pass, {`;
  - `calc-prefill.integration.test.ts`: :806 and :851 (re-check v3-4) open no chain of their own and leaned on
    the fallback rule 3 deletes, so each passes `{ expectRev: await prefillTicket(id) }` (the
    worker's path); :463 and :750 gain the `handsoff_rev` assertion (§10.3);
  - `ai-reply.test.ts` (the `asks` and `pass` fields, the audience-keyed tails),
    `prefill-reply.test.ts` (the tariff re-run heading, the chat tail);
  - `estimate.test.ts:368-377` (the words pin): `refused_measure` becomes `{ chat: '⚠️ qatorda
    soni yoki og‘irligi yo‘q — mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    lenta: '⚠️ qatorda soni yoki og‘irligi yo‘q — mijozdan so‘rab, kartadagi lentaga yozing' }`,
    the other three keys unchanged;
  - `customs-estimate.integration.test.ts:536` and `calc-prefill.integration.test.ts:305-307`:
    both read `out.text`, the CHAT rendering, so each asserts the ➕ tail there and the R2 tail
    on `out.lentaText` (re-check p5-p6-9, v3-1);
  - `stored-volume.integration` (:99-105) and `calc-kiritish.integration` (:181) for the
    rebuilt `requestAsks` (§10.2.7) — not `calc-intake.integration`. (re-check p5-p6-13)

### 10.2 Rules
1. **The ticket marks a pass owed, and names its job.** `prefill-queue.ts` holds the one
   home, `ticketStanding(requestId): Promise<'live' | 'none'>`. It reads `ai_pass_rev`,
   `ai_pass_job` and `section`, and asks `jobState(passQueueOf(section), ai_pass_job)` (both
   K15). A terminal or missing job is cleared there
   (`… WHERE id = $id AND ai_pass_job = $deadJob`) and answers `'none'`. (re-check p5-p6-7)
   `queueCalcPrefill`:
   ```sql
   -- after ticketStanding() cleared a dead ticket, and with jobId (a uuid) minted here
   UPDATE calc_requests SET ai_pass_rev = rev, ai_pass_at = now(), ai_pass_job = $job
    WHERE id = $id AND completed_at IS NULL AND ai_pass_rev IS NULL
      AND ($atRev::int IS NULL OR rev = $atRev::int)
   RETURNING rev
   ```
   - It replaces the sender's `prefillTicket` read (prefill-queue.ts:36): an atomic ticket.
     `prefillTicket` itself stays exported (rule 3).
   - No row: `true` when `ticketStanding` answered `'live'` (a pass already stands, so a
     resume's ✅ — `replyQueued`, intake-land.ts:596, which feeds `tariffFollows` — stays
     truthful); otherwise `false` (closed, or with `atRev` a person moved the request since the
     commit that asked for the pass). Two resumes of one cut-off landing, or a duplicate's
     redo, therefore queue one pass (durability-3, durability-5).
   - Then `enqueue(passQueueOf(input.section), { requestId, staffId, rev, section, pass }, {
     id: jobId, expireInSeconds: parts.customs ? PASS_EXPIRE_S : TARIFF_EXPIRE_S })` — R2's two
     expiries kept (prefill-queue.ts:43, :45): the default 15 minutes would re-deliver a live
     customs pass beside itself (jobs.ts:22-41).
   - An enqueue that throws clears the mark (`WHERE ai_pass_job = $job`) and answers `false`.
   - `rev` and `updated_at` are not moved: the clock stays the person-touch detector.
   - **Uch band's retry exits queue too** (re-check p5-p6-6). `rootRequestOfNote`
     (intake-land.ts:525-526; from-thread.ts:389-390) returns before the bill, the queue and
     the stage move, so a landing cut after `openCalcRequest` committed was resumed with ZERO
     passes, and the retried ✅ promised a VED answer. K turns `landIntake`'s two exits (that
     one and K2's `opened.existing`) into one local `retried(requestId)`. Its final code, P2's
     line first, then P5's (on a conflict at the merge keep both, in this order):
     ```ts
     const queuedBefore = await rootRequestOfNote(input.noteId);
     if (queuedBefore) return retried(queuedBefore);
     // … and after openCalcRequest: if (opened.existing) return retried(opened.id);
     async function retried(requestId: string): Promise<IntakeTarget> {
       await attachIntakePasses(input.noteId, requestId).catch((err: unknown) => logger.warn({ err, requestId }, '[calc-intake] readings not attached')); // P2
       const replyQueued = await queueCalcPrefill({ requestId, staffId: input.collectedBy, section: input.section, atRev: 0 }); // P5
       try { await moveToCalcStage(target, input.collectedBy); } catch (err) { logger.error({ err, kind: target.kind, id: target.id }, '[calc-intake] stage move failed'); } // P5
       return { ...target, queued: true, requestId, queueError: null, replyQueued };
     }
     ```
     from-thread.ts:389-390 (P5): `const root = await rootRequestOfNote(input.noteId); if
     (root) { await queueCalcPrefill({ requestId: root, staffId: actor.id, section:
     input.section, atRev: 0 }); return { ...target, queued: true }; }`, and K2's
     `opened.existing` exit (a concurrent twin under the note lock) takes the same queue before
     it returns: `if (opened.existing) { await queueCalcPrefill({ requestId: opened.id, staffId:
     actor.id, section: input.section, atRev: 0 }); return { ...target, queued: true }; }` —
     a no-op beside the twin's own queue, through the ticket. The root branch is the CLIENT
     path only (it sits inside `if (!target)`). On a DEAL or LEAD card the note is written in
     the request's transaction, so a sequential retry after a commit is refused `note_taken`
     by the pooled check before any transaction (service.ts:378-383, Uch band's double-press
     fence, from-thread.ts:306) and queues nothing: such a cut is stated, not resumed (§15)
     (re-check p5-p6-6, v3-0). `atRev: 0` is the
     revision every request is born at (0092's default), so the ticket refuses a pass that
     stands or any write since the INSERT. Stated (§15): a customs pass that finished WITHOUT
     moving the revision runs once more on such a retry — one model call, its message silenced
     by the `'landing'` claim.
2. **The pass settles**, on every way out of the worker (success, stand-down, failure, in a
   `finally`), in ONE statement that ONLY clears the ticket:
   ```sql
   UPDATE calc_requests SET ai_pass_rev = NULL, ai_pass_at = NULL, ai_pass_job = NULL
    WHERE id = $id AND ai_pass_job = $job
   ```
   then `await requeueWaitingAmendments(requestId)` (P4; each enqueue in its own `try`). An
   addition stored while this pass ran is written now, without a second press (product-fit-6).
   - The job id reaches it: `registerCalcPrefillWorker`'s handler (jobs.ts:253-254, BOTH
     queues) calls `runPrefillJob(job.data, job.retryCount ?? 0, job.id)` (jobs.ts:260). The
     statement and the requeue are ONE function, `prefill-queue.ts` `settlePass(requestId:
     string, jobId: string): Promise<void>`, imported dynamically like `./say-once`, inside its
     own try/catch that logs `[calc-prefill] settle failed` and never rethrows (the worker's
     rule, calc-prefill-wire.test.ts:220-229). intake-corpus.test.ts and
     calc-prefill-standdown.test.ts run the real jobs.ts with job id `'j1'`, so both mock it
     (`settlePass: vi.fn()`); unmocked, a non-uuid `ai_pass_job` would reach the database
     from a unit test. (re-check p5-p6-5)
   - **The settle stamps nothing** (durability-6). The first draft stamped `handsoff_rev`
     only here, from an in-memory `track`. A pass killed mid-way runs no `finally`, so its own
     committed saves had moved `rev` with no stamp behind them. The request then read
     «started» for ever, every later addition went to the VED as text, and «➕» opened with
     «VED ishlayapti» about a person who never touched the job. The stamp now moves inside
     each save (rule 3), so a kill leaves it at the last committed write.
   - A pass queued before this deploy (no ticket) settles nothing; its request reads
     `started` (§0.1(1)).
3. **Every machine save stamps itself** (law-money-2, durability-6).
   - R2's late pass (P1-R2) already starts the chain at `data.rev` (jobs.ts:294-295) and puts
     the claim (workspace.ts:2975), `applyProposal` (:1681),
     `pullRatesFromDictionary`/`setGroupRates`/`mutateRequest` (:3602) and
     `priceProposedGroups`' `saveTable` (:4325) under `expectRev`; `proposeGroups` already
     returns its own last `rev`. P5 keeps the name `expectRev` and deletes only the two null
     fallbacks — `?? (await prefillTicket(requestId))` (prefill.ts:327) and
     `rev === null ? await prefillTicket(requestId) : rev` (:411) — so a job with no ticket rev
     runs with no chain and moves no stamp. Its one new thing is `handsOff: true` beside every
     `expectRev` the chain passes (step 1: `{ expectRev: rev, handsOff: true }` to
     `proposeGroups`, prefill.ts:399). `prefillTicket` stays exported
     (calc-prefill-once.integration.test.ts:39, calc-prefill.integration.test.ts:33).
     (re-check p5-p6-2)
   - Steps 0, 2 and 3 (`applyMemory`, the sweep `saveTable`, `pickBazas`) pass
     `handsOff: true` beside the `expectRev` they already carry (prefill-steps.ts `casOf`, :51;
     prefill.ts:435).
   - Each such save runs `advanceHandsOffInTx(tx, id, expectRev, newRev)` in its own
     transaction. The stamp moves only while it equals the revision the save expected, which
     the save's own lock proved equal to `rev`.
   - R2's `attemptStanding` is unchanged: a redelivered pass whose own writes moved `rev`
     stands down as `unfinished` (one paid call, not two). Its settle clears the ticket, and
     the stamp, already correct, lets «➕» open `open`.
4. **One machine message per PASS** (re-anchors R2's `sayOnce`; the seam is K's, K15):
   ```ts
   export async function sayOnce(requestId: string, pass: string, input: StaffTelegramInput, opts: { whileOpen?: boolean; direct?: boolean } = {}): Promise<boolean>;
   ```
   (re-check p5-p6-1)
   - `claimed()`'s WHERE gains `sql\`coalesce(${notifications}.payload->>'pass', 'landing') =
     ${pass}\`` beside `payload->>'requestId'` — one closure, so both of its reads carry it.
     `extra` becomes `{ ...(input.extra ?? {}), requestId, pass }`, so the queued rows AND the
     CONC-4 `muted / cannot log in` holder row carry the pass. The advisory lock, the
     `requested_at - 1 day` floor (perf-5) and `whileOpen` (CONC-1: the reply at jobs.ts:309
     keeps `{ whileOpen: true }`) are unchanged. `direct` only for an `amend:*` pass (rule 5).
   - `const pass = data.pass ?? 'landing';` at the top of `runPrefillJob`; the five sites K
     wrote with `'landing'` (jobs.ts:277, :302, :309, :315, :353) read `sayOnce(requestId,
     pass, {`, each with its `extra: { add }` (rule 5).
   - A redelivery is the same pass and stays silent. A re-run after an addition is a new
     pass and speaks. R2's «every request is queued exactly once» (say-once.ts:21) is no
     longer true: the add door queues again, and the key says so.
5. **Which machine messages carry ➕**:
   `addFor(standing: StandDown | 'ok'): boolean = standing !== 'closed' && standing !== 'not_found'`.
   - Each of the five `sayOnce` sites passes `extra: { add: addFor(…) }` — `standing` at :277,
     `out.stood` at :302, `'ok'` for the reply (:309) and the failure (:353), `'closed'` at
     :315. So the reply, `PASS_FAILED`,
     `TARIFF_PASS_FAILED` (= `TARIFF_STOOD_DOWN.unfinished`, jobs.ts:166), `STOOD_DOWN.touched`,
     `.confirmed` and `.unfinished` carry `add: true`. `closed` carries no ➕: `STOOD_DOWN.closed`,
     `TARIFF_STOOD_DOWN.closed` and the withheld-reply closed sentence at :315. (re-check
     p5-p6-18)
   - `buttonsFor('CalcPrefilled', payload)` draws
     `[[{ text: '➕ Shu so‘rovga qo‘shish', callback_data: \`ca:${payload.requestId}\` }]]`
     only when `payload.add === true` and `payload.requestId` is a uuid (staff-bot.ts's `UUID`).
   - A muted seller gets no AI answer and so no ➕ there. The ✅'s ➕ is his door (stated, R2's
     mute rule unchanged) — EXCEPT for a re-run he started himself (⭐ of Question 7,
     product-fit-15). For `pass = 'amend:<id>'`, `sayOnce(…, { direct: true })`: the claim
     row for a seller who muted «✅ Mening vazifalarim» (the `tasks` group, where
     `CalcPrefilled` lives, mutes.ts:42-50) is queued `pending` with `direct: true` instead of
     `muted` — `sayOnce` passes `ignoreMute: true` to `queueStaffTelegram` (K15; mutes are
     decided there at QUEUE time, staff.ts:37-60, and there is no `mutedFor`) — and the DRAIN
     sends it — its 429/botDown pauses kept, its `payload.tg` written as for every sent row —
     so it is one message, never two, and a reply to it reaches the reply door like any sent
     ping (no reply-door change). Every other machine message keeps his mute. Under 7 b,
     `direct` is never set, and §2.4's `applied` words take their muted form. (re-check
     p5-p6-8)
6. **The 2.8 b block** (§2.5). `law-asks.ts`:
   ```ts
   export interface LawAsk { itemId: string; seq: number; name: string; needs: RowNeed[] }
   /** The rows a stored request owes a figure the LAW pins (not the one-measure rule): the
    * ⚠️ rows of the add table that are law-pinned, outside ✅'d groups, in seq order. */
   export function lawAsksOf(stored: { section: CalcSection; facts: CalcFacts; bookLaws: ReadonlyMap<string, NeedLaw>;
     confirmedSeqs: ReadonlySet<number> }): LawAsk[];
   ```
   - Built on `lineNeeds` over `storedRequestFacts` — the SAME function the add table reads,
     so the ask and the table cannot disagree. P4's `pressAdd` asks it too, for the rows an
     unaddressed answer goes to (§9.2).
   - **His 1.14 a (2026-10-27): every unit the law pins is asked** — dona, 1000_dona, juft,
     and kg, m², litr when the law's floor or excise is in that unit. No unit filter: the ask
     is `lineNeeds`' own law-pinned set, so the ask and the VED's chips cannot disagree.
     (The draft's ⭐ b would have filtered to dona/1000_dona/juft through a `LAW_ASK_UNITS`
     constant; that constant is not built.)
   - `aiPrefill` computes it only for a customs part, when `!overtaken` and the request's
     `handsoff_rev = rev` (read with the final workspace: a person has not been here).
     Otherwise `asks: null`. Its input comes from the `ws` `aiPrefill` already loaded, through
     the pure `lawAsksInputOf(ws)` — never a second `storedRequestFacts` / `loadWorkspace`
     read (performance-9). `pressAdd` and the add table build the same input from
     `storedRequestFacts` (≤ 4 statements, K14); a test pins that both adapters give
     `lawAsksOf` the same rows for one request.
   - `lawAsksInputOf(ws)` returns null when `ws.handsoffRev !== ws.rev` (K1: `Workspace` gains
     `handsoffRev`, read by `loadWorkspace`'s first query beside `rev`, no extra statement).
     Its `bookLaws` is empty: after the step-2 sweep every coded row sits in a group, so an
     ungrouped row has no code and no law (a sweep that failed leaves a coded row un-asked —
     under-asking, never a wrong ask). Like `storedRequestFacts` (K14) and `lineNeedsFor`
     (service.ts:1577) it sets R2's regression-3 flags `lineWeightsStated` and `totalsStored`,
     so neither adapter derives a lone weight or a Σ the stored rows do not hold. (re-check
     p5-p6-12)
   - `AiVedReplyInput` (ai-reply.ts:136) gains `asks: LawAsk[] | null` and
     `pass: 'landing' | 'amend'`; `TariffReplyInput` (prefill-reply.ts:153) gains `pass`.
   - The block goes in `fixed` (chat) or the one VED line (lenta). Rows are numbered by `seq`.
7. **`requestAsks`** (the card form's «Yuborildi. VED so‘raydi: …», service.ts:1592, one
   caller, actions.ts:293) is rebuilt on `storedRequestFacts`, so a GROUPED row answers to its
   group's law (judge S9) — the rule `checklistFor` (service.ts:1658), the VED's chips and the
   add table already follow — and the stored request has one reader (#513). It used to read
   the book only. The card form calls it right after `openCalcRequest`, before anything is
   grouped, so that ✅ reads exactly as before; the rebuild shows on a later call and in
   `pressAdd` and the add table, which read the same function. (re-check p5-p6-13)
8. **The seller's tails** (§2.5): `FREIGHT_TAIL_WORDS: Record<FreightTail, Record<'chat' |
   'lenta', string>>` (ai-reply.ts:289); `CUSTOMS_TAIL_WORDS.seller` (:300-301) follows it;
   `roadRefusalLine(f, audience)` (:317) and `lineText(line, index, audience)` (:413 — it is
   `input.lines.map`'s callback, so the map passes the audience) take the audience
   (`tariffReplyText` passes it too, prefill-reply.ts:184); `TAXMINIY_BLOCK_WORDS.refused_measure`
   (estimate.ts:279) becomes `{ chat, lenta }`; prefill.ts `blockWords(block, audience)` (:643) /
   `totalsWords(e, audience)` (:653) receive it from `reply(link, audience)`. (re-check
   p5-p6-9)
9. **Freight is not priced on a stale total** (law-money-1). `aiPrefill`'s `opts` gains
   `pass?: string` (absent = `'landing'`); jobs.ts passes `{ ...expected, pass }`. For
   `pass = 'amend:<id>'`, `aiPrefill` reads that amendment's `change.totalsStale`. When the
   section prices the road and a total it needs is stale, the reply's freight line is §2.5's
   «yangilanmagan» words, in both renderings — and so is `tariffOnly`'s (prefill.ts:592,
   handed the pass), which prices a yolkira road from the STORED totals through `roadOf(ws)`
   and reads no amendment today: the section that is ONLY the road. The figure from the stale
   column is never printed. (re-check p5-p6-11)
10. **The re-run's heading** is §2.5's: `RERUN_WORD` (reply-heads.ts) after the title phrase,
   never between `TARIFF_REPLY_TITLE` and `· taxminiy`, so every heading still starts with
   `MACHINE_REPLY_HEADS[kind]`, a priced tariff re-run with `TARIFF_PRICED_HEAD`, and R2's
   lenta chip (feed.ts:243-244, PF-9) classifies it unchanged. (re-check p5-p6-10)

### 10.3 Tests (P5)
**`law-asks.test.ts`** (pure; the scout's probe, literals by hand):

| Row | Law / basis | Expected |
|---|---|---|
| Kurtka | per-kg import baza, «kamida $3/dona» | dona |
| Kafel | m² law, the row states only kg | m² (his 1.14 a) |
| Krossovka | juft law, no baza | juft, once |
| Sumka | advalor | none |
| Ko‘ylak | lgota | none |
| Shim | count given | none |
| a yolkira job | — | `[]` |

- a grouped row whose group law differs from the book → the group's (S9).
  **Red proof:** read the book only → the grouped row is asked wrongly;
- a row in a ✅'d group → none;
- numbered by `seq` after a deletion (seq 1, 3, 4);
- `lawAsksInputOf(ws)` and the `storedRequestFacts` adapter → the same `LawAsk[]` for one
  stored request (performance-9);
- `lawAsksInputOf(ws)` with `ws.handsoffRev !== ws.rev` → null (p5-p6-12).
  **Red proof:** filter the asks to dona/1000_dona/juft → Kafel loses its m² ask (his 1.14 a).

**`calc-pass-settle.integration.test.ts`**:
- a customs pass that finishes → `handsoff_rev = rev` (every machine save stamped), `ai_pass_*`
  NULL;
- a person's save mid-pass → `overtaken`, `handsoff_rev` stays behind `rev`.
  **Red proof:** advance the stamp without `WHERE handsoff_rev = $from` → the stamp claims the
  person's write;
- a pass KILLED after its memory save (no `finally` runs; the job then reads `failed`) →
  `handsoff_rev` = the memory save's `rev`; `ticketStanding` clears the dead ticket;
  `amendStanding` → `open` (durability-6).
  **Red proof:** stamp in the settle only (the first draft) → `started`;
- law-money-2 (a) and (b) are already pinned by R2's P1-R2 cases in
  `calc-prefill.integration.test.ts` — :463 (a VED save after the job's check is never grouped
  over) and :750 (the grouping's claim at a stale revision is `conflict`, writes nothing).
  P5 extends each to also assert `handsoff_rev` did not move (re-check p5-p6-3).
  **Red proofs:** (a) start the chain from a fresh `prefillTicket` read instead of
  `expectRev` → :463's grouping runs over the person's save; (b) drop BOTH the claim's `rev`
  clause (workspace.ts:2975) and `applyProposal`'s compare (:1681) → :750's stale
  `proposeGroups` writes over the VED's save. Dropping the claim's clause alone stays green —
  `applyProposal`'s compare and `stillOurs` (prefill.ts:361-367) still refuse — stated;
- a tariff pass → the stamp is unchanged (it writes nothing);
- the ticket: an enqueue that throws → cleared, `false`; `atRev` ≠ `rev` → no row, `false`; a
  live ticket → a second `queueCalcPrefill` enqueues nothing and answers `true`; a dead ticket
  → cleared and the new one taken;
- the routing, moved from calc-prefill-wire (:86-111): a yolkira job → `calc.tariff-reply`
  with `TARIFF_EXPIRE_S`; rastamojka, podklyuch and a null section → `calc.prefill` with
  `PASS_EXPIRE_S`; payload `{ requestId, staffId, rev, section, pass }`, options
  `{ id, expireInSeconds }` (p5-p6-7);
- a cut-off landing: land, delete the pg-boss job before the queue call (a simulated cut),
  re-run `landIntake` with the same note → exactly one `calc.prefill` job; a second press
  while that pass stands → still one (p5-p6-6); the same through `threadCalcSend` from a
  CLIENT (the root branch) → exactly one job; from a DEAL card a resend after the commit →
  `note_taken`, no second request and no second job (the stated cut, §15) (re-check v3-0);
- a landing pass then an amend pass → TWO `CalcPrefilled` rows; the amend job redelivered →
  still two.
  **Red proof:** drop the `pass` clause → the amend reply is silenced;
- an `amend:*` pass whose request closed mid-run sends no reply (`whileOpen` kept);
- the settle enqueues the request's `'waiting'` amendments.
- an amend pass with `totalsStale: ['volumeM3']` on a podklyuch request → the reply's freight
  line is the «yangilanmagan» words, no dollar figure; the same on a YOLKIRA request → the
  tariff reply carries no dollar figure (p5-p6-11).
  **Red proof:** `tariffOnly` ignores the pass → a dollar road on the stale cube;
- a muted seller (moved here from calc-add-buttons: it needs the drain): his `amend:*` reply
  is ONE `pending` row with `direct: true`; the drain sends it and writes `payload.tg`; a reply
  «2: 40 juft» to it opens the add collection and the assistant spy is never called; a
  `landing` pass for the same seller → one `muted` row, nothing sent (R2's rule)
  (product-fit-15, p5-p6-8).
  **Red proof:** drop `ignoreMute` from sayOnce's queue call → the row is `muted` and nothing
  is sent;
- a priced `amend:*` tariff note on the lenta still wears the 'tariff' chip (feed.ts:244); an
  `amend:*` AI note the 'ai' chip (:243) (p5-p6-10).
  **Red proof:** put `· qayta hisob` before `· taxminiy` → the tariff chip is lost.

**`handsoff-writers.test.ts`** (derived, source shape with TypeScript's parser, comments
stripped — #725):
- every write of `handsoffRev` / `handsoff_rev` in `src/` is one of exactly two:
  `openCalcRequest`'s INSERT (`0`) and `advanceHandsOffInTx`;
- `handsoffRev: 0` sits in openCalcRequest's INSERT (service.ts:493) after Uch band's lead
  lock and rota pick, and recalcFromSealed's INSERT (workspace.ts:2568) writes no
  `handsoffRev` (a correction reads «started») (re-check p5-p6-19);
- `advanceHandsOffInTx` is called only from the save primitives (`saveTable`,
  `mutateRequest`, `applyProposal`) under `handsOff`;
- `handsOff: true` is passed only from `prefill.ts`, `prefill-steps.ts`, `proposeGroups`'
  chain and `amend.ts`. A fourth writer (a screen door stamping «hands off») would let a
  person's write read as the machine's.
- **Red proof:** add `handsOff: true` to the VED page's `saveTableAction` → the fence names the
  file.

**`calc-add-buttons.test.ts`**:
- `buttonsFor('CalcPrefilled', { requestId, add: true })` → one ➕ button whose
  `callback_data` `parseCallback` accepts;
- without `add`, or without a uuid `requestId` → null;
- `addFor('closed')` and `addFor('not_found')` false, every other (`touched`, `confirmed`,
  `unfinished`, `'ok'`) true (re-check v3-2);
- the asks block survives `fitTelegram` on a 40-line reply (`fixed`).
  **Red proof:** put it in `lines` → it is cut;
- the asks block is absent when `handsoff_rev !== rev` at the reply;
- the chat tails read «— mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring» on the
  road, a customs line and `refused_measure`; the lenta keeps «kartadagi lentaga yozing»
  (p5-p6-9).
- The muted seller's re-run is pinned in `calc-pass-settle.integration` (it needs the drain).

---

## 10A. P6 «Ko‘rdim» — the VED's doors see a seller's addition (law-money-3)

The add door is a new writer on open requests. It writes for as long as the VED has not saved:
⭐ Q2 a, so opening the page or composing the «Готово» fold does not count as «started». None
of the VED's official doors compared the revision its screen was drawn at:
- «Готово» (`finishCalcRequest`) checks no `rev` at all. It is the only close on exactly the
  jobs where 2.8 b asks a count (no customs total, so `canSeal` is false);
- `confirmGroup` / `confirmAllGroups` compute `warnings.rev` at PRESS time;
- the seal compares its own press-time compute.

So a seller's «2: 40 juft», and the re-pass behind it, could land between the VED's page load
and the press. The official answer then priced goods the VED never saw. That answer is the
upsale floor, the card's lock, the price channel's post and the CalcDone push. And a ✅ blessed
seller-written figures as «what stood on the screen».

### 10A.1 Files OWNED
- new `src/modules/wms/calc/amended-since.ts`;
- `workspace.ts`: the `confirmGroup` (:1502), `confirmAllGroups` (:1550) and `sealCalc`
  (:1835, `SealInput` :1811) hunks (K15's hunks are elsewhere in the file);
- `service.ts`: the `endRequest` (:731) and `finishCalcRequest` (:905) hunks, and
  `CalcRequestDetail` gaining `rev` (`calcRequestDetail`'s `findFirst` already reads it,
  :1686; re-check v3-4) (P5 holds `requestAsks`, K holds `openCalcRequest`);
- `src/app/(protected)/hisoblash/actions.ts` (`finishCalcAction` :180, `confirmGroupAction`
  :559, `confirmAllAction` :568, `sealAction` :598) and the five call sites that press the four
  doors — none is a form post (re-check p5-p6-15): `[id]/items-table.tsx:1900`
  («✅ Hammasini»), `:2923` (the group ✅), `[id]/phone-blocks.tsx:180` (the phone's ✅),
  `[id]/calc-workspace.tsx:637` («Muhrlash» — one `SealPanel` for phone and desktop),
  `[id]/calc-actions.tsx:246` (the «Готово» fold); and `[id]/page.tsx:575-580`, where
  `CalcActions` gets `sawRev`;
- `messages/{ru,uz,zh-CN,en}.json`: one key.
- Tests: new `amended-since.integration.test.ts`, `amended-since-wire.test.ts`. Re-anchored:
  the ~160 calls of the four doors in 31 test files pass the request's live rev (each is a
  compile error until it does, rule 3).

### 10A.2 Rules
1. **One predicate**, `amended-since.ts`:
   ```ts
   import type { Tx } from '../../platform/db/client';
   export function amendedSinceSql(requestId: string, sawRev: number): SQL;   // EXISTS over calc_amendments
   export async function refuseIfAmendedSinceInTx(tx: Tx, requestId: string, sawRev: number): Promise<void>;
   ```
   `EXISTS (SELECT 1 FROM calc_amendments WHERE request_id = $id AND outcome = 'applied' AND rev > $sawRev)`
   → `CalcError('amended_since')`. It reads through `tx` only (#714), inside the door's own
   lock, after the lock and before any write: right after `lockRequestInTx` in `sealCalc`
   (workspace.ts:2021), first inside `mutateRequest`'s fn in `confirmGroup` (:1522) and
   `confirmAllGroups` (:1556). (`TxHandle` is workspace.ts's private alias, :3520; `Tx` is the
   exported one.) (re-check p5-p6-20)
   - **«Готово» has no transaction** (re-check p5-p6-14). `finishCalcRequest` reads on the
     pool and ends through `endRequest`, one bare `UPDATE … WHERE id = $id AND completed_at IS
     NULL` (`openRequests`, service.ts:749-762), so a check written before it races exactly
     the addition P6 exists for. `endRequest`'s patch gains `notAmendedSince?: number`, which
     ANDs `NOT ${amendedSinceSql(id, sawRev)}` into that UPDATE's WHERE. Zero rows (:972) →
     re-read the request: completed → `already_closed`, otherwise
     `new CalcError('amended_since')`. Only `finishCalcRequest` passes it; `returnCalcRequest`
     and the task/lines closes do not. The task close, `retireTaskCopiesSoon` and
     `kickPriceChannel` stay after the UPDATE, on the pool (#714).
2. **Keyed on `calc_amendments`, not on any `rev` move**, so the VED's own saves (and the
   machine's) never trip it. Only a seller's APPLIED addition does. A `to_ved`, `noted` or
   `waiting` row changed no row, so it trips nothing.
3. **`sawRev` is a REQUIRED argument** of the four doors (`number` — never optional, never
   null). An optional one fails open (the phase-C lesson, #790), and making it required turns
   every caller into a compile error that names itself.
   - It travels as an ARGUMENT, because none of the four buttons is a form post (re-check
     p5-p6-15): `confirmGroupAction(id, groupId, via, sawRev)` → `confirmGroup(groupId, ctx,
     via, sawRev)`; `confirmAllAction(id, sawRev)` → `confirmAllGroups(requestId, ctx,
     sawRev)`; `sealAction(id, { …, sawRev })` with `SealInput.sawRev: number` REQUIRED
     (unlike `sawFeeUsd`); `finishCalcAction(id, answer, revalidate, sawRev)` →
     `finishCalcRequest(id, answer, ctx, sawRev)`. The four workspace call sites pass `workspace.rev`, calc-actions.tsx:246 its `sawRev` prop
     (re-check v3-4);
     page.tsx passes `sawRev={workspace?.rev ?? row.rev}` to `CalcActions` (a server-behind
     page has no workspace, so the row's own clock, §10A.1).
   - A page from an old build cannot call the new build's actions at all (server action ids
     are per build), so there is no «posted none» case to read.
   - No door without a screen calls these four: each has one caller (actions.ts:188, :565,
     :569, :613). `completeCalcForTask` (an unbound task — a bound calc job's task has no ✅,
     task-gate.ts) and `returnCalcRequest` (a hand-back) close without a price and are outside
     P6, stated. (re-check p5-p6-16)
4. **The words** — `calc.errors.amended_since`, in all four bundles:
   - uz: `Sotuvchi qo‘shimcha yubordi — sahifani yangilang, o‘zgarish «Savol-javob» da yozilgan.`
   - ru: `Продавец прислал дополнение — обновите страницу, изменение записано в «Вопрос-ответ».`
   - en: `The seller sent an addition — reload the page; the change is written in the Q&A thread.`
   - zh-CN: `销售员发送了补充——请刷新页面，变更已写在问答中。`
   The refusal changes nothing. The reloaded page shows the rows as written and the thread
   message with the change lines.

### 10A.3 Tests (P6)
**`amended-since.integration.test.ts`**:
- a load at rev N, an amendment applied at N+1, then «Готово» with `sawRev` N → refused,
  nothing ended, no CalcDone;
- the same for `confirmGroup`, `confirmAllGroups` and the seal;
- `sawRev` = the current rev → passes;
- a VED save after the load (rev moves, no amendment) → passes;
- a `to_ved` amendment after the load → passes;
- «Готово» with an amendment applied AFTER its pooled reads and before `endRequest`'s UPDATE
  → refused by the UPDATE's own WHERE, the request still open; closed meanwhile →
  `already_closed`.
- **Red proof:** drop `notAmendedSince` from `finishCalcRequest`'s `endRequest` call → the job
  closes over goods the VED never saw.

**`amended-since-wire.test.ts`** (source shape):
- the three locked doors call `refuseIfAmendedSinceInTx` inside their lock;
  `finishCalcRequest` passes `notAmendedSince` to `endRequest`;
- `sawRev` is not optional in their signatures, nor in `SealInput`;
- each of the five call sites passes a rev argument, and page.tsx passes `sawRev` to
  `CalcActions`.
- `calc-error-words.test.ts` sees `amended_since` once amended-since.ts and service.ts throw
  it literally (`new CalcError('amended_since')`, never through a variable) and requires its
  sentence in all four bundles' `calc.errors` (absent from all four today; `i18n-keys.test.ts`
  checks only literal `t('…')` keys and cannot see a runtime `errors.${code}`). Any other new
  `CalcError` code R3 throws under wms/calc needs its sentence ×4 too. **Red proof:** drop it
  from `zh-CN.json` → `zh-CN has a sentence for every CalcError code` is red. (re-check
  p5-p6-17)

---

## 11. The regression corpus and every re-anchored test

`tests/unit/intake-corpus.test.ts` stays green on the merge. Nothing is weakened silently;
every change is below with its reason.

**Mechanical (K):**
- every drive calling `readIntakeFile` gains `attachmentId`;
- `receivePdf` drives pass `{ attachmentId, name, bytes }`;
- `startIntake(…, { staffId })` in all thirteen files that call it (calc-intake.ts:1383 today
  takes `opts: { ai?: boolean }`): `ai-rastamojka-bot.test.ts` (its two source literals,
  :66-67), `intake-collected-goods`, `intake-collector`, `intake-collector-r3`,
  `intake-collector-r4`, `intake-confirm`, `intake-corpus` (the `collection()` helper, :216),
  `intake-customer-name`, `intake-own-budget`, `intake-round1`, `totals-question`,
  `calc-kiritish.integration` (×2), `intake-usage.integration` (re-check corpus-mig-seam-16);
- the moved functions import through the re-exports.
- No `said` changes. The affected cases include c0016, c0017, c0524, c0775, c0785,
  c1338-c1343 and c1882-c1891 (re-check corpus-mig-seam-15).

**Still true, drive re-pointed:**
- **c0011, c0773** (`settleAnalysis`): unchanged expectation. The fixtures' `lineDone` input
  field becomes inert.
- **c0018, c0019, c0020, c0783, c0784** (⏭ refused): still «Bu tugma eskirgan». The step is
  retired, so it is now refused everywhere. c0020's fixture stage `'question'` is a dead
  value, and the expectation holds.
- **c0234** (no 🔄 on a `truncated` failure): `reviewKeyboard`'s rule is unchanged; the drive
  reaches the table through the job helper and reads its keyboard.
- **c1892, c1893** (the summary's «Faqat Excel…» and the notes on their own lines): the same
  assertions on `intakeTableText`'s tail, reached through the job helper; their state
  fixtures' `pdfs: [{ data: Buffer }]` become `{ attachmentId, name, bytes }` (K4).
- **c0012** (a refused «⏳» notice never strands the lock): the drive mocks `enqueue` and runs
  `runIntakeRead` between presses. The `said` («never «Tahlil davom etmoqda» for ever»)
  holds: the job releases or settles the token.
- **c0774** («analysing back to null; stage review; the summary sent»): the drive runs the
  job. «The summary» is the table; the same three facts are asserted.

**Changed by his 1.10 c, each named:**
- **c0021** (⏭ on an open line → `lineDone` + next line): retired; now «Bu tugma eskirgan».
  The table has no per-line skip; a line left ⚠️ at «Tasdiqlash» is the VED's.
- **c0803** (⏭ under the podklyuch totals question accepted): retired. The totals are a
  table row.
- **c0797, c1375, c1376, c1721, c1722** («a skipped line is never asked again», across
  re-reads that reorder or drop lines): the defect each pinned — a record carried by index
  onto another line after a re-read — is re-anchored onto ANSWERS. The same fixtures and
  re-reads, with the skip replaced by an answer, assert the answer lands on its own line
  after the reorder, survives a reading without the line, and comes back with it.
  `placeByName` is the rule under test.
- **c1377** (a ⏭ at the round cap reaches review): retired with `MAX_QUESTION_ROUNDS`.
  Nothing replaces it: the table has no rounds.
- **`resolveLineDoneCases`** (c0798, c1374, c1719, c1720): the same four inputs and expected
  placements, run through `placeByName` (entries without patches). The subject moved; the
  cases did not change.

**The reading is a job (P2, regression-10).** Every drive that presses «Bo‘ldi» and then
waits for the reading's result would time out, because the press only enqueues; an unmocked
`enqueue` would also reach `ensureListening()` / `boss.start` against the test database. Each
uses P2's ONE helper (`tests/fixtures/calc-read-drive.ts`, beside `source-shape.ts` — there is
no tests/unit/helpers/: `enqueue` mocked, then `driveReading(chatId)` = `runIntakeRead` with
the captured payload; re-check kernel-20). The subject moved; no expectation changes:
- corpus c0012, c0234, c0599, c0774, c1722, c1892, c1893;
- the `skipThenReread` helper (c1375, c1721), whose skip half is re-anchored onto answers
  (below) and whose re-read half goes through the job;
- `intake-collector-r3.test.ts:334`, `intake-collector-r4.test.ts:209`;
- `totals-question.test.ts`'s `pressDone` (:108-114, six callers) → `driveReading` (re-check
  p1-p2-20);
- whatever else K16's grep finds pressing `'done'` then waiting for `stage: 'review'` or
  `analysing: null`.
They stay as they are: corpus c0016, c0769, c0775 and `intake-collector.test.ts:183` press
«Bo‘ldi» but a guard answers before any enqueue (re-check p1-p2-20).

**Fixtures in the retired shapes (K, regression-9):**
- state fixtures with `pdfs: [{ data: Buffer, name }]` / `images: [{ data, mediaType }]` —
  `intake-collector-r3.test.ts:157`, `intake-collector-r4.test.ts:205`,
  `intake-corpus.test.ts:939` (c0017), `:1868` (c1892), `:1882` (c1893) — become
  `{ attachmentId, name, bytes }` / `{ attachmentId, mediaType }`, the file content moving to
  the storage the job reads; the `receivePdf` drives (:925 c0016, :1433, :1627, :1641) are
  K's mechanical change above (re-check corpus-mig-seam-15);
- fixtures carrying `stage: 'question'`, `askingIndex`, `round` or `lineDone`
  (`intake-collector.test.ts:140`, `:227-234`; c0020; c5 «nor while an analysis runs», which
  expects stage `'question'`) drop the retired fields; c5's expectation becomes «the stage is
  unchanged while an analysis runs» (`review`), the claim it pinned; c0006's
  `invoiceChoice(invoiceState('question'), 'inv_add')` (:826) becomes `invoiceState('review')`,
  its claim (inv_add moves to `'material'`, `reask` null) unchanged — `pnpm typecheck`
  refuses the old literal once P3 drops `'question'` (re-check corpus-mig-seam-15);
- the C9 / R3-C3 summary drives (`intake-collector.test.ts:384-398`) reached the summary only
  through `handleCalcCallback(…, 'skip')`, which P3 makes «eskirgan»: they reach the table
  through the job helper instead, and keep their `Mijoz:` assertions.

**Worker cases (R2 P1's re-anchors), K then P5:** K changes `sayOnce` to
`sayOnce(requestId: string, pass: string, input: StaffTelegramInput, opts: { whileOpen?: boolean;
direct?: boolean } = {})` (K15; today `sayOnce(requestId, input, opts: { whileOpen?: boolean } =
{})`, say-once.ts:48) and passes `'landing'` at jobs.ts:277, :302, :309, :315, :353, so K16
re-anchors: c0220 reads `call[2].text` and keeps `toEqual([PASS_FAILED])`; c0221 becomes
`toHaveBeenCalledWith('r1', 'landing', expect.objectContaining({ text: STOOD_DOWN.touched }))`;
c0789's pin on `const said = standDownWords(standing, writes);` (jobs.ts:276) and c0804 are
unchanged. P5: their jobs carry no `pass`, so K's `'landing'` stays; the file mocks
`@/modules/wms/calc/prefill-queue` (`settlePass: vi.fn()`) beside `./say-once` (F rule 2).
(re-check corpus-mig-seam-2)

**Other tests:**

| Test | Package | Change and reason |
|---|---|---|
| `intake-questions.test.ts` `nextLineToAsk` | P3 | Re-anchored to `lineNeeds` + the table's ⚠️ marks (same rows). «walks past every row already dealt with — answered OR skipped» keeps its answered half; the skipped half is retired (1.10 c). «the words» moves to the table's ↳. |
| `intake-collector.test.ts` «a stale ⏭ moves nothing (c5)» | P3 | Holds (⏭ is refused everywhere). |
| `intake-collector.test.ts` «a line passed with ⏭ is never asked again (C10)» | P3 | Re-anchored to answers across «➕ Yana ma’lumot» (as c1376). |
| `intake-collector.test.ts` «a refused «⏳» notice cannot strand the lock (c3)» | P2 | The press releases the token on an enqueue failure; the notice failure is caught as before. |
| `intake-collector-r3.test.ts` «a line passed with ⏭ stays passed across a re-read (R3-C5)» | P3 | Re-anchored onto `placeByName` (the resolver's rule, same cases). |
| `intake-collector*.test.ts` summary blocks (C9, R3-C3) | P3 | The table's `Mijoz:` line carries the same text. |
| `calc-intake-lines.test.ts` | K + P3 | Reads `collectorSource()`. The merge-on-the-analysis-path pin reads `placeByName`. |
| `calc-kiritish.integration` «➕ Yana ma’lumot keeps the per-line answers (P1.3)» | P3 | Re-anchored: the fixture's `lineDone` (:265-268) goes and the import (:18) loses `resolveLineDone`; the second expectation (:276) runs through `placeByName` over the same answers (Plitka → index 1, Kurtka → index 0); the first (the answers back on their lines after a reorder) holds unchanged (re-check corpus-mig-seam-14). Its `requestAsks` case (:181) is P5's (F §10.1). |
| `bot-ai-dispatch.test.ts` analysis half | P2 | «dispatches the analysis off the middleware chain» becomes «the press enqueues `JOB_CALC_INTAKE_READ` and calls no model». |
| R2's `totals-question.test.ts` | P3 (`pressDone`: P2) | R2's `totalsQuestion` is retired (§8.2 rule 1): an unaddressed bare figure goes to the single open totals target by its own unit, on every section, and WHICH totals rows are ⚠️ is `missingFields` minus `LINE_FIELDS` (regression-22). So `:130` («every freight section asks, on every door; rastamojka never does»; `:110` is now inside `pressDone`) is re-anchored to «rastamojka's ⚠️ totals are `missingFields` minus `LINE_FIELDS`» — brutto and m³ ⚠️ when absent, MR-9's rule (re-check corpus-mig-seam-11, p3-5). The question-stage drives become table drives: a bare «3500» with only the weight row ⚠️ → kg; «jami 3500». `:342` (the cube typed two ways) moves to `intakeTableText`: its ⚠️ row, never «to‘liq» (re-check corpus-mig-seam-13). The late-pass blocks keep their rules, re-driven through the table: CONC-2 (:373-515) — a table answer carries R2's `at` mark, `totalsDoubts` stays the one rule and the table reads it; answer «jami 3500 kg», then ➕ and a FORWARDED «brutto 4200 kg» (typed, it is a totals address and a new answer, §8.2 rule 5), «Bo‘ldi» → ⚠️ with both figures, never 3500 in silence (re-check corpus-mig-seam-11, p3-3, v2-4); P3-R7 (:201). The concurrency-5 block (:516-615) is re-anchored onto `orphanAnswerSentence`: :575 asserts §2.8's new sentence for a WORDED figure (it asserted `LOST_TOTALS_ANSWER`, the one sentence P3 retires); :536, :549, :562 keep their gates (`messageId !== null`, Door B's replay, `waitDeclined`) and their `not.toContain`, re-pointed at §2.8's sentence (`LOST_TOTALS_ANSWER` and its import retire; re-check v2-3); REG-3 stays — :586 keeps `BARE_FIGURE_NOT_FOUND` for a BARE figure («777», «150», «12», «3500») unchanged, its «never «to‘plam topilmadi»» becoming «never «Ochiq hisoblatish yo‘q»»; :602 (the worded/bare shape test) is unchanged, calc-intake.ts re-exporting `totalsAnswerShape` from `totals-shape.ts`; :608 (other words reach the assistant) holds (re-check corpus-mig-seam-12). `pressDone` (:108-114) drives the job (P2, above). |
| R2's `intake-usage.integration.test.ts` and `intake-own-budget.test.ts` | P2 | Reason: the ledger now holds a collection's readings from the moment the model answered, so R2's concurrency-11 subtraction (`aiCalcBudgetLeft() - state.usages.length`, calc-intake.ts:1483) and its append (:1571) go in the same commit, or every reading counts twice (§7.2.10). intake-usage: :177 → «billed by the job on the day the model answered (`createdAt = at`, concurrency-11's day kept), on the note anchor, then attached»; :191 «a bill that cannot be written costs that row alone …» → «a failing attach never skips the queue»; :156 and :186 hold, driven through the job. intake-own-budget: «two unlanded readings spend the last two calls» → «a collection with one billed reading and the ledger saying 1 left reads once more»; **red proof:** restore the subtraction → refused `'budget'` (re-check corpus-mig-seam-10). |
| R2's `calc-prefill-once.integration.test.ts` | K + P5 | K: the three direct `sayOnce` calls take `'landing'` (the three worker-driven tests are unchanged; re-check v3-3); CONC-1 (`whileOpen`, :210), CONC-4 (the muted claim row, :231) and perf-5 (the `requested_at - 1 day` floor, :261) keep their assertions. P5 adds: a second pass key speaks once more; an `amend:*` pass whose request closed mid-run sends no reply (re-check corpus-mig-seam-2). |
| `calc-prefill-standdown.test.ts`, `calc-prefill-wire.test.ts`, `calc-prefill.integration.test.ts` (:463, :750, :806, :851; :305-307), `ai-reply.test.ts`, `prefill-reply.test.ts`, `stored-volume.integration` (:99-105), `estimate.test.ts`, `customs-estimate.integration.test.ts` (:536) (re-check v3-1, v3-4) | K + P5 | K: standdown's `toHaveBeenCalledWith('r1', …)` gain `'landing'` second (`call[1]`→`call[2]`, `call[2]`→`call[3]`); wire's :172 → `sayOnce(requestId, 'landing', {`. P5: each as F §10.1 lists it (wire's `pass`, the ticket pins, standdown's `pass: 'landing'` and the `prefill-queue` mock, the two chain-less integration cases, the audience-keyed tails — estimate's words pin and the two `out.text` tail pins, re-check v3-1) (re-check p5-p6-4). |
| `redelivery-wire.test.ts` | K + P1 | The ladder asks `intakeTakes` (K); (8) and (10) read `collectorSource()`, and (10) also requires `pressKey(ctx, ` for every step `CALC_STEP_REPEAT` classes `'keyed'` (K12, re-check corpus-mig-seam-18); the hydrate order is `Promise.allSettled` with one `.catch` per hydrate (P1, regression-20, durability-11). |
| `bot-lifecycle.test.ts` (the stop) | K | The flush budget is the rest of the 5 s and an `unwritten()` number confirms through the update before it; the dep is OPTIONAL (default `() => null`), so its five calls compile unchanged and every existing expectation holds (re-check p1-p2-8). |
| any test pinning `BACKLOG_SENTENCE`'s text (backlog.ts:21; `bot-redelivery.integration` :743-921 sends it) | P1 | `backlogSentence(hasCollection)` (backlog.ts; `tellBacklogOnce` passes `collectionSurvived(chatId)`): today's text unless a collection opened before this boot is live (kept, regression-24), the shortened one with such a collection (re-check p1-p2-6). |
| Door B's pins (`topshiriq-buttons.test.ts:10,132` — `forwardKeyboard()` in the keyboard-function scan; `topshiriq-bot.integration.test.ts:292`, `bot-redelivery.integration.test.ts:469,922` — the «📌» offer) | K | Door B's keyboard (task-handlers.ts:553) is `[...forwardKeyboard(), ...(await addOfferRows(chatId))]`; `addOfferRows(chatId: bigint): Promise<{ text: string; callback_data: string }[][]>`, K's body `async () => []`, so every keyboard assertion holds (re-check corpus-mig-seam-19). P4's `amend-offer.test.ts` covers the rows; `cf:` stays under the derived callback scan because that scan reads `CALC_COLLECTOR_FILES` (below). |
| `ai-rastamojka-bot.test.ts` | K | The `startIntake` literals carry `staffId`. |
| `intake-images.test.ts`, `intake-round1.test.ts` (`AI_READ_FAILURE[failure].text`), `bot-ai-dispatch.test.ts`, `ai-rastamojka-bot.test.ts`, `intake-customer-name.test.ts:105-107` (`readCustomerText` / `clientAnswer` in the branch K6 moves into `routeCollectorText`) | K | Read `collectorSource()` (`tests/fixtures/calc-collector-source.ts`, K16) where they read `staff-handlers.ts` for a MOVED literal (re-check kernel-20). |
| The landing's ✅: `intake-reply-link.test.ts` (:24-32), `intake-confirm.test.ts`, `bot-both-modes.test.ts`, `calc-landed-words.test.ts` | K | The text moves verbatim into `calc-dialog.ts` `landingReplyText(target, { link, tariffFollows })` (pure; the save branch keeps `const link = await landingLinkFor(staff.id, target);` and computes `tariffFollows` as today, K11). intake-reply-link keeps its slice for `landingLinkFor(staff.id, target)` and re-points the ``(link ? `${link}\n` : '')`` needle at `landingReplyText`'s body; intake-confirm (presses `'save'` with no `callbackQuery`; its inline fake at :54 now returns `{ message_id }` so it compiles against `CalcPressCtx`, re-check v1-1) has no expectation change; bot-both-modes needs no re-anchor (`await replyKeyboardFor(chatId)` stays in staff-handlers.ts); calc-landed-words keeps its import path (`landedWords` and `TARIFF_FOLLOWS` re-exported from staff-handlers.ts) (re-check corpus-mig-seam-7). |
| `reply-door.test.ts` | P4 | The new verdict in the exhaustive switches, and the HANDLED-with-no-text outcome (regression-2). |
| `thread-reply.integration.test.ts:340-350` | — | Unchanged and must stay green: Q2 a holds. |
| `intake-round1.test.ts:204` (the save guard's literal names `'question'`) | K + P3 + P5 | K keeps today's literal verbatim, `if (state.stage !== 'review' && state.stage !== 'question') {`, with the guard above the amend branch (regression-4, K11); P3's commit narrows it to `if (state.stage !== 'review') {` and re-anchors :204 (re-check kernel-5). `:202-206`'s claim («a save before «Bo‘ldi» is refused») is unchanged. Its stand-down pin (:227-248) follows `sayOnce`'s pass: K → `await sayOnce(requestId, 'landing', {`, P5 → `await sayOnce(requestId, pass, {` (re-check corpus-mig-seam-2). There are no `reasked` reads: its `reaskedGroup` pin (:252-258, the CUSTOMER question's album re-ask) stays (re-check corpus-mig-seam-17). |
| `intake-collector-r4.test.ts` (`resolveLineDone`, `carryLineDone`) | P3 | Re-anchored onto `placeByName` and its WRITE-BACK (regression-7): the same fixtures, the placed `index` asserted. |
| `intakeSummaryText`'s FIVE test files: `intake-facts.test.ts` (:70, :164, :186), `intake-volume.test.ts` (:103-123), `calc-intake.integration.test.ts` (:131, :145), `totals-question.test.ts:342`, `intake-weight-basis.test.ts:129` | P3 | The function is deleted; each assertion moves to `intakeTableText` over the same facts (the `Mijoz:` line, the volume «qatorlardan», the freight-only rows; the two-way cube's ⚠️ row, never «to‘liq»; PF-1/PF-3's weight words → the table's weight row, `✅ ${weightLabel(section, facts)}: {kg} kg` — podklyuch `✅ Og‘irlik (brutto): 3500 kg`, rastamojka netto-only `✅ Og‘irlik (netto): 1200 kg`, rastamojka plain `✅ Og‘irlik: 1200 kg`, in `intake-table.test.ts`). Nothing asserted is dropped (re-check corpus-mig-seam-13). |
| `press.test.ts:144` (`c:cert`) | K | Presses `c:cert_y`; a new case asserts `c:cert` answers «Bu tugma eskirgan». |
| `calc-intake-lines.test.ts:25` (pins `c:skip` on the offer keyboard) | P3 | The offer keyboard has no ⏭ (product-fit-9); `:25` now asserts its absence, and that `skip` still parses (old messages). |
| `ai-rastamojka-bot.test.ts` (the vocabulary list) | K | Gains `cert_y`, `cert_n`, `resume`; `cert` and `skip` stay parseable. |
| `topshiriq-buttons.test.ts` | K | No test reads `CALC_STEPS` (private, staff-bot.ts:462). Its derived callback scan (:106-110, the #939 fence) adds K16's `CALC_COLLECTOR_FILES` to its three sources, or the moved calc keyboards and `cf:` leave the fence. The per-step class is fenced by `CALC_STEP_REPEAT`'s `Record<CalcStep, …>` type itself and by `redelivery-wire.test.ts` (10) (above) (re-check corpus-mig-seam-18). |
| `calc-error-words.test.ts` | P6 | Unchanged; it sees `amended_since` once `amended-since.ts` throws it literally (§12) (re-check corpus-mig-seam-20). |
| `intake-corpus.test.ts` routing (new cases, P3) | P3 | c1524-c1526's inputs as table-stage and material-stage ROUTING cases (no row patched), beside their goods-reader cases, which are unchanged. |
| The derived re-anchor list (K16) | K | Whatever the grep finds beyond this table joins it, with a reason, before K is cut. |

**No e2e.** No browser surface changes. The VED's page renders the job's thread and the
card's lenta notes with existing components (their e2e already walk them). The bot halves are
proven through the real handler chain (`registerBotHandlers` in
`bot-redelivery.integration`).

---

## 12. i18n keys: one

Every new BOT string is the staff bot's, and the staff bot speaks Uzbek from code (the
`prefill-reply.ts` convention, R2 §10). The one web-screen change is P6's refusal on the VED's
doors: `calc.errors.amended_since`, in all four bundles (`ru`, `uz`, `zh-CN`, `en`), with the
words of §10A.2.4. The key is absent from all four today (92 `calc.errors` keys each). The
refusal reaches the screen as a runtime key (`errors.${code}` behind `t.has`), which
`i18n-keys.test.ts` does not check (it reads literal `t('…')` keys only). The fence is
`calc-error-words.test.ts`, derived from every literal `new CalcError('…')` under wms/calc,
wms/customs and app/(protected)/hisoblash: it sees `amended_since` once `amended-since.ts`
throws it literally (`new CalcError('amended_since')`, never through a variable) and requires
its sentence in all four bundles' `calc.errors`. **Red proof:** drop it from zh-CN.json →
`zh-CN has a sentence for every CalcError code` is red. Any other new `CalcError` code R3
throws in wms/calc needs its sentence ×4 too (`lead_closed` is there already). (re-check
corpus-mig-seam-20)

---

## 13. Migration 0137 `calc_intake_durable` (additive) (re-check kernel-1) — 0138 after the merge, ledger 139 (K-review spec-5)

```sql
-- Sakkiz band round 3 (docs/SAKKIZ-R3.md), migration 0138 — after main's 0137_plan_road.
-- His 1.8 c: an unfinished «Hisoblatish» waits 24 hours and survives a deploy. His 1.9 a:
-- what arrives after the job landed joins THAT job while the VED has not started. His 2.8 b: the law's missing count is asked after the AI
-- answer. Nothing is backfilled. gsr_ai_reader (0080, allowlist default-deny) is granted
-- NOTHING on either new table. The four new `calc_requests` columns are readable through
-- 0080's table-level grant on `calc_requests` (no secret in them, stated);
-- `ai_calc_passes.intake_note_id` is not (the table is not granted).

-- (1) The collection, written behind memory (the 0130 idiom). One per chat. The note id is
-- the collection's identity: its files are pre-bound to it, and a landed or added collection
-- is recognised by it.
CREATE TABLE "telegram_calc_intakes" (
  "chat_id" bigint PRIMARY KEY,
  "staff_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "note_id" uuid NOT NULL,
  "state" jsonb NOT NULL,
  "opened_at" timestamptz NOT NULL,
  "touched_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "telegram_calc_intakes_note_unique" UNIQUE ("note_id"),
  CONSTRAINT "telegram_calc_intakes_state_check" CHECK (jsonb_typeof("state") = 'object'),
  CONSTRAINT "telegram_calc_intakes_window_check" CHECK ("opened_at" <= "touched_at" AND "touched_at" < "expires_at")
);
-- No index on expires_at: every write changes it (an index would rule out HOT updates and
-- add an index write per message), and the table holds one row per staff chat, which the
-- hydrate and the nightly prune scan anyway.
--> statement-breakpoint
-- (2) Who touched the request last. `handsoff_rev` = the revision the machine's pass or the
-- seller's own addition left; equal to `rev` = no person has written since (his 1.9 a «VED
-- hali boshlamagan»). NULL = not known (requests before this migration, corrections). The
-- landing writes 0 (rev's own default).
ALTER TABLE "calc_requests" ADD COLUMN "handsoff_rev" integer;
--> statement-breakpoint
-- (3) A machine pass owed or running: the ticket it was queued at, and when. Set by
-- `queueCalcPrefill` on whichever queue the section names (`calc.prefill` or
-- `calc.tariff-reply`, `passQueueOf`) and cleared by THAT queue's worker's settle
-- (`settlePass`; both workers settle). Neither moves `rev`.
ALTER TABLE "calc_requests" ADD COLUMN "ai_pass_rev" integer;
--> statement-breakpoint
ALTER TABLE "calc_requests" ADD COLUMN "ai_pass_at" timestamptz;
--> statement-breakpoint
-- The pass's own pg-boss job, the id `enqueue` was given (K: `EnqueueOptions.id`; the queue
-- is re-derived from the row's section): «busy» is «that job is alive», never a time window.
ALTER TABLE "calc_requests" ADD COLUMN "ai_pass_job" uuid;
--> statement-breakpoint
ALTER TABLE "calc_requests" ADD CONSTRAINT "calc_requests_ai_pass_check"
  CHECK (("ai_pass_rev" IS NULL) = ("ai_pass_at" IS NULL)
     AND ("ai_pass_rev" IS NULL) = ("ai_pass_job" IS NULL));
--> statement-breakpoint
-- (4) What a seller added to a landed request, and what became of it: written into the rows
-- ('applied'), handed to the VED ('to_ved'), stored until the running machine pass ends
-- ('waiting'), or only filed on the card ('noted'). The note id is the once-key: a redelivered
-- or repeated «✅ Qo‘shish» finds it. The submission is kept so a 'waiting' row can be written
-- later by the job alone, and the chat so its words reach the seller.
CREATE TABLE "calc_amendments" (
  "id" uuid PRIMARY KEY,
  "request_id" uuid NOT NULL REFERENCES "calc_requests"("id") ON DELETE CASCADE,
  "note_id" uuid NOT NULL,
  "staff_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "chat_id" bigint NOT NULL,
  "outcome" text NOT NULL,
  "rev" integer,
  "submission" jsonb NOT NULL,
  "change" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- when the seller was told the CURRENT outcome (NULL again when a 'waiting' row moves on)
  "outcome_sent_at" timestamptz,
  -- when the thread message's ping finished (the message itself is in the save's transaction)
  "announced_at" timestamptz,
  CONSTRAINT "calc_amendments_note_unique" UNIQUE ("note_id"),
  CONSTRAINT "calc_amendments_outcome_check" CHECK ("outcome" IN ('waiting', 'applied', 'to_ved', 'noted')),
  CONSTRAINT "calc_amendments_rev_check" CHECK (("outcome" = 'applied') = ("rev" IS NOT NULL)),
  CONSTRAINT "calc_amendments_change_check" CHECK (jsonb_typeof("change") = 'object'),
  CONSTRAINT "calc_amendments_submission_check" CHECK (jsonb_typeof("submission") = 'object')
);
--> statement-breakpoint
CREATE INDEX "calc_amendments_request_idx" ON "calc_amendments" ("request_id", "created_at");
--> statement-breakpoint
-- P6's refusal asks «an applied addition after the revision the VED saw», on every door press.
CREATE INDEX "calc_amendments_applied_idx" ON "calc_amendments" ("request_id", "rev")
  WHERE "outcome" = 'applied';
--> statement-breakpoint
-- The settle and the sweep look for what waits.
CREATE INDEX "calc_amendments_waiting_idx" ON "calc_amendments" ("request_id")
  WHERE "outcome" = 'waiting';
--> statement-breakpoint
-- (5) A collection's model reading is billed when the model answers, before any request
-- exists (R2 §8.2.7's stated hole), dated by the answer as R2's late pass already did
-- (concurrency-11): `intake_note_id` anchors it, and the landing sets `request_id`. The
-- collector's own subtraction of its unlanded readings goes in the same release (P2), or
-- each reading counts twice. The anchor CHECK keeps 0119's two rules and adds the third.
ALTER TABLE "ai_calc_passes" ADD COLUMN "intake_note_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_anchor_check";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_anchor_check" CHECK (
  CASE "kind"
    WHEN 'similar' THEN "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'intake'  THEN "request_id" IS NOT NULL OR "intake_note_id" IS NOT NULL
    ELSE "request_id" IS NOT NULL AND "intake_note_id" IS NULL
  END);
--> statement-breakpoint
CREATE INDEX "ai_calc_passes_intake_note_idx" ON "ai_calc_passes" ("intake_note_id")
  WHERE "intake_note_id" IS NOT NULL;
```

Why each:
- **(1) is a table, not a `telegram_chat_waits` kind.** A collection is kilobytes to hundreds
  of kilobytes, written dozens of times, and has its own clocks. 0130's kind CHECK would also
  need widening. Platform schema with an FK to `users` only: no FK to `calc_requests`
  (platform must not name a wms table), so the add collection's request lives in the state.
- **(1) has no `expires_at` index** (performance-8). The first draft indexed the one column
  every UPSERT rewrites, for a table of a few dozen rows that the hydrate reads whole and
  whose only other reader is the nightly prune (§6.2.17). The column stays, unindexed, for
  the window CHECK and the prune.
- **(2)-(3) are columns on the row the clock already lives on.** «Started» and «busy» are then
  one indexed read by primary key.
- **(4) is a table** because the add door's once-key must be in the save's own transaction,
  and the VED's branch writes no row of the request to hang it on. It is also the one record
  of what a seller added after landing, the queue of what waits for a running pass, and the
  record of which of its effects (the words, the ping) are done, so a repeat redoes only the
  missing ones.
- **No unique index on `calc_requests.note_id`** (durability-3's fix by a lock instead,
  K2): a correction copies its parent's note id (`recalcFromSealed`, workspace.ts:2581), so
  duplicates are by design; only a partial index `WHERE supersedes_request_id IS NULL` could
  be unique, and it could meet an unknown production duplicate on deploy morning (#472). K2's
  lock plus `rootOfNoteSql` instead; §17 counts ROOT duplicates on the shaped copy. (re-check
  corpus-mig-seam-6)
- **(2)-(3) and the AI reader:** the four new `calc_requests` columns ride 0080's
  table-level `GRANT SELECT ON … calc_requests` (0080_ai_assistant.sql:77), and the analyst's
  schema card lists columns from the Drizzle schema (`getTableColumns`), so the admin's AI can
  read `handsoff_rev` and the ticket — revisions and a job id, no secret, stated in the
  header; `ai_calc_passes` is not granted. (re-check corpus-mig-seam-24)
- **(3) covers both queues** R2 runs a pass on (`calc.prefill`, `calc.tariff-reply`,
  jobs.ts:10/:20): a ticket the tariff worker never settled would read «busy» until
  `ticketStanding` reaped it. (re-check corpus-mig-seam-23)
- **(5) replaces R2's interim bill** (concurrency-11: the collector subtracted its own
  `state.usages` from the day's budget and the landing wrote them, calc-intake.ts:1483,
  intake-land.ts:574-591). (re-check corpus-mig-seam-10)
- **Going below 0137 restores to 0136 at most:** Uch band's 0136 drops `leads_client_unique`
  and is one-way. (re-check kernel-1)
- **(5) is a nullable column.** Existing rows satisfy the new CHECK (every `intake` row has a
  `request_id`; no other kind carries a note). `ON DELETE SET NULL` on `calc_amendments.staff_id`
  sits beside no CHECK that spans it (#809). The anchor CHECK sits beside 0096's
  `ON DELETE CASCADE` (the FK 0119 kept; re-check v3-4), which never nulls the column.

Deploy: the ledger must read **139** (main's `0137_plan_road` is 138; this round's file is
0138 after the merge — K-review spec-5). His server last CONFIRMED 136; if the 138 deploy (R2 +
Uch band + `plan_road`) was not confirmed first, this deploy carries Uch band too and MUST rebuild tg-listen
(Uch band changed `inboundMatch`): `docker compose build migrate app tg-listen`,
`docker compose up -d`, `docker compose --profile telegram up -d tg-listen`. Round 3 itself
changes nothing tg-listen imports. `app` starts only after `migrate` completes (compose
`service_completed_successfully`), so a code-ahead-of-schema minute exists only when
`migrate` FAILED — then read that container's own output. In that window the store's
readiness probe answers false (memory-only), the landing's catch turns any non-`CalcError`
into `queueError: 'server_behind'` (QUEUE_REFUSAL: «server yangilanmoqda — biroz keyinroq
urinib ko‘ring.»), and a path that asks `isServerBehind` (platform/db/errors.ts:28) answers
42P01 (the two new tables) and 42703 (the four new `calc_requests` columns,
`ai_calc_passes.intake_note_id`) alike. End by counting the ledger (139) AND reading
`/api/version`. (re-check corpus-mig-seam-21, kernel-30)

---

## 14. The landing — Uch band (round 4, shipped, docs/UCH-BAND.md, migration 0136) is in the base (re-check corpus-mig-seam-3)

Uch band (round 4 and 8, shipped, docs/UCH-BAND.md) is the other session's round 4 — a new
deal per request (his item 6; 6.1 a-6.10 a) and his 6.8 b (a request a seller sends for a
colleague's client opens a LEAD in the sender's funnel) — with round 8, merged into this base
(a697164; DECISIONS #1469-#1478). The add door must not decide which card a NEW request lands
on, and round 3 builds on Uch band's landing; it never re-implements it.

1. **What Uch band built, and the add door never calls** (`amend-wire.test.ts`'s fenced
   names, §9.7):
   - `intake-land.ts`: `landIntake`, `landCodedRequest`, `landCodedCard`, `calcCardFor`,
     `cardOfNote`, `rootRequestOfNote`, `shellCandidate`, `openLeadForPhone` (→
     `inboundMatch`), `calcDealOwnerFor`, `clientSellerFor`, `resolveIntakeClient`,
     `calcStageMove`, `moveToCalcStage`, and `landIntake`'s target block
     (`let target: IntakeTarget; if (input.client) {…} else {…}`, intake-land.ts:481-521)
     with its note writes — round 3 does not touch that block;
   - `openCalcRequest` (calc/service.ts), `createDealInTx` (deals/service.ts:205),
     `insertLeadTx` (crm/service.ts:582);
   - `from-thread.ts`: `threadCalcSend`'s client path;
   - the ✅'s words: `landedWords` (with `TARIFF_FOLLOWS`, `QUEUE_REFUSAL` incl.
     `lead_closed`, `queueRefusal`).
   - `dealFor` no longer exists (only comments name it); a fence on it would be vacuous and
     goes.
2. **What round 3 changes in those files, and nothing else:**
   - `intake-land.ts`:
     - NO extraction (there is no `landRequestHalf`). Uch band already makes the landing
       idempotent per note: `cardOfNote` (:178, sender-fenced) finds the note's own card
       (outcome `'retried'`) and `rootRequestOfNote` (:216) the request if one exists. A
       landing cut off between its note and its request (durability-3) is finished by
       calling `landCollectedIntake` → `landIntake` again with the same collection — the
       next «Tasdiqlash», or P1's sweep (`resume_landing`; `landingState` = those two
       readers, §6.2.15). P1 never reads a target itself and never asks `crm_activities`;
       `cardOfNote` is the one reader. (re-check corpus-mig-seam-5)
     - Uch band's retry branch (`const queuedBefore = await rootRequestOfNote(input.noteId)`,
       :525-526, which returns before the bill, the queue and the stage move) becomes one
       local function, `retried(requestId)`, also taken on K2's `opened.existing`. K: today's
       return. P2 adds the attach line, then P5 the queue (`atRev: 0`), the stage move and
       `replyQueued` (F rule 1, C §7.2.9). (re-check corpus-mig-seam-25)
     - P2's ONE hunk right after `openCalcRequest`: R2's per-usage loop (:574-591) becomes
       `await attachIntakePasses(input.noteId, opened.id).catch(log)`, and the input loses
       `usages` (§7.2.10).
     - Signature otherwise unchanged; `IntakeTarget` unchanged.
   - `from-thread.ts`: P5's two retry exits (the root branch :389-390 and K2's
     `opened.existing`) queue the found root's pass (F rule 1) (re-check v3-0).
   - `service.ts` `openCalcRequest`: K2's per-note lock and root re-read (`rootOfNoteSql`)
     FIRST in its transaction and `existing`; then Uch band's order, unchanged — the lead
     `FOR SHARE OF l` check, the card-path note insert, the rota pick LAST, the INSERT
     carrying `handsoffRev: 0`. (re-check corpus-mig-seam-5)
   - `staff-bot.ts` `landCollectedIntake`: P2 deletes its `usages: state.usages` (:1334). Uch
     band's body above it (`resolveIntakeClient`, `client`, `leadName`, `leadPhone`, his
     6.8 b) is in the base, so there is no conflict to resolve (regression-19 a and b are void).
   - `staff-handlers.ts` save branch (K11): two delegate calls — `landedAlreadyReply` after the
     guards (K: false; P1: `resuming.has(chatId)`), `landedReplyMarkup(target) ?? (await
     replyKeyboardFor(chatId))` as the reply's markup. The ✅ text moves verbatim into
     `calc-dialog.ts` `landingReplyText(target, { link, tariffFollows })` — pure, the caller
     awaiting `landingLinkFor(staff.id, target)` and computing `tariffFollows` as today — with
     Uch band's words and its `note_taken` → `endIntake` branch (staff-handlers.ts:2820)
     unchanged. Nothing is reworded, and P1's resume sends the same words. (re-check
     corpus-mig-seam-7)
3. **The contract Uch band's landing keeps, and round 3 relies on:**
   - `IntakeTarget.requestId` is the queued request's id, on the retry exit too (:526) (the
     ✅'s ➕ needs it);
   - `calc_requests.requested_by` is the SENDER on every door, 6.8 b's lead included
     (`openCalcRequest(…, { actorId: input.collectedBy })`; the ➕ is the sender's);
   - the landing writes `handsoff_rev = 0` through `openCalcRequest` (K2). A door that inserts
     a request another way must write it too, or its additions read «started»
     (`recalcFromSealed` writes none, so a correction reads «started» — pinned in
     `handsoff-writers.test.ts`);
   - Question 6's seeded collection (a returned request sent again) lands through
     `landIntake` like any «🧮»: Uch band decides the card (a coded client's re-send is a NEW
     deal, a colleague's client a lead in the sender's funnel, a stranger joins the open lead
     by phone or opens a new one). The returned request, its note and the files pre-bound to
     it stay on the old card; the add door decides nothing about it. (re-check
     corpus-mig-seam-8)
   - A request's card can MOVE after it landed (Uch band's win split, `rekeyLeadCalcJobsTx`,
     calc/service.ts:1134): `amendRequest` reads `entity_type/entity_id` from the request row
     under its own lock, and the 'noted'/'to_ved' notes and links go there — never to a card
     the add collection remembered. (re-check corpus-mig-seam-9)
   - **The landing is idempotent by the collection's note id** (durability-18, regression-19
     d). Uch band did it for a coded client: `landCodedCard` writes the card and the note in
     one transaction and `cardOfNote` finds them on a retry, so no second deal can be minted.
     The stranger path still commits `createLead` and the note (`addActivity`) separately
     (intake-land.ts:505-519); a kill between them followed by «Tasdiqlash» joins the same
     lead when a phone was typed (`openLeadForPhone`) and mints a second, phone-less lead
     otherwise. Round 3 does not touch that block; §15 states it. (re-check
     corpus-mig-seam-4)
   - The lenta note's id is the collection's `noteId` on both paths, because `landingState`
     and hydrate's `endedCollections` read the request by that id: on the coded path it is
     written with the card in one commit; on the stranger path `createLead` precedes it
     (above). (re-check corpus-mig-seam-4)
4. **No merge order with another session.** Uch band is in the base, so K moves the collector
   out of `staff-handlers.ts` into `calc-store.ts`, `calc-files.ts`, `calc-dialog.ts`,
   `calc-keyboards.ts`, `calc-read.ts`, `calc-intake-sweep.ts` and `calc-amend.ts` (K3-K10)
   with Uch band's edits verbatim (`landedWords`, `QUEUE_REFUSAL` incl. `lead_closed`, the
   `note_taken` endIntake), and nothing is sent to another session. The first draft's frozen
   list for round 4, «K lands before round 4 branches» and the conflict resolutions
   (regression-19 c) are deleted. (re-check corpus-mig-seam-3)
5. **What round 3 gives Uch band:** his 6.6 a («the rule ships with the add door») is
   satisfied once this merges: a top-up through ➕ is the SAME request; one re-sent through
   «🧮» is still a new deal (Uch band, his Q4 a). This replaces Uch band's interim rule («a
   re-sent top-up is a new request on a new deal», UCH-BAND.md:143-145) only for ➕; §16.2
   tells him. (re-check corpus-mig-seam-26)

---

## 15. Not this round (said to him)

- **Rounds 4 and 8** shipped as the other session's Uch band (0136) and are in this round's
  base (§14); round 5 (docs/SAKKIZ-R5.md) is the other session's and runs after this round's
  migration (0138 after the merge). Its placeholder `0137_ai_spend` (docs/SAKKIZ-R5.md:42, :805, :2449) becomes
  **0139** (`when` 1785190000118 or later) and still runs after `calc_intake_durable`; that
  session is told, and R5's file is not edited by this round. (re-check corpus-mig-seam-27,
  kernel-1)
- **A re-sent returned job on a new card** (Question 6 a under Uch band, his Q4 a): the
  corrected job lands on a NEW deal (a colleague's client: the sender's lead) beside the
  returned one, which keeps its note and files; a stranger's re-send joins the open lead by
  phone or opens a new one. In his words: «yangi so‘rov Uch band qoidasi bo‘yicha yangi bitim
  bo‘lib ochiladi; qaytarilgan bitim ochiq qoladi — kerak bo‘lmasa yopiladi.» (re-check
  corpus-mig-seam-8)
- **Voice transcription.** His 1.12 a stands: «yozib yuboring», in an add collection too.
- **Undo after «Tasdiqlash» or «✅ Qo‘shish».** The change is on the job; another «➕» changes
  it. A machine-side undo would need a person-safe inverse write the VED may already have
  overtaken.
- **The add door on the web** (the card form, the card's chat door). It is Telegram-only; the
  card's «Savol-javob» remains the web channel to the VED.
- **The add door changing a price, a rate, a zone, the certificate or a code that exists**
  (§0.1(2), ⭐ of Question 3).
- **Files in a calc thread** (E10 a). The add door's files go on a card NOTE, not into the
  thread.
- **A sweep for a LANDING's owed pass that nobody lands again** (a kill between
  `openCalcRequest`'s commit and `queueCalcPrefill`). The landing has had this exposure since
  sub-round B, and Uch band's retry branch (intake-land.ts:525-526, from-thread.ts:389)
  reached it on every second press too: it returned before the queue, the stage move and
  `replyQueued`, so the retried ✅ promised a VED answer no pass was owed for. This round
  closes the bot door's half: the branch becomes `retried()`, which queues the pass through
  the ticket (`atRev: 0`, §14.2), and a cut collection is finished by the next «Tasdiqlash»
  or by P1's `resume_landing`. The thread door has no collection: on a CLIENT its cut is finished
  only by sending again (P5's retry branch queues); on a DEAL or LEAD card a resend is refused
  `note_taken` (Uch band's fence, the note commits with the request), so a cut there leaves the
  request with no pass until the VED opens it — like the card form (re-check v3-0). The card form (hisoblash/actions.ts:288) has no
  retry at all, and no sweep looks for a request with no pass. A retried or resumed landing
  re-queues its pass through the ticket (atRev 0): a customs pass that finished without
  moving the revision runs once more (one model call, its message silenced by the landing
  claim) — stated. The add door does not share the exposure: its save is a
  job, and a redelivered job finds its amendment and queues the missing re-pass
  (durability-5). A ticket whose job died is cleared by `ticketStanding` the next time
  anything asks, so the door never stays shut. (re-check corpus-mig-seam-25)
- **A stranger's landing killed between `createLead` and its note** (durability-18,
  intake-land.ts:505-519): with no phone typed, the retry mints a second, phone-less lead,
  as it can today; with a phone it joins the same lead (`openLeadForPhone`). The coded path
  is closed by Uch band's one-commit landing (`landCodedCard`). Round 3 does not touch the
  target block. (re-check corpus-mig-seam-4)
- **A press made during an outage that crossed the 24 h end.** A callback carries no time of
  its own, so it cannot be judged by when it was pressed; it meets the no-collection answer,
  Uch band's «Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini
  «🧮 Hisoblatish» tugmasidan boshlang.» (staff-handlers.ts:2631; durability-12 c's press
  half). (re-check kernel-22)
- **The rest of an album under a ➕ offer, once it is out of memory.** The `cf:` press takes
  the message the offer replies to and, for a forward, the album's other parts while
  `forwardAlbumOf` still holds them (§9.2); only after that does the add collection ask for
  the rest of the album (product-fit-16). (re-check p4-9)
- **Resuming a redelivered pass that stood down as `unfinished`.** It stays R2's stand-down:
  one paid call, not two, with «➕» under it.
- **P6's check on the bot's «Bajarildi» door.** That door has no screen, so it posts no
  `sawRev` and is not checked (§10A.2.3).
- **Orphan files of an abandoned collection.** They stay in storage, as today (Telegram still
  holds them for the seller). A sweep with `purgeAttachment` is its own round.
- **Models, effort, streaming, the dollar ceiling** — round 5. **One reader over all material**
  — round 6.
- **Per-line ⏭.** Retired with the one-question loop (his 1.10 c).

---

## 16. For the lead's Uzbek report (⭐ = built default)

### 16.1 Savollar (the seven of «Questions for the owner», in his language)

His answer (2026-10-27): «14 a, qolgani seni taklifing» — 1.14 a, 1.15-1.20 the ⭐. The report
says what was built for each. (re-check laws-print-23)

**1.14** AI javobidan keyin bot qaysi sonlarni so‘rasin (2.8):
- a) kod qonuni so‘ragan har qanday o‘lchov: dona, juft, kerak bo‘lsa kg, m², litr ham ⭐ —
  JAVOB: 1.14 a
- b) faqat dona va juft — siz 2.8 da shunday javob bergansiz

**1.15** «VED boshlagan» deb nimani hisoblaymiz (1.9):
- a) VED hisob sahifasida biror narsani saqlagan yoki guruhga ✅ bosgan bo‘lsa. «Olaman»,
  sahifani ochish yoki savol yozish hisoblanmaydi ⭐
- b) a, unga qo‘shimcha VED hisob ostida savol yozgan bo‘lsa ham

**1.16** Sotuvchi kodi bor qatorga boshqa TNVED kod yozsa:
- a) yozilmaydi, VED ga matn bo‘lib boradi; kodi bo‘sh qatorga esa yoziladi ⭐
- b) eski kod o‘rniga yoziladi va AI qayta hisoblaydi

**1.17** 2 soatlik eslatma kechasi kelsa:
- a) kechasi 22:00 dan 08:00 gacha ovozsiz keladi — botning boshqa ovozsiz xabarlari bilan bir
  xil tun ⭐ (re-check p1-p2-11)
- b) ertalab 08:00 gacha kutiladi

**1.18** 24 soat o‘tganda:
- a) bitta qator: «⌛ … o‘chirildi» (hech narsa yuborilmagan yig‘ish jim o‘chadi) ⭐
- b) jim o‘chadi

**1.19** VED so‘rovni sotuvchiga qaytargan bo‘lsa («ma’lumot yetishmayapti»), «➕» nima qilsin:
- a) o‘sha so‘rovning qatorlari, sonlari, kodlari va mijozi bilan to‘ldirilgan YANGI «🧮 Hisoblatish»
  ochiladi; sotuvchi faqat VED so‘raganini qo‘shadi, «✅ Tasdiqlash» uni yangi so‘rov qilib VED ga
  yuboradi — yangi so‘rov Uch band qoidasi bo‘yicha yangi bitim bo‘lib ochiladi; qaytarilgan
  bitim ochiq qoladi — kerak bo‘lmasa yopiladi ⭐ (re-check corpus-mig-seam-8)
- b) «➕» rad etadi, sotuvchi hammasini «🧮 Hisoblatish» orqali qaytadan yuboradi

**1.20** Sotuvchi «✅ Mening vazifalarim» xabarnomalarini o‘chirib qo‘ygan bo‘lsa, u o‘zi
«✅ Qo‘shish» bosgandan keyingi AI qayta hisobi unga kelsinmi (re-check p5-p6-8):
- a) ha — o‘zi so‘ragan qayta hisob chatga keladi (xuddi «Bo‘ldi» dan keyingi jadval kabi);
  boshqa AI javoblari o‘chirilganicha qoladi ⭐
- b) yo‘q — o‘chirilgan bo‘lsa kelmaydi, bot buni oldindan aytadi: «natija kartadagi lentada»

### 16.2 Aytiladi, so‘ralmaydi

1. Yig‘ilgan ma’lumot endi serverda saqlanadi: deploy yoki qayta ishga tushish uni o‘chirmaydi.
   Bot o‘chiq paytda yozilgan xabarlar ham, yig‘ish ochilgandan keyin yozilgan bo‘lsa, shu
   yig‘ishga qo‘shiladi.
2. AI o‘qishi endi alohida navbatda ishlaydi (bir vaqtda 4 ta). Deploy paytiga to‘g‘ri kelsa,
   natija biroz kechroq (7 daqiqagacha) keladi, lekin yo‘qolmaydi. Bunday holatda AI qayta
   o‘qiydi: Anthropic ikkala o‘qish uchun ham pul oladi, lekin kunlik AI hisobida bitta bo‘lib
   ko‘rinadi (to‘xtatilgan o‘qish yozilmaydi). Telegram vaqtincha xabar yubormay tursa, tayyor
   jadval kutib turadi va keyinroq keladi — «Tahlil qilib bo‘lmadi» demaydi.
3. Savollar endi bitta jadval: har qator ✅ yoki ⚠️, sababi bilan. Bitta xabarda istalgan
   qatorni to‘ldirasiz: «2: 40 juft», «Shapka 30 dona», «jami 3500 kg». «⏭ O‘tkazib yubor»
   tugmasi olib tashlandi: to‘ldirilmagan qatorni VED to‘ldiradi.
4. Jadval paytida yozilgan matn endi umumiy og‘irlikka aylanib ketmaydi: u yo qatorga javob,
   yo bot «qaysi qatorga?» deb so‘raydi. Yangi tovar yoki fayl — «➕ Yana ma’lumot».
5. «↩️ Shu javobni bekor qilish» faqat yig‘ish ochiq turganda ishlaydi. Tasdiqlangandan keyin
   o‘zgartirish — «➕ Shu so‘rovga qo‘shish». Butun yig‘ishni o‘chiradigan «✖️ Bekor qilish»
   esa, ichida xabar yoki fayl bo‘lsa, bir marta so‘raydi: «Hammasi o‘chadi: 3 ta xabar, 2 ta
   fayl. O‘chiramizmi?».
6. «➕ Shu so‘rovga qo‘shish» ✅ va AI javobi ostida turadi. Qo‘shimcha umumiy og‘irlik yoki
   hajmni faqat «jami 3500 kg» deb yozilganda o‘zgartiradi: qo‘shimcha packing listdagi jami
   butun mashinaniki yoki faqat qo‘shimchaniki ekanini bot bilmaydi.
7. Deploydan oldin yuborilgan hisoblar uchun «VED boshlagan» deb olinadi: ularga qo‘shimcha VED
   ga matn bo‘lib boradi.
8. AI javobi ovozsiz qilingan («✅ Mening vazifalarim» o‘chirilgan) sotuvchi AI javobini va
   uning ostidagi ➕ ni ko‘rmaydi. ✅ ostidagi ➕ esa qoladi. Faqat o‘zi «✅ Qo‘shish» bilan
   so‘ragan qayta hisob unga baribir keladi (1.20 ⭐).
9. Eslatma sotuvchining o‘z yig‘ishi haqida, shuning uchun xabarnomalar sozlamasidan qat’i
   nazar keladi.
10. Yig‘ish 24 soat kutadi, lekin chatni egallab turmaydi: 30 daqiqa hech narsa yozilmasa u
    «to‘xtab turadi». Shu paytda «GS777», zametka, «➕ Topshiriq» va AI yordamchi oddiygidek
    ishlaydi. Davom etish — «▶️ Davom etamiz», yig‘ishning tugmalari yoki jadvalga reply.
11. AI hali hisoblayotgan paytda «✅ Qo‘shish» bosilsa, qo‘shimcha saqlanadi va AI tugatgach
    o‘zi so‘rovga yoziladi (VED boshlamagan bo‘lsa), aks holda VED ga matn bo‘lib boradi —
    qayta bosish shart emas.
12. Faqat fayl yoki matn qo‘shilib, qatorlar o‘zgarmasa — u kartaga va VED ga boradi, AI qayta
    hisoblamaydi. Fayldagi son so‘rovdagidan farq qilsa («faylda 200 dona, so‘rovda 300»), bot
    sizning 1.13 javobingizdagi kabi so‘raydi: «qo‘shilsin» (500), «o‘rniga» (200) yoki «VED
    hal qilsin». Javob berilmasa — VED hal qiladi; bot o‘zi hech birini yozmaydi.
13. Qo‘shimchada yangi tovar qo‘shilsa: umumiy hajm qatorlar yig‘indisi bo‘lsa, o‘zi qayta
    hisoblanadi; qo‘lda yozilgan hajm va umumiy brutto esa «yangilansinmi?» deb so‘raladi, va
    javob berilmasa AI yo‘lkirani hisoblamaydi.
14. VED sahifani ochgandan keyin sotuvchining qo‘shimchasi so‘rovga yozilsa, VED ning «Готово»,
    ✅ va «Muhrlash» tugmalari «sahifani yangilang» deydi — VED ko‘rmagan narsaga javob
    berilmasligi uchun.
15. Hech narsa ochiq bo‘lmaganda sotuvchi packing list forward qilsa yoki fayl yuborsa, va
    uning oxirgi 7 kunda yuborgan ochiq so‘rovi bo‘lsa, bot «➕ B-000067 so‘roviga qo‘shish»
    tugmasini taklif qiladi (forwardda «📌 Topshiriq qilamizmi?» yonida). Bosilsa, o‘sha xabar
    qo‘shimchaga tushadi.
16. VED allaqachon ishlayotgan so‘rovga qo‘shimcha yozilayotganda bot «yozildi» demaydi:
    «📝 VED ga yuboriladi» deydi va tugma «📨 VED ga yuborish» bo‘ladi. Kod qonuni qabul
    qilmagan son (masalan juft so‘ramaydigan kodga «40 juft») «yozilmadi» deb aytiladi.
17. Qatorni raqam yoki nom bilan yozish endi oddiy gapdagidek ishlaydi: «3-qatordagi …»,
    «3-chi qator …», «строка 3», «50 dona sumka», «og‘irligi 3500 kg», «брутто 3500 кг».
18. Bot o‘chiq paytda yozilgan xabarga «bot yangilanayotgan paytda yozilgan» degan gap
    keladi; «Hisoblatish» so‘zi unda faqat yig‘ishi saqlanmagan chatda qoladi.
19. «➕ Shu so‘rovga qo‘shish» orqali yuborilgan qo‘shimcha o‘sha so‘rovning o‘zi bo‘ladi
    (6.6 a). «🧮 Hisoblatish» orqali qayta yuborilgani esa Uch band qoidasi bo‘yicha yangi
    bitim bo‘lib ochiladi. (re-check corpus-mig-seam-26)

---

## 17. Merge, gates, verification (the lead)

1. **K first.**
   - Fresh `gsr_ci`: migrate, seed, `seed:demo`.
   - `pnpm typecheck` / `pnpm lint` / the calc, telegram and corpus suites, each with its own
     exit code.
   - K is behaviour-unchanged except its three stated presses (K7, K9, K11): TTL 30 min, the
     in-process reading, the per-line questions, no ➕, `quiet` ignored, `intakeTakes` =
     today's rule, `holdingIntake` = `activeIntake`, `ownsPress` = true,
     `oldestUnwrittenUpdate` = null (so the stop confirms as today), `intakesHydrated` =
     true, `addOfferRows` = [], `offerAddForMedia` = false, `pressCancel` = today's end,
     `routeAnswer` never written. The full suite
     passing, with the K16 re-anchors only (the DERIVED list), is the proof.
   - Commit, then write the hash at the top of this file.
2. **P1-P6 in worktrees off K**, two agents at a time (4 CPUs, #1339). Suggested waves:
   P1 + P3, then P2 + P5, then P4 + P6 (P4 consumes the most seams; P6 touches only the VED's
   web doors). Each package:
   - runs typecheck, lint and its touched unit and integration tests against its own
     `gsr_<pkg>` database;
   - shows every red proof by string edit;
   - commits and reports its branch.
3. **Cherry-pick order: P1 → P2 → P3 → P5 → P4 → P6.**
   - Shared files, hunks apart: `calc-intake.ts` (P3's retired fields and helpers,
     :22-662 today, and `analyzeCollected`'s BASE branch; P2's budget/usages lines in it,
     :1483/:1571; P4's ADD branch beside P3's — `analyzeCollected` is at :1464 today, ~:1385
     after K3's store move) (re-check p3-4); `staff-bot.ts` (P5's `buttonsFor` branch,
     :642-709, re-check v3-4; P2's `landCollectedIntake` line, :1334); `intake-land.ts` (K's `retried()`:
     P2's attach line, then P5's queue / stage move / `replyQueued` — on a conflict keep both,
     in that order; re-check corpus-mig-seam-25); `intake-corpus.test.ts` (P2's c0012/c0774
     drives, P3's collector cases and routing cases, P5's worker mock); `service.ts` (K's
     `openCalcRequest`, P5's `requestAsks`, P6's `finishCalcRequest`); `workspace.ts` (K15's
     seams, P6's three doors).
   - P3-owned hunks in OTHER packages' files — calc-store.ts `startIntake`'s defaults (P1's),
     calc-read.ts `settleAnalysis`'s `lineAnswers` (P2's) — are applied by the lead at the P3
     pick when they collide (D §8.1) (re-check p3-4).
   - On a conflict there, keep both. After each pick, run `pnpm typecheck`.
4. **On the merge:**
   - `pnpm typecheck`, `pnpm lint`;
   - the full vitest on a fresh `gsr_ci`, seeded once;
   - Playwright WITHOUT re-seeding (CI's order);
   - `fuser -k 3000/tcp` before e2e; no `CI=1`.
5. **Docs:**
   - `docs/SAKKIZ-BAND.md` §10 «R3 SHIPPED» with the DECISIONS range;
   - DECISIONS `#R3-*` renumbered after a fetch (main's tail was #1511 on 2026-10-28, so from
     #1512 unless it has moved again; re-check laws-print-3);
   - CHANGELOG in Uzbek; the deploy steps are §13's one paragraph (ledger 139; tg-listen
     rebuilt when the 138 deploy was not confirmed first);
   - the CLAUDE.md state paragraph: migration 0138 (renamed from the branch's 0137 at the
     merge), ledger 139; R5's placeholder becomes 0139 (tell that session). (re-check
     kernel-1, K-review spec-5)
6. **Measured, not argued, before the push:**
   - the stored state's size for a worst-case collection (12 photos, 3 PDFs, five 15k-char
     sheets, a 500-row invoice), and one UPSERT's time — set against the stop's flush budget
     (the rest of the 5 s, K15); a worst case over 2 s is reported to the owner with the
     number, and the unwritten-update rule is what keeps it safe (durability-10);
   - the write count over a real 20-message forward burst with the bot's own awaited replies
     (one per collection-changing message since the write-before-return rule, §6.2.2 —
     K-review spec-2; measured: each write's time, set against the reply it sits beside);
   - hydrate time with 50 rows;
   - `SELECT note_id, count(*) FROM calc_requests WHERE note_id IS NOT NULL AND supersedes_request_id IS NULL GROUP BY 1 HAVING count(*) > 1`
     on the shaped copy — ROOT duplicates only (a correction shares its parent's note id by
     design, workspace.ts:2581) — recorded, never «fixed» by the migration (K2) (re-check
     corpus-mig-seam-6);
   - **the crash drill:** a text and a document into a collection, `docker kill` right after,
     start → the same updates redelivered, `material` and `fileCount` unchanged, one
     attachment row;
   - **the parking drill:** a collection left 31 minutes, then «GS777» → the lookup answers;
     a reply to the table → taken;
   - **the add-save drill:** «✅ Qo‘shish», `docker kill` before the words → after the start,
     the words arrive once, the re-pass once;
   - **the deploy drill:** open a collection, press «Bo‘ldi», `docker kill` the app mid-job,
     start it → the time until the table arrives (expected ≤ 300 + 120 s + polling), and
     ONE `intake` row billed: the killed call wrote none (it is spent at Anthropic and not
     counted against the day's budget), the redelivery writes one (durability-20). Two rows
     only if the kill lands between the bill and the stored reply;
   - **the flood drill:** a reading whose delivery meets a 429 with `retry_after` 30 → one
     follow-up job, the table about 31 s later, no «Tahlil qilib bo‘lmadi» (durability-16);
   - **the boot-window drill:** «Bo‘ldi» pressed seconds before a deploy, the job fetched by
     the new process before the bot hydrates → the job waits, then delivers (durability-9);
   - **the stop drill:** a text into a collection whose write is made slow (a `pg_sleep`
     trigger on a throwaway copy), then SIGTERM while its handler still awaits the write →
     `confirmedThrough` stops before that update, and the new process applies it once
     (durability-10); and the same with the write made to FAIL after the handler returned →
     the log names the update `unwrittenLost` (K-review spec-2);
   - **the stalled-storage drill:** a MinIO that accepts and never answers one photo → the
     reading still settles inside its file budget, naming «1 ta fayl o‘qilmadi»;
   - **the graceful drill:** SIGTERM mid-collection, a text typed during the downtime → it
     lands as material with no backlog sentence;
   - a real 10-line invoice with 227-character names → the table under 4096;
   - on a shaped copy: ➕ → «2: 40 juft» → «✅ Qo‘shish» → the re-pass reply. Time
     `amendRequest` on a 30-row request.
7. **Pinned by name on the merge:** `migration-journal.test.ts` green with this round's file
   renamed 0138 (idx 138) after main's `0137_plan_road` (`when` …117 > …116 > …115; re-check
   kernel-1, K-review spec-5); `intake-corpus.test.ts` green with every
   package's hunks; `thread-reply.integration.test.ts:340-350` green (Q2 a); R2's
   `calc-basis.integration.test.ts:657-675` green (the add door's save goes through the same
   fill); `handsoff-writers.test.ts` and `intake-holds-wire.test.ts` green over the MERGED tree
   (a package's own tree cannot see another package's writer or reader).

---

## 18. Judged before code

Five lenses (durability, regression, product-fit, law-money, performance), each objection
given refuters in two passes. The first pass's relay CUT its lists, so the first revision saw
only the first 38 verdicts. This revision worked from the judges' raw outputs and both
refuter passes (`r3/judges/judge-*.txt`, `refute-*.txt`, `refute2-*.json`); every one of the
87 ids below has its verdict, and nothing is left unseen. A «refuted» verdict here almost
always means «already absorbed under another id», and the row says which.

**Counts:** 87 objections — durability 21, regression 26, product-fit 21, law-money 9,
performance 10. **63 confirmed, 12 partial, 12 refuted.** Blockers: 7 (durability-1,
regression-1, regression-2, regression-3, product-fit-1, law-money-1, performance-1), all
absorbed in the first revision. **This pass:** 38 absorbed (36 newly, plus regression-9 and
product-fit-10 completed), 4 verified as already in the text (law-money-6, regression-8,
durability-7, durability-8), 12 refuted and left as they are. One new question for the
owner (1.20, product-fit-15) and one changed ⭐ (1.14 → b, product-fit-21) — which his answer
of 2026-10-27, 1.14 a, moved back to (a) (re-check laws-print-23). The drift check against
0373bd2 (R2 merged and changed by its late pass, Uch band merged in) then changed several
«what changed» entries below; each such entry says «Now:» with its re-check id.

| Id | Verdict | What changed |
|---|---|---|
| durability-1 (blocker) | confirmed | `takenUpTo` (the highest applied message id) is written in the same state as the effect; `intakeTakes` answers `'seen'` for a redelivery; file attachment ids are `uuidv5(noteId:messageId)`; the stop SEALS the store after its flush (§6.2.3, §6.2.8, K5). |
| durability-2 | confirmed | `c:cert_y` / `c:cert_n` set the answer, and an old `c:cert` is «eskirgan»; a restart that would reopen the live collection resumes it (`openedBy`, `pressKey('restart')`); `CALC_STEP_REPEAT` per step, with `'own'` presses checked by `ownsPress` (K11, K12, §6.2.9). |
| durability-3 | confirmed | «Landed» = a `calc_requests` row with the note id. A note-only landing is KEPT by hydrate and RESUMED on the note's own card through `landRequestHalf`. `openCalcRequest` takes a per-note advisory lock and returns `existing`; not a unique index, which would fail deploy morning on an unknown duplicate (K2, K15, §6.2.15, §14). Now: no extraction — the resume calls `landIntake` again, and Uch band's `cardOfNote` / `rootRequestOfNote` make it converge on the note's card; «landed» = a ROOT row (`rootOfNoteSql`) (re-check corpus-mig-seam-5). |
| durability-4 | confirmed | The add door's save is the pg-boss job `calc.amend-save` (`singletonKey = noteId`). The press flushes and enqueues; the collection is frozen while it runs; hydrate keeps an add collection whose outcome was never told, and re-enqueues it (§9.6, §6.2.10). Now: no `singletonKey` (pg-boss 10.4.2 dedupes nothing on a standard queue); the job is enqueued `{ id, expireInSeconds: 120, retryLimit: 3 }`, and a duplicate is harmless — it answers `duplicate` off `calc_amendments_note_unique` (re-check p4-2, p1-p2-13). |
| durability-5 | confirmed | The thread message is written in the amendment's own transaction (`insertThreadMessageInTx`). `outcome_sent_at` and `announced_at` record the rest. A `duplicate` redoes only what is missing: the re-pass (`atRev`), the ping, the words (§9.5). |
| durability-6 | confirmed | The stamp moves INSIDE every machine save (`advanceHandsOffInTx`, `handsOff`), never in the settle, so a killed pass leaves it at its last committed write. The settle only clears the ticket (§10.2.2-3, K15). |
| durability-7 | confirmed | Every storage read of the reading goes through `readWithin` under the job's one wall clock (with performance-1, §7.2.1, §7.2.4.3). Verified in the text this pass: `INTAKE_FILES_BUDGET_MS` and the SUM pin (K5, §7.2.1). |
| durability-8 | partial | Already covered by performance-1's absorption: the sweep's `release_reading` judges the reading by its pg-boss job state, so a killed or expired job gets «Tahlil qilib bo‘lmadi» within minutes, not after 2 h (§6.2.13, §7.2.2). This pass keeps that path from firing on a SUCCEEDED reading (durability-16). |
| durability-9 | partial | Both jobs await `intakesHydrated(INTAKE_HYDRATE_WAIT_MS)` and throw when not ready (pg-boss re-delivers); `loadIntake` reads memory regardless of `durable`; the wait is inside the reading's SUM pin (K3, §3, §6.2.12, §7.2.1, §7.2.4.1, §9.6). |
| durability-10 | confirmed | A failed write keeps its chat dirty and is retried; each dirty chat records the update it came from (`currentUpdateId`, `oldestUnwrittenUpdate`); the stop confirms only through the update before it, and its flush gets the rest of the 5 s (K3, K15, §3, §6.2.2, §6.2.11, §17.6). |
| durability-11 | confirmed | As regression-20: `Promise.allSettled` with a `.catch` per hydrate (§6.2.10). |
| durability-12 | confirmed | (a) one end path `expireIntake`, used by the sweep and by a read that finds the collection expired, says the line once; (b) hydrate loads rows expired in the last 24 h and the nightly prune deletes older ones; (c) a backlog message is judged by its written date, and the sweep ends nothing for 2 min after boot; a press cannot be dated and is stated (§2.7, §3, §6.2.6, §6.2.10, §6.2.13, §6.2.17, §15). |
| durability-13 | refuted | Already absorbed through durability-2: every collector press asks `ownsPress` (the message ids), so an old reminder's ✖️ cannot end another collection (K11, §6.2.9). |
| durability-14 | refuted | Already absorbed through regression-5 / product-fit-5: `foreignAddReply` answers a reply to another request's ➕ message before `routeCollectorText`, and a reply to a foreign bot message is never a table answer (K11, §8.2.5, §9.6). |
| durability-15 | partial | The residue: the save job has an in-process fence per note id and its own wall clock (`AMEND_SAVE_EXPIRE_S` 120, deadline 110 s), and the card note is `INSERT … ON CONFLICT (id) DO NOTHING` (`addActivity`'s `onConflict`, K15) (§9.5, §9.6, save-job test). Now: no `onConflict` seam — the card note is written through Uch band's `insertActivityTx(tx, …)` inside the amendment's transaction, only after `calc_amendments`' INSERT returned a row, so its key can never collide (re-check corpus-mig-seam-9). |
| durability-16 | confirmed | A 429 past the brief retry enqueues a delivery-only follow-up at `retry_after + 1` (`startAfter`, K15) and returns; the last attempt never says «bo‘lmadi» over a stored reply; the sweep's `deliver_pending` is the net (K4, K8, §2.6, §3, §6.2.13, §7.2.4.7-8). |
| durability-17 | confirmed | A `routeAnswer` carrier beside `totalsAnswer`, merged by K in `analyzeCollected` and `settleAnalysis`, written by P3, reverted by the undo, read by `amendSubmissionOf` (K4, K15, §8.2.6-7, §9.5, dialog test). |
| durability-18 | confirmed | §14.3: round 4 must make the landing's TARGET idempotent by the collection's note id (stamp the new card and find it first under the note lock, or write target and note in one transaction); until then the lead path's exposure is stated in §15. Now: Uch band chose the one transaction for a coded client (`landCodedCard`, found again by `cardOfNote`); the stranger path's `createLead` → note gap stays, stated in §15 (re-check corpus-mig-seam-4). |
| durability-19 | confirmed (nit) | The reminder's claim is released on any failure but 403/400, so the next tick retries (§3, §6.2.13, sweep test). |
| durability-20 | confirmed (nit) | One row: the killed call is spent at Anthropic and not counted; §3, §16.2(2) and the §17.6 deploy drill now say the same. |
| durability-21 | refuted | Overtaken by regression-1: the doors ask `holdingIntake`, so they refuse for at most 30 minutes after the seller's last action, as today (§6.2.7). |
| regression-1 (blocker) | confirmed | The collection WAITS 24 h but HOLDS the chat only 30 min (`HOLD_MS`): a parked collection takes no text, file or contact. The four refusing doors ask `holdingIntake`; a table-shaped text gets the pause line with ▶️; a fence classifies every `activeIntake(` call (§0.1(7), §6.2.7, K3). |
| regression-2 (blocker) | confirmed | `threadReplyFromBot` returns `{ text: null }` = HANDLED, and the ladder returns on any non-null result; a test proves an armed task stays open and the assistant is never called (K6, §9.6, §9.7). |
| regression-3 (blocker) | confirmed | A number whose words name ANOTHER row is `name_mismatch` (asked, never written). In the material stage only «N:» / «N-qator» address a row. c1524-c1526 become routing cases (§8.2.4, §11). |
| regression-4 | confirmed | Save branch order: analysing guard → stage guard → `saving` → amend → `landedAlreadyReply` → landing; `intake-round1.test.ts:204` re-anchored (K11, §11). Now: K keeps the stage guard's literal verbatim; P3's commit narrows it and re-anchors :204 (re-check kernel-5). |
| regression-5 | confirmed | A reply to a bot message that is not the collection's own is never a table answer. A reply to ANOTHER request's ➕ message gets the two-card words via `foreignAddReply`, nothing written (§8.2.5, §9.6, §2.4). |
| regression-6 | confirmed | The same fix as durability-1 and durability-2 (`takenUpTo`; `cancel` / `go_*` / `cg:` keyed or `'own'`), with the redelivery block in `bot-redelivery.integration` (§6.3). |
| regression-7 | confirmed | `placeByName`'s placement is WRITTEN BACK into `lineAnswers` (`index` rewritten, `-1` = not placed this reading). Merges are keyed by `itemId` or the current placement. `carryLineDone`'s rule is carried, not retired (§8.2.1, §8.2.6, §8.2.8). |
| regression-8 | confirmed | One numbering, `TableRow.no`: `seq` for a stored row, position for a new request's line, `max(seq)+k` for an added one; the ❓ block, the table, the echo, the undo and the parser all read it (§2.1, §8.2.3). Verified in the text this pass: `no_line` is judged against the numbers SHOWN (`TableRow.no`), so «4: …» on rows 1, 3, 4 is an answer. |
| regression-9 | confirmed | The re-anchor list is DERIVED by a grep over `tests/` for every moved or retired name, before K. It already adds `intake-round1`, `intake-collector-r4`, `intake-facts`, `intake-volume`, `calc-intake.integration` and `press.test.ts` (K16, §11). This pass completed it: the retired fixture shapes (`pdfs: [{ data`, `images: [{ data`), the `'question'`-stage fixtures (c5) and the C9 drive through `skip` are in K16's grep and in §11. |
| regression-10 | confirmed | P2 owns ONE drive helper (`calc-read-drive.ts`: `enqueue` mocked, `runIntakeRead` with the captured payload); §11 lists every case that presses «Bo‘ldi» and waits (c0012, c0234, c0599, c0774, c1722, c1892, c1893, `skipThenReread` c1375/c1721, r3:334, r4:209), and K16's grep finds the rest (§7.1, §11, K16). |
| regression-11 | refuted | Already absorbed as product-fit-9: `lineOfferKeyboard` drops ⏭ (§2.2, §8.2.6). `calc-intake-lines.test.ts:25` is now named in §11 with its reason. |
| regression-12 | refuted | Already absorbed as product-fit-10: `fitTelegram(…, { maxLines: Infinity })` for the table (K15, §2.1, §8.3). |
| regression-13 | refuted | Already absorbed as durability-6: the stamp moves inside each machine save (`advanceHandsOffInTx`), so a killed pass leaves it at its last write (§10.2.2-3). |
| regression-14 | refuted | Already absorbed as performance-6: `busy` = the ticket's pg-boss job is alive, and an addition waits behind a queued landing pass instead of overwriting its ticket (§9.3, §10.2.1). |
| regression-15 | refuted | Already absorbed as law-money-4: every add and every unit/code answer goes through `doorRow`; `AMEND_REFUSAL` is a `Record` with no fallback (§9.5, §2.4). |
| regression-16 | confirmed (nit) | K15's `inTx` runs LAST and receives the save's `applied` (`measuresDropped` / `measuresCleared` / `basisConflict`); `amendChangeText(change, fileCount, applied)` names a dropped measure «yozilmadi» to the seller and in the thread (§0.1(13), §2.4, §9.5, amend test (q)). |
| regression-17 | refuted | Already absorbed as product-fit-8: «▶️ Yo‘q, davom etaman» is `c:resume` in the add door's question and in `restartKeyboard` (K7, §2.4). |
| regression-18 | partial | The voice half was missing: `refuseMediaReply`'s `calc_add` branch answers a voice note, audio or video «🎤 Ovozli xabar o‘qilmaydi — yozib yuboring.» and opens nothing (§9.6, press test). |
| regression-19 | partial | §14 now names `landCollectedIntake` (round 4's `resolveIntakeClient` / 6.8 b code) and `landIntake`'s input type as shared hunks with a resolution; K's moved functions are a frozen list sent to round 4, and K lands before round 4 branches its build; the note-before-target idempotence is in §14.3 (with durability-18). Now: round 4 shipped as Uch band and is in the base — no shared hunk to resolve, no list to send, no merge order (§14.2, §14.4) (re-check corpus-mig-seam-3). |
| regression-20 | confirmed | `Promise.allSettled` with one `.catch` per hydrate, polling after BOTH; `redelivery-wire.test.ts` re-anchored; a bot-redelivery block pins it (§6.2.10, §6.3, §11). |
| regression-21 | confirmed | `looksLikeLineAnswer` is true only when EVERY segment is an address + figures + units with at most a two-word row name; «1) 2026 oktyabr hisoboti» and a numbered question are pinned false and reach the assistant (§2.8, §8.2.4, §8.3). |
| regression-22 | confirmed | ONE home for the ⚠️ totals rows: `missingFields` minus `LINE_FIELDS` on every section; `totalsQuestion` survives only as a bare number's unit hint; `totals-question.test.ts:110` re-anchored with the reason (§2.1, §8.2.1, §8.2.3, §11). Now: `totalsQuestion` is retired too — a bare figure goes to the single open totals target by its own unit (§8.2 rule 1, re-check p3-5); the pinned test is `:130` (re-check corpus-mig-seam-11). |
| regression-23 | partial | The `pick_N` gap: picks act only from the message that drew the live offers (`offersMessageId`), `pick_N` is `'own'`; a test presses an older offer (§2.2, K4, K12, §8.2.6). |
| regression-24 | confirmed (nit) | `backlogSentence(hasCollection)`: «Hisoblatish» leaves the sentence only for a chat with a live collection, since a collection can still be lost (first deploy, probe false, failed write) (§2.7, §6.2.16). |
| regression-25 | confirmed (nit) | The stop's flush gets the rest of the 5 s, and an unwritten change keeps its update unconfirmed (`oldestUnwrittenUpdate`, K15's `unwritten` dep); measured in §17.6 (with durability-10). |
| regression-26 | refuted | Already absorbed as performance-5: `tableHash`, and «message is not modified» is success (§2.2, §8.2.9). |
| product-fit-1 (blocker) | confirmed | Unaddressed parse order: figures with no goods word → an ANSWER to the one fitting row, before any material test. `looksLikeMaterial` only for a multi-line typed list. The address pattern accepts «3-qatorga» (§8.2.4). |
| product-fit-2 | partial | Every echo that wrote something names what is still missing and carries the confirm button; the table closes with «Bilmagan qatoringizni VED to‘ldiradi …» (§2.1, §2.2). The overstated half (the table is right above the echo in the reply path) is noted; the fix stands. |
| product-fit-3 | confirmed | An add collection's `preferred` targets are the law-asked rows (`askedSeqs`, from P5's `lawAsksOf`); within any open set a unit picks its row («40 juft» → the juft row) (§8.2.4, §9.2). |
| product-fit-4 | confirmed | `seq` numbering everywhere a stored row is named (as regression-8), with a test after a VED deletion (§8.3). |
| product-fit-5 | confirmed | As regression-5: the reply's own target decides, with `cg:<B>` / `c:resume` buttons (§2.4). |
| product-fit-6 | confirmed | `busy` is no longer a refusal. The addition is STORED as `'waiting'` and written by the job when the pass settles (`requeueWaitingAmendments`, plus the sweep as the net). Both texts keep the promise (§2.4, §9.5, §10.2.2). |
| product-fit-7 | confirmed | The returned branch's words no longer promise a reopen. Question 6 asks him; ⭐ a: «➕» opens a NEW collection seeded with the request's rows, landed by the landing's rules (§2.4, §9.2, §14). Now: those rules are Uch band's — a coded client's re-send is a NEW deal beside the returned one (re-check corpus-mig-seam-8). |
| product-fit-8 | confirmed | «▶️ Yo‘q, davom etaman» (re-check v1-8) is `c:resume` in the add door's question AND in `restartKeyboard` (K7, a stated K change). |
| product-fit-9 | confirmed | `lineOfferKeyboard` drops ⏭; multi-row offers name their row; a picked offer goes through `applyTableAnswer`, so it gets its own echo and ↩️ (§2.2, §8.2.6). |
| product-fit-10 | confirmed | `fitTelegram` takes `maxLines`; the table passes `Infinity`, the reply keeps 25; a test shows 40 short rows (K15, §2.1, §8.3). This pass completed it: over 4096, ⚠️ rows sharing an identical ↳ get ONE grouped ↳ with ranges, a ⚠️ row and its ↳ are one entry, and the last resort says to send the Excel (§2.1, `intake-table.test.ts`). |
| product-fit-11 | confirmed | The undo finds the row where the answer is NOW (`itemId`, else the `lineAnswers` entry at its written-back index), never at the echo's old index; a test moves Sumka from row 3 to 5 and undoes (§2.3, §8.2.7, `calc-undo.test.ts`). |
| product-fit-12 | partial | «✖️ Bekor qilish» from the table, add table, echo or restart question asks once when the collection holds something («Hammasi o‘chadi: 3 ta xabar, 2 ta fayl»); from the reminder it ends at once; the undo is renamed «↩️ Shu javobni bekor qilish» (§0.1(12), §2.2, §2.7, K6 `pressCancel`, §8.2.12). |
| product-fit-13 | partial | The open half: «-dagi» and any suffix after «qator», ordinals («3-chi», «3chi»), Russian («строка 3», «3 строка», «стр. 3»), and the name read before OR after the figures («50 dona sumka»); all in `line-address.test.ts` with red proofs (§8.2.4, §8.3). |
| product-fit-14 | confirmed | ONE exported `TOTALS_WORDS` with the table's own labels (og‘irligi, hajmi, vazni, brutto/брутто, вес, объём, obshiy …); the parser and the orphan guard (`looksLikeTableAnswer`) ask it, so «jami 3500 kg» never reaches the assistant after expiry (§1, §2.8, §8.2.4, §8.2.11). |
| product-fit-15 | confirmed | A decision his answers do not settle → Question 7 (1.20). ⭐ a: an `amend:*` pass's answer is sent straight to a requester who muted «Ish jarayoni» (`sayOnce(…, { direct })` + the drain's `mutedFor`); b keeps the mute and makes the words say so (§0.1(6), §2.4, §10.2.5, K15). Now: the group he mutes is «✅ Mening vazifalarim» (`MUTE_GROUPS.tasks`); no `mutedFor` export and no second sender — `sayOnce`'s `direct` queues the muted seller's row `pending` (`StaffTelegramInput.ignoreMute`) and the DRAIN sends it, writing `payload.tg` as for every sent row (re-check p5-p6-8). |
| product-fit-16 | confirmed | Door B's «📌» keyboard gains `➕ {card} so‘roviga qo‘shish` (`cf:<id>`) and a plain file with nothing open gets one offer line, while the seller has an open request from the last 7 days; the press takes the replied message as material (K10-K12 seams, §2.4, §9.2, `amend-offer.test.ts`). |
| product-fit-17 | partial | A top-up of the same goods is asked with his 1.13 c buttons: «qo‘shilsin» (Σ), «o‘rniga», «VED hal qilsin» (default VED); a figure in a field the stored row has EMPTY is a conflict too (`stored: null`), never silently dropped (§0.1(9), §2.1, §9.4, `pressConflict`). |
| product-fit-18 | confirmed (nit) | `standingAtOpen === 'started'`: the echo says «📝 VED ga yuboriladi», the button «📨 VED ga yuborish»; `to_ved`/`started` says «VED ga yuborildi» instead of the ambiguous «unga» (§2.2, §2.4, §8.2.6). |
| product-fit-19 | confirmed (nit) | (a) «alohida satrga yozing (yoki «;» bilan)»; (b) «son kerak» under ⭐ b, «o‘lchov kerak» under a — now «o‘lchov kerak», his 1.14 a (re-check laws-print-23); (c) «sof og‘irligi» verbatim from `lineNeedText`; (d) «🗑 Ha, uni o‘chirib qo‘shimchaga o‘tamiz»; (e) the end and orphan sentences name «✅ yoki AI javobi ostidagi ➕» (§2.1, §2.4, §2.5, §2.7, §2.8). |
| product-fit-20 | confirmed (nit) | On the AI door every echo carrying «✅ Tasdiqlash» prints «📄 Sertifikat: bor|yo‘q» and carries the `cert_y`/`cert_n` button (§2.2, §8.2.6). |
| product-fit-21 | partial | Question 1 asked him; he answered **a** (2026-10-27): every law-pinned unit is asked, no filter (Questions, §10.2.6, §16.1). |
| law-money-1 (blocker) | confirmed | `amendTotalsStale` (one home). A stored m³ that is the lines' Σ is re-summed after an addition (MR-9's denominator follows); a typed m³, and brutto on any added line, read ⚠️ «yangilansinmi?». The amend pass withholds freight on a stale total (§0.1(2), §9.5, §10.2.9). |
| law-money-2 | confirmed | The chain starts from the job's ticket. The claim, `applyProposal`, `pullRatesFromDictionary` and `priceProposedGroups` are under `expectRev`, and each returns its `rev`. R2's two `prefillTicket` reads are removed. Every machine save stamps itself only from the revision it expected (K15, §10.2.3). Now: R2's late pass already chains `expectRev` from `data.rev`; K adds only `handsOff`, and P5 deletes the two null fallbacks (prefill.ts:327, :411); `prefillTicket` stays exported (re-check p5-p6-2). |
| law-money-3 | confirmed | New package P6: «Готово», a group's ✅, «✅ Hammasini» and the seal take a REQUIRED `sawRev` and refuse `amended_since` when a seller's APPLIED addition landed after it; one i18n key ×4 (§10A, §12). |
| law-money-4 | confirmed | Every add, and every unit/code answer, goes through `doorRow`. `AMEND_REFUSAL` is a `Record<SaveTableRefusal, string>` over the codes `saveTable` throws, with no `??` fallback (§2.4, §9.5). |
| law-money-5 | confirmed | A restated row with a different figure is a CONFLICT (⚠️, asked, named to the VED, never written). An addition that changes no row is `'noted'`: card + thread, no rev move, no re-pass, honest words (§2.1, §2.4, §9.4, §9.5). |
| law-money-6 | confirmed | `cargo` / `totals` / `route` are present-keys-only patches, and the type admits no `null` (`cargoPatchOf`, K13, K15). Verified in the text this pass (K13, K15; amend test (o)). |
| law-money-7 | confirmed (nit) | `already_closed` → `to_ved`/`closed` with `completedVia` re-read; `ai_running` re-reads the standing: a machine ticket → `waiting`, a person's ✨ → `to_ved`/`started`. Neither reaches «birozdan keyin qayta bosing» (§2.4's `AMEND_REFUSAL`, §9.5, amend test (p)). |
| law-money-8 | refuted | Already absorbed as product-fit-7: the returned branch never promises a reopen, and Question 6 a opens a NEW collection (§2.4, §9.2). |
| law-money-9 | refuted | Already absorbed as regression-8 / product-fit-4: one numbering, `TableRow.no` = `seq` for a stored row, `max(seq)+k` for an added line, with the deletion test in `line-address.test.ts` and `law-asks.test.ts`. |
| performance-1 (blocker) | confirmed | ONE wall clock: files ≤ 30 s (`readWithin`), the model's leash shrinks to what is left, delivery bounded at 10 s per send, expiry 300 s, the SUM pinned. An in-process token fence; the job id is kept and the sweep releases a dead reading; «the token is the fence» is deleted (§7.2.1-2, §7.2.4). |
| performance-2 | confirmed | Writes are DEBOUNCED per chat (1 s quiet, 5 s max), not one chain step per update. Test (c) drives an awaited fake Telegram call between updates (§6.2.2, §6.3). |
| performance-3 | confirmed | `INTAKE_READ_WORKERS = 4`, `batchSize` 1, pinned; `ANALYSIS_STALE_MS` allows for queue wait (§7.2.1-2). |
| performance-4 | partial | The model-sized JPEG is stored at arrival as a derived object and read first; the job re-reduces only on a miss (§7.2.4.3, §7.2.8). The overstated magnitude is noted: a `message.photo` is already Telegram-compressed, and sharp runs on libvips' pool. |
| performance-5 | confirmed | The table edit is `void`, per chat, latest wins. An identical render is skipped (`tableHash`), and «message is not modified» counts as success, never a resend (§2.2, §8.2.9). |
| performance-6 | confirmed | `busy` = the ticket's pg-boss job is alive (`ai_pass_job`, `ticketStanding`), never a 35-minute window. While it is alive an addition WAITS, so the landing pass can no longer stand down over the seller's own addition (§9.3, §10.2.1, §13). |
| performance-7 | confirmed | `loadIntake` reads MEMORY only, after awaiting `intakesHydrated`; the table fallback that could resurrect an ended collection is gone (K3, §6.2.12, test (j)). |
| performance-8 | confirmed (nit) | The `expires_at` index is dropped (every write changed the indexed column, ruling out HOT); the column stays, unindexed, for the CHECK and the prune (§13). |
| performance-9 | confirmed (nit) | `storedRequestFacts` is ≤ 4 statements and never `loadWorkspace` (pinned in `amend-wire.test.ts`); `aiPrefill` builds `lawAsksOf`'s input from its own `ws` (`lawAsksInputOf`), and a test pins both adapters equal (K14, §10.2.6). |
| performance-10 | confirmed (nit) | `flushIntakeWrites(chatId)`: a press and a job await THEIR chat's write only, and the boolean speaks for that chat; §1 restated; test (h) (K3, §1, §6.2.2, §7.2.3, §9.6). |

**What the judging changed in shape**, beyond the line fixes:
- a sixth package (P6) for the VED's doors;
- 0137 grows (`calc_requests.ai_pass_job`; `calc_amendments` gains `chat_id`,
  `submission`, `outcome_sent_at`, `announced_at`, and the `'waiting'` / `'noted'` outcomes)
  and loses the `expires_at` index (re-check kernel-1);
- one i18n key;
- three stated behaviour changes in K, and these inert K seams added by the second pass: the
  stop's `unwritten` dep and `currentUpdateId` (lifecycle), `intakesHydrated`,
  `flushIntakeWrites(chatId)`, `oldestUnwrittenUpdate`, the `routeAnswer` merge, `startAfter`
  on `enqueue`, `inTx`'s `applied`, Door B's and the media handler's offer calls,
  `pressCancel` / `pressConflict`, and the `cf:` prefix with the `cancel_y` / `conf_N_*`
  steps. The draft's `addActivity` `onConflict` and exported `mutedFor` are gone: the card
  note goes through `insertActivityTx` (re-check corpus-mig-seam-9) and the re-run's muted
  answer through `StaffTelegramInput.ignoreMute` and the drain (re-check p5-p6-8);
- seven questions for the owner (1.14-1.20); his answer «14 a, qolgani seni taklifing» —
  1.14's ⭐ is now (a), the rest the ⭐ (re-check laws-print-23).

---

## 19. Re-checked against the tree before code (2026-10-28)

**Why.** This spec was written on R2's SPEC TEXT while R2 was still being built. Since then
R2 was built, reviewed and changed by its late pass (docs/SAKKIZ-R2.md §16-§17), and the
other session's Uch band (docs/UCH-BAND.md, migration 0136 `lead_client_many`, DECISIONS
#1469-#1478) was merged in. The tree the round is built on is 0373bd2. A drift check compared
every claim here with that tree; seven amenders (A-G, one per part) fixed their parts against
one cross-section ruling list; three verifiers then re-read the amended text against the tree
and the residuals were re-checked one by one. His answers and the design's intent did not
move; every amended spot carries «(re-check <id>)».

**Counts.**
- Drift check: **114 distinct findings — 9 blockers, 44 defects, 61 nits** (169 raw, 55 of
  them duplicates of another).
- Amendment (ledgers A-G, 198 entries over the 114): **112 applied, 2 partial, 0 rejected**.
  p5-p6-10 counts as applied: B's «partial» was «nothing in §5 to edit», and A (§2.5) and F
  (§10.1, §10.3) applied it.
- Residual round (three verifiers, 30 items: v1 10, v2 15, v3 5): **29 applied, 1 partial,
  0 rejected**. New K seams from it, all inert in K: `fileOf` (calc-files.ts, v1-3),
  `noteOwnMessage` (calc-store.ts, v2-8), `savingAlive` / `releaseDeadSave` (calc-amend.ts,
  v2-6); K6 also moves R2's four collector words into calc-dialog.ts (v1-4, v2-2).

**Partial, each with its reason.**
- kernel-8 (defect): `routeAnswer` carries R2's `at` mark and is merged like `totalsAnswer`
  (K4, K15, X9). Not adopted: the finding's extra «a doubted city is said» entry — X9's
  binding text lets the reading's city stand, with no new doubt kind.
- p1-p2-26 (nit): a landing whose note committed but whose request was refused (`queueError`)
  still ends the collection; stated in §6.2.15 and §15. Not adopted: keeping it, which needs
  K11's frozen save branch and new Uzbek words.
- v3-0 (residual): the thread door's `opened.existing` exit queues the pass like the root
  branch (§10.2.1). The verifier's premise was half wrong: on a DEAL or LEAD card the note
  commits with the request, so a sequential resend is refused `note_taken` by the pooled
  check (service.ts:378-383) and never reaches `opened.existing`. That cut is stated in §15,
  like the card form, and pinned in §10.3; Uch band's double-press fence is not reopened.

**Rejected:** none — in the amendment and in the residual round.

**Cross-section decisions (CROSS.json), one line each.**
- X1: the migration is `calc_intake_durable`, 0137 on the branch (idx 137, `when` …117) and 0138 after the merge (main's `0137_plan_road` holds …116); the ledger reads 139 (K-review spec-5).
- X2: base 0373bd2 (R2's kernel 1131998); «round 4» as the landing's owner is Uch band, shipped.
- X3: `sayOnce(requestId, pass, input, opts)` — pass positional; R2's `whileOpen`, CONC-4 and perf-5 kept.
- X4: a muted seller's re-run answer goes through the notification drain (`ignoreMute`), never a second sender.
- X5: the re-run word `RERUN_WORD` goes AFTER the title phrase; the lenta's head anchors stay whole.
- X6: three seller tails become audience-keyed (`chat` / `lenta`) in the files that hold them.
- X7: the weight row is R2's `weightLabel`; the ⚠️ row keeps `FIELD_LABEL.weightKg`.
- X8: doubts are R2's `TotalDoubt`, worded by `ambiguousTotalText`, one wording everywhere.
- X9: a totals table answer is R2's CONC-2 `totalsAnswer` with its `at`; the undo restores it whole; `routeAnswer` gets the mark.
- X10: `orphanAnswerSentence` is async; R2's gate kept, `holdingIntake` for `!activeIntake`; parked → the pause line.
- X11: no «eskirgan» sentence for a press with no collection — Uch band's conc-13 sentence, verbatim.
- X12: no `landRequestHalf`; Uch band's `cardOfNote` / `rootRequestOfNote` make the landing idempotent per note.
- X13: K2's per-note lock kept, built on Uch band's order inside `openCalcRequest`.
- X14: Uch band's retry exits become `retried(requestId)` — attach (P2), queue at `atRev: 0` and stage move (P5).
- X15: `landingReplyText` is pure; the caller passes the link; the body is today's string.
- X16: Q6 a's re-send lands through `landIntake`; Uch band decides the card (v1-5: a lead is joined).
- X17: the add door's note goes in the same tx as its `calc_amendments` row, after it, via `insertActivityTx`.
- X18: no `announceThread`; the thread writer is `addThreadMessage` + `announceNote`.
- X19: `enqueue` gains `id`, `startAfter`, a job-id return and `jobState`; no `singletonKey`.
- X20: billing moves to the reading job (P2), dated by `AnsweredUsage.at`, with the usage list's removal in the same commit.
- X21: `storedRequestFacts` reuses service.ts's stored-request reader, R2's regression-3 flags and the ending.
- X22: shared test helpers live in `tests/fixtures/`; the re-anchor grep runs on 0373bd2.
- X23: `CALC_STEP_REPEAT` is a Record over `CalcStep`; redelivery-wire (10) re-anchored, no second test.
- X24: two ctx types (`CalcPressCtx`, `PressCtx`); the «bare `{ reply }` fakes compile» claim was corrected by v1-1 (intake-confirm's fake changes mechanically).
- X25: the new refusal's fence is a derived `calc-error-words.test.ts` over every literal `new CalcError(…)`.
- X26: R2's late pass already chains `expectRev`; this round adds `handsOff` beside it and deletes the `prefillTicket` fallbacks.
- X27: §14 is no longer a seam with a parallel session; Uch band's landing names are fenced from the add door.
- X28: his 1.14 a — the block says «o‘lchov», not «son».
- X29: one night rule, the shipped `quietHour` (22:00-08:00); the reminder never sleeps.
- X30: K keeps every R2 shape P3 retires; P3's retirement hunks in other packages' files are named (v2-1, v2-2 completed the list).
- X31: the small K seams' names and anchors fixed once.
- X32: `backlogSentence` is P1's new function; `tellBacklogOnce` decides it from the store.
- X33: `calc_requests` has no `created_at`; the offer reads `requested_at`; no new index.
- X34: `intakeSummaryText` has five test readers; each moves to `intakeTableText`.

**The lead's calls (LEAD.json), one line each.**
1. `sayOnce`'s pass is positional and required; the landing passes `'landing'`; `whileOpen` as R2 shipped it.
2. The direct send to a muted seller (Q7 a) goes through the drain with an explicit flag, never a sender after commit.
3. A bare figure with a PARKED collection → the pause line; with none, R2's REG-3 split and gate stand.
4. `landingReplyText` is synchronous and pure; the caller passes the link.
5. Q6 a: the re-sent request lands where Uch band puts it — no special landing for this door (a coded client's deal is new; a lead may be joined, v1-5).
6. The add door's note dedupe: the `calc_amendments` row first (unique `note_id`), then the card note, one tx.
7. A reading's `createdAt` is the day the model answered (`AnsweredUsage.at`).
8. The 2-hour reminder at night: the shipped `quietHour` (22:00), told to him with the reason.
9. `CALC_STEP_REPEAT` is a Record over the step union; the existing pins re-anchored.
10. The doubted-totals wording: one, picked by the cross pass (X8), verbatim everywhere.
