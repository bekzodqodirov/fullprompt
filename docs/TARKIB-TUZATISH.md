# Tarkib tuzatishlari — six fixes to the lot composition (2026-11-10)

Status: **v1 — the design after the readers' maps, before the judge.** The kernel (§1, §3.2)
is written and red-proven; everything else is open to the judge.

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

## 1. Data — migration `0142_tarkib_document_optional` (`when` 1785190000121, ledger 143)

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
- **Rollback** (docs/UPDATE.md, «0142 dan PASTGA»): code below this release inner-joins, so
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

### 3.5 The lot check

`tarkibVouchesSql` → `lot_tarkib.n >= 1` (`one_name` leaves `lotTarkibJoinSql`);
`documentOtherName`, `linesVouchForLot` and the editor's «no vouch» hint are deleted with
their keys; lot-check test 12b and the fence's «1a reversed» sentence pins are rewritten as
the recorded reversal of 8.6.

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

## 6. Item 6 — the invoice draft

### 6.1 One pure row model — `documents/invoice-rows.ts`

`buildInvoiceXlsx` stops writing cells while it walks lots. It builds SOURCE rows (one per
uncomposed lot, one per printed tarkib line — exactly today's rows, each carrying its lot's
label), then `mergeInvoiceRows(source, mergeCodes)` → FINAL rows, then writes. The dialog's
list (`invoiceMergeGroups(source)`) and the sheet come from the same source rows (#513).

### 6.2 Merging

- **Automatic**: rows with the same non-empty TNVED code AND the same name (`nameKey`: trimmed,
  lower-cased, whitespace collapsed) become one position, wherever they come from (two
  clients' lots included). Rows with NO code never merge.
- **Asked**: a code whose rows carry two or more different names is a GROUP. Listed in the
  dialog; merged only when the download names that code (`?merge=<code>,<code>`). A merged
  group prints ONE row named with its distinct names joined «, » in row order (the draft is
  finished by hand in Excel; nothing is lost).
- A merged row: quantity = Σ when every member has the same unit, else «кг» with Σ kg;
  places = Σ of the numeric places («(часть места)» only when every member says so);
  netto = brutto = Σ kg (members are already tenths; re-rounded to a tenth); the estimate
  fill and a note joining the members' notes when any member is an estimate. Position =
  its first member's. `SUM(G)`/`SUM(H)`/`SUM(F)` equal today's.

### 6.3 The new column and the red

- Columns: A «№» · **B «Маркировка / Marking»** (new) · C name · D code · E unit · F quantity ·
  G places · H netto · I brutto · J price · K amount (`=J*F`). Totals row and header merges
  move one column right.
- B = the labels of the lots behind the row (`client code or marking` + `-` + letter),
  «, »-joined in row order. Everything is keyed by LOT ID, never by label: labels are not
  unique (two lots of different warehouses or letter cycles can both be «GS777-A»), so a
  label string is printed once per row but stands for every lot that carries it.
- A lot that stands behind MORE THAN ONE final row is written red + bold in every row it is
  in — the label is red when ANY lot behind that string in that row is such a lot (rich text
  runs, so a merged row can hold a red and a black label).

### 6.4 The dialog — «ask, then give the invoice»

`InvoiceDownload` (client) replaces the plain link. Press → `invoiceGroupsAction(batchId)`
(the invoice route's own door) → no group: the file at once; groups: a sheet listing each
code with its names (lots, kg), a «Qo'shish / Alohida» choice per code, «Hammasini qo'shish»,
«Hammasini alohida», «Invoysni olish». The answers go in the address
(`/api/batches/<id>/invoice?merge=…`) through `signedDownloadUrl`, so Telegram's in-app
browser downloads it; the last answers per truck are remembered in `localStorage` (a
convenience, pre-selected next time). No table, nothing to freeze: a bare address (an old
link) prints every asked group separately.

## 7. Questions to him (⭐ = built if unanswered)

Sent with the round's report, in Uzbek, numbered:

1. (band 1) Tarkib yozganda hujjat/rasm: ⭐ a) so'ralmaydi — ixtiyoriy, xohlasa biriktiradi ·
   b) majburiy qolsin, lekin skladchi qabulda olgan rasm ham o'tsin · c) boshqa narsa.
2. (band 1) Hujjatsiz yozilgan tarkib lotni «✅ tekshirilgan» qiladimi: ⭐ a) ha · b) yo'q,
   faqat hujjatli tarkib.
