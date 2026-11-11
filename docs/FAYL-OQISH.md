# Fayl o‘qish — the AI door reads every file before «Tasdiqlash», and a file's goods are not lost (2026-11-10)

His report of 2026-11-10, the day after «Ikki eshik» (ledger 142), verbatim:

> «nega ai rastamojkaga malumotlar bergandan kegin ham tovar nomi topilmadi deyabti. 1 dona fileda
> kop tovarlar bolishi mumkun yokida 1 dona tovar bolishi mumkun. va fillarni qabiul qil degandan
> keyin fillarni oldin korib chiqib togridan togri tasdiq deyabti?»

His report is two sentences, and each names a defect:
- **«tovar nomi topilmadi»** is `NO_GOODS_CLOSING` («⚠️ Tovar nomi yozilmagan — …»). It is drawn only when a
  reading ends with ZERO goods rows.
- **«fillarni qabul qil degandan keyin … to‘g‘ridan-to‘g‘ri tasdiq»**: after the prompt says «Qabul qilindi:
  📎 N ta fayl», the table offers «✅ Tasdiqlash», although the AI never looked at the file or read nothing
  out of it.

**The diagnosis** is workflow wf_edbf4e25-bff (68 agents, 2026-11-10). It drove the REAL grammy handler chain
through `bot-harness`, with the real readers and a faked SDK, in eight scenarios:
- xlsx1: one good in one Excel;
- xlsxN: many goods in one Excel;
- unmapped: sheets the column reader cannot map;
- pdfimg: PDFs and photos;
- apireq: the Messages API request;
- dialog: the dialog order;
- zero: the zero-goods table on both doors;
- known: the «already taken» list.

It produced 73 findings. Every non-nit finding got an adversarial refuter: 30 were confirmed, 33 partial and 1
refuted. Each finding is one file in the session scratchpad (`goods/f/<id>.md`) holding:
- the claim and its evidence;
- the reproduction test (in worktree `ek-k`, `tests/**/zz-repro-*`);
- the verdict;
- the verifier's measured **betterFix**, which is binding wherever this spec says «per betterFix».

**v2.** Four lenses judged v1 before code (door, model, sheets, reader), with a refuter per lens and a
completeness critic (wf_d5decc01-3c9). There were 54 objections: 44 upheld, 10 partial, 0 refuted. All are
absorbed below. §9 maps each one to where it is answered. The objections themselves, with their evidence,
are `goods/judge-objections.md` in the scratchpad, and every builder reads the ones its package cites.

What production hit is not proven, because this container has no API key. His `[calc intake]` log lines will
say which route it was (§7). Every route below is fixed regardless.

Numbering: DECISIONS from **#1628**, because main's AI sotuvchi took #1610-#1621 and its «kontekst 100» round
#1622-#1627 (merged at 374983e; the line said #1622 until the as-built review, REGRESSION-7). **No migration**: every new
field lives in the collection's jsonb state, so the ledger stays at **143**.

---

## §0 The two sentences, cause by cause

0.1 **«Tasdiqlash» without a reading** (xlsxN-01 blocker, known-3, dialog-04, zero-01,
unmapped-excel-only-model-not-called):
- On the AI door, a lone Excel the reader maps, with no caption, never reaches the model. `analyzeIntake`'s
  guard never counts the numbered known list, and a one-sheet workbook leaves no sheet text.
- The customer's answer is `clientHintRaw`, not material.
- So the commonest order (door → section → GS777 → the file → «Bo‘ldi») gets `nothing_to_read`.
- The table then says «⚠️ AI ga o‘qish uchun matn, rasm yoki PDF yo‘q edi» right after the file was
  accepted. It proposes no codes, so it asks no law unit, and closes «✅ Ma’lumot to‘liq — «✅ Tasdiqlash»
  ni bosing, AI hisoblaydi».

0.2 **Zero goods, with «Tasdiqlash» over them** (xlsx1-08, xlsxN-04, pdfimg-2, dialog-05, zero-02, zero-03,
zero-04, known-7, all confirmed). Every zero-goods AI table:
- blames the seller («Tovar nomi yozilmagan — tovarlarni «➕ Yana ma’lumot» bilan yuboring»);
- prints «Faqat yozilganidan o‘qildi» when nothing was typed;
- invites the press («Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham bosishingiz
  mumkin») over rows that do not exist.

After the press it promises «🤖 AI hisoblayapti», and the pass answers a bare «Rastamojka jami: hozircha
hisoblab bo‘lmadi».

0.3 **Why a file gives zero goods:**
- **The model's reading failed.** One non-streaming call carries every PDF, photo and unmapped sheet, at
  effort `high` (the default), with the thinking inside `max_tokens` 16 000 and a 150 s leash. A long
  invoice ends in `timeout` (the most likely outcome) or `truncated`, and nothing is kept (zero-06,
  pdfimg-10, apireq-5, xlsxN-03, xlsx1-01).
- **Only the model could read the sheet, and the call failed.** The causes:
  - the header is below row 10 (xlsx1-02);
  - the name column is headed «Product», «Commodity», «Номенклатура» or «货名» (xlsx1-03);
  - a good whose name holds «TOTAL» is dropped as a total row (xlsx1-04).
- **The bot handed the model nothing:**
  - a storage miss (pdfimg-3);
  - an oversized PDF (pdfimg-6);
  - a top-up packing-shaped first file, withheld as «noted» (known-2);
  - a PDF the API refuses, which sinks every re-read (pdfimg-9, apireq-2).

0.4 **A file's goods lost or wrong**, without the word «topilmadi»:
- several sheets: xlsxN-02, known-1, unmapped-other-sheets, xlsxN-11;
- a one-good label|value card: xlsx1-07, unmapped-vertical-card;
- a data row or a letterhead taken as the header: unmapped-product-name-as-header, unmapped-letterhead;
- footer and total rows taken as goods: xlsx1-05, xlsx1-06;
- an ITEM serial column taken as the name: xlsxN-06;
- figures misread:
  - «1,500» typed as text (xlsxN-07);
  - «CTN QTY» (xlsxN-08);
  - «Всего шт» (xlsxN-09);
  - a bilingual two-row header (xlsxN-10);
  - Uzbek headers (unmapped-uz-header-words).

---

## §1 The rule this round adds

> **«✅ Tasdiqlash» on the AI door means «the AI has read every file you sent and it accepted, and it will
> compute».** It is drawn only when that is true. Otherwise the table says, in words, what was not read and
> why. It offers what can fix it, plus a door to the VED that promises no AI figure.

1.0 **«The AI door» is `collectionDoor(state) === 'ai'`**, everywhere in this file: the keyboard, the closing,
`confirmRows`, the save branch and the landing (critic-door-predicate).
- A NULL-door collection keeps today's keyboard, closing and landing. That covers a returned card-form,
  thread-door, AI sotuvchi or pre-0141 request.
- §1.2 covers the FIRST and the SEEDED (returned) AI-door collections (`!state.amend`).
- The ➕ add collection is §1.6 (door-amend-scope).

1.1 **The reading's wholeness: one pure predicate.** `aiReadingWhole(state, rowCount)` lives in
`platform/telegram/reading-whole.ts` (kernel K, §10). It returns
`{ whole: boolean; blocking: Unread[]; named: { name: string; why: string }[] }` and reads STATE FIELDS ONLY
(door-whole-inputs).

**Blocking**: the AI did not read what it ACCEPTED, so a reading with any of these is not whole:
- **(a) `no_goods`**: `rowCount === 0`.
- **(b) `cut`**: `state.aiCut` is set (§3.3).
- **(c) `model_failed`**: model-only material is in the collection and the model did not answer
  (`!state.aiUsed`). Model-only material is any of:
  - `state.images`;
  - `state.pdfs` (less `state.unreadPdfs`);
  - a non-empty `state.sheetTexts` text.

  The context sheets (`invoiceTexts`) are read for totals only and do not count.
- **(d) `pdf_refused`**: `state.unreadPdfs` is non-empty. The API refused those documents (§3.4).
  As built after the as-built review (B): a refused PDF blocks only the table of the reading that MET the refusal. The next reading takes
  it out of `pdfs` and names it in `refusedFiles` with the reason «AI qabul qilmadi» (`PDF_REFUSED_WHY`),
  named and not blocking — kept blocking, nothing the seller sent could ever reach ✅. A PDF is named at all
  only once the PDF-less request reached the model; a PDF-less re-read refused too names none (the PDFs were
  not the cause). Until it moves, the ONE prompt says of it «📄 «X.pdf» — AI bu faylni qabul qilmadi.», never
  «AI o‘qiydi» (WORDS-5).
- **(e) `files_missing`**: `state.filesMissing > 0`. A stored file did not load (§2.5).
- **(f) `input_cut`**: `state.aiInputCut`. The model was not shown all of an accepted sheet text: the
  reader's `cut`, or `fitSheetRows` kept < total (door-whole-input-cuts).
- **(g) `capped`**: a `goodsFiles[]` entry is `capped`, so a mapped Excel past `MAX_GOODS_ROWS` kept its
  first 500 rows. As built after the as-built review (A), REGRESSION-6: `capped` is the reader's own word
  (`ParsedGoods.stoppedShort`, carried per sheet by `readGoodsFile`), never the row count — a list of exactly
  500 read whole is not capped and keeps «✅».

**Named, not blocking**: files REFUSED AT ARRIVAL, `state.refusedFiles` (critic-refused-unread). The seller
was already told at arrival that each one would not be read:
- a 4th PDF;
- PDFs over the 12 MB total;
- a PDF over 10 MB;
- DOCX, video, an archive, an encrypted or old-format xlsx, an unknown type;
- a file over 20 MB (§3.4);
- photos past the 12-photo cap.

Each is named in the table's closing with its own reason. «✅ Tasdiqlash» stays, and the closing says:
«{X.docx} o‘qilmadi ({sabab}) — undagi tovarlar hisobga kirmaydi.»

The reason for the split: the rule is «what you sent and it ACCEPTED is read before ✅». A refused file was
never accepted, and there is no door to remove it from the collection. Blocking on it would leave the seller
no way to an AI figure except ✖️.

