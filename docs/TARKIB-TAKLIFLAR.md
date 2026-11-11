# Tarkib takliflari — a tarkib filled from the client's file, the client's own ✅/❌ in Telegram, the Bojxona 🤖's bill and daily limit (2026-11-11)

His answer to the tarkib round's report (ten ⭐ questions, three suggestions), verbatim:

> «Hammasi yulduzcha javob va taklifingni qoshamiz»

The first half is recorded in `docs/TARKIB-TUZATISH.md` §7 and DECISIONS #1651 (every ⭐ stands; two were
pinned only now). This document is the second half — the three suggestions as they were sent to him:

1. «Tarkibni mijozning packing-list fayli yoki rasmidan AI o'qib to'ldirsin — 10–20 qatorni qo'lda yozmaslik
   uchun.» → **T1**
2. «Tarkibni mijozning o'zi Telegram'da tasdiqlasin (✅/❌) — ilgari kelishilgan, hali qilinmagan band.» → **T2**
   (the owed «5b» of `docs/YUK-TEKSHIRUV.md` §1 row 5, widened so the TARKIB can be confirmed too — the
   sentence he approved says «tarkibni»)
3. «Bojxonadagi 🤖 ga xarajat hisobi va kunlik limit qo'yilsin.» → **T3**

LEAD'S READING, stated to him at the top of the report: «taklifingni» = all three.

Numbering: DECISIONS from **#1652** (re-read main's tail before writing each). Migration **0144**
`tarkib_takliflar`, `when` 1785190000123 — ledger must reach **145**. Re-fetch main before minting: the other
session's open PR #141 («Fayl o'qish») carries no migration but rewrites the file readers (§3.0).

