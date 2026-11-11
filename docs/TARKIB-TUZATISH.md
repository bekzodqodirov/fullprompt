# Tarkib tuzatishlari — six fixes to the lot composition (2026-11-10)

Status: **v3 — eight readers' maps and the papers judge absorbed (§9, BINDING where it and
§1-§8 disagree).** WRITTEN on the branch and red-proven: the kernel (§1, §3.2, §9.1), package 1
(§2, §3.5, the receipt card) and package 3 (§4, the agent Excel). The other four judge lenses
never ran (the usage limit); the merged tree is reviewed as built instead.

## 0. His words and the reading

His message of 2026-11-10, verbatim:

> togirlash kerak bolgan ishlar bor ular:
> 1 tarkib qoshganda tasdiq sorash rasim file.
> 2 va tovar nomini tarkibga yozganda yuklamada har bir tarkib aloxida qatorlarga bolinib chiqsin hozirda prixod 1 qator bolib tarkibi nomlarni ichida turibti
> 3 tarkibni yozib bolgandan keyin agar tarkibda 1 tovar bolsa uni nomi yozilgan bolsa usha nom prixodni rus tili yozilgan joyni orniga tushsin
> 4 agar kop tarkib bolsa rus tili yozilgan joyda 1 chida turgan tovar nomi yozilsin yonida + nechta tarkibligi yozilsin
> 5 bojxona  bolimida tenved kodlarni AI dan soraganda tarkibga bolingan bolsa tenved qoya olmayabti.
> 6 partiyadan invoice qoralama olganda har bir tarkib alooxida bolib turibti shuni agar tenved kod 1 xil bolsa nomi xam 1 xil bolsa qoshib yuborsin va 1 positsiya qilish kerak agarda tnved kod bir xil bolib nomi farq qilsa(shunday hollarda aloxida oyna ochisin va shunday xolatlar bor bolsa shularni korsatib qoshaymi yoqmi deb sorasin) va invoice bersin. invoice da A columdan keyin nomi turibti shu A dan keyin shunday narsa qoshkin ki yani shu tnved kod qaysi karobkalar yani qaysi klientni qaysi prixodiligini yozib ket. agarda 1 prixodda 2 3 4 ta tarkib bolsa va ular invoiceda aloxida qatorda turgan bolsa har birga prixodda klient kodini  va berilgan kod (AA,AB,AC) shuni yozginda qizilda belgilab qoy shu orqali men bilaman shu karobkani ochganimda 3  4 tenved koddagi tovardan biirini ochishim mumkun
> savollarin takliflarin bolsa ber.