Neither of these makes a reading unwhole: typed text alone, or mapped Excel rows alone, both read without the
model. A model failure on an Excel-only collection costs the codes, not the goods, and the landing pass codes
the rows (today).

As built after the as-built review (A):
- The named line quotes the file like every other file line on the table, and a counted entry is plural
  (WORDS-11): «{«X.docx»} o‘qilmadi ({sabab}) — undagi tovarlar hisobga kirmaydi.», «3 ta rasm o‘qilmadi (12
  tadan ortiq rasm) — ulardagi tovarlar hisobga kirmaydi.».
- The tier is bounded (REGRESSION-4): the first `REFUSED_NAMED_MAX` (5) by name, the rest one line per reason,
  «Yana {N} ta fayl o‘qilmadi ({sabab}) — ulardagi tovarlar hisobga kirmaydi.». Sixty HEIC files forwarded as
  files had left no goods row and cut the remedy off. `fitTelegram`'s last resort ends on a line within 600
  characters of the cap and never inside a surrogate pair.

As built after the as-built review (B), the named tier as built (MODEL-6 (9), SHEETS-6 (5)). Besides the list above it names: a HEIC or an
unreadable photo («HEIC rasm», «rasm ochilmadi»); a broken, old-format or encrypted xlsx; a workbook whose only
content is pictures («ichida faqat rasm, jadval yo‘q» — a noun phrase like every reason, OWNER-11); a picture
DOCUMENT between storage's 15 MB photo ceiling and Telegram's 20 MB («15 MB dan katta rasm», MODEL-3); an HTML
or XML table or an .xlsb («HTML jadval», «XML jadval», «Excel binary (.xlsb)», REGRESSION-5); the photo cap as
ONE counted entry («N ta rasm»). The READING writes it too (the refused PDF, §1.1 d). It names no empty sheet
(nothing was lost) and no `download_failed` (the re-send brings the file). A macro-enabled workbook (.xlsm) is
no longer refused — storage keeps it as a download-only document and the reader reads it (OWNER-10). A file
TAKEN later under the name of one refused before leaves the tier: the bot's own refusal asks for exactly that
re-send (MODEL-5); never under a name the bot made up («rasm», «fayl», «N ta rasm»).

1.2 **Not whole → no «✅ Tasdiqlash»** (§6 Q1 ⭐ a, built as ⭐). On a first or seeded AI-door collection the
keyboard is:
- `[🔄 AI qayta o‘qisin]` only when a retry can help:
  - a retryable `AI_READ_FAILURE`;
  - `files_missing`;
  - a CLOCK cut, at most once per material mark (`aiCutRetried`). After that, the size cut rule below applies
    (model-reread-and-codes).

  A SIZE cut (`max_tokens`) never draws 🔄 (review #21, door-cut-retry).
- `[📄 Sertifikat: …]`, kept. The answer goes on the request for the VED.
- `[➕ Yana ma’lumot]`.
- `[👤 VED hisoblasin]`, the new step `to_ved`. The label is deliberately NOT «📨 VED ga yuborish», which
  is the ➕ door's c:save (door-amend-scope).
- `[✖️ Bekor qilish]`.

**The closing** replaces `vedLine` and the complete line ONLY on not-whole tables (critic-pins). A whole
table, complete or not, keeps today's closing: `vedLine` stays on a whole-but-incomplete AI table, as
IKKI-ESHIK §3.2 decided, and `calc-dialog.test.ts:279` stands.

One function, `notWholeClosing(state, whole, rows)`, chooses the FIRST line:

| Case | First line |
|---|---|
| zero rows, files accepted, the model failed | «⚠️ Fayldan tovar o‘qilmadi.» (the reason is in the tail's failure block — never said twice, critic-said-twice) |
| zero rows, files accepted, the model answered `goods: []` | «⚠️ AI yuborilgan fayllardan tovar topa olmadi.» |
| zero rows, no file | `AI_NO_GOODS` = «⚠️ Tovar nomi yozilmagan.» (a NEW constant; `NO_GOODS_CLOSING` stays the legacy branch's, `intake-table.test.ts:119` stands) |
| rows > 0, model-only material unread | «⚠️ {N} ta tovar Excel/yozilganidan olindi; {k ta PDF / k ta rasm / «X» varag‘i} o‘qilmadi.» |
| clock cut | «⚠️ AI faylni oxirigacha o‘qib ulgurmadi — {N} ta tovar o‘qildi, qolgani o‘qilmadi.» |
| size cut | «⚠️ Material juda katta — {N} ta tovar o‘qildi, qolgani o‘qilmadi. Kamroq sahifa yoki Excel yuboring.» |
| input cut / capped | «⚠️ «{X}» jadvalining {kept}/{total} qatori o‘qildi.» |
| pdf refused / files missing | Named with their own words (§2.5, §3.4) |

Then the remedy line, which names only the presses that are drawn:

> «{«🔄 AI qayta o‘qisin» ni bosing, yoki }faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan
> yuboring. Yoki «👤 VED hisoblasin» — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi).»

With files accepted and zero rows, the goods row above prints «⚠️ tovar — fayldan o‘qilmadi», not
«⚠️ tovar nomi — yozilmagan» (critic-said-twice). With no file, the old words stay.

As built after the as-built review (A):
- «Files accepted» is what was TAKEN (`filesAccepted`: a PDF, a photo, a sheet text, an Excel's rows, a stored
  file that did not load), never `fileCount`, which counts a DOCX the arrival refused and leaves out a 20 MB
  file (OWNER-5). Zero rows with every file refused at arrival is its own first line, «⚠️ Yuborilgan fayl
  o‘qilmadi — sababi pastda.» (the named lines follow it); the goods row is «⚠️ tovar — fayldan o‘qilmadi»
  whenever a file was sent, taken or refused; the VED reason is «yuborilgan fayl o‘qilmadi».
- A label is quoted once (OWNER-6): the readers store it quoted, so «⚠️ «X» jadvalining …» prints the stored
  label as it is; a further sheet's label already ends «varag‘i» and reads «⚠️ «X», «Zavod B» varag‘ining
  birinchi 500 qatori o‘qildi.».
- The remedy line names only roads that lead somewhere (OWNER-8, WORDS-3): no door takes a file back out of a
  collection, so «➕» is offered only for a block new material heals (no rows, a retryable failure, a file not
  handed back, a refused PDF). The sentence above stands for those. Otherwise:
  - the model will not answer today (budget, no key, a dead key): ««👤 VED hisoblasin» ni bosing — VED xodimi
    fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi). Yoki ertaga / AI ulangach «➕ Yana ma’lumot» bilan
    biror narsa yuboring — AI hammasini qayta o‘qiydi.»;
  - a capped or input-cut table, a cut, a size stop, a refusal of the material: ««👤 VED hisoblasin» ni bosing
    — … Yoki «✖️ Bekor qilish» ni bosib, {jadvalni kichikroq bo‘laklarga bo‘lib / kamroq sahifa yoki Excel
    qilib / faylni kichikroq (yoki Excel) qilib / o‘qilmagan faylsiz (Excel qilib yoki yozib)} qaytadan
    yuboring.», with the «🔄» lead before it while a clock cut's one retry stands;
  - no file at all: «Tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring.»; the VED clause says «fayllarni o‘zi
    ko‘rib» only where a file reached the card (taken, or stored and refused), else «VED xodimi o‘zi
    hisoblaydi (AI hisoblamaydi)».
- The remedy drops its «🔄» lead whenever a stored file did not load (OWNER-7): the tail's failure line or the
  reading's note already names the press.

As built after the as-built review (B):
- «🔄» is drawn for a CLOCK OR DROPPED cut (`notWholeRetry`: every cut but a size cut — a dropped stream is the
  network's, not the input's), once per material mark, and a dropped cut takes the clock cut's words (OWNER-9
  a, MODEL-6 (1)).
- The PRESS obeys «once per material mark», not only the table (WORDS-8): the older table keeps its «🔄» and an
  older prompt its «Bo‘ldi». Nothing new sent, a cut reading, no retry left (a size cut, or a clock cut already
  re-read, no stored file to load again) → nothing is enqueued, the bot answers «⚠️ AI bu materialni yana o‘qisa
  ham shu yerda to‘xtaydi — «👤 VED hisoblasin» ni bosing, yoki «✖️ Bekor qilish» ni bosib, {faylni kichikroq
  (yoki Excel) qilib / kamroq sahifa yoki Excel qilib} qaytadan yuboring.» and draws the table again. The AI
  door's first or seeded collection only; elsewhere today's.
