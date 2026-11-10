# Fayl o‘qish — the AI door reads every file before «Tasdiqlash», and a file's goods are not lost (2026-11-10)

His report of 2026-11-10, the day after «Ikki eshik» (ledger 142), verbatim:

> «nega ai rastamojkaga malumotlar bergandan kegin ham tovar nomi topilmadi deyabti. 1 dona fileda
> kop tovarlar bolishi mumkun yokida 1 dona tovar bolishi mumkun. va fillarni qabiul qil degandan
> keyin fillarni oldin korib chiqib togridan togri tasdiq deyabti?»

Two sentences, two defects:
- **«tovar nomi topilmadi»** is `NO_GOODS_CLOSING` («⚠️ Tovar nomi yozilmagan — …»). It is drawn
  only when a reading ends with ZERO goods rows (intake.ts `rows.length === 0`).
- **«fillarni qabul qil degandan keyin … to‘g‘ridan-to‘g‘ri tasdiq»**: after the prompt says
  «Qabul qilindi: 📎 N ta fayl», the table offers «✅ Tasdiqlash» although the AI never looked at the
  file, or read nothing out of it.

**The diagnosis** is workflow wf_edbf4e25-bff (68 agents, 2026-11-10). It drove the REAL grammy
handler chain through `bot-harness` with the real readers and a faked SDK, in eight scenarios:
- one good in one Excel (xlsx1);
- many goods in one Excel (xlsxN);
- sheets the column reader cannot map (unmapped);
- PDFs and photos (pdfimg);
- the Messages API request itself (apireq);
- the order of the dialog (dialog);
- the zero-goods table on both doors (zero);
- the «already taken» list (known).

The result is 73 findings. Every non-nit finding had an adversarial refuter: 30 were confirmed,
33 partial and 1 refuted. Each finding is one file in the session scratchpad (`goods/f/<id>.md`)
holding:
- the claim and its evidence;
- the reproduction test;
- the verdict;
- the verifier's measured **betterFix**, which is binding wherever this spec says «per betterFix».

What production hit is not proven: this container has no API key. His `[calc intake] model tokens`
and `calc intake AI failed` log lines will say which cause it was (§7). Every cause below is fixed
regardless.

Numbering: DECISIONS from **#1622** (main's AI sotuvchi took #1610-#1621). **No migration**: every
new field lives in the collection's jsonb state, and the ledger stays **143**.

---

## §0 The two sentences, cause by cause

