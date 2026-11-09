# Ikki eshik — «🧮 Hisoblatish» and «🤖 AI rastamojka» made two doors (2026-11-08)

His report the day after round 3 reached production (ledger 140), verbatim:

> «1 chi muammo har bir fayl uchun sorayabti va tushunarsz holatga olib kelyabti men sendan soragan
> narsam shu ediki, AI rastamojkada hsoblatganda hamma malumotlarni bergandan keyin boldini bosganida
> ai tahlil qilib chiqib hamma malumot toliq bolsa tasdiq, agar toliq bolmasa nima malumotlar kerak
> ekanini sorashi kerak edi shularni kirgazib tasdiqni bosganda ai hsoblab berishi kerak. oddiy
> hsoblatishdan kirib borganida hamma malumotlarni kirgazib tasdiqni bosganida shunday turishicha ved
> hodimiga tushsin ai bergan komentariya bilan birga.»

The six questions as sent, and his answer «sen aytgandek bolsin», which takes every ⭐:

1. **Several files.** a) ⭐ The bot does not ask; the AI compares the files itself. The same goods
   are taken once, new goods are added, and a packing list is read for weight and cube only. What
   the AI did is written on the card for the VED.
2. **Plain «🧮».** a) ⭐ «Bo‘ldi» → a short summary with no questions → «✅ Tasdiqlash» → the job
   lands at the VED with the AI's commentary. A missing brutto or cube is the VED's to ask.
3. **Plain «🧮»'s AI estimate.** a) ⭐ It does not reach the seller. The AI only prepares the card
   for the VED: codes, rates, commentary.
4. **«🤖 AI rastamojka».** a) ⭐ «Bo‘ldi» → the AI analyses → ONE table. If complete: «Ma’lumot
   to‘liq — tasdiqlang». If incomplete: what is needed. An answer sends no message of its own; the
   table updates. «Tasdiqlash» → the AI computes.
5. **«🤖»'s law unit (dona/juft).** a) ⭐ The AI codes the rows while reading, so the unit is asked
   once, in the table. The AI answer after «Tasdiqlash» asks nothing; what is still missing goes to
   the VED.
6. **Files sent with no collection open.** a) ⭐ The offers stay, but files sent in a row get ONE
   question.

**The diagnosis** is the reproduction of 2026-11-08 (scratchpad r4fix/diag: ord.json, aidoor.json,
perfile.json, doors.json). Both doors were ONE collector: `IntakeState.ai` was read only by the
certificate control. Both doors:
- asked about each file while collecting;
- refused «Bo‘ldi» once for each open file question;
- drew the asking table;
- sent an echo per answer;
- after the landing, sent the seller the AI-VED answer, which carried a second ask.

None of those asks was his choice for a particular door. Every question behind them (1.10, 1.11,
1.13, 2.7, 2.8) named no door and was taken as ⭐, and RASTAMOJKA-TUZATISH P1.3 made the plain door
ask by design. **This file supersedes those questions for the bot's two doors.** The card form,
the thread door, the AI sotuvchi and the VED's screens are untouched.

Numbering: DECISIONS #1582+, migration **0140** (`when` …119), ledger **141**.

**v2 (2026-11-09).** Five lenses judged v1 before code: durability, money-ved, words, feasibility
and intent, with two refuters per objection. 55 objections were confirmed (6 blockers, 43 defects,
6 nits), and every one is absorbed below. §8 maps each objection to where it is answered. Where two
fixes disagreed, §8 also says why one was not taken.

---

## §0 The door is a fact of the request

0.1 **Migration 0140** adds `calc_requests.intake_door text NULL`, CHECK `IN ('plain','ai')`.
- `CalcRequestInput.intakeDoor: 'plain' | 'ai' | null` is REQUIRED and written in
  `openCalcRequest`'s INSERT, so every caller fails to compile until it names its door.
- The bot's collector passes 'plain' or 'ai' through `landIntake`, which takes the door as a
  REQUIRED input.
- The card form, the thread door and the AI sotuvchi pass **null**. For the AI sotuvchi
  (`agent/decide.ts`) that covers BOTH its paths: `landIntake` and `requeueLanded`.
- `recalcFromSealed` copies `intake_door` the way it copies `source`.
- 0140 also widens `telegram_chat_waits_kind_check` with `'burst'` (§4.1), as 0138 widened it.

0.2 **NULL is legacy and means TODAY's behaviour on every reader.** Every request in production is
NULL, the AI-door ones included. On NULL:
- the pass replies, respecting the seller's mutes, with today's words;
- an add or seeded collection opens with its collection's stored flag;
- the tails and refusals keep today's words.

Only `'plain'` silences anything, and only `'ai'` passes a mute. So the card form, the thread door
and the agent stay as they are, as §5 promises. A test pins that an agent-landed request still
announces the estimate to its owner (his Q5 ⭐ c).

0.3 **Readers take the door from the ROW, never from a job payload.** A pg-boss job queued before
0140, or re-queued by `retried()`, carries none.
- The pass reads the door in `prefillStanding`'s existing request read.
- `direct` (jobs.ts:303-310) becomes `pass.startsWith('amend:') || door === 'ai'`.
- `storedRequestFacts`/`AmendBase` carry the door for the ➕ door and the seeded door. `openDoor` and
  `openSeeded` derive the collection's `ai` from it: 'plain' gives false, 'ai' gives true, and NULL
  keeps the flag today's code would set.
- A seeded collection lands with its source's door. An add collection is judged by its request's
  door.
- An add collection already hydrated at deploy keeps its stored flag.

0.4 **Code that runs ahead of the migration (#472).** The column is probed once per process, in the
`intakeTableReady` idiom (calc-store.ts:151-164). While the column is missing, the INSERT leaves it
out and every reader reads NULL. A landing is never refused 'server_behind' because 0140 is late.

## §1 Shared by both doors: no question per file (his 1a)

1.1 **No file asks anything.** On both doors and in the ➕ add collection, these go:
- The second-Excel question («Oldingi faylda N ta tovar bor. Nima qilamiz?», `c:inv_add` /
  `c:inv_replace`).
- The other-files question («AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?», `c:other_add` /
  `c:other_same`).
- «Bo‘ldi»'s refusals for those two («Avval ikkinchi fayl haqida javob bering», «Avval javob
  bering: …»).