- A re-read of the SAME material that reads LESS keeps the earlier reading (CRITIC-1): a cut with fewer goods,
  or a failure with none, leaves the earlier cut's goods, totals and `aiCut`, with the note «⚠️ Qayta o‘qishda AI
  avvalgidan kam o‘qidi — avvalgi o‘qishdagi {N} ta tovar qoldi.». A whole answer, or a cut that read as many,
  replaces it; new material is a new reading. Both doors (the plain door's «Bo‘ldi» re-reads too).
- The input-cut row has two more first lines (OWNER-9 e): «⚠️ «{X}» jadvalining birinchi {kept} qatori
  o‘qildi.» when the reader's own stop or the 500-row ceiling counted no total, and «⚠️ Jadval AI ga to‘liq
  ko‘rsatilmadi — bir qismi o‘qildi.» when `aiInputCut` names no sheet.

**Every word and button that names the confirm** goes through ONE function of the live state's wholeness
(door-closing-drawers):
- the closing's complete branch (`aiCompleteLine`);
- `plainNudge`'s «Tasdiqlash uchun …»;
- `missingLines`' «Hamma qator to‘liq — «✅ Tasdiqlash» …»;
- `pressCertificate`'s fallback keyboard;
- `confirmRows` under an echo;
- the failed-landing retry («Saqlab bo‘lmadi — «✅ Tasdiqlash» ni qayta bosing»), at the press and in the
  sweep;
- the returned door's opening line. When no ✅ will be drawn it reads «… — to‘ldiring yoki «👤 VED
  hisoblasin»».

When the reading is not whole, every one of these names and draws `to_ved`.

1.3 **«👤 VED hisoblasin» and the landing.**
- **(a) The press's choice is durable.** `c:save` and `c:to_ved` write `state.landAs: 'ai' | 'ved'` in the
  same patch that marks the landing in progress. A `c:save` on a not-whole AI collection writes 'ved'. That
  covers an old table drawn before the deploy and a redelivered press (door-aipass-home).
  - `landCollectedIntake` is the ONE home that derives the landing, and both the press and the sweep's resume
    use it.
  - `landAs === 'ved'` → the request is written with **`intake_door = 'plain'`**.
  - The landing pass then runs silently. The machine still prepares the card for the VED (memory codes,
    dictionary and import baza, the AI note), and the seller hears nothing. So the VED is served no worse than
    by «🧮 Hisoblatish» (door-ved-no-prep).
  - It is the existing mechanism and needs no migration. A later ➕ addition re-passes silently, with
    `plainLine` words, so the AI figure the ⭐ rejected cannot come back through «➕ Shu so‘rovga qo‘shish»
    (door-ved-then-add).
  - The record stays honest: the lenta note says «🤖 AI eshigidan keldi — AI hisoblamadi: {sabab}. O‘qilgan:
    {…}».
  - A `to_ved` pressed on a stale table, after a 🔄 made the reading whole, still lands as 'ved'. That is
    what he pressed.
- **(b) The seller's ✅** after a 'ved' landing reads: «🧮 VED navbatiga tushdi — AI hisoblamadi: {sabab}.
  VED xodimi fayllarni ko‘rib, javobni shu yerga yuboradi.» It is never `AI_QUEUED`. `queuedLine` and
  `landedWordsOf` take the landed door AND the item count.
- As built after the as-built review (A), WORDS-2: every bot landing's lenta note names the files refused at
  arrival under its head, «⚠️ O‘qilmagan fayllar (tovarlari hisobga kirmagan): «X» — {sabab}; …» (bounded like
  the table); an addition's thread message and lenta note do too. The ✅'s «fayllarni ko‘rib,» is said only
  when a file reached the card (`fileCount > 0`): of a file past 20 MB the VED has no copy.
- **(c) A landed request with zero items** skips the pass ONLY for a section with a customs half and no
  freight half (rastamojka): `landingItems(facts).length === 0 && sectionParts(section).customs &&
  !sectionParts(section).freight` (door-zero-pass).
  - yolkira keeps its tariff queue on every door.
  - podklyuch keeps its pass, and its customs half says «so‘rovda tovar yo‘q» (ai-reply, aiNoteText).
  - The rule lives in one place and is obeyed by BOTH queue calls in `landIntake`: the normal path and
    `retried()`. The agent door (decide.ts) passes through the same rule.

1.4 **The plain door is unchanged in its keyboard and landing** (his 2a). Its words are fixed by §2.3, and its
READING changes with §4 and §5, because `readIntakeFile` serves both doors.

As built after the as-built review (A), OWNER-3: the bot keeps a cut answer's goods on BOTH doors (§3.6), so the
plain summary of a cut reading says it above its closing, «⚠️ AI faylni oxirigacha o‘qib ulgurmadi — {N} ta
tovar o‘qildi, qolgani o‘qilmadi.» (a size cut: «⚠️ Material juda katta — …»), and the landed note says «⚠️ AI
faylni oxirigacha o‘qimadi — {N} ta tovar o‘qildi, qolgani o‘qilmadi: ro‘yxat to‘liq emas, faylni ko‘ring.» —
seven of twelve goods had read as the whole invoice to the VED. Keyboard and landing unchanged.

1.5 **Pinned by:**
- a unit test over `intakeTableText` + `tableWords` + every function §1.2 lists, for these states: zero rows
  with a file; zero rows with no file; rows plus an unread PDF; a clock cut; a size cut; capped; files
  missing. Each asserts no `c:save` button and no «✅ Tasdiqlash» text where the reading is not whole, and
  today's words where it is whole.
- a NULL-door seeded zero-row table, which keeps today's keyboard.
- a derived fence: every `callback_data` drawn parses (`to_ved` in `CALC_STEPS` and `PRESS_REPEAT`).
- integration tests through `bot-harness`:
  - a zero-goods AI collection → 👤 → landed with `intake_door='plain'`, no AI_QUEUED words, the plain pass
    queued silently — as built (B), on a zero-goods PODKLYUCH; a zero-item rastamojka queues none (§1.3 c,
    which wins; the silent plain pass is also pinned on a not-whole rastamojka WITH rows);
  - a `c:save` on a not-whole collection → the same;
  - 📨 pressed, the landing cut after the note → the sweep's resume → still 'plain', no AI words;
  - 👤 → ➕ addition → no CalcPrefilled chat message (its queued re-pass run, its claim written muted) and never
    «AI qayta hisoblayapti». §1.3 a's `plainLine` words («AI kartani VED uchun qayta tayyorlaydi») stand.
- a unit test that `settleAnalysis` carries every new reading field (§10) and that a cut then a whole
  re-read clears `aiCut`.

1.6 **The ➕ add collection** (door-amend-scope):
- It keeps `amendKeyboard`; no `to_ved` is drawn there.
- When its own reading is not whole, its closing says «⚠️ {what} o‘qilmadi — «✅ Qo‘shish» faqat
  o‘qilganini qo‘shadi, AI qayta hisoblamaydi.»
- Its save writes the addition WITHOUT the `amend:` re-pass, and its words never say «AI qayta
  hisoblayapti».
- A whole add reading keeps today's behaviour.
- As built after the as-built review (A), WORDS-1: the VED's thread head says the same (`appliedHead`):
  «➕ Sotuvchi qo‘shimcha yubordi — so‘rovga yozildi; AI qayta hisoblamaydi ({what} o‘qilmadi) — narxni siz
  berasiz:», and for a stored waiting addition «➕ Kutib turgan qo‘shimcha so‘rovga yozildi; AI qayta
  hisoblamaydi ({what} o‘qilmadi) — narxni siz berasiz.» — it had promised «AI qayta hisoblaydi».

---

## §2 Package P-door: the closing, the words, the landing, the restart

P-door owns §1 (the builder writes `notWholeClosing`, the keyboard, the drawers, `landAs`, the landing door,
the zero-item rule, §1.6), plus everything below.

2.1 The AI door's lone Excel reaching the model is **P-model's (§3.7)**. P-door owns the WORDS around it:
`readingFailure` returns null for `nothing_to_read` on EITHER door when `invoiceGoods` is non-empty
(door-nothing-ai).

2.2 **The tail's words** have four cases (critic-tail-both). «Typed» = `material.some(s => s.trim())`.
- Excel + typed: «Faqat Excel va yozilganidan o‘qildi.» (today's words, kept; c1892 and
  `intake-collector-r4.test.ts:233` stand).
- Excel only: «Faqat Excel'dan o‘qildi.»
- Typed only: «Faqat yozilganidan o‘qildi.»
- Neither: «Hech narsa o‘qilmadi.»

As built after the as-built review (A), OWNER-12: on the AI door's first or seeded table a `rejected` failure
whose PDFs the closing names («📄 «X.pdf» — AI bu faylni qabul qilmadi») leaves the tail's generic «AI so‘rovni
qabul qilmadi …» sentence out (`failureSaidBelow`); the «what WAS read» line stays.

2.3 **The reading notice** (xlsx1-10, zero-05, apireq-3, pdfimg-7, critic-notice-kind). At settle,
`pendingReply.notice: 'read' | 'cut' | 'failed' | 'no_model' | 'arrived'` is stored. `deliver()`, the late
send and the sweep edit «⏳ AI o‘qiyapti…» by it:
- `read` → «✅ O‘qildi — natija pastda ⬇️»;
- `cut` → «⚠️ AI oxirigacha o‘qimadi — natija pastda ⬇️»;
- `failed` → «⚠️ AI o‘qiy olmadi — sababi pastda ⬇️»;
- `no_model` → «📊 Fayl o‘qildi — natija pastda ⬇️»;
- `arrived` → «⬇️ Yangi xabarlar keldi — pastda».

A `pendingReply` stored before the deploy has no `notice` and keeps «✅ O‘qildi».

As built after the as-built review (B), the rule the words follow (`noticeKindOf`, OWNER-9 i), first match wins: `cut` — a cut, an input cut or a
capped file; `failed` — a stored file not loaded or a refused PDF; `read` — the model answered; `failed` —
model-only material unread, or a failed call other than nothing_to_read / not_configured / budget; `no_model` —
Excel rows or a goods file; otherwise `read` when something was typed, else `failed`.

On «Bo‘ldi» with nothing accepted but `refusedFiles` present, the bot does not say «Hali hech narsa
yuborilmadi». It says «Yuborilgan fayllarning birortasi ham o‘qiladigan emas: {X — sabab; …}.» and starts no
reading.

2.4 **The restart question refuses material in words** (dialog-03, door-restart-hold). Holding the material
and carrying it over would need a burst model the restart question is not part of. The design takes the
verifier's simpler alternative:
- `state.restartAsked: { messageId: number | null; at: number } | null` is set where the question is asked
  (staff-handlers.ts, c:ai/c:aipk/section on a live collection).
- While it is set, the file door, the forward door and the text ladder answer, kept last, «⏸ Avval yuqoridagi
  savolga javob bering — «🔄 Ha, boshqatdan» yoki «▶️ Yo‘q, davom etaman». Yuborganingizni javobdan keyin
  qayta yuboring.» They file NOTHING into the old collection. As built after the as-built review (B), WORDS-10: the last sentence was
  «Faylni javobdan keyin qayta yuboring.», which told a seller who had TYPED «3-qator 50 kg» to re-send a file he
  never sent; one sentence for all three doors.
- It is cleared on «🔄 Ha» (the new collection), on «▶️ Yo‘q» (`c:resume`, unchanged otherwise), and on
  cancel, read or save. The question's buttons are stripped when it clears.
- It also clears after 30 minutes (`HOLD_MS`), so a forgotten question never jams the chat.

2.5 **A storage miss is retryable** (pdfimg-3). `loadIntakeFiles`' `missing > 0` is written to
`state.filesMissing`.
- With nothing else read, it is the new failure `files_missing` (retry: true): «⚠️ {N} ta fayl saqlangan
  joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.»
- It is never `nothing_to_read`.
- `filesMissingNote` is then not pushed, so there is one sentence per fact (critic-said-twice).
- With other material read, the reading is not whole (1.1 e) and 🔄 is drawn. The note's words become the 🔄
  sentence.

2.6 **The parked collection's old «Bo‘ldi»** (dialog-02) is **not built** in this round; see §8. The verifier
measured it as narrow: it needs 30 minutes of silence and a seller who ignores the newest message. A silent
take would break his recorded 1.8 c (door-burst-consent).

---

## §3 Package P-model: the reading finishes, or keeps what it read

P-model owns `analyzeIntake`, `intakeContent`, `sheetsPromptText`, `readIntakeResponse`, the attempt loop,
`aiFailureOf`, and the prompt-text changes of §3.7 and §4.1 (critic-split). It also owns
`analyzeCollected`'s writing of the reading fields (§10), `from-thread.ts`, and the PDF and size refusals in
`calc-files.ts` / the file doors.

3.1 **Effort `medium`** (`output_config.effort`, typed in SDK 0.114):
- The reading is transcription plus a code PROPOSAL. A person confirms it, and the landing pass codes the rows
  again.
- The Opus 5 model guide calls `low`/`medium` «unusually effective» and the primary latency lever.
- Measured nowhere here (no key). It is stated to him, and the log line (3.5) shows the effect.

3.2 **Streaming, with the leash enforced by the caller** (model-leash-unbounded):
- The call is `client.messages.stream(params, { signal })`.
- The signal is an `AbortController` aborted by a timer at `left`. `stream.abort()` runs in a `finally` on
  every exit.
- The client `timeout` stays only as the connect/headers bound.
- `INTAKE_MAX_TOKENS` = 32 000.
- **`INTAKE_TIMEOUT_MS` stays 150 s** (model-time-sum). The job's pinned budget `calc-read-press.test.ts`
  sums to exactly 290 s, and «3 daqiqagacha» stays true.

Tests that move (model-tests-reanchor): `intake-ai-codes-cut`, `intake-answered` and `intake-known-codes`.
They move onto ONE shared SSE stand-in fixture, `tests/fixtures/sse-anthropic.ts`. The fixture supports:
- `message_start` → text deltas at a chosen pace → `message_delta` usage → `message_stop`;
- the variants `abortAfterMs`, a mid-stream `event: error`, and a socket drop.

No test hand-stubs `stream()`. `readIntakeResponse` stays pure over the final message, so its pins stand.

3.3 **A cut keeps what it read** (model-midstream-errors, model-salvage-scanner, door-cut-retry,
model-cut-unbilled):
- **A cut** is any attempt that ended after `message_start` with text in hand:
  - an abort (the clock);
  - `max_tokens`;
  - a mid-stream `event: error`;
  - a mid-body socket drop.
- **The scanner** is a hand tokenizer over the accumulated text. It tracks string state and backslash
  escapes, locates the top-level `"goods"` array, and keeps an element only once its closing `}` is reached
  at array depth. Each kept element is re-validated with the per-good zod object: all keys present, no
  defaults. The totals before `goods` are kept only when their values completed. **Never `partialParse`,
  never MessageStream's partial snapshot.** Pinned by cutting a 2-good answer at every byte, with names
  holding `{`, `}` and `\"`: the scanner never returns a third good and never a figure absent from the full
  answer.
- **Salvage** happens on the attempt that ENDS the reading. PF-ADV-13's codes-free retry still fires for a
  `truncated` answer with zero complete goods. A cut with ≥ 1 good is
  `{ ok: true, cut: { goods: N, why: 'clock' | 'size' | 'dropped' } }`. It is never retried, and a refusal is
  never salvaged.
  - With no complete good, a drop or an overload may retry under the half-leash rule.
  - `aiFailureOf` maps a status-less `APIError` by `err.type`: `overloaded_error` / `api_error` →
    'overloaded'; `rate_limit_error` → 'rate_limited'; anything else → 'rejected'. `AnthropicError
    ('terminated')` → 'network'.
- **Billing.** Every attempt that received `message_start` is pushed to `answered`, whether it was cut,
  aborted or dropped:
  - `inputTokens` comes from `message_start`;
  - `outputTokens` comes from the last `message_delta` usage, or else ⌈text chars ÷ 3⌉, stated as an estimate
    in the code. As built after the as-built review (B), OWNER-9 f: ⌈(answer + thinking chars) ÷ 3⌉ — thinking is billed output, and
    the estimate exists so the day's cap counts the attempt.

  A cut outcome carries `answered` like any other.
- **Codes.** `known_codes` stays the last property. A cut drops the codes, and the landing pass codes the rows
  (stated).
- As built after the as-built review (A), MODEL-2: «≥ 1 good» is judged INSIDE the goods array. A cut after the
  array's own «]» (`salvageCut().goodsClosed`) read every good it meant to — goods [] beside an Excel included,
  the AI door's commonest answer, whose longest tail is `known_codes` — so it is an ordinary reading with its
  totals and steps and NO `cut` (logged; only the codes are lost). Before, it was a 'timeout' failure that lost
  the totals, or a blocking cut over a finished list.
- As built after the as-built review (B), OWNER-2: beside no Excel, a CUT answer's goods are the model's completed ones FOLLOWED by every typed
  line no model line names (its figures as typed). «The model answered, so its goods are the list» was written
  for a whole answer: the caption «Erkaklar shimi 50 dona» beside an unmapped Excel, and the goods the remedy
  asks to be typed, were dropped by every cut. The trade, stated: a typed good the model read under another name
  is listed twice — on a table that draws no ✅ (a cut).

3.4 **What the API refuses, named.**
- **An encrypted PDF** (model-encrypt-sniff). In `readIntakeFile`'s pdf branch, look for `/Encrypt <n> <g> R`
  in the trailer region only: the last 4 KB plus the first 2 KB, for a linearized file. NEVER do a
  whole-file grep, because content can mention /Encrypt.
  - It is a WARNING at arrival, and the PDF is kept: «⚠️ «X.pdf» parol bilan himoyalangan bo‘lishi mumkin —
    AI o‘qiy olmasa, parolsiz saqlab yuboring.» An owner-password-only PDF may be read fine.
- **A request refused with document blocks** (apireq-2, pdfimg-9 betterFix a+b). On 'rejected' with PDFs in
  the request, make ONE more attempt inside the leash without the PDFs; a 400 is instant and unbilled. Those
  PDFs' attachment ids go into `state.unreadPdfs`, and later re-reads skip them. They are named in the table:
  «📄 «X.pdf» — AI bu faylni qabul qilmadi». The reading is not whole (1.1 d).
- **A file over Telegram's 20 MB bot limit** (pdfimg-5, model-20mb-refusal):
  - `fileOf` carries `size` (from `document.file_size` / `photo.file_size`).
  - The collector doors check `size > MAX_TELEGRAM_DOWNLOAD_BYTES` before `getFile`, and read getFile's «file
    is too big» description as the same refusal. The doors are staff-handlers' file door and calc-amend's two
    media doors.
  - `saveIntakeFile` returns a typed refusal (`too_big` | `download_failed`) instead of null. The zametka door
    keeps its own words.
  - The refusal says «Fayl 20 MB dan katta — Telegram uni botga bermaydi. Kichikroq qilib (yoki Excel)
    yuboring.» It is recorded in `state.refusedFiles`, never in `fileCount`.
  - **The caption is read on every refusal**, so typed goods are never lost with the file.
- **pdfimg-8.** `receivePdf` has two sentences: the count cap («3 tadan ortiq PDF») and the byte cap («PDFlar
  jami 12 MB dan oshdi»). Every refusal there writes `refusedFiles`.
- The photo cap writes `refusedFiles`, so pdfimg-12's skipped count is kept on the table. The model is told
  what it was SHOWN («показано N фото, M PDF»).
- As built after the as-built review (B) (OWNER-9 c, MODEL-6 (3)(4)(11), MODEL-3, REGRESSION-5):
  - `saveBotFile` (the one home of the crossing; `saveIntakeFile` and the zametka door call it) returns FOUR
    typed refusals: `too_big` (past Telegram's 20 MB, checked before `getFile`), `too_large` (a picture past
    storage's 15 MB photo ceiling: «🖼 «X» — rasm 15 MB dan katta, saqlanmadi. Kichikroq qilib (yoki PDF)
    yuboring.»), `unsupported` and `download_failed`. The zametka door keeps its own words for all four.
  - The caption is read on every refusal NO RE-SEND HEALS (`too_big`, `too_large`, `unsupported`). A
    `download_failed` takes nothing at all three doors: the same message re-sent brings file and caption once.
  - An HTML or XML table, or an .xlsb, is a type storage keeps no attachment of; told by its name, else its mime:
    «📎 «X» kartada saqlanmadi: HTML jadval o‘qilmaydi — Excel’da .xlsx qilib saqlab yuboring.» (XML jadval,
    Excel binary (.xlsb) alike). Every other unsupported type keeps «… rasm, PDF va Excel/CSV yuboring.».
  - pdfimg-8's caps count only the PDFs a reading will SEND (`pdfs` less `unreadPdfs`): counted, a refused PDF
    refused the very password-free copy its warning asks for.
  - The refused PDF's «later re-reads skip them … The reading is not whole» above is §1.1 d's as-built rule: it
    blocks the table of the reading that met the refusal, and is named, not blocking, after.

3.5 **The log line** (model-thinking-null). `[calc intake] model tokens` carries `in`, `out`, `thinking`,
`stop`, `ms`, `cut`, and the material counts (images, pdfs, sheets, known).
- `thinking`, the final `out` and `stop` are read from the RAW `message_delta` stream event, never from
  `finalMessage().usage`. The SDK's accumulator drops `output_tokens_details`.
- An abort logs `stop: 'aborted'`, the estimate and `textChars`.
- `calc intake AI failed` carries `ms` and the same counts.

3.6 **The thread door** (model-thread-door-cut). `analyzeIntake` takes a REQUIRED `salvage: boolean`:
- the bot passes true;
- `from-thread.ts` passes false, so a cut there is today's 'timeout' with the manual parser and «retry».

3.7 **The lone Excel is coded by the model** (0.1, door-nothing-ai, critic-split, sheets-04 (3)):
- `analyzeIntake` computes `knownList`/`ask` ABOVE the guard. It counts
  `input.codeKnown === true && knownList.some((_, i) => ask(i))` as something to read, so an all-coded Excel
  makes no call.
- When the numbered list is the only material, `intakeContent`'s empty-material line is «Других материалов
  нет: goods оставь пустым, дай только known_codes для строк списка». The line is chosen by what was SENT
  (xlsxN-14). «Текста нет — читай фото и документы» is printed only when photos or documents ARE there.
- A packing-shaped goods sheet's own text (`goodsFiles[0].text`) is passed to the model under the TOTALS
  heading («только для итогов … НЕ перечисляй»), and only when `codeKnown`. It is read in `analyzeCollected`
  and never stored in `invoiceTexts`.
- As built after the as-built review (A), MODEL-8: the rows a reader dropped under a list (§5.5), handed to the
  model on the AI door, are marked `dropped` and never count as something to read: an all-coded Excel with a
  «Buyer signature» row under it makes no call. Beside a reading that happens anyway they are still shown.
- As built after the as-built review (B), OWNER-1 / MODEL-1 / SHEETS-2 / REGRESSION-3 (merge seam 1): the goods sheet's own text is passed
  only while it is the collection's ONE goods file holding every row, uncapped (`loneGoodsFile`, the rule
  `loneFileTotals` reads) — exactly where the file's own totals outrank the model's. After a fold (another
  factory's sheet, or a second factory's file) `goodsFiles[0].text` is ONE factory's sheet with ONE factory's
  TOTAL under a heading that asks for the shipment's totals, and nothing outranked the model's figure: factory
  A's brutto and cube landed as the shipment's under a ✅, and on podklyuch the road was priced on them. Beside a
  fold the model is shown no goods-sheet text, the brutto is asked and the cube is the rows' Σ (§4.3).