0.1 **«Tasdiqlash» without a reading** (xlsxN-01 blocker confirmed, known-3, dialog-04, zero-01,
unmapped-excel-only-model-not-called).
- On the AI door, a lone Excel the reader maps, with no caption, never reaches the model.
- `analyzeIntake`'s guard (intake-ai.ts `if (!material && images.length === 0 && pdfs.length === 0 &&
  !hasSheets)`) never counts the numbered known list, and a one-sheet workbook leaves no sheet text.
- The customer's answer is `clientHintRaw`, not material. So the commonest order (door → section →
  GS777 → the file → «Bo‘ldi») gets `nothing_to_read`.
- The table then says «⚠️ AI ga o‘qish uchun matn, rasm yoki PDF yo‘q edi» right after the file was
  accepted, gives no codes and so asks no law unit, and closes «✅ Ma’lumot to‘liq — «✅ Tasdiqlash»
  ni bosing, AI hisoblaydi».

0.2 **Zero goods, and «Tasdiqlash» over them** (xlsx1-08, xlsxN-04, pdfimg-2, dialog-05, zero-02,
zero-03, zero-04, known-7; all confirmed). Every zero-goods AI table:
- blames the seller («Tovar nomi yozilmagan — tovarlarni «➕ Yana ma’lumot» bilan yuboring»), whatever
  happened to his file;
- prints «Faqat yozilganidan o‘qildi» when nothing was typed;
- invites the press («Bilmagan qatoringizni VED to‘ldiradi — «✅ Tasdiqlash» ni hozir ham
  bosishingiz mumkin») over rows that do not exist;
- after the press, promises «🤖 AI hisoblayapti», and the pass answers a bare «Rastamojka jami:
  hozircha hisoblab bo‘lmadi».

0.3 **Why a file gives zero goods.** Three routes:
- **The model's reading failed.** One call holds every PDF, photo and unmapped sheet; it is
  non-streaming, at default effort (`high`), with thinking inside `max_tokens` 16 000 and a 150 s
  leash. A long invoice ends `timeout` (most likely) or `truncated` with nothing kept (zero-06,
  pdfimg-10, apireq-5, xlsxN-03, xlsx1-01).
- **Only the model could read the sheet**, and the call failed:
  - a header below row 10 (xlsx1-02);
  - a name column headed «Product», «Commodity», «Номенклатура» or «货名» (xlsx1-03);
  - a good whose name holds «TOTAL», dropped as a total row (xlsx1-04).
- **The bot handed the model nothing:**
  - a storage miss became `nothing_to_read` with no retry (pdfimg-3);
  - a PDF over the cap (pdfimg-6);
  - a top-up where a packing-shaped first file is «noted» and withheld (known-2).

0.4 **A file's goods lost or corrupted without the word «topilmadi»** («1 dona fileda kop tovarlar …
yokida 1 dona tovar»):
- **lost:**
  - a workbook with different goods on different sheets keeps only the biggest sheet
    (xlsxN-02, known-1, unmapped-other-sheets);
  - a one-good label|value card lands its labels as goods (xlsx1-07, unmapped-vertical-card);
  - a product name containing a goods word is taken as the header (unmapped-product-name-as-header);
  - a letterhead «Company name: | …» becomes the header (unmapped-letterhead);
- **wrong:**
  - footer rows become goods and null the Σ (xlsx1-06);
  - an «Umumiy»/«Итог»/«Sum» total row becomes a second good (xlsx1-05);
  - an «ITEM» serial column becomes every name (xlsxN-06);
  - «1,500» typed as text reads 1.5 (xlsxN-07);
  - «CTN QTY» reads as pieces (xlsxN-08);
  - «Всего шт» is ignored (xlsxN-09);
  - a bilingual two-row header lands its second row as a good (xlsxN-10);
  - Uzbek «og‘irligi»/«Nechta» are missed (unmapped-uz-header-words);
  - an invoice + packing list in ONE workbook loses the packing sheet's netto and totals (xlsxN-11).

---

## §1 The rule this round adds

> **«✅ Tasdiqlash» on the AI door means «the AI has read everything you sent, and it will compute».**
> It is drawn only when that is true. Otherwise the table says, in words, what was not read and why,
> and offers what can fix it, plus a door to the VED that promises no AI figure.

1.1 **A reading is WHOLE** — one pure predicate, `aiReadingWhole(state, rows)`, asked by:
- the table's closing;
- its keyboard;
- the save branch;
- the landing's words.

It is true when ALL of these hold:
- (a) the table has ≥ 1 goods row;
- (b) the reading was not cut short (`state.aiCut` is false, §3.3);
- (c) every piece of material ONLY the model can read was read by an answering model:
  - photos;
  - PDFs;
  - unmapped sheet texts (`sheetTexts`);
  - the other sheets the reader could not judge (§4.1 «cannot tell»).

  If the call failed while such material was in the collection, the reading is not whole.
- (d) no stored file failed to load (`files.missing === 0`).

Typed text alone and mapped Excel rows alone never make a reading unwhole: both are read without the
model. A model failure on an Excel-only collection costs the codes, not the goods. The landing pass
codes the rows, as today.

1.2 **Not whole → no «✅ Tasdiqlash»** (his ⭐ answer to §6 Q1, built as ⭐). The AI keyboard
becomes:
- `[🔄 AI qayta o‘qisin]`, only when the failure is retryable (`AI_READ_FAILURE[f].retry`, or a cut,
  §3.3);
- `[📄 Sertifikat: …]` — the answer is kept; it goes on the request for the VED;
- `[➕ Yana ma’lumot]`;
- `[📨 VED ga yuborish]` (new step `to_ved`);
- `[✖️ Bekor qilish]`.

The closing, which replaces both `NO_GOODS_CLOSING` and `vedLine` on the AI door, has one first line
for each case:

- zero rows, a file sent, the model failed:
  «⚠️ Fayldan tovar o‘qilmadi — {AI_READ_FAILURE text}»
- zero rows, a file sent, the model answered with no goods:
  «⚠️ AI yuborilgan fayllardan tovar topa olmadi.»
  No 🔄: the same input gives the same answer.
- zero rows, no file:
  «⚠️ Tovar nomi yozilmagan.» (`NO_GOODS_CLOSING`'s words, for the case they are true of)
- rows > 0 and unread model-only material:
  «⚠️ {N} ta tovar Excel/yozilganidan olindi; {k ta PDF / k ta rasm / «X» varag‘i} o‘qilmadi — {failure text}»
- cut (§3.3):
  «⚠️ AI faylni oxirigacha o‘qib ulgurmadi — {N} ta tovar o‘qildi, qolgani o‘qilmadi.»

Then the remedy line, which names only the presses drawn:

> «{«🔄 AI qayta o‘qisin» ni bosing, yoki }faylni Excel qilib / tovarlarni yozib «➕ Yana ma’lumot» bilan yuboring.
> Yoki «📨 VED ga yuborish» — VED xodimi fayllarni o‘zi ko‘rib hisoblaydi (AI hisoblamaydi).»

1.3 **«📨 VED ga yuborish»** lands the collection exactly as «✅ Tasdiqlash» does: the same card, note,
files, certificate and door `'ai'`. It differs in three ways:
- **(a) No AI pass is queued** (`landIntake` takes a REQUIRED `aiPass: boolean`).
  - The seller is told «🧮 VED navbatiga tushdi — AI hisoblamadi: {sabab}. VED xodimi fayllarni ko‘rib,
    javobni shu yerga yuboradi.»
  - The card's lenta note says the same for the VED: why the AI did not compute, and what WAS read.
- **(b)** A landed request with ZERO items never queues a pass, on either door: the pass has nothing
  to price. The note says «so‘rovda tovar yo‘q». This closes zero-03 and zero-08.
- **(c)** An old «✅ Tasdiqlash» pressed on a not-whole collection (a table drawn before the deploy,
  or a redelivered press) lands as «📨 VED ga yuborish». It says so, and never promises an AI figure.
  `queuedLine`/`landedWordsOf` read the landed item count and the pass decision. They never read the
  door alone.

1.4 **The plain door is untouched** (his 2a: the job lands as it is and the VED asks). Two of its words
are fixed:
- an Excel-only collection prints no `nothing_to_read` failure line;
- «Faqat yozilganidan o‘qildi» is printed only when something WAS typed (§2.3).

1.5 **Pinned** by:
- a unit test over `intakeTableText` + `tableWords` at zero rows, at a cut and at a failure with a
  PDF: no ✅, no vedLine, the right first line, the right buttons;
- a derived fence: every `callback_data` drawn parses (`to_ved` in `CALC_STEPS` and `PRESS_REPEAT`);
- integration tests through `bot-harness`: a zero-goods AI collection → `📨` → landed, no pass row,
  no AI_QUEUED words.

---

## §2 Package P-door — the AI door reads, and says what it read

2.1 **The model codes a lone Excel** (0.1). On the AI door, `analyzeIntake`'s guard counts a non-empty
numbered list (`codeKnown && known.length > 0`) as something to read. The model is then shown:
- the numbered rows;
- the workbook's own goods-sheet text for a packing-shaped sheet (as `ownText` already is for
  packing). An invoice-shaped sheet's own text is NOT added (the «do not repeat» fence, #1458).

It answers codes and totals. The plain door keeps no call for an Excel-only collection.

2.2 **The «already taken» heading is true** (known-2):
- In a top-up, a packing-shaped file is a NOTED file only while there are kept or held rows for it
  to be the totals of.
- With zero kept rows and zero held rows (a returned request with no rows, a ➕ on an empty
  request), it is the goods list, as on a fresh collection.
- `invoiceTexts` is never printed under «товары … уже взяты» unless rows were taken from it.

2.3 **The tail's words** (zero-04, xlsx1-09, apireq-4, pdfimg-1):
- «Faqat yozilganidan o‘qildi» only when `state.material` is non-empty;
- «Faqat Excel'dan o‘qildi» when only Excel rows were read;
- «Hech narsa o‘qilmadi» when neither.

2.4 **The reading notice** (xlsx1-10, zero-05, apireq-3, pdfimg-7). `deliver()` edits «⏳ AI
o‘qiyapti…» to:
- «✅ O‘qildi — natija pastda ⬇️» when the model answered;
- «⚠️ AI o‘qiy olmadi — sababi pastda ⬇️» when it failed;
- «📊 Fayl o‘qildi — natija pastda ⬇️» when no model call was needed.

On «Bo‘ldi» with only refused files, the reading is not started: «Yuborilgan fayllarning birortasi
ham o‘qiladigan emas — {sabablar}.»

2.5 **A storage miss is retryable** (pdfimg-3). `loadIntakeFiles`' `missing > 0` with nothing else
read is the new failure **`files_missing`** (retry: true):
> «⚠️ {N} ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.»

It is never `nothing_to_read`. With other material read, the reading is not whole (1.1 d) and 🔄 is
drawn.

2.6 **The restart question carries the files** (dialog-03, confirmed). While «Sizda tugallanmagan
yig‘ish bor…» stands:
- any material that arrives is HELD, not filed into the old collection;
- «🔄 Ha, boshqatdan» opens the new collection WITH the held material, through the same `takeParts`
  fence as the burst;
- «▶️ Yo‘q, davom etaman» files the held material into the old collection.

The question's text says: «Hozir yuborgan fayllaringiz qaysi biriga qo‘shilishini shu savol hal
qiladi.»

2.7 **A parked collection's old «Bo‘ldi»** (dialog-02). `pressAnalyse` asks whether an untaken burst
is drawn beside THIS collection (`parkedNote === state.noteId`). If one is, the burst is taken first
(the `pressResumeTake` path), then the reading runs. The same guard applies to `save` and `to_ved`.

2.8 **The model's lines are never dropped in silence** (xlsxN-02 betterFix 4). In `pickGoods`, with
`aiGoods === null` and an invoice held, a model line that matches no invoice row is NAMED, as the
photo branch already does («AI fayldan yana «X» ni topdi — ro‘yxatga qo‘shilmadi, VED ko‘radi»).
It is not added: the multi-sheet rule (§4.1) decides what is added.

---

## §3 Package P-model — the reading finishes, or keeps what it read

3.1 **Effort `medium`** for the intake reading (`output_config.effort`; the SDK 0.114 types carry it).
- claude-opus-5 thinks by default at effort `high`, and its thinking counts inside `max_tokens` and
  against the clock.
- The reading is transcription plus a code PROPOSAL. A person confirms the proposal, and the landing
  pass codes the rows again.
- The model guide calls `low`/`medium` «unusually effective» and the primary latency lever.

This was measured nowhere here (no key). It is stated to him, and the log line (3.5) shows the
effect.

3.2 **Streaming** (`client.messages.stream(…)`, `finalMessage()`), with:
- `max_tokens` 32 000 (INTAKE_MAX_TOKENS);
- the leash at 170 s (INTAKE_TIMEOUT_MS), still inside his «3 daqiqagacha» (3.4 b) and the job's
  300 s expiry.

The text deltas are accumulated as they arrive, so an abort or a cap has the partial answer in hand.

3.3 **A cut keeps what it read.** On `timeout` (abort) or `max_tokens`:
- the partial JSON text is scanned for COMPLETE `goods[]` objects, in order;
- the totals before them (the schema's property order puts `from_city … volume_m3` first) are kept
  only when their values completed.

If ≥ 1 good completed, the reading is `{ ok: true, cut: true }` with those goods. `state.aiCut = true`
and `aiCutGoods = N`, and the table says so (1.2). 🔄 re-reads the whole material. A cut with no
complete good stays the failure it is today. A cut never becomes «whole», so it never offers
✅ Tasdiqlash.

3.4 **Two requests the API refuses are named at arrival**, not discovered at «Bo‘ldi»:
- **A PDF with `/Encrypt`** (apireq-2, pdfimg-9) is refused in `receivePdf`:
  «PDF parol bilan himoyalangan — AI o‘qiy olmaydi. Kartada saqlandi.»
- **A file over Telegram's 20 MB bot limit** (pdfimg-5) is answered «Fayl 20 MB dan katta — Telegram
  uni botga bermaydi. Kichikroq qilib (yoki Excel) yuboring.» It does not get «Faylni saqlab
  bo‘lmadi».

3.5 **The log line says enough to diagnose the next report.** `[calc intake] model tokens` carries:
- `in`, `out` and `thinking` (`usage.output_tokens_details.thinking_tokens`);
- `stop`;
- `ms` (the elapsed time);
- `cut`;
- the material counts (images, pdfs, sheets, known).

`calc intake AI failed` carries `ms` and the same counts.

3.6 **Code-point-safe cuts** (apireq-1). Every cut that can reach the model or the state is
code-point safe (`clipText` / `Array.from`):
- goods-file.ts `sheetsAsText` (the 300 cell cut and the raw ×4 cut);
- intake-ai.ts the 120 name cut and the 20 000 material cut.

`intakeContent` runs `.toWellFormed()` over every text block as a fence. A unit test puts an emoji at
each boundary and asserts that `JSON.stringify(params)` has no lone `\ud8xx` escape.

---

## §4 Package P-sheets — every sheet of a workbook is judged (readGoodsFile + the collector)

4.1 **Several mapped sheets** (xlsxN-02, known-1, unmapped-other-sheets, xlsxN-11), per xlsxN-02
betterFix:
- `readGoodsFile` also returns every OTHER visible sheet whose header it maps, with its own parse
  (`moreSheets`). The field is additive: the deal card's import and `send-rows` keep reading `goods`.
- The collector judges each further sheet against the goods sheet, in order, and SAYS every decision
  on receipt:
  - **The same goods:** packingOfHeld, or a majority of sameLine matches. The sheet gives totals and
    netto fills, exactly as a second FILE does (packingFills, fileTotals). This is the CI + PL
    workbook (xlsxN-11).
  - **Other goods, proven:** the names are comparable (one script, so a meeting is possible) AND no
    row meets any held row by name, by sameFigures or by an equal count. The sheet is folded as new
    goods with foldInvoice and named: ««Zavod B» varag‘idan 4 ta yangi tovar qo‘shildi».
  - **Cannot tell** (different scripts, no counts — R1's CI + Chinese-only PL): the sheet stays model
    text. The model is told «list them only if they are NOT the numbered goods»; the «НЕ перечисляй»
    wording is replaced. The seller is told ««X» varag‘idagi qatorlar shu tovarlarmi — aniqlab
    bo‘lmadi, AI/VED ko‘radi».
- `loneFileTotals`, and wherever fileTotals is built from one goods sheet, refuses the ✅ total
  while the workbook had a mapped sheet not judged «the same goods».
- The arrival line never claims «boshqa varaqlarni AI o‘qiydi» about a sheet the model is not asked
  to read as goods.

4.2 **The two-file CI + Chinese-only PL doubling** (R2 in xlsxN-02's verdict, a precondition of 4.1).
`packingOfHeld` also accepts a packing list:
- whose row count equals the held list's; AND
- whose rows line up one to one by position on their figures (count, or cartons × per-carton count);
- when the names cannot meet (a different script).

Pinned both as two files and as two sheets.

4.3 **A workbook whose goods are a picture** (unmapped-embedded-picture-dropped). A workbook that
yields no goods and carries embedded images says: «Excel ichidagi rasm o‘qilmaydi — rasmni alohida
(rasm yoki PDF qilib) yuboring.» It does not say «jadval bo‘sh» or «AI o‘qiydi». Reading the pictures
is stated, not built (§8).

4.4 **The receipt line for a sheet whose header WAS found but which landed 0 rows** (xlsx1-04
betterFix) does not say «sarlavhasini topa olmadim».

---

## §5 Package P-reader — the column reader (goods-import.ts)

Every item here changes `parseGoods`/`findHeader`, so each one follows CLAUDE.md's corpus rule:
- the WHOLE intake corpus (`tests/unit/intake-corpus.test.ts`) runs before and after;
- the ratchet (`intake-corpus-known.ts`) may only shrink;
- every new shape becomes a corpus case, pinned with the answer the verifier measured.

The verifiers proved most of the claims' own fixes WRONG. Their betterFix is the spec:

5.1 **Header below row 10** (xlsx1-02): per betterFix.
- Rows 10-49 are searched with two guards that apply there only: a row carrying a figure is data,
  and a header that deep must name a figure column.
- c0215 is re-anchored to `goods`/130 rows.
- New corpus cases: long header-less lists with a name-key word in a data row, and a party row
  inside a long title block.

5.2 **«Product», «Commodity», «Номенклатура», «Наим.», «货名», «Yuk turi»** (xlsx1-03): per betterFix.
- One LAST rung, `LAST_NAME_KEYS`, reached only when no NAME_KEYS column exists. It never takes a
  NAME_PARTY or NAME_ATTRIBUTE head, and it requires `wordy`.
- NAME_KEYS is NOT widened (c1936 and six neighbours flip).

5.3 **The «ITEM» serial column as every name** (xlsxN-06). On the rung that takes it (line ≈779,
per the verdict, not the last rung), a column whose sampled cells are all integers or article
numbers is refused while a LAST_NAME_KEYS or wordier column exists.

5.4 **Total rows** (xlsx1-04, xlsx1-05): per xlsx1-04 betterFix. One row-level predicate replaces
`isTotalRow(description)` in `push()` and at `stoppedShort`. A row is not a good when:
- (a) it is a label-only total, after stripping the total word and the closed qualifier
  vocabulary. The total words are TOTAL, Итого/Итог/Всего, Jami, Umumiy, Жами/Умумий, Общий итог,
  合计/总计, «Sum» as a whole word, and «X Итог» (an Excel subtotal);
- (b) it is a figure-less footer with a total word;
- (c) it is a total by arithmetic: the figures equal the Σ since the sheet start or the last total,
  within `contradicts`' tolerance.

«TOTAL cordless drill», «TOTAL QUARTZ», «Umumiy maqsadli lak» and «Итоговая папка» stay goods. A
two-row twin («black/red jacket, both 300/150/1.2») stays two goods: (c) needs ≥ 2 rows above. A
dropped total-worded row whose figures are NOT the Σ is NAMED in the file's note.

5.5 **Trailing footer rows** (xlsx1-06): per verdict. After the LAST figure-bearing row, figure-less
rows are not goods and do not null the Σ: «Made in China», «Shipping mark», bank, signature,
«Продавец». They are counted in the note. A figure-less row BETWEEN figure rows (a section heading
such as «WOMEN» / «MEN») is untouched.

5.6 **A label|value card** (xlsx1-07, unmapped-vertical-card-one-good). A sheet with ≤ 3 filled
columns whose column A is mostly field labels, judged by an EXACT label vocabulary (not `matchKey`'s
substring: «Весы напольные» must stay a good), and whose column B holds the values, is ONE good:
- its name comes from the name label's value;
- its qty, weight, volume and TNVED come from their labels.

Anything card-like that is not clearly that goes to the model as text (`kind: 'text'`), never as
label-goods.

5.7 **A data row taken as the header** (unmapped-product-name-as-header). A header candidate any of
whose NON-name cells reads as a figure is a data row (`continue`). c1790/c1791 (a numbered title
above the header) stay green.

5.8 **A letterhead label taken as the header** (unmapped-letterhead-false-header), per its verdict.
The gate is the LAST rung: it must not take a NAME_PARTY header («Customer name:», «Consignee
name:», «Company name:», «公司名称»). A name cell ending in «:»/«：» is a label, not a column
heading. The verdict's own warning stands: this must not break another `parseGoods` caller (the deal
card import), so that caller's tests run too.

5.9 **Figures as text** (xlsxN-07). A STRING cell goes through `readNumberCell` in `parseMeasure`
and in the amount path, as the glued branch already does:
- «1,500» is ambiguous, so it becomes null plus «soni «1,500» — aniq emas»;
- a numeric cell keeps `parseNumber`;
- resolving by the column is allowed only when EVERY other cell of the column has a 3-digit group
  after the comma.

5.10 **Carton counts are not pieces** (xlsxN-08), per verdict:
- a qty header carrying PACKAGE_COUNT (ctn/carton/箱/件数/мест/короб/pkg/package) is `cartonCol`;
- among several piece-count candidates, the one carrying total/ttl/всего/总/合计 wins;
- every shape in the verdict's two lists is a corpus case.

5.11 **«Шт» / «Всего шт» / «Pieces» / «Jami, ta» are a piece count** (xlsxN-09), per its verdict's
betterFix:
- as a whole word, never a substring;
- the per-package filter keeps «Кол-во в коробке» and «шт/кор» out;
- «Итого шт» / «Total pieces» are a COUNT, never the line's money.

5.12 **A bilingual header on two unmerged rows** (xlsxN-10). A row directly under the header whose
mapped cells all read as header words, with no figure, is a second header row: it is skipped.

5.13 **Uzbek headers** (unmapped-uz-header-words):
- `matchKey` folds [ʻ‘’`ʼ] to «'»;
- the weight stems are «og'irl»/«ogirl»; the count stems are «nechta»/«necha» (not before
  so‘m/pul);