| # | Reading | Confidence |
|---|---|---|
| 1 | Saving a tarkib DEMANDS a proof file («Mijozning hujjatini biriktiring», a carton photo is refused). He wants that demand gone. Built: the document is OPTIONAL. | high — the only thing a person meets on «Tarkib qo'shish» that asks for a picture or a file |
| 2 | «yuklama» is his word, in no UI string. The only place a composed lot is ONE row with its tarkib inside the name cell is the AGENT EXCEL of a plan («Agent uchun Excel»: «键盘 (клавиатура)\nСостав лота (весь план): …»). Built: one row per tarkib line there. | medium-high — asked back |
| 3 | Wherever the lot's Russian name is SHOWN, a ONE-line tarkib's name is shown instead. The stored name (the warehouse's own word) does not move — §3 says why. | high |
| 4 | With several lines the shown name is «FIRST +N», N = the lines beyond the first («Клавиатура +2» for three) — the house convention already (`deals/cargo-label.ts`, the uncollected list). | high on the shape, the meaning of N asked back |
| 5 | The Bojxona tab's 🤖 skips composition LINE rows (the earlier design), so on a truck of composed lots «AI taklif» fills nothing. Built: 🤖 for lines. | high |
| 6 | The invoice draft: (a) same TNVED code + same name → one position; (b) same code, different names → a dialog lists them and asks, then the file; (c) a new column after «№» naming the lots behind each row (client code + lot letter); (d) a lot spread over several rows is written RED on each. | high |

Earlier decisions this round REVERSES (each recorded in DECISIONS):

- LOT-TARKIBI rule 3 / his answer 6 of 2026-10-01 («ved va logist hujjat biriktrb yozadi») — the document is no longer mandatory.
- LOT-TARKIBI rule 1 («the lot keeps its body … everything else goes on saying «klaviatura»», his own 2026-10-01 «lot o'zgarmaydi») — the Russian name every SCREEN and list shows now follows the tarkib; the cartons, letter, stickers, the Chinese name, the stored Russian name, counts and money still do not.
- UCH-BAND 8.6 («a one-line tarkib vouches ✅ only when its name is the lot's») — any standing tarkib vouches, because the screens now print the tarkib's name.
- LOT-TARKIBI §5 («a line row has no 🤖») and UCH-BAND 7b's «the agent file stays one row per plan line».

## 1. Data — migration `0143_tarkib_document_optional` (`when` 1785190000122, ledger 144)

Minted as 0142 / `when` …121; main's «✅ Yuborish chiqmadi» round (PR #140) merged first with
the same number AND the same `when`, so this one moved on the merge — the thirty-first collision.

```sql
-- Lot tarkibi: the client's document is optional (the owner, 2026-11-10 —
-- «tarkib qo'shganda tasdiq so'rash rasm file»). 0122 demanded one; the VED
-- often has only the client's words. The FK stays NO ACTION: a file a
-- composition cites is still `in_use`.
ALTER TABLE "lot_compositions" ALTER COLUMN "attachment_id" DROP NOT NULL;
```

- Catalog-only, additive, no backfill (every existing row has a document).
- Items 3-4 store NOTHING (§3): the shown name is derived from the lines that already exist,
  so no column, no restore protocol, no backfill script — and every tarkib written before
  this deploy shows its name the minute the code runs.
- Item 6's merge answers travel with the download (§6.4): no table.
- Not granted to `gsr_ai_reader` (0080's allowlist; unchanged).

## 2. Item 1 — the document is optional

What he meets today: the editor's FIRST block is «Mijozning hujjati», and after typing every
line and balancing kg/m³ the save answers «Mijozning hujjatini biriktiring (packing list /
invoys)» (`document_required`, checked LAST). There is no other prompt on that path
(`window.confirm` is only on the clear). A photo taken later already counts; only the
warehouse's receive-time carton photos do not, and they are never offered.

Built (the map's option A + L1):

- **Service** (`lot-composition.ts`): `attachmentId` may be null → the document step (the
  KEY SHARE lock and its two checks) runs only for a posted id; `document_required` leaves the
  union, the throw, the panel and the four bundles. A document that IS posted is checked
  exactly as today (`document_not_on_receipt`, `document_is_photo`; `isPaperDocument` and the
  FK's NO ACTION → `in_use` are untouched). Un-choosing the chip and saving detaches the file,
  which then becomes deletable.
- **Reader**: `compositionsFor`'s `JOIN attachments` becomes a `LEFT JOIN` inside the same ONE
  statement — #600's rule: with the inner join left behind, a document-less tarkib vanishes
  from the receipt card (and can then be neither edited nor cleared: `seenRev 0` against an
  existing header is `composition_changed`) and from the plan-stage agent file, while the
  invoice (`paperCompositionsFor`, no join) keeps printing its lines.
  `CompositionView.attachment` is `{ id, fileName } | null`; `compositionSummary` writes
  `document: null, attachmentId: null`.
- **One migration behind**: the INSERT with a NULL document against the old NOT NULL is a
  23502. New `violatedNotNull(err)` in `platform/db/errors.ts` (`violatedCheck`'s twin:
  `{ table, column } | null`, `cause` asked too); the action answers `server_behind` only for
  `lot_compositions.attachment_id` — by name, never a blanket 23502.
- **Editor** (`composition-panel.tsx`): the document block moves BELOW the lines and above the
  sticky bar, titled «Mijozning hujjati (ixtiyoriy)»; a chosen chip can be un-chosen; the save
  posts `attachmentId` only when that id is among the DRAWN chips (a draft restored from
  `localStorage` may name a file since deleted — it answered `document_not_on_receipt`, the
  wrong sentence, and with nothing required there may be no chip to un-tick). The face prints
  the 📎 link only when a file is cited. Found by the map, fixed here: `addDocument` is
  try/finally with NO catch and is called `void addDocument(…)`, so an undecodable photo
  (HEIC) or an offline upload said nothing — it now says `upload_failed`, and `too_large` /
  `unsupported_type` say the attachments panel's own words.
- **Lot check** (L1, no SQL change — the sentence never read the file): a standing tarkib
  still makes the lot ✅. The six sentences that claim a paper are reworded in the four
  bundles: `lotCheck.byDocument` «Tarkib bo'yicha tekshirilgan», `staleDocument`,
  `documentOld`, `documentOtherName`, `otherAnswers`, `otherAnswersAskLogist` (🧩 and the
  logist word stay — the fence pins them) and `receipts.attachInUse`.
- **Rollback** (docs/UPDATE.md, «0143 dan PASTGA»): code below this release inner-joins, so
  `SELECT count(*) FROM lot_compositions WHERE attachment_id IS NULL` must be 0 first.

## 3. Items 3-4 — the Russian name every screen shows follows the tarkib

### 3.1 DERIVED, not written — and why

The lead's first design wrote the label into `receipt_lots.product_name_ru` at the save. The
map of that column killed it:

- 72 files read it, and a dozen read it as IDENTITY, not display: the customs papers of a
  truck whose frozen copy says «no composition at the tick» (they print the lot's own name —
  a label written later would put «Клавиатура +2» on an invoice customs already holds, and
  integration tests 12 / 12e pin exactly that); `packingProductCell` and
  `refuseVanishingCode` (they compare a line with the lot's OWN name); the TNVED memory's
  `product_name_ru`, which `tnvedHintsFor` matches future line names against; two model
  prompts; the price-history needle; the sticker; the person's ✅ snapshot.
- `editLot` re-posts the name from an uncontrolled form with no compare-and-set on names: a
  form opened before a tarkib save and submitted after it would silently write the old name back.
- Two screens already append their own «+N» to the first name (deal pickers, the uncollected
  list): fed a stored label they print «Клавиатура +2 +1».
- Every failure above is silent, and a future reader that wants the lot's identity would get
  a label for ever.

Derived, the label exists exactly while the lines do (a clear, a torn header, a fixture's raw
write all read right by themselves — the lot check's «no writer clears anything»), every
identity reader stays correct by construction, a missed reader fails visibly and harmlessly
(it shows today's name), and every tarkib written before the deploy shows its name at once.
Measured on gsr_ci: the label as a scalar subquery costs 2.3 µs per lot row and is legal in a
grouped select and inside `string_agg`.

### 3.2 One home — `src/modules/wms/receipts/lot-name.ts`

- `tarkibLabel(lines)` (pure, `composition-math.ts`): one line → its name; n ≥ 2 → the name
  of the LOWEST `seq` + `' +' + (n − 1)` with ONE plain space (the PDF font has no NBSP);
  `null` below `MIN_STORED_LINES`. Applies while the lines exist, stale or not, and reads the
  LIVE composition (screens are live; only papers are frozen).
- `lotRuShownSql(lot)`: `coalesce((SELECT CASE WHEN count(*) = 1 THEN min(name) ELSE
  (array_agg(name ORDER BY seq))[1] || ' +' || (count(*) - 1) END FROM lot_composition_lines
  WHERE lot_id = <lot>.id HAVING count(*) >= 1), <lot>.product_name_ru)` — `lot` is a TABLE
  reference, never a column (#128); the lines' alias is `tarkib_line`.
- `lotGoodsShownSql(lot)` for the `ru || zh` readers; `tarkibLineMatchSql(lot, like)` — the
  extra arm a search predicate ORs into its own zh/ru arms, so «мышь» finds a lot whose
  second line is mice (an uncorrelated `ARRAY(SELECT lot_id …)`, so the trigram indexes of
  the name arms stay usable); `lotRuShownFor(lotIds, exec = db)` for whole-row readers.
- The pure twin and the SQL are pinned against each other
  (`tests/integration/lot-name.integration.test.ts`: 0 / 1 / 3 / 20 lines, a header with no
  lines, lines that do not start at 1, a cleared tarkib, a grouped select — and the stored
  `product_name_ru` never moves). Four red proofs run.

### 3.3 Who shows the label, who keeps the own name

**Shows the label** (swap the SELECT expression, keep the field name):

- Warehouse: /stock (table, lot page, crate fold) + the Ostatka XLSX, the plan editor and
  plan view, the batch card / cost grid / Narx tab (`batches/lots.ts`), the receipt card's
  lot header, box and crate pages, the issue screen, the QR-siz list, the count panels and
  their texts, the unload's missing-lot lines, the staff bot, the client card's «Yuklar»,
  ⌘K's labels.
- Office: deal pickers and cargo labels, the client lenta, costing/freight labels, the
  reports (landed cost, aging, client history) and their XLSX, unpriced / compensation lists,
  double-received, the map's place cargo, the annul registry, the uncollected list, the
  manifest, the re-emitted «prixod confirmed» payload.
- Customer (asked; ⭐ yes): the Mini App's cargo and history, the map, the arrival / summary
  pushes, the «berildi» payload, the handover act.
- Search: /stock's box, ⌘K, the count door's search, the broadcast's goods filter →
  `lotNameMatchSql`.
- Aggregators that already print «first +N» (deal cargo, the uncollected list) count goods
  KINDS over the line names, so they keep ONE number.

**Keeps the lot's own name** (untouched, and counted on the fence's allowlist): the stored
column and its one writer `editLot` / the ✏️ form (which gains one line under the Russian
input while a tarkib stands: «Ekranlarda tarkib nomi chiqadi: …»), the lot-check snapshot,
every customs paper (lines when composed, the own name otherwise — a sent truck's papers do
not move), the Bojxona product rows and both model prompts, the price history, the sticker,
`refuseVanishingCode`, `oneGoodPrefillFor`.

**Never reached in either design** (stated to him): the loading, unload and stock-take scan
screens print the CHINESE name only.

### 3.4 The fence — `tests/unit/lot-name-fence.test.ts`

Derived, comments stripped: every `receiptLots.productNameRu` / lot `product_name_ru` in
`src/` is in `lot-name.ts` or on a COUNTED own-name allowlist, and no other file builds a
` +N` onto a lot name. `lot-composition-fence.test.ts` gains `lot-name.ts` in MUST and
ALLOWED; readers import only that module (its name is not one of the fence's tokens), and the
DENY list is re-stated as «may not name the tables» — the recorded reversal of rule 1, not a
loosened list.

### 3.5 The lot check (as built)

Any STANDING tarkib makes the lot ✅ — `tarkibVouchesSql`, `one_name` in `lotTarkibJoinSql`,
`documentOtherName`, `linesVouchForLot` and the editor's «no vouch» hint are deleted with
their keys, and `lotCheckStateSql` reads `tarkibStandsSql` alone. A tarkib that no longer
matches the lot is «o'zgardi» whatever its line count (a one-line tarkib of another good
never vouched, so it never went stale; it vouches now, so it can). Lot-check test 12b is
rewritten as the recorded reversal of 8.6, and asserts in the same breath that the lists
print the tarkib's name while the stored name has not moved.

## 4. Item 2 — the agent Excel: one row per tarkib line

«Yuklama» is in no UI string («Yuklash» is the TRUCKS section's name; the plan is «Yuklash
rejasi»). The reading rests on his description of today, and exactly one surface matches it:
the plan's «Agent uchun Excel» (`plans/[id]/page.tsx` → `/api/plans/[id]/xlsx` →
`buildAgentXlsx`). Its rows are the plan's lines (a line with a road part is up to three rows
in three blocks: here under its arrival, «В пути», «Не пришло»), and a composed lot's whole
planned contents are written ONCE, as text under the Chinese name in the product cell of the
lot's first row («Состав лота (весь план): …») — his «prixod 1 qator bo'lib, tarkibi nomlarni
ichida turibdi». Every other paper already prints a row per line (the invoice, the draft
packing list, «Packing (rasmlar)»); every screen prints one row per lot and no tarkib at all.
LOT-TARKIBI's own opening paragraph promised «the agent file prints a composed lot as one row
per line» while its §4 built the text suffix: he found the gap. Asked back with named options.

Built:

- **Group by LOT ID inside one block, never by adjacency or by label.** Lot labels are not
  unique (letters come from a per-warehouse counter shared by every client and cycle every 702
  lots — measured on gsr_ci: 605 claimed lots, 27 labels carried by two or more), so «the rows
  of one label are adjacent» is not a rule. A `Set<lotId>` per block.
- **The figures — `paperLinesByPart`** (new pure export of `composition-math.ts`):
  `(comp, lot, { segments, parts: { cartons, kg, m3 }[] }, opts) → (PaperView | null)[]`. It
  fits the plan's positions ONCE over Σ cartons (`fitSegments`), slices the fitted runs
  consecutively for the parts — here, then «В пути», then «Не пришло» — calls the existing
  core per part and ORs the whole fit's `clamped` into every part. A part of 0 cartons is
  null. Two traps this closes, both reproduced on the real `paperLines`: passing each block
  `segments: []` on a plan that does not cross restarts every block at position 0 (cartons
  [34,33] [15,15] [2,1] → 51/49, the old Papers-2 defect, against the right [1,2] in the last
  block); and pre-sliced runs lose `fitSegments`' `clamped` reason.
- **Decimals**: `{ kgDecimals: 3, m3Decimals: 4 }` — the precision the uncomposed rows of THIS
  sheet print (`planned_kg` as stored), so a block's cells add up to its heading
  (`round1` «as today» made 33.3 + 33.3 + 33.3 under a heading of 100.0).
- **One row per printed line**: «Код» the lot's label on every line row · «Товар»
  `agentProductCell(line, lot, first)` = the packing lists' product cell (the line's name, the
  lot's Chinese name beside the line that IS the lot's own good) + the line's TNVED in brackets
  when stated («Мышь [8471606000]»); the Chinese name never vanishes from the one sheet read
  Chinese-first — when no line is the lot's own good, the lot's FIRST line row carries a second
  text line «На коробке / On the carton: 键盘» · «Кол-во, шт» `packingPiecesCell` · «Коробок»
  `packingBoxesCell` («alohida»: the line's cartons; «aralash»: the part's cartons on the first
  line, «(в тех же коробках)» after) · kg · m³ · the line's kg/m³ · the lot's arrival cells.
- **Photographs** once per block, on the group's first line row (height 60); the other line
  rows `max(20, 15 × text lines)`. (Today they repeat on every plan row of a lot.)
- **Estimate**: fill + note on every line row of an estimated group; a part that is a share
  of a fully planned lot says «доля лота в этом блоке / lot share in this block», not «на
  этой машине».
- Block headings, the title line and both their totals come from the plan's rows as today.
  An uncomposed lot's row is exactly today's. Columns, `PHOTO_START_COL` 9 and the frozen
  panes do not move, so no test that reads a column index moves.
- `agentContentsText`, `agentPiecesCell` and `DOC.contents` are deleted with their tests.
- Stated to him: a plan file downloaded again after a tarkib is written has more ROWS, with
  no new plan version; a truck whose papers are sent keeps its frozen copy.
- The plan view and the plan editor on screen stay one row per lot (he said «yuklamada») and
  show the label of §3.

**As built — two defects the review of the built round found, fixed:**

- **Every good's row wraps and is as tall as its text** (`wrappedLines`, composition-cells.ts —
  an estimate calibrated against LibreOffice's own layout, never short). Only a first row
  carrying the sticker's name wrapped; the others were 20 pt whatever they held, so a name
  with its code in brackets ran past the 40-wide column and lost its END — «Мышь компьютерная
  беспроводная [84716060», a ten-digit code read as a valid eight-digit one — and the
  «aralash» sentence in the 10-wide carton column read «(в тех же ко».
- **An approved plan keeps its positions.** `plan.batchId` is set at the approval, but a truck
  that holds no carton of the lot yet (every carton owed from the road, or missed) is not
  among the lot's trucks, and `truckSegments` answers «from position 0» for a truck it does
  not know: the file printed the lot's FIRST goods where the plan takes its last cartons, and
  went back when the first carton landed. Such a plan takes its positions as a truckless one
  does (`planSegments` — after every truck the lot already crossed on). Pinned in
  `plan-road.integration.test.ts` on a crossing plan.

## 5. Item 5 — 🤖 for tarkib lines

Today: the per-row 🤖 is drawn for product rows only (`{!line && …}`); «🤖 AI taklif (N)»
counts and walks product rows only and is not drawn when that count is 0, while the card's
«TNVED kodsiz · N» counts lines too. So a truck of composed lots has no AI at all — and
nothing says why (`tnved.lineNoAi` is in the four bundles and referenced nowhere): he meets a
missing button. Sharpest case: a ONE-line tarkib of the lot's own good («Bitta tovar», made
only to state pieces) turns a row that had 🤖 and a photo into one with neither.

Built:

- **What the model reads — `lineQuestion`** (pure, `tnved/service.ts`): for a line that is the
  lot's own good (`lineIsLotGood`) the product row's own question (the lot's Chinese name with
  the Russian); otherwise the line's name alone — never the lot's Chinese name as the goods
  name. `wantsPhoto` = the tarkib has ONE line (every carton is that good); for a lot of
  several goods the photo shows one of them and would steer the model to it. `context`: the
  line's own figures («500 шт · 60 кг · 0.8 м³»), the sibling names («в той же партии коробок
  также: …», capped) and, for another good, «на складе партия принята как …». `suggestTnved`
  gains `context`; its text moves into a pure exported `tnvedQuestionText` a unit test reads;
  the system prompt gains one rule: «Контекст» is a hint, classify only «Товар».
- **The call is hardened**: `max_tokens` 2048 → 16000 with a `stop_reason === 'max_tokens'`
  branch (the analyst model's thinking counts inside it — `intake-ai.ts` recorded the cut at
  4096: no text, `JSON.parse` throws, the person reads «AI javob bermadi»), a `logger.warn` in
  the catch that swallowed every failure, a `logger.info` of the tokens per call.
- **Action** `suggestTnvedForLineAction(batchId, lotId, lineId)` — by line ID (after a receipt
  save a seq can name another good). Every step before any spend: `vedActor` +
  `mayWriteComposition` → uuid shapes → the card door → a carton of the lot is a member of the
  truck → `paperCompositionsFor`: none / the line gone → `composition_changed`, frozen →
  `frozen` → `compositionDoor(…, requireConfirmed)` (the save's own door — the model is never
  paid for a code that cannot be saved) → `lineQuestion`, the photo only when wanted →
  `suggestTnved`. It writes nothing.
- **Editor**: 🤖 on a line row when `!line.frozen && line.lineId`; `missing` counts those rows
  too; the reasoning line shows under a line (and says «AI faqat nomga qarab taklif qildi»
  when no photo was sent). The bulk walk: (a) fills every empty line that has a 💡 hint with no
  model call; (b) asks the rest in drawn order, reading the LIVE code through a ref before
  each ask and before applying, so a code typed meanwhile is never overwritten; (c) keeps one
  answer per line NAME and copies it to same-named empty lines — the invoice merges them only
  when their codes are equal (§6); (d) stops on `forbidden`, `frozen`, `composition_changed`,
  `ai_not_configured` and after two consecutive `ai_failed`; (e) shows «done / n» and a stop
  button. `saveAll` posts only CHANGED product rows (today one row a colleague composed
  meanwhile refuses the whole save `not_on_truck`, and the reload drops every unsaved answer).
- A suggested line code is state until «Saqlash», which posts it through `saveLineCodesAction`
  — on the line, never in the memory (unchanged, fence rule 3). A saved line code is already
  the 💡 for that name on later lots (`tnvedHintsFor`), so nothing more is remembered.
- No ledger row, no daily limit — the lot-level 🤖 has neither today (asked; ⭐ none).
- `tnved.lineNoAi` leaves the four bundles; new `tnved.aiNameOnly`, `aiSameName`,
  `suggestProgress`, `suggestStop`.

**As built** (overrides the bullets above where they differ):

- The walk's stop rule (`walkStep`, editor-state.ts): a door shut for EVERY row ends it
  (`forbidden`, `frozen`, `ai_not_configured`, anything unknown), and so do two `ai_failed`
  in a row — one sentence on the screen is enough. A fact about ONE lot
  (`composition_changed`, `receipt_not_confirmed`, a lot that is gone) leaves that lot's
  rows alone and the walk goes on; the lot is named at the end.
- The walk's write is `fillEmpty` — the emptiness check is INSIDE the state updater, so «a
  code typed meanwhile is never overwritten» is a property of the write and not of a ref read
  a moment earlier; the ref (`rowsRef`) only saves the model a call for a row that got a code.
  A single 🤖 press on a row still replaces that row's code — the person asked for it.
- The photograph has ONE reader in the action file (`firstLotPhoto`), called by both 🤖
  actions after every door; the line action returns `photo: boolean`, and the row says
  «rasmsiz, faqat nomga qarab» when none was read.
- The context names the warehouse's word for the cartons («приняты под названием «键盘» — это
  название может быть неточным») only for a line that is NOT the lot's own good, and the
  system prompt gained one rule: «Контекст» is a hint, classify only «Товар».
- The editor's root carries `data-tnved-unsaved` (typed and not saved, product rows and
  lines) — the invoice button reads it (§6.4).
- **The editor re-seeds by MERGE, never by remount** (the review of the built round, five
  findings — DECISIONS #1647). `editor-state.ts` (pure): `reseedRows` keeps a code that is
  typed or suggested and not saved on its row when the server's rows come back, and takes the
  server's row everywhere else; the page's `key` built from the line revisions is gone. The
  save is not stopped by one refusal (`saveLineCodesAction` → `refused`, `saveTnvedAction` →
  `gone`, every code validated before the first write); the walk ends with the editor
  (unmount), `walkStep` replaces the stop rule above for ONE lot's refusal (that lot is left
  alone, the walk goes on, the lot is named at the end), and `sameNameCode` takes a
  same-named line's code off the screen before the model is asked. Pinned by
  `tests/unit/tnved-editor-state.test.ts`, the save tests in `tnved-line-ai.integration` and
  the browser proof in `m9zzx` (a colleague's code and revision written by SQL, the tab
  re-read, the typed code still there). 12 more red proofs.
- Pinned by `tests/unit/tnved-question.test.ts` (the question, pure),
  `tests/integration/tnved-line-ai.integration.test.ts` (every door with a model stand-in
  that records what it is asked — the card door proven ALONE by a prixod received at a third
  warehouse, so the composition's own door would have let the person through),
  `tests/unit/batch-door-wire.test.ts` (door order, the walk's write, the changed-only save)
  and the browser half in `m9zzx` (no AI key here or in CI: the button, its count, the honest
  refusal). 12 red proofs by string edit; one stayed green first (the card door, masked by
  the composition's door) and its fixture was re-shaped.

## 6. Item 6 — the invoice draft

Today (`documents/ved-xlsx.ts` `buildInvoiceXlsx`): cells are written WHILE the lots are
walked — one row per uncomposed lot (name = the lot's ru || zh, code = the TNVED memory by
the CHINESE name, «кг»), one row per printed tarkib line (the line's own name and code, «шт»
when its pieces land ≥ 1 here, else «кг»). Nothing merges, no row says which lots it is, and
the Bojxona tab links the file as a plain `<a target=_blank>`.

### 6.1 One pure row model — `documents/invoice-rows.ts`

Imports only `nameKey`. `buildInvoiceXlsx` becomes three steps, and the dialog's list and the
sheet come from the SAME source rows (#513):

1. `invoiceSourceRows(batchId)` (`ved-xlsx.ts`, exported) — exactly today's rows, unshifted and
   unmerged, each carrying its lot (`{ lotId, label, lines }` — `lines` = the tarkib's line
   count as this paper reads it, 0 = none), `name`, `code` ('' = none), `unit`, `pieces`,
   `places` (a number, `'part'` or null — turned into «(часть места)» only at the sheet),
   `kgTenths` (an INTEGER: every row is already a tenth), `estimate` (the note, or null).
   Lots in a TOTAL order — letter, then label, then lot id (today's `ORDER BY letter,
   seq_in_lot` interleaves lots that share a letter, so the same truck could print its rows
   in another order on the next download).
2. `invoiceModel(source, answer)` (pure) → `{ positions, groups, fp, redLabels }`.
3. The sheet is written from `positions`.

### 6.2 Merging

- **Automatic** — rows with the same NON-EMPTY code and the same name (`nameKey`: trimmed,
  lower-cased, whitespace collapsed) are one position, wherever they come from: two clients'
  lots, a tarkib line and a lot with no tarkib. The first member keeps the slot and the
  spelling. A row with NO code is never merged and never asked.
- **Asked** — a non-empty code that still holds two or more positions is a GROUP. It merges
  only when the download names it WITH the signature it was listed under
  (`merge=<code>.<sig>`, `sig` = 8 hex of a pure FNV-1a over the code and its SORTED name
  keys): names that changed between the list and the file are asked again, never merged
  blind. A merged group is ONE position in its first member's slot, named with its distinct
  names joined «, » in slot order (the draft is finished by hand in Excel; nothing is lost).
- **A merged position's figures**: `kgTenths` = Σ as integers (so `SUM` netto / brutto equal
  today's by construction — never floats re-rounded); places = Σ of the numeric members,
  «(часть места)» only when none is numeric; unit «шт» with Σ pieces only when EVERY member
  is «шт», otherwise «кг» with Σ kg and a NOTE on the quantity cell naming the pieces that
  were stated («шт: GS777-A 500») — mixed units are common, an uncomposed lot is always «кг»;
  the estimate fill when any member is an estimate, the name cell's note one member's text
  verbatim or `label: note` joined «; ».

### 6.3 The new column and the red

- Columns: A «№» · **B «Маркировка / Marks»** (new, width 22) · C name · D code · E unit ·
  F quantity · G places · H netto · I brutto · J price · K amount (`=J*F`); totals `SUM(G)`,
  `SUM(H)`, `SUM(I)`, `SUM(K)`. The header block's VALUES move from B to C (merges `C1:J1`,
  `C7:J8`, `C10:J11`, `C13:J15`; the customs post to `I17`) and B stays empty in rows 1-18 —
  which also cures a live defect the map rendered: column A is 4 wide, so «Отправитель/Sender:»
  reads «Отпр» today; with B empty beside it the label spills and is readable.
- B = the labels of the lots behind the position — `client code + '-' + letter`, and for a
  prixod received by marking and claimed later the marking in brackets, «GS444-B
  (444MANIKEN-AL)» — distinct strings, «, »-joined in slot order.
- **Red** = «opening a carton with this sticker you may find another good»: a lot whose tarkib
  has two or more lines that do NOT all stand in one position of this invoice — whether the
  others stand in other rows or (a partial truck, «alohida») are not on this truck at all.
  Decided per LABEL STRING over the whole truck, never per lot or per row: labels are not
  unique (the letter counter is per warehouse and cycles; gsr_ci holds 28 strings carried by
  two or more lots), and the person at the carton has only the sticker — the same string red
  in one row and black in the next would be a riddle. A red label is red + bold in every row
  it appears in (bold survives a black-and-white print).
- Rich text: every run carries `font: { name: 'Arial', size: 11 }` (a run without a name
  came out in the workbook's default face — the «all fonts Arial» pass sets the CELL's font
  and does not reach runs); tests read `cell.text`, never `String(cell.value)`.

### 6.4 «Ask, then give the invoice»

- **The list is a GET route**, `api/batches/[id]/invoice/groups` (`force-dynamic`,
  `Cache-Control: private, no-store`, the invoice's own `guardBatchDocument`), not a server
  action: Next runs actions one at a time, so an action would queue behind the editor's AI
  walk — which this round makes longer. `src/app/sw.ts` lists the invoice and its groups
  NetworkOnly (every other same-origin `/api/*` GET is NetworkFirst with a day-long cache —
  a list of merge candidates must never be yesterday's).
- **The trigger is a BUTTON** (`InvoiceDownload`, client, in the tab's folder), not a link with
  an `onClick`: `download-links.tsx` is a capture listener on `document` and takes a press on
  an `<a href="/api/…">` before React hears it — on a phone the file would download unmerged
  AND the dialog would open.
- Press → the groups. None → the file at once. Some → a dialog (`Overlay`, always mounted and
  toggled — an Overlay mounted already-open closes itself): per group the code, its names with
  their lots / kg / pieces, a «Qo'shish / Alohida» pair; one row «Hammasini: Qo'shish ·
  Alohida»; what a merged position will be called; the mixed-units warning; the red note;
  «Invoysni olish». An unanswered group stands at «Alohida» — what a bare address prints.
- The answers go in the address: `?merge=<code>.<sig>,…` (or `merge=all.<fp>` when every
  group is merged — `fp` = the hash of all the signatures), followed through
  `signedDownloadUrl` + the shared `followDownload` at the moment of the press, so Telegram's
  in-app browser downloads it (a POST-then-blob cannot reach its download manager). The
  signed path is capped at 2048 characters — about 95 pairs; `all` covers the rest.
  `parseMergeParam` treats the parameter as a forged post (shape-checked, capped, garbage
  dropped — never a 500).
- This device's last answers per truck are kept in `localStorage` (try/catch on every read
  and write; applied only where the signature still matches; a convenience, never a record)
  and stand pre-selected next time. No table, nothing to freeze: «hujjat yuborildi» freezes
  only tarkibs and carton positions today — an uncomposed lot's name and memory code are
  live on a sent truck — so a stored, locked answer could not make a sent truck's file
  identical anyway. The dialog says when the papers went.
- `guardBatchDocument` gains `isUuidShaped` (a malformed id is a 22P02 → 500 on all four
  document routes today).
- The tab's editor root carries `data-tnved-unsaved` (P4); the button reads it at the press
  and says «N ta kod saqlanmagan — invoysga kirmaydi» first: the invoice reads SAVED codes,
  and an AI answer is a draft until «Saqlash».

**As built — the review of the built round changed three things here (they override the
bullets above):**

- **A file is followed only right after the list was read.** The button replaced an
  `<a target="_blank">`; its download is a navigation of the tab it stands in. A list that
  could not be read (a deploy recreating the server, a session run out) used to fall back to
  the plain file — whose address fails for the same reason, answers with a page instead of a
  file, and so REPLACED the Bojxona screen and every code typed or suggested and not saved.
  Now `readGroups()` answers null for any failure, the screen says so
  (`invoys.listFailed`, inside the open dialog too) and nothing is followed.
- **«Invoysni olish» reads the list again.** A dialog left open while a colleague saved a
  code, a name or a tarkib sent answers about a list that no longer existed, and they were
  dropped without a word. When the list's fingerprint moved, the dialog shows the new list,
  keeps the answers that still name a group, says `invoys.moved` and waits for a second press.
- **Pairs first in the address.** `mergeQuery` writes `code.sig` pairs whenever they fit
  (≤ `MERGE_PICKS_MAX`) and `all.<fp>` only when EVERY group is chosen and they do not: `all`
  names the whole list, so one changed group took every other answer with it.
- The editor counts as «unsaved» only what differs from what the SERVER holds: for the moment
  between «✅ Saqlandi» and the refreshed page it used to compare with the rows it was handed,
  and the dialog warned about a code saved a third of a second earlier (found by the browser
  run).
- Pinned by `tests/unit/invoice-rows.test.ts` (the pure model, incl. «one group renamed under
  an open dialog»), `tests/integration/invoice-merge.integration.test.ts` (the file, by
  header), `tests/unit/invoice-dialog-wire.test.ts` (the dialog's two rules, source-shape) and
  the browser half in `m9zzx` (the list held at the CONTEXT — the service worker answers
  `/api/*`; a code changed under the open dialog by SQL).

## 7. Questions to him (⭐ = built if unanswered)

Sent with the round's report, in Uzbek, numbered:

1. (band 1) Tarkib yozganda hujjat/rasm: ⭐ a) so'ralmaydi — ixtiyoriy, xohlasa biriktiradi ·
   b) majburiy qolsin, lekin skladchi qabulda olgan rasm ham o'tsin · c) boshqa narsa.
2. (band 1) Hujjatsiz yozilgan tarkib lotni «✅ tekshirilgan» qiladimi: ⭐ a) ha · b) yo'q,
   faqat hujjatli tarkib.
3. (band 2) «Yuklama» = reja sahifasidagi «Agent uchun Excel»: ⭐ a) ha, faqat shu fayl ·
   b) ha, va rejaning ekrandagi ro'yxatida ham · c) yo'q — partiya kartasidagi «Ichidagilar» ·
   d) boshqa joy.
4. (band 4) Ko'p tovarli tarkibda: ⭐ a) «Клавиатура +2» (birinchisidan tashqari yana 2 ta) ·
   b) «Клавиатура +3» (jami 3 ta) · c) hammasi vergul bilan.
5. (band 3-4) Mijoz ko'radigan joylarda ham (Mini App, «yukingiz keldi» xabari, topshirish
   akti) tarkib nomi chiqsinmi: ⭐ a) ha · b) yo'q, mijoz skladchi yozgan nomni ko'radi.
6. (band 6) Bir xil kod + bir xil nom har xil MIJOZLARNING yukida bo'lsa ham bitta
   pozitsiyaga qo'shilsinmi: ⭐ a) ha · b) faqat bitta mijoz ichida.
7. (band 6) Kod bir xil, nom har xil, «Qo'shish» tanlandi — invoysda qaysi nom: ⭐ a) hamma
   nomlar vergul bilan · b) oynada bittasini tanlayman · c) o'zim yozaman.
8. (band 6) Javob eslab qolinsinmi: ⭐ a) shu telefon/kompyuter oxirgi javobni belgilab
   turadi, oyna har safar chiqadi · b) mashina bo'yicha bir marta so'ralib, hamma uchun saqlansin.
9. (band 6) Biri «dona», biri «kg» bilan yozilgan qatorlar (as built, PAPERS-1: never merged
   by itself): ⭐ a) oynada so'raladi; «Qo'shish» desa kg bilan chiqadi, donasi izohda qoladi ·
   b) bunday qatorlar umuman qo'shilmasin.
10. (band 5) Ko'p tovarli lotda AI rasmga qaramaydi, faqat nom/son/vaznga qaraydi (rasmda
    qaysi tovar ekani noma'lum): ⭐ a) shunday · b) rasm ham yuborilsin.

Stated, not asked (each a one-line «aytib qo'yay»): the sticker keeps the warehouse's name;
the scan screens print the Chinese name only; a plan's agent file gains rows when a tarkib is
written; a sent truck's invoice still follows later TNVED/name changes of lots with no tarkib;
the AI button has no daily limit, as before.

## 8. Packages

Kernel K (the lead — WRITTEN, commits on the branch): migration 0143 + journal + schema;
`violatedNotNull`; `compositionsFor` LEFT JOIN + the nullable `attachment`; `tarkibLabel`;
`receipts/lot-name.ts`; `lot-composition-fence` lists. P1 (the lead — WRITTEN): §2 and §3.5
and the receipt card (`lot-composition.ts` save, `composition-panel.tsx`,
`composition-actions.ts`, `receipts/[id]/page.tsx`, `lot-edit-form.tsx`, `lot-check*.ts`,
`lot-check-panel.tsx`, bundles `tarkib.*` `lotCheck.*` `receipts.attachInUse`), with its
integration, unit and e2e tests and nine red proofs.

| Package | Owns | Files it alone edits |
|---|---|---|
| P2a names — warehouse | §3.3 warehouse + search | stock (page, XLSX, filter), `planning/stock.ts`, plan view, `batches/lots.ts` and its three screens, scanning count panels and texts, box / crate pages, issue list, QR-siz list, bot lookup, `client-cargo-now.ts`, `search/service.ts`, broadcast filter |
| P2b names — office + customer | §3.3 office + customer | deals cargo labels, lenta, costing labels, reports + XLSX, unpriced / compensation, pickups, tracking, annul registry, uncollected list, manifest, `receipts/edit.ts` payload, client-cabinet, notices, `issue/service.ts` payload, handover act |
| P3 agent Excel | §4 | `agent-xlsx.ts`, `composition-cells.ts` (agent cells only), `composition-math.ts` (`paperLinesByPart` only), `labels.ts` (`contents` out, the carton-name label in) |
| P4 🤖 for lines | §5 | `tnved/service.ts` (the question + the call), `tnved/actions.ts`, `tnved-editor.tsx`, bundle `tnved.*` |
| P5 invoice | §6 | `ved-xlsx.ts` (invoice), new `documents/invoice-rows.ts`, `labels.ts` (`lotMarks` only), `api/batches/[id]/invoice/**`, `route-guard.ts`, `sw.ts`, `download-url.ts` / `download-links.tsx` (`followDownload`), new `invoice-download.tsx`, `batches/[id]/tnved/page.tsx` (the button only), bundle `invoys.*` |

Shared files, one rule each: `messages/*.json` — every package edits only its own namespaces
through a script; `tests/integration/lot-composition.integration.test.ts` — P3 edits tests 9 /
9b only, P5 test 7 and the `invoiceRows` helper only, everything else goes into NEW test files;
`tests/e2e/m9zzx-lot-tarkibi.spec.ts` — P5 edits the `invoice()` helper's column numbers only;
`tests/unit/lot-composition-fence.test.ts` — the lead registers new modules at the merge.
The derived `lot-name-fence.test.ts` (§3.4) is written by the lead on the merged tree.

**Who builds what (v3):** K, P1, P3 — the lead, WRITTEN. P5 (invoice) and P4 (🤖) — the lead.
P2a and P2b — builders in worktrees, on the base commit the lead names; §9.1-§9.2 bind them.

## 9. v3 — what the last two maps and the papers judge changed (BINDING)

### 9.1 Kernel additions (WRITTEN)

- **No «键盘 (键盘)».** «Bitta tovar» pre-fills its line with the lot's Russian name ELSE the
  Chinese one, and most lots are typed in Chinese only (561 of 640 on gsr_ci) — so the commonest
  one-line tarkib would have made every `zh (ru)` cell print the Chinese name twice. A ONE-line
  tarkib whose name is the lot's Chinese name (by `productKey`, which is `nameKey` character for
  character) gives NO label: `tarkibLabel(lines, lotZh)` (the second argument REQUIRED) and the
  same clause in `lot-name.ts`'s HAVING; with no label the lot's own Russian name shows.
  Two or more lines are always a label, even when the first repeats the Chinese name.
- **«+N» is the half that must survive.** Everything that shortens a string cuts its END, and
  the count is the end: the stock, plan, truck-card and issue cells are CSS `truncate`, the
  customer pushes clip at 80 and the photo buttons at 40. `platform/text/label-count.ts`
  (pure; platform, wms and the browser import it): `splitLabelCount`, `clipKeepingCount(text,
  max)` (code points, «Клавиатура проводн… +2»), `withoutLabelCount(needle)`;
  `components/lot-goods-name.tsx`: `LotGoodsName({ zh, ru })` for a `zh (ru)` cell and
  `LotNameText({ text })` for a one-name cell — the name truncates, the count sits in a
  non-shrinking element. The count is found in the TEXT, so the helpers never need to know
  whether a string came from a tarkib.

- **Goods KINDS for the lists that already count.** `lotGoodsKindsSql(lot)` (lot-name.ts) is
  a `text[]`: the tarkib's line names in order while it has a label, else the one `ru || zh`
  name. A deal's cargo label and the uncollected list print «first +N» over SEVERAL lots; fed
  the lot's label they would print «Клавиатура +2 +1». They `unnest` the kinds instead, so
  there is ONE number: the first kind and how many more kinds there are in all.

### 9.2 Rules for the two «names» packages

1. **Swap the SELECT expression through `receipts/lot-name.ts` only** — `lotRuShownSql(sql\`${receiptLots}\`)`
   (or the query's own alias) for a `product_name_ru` a screen PRINTS, `lotGoodsShownSql` for a
   `ru || zh` reader. A file outside the fence's ALLOWED list never names the composition
   tables. Inside a transaction: `lotRuShownFor(ids, tx)` — never the pool (#714).
2. **A row type that is BOTH display and identity gets a second field, never a swapped one.**
   `BatchLot.productNameRu` (batches/lots.ts) is drawn on three screens AND is the price
   history's trigram needle (price-history.ts, the `similar` route): add `shownNameRu` beside
   it and draw `shownNameRu ?? productNameRu`. Before swapping any field in place, grep its
   consumers for a write, a key, a prompt, a search needle or a paper.
3. **Stored payloads keep the lot's own name.** The `BoxIssued` event's `lots` and the
   re-emitted «prixod confirmed» payload are WRITTEN and kept (a label must never be stored as
   if it were the lot's name; nobody prints the first, and no tarkib can exist at confirm
   time). The customer's pushes re-read at SEND time — that read is where the label goes
   (`receivedFacts`, `arrivedSummary`, `issuedFacts`). This withdraws §3.3's two «payload» items.
4. **Platform code** (`platform/broadcast/service.ts`'s goods filter) reaches
   `tarkibLineMatchSql` by DYNAMIC import only — platform never statically imports wms and may
   not name the tables.
5. **Searches** (/stock's box, ⌘K's lots, the count door, the broadcast): the needle goes
   through `withoutLabelCount` first, and the predicate ORs `tarkibLineMatchSql` into its own
   zh/ru arms — «мышь» finds the lot whose second line is mice, and a label pasted off a card
   finds its lot.
6. **Truncating cells and text clips**: every cell that prints a lot's name inside a
   `truncate` uses `LotGoodsName` / `LotNameText`; every clip of a lot's name uses
   `clipKeepingCount`. Measured at 360 px with a 60-character first name: «+2» is on screen.
7. **PDF**: the handover act swaps in the SELECT, so `cjkSubsetFor` embeds the label's
   characters («+», digits and the plain space are in the base set; the names are not).
8. **No new probe.** `lot_composition_lines` has existed on every server since 0122; where a
   statement already branches on a probe, either branch may carry the label.
9. **Keeps the own name** (the fence's counted allowlist — do not touch): `labels/sheet.ts`
   and the QR-siz print list, `ved-xlsx.ts`, `packing-photos-xlsx.ts`, `agent-xlsx.ts`,
   `tnved/batch-lots.ts` and the tnved actions, `price-history.ts`, `similar-ai.ts` and its
   route, `lot-composition.ts`, `receipts/edit.ts` and the ✏️ form, the lot check's own
   snapshot (§9.3), the scan screens (Chinese only).
10. **A test per package that seeds a tarkib and reads it through the swapped readers** — no
    existing test does, so no swap can go red by itself: one new integration file per package
    (three-line tarkib → «Клавиатура +2» through each reader's own exported function; the
    stored name unmoved; a lot with no tarkib unchanged), each reader red-proven by swapping
    its expression back.

Stated to him, not built: the manifest and a re-printed handover act follow the LIVE tarkib
(a sent truck's invoice does not); the AI assistant's SQL tier (the `gsr_ai_reader` role is
denied the composition tables) still answers with the warehouse's name.

### 9.3 The person's ✅ is for the name the card SHOWS (the lead, P1 follow-up)

Found by the lot-check map on the branch as built: the «✅ To'g'ri — mijoz tasdiqladi» button
sits under a header that prints the LABEL and snapshots the STORED name — «a person cannot
confirm a name they did not see», broken; and a tick made as «Клавиатура», then a one-line
tarkib «Мышь», then a re-weigh, read ✅ «Mijoz tasdiqladi» beside «键盘 (Мышь)». The check's
Russian name is the SHOWN one everywhere: `lotTarkibJoinSql` carries the label, the name term
compares `seen_name_ru` with `coalesce(label, product_name_ru)`, and `checkLot` reads the
label under the lot lock (the save and the clear take the same lock first) for the
`lot_changed` compare, the snapshot and the audit summary. The Chinese name term is untouched.

### 9.4 The invoice — the papers judge's four (the lead, P5)

- **PAPERS-1 — a merge never takes «шт» off the paper by itself.** The automatic key is
  code + name + UNIT. «Клавиатура шт» and «Клавиатура кг» under one code are two positions,
  hence a GROUP: listed in the dialog with the mixed-units warning and merged only on a signed
  answer; a bare address prints them apart, exactly as today (his 3a of 2026-10-01 stands
  unless he answers the dialog). A merged position prints each distinct name ONCE.
  `groupSig` hashes name + unit pairs. Q9 is answered by the dialog itself.
- **PAPERS-2 — a merge never crosses a customs choice.** Inside one truck some prixods are
  cleared by the client's own firm or by another firm (`effectiveCustoms`, the Rastamojka
  panel on the same tab). Fused into one position their places and kilos could no longer be
  taken out of OUR invoice. Every source row carries its prixod's customs scope ('' = follows
  the truck, `client`, or the firm's id); rows merge — automatically and by answer — only
  inside one scope, and a group is a code within one scope.
- **PAPERS-3 — what moves with the new column**: BOTH helpers of
  `lot-composition.integration` (`invoiceRows`, `invoiceAmounts`, the `I*E` formula),
  `m9zzx`'s `invoice()`, `pallet.integration` and `count-review.integration` (read by HEADER
  where possible); the fence's rule 4 is re-anchored on `invoiceSourceRows`; the kg/brutto
  readers move to their own cells even though the two carry the same number today.
  Reversals to record: #1263's 2a (the agent file's one row with the contents under it).
- **PAPERS-4 — a merged position's estimate note names its lots**: verbatim only when the
  position holds ONE lot; otherwise every note is `label: note`, joined «; ».