- As built after the as-built review (B), the closing as built has six branches (MODEL-6 (7), OWNER-9 g): «Материалы: …» with typed text;
  «Текста нет — читай фото и документы.» with photos or PDFs; «Текста нет — читай таблицу выше.» beside a GOODS
  sheet text only; with codes asked, «Текста нет: goods оставь пустым (товары уже взяты); общий вес и объём
  возьми из листов выше; коды — в known_codes.» when a context sheet with rows is shown, else «Других материалов
  нет: goods оставь пустым, дай только known_codes для строк списка.»; and «Текста нет.» for a context-only
  reading.
- Pins: `intake-images.test.ts:51` is re-anchored. Three tests:
  - an AI-door lone Excel makes ONE call;
  - an all-coded Excel makes none;
  - a plain-door lone Excel makes none.

3.8 **Code-point-safe cuts** (apireq-1, model-cuts-inventory). Use **`clipUnits`**
(`platform/text/clip.ts:49`; NOT clipText, NOT Array.from) at:
- goods-file.ts:368 and :374 (built by P-sheets, which owns the file);
- intake-ai.ts:515 and :912;
- goods-import.ts:1201 (built by P-reader-A).

`intakeContent` runs `.toWellFormed()` over every text block as a fence. A unit test puts an emoji at each
boundary, plus a 299-unit description + emoji through `parseGoods`. It asserts that `JSON.stringify(params)`
has no lone `\ud8xx`.