Binding rules of the house that every package meets (named once, not repeated per section): a refusal keeps
what was typed (#171); every door before any spend; nothing pooled inside a transaction (`tx-pool`); a column
the old schema lacks is read and written SQL-only (#472); four staff locales (ru default, uz, zh-CN, en) and
three customer locales (uz, ru, en) — a missing key throws at render; red proofs by reversible string edit
after a WIP commit; no model identifier in any pushed text (the constants `ANALYST_MODEL` / `STAFF_MODEL` only).

---

## §1 Kernel K — the migration, the settings, the pressed-AI ledger (lead, before the packages)

### 1.1 Migration 0144 `tarkib_takliflar` (additive; every existing row satisfies every new CHECK)

```sql
-- (a) T2: what the CLIENT answered about a lot, and what they were shown when they answered.
CREATE TABLE "lot_client_confirms" (
  "lot_id"           uuid PRIMARY KEY REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "verdict"          text NOT NULL,
  "shown_zh"         text NOT NULL,
  "shown_ru"         text,
  "shown_count"      integer NOT NULL,
  "shown_client_id"  uuid NOT NULL,          -- loose, like lot_checks.seen_client_id
  "shown_tarkib_rev" bigint,                 -- the tarkib's rev token the ask was drawn from; NULL = none stood
  "chat_id"          bigint NOT NULL,        -- which Telegram chat pressed
  "asked_by"         uuid,                   -- loose: who pressed «Mijozdan so'rash»; NULL = the receipt push asked
  "answered_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lot_client_confirms_verdict_check" CHECK ("verdict" IN ('yes', 'no')),
  CONSTRAINT "lot_client_confirms_count_check"   CHECK ("shown_count" > 0),
  CONSTRAINT "lot_client_confirms_ru_check"      CHECK ("shown_ru" IS NULL OR "shown_ru" <> '')
);
-- (b) T2: who asked — SQL-ONLY (never declared on the drizzle `clientNotices`: `claimReceivedNotice` inserts
--     through drizzle INSIDE confirmReceipt's transaction, and a declared column is a 42703 that would refuse
--     every prixod on a server one migration behind).
ALTER TABLE "client_notices" ADD COLUMN "asked_by" uuid;
-- (c) T1 + T3: a pressed model call is a row of the one AI ledger. All three columns SQL-ONLY on the drizzle
--     `aiCalcPasses` (`recordAiPass` inserts through drizzle and swallows its own failure — a declared column
--     would silently lose every calc bill of a half-applied deploy).
ALTER TABLE "ai_calc_passes" ADD COLUMN "lot_id" uuid;     -- loose: a ledger never shrinks by a cascade
ALTER TABLE "ai_calc_passes" ADD COLUMN "batch_id" uuid;   -- loose: which truck's Bojxona tab (T3); NULL for T1
ALTER TABLE "ai_calc_passes" ADD COLUMN "outcome" text;    -- NULL = every row before this (written after an answer)
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_outcome_check"
  CHECK ("outcome" IS NULL OR "outcome" IN ('reserved', 'ok', 'failed', 'no_answer'));
-- kind CHECK re-made + 'tnved', 'tarkib'; anchor CHECK re-made:
--   WHEN 'similar' THEN request_id IS NULL AND intake_note_id IS NULL
--   WHEN 'intake'  THEN request_id IS NOT NULL OR intake_note_id IS NOT NULL
--   WHEN 'tnved'   THEN lot_id IS NOT NULL AND request_id IS NULL AND intake_note_id IS NULL
--   WHEN 'tarkib'  THEN lot_id IS NOT NULL AND request_id IS NULL AND intake_note_id IS NULL
--   ELSE request_id IS NOT NULL AND intake_note_id IS NULL
```

`gsr_ai_reader` is granted nothing new (0080 is default-deny). The `'tnved'` arm and `lot_id` are the names the
other session's unbuilt handoff `docs/SAKKIZ-R5.md` plans for itself (its §8.2, its migration lines) — written
here first, so R5 re-fits by DELETING its `ADD COLUMN "lot_id"` and its kind/anchor lines, not by renaming. Said
in CLAUDE.md for whoever builds R5.

Drizzle (`schema/wms.ts`): `lotClientConfirms` declared in full (a new table has no «one migration behind»
reader that is not already guarded by the probe, §4.3); the two `ai_calc_passes` CHECK mirrors updated; the three
ledger columns and `client_notices.asked_by` NOT declared (fenced: `tests/unit/takliflar-sql-only.test.ts`
reads the two table bodies).

### 1.2 Settings (each with `settings.descriptions.<key>` ×4 — `locales.test.ts` is red otherwise)

| Key | Default | Meaning |
|---|---|---|
| `tnved_ai_daily_limit` | 300 | Bojxona 🤖: answered presses per Tashkent day, company-wide. **0 = switched off.** |
| `tarkib_ai_daily_limit` | 50 | «📄 Fayldan to'ldirish»'s model readings per day. **0 = AI reading off** (a spreadsheet is still read — it needs no model). |
| `client_confirm_on_receipt` | true | T2's kill switch: the ✅/❌ row under «yukingiz qabul qilindi». Off = the push goes out as before. |

Both limits are read through ONE sanitiser (`limitOf(raw, fallback)`): finite and ≥ 0 → `Math.floor`; anything
else → the DEFAULT. A cap on a bill never fails open (`ai_calc_daily_limit`'s «0 = no cap» is not copied; the
description says «0 — o'chirilgan»).

### 1.3 The pressed-AI ledger — `src/modules/wms/calc/ai-press.ts` (new; `ai-cost.ts` stays the calc budget's)

One home for «a person pressed an AI button that belongs to no calc request». Raw SQL throughout (the columns
are SQL-only).

| Export | Shape | Rule |
|---|---|---|
| `type PressKind = 'tnved' \| 'tarkib'` | | |
| `pressLimit(kind)` | `Promise<number>` | pooled `getSetting`, sanitised (§1.2) |
| `PRESS_COUNTED(kind)` | SQL fragment | `kind = <kind> AND outcome IS DISTINCT FROM 'no_answer' AND created_at >= <Tashkent midnight>` — ONE fragment for the cap and for the number shown |
| `reservePress({ kind, staffId, lotId, batchId })` | `{ ok: true; id } \| { ok: false; error: 'ai_limit' \| 'server_behind' }` | limit read on the pool FIRST; then one transaction: `SELECT pg_advisory_xact_lock(hashtext('ai-press:' \|\| kind))` as its OWN statement (folded into the INSERT it granted 10 of 10 against a limit of 3 — `assistant.ts`'s measured lesson), then `INSERT … SELECT … WHERE (count over PRESS_COUNTED) < limit RETURNING id` with `outcome = 'reserved'`, `model = ANALYST_MODEL`. No row → `ai_limit`. `isServerBehind(err)` or a 23514 naming `ai_calc_passes_kind_check` / `ai_calc_passes_anchor_check` → `server_behind` (fails CLOSED: no count, no spend). Never throws. |
| `settlePress(id, { outcome: 'ok' \| 'failed' \| 'no_answer', usage? })` | `Promise<void>`, never throws | `UPDATE … SET outcome, model, input_tokens, output_tokens WHERE id = … AND outcome = 'reserved'` |
| `pressToday(kind, sight)` | `{ used, limit, usd: number \| null, usd30: number \| null }` | `used` over `PRESS_COUNTED`; dollars ONLY with a `CompanyMoneySight` (branded, REQUIRED argument — `null` for everyone else): Σ tokens per model × `MODEL_USD_PER_MTOK`, today and the last 30 days; `null` when a model has no price (never a guess) |

Outcomes: `ok` = usable answer; `failed` = the model ANSWERED and the answer was no good (refusal, cut, invalid
code, unreadable) — billed with its tokens and COUNTED; `no_answer` = no usage came back (timeout, network,
4xx/5xx) — recorded, NOT counted (a dead key must not spend the day); a row left `reserved` by a killed process
stays counted (a crash still spends a slot).

`aiCalcBudgetLeft('calc')` in `ai-cost.ts` stops meaning «everything but similar»: its predicate becomes the
positive list `kind IN ('intake','grouping','pick','invoice')`, and the two tests that restate it
(`ai-cost.integration.test.ts`) follow — otherwise every 🤖 press would spend the VED's Telegram estimates.
`AiPassKind` gains the two names for the record.

Prices: `MODEL_USD_PER_MTOK` beside the model constants in `platform/ai/model.ts`, keyed BY THE CONSTANTS (no
new model id literal in source); values are the provider's LIST prices per million tokens, looked up from the
API reference at build time and dated in the comment; `approxUsd(rows)` is pure, in integer micro-dollars.
List prices of answered calls only — hence «≈» on every screen.

---

## §2 T3 — the Bojxona 🤖: counted before, billed after, capped per day

His words: «Bojxonadagi 🤖 ga xarajat hisobi va kunlik limit qo'yilsin.» Today `suggestTnved` logs its usage
and throws it away; one press of «🤖 AI taklif (N)» is up to N sequential calls with no ceiling.

2.1 `suggestTnved` returns `TnvedSuggestion & { usage?: AiUsage }` and every post-answer `TnvedError('ai_failed',
usage)` carries it (`proposeGoodsGrouping`'s own shape). The log line and the four pinned strings stay.

2.2 Both actions (`suggestTnvedForLotAction`, `suggestTnvedForLineAction`), AFTER the last door and BEFORE the
photograph is read:

```
if (!aiConfigured()) return { ok: false, error: 'ai_not_configured' };     // a keyless server writes no row
const pass = await reservePress({ kind: 'tnved', staffId: actor.id, lotId, batchId });
if (!pass.ok) return { ok: false, error: pass.error, today };              // 'ai_limit' | 'server_behind'
… firstLotPhoto … suggestTnved({ …
   success                         → settlePress(pass.id, { outcome: 'ok', usage })
   TnvedError WITH usage           → 'failed'
   TnvedError without / any throw  → 'no_answer'     (a flag + finally: a throw from the photo read settles too)
```

The literal `suggestTnved({` and `firstLotPhoto(lotId)` stay inside each exported action (`batch-door-wire`
finds them by position); the ledger is written only through the two helpers; `usage` is stripped before the
suggestion goes to the browser. Both results gain `today?: { used, limit, usd, usd30 }`.

2.3 The screen (`tnved-editor.tsx`): `askError` gains `case 'ai_limit'` → `t('aiLimit')` (without it the default
prints «AI javob berolmadi — keyinroq urinib ko'ring», which invites pressing again); `walkStep` already answers
`stop` for an unknown code — pinned for `ai_limit`. A line beside the buttons, `data-testid="tnved-ai-today"`:
everyone behind the tab's door reads «Bugun AI: {used} / {limit}»; a reader with `companyMoneySight` also reads
«≈ ${usd} · 30 kun ≈ ${usd30}». Fed by a page prop (read in try/catch — no line when unreadable; the tab still
renders one migration behind) and replaced by each action's `today`.

2.4 Stated, not built: the deal goods import's grouping and the card chat's reading stay unbilled (other doors);
no per-press ceiling on «AI taklif (N)» (the daily limit is the ceiling); the cap is the COMPANY's day, so one
long walk can end everybody's 🤖 until midnight — the refusal says who to ask.

Tests: `batch-door-wire` (order of `aiConfigured()`, `reservePress(`, `firstLotPhoto`, `settlePress(` in both
actions; the `ai_limit` case), `tnved-editor-state` (`ai_limit` → stop), `tnved-question` (every post-answer
throw carries usage), `batch-door.integration` + `tnved-line-ai.integration` (a refused door writes NO row; an
answered press writes exactly one `tnved` row; a thrown-without-usage press is `no_answer` and not counted; the
cap refuses with the model never asked and the photo unread), NEW `ai-press.integration` (the burst: N parallel
reservations against limit k grant exactly k; `no_answer` frees its slot, `reserved` does not; Tashkent day by
the function's own predicate; `server_behind` by constraint name), `ai-cost.integration` (a `tnved` row moves
neither the calc nor the similar budget), `price-icons-matrix.integration` (the anchor matrix for both new
kinds), NEW unit (the price map covers both constants; `approxUsd`; the limit sanitiser; the lock is its own
statement; the SQL-only fence).

---

## §3 T1 — «📄 Fayldan to'ldirish»: the tarkib editor's DRAFT from the client's packing list

His words: «Tarkibni mijozning packing-list fayli yoki rasmidan AI o'qib to'ldirsin — 10–20 qatorni qo'lda
yozmaslik uchun.»

### 3.0 What it must never be

A writer. It fills the editor's three pieces of client state (`mode`, `lines`, `doc`) and stops. «Saqlash» stays
the person's press and still runs `parseDraft` + `checkSums` + the action. No `saveComposition`, no TNVED
memory, no `editLot`, no audit row, no automatic scaling or balancing, no invented number (a figure the file
lacks is an EMPTY cell, never `0`, never a share of the lot's total).

And it touches NO fenced reader file (`goods-import.ts`, `goods-file.ts`, `xls.ts`, `intake*.ts`, `units.ts`,
`calc-intake.ts`): the other session's PR #141 rewrites them. T1 imports their exported API only, through ONE
adapter file, so the merge that follows has one place to look.

### 3.1 The press

In the editor's document block, beside «📎 Hujjat yuklash»: **«📄 Fayldan to'ldirish»**
(`data-testid="tarkib-read"`), enabled when a document chip is CHOSEN (`doc !== null && docs.some(…)`), no
upload in flight and no save pending. The file read IS the file the tarkib will cite — no second upload. A
photographed packing list is uploaded by the editor's own 📎 with document-grade compression
(`uploadAttachmentFile(file, 'receipt', receiptId, { maxSizeMB: 1, maxWidthOrHeight: 2000 })` — the default
0.3 MB crushes small print; the other callers keep the default).

Press → `POST /api/tarkib/read` (`{ lotId, attachmentId }`, JSON — ids only, the bytes are read from storage
on the server; a route handler and not an action: a model reading may take a minute and a page's actions queue
behind each other). The button shows «O'qilmoqda…» and is disabled; the editor stays usable.

### 3.2 The route — every door before any spend

1. `requireActor()` → 401.
2. `compositionDoor(actor, lotId, { requireConfirmed: true })` → `forbidden` / `receipt_not_confirmed`.
3. The attachment row: `entity_type = 'receipt'` AND `entity_id = lot.receiptId` (the LOT's prixod, never a
   posted one) → else `document_not_on_receipt`; `isPaperDocument` → else `document_is_photo`.
4. Bytes: `readWithin(getStorage().get(key), 15 s)`; over 25 MB or unreadable → `file_unavailable`.
5. Kind by CONTENT (`intakeFileKind`, the bot's own sniffer): `sheet` · `pdf` · `image` / `isomedia` ·
   `docx` → `word_file` · `video` / `archive` → `unsupported_type`.
6. **sheet** → `readGoodsFile` (no model). `refused` → `sheet_old_format | sheet_encrypted | sheet_broken |
   sheet_empty`; `null` → `unsupported_type`; `text` (no header the reader knows) → the model reads the sheet's
   text (step 7) when AI is available, else `sheet_no_header`.
7. **pdf / image / header-less sheet** → `aiConfigured()` else `ai_not_configured`; a PDF over 10 MB →
   `pdf_too_large`; an image through `sheetPhoto(bytes, 1568)` (a HEIC throws → `photo_unreadable`; over
   4.5 MB after reduction → `photo_unreadable`); `reservePress({ kind: 'tarkib', … })` → `ai_limit`; the
   reading (§3.4); `settlePress`.
8. Answer `200 { ok: true, proposal }` or `200 { ok: false, error }`, `Cache-Control: private, no-store`;
   a thrown error is `failed`, never a white page. Nothing is written but the ledger row.

### 3.3 The sheet path — exact figures, the file's own words

`src/modules/wms/receipts/tarkib-sheet.ts` (the ONE adapter over the readers):

- `readGoodsFile(body, mime)` → `goods` → per row `normalizeRowUnit`: pieces (a piece word or none), cartons
  (a carton word in the count column), kg / m³ («500 кг» typed in the count column lands in kg), the
  supplier's own TNVED column; what did not land in a tarkib column is a per-row NOTE («sotuvchi: 120 пар»,
  «soni «12,500PCS» — aniq emas»).
- **Cartons and GROSS per row** — the commonest packing list has BOTH a piece column and a carton column, and
  `GoodsRow` carries no carton field (and the line weight is the NET one). For an XLSX (`PK`) the adapter reads
  the chosen sheet again (`workbookSheets` → the sheet named `read.sheet`), asks `detectColumns` for the header
  row and the name / gross columns, finds the carton column by its header's words (a small list:
  «箱数», «件数» only when another count column took the pieces, «CTNS», «Cartons», «Packages», «Pkgs», «Мест»,
  «Кол-во мест», «Коробок», never a per-package header), and walks the rows IN ORDER matching each goods row
  by its name cell (strict equality with the reader's own `description`). A row it cannot match ends the
  recovery — the rest keep empty cartons, said in a note; nothing is ever assigned by position. A cell under
  a vertical merge counts once, on its master row. Other formats (.xls, HTML, XML, CSV) get no recovery.
- kg for the draft = the row's GROSS when the sheet states one per row, else the reader's line weight; the
  proposal says which (`weightKind: 'gross' | 'net' | 'plain' | null`) — the lot's stored kg is what the
  warehouse WEIGHED, so gross is the closer figure.
- Numbers → the cells' spelling: pieces / cartons as plain digits of a positive whole number (a fraction is
  dropped to a note, never rounded); kg `fromUnits(…, 3)`, m³ `fromUnits(…, 4)` — a figure with more decimals
  than the column is rounded half-up to the column and the note says so.
- **Names**: the file's own words. When a name has no Cyrillic letter and AI is available (key, budget), ONE
  model call translates the names into short Russian customs wording (`translateNames`, the same ledger kind,
  one pass); it fails soft — the names stay as the file wrote them and the proposal says «Nomlar tarjima
  qilinmadi». A row keeps `nameOriginal` so the dialog shows both.
- `read.goods.length >= MAX_GOODS_ROWS` → the proposal says the file may hold more.

### 3.4 The model path — its own small reader (`src/modules/wms/receipts/tarkib-read-ai.ts`)

NOT `analyzeIntake`: that reader is the bot's, is being rewritten by PR #141, and has no carton field. One
call, the house pattern: `new Anthropic({ timeout, maxRetries: 0 })`, `ANALYST_MODEL`, structured output
(`output_config.format` json_schema, every field required, `additionalProperties: false`), `stop_reason`
checked (`refusal`, `max_tokens` named), zod on the parsed text, usage returned BESIDE the answer and on every
post-answer failure. Leash 90 s (a person is waiting). Input: a `document` block (PDF, base64) or an `image`
block (JPEG) or the sheet text, then ONE text block.

Schema: `rows[{ name_ru, name_original, pieces, cartons, gross_kg, net_kg, volume_m3, hs_code }]`,
`totals{ cartons, gross_kg, net_kg, volume_m3 }` (each nullable — what the paper's own TOTAL row prints),
`notes[]` (≤ 5 short strings). The prompt, in Russian like the house's other readers: transcribe the goods
table of a packing list or invoice; a number is what the paper prints — never computed, never multiplied
(one carton's CBM is NOT the line's volume → null); pieces are PIECES, cartons are packages; `hs_code` only
when the paper itself prints one for that line — never a guess (the Bojxona 🤖 is the place for a guess);
`name_ru` = the good in short Russian customs wording, `name_original` as written; at most 60 rows; nothing
invented.

Mapping: name = `name_ru` (else the original), kg = gross else net (said), cartons, pieces, m³, tnved =
`hs_code` when 4-10 digits. **The misread detector**: when the paper prints totals, Σ rows is compared with
them per measure — a difference is a WARNING on the proposal («Qatorlar yig'indisi hujjatdagi jamiga teng
emas: kg 1 240 ≠ 1 420»). A model reads digits; this is the one cheap check that it read them all.

Failures → codes with words: `ai_refused`, `ai_truncated` («hujjat juda katta — kamroq sahifa yoki Excel»),
`ai_timeout`, `ai_busy` (rate limit / overload — «bir daqiqadan keyin»), `ai_auth`, `ai_rejected`,
`ai_unreadable`, `ai_network`, `ai_no_goods` (the model answered and found no goods table).

### 3.5 The proposal and the dialog

```ts
interface TarkibProposal {
  via: 'sheet' | 'ai';
  rows: { name: string; nameOriginal: string | null; pieces: string; cartons: string; kg: string; m3: string;
          tnved: string; notes: string[] }[];           // cells in the editor's own spelling, '' = unknown
  weightKind: 'gross' | 'net' | 'plain' | null;
  fileTotals: { cartons: string | null; kg: string | null; m3: string | null } | null;   // the paper's own
  warnings: { code: string; text?: string }[];           // totals mismatch, cut list, untranslated names, …
  translated: boolean;                                    // names were put into Russian by the model
}
```

The dialog (`Overlay`, kept MOUNTED and toggled — it closes itself otherwise), `data-testid="tarkib-read-dialog"`:

- a row per good with a checkbox (`tarkib-read-row`), the name (Russian, the original small beneath when
  different), and one line of figures «500 dona · 50 karobka · 600 kg · 1.5 m³ · 8471…»; a row's notes in warn
  colour;
- **all rows ticked** to begin with; when the prixod has more than one lot, a sentence above the list:
  «Bu prixodda {n} ta lot bor — faqat SHU lotdagi tovarlarni belgilab qoldiring» (a packing list covers the
  shipment, a tarkib is one lot's);
- a live line under the list: Σ of the TICKED rows against the lot — «kg: 1 000 ✓ · m³: +0.2 ortiqcha ·
  karobka: 5 qoldi» (the editor's own `remainderOf` and words) — so the right selection is visible before it
  is applied;
- for `via: 'ai'` a standing sentence: «AI o'qidi — har bir raqamni hujjat bilan solishtiring»; every warning;
- **«Tarkibga qo'yish ({n})»** (`tarkib-read-apply`): refused in words above 20 ticked rows («Tarkibga 20
  tagacha tovar sig'adi») and with none; two ticked rows of one name are ADDED together and said («2 ta bir
  xil nomli qator qo'shildi: …» — a figure missing on either leaves that sum empty); when the editor holds
  any non-blank row, `window.confirm` first («Mavjud qatorlar almashtiriladi»).

Apply: `setLines(rows)`, `setMode('separate' only when EVERY applied row has cartons and the lot has more than
one carton, else 'mixed')`, `setRefusal(null)`; `doc` is already the chosen chip. Then the editor's own sticky
remainder, «Sklad o'lchoviga moslashtirish», «Karobka soniga qarab taqsimlash» and «=» appear by themselves —
they are derived from the rows. A late answer is dropped: each press takes a token, and an answer whose token
is not the newest (or whose editor was remounted) applies nothing.

### 3.6 Refusal words

One literal map in the dialog/editor (`useRefusalText` gains a `case` per new code; its `default` says «Ma'lumot
to'liq emas», which would be wrong for every one of these). i18n namespace `tarkib` (`read.*`, ×4).

### 3.7 Tests

- unit `tarkib-sheet.test.ts`: real workbooks built with exceljs (Chinese, Russian and English headers;
  pieces + cartons + net + gross; a carton-only count column; a merged carton cell; a total row; 600 rows;
  a fractional carton; a 5-decimal weight) → exact proposal rows; the recovery stops, never mis-assigns
  (a fixture whose name cell is a number); a PDF handed to it is refused, not read as CSV garbage.
- unit `tarkib-read-ai.test.ts`: against a stand-in Messages server (the `intake-answered` shape): the request
  carries a document / image block and the schema; a good answer maps; refusal / cut / unparseable / timeout /
  429 / 401 each give their code AND their usage rule; the totals mismatch warning; `hs_code` garbage dropped.
- integration `tarkib-read.integration.test.ts` (the route's `POST` called directly, storage holding real
  bytes): every door in order, each refusing with NO ledger row and the model stand-in never asked; a sheet
  read writes no row at all; a PDF read writes exactly one `tarkib` row (`ok`, tokens); the daily limit;
  `server_behind`; nothing in `lot_compositions`, `tnved_assignments`, `audit_log` moves.
- unit, source-shape: the adapter is the only importer of the reader modules among T1's files; the route
  contains no `saveComposition` / `saveTnved` / `writeAudit`; `photo-inputs` and `lot-composition-fence`
  (`ALLOWED` gains the new files) stay green.
- e2e `m9zzx` (no key in CI): upload an XLSX built in the spec → «📄 Fayldan to'ldirish» → the dialog lists
  the rows → untick one → the live remainder moves → apply → the editor's rows hold the figures, nothing is
  saved (the face is unchanged after a reload); a PDF → the honest «AI ulanmagan» sentence; 360 px geometry
  (document = viewport, the apply button inside the screen).

---

## §4 T2 — the client's own ✅/❌ in Telegram

His words: «Tarkibni mijozning o'zi Telegram'da tasdiqlasin (✅/❌) — ilgari kelishilgan, hali qilinmagan band.»
Agreed earlier (`docs/YUK-TEKSHIRUV.md`, his 5b): buttons on the client's «yukingiz qabul qilindi». That is
T2a. It cannot confirm a TARKIB — a tarkib is written days later — so T2b adds the same question on a person's
press, with the lot's goods listed.

### 4.1 One fact, two moments

**The fact** — per lot, in `lot_client_confirms` (0144): the client's latest ANSWER (`yes` / `no`) and what
they were SHOWN when they gave it (both name spellings, the carton count, the owner, the tarkib's rev). Like
the staff tick, it is a snapshot that every reader COMPARES — nothing clears it on a write.

It is NOT a `lot_checks` row: that table is «a colleague vouched» (its `checked_by` stays NOT NULL, its writer
and its fences are untouched), and the two facts can stand together — «✅ Sardor · 11.11» and «✅ Mijozning
o'zi (Telegram) · 12.11».

**T2a — on «📥 Yukingiz omborimizga qabul qilindi» (C1)**, automatically: a third keyboard row
`[✅ To'g'ri] [❌ Xato bor]` and one short question line, when at SEND time all of these hold: the setting
`client_confirm_on_receipt` is on; the receipt has at most `PUSH_LOT_LINES` (12) lots (every lot is printed);
at least one lot is askable (a live carton still in China, `lotAskableSql`) and not ✅ (state `none` or
`stale`). Rows 0 (Mini App) and 1 (`mg`) stay where the tests pin them.

**T2b — «📨 Mijozdan so'rash»** on the prixod card (the lot-check panel's prixod-level row; door = `mayCheckLot`
+ the card's read door; a confirmed prixod with a client): a NEW message to the client's chats — kind
`lot_ask`, ref the receipt — that lists every lot and, where a tarkib is written, its goods with their pieces:

```
📋 Yuk ma'lumotini tasdiqlang
GS777 · Yiwu · 12.11.2026

📦 A — 100 quti
   • Клавиатура — 500 dona
   • Мышь — 1 000 dona
📦 B · Чехол — 20 quti

Hammasi to'g'rimi?
Qabul raqami: YW-000123
[🚚 Yuklarimni ochish]  [💬 Menejer]  [✅ To'g'ri] [❌ Xato bor]
```

No photograph (the caption limit would cost the list). Refused to the PRESSER in words: `no_chat` («Mijozning
Telegrami ulanmagan» — the phones are on the panel), `already_queued`, `too_soon` (sent less than 10 minutes
ago), `too_long` (the text would pass 3 500 characters or 30 lots — «ro'yxat Telegram'ga sig'maydi»),
`receipt_not_confirmed`, `no_client`, `forbidden`. The claim re-arms the one `client_notices` row of
(client, `lot_ask`, receipt) — `status = 'pending'`, `send_after = now()`, `attempts = 0`, `asked_by` — and
kicks the sweep; an audit row on the prixod says who asked. The card shows the last ask («📨 So'rov
yuborildi · 12.11 14:05» / «navbatda» / «yetib bormadi: …»).

### 4.2 The tag — «a client cannot confirm what they were not shown»

`clientAskFacts(receiptId)` (`src/modules/wms/receipts/client-confirm.ts`, the ONE reader for both messages and
for the press): the receipt (client, status, number, warehouse), every lot by letter then seq — id, letter,
stored zh, SHOWN ru (`NULLIF(lotRuShownSql, '')`), box count, the tarkib's rev or null, and its goods
(name + pieces) — and

```
tag = first 8 hex of sha256( JSON.stringify([clientId, lots.map(l => [l.id, l.zh, l.ru ?? '', l.count, l.rev ?? 0])]) )
```

Both messages carry `yt:<1|0>:<receiptId>:<tag>` (50 bytes; Telegram's limit is 64, and a refused button drops
the WHOLE keyboard). Because the tag is the facts and not the message, a ✅ on an old C1 and on a fresh ask
are the same answer while nothing changed — and a tarkib written after C1 makes C1's buttons stale, which is
what forces the tarkib itself to be shown before it is confirmed.

### 4.3 The sentence (`lot-check-sql.ts`) — one more source, and a veto

A third join, at most one row per lot, fixed alias (`LOT_CLIENT`, as `LOT_TARKIB` is): `withLotCheckJoins`
adds it for every list reader and `lotCheckViewsFor` adds it to its own statement — no call site changes.
`lotTarkibJoinSql` also selects the composition's `rev`.

```
clientHolds  = lot_client.lot_id IS NOT NULL
               AND shown_zh = lot.product_name_zh
               AND shown_ru IS NOT DISTINCT FROM NULLIF(<shown ru>, '')
               AND shown_count = lot.box_count
               AND shown_client_id IS NOT DISTINCT FROM receipt.client_id
clientSaysNo = clientHolds AND verdict = 'no' AND shown_tarkib_rev IS NOT DISTINCT FROM lot_tarkib.rev

CASE
  WHEN clientSaysNo                                   THEN 'none'       -- the veto: ❓, on the worklist
  WHEN <tarkib stands>                                THEN 'checked'
  WHEN receipt.client_id IS NULL                      THEN 'unclaimed'
  WHEN <staff row holds>                              THEN 'checked'
  WHEN clientHolds AND verdict = 'yes'                THEN 'checked'
  WHEN check.lot_id IS NOT NULL OR lot_tarkib.lot_id IS NOT NULL
       OR (lot_client.lot_id IS NOT NULL AND verdict = 'yes') THEN 'stale'
  ELSE 'none'
END
```

- A client's ✅ about what the lists still show makes the lot ✅ — the logist's phone call is not needed.
- A client's ❌ about what the lists still show takes the ✅ away — even a colleague's tick, even a standing
  tarkib — until one of three things happens: the data is corrected (the snapshot no longer matches; a tarkib
  re-saved has a new rev), the client answers again, or a person with the lot-check door presses **«E'tirozni
  yopish»** on the card (the `no` row is deleted, with an audit row and an optional note). No new state: the
  lot reads ❓ and stands on the worklist, where a disputed lot belongs.
- kg / m³ are not compared, as on the staff tick.

`lotChecksReady()` also probes `lot_client_confirms`: on a server whose 0144 did not land, every reader runs
its pre-0123 shape (no chip, no crash) until it does — the #472 rule the round before it set.

### 4.4 The press (`registerClientCabinet`, one `bot.callbackQuery(/^yt:([01]):([0-9a-f-]{36}):([0-9a-f]{8})$/)`)

Placed with the other three customer callbacks, before the relay's `bot.on('message:text')`. `parseCallback`
(the staff parser) answers null for it — pinned. The handler asks ONE wms function by dynamic import
(`answerClientAsk({ chatId, receiptId, verdict, tag })`), which:

1. `clientsForChat(chatId)` — nobody linked → neutral.
2. the receipt: exists, `confirmed`, not voided, `client_id` ∈ the chat's clients → else `stale`.
3. `clientAskFacts(receiptId)`; `tag` differs → `stale`.
4. every lot already holds THIS verdict for these facts → `already`.
5. ONE small transaction: the upsert of every lot's row (written from the facts just read — no lot or prixod
   lock is needed, because a row that raced a rename simply does not match and reads stale), and one audit
   row on the prixod (actor null, per-lot keys `clientConfirm:<letter>`, the value saying «Telegram» and the
   verdict). `asked_by` is copied from the newest `lot_ask` notice of this receipt, if any.
6. after the commit: ❌ → `notifyStaffTelegramOnce` (key = the press) to the client's seller ∪
   `usersWithPermission('plans.manage')` ∪ the asker — type `ClientLotDisputed` (`MUTE_GROUPS.alerts`):
   which client, which prixod, which lots, the card link last. ✅ → only the asker of a T2b ask is told —
   `ClientLotConfirmed` (`operations`). A ✅ on the automatic C1 tells nobody: the ❓ list shrinking is the news.

What the customer reads (their chat's language): ✅ → a toast «Rahmat — tasdiqlandi ✅»; ❌ → no toast, and a
message «Tushunarli. Nima noto'g'ri ekanini shu yerga yozing yoki rasm yuboring — menejeringizga yetkazamiz»
(the existing relay carries whatever they send next); `stale` → toast «Bu xabar eskirgan — ma'lumot
yangilangan»; `already` → toast «Javobingiz allaqachon qabul qilingan». In every case the pressed message's
✅/❌ row is removed (`editMarkup` with the remaining rows of the pressed message — the Mini App and `mg`
rows stay); copies in the client's other chats keep their buttons and answer `already` or `stale`.

The handler holds no lock and calls no model; a late or redelivered press is a no-op by step 4.

### 4.5 The card

Per lot, in the lot-check panel: «✅ Mijozning o'zi tasdiqladi (Telegram) · 12.11» (+ «— tarkib keyin
o'zgartirilgan» when the rev moved); «Mijoz tasdig'i eskirgan — ma'lumot o'zgargan»; **«❌ Mijoz: ma'lumot
noto'g'ri (Telegram) · 12.11»** in bad colour with «E'tirozni yopish» for a writer; «Mijoz e'tirozidan keyin
ma'lumot o'zgartirilgan — qayta so'rang». Per prixod: «📨 Mijozdan so'rash» and the last ask's line.
i18n namespace `lotCheck` (×4). Audit labels `audit.fields.clientConfirm`, `clientAsk`, `clientDispute` (×4).

### 4.6 Customer words (uz / ru / en — `client-labels.ts`, compile-checked)

`confirmAskTitle`, `confirmAskLine`, `confirmYes`, `confirmNo`, `confirmThanks`, `confirmTellUs`,
`confirmStale`, `confirmAlready`, `pieces` (the «dona» of a goods line).

### 4.7 Stated, not built

- A client with no linked Telegram gets no C1 at all, so no question either — the logist's phone stays the way.
- A receipt with more than 12 lots carries no buttons on C1 (the message does not print them all); «Mijozdan
  so'rash» lists up to 30.
- Copies of a message in the client's other chats keep their buttons (no message id is stored for a push).
- The Mini App shows nothing of this (a later round, if he wants the answer there too).
- Not verifiable here: a real Telegram press. The whole chain runs under `botHarness` and the recorded Bot API.

### 4.8 Tests

- integration `client-confirm.integration.test.ts`: facts + tag (stable; moves on rename / count / client /
  tarkib save); ✅ → every reader says `checked` (the sentence through `lotCheckViewsFor`, `/stock`'s reader,
  the worklist count); ❌ vetoes a holding staff row and a standing tarkib; each of the three ways out;
  `already`; `stale`; a receipt moved to another client; an unlinked chat; the ask claim (door, `no_chat`,
  cooldown, re-arm, `asked_by`); the dismissal; one migration behind (the probe off → readers' old shape).
- integration `client-push.integration.test.ts` (extended): C1's keyboard row 2 and the question line appear
  exactly when the rule says (askable + unconfirmed; setting off; 13 lots; all ✅ already); rows 0-1 unmoved;
  the `lot_ask` message's text in three locales and its keyboard; one message per chat.
- integration `bot-redelivery`-style through `botHarness`: ✅, ❌ (the relay sentence, the staff alert once),
  a late press, a redelivered press, a press from a chat that lost its link, the keyboard edit keeping rows 0-1.
- unit: the callback grammar (regex, ≤ 64 bytes, `parseCallback` null, a DERIVED fence — every customer
  `callback_data` built in `menu-button.ts` / `client-cabinet.ts` / `wms/notices/**` / `client-confirm*.ts`
  is matched by a `bot.callbackQuery(` pattern), the pure texts, the mutes (both new types in a group, neither
  in `FOUNDERS`), `lot-check-wire` (the new table has ONE writer; `shown_*` names only in it, the sentence and
  the schema), `cabinet-bot-wiring` (order; `answerPress` first).
- e2e `m9zzy` (extended): the card's ask button (a client without Telegram → the honest sentence), a client
  row written by SQL → the ✅ line and the stock chip; a `no` row → the dispute line, ❓ in /stock, «E'tirozni
  yopish» → ✅ back; cleanup as the final test.

---

## §5 Questions to him (⭐ = built if unanswered)

Sent with the round's report, in Uzbek, numbered — see CHANGELOG. In short:

1. T1 names: ⭐ a) AI translates non-Russian names (a few cents a file) · b) names stay as the file wrote them.
2. T1 weight: ⭐ a) brutto where the file has it per row, else netto · b) always netto.
3. T1 limit: ⭐ 50 readings a day · another number.
4. T2 on C1: ⭐ a) buttons on every «qabul qilindi» whose cargo is in China and unconfirmed · b) only on a
   person's press.
5. T2 ❌: ⭐ a) takes the ✅ away until fixed, re-asked or closed by a person · b) alert only.
6. T2 who hears ❌: ⭐ a) the seller + logists + the asker · b) the seller only · c) + VED.
7. T3 limit: ⭐ 300 a day · another number.
8. T3 dollars: ⭐ a) shown to money readers on the Bojxona tab · b) also one line in the 20:00 summary.

---

## §6 Packages

- **K** (lead): §1 whole + §2 (T3 is small and sits on the kernel) + T2's core — the table's writer and
  readers, the sentence, `lotCheckViewsFor`, the probe (§4.2-§4.3) with its integration test.
- **P1** (worktree): T1 whole (§3).
- **P2** (worktree): T2's Telegram half — the C1 row and line, the `lot_ask` kind (claim's send half, preparer,
  text), the press handler, customer words, the bot-harness and client-push tests (§4.1 send half, §4.4, §4.6).
- **P3** (lead, while the packages build): T2's card half — the panel's lines, «Mijozdan so'rash» (the claim's
  door half), «E'tirozni yopish», the staff notifications and mutes, staff i18n, e2e (§4.1 claim, §4.5).

Each package: its own test files (new ones wherever possible), `flock /tmp/gsr-heavy.lock` around typecheck and
build, its own database, WIP commits before every red proof, a final report that carries `completed: true`.
Merge by cherry-pick; then a review of the merged tree; then the full CI order on a fresh `gsr_ci`.