- «Umumiy og'irligi» is a WEIGHT, never money.

5.14 **A «Brutto» column alone gives the per-row weight** (xlsxN-12, nit), as «G.W.»/«毛重» do.

---

## §6 The questions sent to him (built as ⭐, his answer awaited)

1. **Fayldan tovar o‘qilmasa, yoki AI faylni oxirigacha o‘qib ulgurmasa.**
   - a) ⭐ «Tasdiqlash» chiqmaydi. O‘rniga quyidagilar chiqadi: «🔄 AI qayta o‘qisin»,
     «➕ Yana ma’lumot» va «📨 VED ga yuborish». Oxirgisini bossangiz, VED xodimi faylni o‘zi
     ko‘rib hisoblaydi.
   - b) «Tasdiqlash» qoladi va AI faqat o‘qigan tovarlarini hisoblaydi (ogohlantirish bilan).
2. **Bitta Excelda bir nechta varaq.**
   - a) ⭐ Boshqa varaqdagi BOSHQA tovarlar qo‘shiladi. Bir xil tovar bo‘lsa (invoys + packing),
     varaqdan faqat og‘irlik va kub olinadi. Aniqlab bo‘lmasa, bot buni aytadi.
   - b) Hozirgidek, faqat eng katta varaq olinadi.
3. **Botga «🤖 AI rastamojka» ni bosishdan OLDIN yuborilgan fayllar.**
   - a) ⭐ Hozirgidek: tugmadan keyin qayta yuboriladi.
   - b) Bot «Oldin yuborilgan 2 ta faylni shu hisobga olaymi?» deb so‘raydi.

   Not built: b is a new design.