---

## §4 Package P-sheets: every mapped sheet of a workbook is judged

P-sheets owns `goods-file.ts`, `readIntakeFile`'s sheet branch, `receiveGoodsSheet`, `file-goods.ts`, and in
`calc-intake.ts` both `pickGoods` and `loneFileTotals`. The scope was REDUCED in v2: v1's three-way rule had
five blockers (sheets-01..05). It keeps today's behaviour wherever a sheet cannot be PROVEN to be other goods
or packing data of the same goods.

4.1 **The loop.**
- `readGoodsFile` returns, beside `goods`, every OTHER visible sheet whose header it maps, as `moreSheets`.
  Each entry carries `{ goods, shape, weightKind, grossKg, grossColumn, volumeM3, ownText }`.
- `text` then holds the UNMAPPED sheets only, with their own `textCut` / `cellsCut` (sheets-07).
- `readIntakeFile` is readGoodsFile's only caller (sheets-09). The deal-card import reads `workbookRows`
  (first sheet only) and is unchanged (§8).
- **The judgement lives inside `readIntakeFile`, as a loop of `receiveGoodsSheet` over [goods sheet,
  ...moreSheets]**, so every door shares one rule (sheets-06). Those doors are the fresh collection, the burst
  take, and calc-amend's two media doors.
  - Each step takes the state the previous step left, so «held» is everything so far.
  - `at.files` stays `fileCount + 1` for every sheet; the doors increment once per FILE.
  - `fileNotes` and the say accumulate into ONE patch and one `say`.
  - `sameFileAgain` judges the workbook as a WHOLE. Once it is «already sent», the loop stops.
- **The goods sheet** is the sheet with the most mapped rows, the first on a tie (today, sheets-03 (1)).
- As built after the as-built review (B) (SHEETS-6 (6)): a `moreSheets` entry also carries `dropped` (§5.5's rows the reader did not take,
  per sheet — SHEETS-1) and its `stoppedShort`.

4.2 **Each further mapped sheet, by its SHAPE** (sheets-02):
- **Packing-shaped, of the held goods.** «Of the held goods» means one of:
  - `packingOfHeld`, as a second file uses it today;
  - inside ONE workbook only, a packing-shaped sheet with exactly the goods sheet's row count, beside an
    invoice-shaped goods sheet, sharing NO script with it (R1: an EN CI + a ZH-only PL). Its totals come from
    the PL's Σ, and its netto fills go by POSITION.

  → `fileTotals` plus the netto fills (`packingFills`, or the positional fill for R1), exactly as a second file
  gives them. **In a top-up this is `notedTotalsNote`, never `fileTotals`.** The exposure is stated: a
  two-factory workbook of equal length in two scripts loses factory B (sheets-05 (a)).
- **Proven OTHER goods** (sheets-01). ALL of these must hold:
  - both sheets state a piece count on every row, and the Σ pieces differ;
  - the names share a script;
  - every further row is `otherName` (exported from file-goods.ts) against every held row.

  → folded as new goods (`foldInvoice`) and named: ««Zavod B» varag‘idan 4 ta yangi tovar qo‘shildi». Its
  text goes nowhere (sheets-07 (2)).
  - As built after the as-built review (A), REGRESSION-1: a fold that would take the held list past the
    queue's own limit (`MAX_CALC_ITEMS`, 1000) is not made — three sheets of 400 had folded into a table that
    invited «✅ Tasdiqlash» and whose press ended the collection with every file lost. The sheet keeps today's
    reading and the seller is told «📄 «X», «Zavod 3» varag‘i qo‘shilmadi — bitta so‘rovda 1000 tadan ortiq
    tovar bo‘lmaydi; boshqa tovarlar bo‘lsa, bu varaqni alohida so‘rov qilib yuboring.» (the conditional is (B)'s,
    below).
  - As built after the as-built review (B), REGRESSION-2: past that limit the sheet is not JUDGED either — a list that held + this sheet's rows
    would pass is not asked `provenOther` (every row against every held row; ten sheets of 500 cost 4 s of
    synchronous CPU on the one process the poller awaits, twenty sheets two minutes). A fold only keeps or adds
    rows, so the answer cannot matter. Unjudged, the sheet may be the same goods again, so the cure is
    conditional: «boshqa tovarlar bo‘lsa, …».
  - As built after the as-built review (A), SHEETS-1: every further sheet carries its own dropped rows
    (`MappedSheet.dropped`, §5.5). On a fold and on a packing-of-held sheet they are said on receipt under the
    SHEET's label («📄 «X», «Zavod B» varag‘i — ostidagi 2 ta qator tovar deb olinmadi: …») and kept in
    `fileNotes`; on a fold the AI door hands them to the model too (a folded sheet's text goes nowhere else).
    A sheet kept on today's reading says nothing of them: none of its rows is taken and its whole text goes to
    the model.
  - As built after the as-built review (B), SHEETS-6 (1)(2): R1 also requires the held list to BE the goods sheet's rows, place for place (the
    same name key at each index), so R1 never fires after a file or a folded sheet came first. In a top-up,
    `provenOther` also holds the further sheet against the request's STORED rows (names only — the FILES-2
    priced-twice fence), so a Cyrillic «Zavod B» beside Latin stored rows is not proven other.
  - As built after the as-built review (B), SHEETS-3: once a fold has widened the held list (two goods files held), a packing-shaped sheet
    gives the shipment's totals only when it answers for the WHOLE list (`packingCoversHeld`: the same Σ
    pieces, or every held row met by a row of its own). Factory A's packing list beside factory B's folded goods
    passed `packingOfHeld` (most of ITS rows meet held rows) and its Σ was written and announced as the
    shipment's, factory B's cargo out of both. Now it fills netto and is said as a part: «📄 «X», «PL A» varag‘i —
    ro‘yxatdagi tovarlarning bir qismi: boshqa tovarlar unda yo‘q, shuning uchun umumiy brutto va kub butun yuk
    uchun olinmadi.»; its text goes nowhere (under the totals heading its Σ came back through the model). With
    one goods file held the loose rule a second file has always had stands. Totals a packing list gave BEFORE a
    fold are dropped by the fold and said («CI A, PL A, CI B»): «📄 «X», «PL A» varag‘i — undan olingan umumiy
    brutto va kub endi butun yukniki emas: ro‘yxatga boshqa tovarlar qo‘shildi, shuning uchun olinmadi.». The
    loss, stated: a packing list that happened to list factory B's goods too is dropped with it, and the seller
    answers one figure. Workbook sheets only; three FILES are §8's.
  - As built after the as-built review (B), SHEETS-6 (4): every sheet line is said with its file's label first («📄 «file», «Zavod B»
    varag‘idan …») — the house style of every file line, since a seller forwards workbooks whose sheets share
    names.
- **Anything else** (an invoice-shaped sheet of the same goods, or any sheet that is not proven either way) →
  TODAY's behaviour. Its text goes to the model under today's totals heading («НЕ перечисляй»; the C2/C6 fence
  is untouched, so c0782 and c1336 stand). The seller is told, once per sheet: ««{X}» varag‘i — o‘sha tovarlar
  deb olindi (faqat jami uchun o‘qildi); boshqa tovar bo‘lsa, alohida fayl qilib yuboring.»
  - The PL-first role swap of an invoice sheet is NOT built (sheets-03 (2-4), §8). A PL-first workbook keeps
    today's reading: the PL's rows, and the CI's codes as model proposals.