3. (band 2) «Yuklama» = reja sahifasidagi «Agent uchun Excel»: ⭐ a) ha · b) boshqa joy (qaysi).
4. (band 4) Ko'p tovarli tarkibda: ⭐ a) «Клавиатура +2» (birinchisidan tashqari yana 2 ta) ·
   b) «Клавиатура +3» (jami 3 ta) · c) hammasi vergul bilan.
5. (band 3-4) Mijoz ko'radigan joylarda ham (Mini App, «yukingiz keldi» xabari, topshirish
   akti) tarkib nomi chiqsinmi: ⭐ a) ha · b) yo'q, mijoz skladchi yozgan nomni ko'radi.
6. (band 3-4) Stiker qayta chop etilsa: ⭐ a) skladchi yozgan nom (stiker o'zgarmaydi) ·
   b) tarkib nomi.
7. (band 6) Bir xil kod + bir xil nom har xil MIJOZLARNING yukida bo'lsa ham bitta
   pozitsiyaga qo'shilsinmi: ⭐ a) ha · b) faqat bitta mijoz ichida.
8. (band 6) TNVED kodi hali yozilmagan qatorlar: ⭐ a) qo'shilmaydi · b) nomi bir xil bo'lsa qo'shilsin.
9. (band 6) Kod bir xil, nom har xil, «qo'shish» tanlandi — invoysda qaysi nom: ⭐ a) hamma
   nomlar vergul bilan · b) oynada o'zim tanlayman/yozaman.
10. (band 6) Javob eslab qolinsinmi: ⭐ a) shu telefonda/kompyuterda oxirgi javob tayyor
    turadi, har safar oyna chiqadi · b) bir marta so'rab, keyin so'ramasin.
11. (band 6) Bir pozitsiyaga qo'shilganlarning birida «dona», birida «kg» bo'lsa: ⭐ a) kg
    bilan chiqadi · b) bunday qatorlar qo'shilmasin.
12. (band 5) Ko'p tovarli lotda AI rasmga qaramaydi, faqat nomga qaraydi (rasmda qaysi tovar
    ekani noma'lum): ⭐ a) shunday · b) rasm ham yuborilsin.

## 8. Packages

Kernel K (the lead, first — every package compiles against it): migration 0142 + journal +
schema; `violatedNotNull`; `compositionsFor` LEFT JOIN + the nullable `attachment` type with
its compile fixes; `tarkibLabel`; `receipts/lot-name.ts`; the two fences' scaffolding.

| Package | Owns | Files it alone edits |
|---|---|---|
| P1 tarkib editor + lot check | §2, §3.5, the receipt card | `lot-composition.ts` (save/clear), `composition-panel.tsx`, `composition-actions.ts`, `receipts/[id]/page.tsx`, `lot-edit-form.tsx`, `lot-check*.ts`, `lot-check-panel.tsx`, bundles `tarkib.*` `lotCheck.*` `receipts.*` |
| P2a names — warehouse | §3.3 warehouse + search | stock, plans, `batches/lots.ts`, scanning count panels, crates, issue list, QR-siz list, bot lookup, `client-cargo-now.ts`, search |
| P2b names — office + customer | §3.3 office + customer | deals, lenta, costing labels, reports, unpriced/compensation, pickups, tracking, annul registry, uncollected, manifest, `receipts/edit.ts` payload, client-cabinet, notices, handover act |
| P3 agent Excel | §4 | `agent-xlsx.ts`, `composition-cells.ts` (agent cells), `composition-math.ts` (`sliceSegments`), `labels.ts` |
| P4 🤖 for lines | §5 | `tnved/service.ts`, `tnved/actions.ts`, `tnved-editor.tsx`, bundle `tnved.*` |
| P5 invoice | §6 | `ved-xlsx.ts` (invoice), new `documents/invoice-rows.ts`, `api/batches/[id]/invoice`, new `invoice-download.tsx`, `batches/[id]/tnved/page.tsx` (the link), bundle `invoys.*` |