---

## §7 What production hit — owed to him as a request

These lines from the server tell which §0.3 route his file took:

```
docker compose logs app --since 48h | grep -E "calc intake"
```

How to read them:
- `failure: "timeout"` → §3.1 and §3.2 are the fix.
- `stop: "max_tokens"` → §3.2 and §3.3.
- `failure: "nothing_to_read"` → §2.1.
- No line at all → the model was never called: §2.1 and §4.

The file itself, or a screenshot of the bot's messages, settles it.

---

## §8 Stated, not built

- **Files sent before the door** (dialog-01): designed and pre-existing (IKKI-ESHIK §4.1); §6 Q3.
- **Pictures inside an Excel** are not read as images: words only (4.3).
- **A PDF of 10-20 MB** is still refused at arrival, in words (pdfimg-6).
- **TIFF scans** (pdfimg-4) stay refused.
- **Deliberate decisions, unchanged:**
  - another factory's same-named product dropped as «Excel'dagi bilan bir xil» (known-4);
  - a second same-named added line (known-5);
  - the obedient model omitting a same-named product of another factory (known-6).
- **A model answer with a blank name** (zero-07): model-dependent and unlikely.
- **A formula cell with no cached value** (xlsxN-13), and **a hidden goods sheet behind a cover
  sheet** (unmapped-hidden-goods-sheet): nits.
- **«🔄» after a cut re-reads the WHOLE material.** It does not continue from the last good read.
- **The «AS PER PACKING LIST» one-line invoice beside an unknown-header packing list** (xlsxN-05):
  covered only as far as 5.2 maps the packing list's header and 4.1 judges it. A one-line summary
  invoice beside a mapped list is still the goods sheet when it out-counts it, which it never does.