4.3 **loneFileTotals and the ✅ total.** loneFileTotals is unchanged for a single goods sheet. When a further
sheet was folded, `goodsFiles` has two entries and today's rule already refuses the lone total.
As built after the as-built review (B) (OWNER-1, MODEL-1, SHEETS-2, REGRESSION-3): the same rule now gates what the MODEL is shown (§3.7) —
beside a fold it was handed factory A's sheet under the totals heading and its figure landed. The Σ of the
folded sheets' own gross and cube is NOT written as the shipment's (§8).

4.4 **The words:**
- The arrival line never claims «boshqa varaqlarni AI o‘qiydi» about a sheet it did not hand the model as
  goods. It says «boshqa varaqlar faqat jami uchun o‘qiladi».
- A sheet whose header WAS found but which landed 0 rows does not say «sarlavhasini topa olmadim» (xlsx1-04
  betterFix). Neither does a cover or picture sheet with no goods rows (unmapped-misleading-receipts).
- A workbook that yields no goods and carries embedded images says «Excel ichidagi rasm o‘qilmaydi — rasmni
  alohida (rasm yoki PDF qilib) yuboring.» (unmapped-embedded-picture-dropped).
- As built after the as-built review (B) (SHEETS-6 (3)(4)(5)): with a further MAPPED sheet the arrival clause reads «tovar qatori olinmagan
  varaqlar faqat jami uchun o‘qiladi» (the sheets no goods row was taken from), never «boshqa varaqlar» about a
  sheet folded in two lines down. Two words the spec does not give are the builder's: «jadvaldan tovar
  qatorlarini o‘zim ajrata olmadim, AI o‘qiydi.» (a header found, 0 rows) and «jadvalda tovar qatori
  ko‘rinmadi.» (no row pairs a name with a figure). The picture-only workbook is also a named refusal
  («ichida faqat rasm, jadval yo‘q», §1.1).

4.5 **The top-up packing file** (known-2). A packing-shaped file is a NOTED file only while there are kept or
held rows for it to be the totals of. With zero kept rows and zero held rows (a returned request with no rows,
or a ➕ on an empty request), it is the goods list, as on a fresh collection.

4.6 **A model line is never dropped in silence** (xlsxN-02 betterFix 4, narrowed by sheets-08).
- In `pickGoods`, with `aiGoods === null` and an invoice held, a model line that matches no invoice row is
  NAMED only while the collection holds model-read material that can carry other goods: a header-less other
  sheet in `invoiceTexts`, or typed text. Photos stay under the existing `modelSawImages` branch.
- Even then, a line is skipped when it meets exactly one invoice row by an equal count under non-contradicting
  names, or by position in an equal-length list.
- The line is named, not added: «AI fayldan yana «X» ni topdi — ro‘yxatga qo‘shilmadi, VED ko‘radi».
- Collector corpus pins:
  - a lone single-sheet Excel whose model answer is count-only translations of every row → `notes: []`;
  - K10 with the model listing the other sheet's goods → handled by 4.2's fold.

4.7 **Pins:**
- R1 as one workbook → 12 rows, deterministic `fileTotals`, netto by position.
- K10 / G / J1 (counts on every row, Σ differ) → folded and named.
- These keep today's rows plus the new sentence:
  - an RU CI + an RU short-name PL;
  - an EN «Ladies jacket, black» CI + a «Ladies jacket» PL;
  - K10 with B at 300/200 (two invoices) → 5 rows only if proven, else today's plus the sentence.
- The summary-invoice workbook in both sheet orders → today's rows.
- One bot-harness case per door (fresh, burst take, ➕ media).

---

## §5 Packages P-reader-A and P-reader-B: the column reader (goods-import.ts)

The corpus rule (CLAUDE.md), sharpened by reader-corpus-blind, applies to EVERY item:
- The regression shapes the verifier measured against the CLAIM's fix become corpus cases BEFORE the change,
  each with its expected answer.
- Every parseGoods case this round touches, and every new one, asserts `unit` and `note` where the
  expectation depends on them. Add `unit: null` to c1778 and c2453 now.
- Each item lands with a one-off old-vs-new differential of parseGoods / readGoodsFile over all
  `parseGoodsCases` and `readGoodsFileCases` inputs plus the finding's shapes. Every changed output is listed
  and justified in the commit.
- The whole corpus runs before and after. The ratchet may only shrink.
- The deal-card import route's tests and `send-rows`' tests run too, because both are callers.

**P-reader-A (findHeader, the name ladder) — first:**

5.1 **A header below row 10** (xlsx1-02 betterFix, verbatim):
- Rows 10-49 are searched with two guards that apply there only:
  - a row carrying a figure is data;
  - a header found that deep must name a figure column (quantity / weight / volume / amount / gross).
- c0215 is re-anchored to `goods` / 130 rows.
- New corpus cases: long header-less lists with a name-key word in a data row, and a party row inside a long
  title block.

5.2 + 5.3 **The name ladder** (reader-5.2-5.3-ladder, rewritten on xlsxN-06's variant C):
- (a) '货名' goes into NAME_KEYS and NAMING_HAN.
- (b) Directly after the first rung, a product rung: `findColumn(header, ['product','commodit','номенклат'],
  taken, i => namesTheProduct(h) && wordy(i))`.
- (c) The running-serial guard (cells exactly 1..N, or article numbers, while a wordier column exists) applies
  on the rungs at ≈:778, :779 AND :780.
- (d) A LAST rung only for 'наим' and 'yuk turi', guarded by `lastNames && wordy`. NAME_KEYS is not otherwise
  widened.
- Corpus cases:
  - «ITEM | PRODUCTS»;
  - «Item No. | Product»;
  - «Product | Brand name»;
  - «货名 | 品牌名称»;
  - «Commodity | Customer name»;
  - «Номенклатура | Количество»;
  - «№ | Наим. | Кол-во»;
  - c1936 unchanged;
  - «Product | Description» in both shapes, with the chosen answer written down.
- As built after the as-built review (B) (SHEETS-7): the article-number half of (c)'s serial guard applies only under a header that names the
  goods with «item» alone (no first-tier name key); «a wordier column» is one that could hold goods (not a
  party or an attribute column). Unscoped, «Item No. | Customer name» lost its header.

5.6 **A label|value card** (reader-5.6-card).
- **The primary rule is a REFUSAL inside findHeader.** A candidate is refused as a transposed header when
  either holds:
  - (a) its other filled cell is a VALUE, not a key;
  - (b) most of the chosen name column's sampled cells are whole-cell field labels (short, no digits, an
    optional «:», from an exact label vocabulary, never `matchKey`).

  The sheet then falls to `kind: 'text'` for the model.
- **A deterministic one-good transpose is an extra.** It runs before the loop, only when ALL of these hold:
  - exactly two columns;
  - exactly ONE name label;
  - every label is a known field.

  The line weight comes from a netto label only; a brutto label goes to `grossKg`. The result carries a
  headerRow, so `readGoodsFile` keeps it.
- Corpus cases:
  - the uz/ru/en/zh cards;
  - stacked cards → text, with both goods reachable;
  - colon and no-colon cards;
  - a unit-column card;
  - a column-C card;
  - «Весы напольные / Весы кухонные» → kept as a list.
- As built after the as-built review (B) (SHEETS-7): a PLAIN weight label («Vazni», «Вес») is the card's line weight, as a plain weight
  column is on a table; only a BRUTTO label goes to `grossKg`. «A netto label only» would drop the weight of the
  commonest Uzbek card. (a)'s «a VALUE, not a key» means: exactly one other cell, naming no column, over a column
  of mostly figures or codes («Товар | Цвет» stays a table). (b) and §5.8's label data count only ANOTHER
  field's labels and cells ending «:».

5.7 **A data row taken as the header** (unmapped-product-name-as-header betterFix, both parts):
- (1) A multi-cell candidate any of whose NON-name cells reads as a figure is data.
- (2) Inside `filled(header) < 2`, after the two existing refusals, the ladder may take a one-cell row only if
  `listHeadingLine(text) || TITLE_LINE.test(text)` (reader-5.7-onecell).
- Corpus cases:
  - Q4, the five names with «Товары для дома» → all five, no header;
  - «Хозтовары», with the answer written down;
  - c1790, c1791 and c0169 unchanged.

5.8 **A letterhead label taken as the header** (reader-5.8-colon):
- The «name cell ending in «:»» rule is DROPPED.
- The rung at :780 (`findColumn(header, NAME_KEYS, taken, i => !allCodes(i))`) never takes a NAME_PARTY head.
- Best-of-ten: among the first ten rows, choose the candidate that maps the most columns besides the name; a
  tie keeps the earliest. A corpus differential measures it.
- Label data: a name column whose sampled DATA mostly end in «:»/«：», or are whole-cell field labels, is no
  name column.
- Corpus cases:
  - «Товары:», «Goods to be shipped:», «产品清单如下：» and «Наименование: | Кол-во: | Вес:» are still found;
  - «Company Name | …» and «公司名称 | …», with and without a colon;
  - «Customer name:»;
  - «Наименование | Примечание».

5.12 **A bilingual header on two rows** (reader-5.12-twoheader). A row at ANY position after the header is a
header row when all three hold:
- it has no numeric value in any mapped figure column;
- its name cell is a header phrase;
- at least one other mapped cell matches that column's own key family.

`findHeader` returns `dataFrom = r + 2` when such a row sits directly under the header, and `columnCells`
excludes such rows from its sampling. Pin ZH/EN, EN/ZH and RU/EN, each asserting `grossKg`, `volumeM3` and
`tnvedCode`:
- the one-good file, with its tnvedCode kept;
- the page-break repeat.

Also in P-reader-A: the goods-import.ts:1201 `clipUnits` cut (§3.8).

**P-reader-B (rows and figures) — on P-reader-A's commit:**