- The add door's per-row conflict question («faylda 200 dona, so‘rovda 300 — qo‘shilsinmi, o‘rniga
  yoki VED hal qilsinmi?», his 1.13 c buttons).
  - The stored figure stands, the file's figure goes on the card note for the VED, and the choice
    is 'ved' (R3 interp 9's unanswered default).
  - The summary or table names it in one line: «↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi».

«Bo‘ldi» is never refused because of a file. New code only WRITES `aiGoods: 'add'`; the type and
`pickGoods` keep `null`, `'context'` and `'ask'`, so a hydrated old collection still reads (§1.3).

1.2 **The rule that replaces the seller's choice.** The bot decides, and names what it did.

1.2.1 **A mapped Excel is classified by its COLUMNS, never by its line names.** The reader
(`goods-import.ts`) already finds a carton column (`cartonCol`), a gross weight (`GROSS_HEADER`), a
net weight (`isNetWeight`) and money columns. `parseGoods` now also returns, per mapped sheet:
- `shape: 'invoice' | 'packing'`. 'packing' = a carton or gross column and NO money column. A sheet
  with a money column, or with neither, is 'invoice'.
- `weightKind: 'net' | 'gross' | 'plain' | null`: which column the line weights came from.
- `grossKg`: Σ of a gross column over all rows. It is null when any row lacks the figure. It is
  reported even when the line weights were taken from a net column.
- `volumeM3`: Σ of the m³ column over all rows, or null (`linesVolumeM3`'s all-or-none).

This is a reader change, so the WHOLE corpus runs first (`parseGoodsCases`, `readGoodsFileCases`)
and the ratchet holds. `goods-import.ts` and `goods-file.ts` join §5's list.

1.2.2 **A first collection** (neither an add nor seeded):
- **The first mapped Excel is the goods list**, as today, whatever its shape.
- **A packing-shaped further Excel gives TOTALS and fills gaps.** It never adds a row and never sets
  a count; its «мест» is cartons, never pieces.
  - Brutto = its `grossKg`. With no gross column there is no brutto. A Σ from a net column is offered
    as a netto (`weightNetto: true`), which `totalWeightFrom` already refuses as the freight total
    where the section needs brutto.
  - Cube = its `volumeM3`.
  - Its whole text joins `invoiceTexts`. The model reads a «TOTAL G.W.» row there under the
    totals-only heading, as it already does for a workbook's other sheets (F1 a).
  - A held row with NO weight takes the packing list's matching line weight (matched by the
    same-row test below), **but only from a NET column**. Never from gross, never over a stated
    figure, and the note says so.
  - The figures it gives are stored durably in a new `fileTotals` (1.2.5), never in `facts` alone.
- **A packing-shaped FIRST file followed by an invoice-shaped one.** The invoice takes the goods
  role. The packing list's rows become its `fileTotals` and gap fills. File order never decides
  which counts land.
- **An invoice-shaped further Excel** is compared row by row with the held rows:
  - **The same row again** needs all three: the names meet (`goodsNameKeys`: the whole name or
    `namesMeet`), at least one same-unit figure is shared, and every shared same-unit figure agrees.
    A carton count is never compared with pieces, and a gross weight never with a netto. The row is
    dropped as a duplicate. The held row's own figures stand, and it takes what it lacks from the
    duplicate: code, unit, measure, amount, currency.
  - **Names that do not meet, with matching figures.** If count AND weight are both present, in the
    same units, and equal exactly ONE held row's, that is also the same row. The note names it:
    «nomi boshqacha, raqamlari bir xil — bitta deb olindi».
  - **Anything else is ADDED.** That includes a same-named row whose figures disagree or share
    nothing. An added row is visible in the VED's workspace and takes one press to delete; a dropped
    line is silent. A same-named row added this way is named: «📄 «B.xlsx» — «Kurtka» 200 dona:
    birinchi faylda ham «Kurtka» 300 — ikkalasi olindi (bir xil bo‘lsa, VED bittasini o‘chiradi).»
  - This is a separate comparison, `sameRowAgain`. `sameGoodsLine` stays as it is for `pickGoods`
    and the add door (F3).
- **As built after the review** (PF-ADV-1..7, PF-SPEC-1):
  - A money HEADER is a money column whether or not the amount took it, and a unit price is never
    the unit column («Qty | Unit price | Amount», «Цена за ед.», «单价»).
  - Two weight columns of one kind (a «PER CTN» pair beside the «TOTAL» pair) are told apart by
    their Σ: the line's is the heaviest; a gross column never beats a plain one for the line's
    weight; a brutto lighter than the lines' netto is no brutto.
  - A list the reader stopped at its row ceiling sums nothing. «小计» / «共计» rows are arithmetic.
  - Any header counting packages («Cartons», «CTNS», «Мест») is a carton column for the shape.
  - A packing-shaped file gives totals only when its rows ARE the held goods (`packingOfHeld`:
    more than half of its rows meet a different held row, or the two lists count the same pieces);
    otherwise it is another factory's list, folded as an invoice, and its totals are not the
    shipment's. The packing-first hand-over asks the same of the invoice.
  - The same Excel again (every row identical, its other sheets already held) adds nothing:
    «📄 «A.xlsx» — bu fayl avval yuborilgan: qatorlari bir marta olindi.»
  - Two NAMES are one row by their figures only when the weights agree to the gram or within
    0.5 % (`twinWeight`), never «under 1 kg apart».
- **A model-read DOCUMENT beside an Excel** (a PDF, or a header-less sheet) takes the
  `aiGoods: 'add'` path. These are the files that used to be asked about.
  - The model is shown the Excel's list as `knownGoods` and told to list only goods not on it.
  - `pickGoods`' same-line dedup then drops repeats.
  - A model line whose count and weight equal exactly one Excel row's is that row (M1 c).
- **Photos and typed text beside an Excel keep today's rule.** The Excel answers, and the extra
  lines are NAMED in the bot's note, never added: «Rasmda/yozuvda Excel’da yo‘q tovar: … — VED
  tekshiradi». Photos were never asked about; making them `add` would count goods twice (M3).

1.2.3 **An add or seeded collection** compares its files with the request's kept rows through R3's
`addReading`/`conflictOf`, unchanged.
- Totals in top-up material are NOT written; R3 interp 2 holds.
- A packing-shaped file there is a «noted» file: its totals go on the note for the VED, and its
  rows change no row and become no line — not even as a first file (review PF-SPEC-2).
- A conflict is never asked (1.1). On both doors it defaults to 'ved' at the save
  (calc-intake.ts:128-140, calc-amend.ts:219).

1.2.4 **The notes**, in the code's own wording conventions (P11):
- «📄 «packing.xlsx» — o‘sha tovarlar: qatorlar oldingi fayldan, bundan faqat umumiy brutto va kub
  olindi.»
- When the packing list has no gross column: «… faqat kub olindi; brutto ustuni yo‘q.»
- When nothing was read: «… jami o‘qilmadi — VED fayldan ko‘radi.» A note names only what was
  actually read.
- «📄 «zavod2.xlsx» — 3 ta yangi tovar qo‘shildi.»
- «📄 «zavod2.xlsx» — 2 tasi ro‘yxatda bor edi, 3 ta yangi tovar qo‘shildi.»
- «🤖 AI o‘qigan fayllardan 2 ta yangi tovar qo‘shildi (3 tasi Excel’da bor edi).» The model-read
  file may be a photo or a header-less sheet, not only a PDF, so the note does not say «PDF dan».
- «🤖 AI o‘qigan fayllardagi tovarlar Excel’da bor.»
- The «bir xil deb qo‘shilmadi» line loses its ⚠️, because this is now the designed outcome: «📄 2 ta
  qator Excel’dagi bilan bir xil — bir marta olindi: …».

1.2.5 **Where the decisions are kept, durably** (DR-9). There are two new optional collection
fields; a row hydrated without them reads null and [].
- **`fileTotals: { weightKg, volumeM3, weightNetto, label, at: TotalsMark, clash? } | null`**,
  written in the same patch as the file.
  - **Rank, as built** (review PF-SPEC-7): `totalsAnswer` on top, doubted by typed material that
    came AFTER it and by a LATER `fileTotals` (R2 CONC-2); then the seller's typed figure; then
    `fileTotals`; then the model.
  - A `totalsAnswer` older than a later `fileTotals` is doubted through `totalsDoubts` (the `at`
    mark), exactly as later material doubts it. The mark is the packing list's OWN, kept on its
    file (`GoodsFileMeta.at`): a packing list that came first hands over the mark it arrived with,
    so an answer given with it in front of the seller is not doubted by it (review PF-ADV-9).
  - A figure two packing lists disagree on stays the VED's (`clash`): a third list does not
    settle it, and the model's figure does not land in its place (review PF-ADV-8).
  - On the AI door, a figure the packing list gave is never asked again (INT-10).
- **`fileNotes: string[]`** holds the RECEIPT-time notes: the Excel-vs-Excel decisions, «N ta tovar
  o‘qildi», «rasm sifatida o‘qiladi», and the reader's cut and size warnings.
  - It is written in the same patch as the file.
  - It survives `settleAnalysis` through `...live`.
  - It lands on the card note ahead of `notes` and `steps` (staff-bot.ts:1511).
- READING-time notes (the model-vs-Excel dedup) stay in `state.notes`, which the summary, the table
  and the card note already print.

The model never decides a price, and nothing here touches money.

1.3 **Collections already open when this deploys** (they are durable for 24 h) may hold
`pendingInvoice` or `aiGoods: 'ask'`.
- **One place resolves them**: a pure `migrateIntakeState(row)`, run in `hydrateIntakes` before
  `store.collections.set`.
  - It applies 1.2.2 to `pendingInvoice` and turns `'ask'` into `'add'`.
  - It leaves `'context'` and `'add'` as they are. 'context' was the seller's own answer, and
    `pickGoods` keeps its branch.
  - After the hydrate, nothing is pending.
- **Every retired callback stays PARSED**, because an unparsed callback spins for ~15 s (#939):
  - `inv_add`, `inv_replace`, `other_add`, `other_same` and the add door's conflict buttons answer
    «Bu tugma eskirgan — fayllar o‘zi solishtirildi.»;
  - `cu:<tag>` undoes while its hydrated echo exists, as today;
  - `pick_N` on a plain collection answers «Bu tugma eskirgan.».
- A unit test pins this: it hydrates one row with `pendingInvoice`, `aiGoods:'ask'` and
  `aiGoods:'context'`, then presses «Bo‘ldi».
- A plain collection already in 'review' at deploy holds today's asking table. Typed answers to it
  go through §2.2's silent write, never into material.

1.4 **ONE prompt, always the last message** (DR-10, P1, P11, F11, P12).
- **A file gets its own message only for a REFUSAL**: HEIC, Word, video, archive, too big, the 4th
  PDF, a broken sheet, a save failure.
- **Everything informational becomes a line of the ONE «Qabul qilindi: …» prompt**: «📄 … N ta tovar
  o‘qildi», «🖼 … rasm sifatida o‘qiladi», «📄 … AI o‘qiydi», the 1.2.4 receipt-time notes, and the
  reader's cut and size warnings.
- **The prompt is a PURE function of durable state.** It shows:
  - the counts;
  - one line per file: `pdfs[].name`; `sheetTexts[].label` with its current fit (`fitSheetRows`
    over `sheetTexts` plus `invoiceTexts`, at draw time); `invoiceTexts[].label`;
  - the images count;
  - `fileNotes`.

  It is cut to 4096 characters with `fitTelegram`, and «message is not modified» counts as success
  (calc-dialog.ts:1110-1113).
- **It is kept last.** When material lands below the prompt (the newest incoming id is above
  `promptMessageId`), the old prompt is deleted and a new one sent below it.
  - This is coalesced per chat with a short debounce, so an album or a forward burst moves it once.
  - If the delete fails, the older copy stays, recorded in `ownMessageIds`, so its «Bo‘ldi» still
    works.
- **When a reading settles, `promptMessageId` is cleared.** The first material after the summary or
  table sends a NEW prompt below it. The summary or table is edited: its buttons go, and its last
  line reads «⬇️ Yangi ma’lumot qo‘shildi — pastdagi «✅ Bo‘ldi» ni bosing, qayta o‘qiladi.»
- **As built after the review** (PC-SPEC-4/5/6/9/13, PC-ADV-6/8/9):
  - «New material» is anything SENT beyond what the last reading read (`IntakeState.readMark`,
    written by the reading's settle; `nothingNewToRead` asks it). «➕ Yana ma’lumot» with nothing
    sent, or a typed answer alone, leaves the summary or table standing, buttons and closing, and
    its ✅ lands without a re-read. A row hydrated without the mark keeps today's rule.
  - Under the marker the plain summary drops its closing and its last line, as the AI table does:
    both pointed at a ✅ the table no longer carries. The certificate line drops «(o‘zgartirish
    uchun tugmani bosing)» there too.
  - Every take that moves a collection to 'material' (the add door's file, a `cf:` take) marks
    the table, as the collector's file handler does (`awaitReading`).
  - The «Tahlil paytida yana N ta …» words carry «Bo‘ldi», so they are recorded as the prompt: the
    next material moves them instead of drawing a second «Bo‘ldi».
  - A door's lead line («▶️ Davom etamiz — …») is said by the next draw whichever call of the burst
    queued it, and it is counted inside the 4096.

1.5 **The customer is asked once per collection**, never once per file.
- The question is ONE message, edited to count and kept last: «Qabul qilindi: 📎 4 ta fayl · ✍️ 1
  ta xabar.\n\nMijozni yozing: kodi (GS777) yoki telefon raqami. Kod bo‘lmasa — ismini yozing.»
- A goods list typed at the client stage asks for the client once, not twice.
- Once the customer is named, a collection that already holds material shows the prompt, whose
  first line is «Mijoz: GS777». It never shows «Tovar ro‘yxatini yuboring» about goods it already
  has.
- As built after the review (PC-SPEC-11): the same goods list sent twice keeps its «Tovar ro‘yxati
  mijoz bo‘la olmaydi.» and loses «Mijozni bitta qatorda yozing: kod yoki telefon.», which asked a
  second time above the question (corpus c1357/c1358 re-anchored on the question itself). The
  «bir necha qatorli» repeat keeps «… bitta qatorda yozing», which says HOW.

1.6 **The AI-podklyuch zone question is asked once**, not once per file. It is the same kind of
edited, counting message, kept last: «Qabul qilindi: 📎 4 ta fayl.\nAvval yuk qayerdan chiqishini
tanlang:», with the zone keyboard. As built after the review (PC-SPEC-2, PC-ADV-5): a text typed at
it is TAKEN first, so the question moves below it; untaken, the question was judged still last,
edited in place above the text, and the typed «Yiwu» heard nothing.

1.7 **One function reads unit words for every reader** (M10, F12; v1's §3.2).
- The table, the plain summary, the completeness verdict, the card note and the landing all draw a
  row from the landing's own `doorRow` / `normalizeRowUnit`, applied once at `invoiceFacts`.
- «пар» is juft: «120 пар» is 120 juft, never «120 dona» with a ⚠️ juft (aidoor S2).
- m² and litr go to the measure pair.
- «мест», CTN and коробок are cartons: a note, never a count. Where the law wants a count, the row
  shows ⚠️ on the AI door and ℹ️ on the plain one.

This is shared by both doors, not the AI door's alone.

## §2 The plain door «🧮 Hisoblatish» (his 2a, 3a)

2.1 **After «Bo‘ldi» and the reading comes a SUMMARY, not a questionnaire** (P5).
- Head: «🧮 Hisoblatish · 🛃 Rastamojka» (likewise 🚚 and 🔑). The two doors then look different on
  the screen where the seller decides what ✅ does.
- The rows and totals as read, each in the 1.7 units, with ✅ where complete.
- A row with a gap is marked ℹ️, never ⚠️, with one line saying what is missing: «↳ kg yo‘q — VED
  xodimi so‘raydi».
- There are no «↳» asks, no «✍️ Bir xabarda istalgan qatorni to‘ldiring», and no certificate
  control (it never had one).
- Closing when complete: «✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, so‘rov VED ga tushadi.»
- Closing when something is missing: «ℹ️ Yetishmaganini VED xodimi o‘zi so‘raydi — «✅ Tasdiqlash»
  ni hozir bosishingiz mumkin.»
- Last line: «Qator raqami bilan yozsangiz («3: 150 kg», «jami 3500 kg») — shu yerda yangilanadi.
  Yana ma’lumot bo‘lsa — yuboring.»
- Buttons: «✅ Tasdiqlash», «➕ Yana ma’lumot», «✖️ Bekor qilish».

2.2 **A typed text after the summary** (DR-1, M11, P4, INT-3) is never filed as material merely
because it was typed. R3 §0.1(3)'s defect stays closed on this door: a row's «150 kg» must not
become the shipment's weight.
- **(a) A text the table parser places WHOLE is written quietly.**
  - «Whole» means every segment is addressed (to a row by number or name, to the totals with
    «jami/umumiy/brutto …», or to a route) and none is refused. This is `answersParkedTable`'s test
    (calc-dialog.ts:1916).
  - It goes into `lineAnswers`, `totalsAnswer`, `routeAnswer` and `answers` through `planWrites` /
    `commitWrites`, in the **no-echo commit** §3.4 also uses. The summary is edited and the message
    gets a 👍.
  - A placed segment that WOULD raise an ask (a figure with no unit, a unit the row cannot take) is
    kept in `answers` as words for the VED. It is never asked.
  - An addressed refusal (`no_line`, `name_mismatch`, `totals_unit`) gets its one-line words.
- **(b) A text with no digit and no goods** («ok», «ha», «rahmat») writes nothing and gets one
  line: «Tasdiqlash uchun «✅ Tasdiqlash» ni bosing. Yana ma’lumot bo‘lsa — yuboring.»
- **(c) Anything else is material**: a goods list, a forward, a file, or a text not placed whole.
  It goes through 1.4: a new prompt below, and the summary marked «⬇️ … qayta o‘qiladi». The next
  «Bo‘ldi» reads again.
- **The 'material' stage after a first reading uses the same rule.** On the plain door it replaces
  the `applyTableAnswer` branch at calc-dialog.ts:1425-1431, so the same text sent twice can no
  longer be material once and an answer the second time.
- **The pin.** An integration test on a plain collection in 'review' reads a packing-list brutto of
  3500 kg, then types «3: 150 kg» and «Sumka 80 kg». `facts.weightKg` must stay 3500, rows 3 and
  Sumka must be written, and no reply may be sent. The red proof routes the text to
  `fileAsMaterial`. `calc-dialog.test.ts:168` stays on an `ai:false` collection, as this door's own
  pin.
- **As built after the review** (PC-ADV-1, a blocker; PC-SPEC-1/3, PC-ADV-3/4/10). «Whole» was
  judged for the text as one piece, so «3: 150 kg» with «rahmat» — or with a figure the table could
  not place — under it was material, and the re-read made 150 kg the shipment's brutto over the
  packing list's 3500: the defect this section exists to keep closed. The rule is per SEGMENT
  (`plainVerdict`):
  - Anything placed is written quietly: a figure, a total, a route, and a row's words that would
    ask (every line refusal — «Kodni 10 xonada yozing», «bittasini yozing», «nechta dona?» — is kept
    in `answers` for the VED with a 👍, never asked). An addressed refusal keeps its one line.
  - Beside a placed segment, a courtesy word is nothing; ONE figure placed nowhere is told how to
    address it («⚠️ Qaysi qatorga? …», and then no 👍); goods the table has no row for are filed as
    material ON THEIR OWN — never the row's figure with them.
  - Nothing placed: goods (a name no row has — «Shapka», «Ayollar sumkasi») are the whole text's
    material; a lone figure placed nowhere («150 kg») is kept for the VED as words with the same one
    line, never material.
  - (b) is a closed list of courtesy words (`plainAck`: «ok», «ha», «rahmat», «xo‘p», «хорошо», …),
    or no letters at all. «No goods» used to be the goods reader's guess, and a single product name
    was nudged at «Tasdiqlash» and kept nowhere. The nudge says «avval Bo‘ldi» only while something
    new waits to be read, and it joins the collection's own messages.
  - Collecting after a reading, a number naming OTHER goods («1. Shapka 50 dona …» after «➕») is
    the seller's list — material — never «yangi tovar bo‘lsa «➕» ni bosing» about the press he just
    made. In the summary stage it keeps its one line.

2.3 **«✅ Tasdiqlash» lands the job as it is.** The card note carries the AI's commentary and what
is missing; that machinery is unchanged. The ✅ text (P6):
- queued: «🧮 VED navbatiga tushdi — VED xodimi hisoblab, javobni shu yerga yuboradi.»
- queued yo‘lkira: `TARIFF_FOLLOWS`, unchanged.
- not queued: «⚠️ Hisoblash navbatiga tushmadi: …», unchanged, promising nothing.

«AI izohi kartada» is for the VED, so it goes at the head of the card note, not into the chat.
`landingReplyText` takes the collection's door at BOTH of its senders: the press
(staff-handlers.ts:1806) and `resumeLanding` (calc-intake-sweep.ts:447).

2.4 **The landing pass still runs and writes the commentary, but sends the seller nothing**
(DR-2, M6, F6, M7, P10, INT-1). This covers rastamojka and podklyuch on a plain request.
- **Every message the pass would send goes through `sayOnce` in a new `silent` mode.**
  - That covers the reply, each stand-down, PASS_FAILED and the 'closed' sentence.
  - The claim row is written as `muted`, with error «oddiy eshik». The drain never sends it, and
    `telegramProblemSql` does not count it, since muted is no problem. This is the pattern of
    say-once.ts's «cannot log in» row.
  - `spoke` stays the gate for the lenta note and its `whileOpen` check, so a redelivered pass still
    writes exactly ONE note.
- **The lenta note on a plain request carries no money**: «🤖 AI izohi (VED uchun)». The seller reads
  the card's lenta, and 3a keeps the estimate from him. The note lists:
  - the codes found and where each came from (🧠 memory / 📖 book / 🤖 model / the file's own);
  - the groups and the rates pulled;
  - the bazas filled and where they came from;
  - each row's missing figure;
  - refusals, in words.

  It carries no «Rastamojka jami», no Taxminiy/Aniq, no road and no JAMI. The VED reads the exact
  figure in his own workspace and the 📊 statistics in its 📥 dialog, so he loses nothing.
- **A failed pass leaves one lenta line**, so the VED is not left waiting for commentary that never
  comes: «🤖 AI hisoblay olmadi — VED qo‘lda hisoblaydi».
- **With `ai_calc_reply_lenta` off**, a plain request gets no pass note, only the landing note. This
  is stated, not changed.
- **A plain yo‘lkira** keeps the tariff answer to the chat (his 2.5 b; no model). Its seller tails
  follow the §3.5 rule in all four freight cases, not only m³: «Yo‘lkira: ⚠️ umumiy hajm (m³) yo‘q
  — VED xodimi sizdan so‘raydi». Brutto is no longer asked, so this answer will mostly say that it
  is missing; that is stated in §7.

2.5 **Refusals that point at an «AI javobi» follow the request's door** (P9).
- Plain (NULL keeps today's text): «Qo‘shimcha bo‘lsa — «✅ Saqlandi» xabari ostidagi «➕ Shu
  so‘rovga qo‘shish» ni bosing. Yangi hisob — «🧮 Hisoblatish».»
- AI: today's text.
- As built after the review (PC-SPEC-10): the no-collection sentence (`NO_OPEN_COLLECTION`) has no
  request in hand, so it keeps TODAY's text (§0.2) — every request at deploy is NULL, and an AI-door
  one is answered by the AI; naming the plain words for a chat whose newest request is 'plain'
  wants that request read in the orphan guard. The expired first collection's goodbye names the
  door it came in by: «Kerak bo‘lsa «🤖 AI rastamojka» dan qaytadan boshlang.» on the AI door.

2.6 **The ➕ door on a plain request.** «➕ Shu so‘rovga qo‘shish» stays under the plain ✅.
- The add collection on a plain request is plain too: a summary with no asks. A conflict prints as
  «↳ faylda 200 dona, so‘rovda 300 — VED hal qiladi», with no buttons.
- Its re-run pass is silent toward the seller (2.4).
- The add outcome's one line («qo‘shimcha yozildi» / «VED ga yuborildi») stays.
- As built: the outcome's re-run line follows the request's door — «🤖 AI kartani VED uchun qayta
  tayyorlaydi — narxni VED beradi.» on a plain customs request (pp seam 1) — on EVERY sender,
  the dead save's included (`amendWords` takes the door as a required argument, review PC-ADV-7).

2.7 **A plain request never asks a law unit**; 2.8 b and 1.14 a do not apply. The units are the
VED's, and the lenta note names them.

## §3 The AI door «🤖 AI rastamojka» (his 4a, 5a)

3.1 **The reading codes the rows** (F2, M4, M5, DR-11, P13).
- **ONE function codes a row for the reading AND for `openCalcRequest`** (#513). It is extracted
  from service.ts:455-476, and tries in this order:
  1. the row's own code (Excel, typed);
  2. sealed memory;
  3. the exact-key book;
  4. the model.

  It returns each code with its source (`'row' | 'memory' | 'book' | 'model'`), and the collection
  carries the source per row. The table and the INSERT code a row the same way. So the unit the
  table asks is the book law (`bookLawsFor`) of exactly the code the INSERT will store.
- **The model codes the Excel rows too.**
  - On the AI door the reading always shows the invoice rows to the model as `knownGoods` (today
    only on `aiGoods:'add'`).
  - The reading's schema gains `known_codes: [{ n, tnved_code }]`, by INDEX into the list as shown.
    Each index is re-checked against the row it claims (the `pickImportRows` idiom).
  - The goods list itself stays «only new goods».
  - The model is already called on every reading that has a key and budget, Excel-only ones
    included, so this adds output and input tokens, not a call.
  - A model code fills only a row whose own code is null. Rows past `KNOWN_GOODS_CHARS`, which the
    model was not shown, are not coded by it.
  - As built (review PF-ADV-13, PF-SPEC-6): a row with a code of its own is listed and never
    numbered; at most `KNOWN_CODES_MAX` (40) rows are asked; an answer cut at `max_tokens` while
    the codes were asked is read once more without them (both answers billed). An add or seeded
    collection's OWN Excel rows are coded too (shown beside the request's rows, which are not).
- **Where the coding step runs.** On the pool, after the model's answer and the bill, and before
  both `tableContext(analysed)` and `settleAnalysis`. It must come before `tableContext` because the
  laws of the new codes have to be read.
  - It has its own `INTAKE_CODING_BUDGET_MS`, which is added to the pinned sum in
    `calc-read-press.test.ts`.
  - It catches its own errors and falls back to the codes it already has. It never throws into the
    settle.
  - It is deterministic, so a retry codes identically.
  - A code the seller typed (`lineAnswers`, `placeByName`) stays on top.
- **The words** (P13):
  - A model-proposed code prints as «· 6403990000 (AI taklifi)». It lands with the item note
    «TNVED: AI taklifi (o‘qishda) — tekshiring», and the AI answer's line marks it the same way.
  - A row still uncoded, with the AI available: «↳ kod yo‘q — AI hisoblashda topadi (topolmasa VED
    qo‘yadi)».
  - A row still uncoded with no key, or with the day's budget spent: «↳ kod yo‘q — VED xodimi
    qo‘yadi».
  - Such a row is never ✅ and never a question.
  - As built after the review (PC-ADV-2): a row whose code is the MODEL's is ℹ️ too, never ✅ on
    the proposal alone, and a long table never folds it into «✅ yana N ta qator to‘liq». It makes
    the table no less complete: the code is not the seller's part.
- **A law unit that only the landing pass's coding reveals goes to the VED** (5a).

3.2 **The table** (P5).
- Head: «🤖 AI rastamojka · 🛃 Rastamojka» (and 🔑).
- Each ⚠️ row, total or route says what it needs, with one «✍️» line and the example
  (`answerHow`).
- Complete: «✅ Ma’lumot to‘liq — «✅ Tasdiqlash» ni bosing, AI hisoblaydi.»
- Incomplete keeps «Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham bosishingiz
  mumkin.»
- «Complete» means the SELLER's part is complete. The customs value comes later, from the sealed
  memory or his quarterly import (§7).

3.3 **The certificate control stays on the AI door's table keyboard.**

3.4 **An answer edits the table and sends no message of its own** (4a; DR-5, INT-6, P2, F9).
- **The echo MESSAGE goes; its record stays.** `echoes[]` keeps each answer, with
  `messageId: null`.
- **The table's LAST block shows the answer's result.** It sits after the AI notes and the
  certificate line, right above the buttons:
  - «✍️ Oxirgi javob: 3-qator «Сумка женская» — 50 juft»;
  - or, on an add the VED has started, «📝 VED ga yuboriladi: …».

  Under it comes the state: «⚠️ Yana 1 ta: 5-qator …», or the complete closing.
- **The undo moves onto the table keyboard**: one «↩️ Oxirgi javobni bekor qilish» button, whose
  callback names the newest un-undone tag (`cu:<tag>`).
  - It is re-rendered with each table edit, so a redelivered press names the tag it was drawn with.
    The `undone` flag keeps it idempotent.
  - `pressUndo` redraws the table instead of editing an echo.
  - 1.11 c's «bekor» is kept; only its message is gone (§7).
- **👍 only when EVERY segment was written** (`setMessageReaction`, best-effort; a failure changes
  nothing).
  - Otherwise there is no reaction, and ONE short reply carries only the refused or asked parts.
    That is the bare-number unit question with its `c:pick_N` buttons (`offersMessageId` = that
    reply), or a refusal's words.
  - That reply has no «✅ Yozildi», no confirm, no certificate and no ↩️.
- Echo ids already stored stay readable for `ownsMessage` for the 24 h that old collections live.
- **As built** (pair 2, P-chat B):
  - The AI table's closing moved to its END, like the plain summary's: notes, the certificate line,
    the last block, then the state and «✍️ …» lines. After an answer the state reads «⚠️ Yana N ta:
    5-qator, umumiy brutto.» (`openTargetsText`); with no answer yet it is today's «⚠️ N ta qatorda
    … yetishmayapti.».
  - The last block is DERIVED from the echo records (`lastBlockOf`), naming each row where it stands
    in the table now; an undo's own words wait in `IntakeState.lastUndo` until the next answer or
    reading. One action names at most 3 writes, the rest counted.
  - The ↩️ stays on a table that points down (§1.4's marker): the undo is no press the save guard
    refuses, and the echo that carried it is gone. Collecting, the closing says only what is open.
  - A text that writes nothing and asks nothing («;») gets NO_ADDRESS, never a 👍.
  - With no table drawn, an undo says its result in one message — the one place left.
  - The complete closing promises the AI's figure only while `aiCalcAvailable()` holds; otherwise
    «… so‘rov VED ga tushadi.» An addition: «✅ Qo‘shish … AI qayta hisoblaydi.», and «📨 VED ga
    yuborish» with no AI promise once the VED has started (§3.7).
  - A NULL door (an add or seeded collection on a request from before 0140) keeps today's table and
    echo (§0.2).

3.5 **«✅ Tasdiqlash» → the job lands → the AI computes** (P6, M9, P3, F7).
- **The ✅ text.** When queued: «🤖 AI hisoblayapti — taxminiy natija bir necha daqiqada shu yerga
  keladi. Rasmiy narxni VED xodimi beradi.» That promise is made only when `replyQueued === true`.
  When not queued: the unchanged «⚠️ Hisoblash navbatiga tushmadi: …».
- **The pass replies with the figure and asks nothing.** The ❓ block goes, which takes the 2.8 b /
  1.14 a seller ask out of the landing pass. Every SELLER tail goes too.
- **ONE place decides who a tail is addressed to**: a `noAsk` flag on the renderer, applied to
  `CUSTOMS_TAIL_WORDS`, `FREIGHT_TAIL_WORDS` and estimate.ts's `refused_measure`.
  - On an 'ai' request, in the chat, a seller fact reads «— VED xodimi sizdan so‘raydi», and the
    VED's own gaps read «— VED xodimi qo‘yadi / hisoblaydi».
  - The podklyuch JAMI line reads «JAMI: hozircha hisoblab bo‘lmadi — VED xodimi hisoblaydi.»
  - The ➕ button stays: it is an offer, not a question.
  - The lenta lists the same gaps under «⚠️ VED uchun: …».
  - The plain yo‘lkira reply (2.4) follows the same rule.
  - NULL keeps today's words.

3.6 **The AI door's answer reaches him past the «✅ Mening vazifalarim» mute** (INT-5). He pressed
the door for it.
- It goes through the drain as one claim row (`direct`, 0.3), never through a second sender.
- Its stand-down and «hisoblay olmadi» sentences pass the mute too, because they are the answer to
  his press.
- This reverses the second half of his 1.20 a, and §7 says so.

3.7 **The ➕ add collection on an AI request** asks the same way: one table, no echo, no ❓ after,
and a conflict as a «VED hal qiladi» line (1.1).

## §4 Outside a collection (his 6a)

4.1 **One question per burst** (DR-7, P7, F10).
- **What a burst is**: files or forwards in one chat, each within 2 minutes of the previous, while no
  collection, draft or capture is open.
- **It is stored durably, so a deploy loses nothing.** It is a `telegram_chat_waits` row of kind
  `'burst'` (0140).
  - The PK (chat_id, kind) gives one burst per chat.
  - The payload holds the offer's message id and the ordered parts, capped at 20: message id,
    forwarded flag, file id, name, mime, text.
  - It expires 2 minutes after the last part.
- **It ends at ONE point**, a middleware beside `collectorScope`. Any update in that chat that is
  neither a media message nor a forward (a typed text, a press, a contact) drops it. So does opening
  a collection, a draft or a capture.
- **ONE offer, always the last message.** It is re-sent below the newest part and the previous copy
  deleted, as in 1.4. Its text:
  - one plain file: «➕ Bu faylni so‘rovga qo‘shamizmi?»;
  - several: «➕ 3 ta faylni so‘rovga qo‘shamizmi?»;
  - any forward in the burst: «📌 5 ta xabar (3 tasi fayl) — topshiriq qilamizmi yoki so‘rovga
    qo‘shamizmi?», with Door B's buttons plus the ➕ rows, all in ONE message.
- **Its buttons act on the whole burst**, which is read from the wait by the pressed message id.
  - ➕ takes every part, forwarded texts included, and says «➕ 3 ta fayl va 2 ta xabar qo‘shildi.»
  - 📌 takes every forward as a source. Over the topshiriq cap it says «⚠ Topshiriqqa birinchi 10
    tasi qo‘shiladi.»
  - «🔍 Qidirish» is drawn only when the burst holds exactly one text.
  - When the wait is gone (it expired, or the press is older than the row), the press takes what
    `reply_to_message` gives and SAYS so, never silently: «⚠ Faqat 1 ta xabar qo‘shildi —
    qolganlarini qaytadan yo‘naltiring.» These are task-handlers.ts:630-632's words.
- **As built** (P-burst; `burst-wait.ts` the wait and its words, `burst.ts` the door):
  - «Drops it» is built as **ends it**: no later part joins, the next one opens a new burst. Its
    parts stay in the row, so the message it drew still acts on them — a seller who types «shu
    GS777 niki» under his files and then presses ➕ gets every file, and a redelivered press finds
    the parts its fence needs. «Gone» is a row replaced by a newer burst, or one past the waits'
    24 h reach.
  - One forward alone keeps Door B's own words: «📌 Topshiriq qilamizmi?», and «📌 Topshiriq
    qilamizmi yoki so‘rovga qo‘shamizmi?» with a ➕ row. «(N tasi fayl)» is left out when no part is
    a file. «fayl» counts photos and documents; «xabar» counts every part.
  - Plain files with no request to join them draw nothing (today's silence, the cabinet next), but
    they ARE kept: a forward that follows draws ONE message for all of them.
  - A full burst (20 parts) STANDS: a part past the cap is counted and said as a line of its ONE
    message, «⚠ Bir martada ko‘pi bilan 20 ta xabar olinadi — qolgan 5 tasini tugmani bosgandan
    keyin qaytadan yuboring.», and the message moves below it (review PB-ADV-1). The chat has one
    row, so a 21st part opening the next burst overwrote the twenty before they were offered. A
    full burst that draws nothing (plain files, no request) takes no overflow: the part opens the
    next one, so a forward after it still draws.
  - 📌 takes EVERY part the message counted — a plain photo or file beside the forwards is a source
    too, the draft's own rule — the first 10 as sources, a part's file only beside its source; the
    cap is the FIRST line of the draft's «👤 Kimga?», and the draft knows the rest were dropped
    (reviews PB-ADV-2, PB-SPEC-5, PB-SPEC-6, PB-ADV-7). «🔍» takes away only its own button.
  - A burst is taken once into each kind: a collection that FILED it (its save or its landing
    wrote the note under the collection's id) refuses a second ➕ — «Bu xabarlar allaqachon
    so‘rovga qo‘shilgan.» — while one cancelled or abandoned frees the parts; a second 📌 says «Bu
    xabarlar allaqachon topshiriqqa olingan.». A collection and a task may both take it, as Door
    B's single offer always let ➕ and 📌 act on one forward (review PB-ADV-3). The take is marked
    BEFORE it runs, so a draw the album still owes never speaks for parts being taken (PB-ADV-5).
  - A replaced burst leaves what its message spoke for (one generation): how many parts, and where
    they went — so its press, or the restart question asked about it, says `BURST_GONE` and never
    files twice (reviews PB-SPEC-3, PB-ADV-3).
  - A forwarded voice note or video taken by ➕ is refused in words once per kind, as the
    collector does («🎤 Ovozli xabar o‘qilmaydi — yozib yuboring.»). A forwarded contact card or
    place is its one line of material (PB-ADV-6).
  - The add door's «Sizda tugallanmagan yig‘ish bor…», asked about a burst, speaks for it: its
    «🗑 Ha» takes the whole burst (`aliasIds`).
  - The take's line («➕ 3 ta fayl va 2 ta xabar qo‘shildi.») is the FIRST line of the ONE prompt
    that follows (§1.4), never a message of its own: a NEW prompt below what was taken, the old one
    retired the kept-last way (review PB-SPEC-2). A collection still at its customer or zone
    question asks it again with the line on top (PB-SPEC-1).

4.2 **Beside a PARKED collection, the pause line is the burst's one message** (DR-8, P8).
- It covers forwards too, is kept last (1.4), and appears once per burst: «⏸ Hisoblatish to‘xtab
  turibdi (30 daqiqa yozilmadi). Hozirgi 3 ta xabar unga hali qo‘shilmagan — «▶️ Davom etamiz» ni
  bossangiz, qo‘shiladi.»
- Buttons: «▶️ Davom etamiz», «📌 Topshiriq qilish» (only when the burst holds a forward), «✖️ Bekor
  qilish».
- The «yoki jadvalga reply qilib yozing» clause is printed only when the parked stage is 'review'
  AND no burst is waiting.
- **Its ▶️ has its own callback**, `c:resume_take`, added to `CALC_STEPS` and `CALC_STEP_REPEAT`.
  - It takes only the burst parts whose stored offer id equals the pressed message.
  - It takes them through `takeReplied`'s per-part fence: `saveIntakeFile` per part, `repliedTaken`
    in the same patch, then `awaitReading`. A redelivered press is a no-op.
  - The REG-2 refusal (`otherCollectorLive`) runs before the take.
  - It answers with a NEW prompt: «▶️ Davom etamiz — 3 ta fayl qo‘shildi.\nQabul qilindi: …\nYana
    yuboring yoki «Bo‘ldi» ni bosing.»
- The other five ▶️ (the restart's «🔄 Ha», the reminder, and the rest) keep `c:resume`, which takes
  nothing. 1.8 c's «a parked collection takes nothing by itself» holds: the press is his consent.
- **As built** (P-burst): the pause line carries no ➕ rows — its buttons are the three above.
  «Waiting» is a pause-line burst not yet taken, beside the collection it was drawn by (`parkedNote`),
  so a typed table answer still gets the line without the reply clause after the burst has ended.
  `c:resume_take` acts only on that collection; a press whose wait is gone takes what the line
  replies to (its newest part) and says `BURST_GONE` when it spoke for more. Pressed again after
  everything was taken (the collection parked anew), it goes on as `c:resume` does — the stage
  shown, nothing taken twice (review PB-ADV-4).
  - A typed table answer beside a waiting burst gets the pause line WITHOUT the reply clause, and
    that line is the burst's too: its keyboard is the burst's, and it speaks for the burst, so its
    «▶️» takes the parts — a second «▶️» that took nothing was the wrong way back (PB-SPEC-4).
  - «📌» on the pause line takes every part into the draft, and the line becomes the collection's
    plain pause line («… bu xabar unga qo‘shilmadi», `c:resume` / `c:cancel`): now true, and its
    «▶️» / «✖️» still act on the collection (PB-ADV-2).

4.3 **A just-landed request is offered at once**: the landing clears the offer list's cache.
  As built: `landCollectedIntake` (staff-bot.ts), the one function both senders call, forgets the
  chat's cached list after `landIntake` returns.

## §5 Not changed

- Money: prices, rates, upsale, the seal.
- The VED's four doors and `amended_since`.
- The durable store and its flush.
- The card form, the thread door, the AI sotuvchi.
- The corpus ratchet: 142 known cases.
  - Any change to `intake.ts`, `intake-manual.ts`, `units.ts`, `goods-import.ts`, `goods-file.ts`,
    `xls.ts`, `calc-intake.ts` or the collector in `staff-handlers.ts` runs the WHOLE corpus first.
  - A known case that starts passing leaves the list.
  - The two-factory case (INT-4) and the packing-list-first case (M1 a) join the corpus.

## §6 Tests that pin the old behaviour

Each is re-anchored on his 2026-11-08 words and named in the commit. A test that pinned a question
he has now refused is rewritten to pin its ABSENCE, never deleted silently. Several of these sit in
suites that go red only in CI's order (vitest after a seed, then Playwright without re-seeding), so
the whole order is run.

| File | What moves |
|---|---|
| `intake-collector*.test.ts` | per-file questions → absence; the 1.2 rule |
| `intake-corpus.test.ts` + the fixtures' scenario cases | the 1.2 rule; the two-factory and packing-first cases |
| `calc-read-press.test.ts` | the pinned time sum gains `INTAKE_CODING_BUDGET_MS` |
| `bot-redelivery.integration.test.ts` | old callbacks answer «eskirgan» (1.3) |
| `totals-question.test.ts:212` | the `fileTotals` rank |
| `calc-dialog.test.ts` | its `ai:false` collections stay plain (:168 is §2.2's pin); the table/echo tests move to `ai:true` |
| `calc-undo.test.ts` | the undo on the table keyboard (3.4) |
| `intake-table.test.ts`, `intake-questions.test.ts` | plain summary vs AI table; no echo |
| `calc-stated-presses.test.ts`, `calc-r3-kernel.test.ts` | the retired callbacks; `c:resume_take` |
| the bot integrations that drive «🧮 → rastamojka» through the table | the plain door summarises |
| `ai-reply.test.ts`, `law-asks.test.ts` | no ❓; `noAsk` tails |
| `estimate.test.ts`, `freight-answer.test.ts`, `prefill-reply.test.ts` | tails by door |
| `calc-add-buttons.test.ts` | door-aware refusals (2.5) |
| `calc-prefill.integration.test.ts`, `customs-estimate.integration.test.ts` | silent plain pass; money-free note |
| `calc-pass-settle.integration.test.ts` | `sayOnce`'s silent mode; one note on redelivery |
| `intake-confirm.test.ts`, `intake-reply-link.test.ts` | the two ✅ texts; the door at both senders |

## §7 Stated to him, not built

- **The plain door and the upsale.** On the plain door a missing brutto or cube is the VED's to get
  (his 2a). The upsale is unchanged: a quote with no measure keeps its whole promise once any cargo
  arrives, as a lump rastamojka always has, and it is the VED writing the m³ or kg before the seal
  that scales it. v1's «nothing pays on a guess» was not true and is not sent (F8). Asked as a
  question that blocks nothing: should a seal with no m³ and no kg be refused in words?
- **The plain door's lenta note carries no money.** The VED sees the figure on his screen. If the
  owner wants the estimate on the card for the seller too, that is one switch (INT-1, P10).
- **«Ma’lumot to‘liq» on the AI door** means the seller's part is complete. Whether the AI can put a
  figure on it depends on the customs value (the memory or the quarterly import).
- **Superseded agreements**, named (INT-12):
  - 2.8 b (asking after the AI answer) is superseded on both doors by 5a.
  - His explicit 1.14 a: the plain door asks no unit; the AI door asks it in the table, before
    «Tasdiqlash».
  - The 2026-09-05 rule that the plain 🔑 podklyuch still gets the AI answer in the chat ends (3a).
    2a's «chat AND lenta» now holds for the AI door only.
  - 1.11 c: the echo message is gone, and the undo is kept on the table.
  - 1.13 c: the second-file and conflict buttons are gone; the bot compares the files itself.
  - 1.20 a, second half: the 🤖 door's answer arrives even when «✅ Mening vazifalarim» is muted.
- **The yo‘lkira tariff answer on the plain door stays** (his 2.5 b). Brutto is no longer asked
  there, so it will mostly say «brutto yo‘q — VED xodimi sizdan so‘raydi».

## §8 The objections and where they are answered

| Id | Sev. | Answered in | Note |
|---|---|---|---|
| DR-1 | blocker | 2.2 | silent addressed write; test + red proof |
| DR-2 | blocker | 2.4 | `sayOnce` silent mode |
| DR-3 | defect | 0.1-0.4 | NULL = today; door read from the row; probe |
| DR-4 | defect | 1.3 | `migrateIntakeState`; the retired-callback list |
| DR-5 | defect | 3.4 | undo on the table keyboard |
| DR-7 | defect | 4.1 | durable burst (telegram_chat_waits 'burst') |
| DR-8 | defect | 4.2 | `c:resume_take` with the per-part fence |
| DR-9 | defect | 1.2.5, 1.2.3 | `fileTotals`, `fileNotes`; add collections |
| DR-10 | defect | 1.4 | the prompt is a pure function; warnings are lines in it |
| DR-11 | defect | 3.1 | the coding step's place, budget and error handling |
| M1 | blocker | 1.2.1-1.2.2 | shape by columns; a duplicate needs agreeing figures; else added and named |
| M2 | defect | 1.2.2 | brutto only from gross; netto flagged |
| M3 | defect | 1.2.2 | the add path only for model-read documents |
| M4 | defect | 3.1 | `known_codes` by index |
| M5 | defect | 3.1 | one coding function; source per row; item note |
| M6 | defect | 2.4 | silent claim; failed-pass lenta line |
| M7 | defect | 2.4 | money-free plain note |
| M9 | defect | 3.5, 2.4 | `noAsk` over all four tail maps |
| M10 | defect | 1.7 | one unit function |
| M11 | defect | 2.2 | as DR-1 |
| P1 | blocker | 1.4 | prompt kept last; cleared on settle |
| P2 | defect | 3.4 | the last block; 👍 only when all is written |
| P3 | defect | 3.5 | tail words |
| P4 | defect | 2.2 | cases (a), (b), (c) |
| P5 | defect | 2.1, 3.2, 2.6 | heads, ℹ️, closings, plain conflicts |
| P6 | defect | 2.3, 3.5 | the ✅ texts |
| P7 | defect | 4.1 | offer kept last; mixed text; cap; 🔍 |
| P8 | defect | 4.2 | pause line text and buttons |
| P9 | defect | 2.5 | door-aware refusals |
| P10 | defect | 2.4, §7 | the money-free note (b) is built, and (a)'s statement is made |
| P11 | defect | 1.2.4, 1.2.5 | wordings; receipt-time vs reading-time notes |
| P12 | nit | 1.5, 1.6 | one counting question, kept last |
| P13 | nit | 3.1 | the code words |
| F1 | blocker | 1.2.1-1.2.2 | `grossKg`/`volumeM3` from the reader; the text joins `invoiceTexts` |
| F2 | blocker | 3.1 | both: (A) the one function and (B) `known_codes`, since the model is already called |
| F3 | defect | 1.2.2 | `sameRowAgain` beside `sameGoodsLine`; gaps filled |
| F4 | defect | 0.1 | `openCalcRequest`'s input; both agent paths; recalc |
| F5 | defect | 0.2-0.3 | NULL behaviour; door read from the row; `direct` |
| F6 | defect | 2.4 | silent claim on every pass message |
| F7 | defect | 3.5, §6 | one place for tails; the tests listed |
| F8 | defect | §7 | the false sentence dropped; the true rule stated |
| F9 | defect | 3.4 | the one reply for asks and refusals. Its «undo gone» was NOT taken: DR-5, INT-6 and P2 keep the undo |
| F10 | defect | 4.1 | the fallback words are taken. Its in-memory store was NOT: DR-7's durable store is, since 0140 exists anyway |
| F11 | nit | 1.2.5, 1.4 | receipt-time vs reading-time notes |
| F12 | nit | 1.1, 1.7 | the union kept; units shared by both doors |
| F13 | defect | §6 | the table |
| INT-1 | defect | 2.4 | money-free note; §7 offers the switch |
| INT-3 | defect | 2.2 | «Sumka 80 kg» pinned |
| INT-4 | defect | 1.2.2 | figures must agree; two-factory corpus case |
| INT-5 | defect | 3.6, §7 | the reversal stated; stand-downs pass the mute too |
| INT-6 | defect | 3.4, §7 | undo kept |
| INT-8 | defect | 0.1-0.2 | the agent passes null; test |
| INT-9 | defect | 1.1, 1.2.3 | conflict question gone; interp 2 holds |
| INT-10 | nit | 1.2.2, 1.2.5 | netto gap fill; never asked again |
| INT-12 | nit | §7 | the superseded agreements named |