5.4 **Total rows** (reader-5.4c-silent-arith, reader-5.4ab-vocab). ONE exported predicate `totalRowOf(row)`
is asked by `push()`, `stoppedShort` AND `totalRows` / `contradicts` (#513). A row is not a good when one of
these holds:
- **(a) A label-only total.** After stripping the total word(s) and the closed qualifier vocabulary, nothing
  word-like is left. The total words are:
  - TOTAL, Итого, Итог, Всего, Jami, Umumiy, Жами, Умумий, Общий итог, 合计, 总计;
  - «Sum» as a whole word;
  - «X Итог/Total», with the total word LAST (an Excel subtotal).
- **(b) A figure-less footer** holding a whole word of the CORE words only (total/итого/всего/jami/合计/总计),
  or the «say total» phrase.
- **(c) Σ-equality**, which may drop a row ONLY when its name also carries a whole-word total word (the
  subtotal form) or is empty or label-only. A word-only product name whose figures equal the Σ is KEPT. At
  most it gets a line note: «bu qator yuqoridagilar yig‘indisiga teng — jami qatormi?».

Every row dropped under (a), (b) or (c) is named in `dropped` (5.5).
- Kept: «TOTAL cordless drill», «TOTAL QUARTZ 9000» (and the Σ with it, with no closing TOTAL), «Umumiy
  maqsadli lak», «Итоговая папка», «Sumka ayollar».
- The colour/size variants (100/200/300 with proportional kg and m³, or a qty-only 5/10/15, or a same-price
  100/100/200) all stay goods.

5.5 **Trailing footer rows** (reader-5.5-footer, xlsx1-06 betterFix). After the LAST row that «states
something», figure-less rows are not goods and do not null the Σ. A row states something when it has:
- a mapped figure;
- a TNVED code;
- a unit cell;
- or a covered merge-down position.

Figure-less landed rows below the last grand-total row are trimmed as well. The trim never applies when no
row states anything, and never in the headerless branch. A section heading between figure rows (V7) is
untouched.

`parseGoods`' result gains `dropped: { text: string; why: string }[]`, threaded through:
- `GoodsFileRead`;
- the deal-import JSON;
- on the AI door, the dropped text goes to the model as context and is printed on receipt («ostidagi N ta
  qator tovar deb olinmadi: …»).

As built (P-reader-B fix round): every dropped row carries its `name`, and reaches a reader on each surface
or the trim does not apply there.
- The bot (both doors): `readIntakeFile` hands `droppedRowsLine` and the named rows' text to
  `receiveGoodsSheet`; the line is said on receipt and kept in `fileNotes` (the prompt, the card's note). Only
  on the AI door do the rows join `invoiceTexts` (the model's context); the plain door asks no model of a lone
  Excel and a footer does not start one. A label-only «TOTAL» is said to nobody and handed to no model.
- The deal card's import shows every non-label-only dropped row under the draft, each with «＋».
- The VED paste keeps the tail (`SheetHints.keepTail`): a figure-less pasted line is not trimmed as a footer.
  It is NOT every line (the as-built check's check-b-paste-claim-overstated): a label-only total (rule a) and a
  figure-less line with a CORE total word (rule b, «Total station Leica» with no figures) still leave the paste
  unsaid — the same as on main before this round, stated and not changed.
- (c) drops a row only in a subtotal's shape: the last word a subtotal word (never umumiy/умумий/sum); or
  the first word Итого/Всего/Jami/Жами/Подытог/Subtotal (1C's «Итого по разделу …»), a leading 合计/小计…,
  or «Grand/Sub/Общий» + a total word — never the Latin «TOTAL …» alone (a brand); or an empty name. A blank figure adds
  nothing to the window; an unread one poisons its kind only; a figure-less heading is no line of the Σ.

5.9 **Figures as text** (reader-5.9-decimal-comma, critic-paste-5.9; xlsxN-07 betterFix verbatim). The comma
is settled once per figure column (quantity, weight, gross, volume, amount), from that column's own string
cells.

The column reads as a **decimal comma** when either holds:
- a cell has 1-2 or ≥ 4 digits after the comma;
- the CSV is «;»-delimited.

It reads as a **thousands comma** when any of these holds:
- a comma group is followed by a dot;
- a cell has two or more comma groups;
- a dot decimal stands beside the comma figures;
- the CSV is «,»-delimited with quoted cells.

A piece column with no quantityUnit is always thousands.

Only a cell of the exact AMBIGUOUS shape (1-3 digits, a comma, 3 digits) takes the column's reading. With no
evidence, it is null plus the note «soni «1,500» — aniq emas» on **GoodsRow.note**, which the bot, the paste
and the deal import all carry.

Unchanged by this rule: every other string keeps `parseNumber` («1.234,56», «1 234,56», negatives, «0,125»);
numeric cells are untouched; the glued branch takes the same column decision.

As built after the as-built review (B) (SHEETS-7): a column with no evidence of its own takes the SHEET's evidence (the HTML pin's «1,950»
money column holds only ambiguous cells; the evidence is the «0.15» cube beside it). The glued branch («1,200KGS»)
takes ONLY its own column's evidence — never the piece rule or the sheet's — or round 1's pinned c0076-c0081
would flip. «A piece column with no quantityUnit» is judged per row (the row's unit cell empty or a piece unit).

Corpus cases, plus send-rows' paste cases:
- an en-US CSV «"1,500"» → 1500;
- an HTML-.xls «1,500/1,950» → 1500/1950;
- an RU «;» CSV «1,125» beside «0,9» → 1.125;
- an evidence-less ambiguous kg column → null plus the note;
- «1.234,56» → 1234.56;
- «-50» → -50;
- «12,5» → 12.5.

5.10 **Carton counts are not pieces** (reader-5.10-jianshu; xlsxN-08 betterFix):
- **Collect** every QTY candidate that is neither per-package nor kg, m³ or karobka.
- **Rank** them:
  - (a) a total word, including a leading 总/總;
  - (b) a piece unit word;
  - (c) no package word;
  - (d) leftmost.
- **A passed-over candidate** that names a package in a LATIN or CYRILLIC word becomes `cartonCol` with the
  literal 'ctn'.
- **A lone candidate** becomes `cartonCol` only through a Latin or Cyrillic package word, never through 件数
  or 总件数.
- Every case asserts `quantity` AND `unit`.

As built (P-reader-B fix round): the four keys in the betterFix's order, with two additions recorded here.
- (a) and (b) are asked of a header that names no package only: a package header's total word or «шт» is
  its packages' («Кол-во | Кол-во мест, шт», «QTY (PCS) | TOTAL CTN QTY», «总件数 | 数量» → the pieces;
  review break-qty-rank). The package words for (c) add «karobka», «quti», «joy soni» and «упаков».
- A header naming money, a weight or a volume ranks below every count (c3102 «Price/pcs | Qty» → 300).
- (b) is a PIECE unit: «Кол-во, м2 | Кол-во, шт» → 300 шт (c3032 re-anchored), and the passed-over count in
  another unit is said on the line's note («Кол-во, м2»: 120), never lost.

5.11 **Шт** (reader-5.11-sht, the verifier's code). In the quantity loop a header is a candidate when either
holds:
- it matches QTY_KEYS;
- `unitOf(headerUnitWord(text)) === 'dona' && !MONEY_HEADER.test(text)`.

The PER_PACKAGE_COUNT skip stays after this test. Corpus cases, written BEFORE the change:
- «Цена, шт» before «Кол-во» → 300;
- «Вес 1 шт, кг» before «Вес нетто, кг» → 135;
- «Цена за шт, $ | Всего шт» → 300;
- «Итого, шт» → a count, not money;
- «Total pieces» → a count;
- «Штрих-код» → not a count.
- As built after the as-built review (B) (SHEETS-7): the candidate rule also excludes a UNIT column (UNIT_KEYS — «ед» reads as dona and broke
  «Кол-во | Ед.») and a weight or volume header without its unit word («Вес 1 шт»).

5.13 **Uzbek headers** (unmapped-uz-header-words, partial):
- `matchKey` folds [ʻ‘’`ʼ] to «'»;
- weight stems: «og'irl» / «ogirl»;
- count stems: «nechta», and «necha» not before so‘m/pul;
- «Umumiy og'irligi» is a WEIGHT, never money.

5.14 **A «Brutto» column alone gives the per-row weight** (xlsxN-12, nit), as «G.W.» and «毛重» do.

---

## §6 The questions sent to him (built as ⭐, his answer awaited)

1. **Fayldan tovar o‘qilmasa, yoki AI faylni oxirigacha o‘qib ulgurmasa.**
   - a) ⭐ «Tasdiqlash» chiqmaydi. O‘rniga «🔄 AI qayta o‘qisin» (yordam beradigan bo‘lsa), «➕ Yana ma’lumot»
     va «👤 VED hisoblasin» chiqadi. Oxirgisi tanlansa, so‘rov VED'ga tushadi va VED xodimi fayldan o‘zi
     hisoblaydi.
   - b) «Tasdiqlash» qoladi, AI faqat o‘qigan tovarlarini hisoblaydi (ogohlantirish bilan).
2. **Bitta Excelda bir nechta varaq.**
   - a) ⭐ Boshqa varaqdagi tovarlar BOSHQA ekani aniq ko‘rinsa, ular qo‘shiladi. Packing list varag‘i bo‘lsa,
     undan og‘irlik va kub olinadi. Aniqlab bo‘lmasa, hozirgidek qoladi va bot buni aytadi.
   - b) Hozirgidek: faqat eng katta varaq olinadi.
3. **Botga «🤖 AI rastamojka» ni bosishdan OLDIN yuborilgan fayllar.**
   - a) ⭐ Hozirgidek: tugmadan keyin qayta yuboriladi.
   - b) Bot «Oldin yuborilgan 2 ta faylni shu hisobga olaymi?» deb so‘raydi. (Not built: this is a new
     design.)

---

## §7 What production hit — owed to him as a request

These lines say which §0.3 route his file took:

```
docker compose logs app --since 48h | grep -E "calc intake"
```

How to read them:
- `failure: "timeout"` → §3.1 + §3.2 + §3.3.
- `stop: "max_tokens"` → §3.2 + §3.3.
- `failure: "nothing_to_read"` → §3.7.
- `failure: "rejected"` → §3.4.
- No line at all → the model was never called: §3.7 and §4.

After the deploy, the same line shows `thinking` and `ms`.

---

## §8 Stated, not built

- **Files sent before the door** (dialog-01). This is designed and pre-existing (IKKI-ESHIK §4.1); see §6 Q3.
- **The parked collection's old «Bo‘ldi»** (dialog-02). It is narrow, and a silent take would break 1.8 c. It
  is a later round, with dialog-02's betterFix, the guard in `handleCalcCallback`.
- **Pictures inside an Excel** are not read as images; words only (4.4).
- **A PDF of 10-20 MB** stays refused at arrival in words (pdfimg-6). **TIFF scans** stay refused
  (pdfimg-4).
- **The PL-first role swap of an invoice sheet in one workbook** (sheets-03 (2-4)). A one-line «AS PER
  PACKING LIST» invoice beside an unknown-header PL (xlsxN-05) is covered only as far as 5.2 maps the PL's
  header.
- **Two FILES, an EN CI + a ZH-only cartons-only PL** (R2) still doubles. That is the pre-existing cross-file
  rule, PF-ADV-5. The fix (sheets-05 (b): «cannot tell», named, not folded) reverses PF-ADV-5 for that shape,
  so it is his call.
- **`cartons × per-carton`** as a figure: GoodsRow carries no carton field (sheets-05 (c)).
- **The deal-card import** stays first-sheet-only (`workbookRows`, sheets-09).
- **A refused header on the deal-card import** (as-built review SHEETS-4, a nit, not built): «ITEM | MERCHANDISE
  | QTY» over numbered rows is refused by the serial guard (§5.3) and the headerless pass lands «ITEM» as a line
  with no figures. On the bot the sheet goes to the model as text; the deal card has no model reader. The draft
  is reviewed before anything is written; the narrow fix (start the headerless pass after a header-shaped
  serial refusal, a «sarlavha topilmadi» line on the import screen in four locales) is owed as its own round.
- **«🔄» after a clock cut** re-reads the WHOLE material, once. It does not continue from the last good read.
  As built after the as-built review (B): a re-read that reads LESS keeps the earlier reading (§1.2, CRITIC-1).
- **An HTML or XML table, or an .xlsb, sent under its own mime** stays refused at storage (as-built review
  REGRESSION-5): storing text/html would need the attachment-disposition fence re-checked first. It is now told
  in its own words with the cure («Excel’da .xlsx qilib saqlab yuboring»), §3.4. An HTML table saved as «.xls»
  arrives with Telegram's Excel mime and is stored and read as before. The .xlsm IS stored (OWNER-10).
- **Three FILES — CI A, CI B (folded as other goods), PL A — or CI A, PL A, CI B** (as-built review SHEETS-3):
  the cross-file packing rule is today's (PF-ADV-5's lineage) and PL A's Σ is still written as the shipment's.
  The workbook path is fixed (§4.2); widening it to files changes the plain door's cross-file reading and is
  his call.
- **The Σ of folded sheets' own totals** (as-built review OWNER-1's optional half): when every goods file states
  a gross column and a cube, their Σ could stand for the shipment's. Not written — §4.3 asks the brutto beside a
  fold, and a deterministic total over two factories' lists is a new rule, not a fix.
- **Deliberate decisions, unchanged:**
  - another factory's same-named product dropped as «Excel'dagi bilan bir xil» (known-4);
  - a second same-named added line (known-5);
  - the obedient model omitting a same-named product (known-6).
- **Nits:**
  - a blank-name model answer (zero-07);
  - a formula cell with no cached value (xlsxN-13);
  - a hidden goods sheet behind a cover sheet (unmapped-hidden-goods-sheet);
  - the burst ➕ naming an old request (dialog-06);
  - the plain door's zero-row ℹ️ wording (zero-04 betterFix 1; the plain door keeps its words beyond 2.2).
- **pdfimg-11** is refuted.

---

## §9 The objections of v1 and where each is answered

| Objection | Answered in |
|---|---|
| door-zero-pass | §1.3 c |
| door-ved-no-prep | §1.3 a (door 'plain', silent pass) |
| door-ved-then-add | §1.3 a |
| door-amend-scope | §1.0, §1.2 label, §1.6 |
| door-whole-inputs | §1.1, §10 |
| door-whole-input-cuts | §1.1 f, g |
| door-cut-retry | §1.2 🔄, §3.3 |
| door-nothing-ai | §2.1, §3.7 |
| door-burst-consent | §2.6 (§8) |
| door-restart-hold | §2.4 |
| door-aipass-home | §1.3 a (`landAs`) |
| door-closing-drawers | §1.2 (one function) |
| model-leash-unbounded | §3.2 |
| model-midstream-errors | §3.3 |
| model-cut-unbilled | §3.3 billing |
| model-thinking-null | §3.5 |
| model-reread-and-codes | §1.2 🔄, §3.3 codes |
| model-thread-door-cut | §3.6 |
| model-time-sum | §3.2 (150 s kept) |
| model-salvage-scanner | §3.3 scanner |
| model-tests-reanchor | §3.2 |
| model-encrypt-sniff | §3.4 |
| model-20mb-refusal | §3.4 |
| model-cuts-inventory | §3.8 |
| sheets-01 | §4.2 proven other |
| sheets-02 | §4.2 by shape |
| sheets-03 | §4.1, §4.2, §8 |
| sheets-04 | §4.2 (fence kept), §3.7 |
| sheets-05 | §4.2 R1 in one workbook, §8 R2 |
| sheets-06 | §4.1 loop in readIntakeFile |
| sheets-07 | §4.1 `text` = unmapped |
| sheets-08 | §4.6 |
| sheets-09 | §4.1, §8 |
| reader-5.4c-silent-arith | §5.4 c |
| reader-5.9-decimal-comma | §5.9 |
| reader-5.2-5.3-ladder | §5.2+5.3 |
| reader-5.10-jianshu | §5.10 |
| reader-5.11-sht | §5.11 |
| reader-5.8-colon | §5.8 |
| reader-5.4ab-vocab | §5.4 |
| reader-5.5-footer | §5.5 |
| reader-5.6-card | §5.6 |
| reader-5.7-onecell | §5.7 |
| reader-5.12-twoheader | §5.12 |
| reader-corpus-blind | §5 preamble |
| critic-refused-unread | §1.1 named tier, §3.4 `refusedFiles` |
| critic-split | §10 |
| critic-notice-kind | §2.3 |
| critic-pins | §1.2, §3.7, §4.2 |
| critic-tail-both | §2.2 |
| critic-said-twice | §1.2, §2.5 |
| critic-door-predicate | §1.0 |
| critic-paste-5.9 | §5.9 |
| critic-section8 | §3.4 (pdfimg-8, -12), §3.7 (xlsxN-14), §4.4, §8 |

---

## §10 Kernel K and the packages

**Kernel K** is written by the lead first, then committed. It is the base of every package.

New `IntakeState` fields, all optional in the type, defaulted in the initial state and in
`migrateIntakeState`. Each says its writer:
- `aiCut?: { goods: number; why: 'clock' | 'size' | 'dropped' } | null` — analyzeCollected, every reading;
- `aiCutRetried?: boolean` — set by the 🔄 press on a clock cut, cleared by new material; as built (B), set by
  the press of a re-read on a clock OR dropped cut, and read by `analyzeCollected` (a re-read that reads less
  keeps the earlier reading, CRITIC-1) and by the press (no second re-read, WORDS-8);
- `aiInputCut?: boolean` — analyzeCollected;
- `filesMissing?: number` — analyzeCollected;
- `unreadPdfs?: string[]` — analyzeCollected, from the outcome;
- `refusedFiles?: { name: string; why: string }[]` — every refusal site at arrival; as built (B), also the
  READING (the API-refused PDF it names, §1.1 d), and an accepted re-send of the same name removes its entries
  (MODEL-5);
- `restartAsked?: { messageId: number | null; at: number } | null` — the restart question;
- `landAs?: 'ai' | 'ved' | null` — c:save / c:to_ved.

Also in K:
- `pendingReply.notice?: 'read' | 'cut' | 'failed' | 'no_model' | 'arrived'`.
- `settleAnalysis` copies `aiCut`, `aiInputCut`, `filesMissing` and `unreadPdfs` from the reading. As built (B,
  MODEL-6 (10)): it also applies the reading's file moves (`readingFileMoves` — the refused PDF out of `pdfs`,
  into `refusedFiles`) as a diff against what the reading read, so a file that arrived meanwhile stays.
- `AiReadFailure` gains `'files_missing'`, with its `AI_READ_FAILURE` entry.
- `AiIntakeRead`'s ok member gains `cut?: { goods: number; why: 'clock' | 'size' | 'dropped' }`.
- `CALC_STEPS` gains `'to_ved'`, with its PRESS_REPEAT class (the same as `save`).
- `aiReadingWhole` (pure, `platform/telegram/reading-whole.ts`), with its unit test.

**Packages**: each is built in its own worktree from K's commit, reviewed by two lenses, fixed, and then
cherry-picked.

| Package | Owns |
|---|---|
| P-door | §1, §2 |
| P-model | §3 (with §3.7's prompt changes, analyzeCollected's field writes, from-thread.ts, the size and PDF refusals at the doors) |
| P-sheets | §4, and §3.8's goods-file.ts cuts |
| P-reader-A | §5.1, 5.2+5.3, 5.6, 5.7, 5.8, 5.12, and goods-import.ts:1201's cut |
| P-reader-B | §5.4, 5.5, 5.9, 5.10, 5.11, 5.13, 5.14, built on P-reader-A's commit |

**Merge order:** P-reader-A → P-reader-B → P-sheets → P-model → P-door.

Shared files are edited in disjoint functions:
- `calc-intake.ts`: P-model `analyzeCollected`; P-sheets `pickGoods` / `loneFileTotals`.
- `calc-files.ts`: P-model's pdf branch, `receivePdf`, `loadIntakeFiles` and `saveIntakeFile`; P-sheets'
  sheet branch and `receiveGoodsSheet`.
- `staff-handlers.ts`: P-model's file door (size); P-door's save, to_ved and restart.

**After the merge:** the whole suite in CI order on a fresh database, an as-built review of the merged tree,
and a fix pass.
