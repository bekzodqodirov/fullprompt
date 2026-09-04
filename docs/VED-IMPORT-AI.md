# VED 2.0 — bojxona IMPORT bazasi + AI VED hodimi

**The agreed spec, NOT yet built.** Agreed 2026-09-04 in chat, immediately
after the phase-4 deploy (his server ledger = 94). The owner's answers are
FIXED product decisions — do not re-ask them. Build in TWO sub-rounds (A then
B below). This file is written for the session that builds it: every measured
fact, every trap, and every decision is here so nothing has to be
re-discovered.

## 0. The owner's request, verbatim

> «tamojenniydan men har 3 oyda 1 marta baza olaman ushani bersam baza
> shakillantirib berolasanmi u bazada 1 tnved kodda 100lab turli hil narx
> bolishi mumkun, qaysi narx(baz) ni olishni tovar nomi shu bizda
> hisoblatishga berilgan tovar nomi bilan qanchalik togriligiga qarab olamiz
> agar togri bolmasa baza yoq deb ved hodimi ozi qoyadi. donada hisoblanadgan
> tovarlarda har bir tovarni ogirligiga qaraymiz. … bu fileda tahminan 500k
> row boladi senga faqat bir qismini tashladim. … men hohlayotgan narsa
> shunday fileni(bazani) bersam shuni ichida menga tahminan qoyib berish
> bazani va mashina invoiceda shunday qilib narxini qoyib edinitsa
> izmereniyasini qoyib tahminiy rastamojka summasini hisoblab bersin. ved
> hodimi uchun bazani tanlashda yordam bersin shu file ichidan baza narxni
> tanlayotganda tanlashib bersin. va telegram botda AI hisobchi qilishimiz
> kk malumotlar berilganda hamma malumotlarni toliq qilib olib hisoblab
> beradgan bolsin AI Ved hodimi»

His SEVEN answers to the clarifying questions (2026-09-04):

1. **(b)** The quarterly file's columns MAY change — the importer recognizes
   columns by their HEADER NAMES, never by position.
2. **(b)** Imports ACCUMULATE. A new quarter's import never deletes the old
   one; suggestions read the NEWEST ready import; the previous quarter stays
   visible for comparison («bu kod avvalgi chorakda qancha edi»).
3. **(a)** AUTO-FILL: when the name similarity is good enough, the closest
   row's price fills the baza AUTOMATICALLY, marked «📥 importdan, taxmin»,
   visible before any ✅; below the threshold the cell stays EMPTY and a
   picker lists candidates (name · $price · weight/unit · date), with the
   weight-closest candidates ranked first for dona goods (his own rule).
4. **ADMIN uploads** the file («admin yuklab bersin fileni sistemamiz tez
   ishlashi kerak») — the VED only READS from the imported data. Processing
   must not slow the system: background job, never in-request parsing.
5. **(a)** The AI hisobchi lives in the STAFF bot only. NO client-facing AI —
   that is his own standing decision from the AI round, reconfirmed.
6. **AI is never official**: it replies «Tahminiy: ~$X (rasmiy emas)» AND the
   pre-filled request lands in the VED queue; the official price exists only
   after the VED's ✅ + seal. (His words: «sen aytgandek bolsin».)
7. **Only the BAZA comes from the file.** Duty/VAT/BHM are computed by OUR
   law engine (PP-3818 rates already seeded) — never taken from the file's
   own customs figures. («sen aytgandek bolsin».)

## 1. The FILE — measured on his sample (uploads/c1ab4448-BAZA.xlsx)

One sheet «Лист1». Sample: 4 001 rows × 24 columns (row 1 = headers). The
real quarterly file is ~500k rows. It is a dump of REAL customs declarations,
one row per declared goods line. Exact headers, verbatim:

```
Режим | Процедура | Отправитель | С графа | 31-Гр-Страна происхождения |
БЮД раками | № Товара | ТИФ ТН КОДИ | Товар номи | За.ед. из.$ |
За.ед. из. Курс валюта | Валюта контракта | Кол.ед. из. | Вес за ед |
Ед. из. | Нетто | Фактура киймати | Божхона киймати | Там.стоим $ |
Курс валюта | Курс доллар | Метод | Страна отправления | Страна происхождения
```

The columns the import NEEDS (match by header name, tolerant of case/extra
spaces — his answer 1b; every other column is ignored):

| Header | Meaning | Import column |
|---|---|---|
| `ТИФ ТН КОДИ` | TNVED code, 10 digits | `tnved_code` |
| `Товар номи` | goods name, usually «ru / en» in one string, often prefixed «1. » | `name` (+ `name_norm`) |
| `За.ед. из.$` | price PER UNIT in USD (per Ед.из) | `price_per_unit_usd` |
| `Ед. из.` | unit: кг / шт / м2 / пар / л | `unit` (mapped) |
| `Вес за ед` | WEIGHT PER UNIT, kg — his dona-matching rule's column | `weight_per_unit_kg` |
| `Нетто` | net kg of the line | `netto_kg` |
| `Божхона киймати` | line's customs value (USD — equals Там.стоим $) | `customs_value_usd` |
| `С графа` | declaration date | `declared_at` |
| `Отправитель` | sender company | `sender` |
| `Страна происхождения` | origin, e.g. «156-КИТАЙ» | `origin_country` |

Measured facts (sample):
- 502 distinct codes; the top code (8708299001) has 1 061 rows — «1 kodda
  100lab narx» is literal.
- Units: кг 74 %, шт 25 %, м2/пар/л < 0.5 %. Map: кг→kg, шт→dona, м2→m2,
  пар→juft, л→litr; ANY OTHER unit → row skipped and counted (never guessed).
- `За.ед. из.$` and `Нетто` are never null/zero in the sample; on кг rows
  `За.ед. из.$ ≈ Божхона киймати / Нетто` (it IS the per-kg price). The
  importer should self-check this ratio on ~100 rows and log drift — if the
  real file breaks it, stop and ask, do not import garbage.
- Dates span exactly one quarter (2026-04-01 → 2026-06-29).
- Names: 100 % carry Cyrillic, ~99 % also Latin («Подшипник шариковый / Deep
  groove ball bearing»). Часто «1. » prefix — strip it in name_norm.
- Режим values «ИМ 40» / «НД 40» — both are imports; do NOT filter by regime
  in v1 (if the real file carries export regimes, ask the owner).

A 12-row fixture with the EXACT headers is committed at
`tests/fixtures/customs-import-sample.xlsx` — build the parser against it.
The full file is NOT in the repo; the owner re-uploads it each quarter.

## 2. Sub-round A — import + baza suggestions

### 2.1 Migration 0094 `customs_import` (ledger must reach 95)

**BEFORE minting: `git fetch origin main` and read the tail of
`meta/_journal.json` — the number/`when` collision has now happened FOURTEEN
times.** As of this writing the tail is idx 93 / when 1785190000072 /
`0093_calc_offer_answer`.

- `customs_import_batches`: `id` uuid, `file_name` text, `uploaded_by` FK
  users, `uploaded_at` timestamptz default now, `status` text CHECK IN
  ('processing','ready','failed') default 'processing', `row_count` int
  default 0, `skipped_rows` int default 0 (unmapped units + unparsable),
  `period_from` date null, `period_to` date null (min/max of `declared_at`),
  `error` text null.
- `customs_import_rows`: `id` **bigserial** (500k×4/year — uuid would bloat
  every index), `batch_id` uuid FK batches ON DELETE CASCADE, `tnved_code`
  text NOT NULL, `name` text NOT NULL, `name_norm` text NOT NULL,
  `unit` text NOT NULL CHECK IN ('kg','dona','m2','juft','litr'),
  `price_per_unit_usd` numeric(14,4) NOT NULL CHECK (> 0 AND <> 'NaN'),
  `weight_per_unit_kg` numeric(12,4) null CHECK (null OR (> 0 AND <> 'NaN')),
  `netto_kg` numeric(14,3) null, `customs_value_usd` numeric(14,2) null,
  `declared_at` date null, `sender` text null, `origin_country` text null.
- Indexes: `(batch_id)`; `(tnved_code)` btree; **GIN trgm on `name_norm`**
  (`CREATE INDEX ... USING gin (name_norm gin_trgm_ops)`) — `pg_trgm` is
  ALREADY installed since migration 0001, do not re-create the extension.
  NOTE: drizzle wraps all pending migrations in ONE transaction, so
  `CREATE INDEX CONCURRENTLY` is impossible (known footgun) — a plain CREATE
  INDEX on an empty table is instant; the table is born empty, fine.
- `calc_request_items.import_row_id` **bigint** null REFERENCES
  customs_import_rows(id) ON DELETE SET NULL — provenance for the 📥 chip.
  (#809 trap: ON DELETE SET NULL cannot coexist with a CHECK spanning the FK
  column — do NOT add any CHECK that mentions import_row_id.)
- Widen the item `baza_source` CHECK (its current form allows
  'dictionary'|'typed'; find the constraint name in 0086/0092 — you must
  DROP + re-ADD the constraint) to allow **'import'**. Same for nothing
  else: rate_source is untouched. **`tests/unit/ai-advisory.test.ts` pins
  the source sets with no 'ai'** — extend that fence deliberately to accept
  'import' with a recorded reason (import = customs' own recorded numbers, a
  person still confirms; 'ai' remains forbidden for ever).

### 2.2 Upload: admin-only, storage-first, background job

- Screen: `/admin/bojxona-import` + a tile on the /admin hub. Gate
  **`admin.dictionaries.manage`** (the freight tariff's own gate — the same
  logic: the person feeding reference prices is the admin, his answer 4).
- Upload endpoint: a ROUTE HANDLER (`/api/admin/customs-import`), never a
  server action (#291 — 1 MB action cap; the file is 40-80 MB). Validate by
  CONTENT (xlsx = ZIP magic `PK`, like the APK upload precedent; csv =
  text), cap ~150 MB. Write the raw file to STORAGE first (the files
  service), insert the batch row 'processing', enqueue `JOB_CUSTOMS_IMPORT`
  with {batchId, storageKey} — **never parse in the request** (his words:
  «sistemamiz tez ishlashi kerak»).
- The job (registered in jobs.ts beside the calc workers, NAMED registration
  — round 106: boss.work mints a worker per call, the done-set pattern):
  1. Stream-parse: `exceljs` is ALREADY a dependency (^4.4.0) — use
     `ExcelJS.stream.xlsx.WorkbookReader` over the storage stream for xlsx;
     plain line-streaming for csv (detect by magic, not extension). DO NOT
     load 500k rows into memory at once.
  2. Header row: locate required columns by normalized header name
     (lowercase, strip spaces/dots): required = code, name, price-per-unit,
     unit; optional = weight-per-unit, netto, customs value, date, sender,
     origin. A MISSING REQUIRED header fails the batch with a sentence
     NAMING it («'Ед. из.' ustuni topilmadi») — never positional guessing
     (his 1b).
  3. Per row: skip when code not /^\d{4,10}$/, unit unmapped, or price not a
     finite positive number (count into skipped_rows). `name_norm` =
     lowercase, «^\d+\.\s*» prefix stripped, whitespace collapsed — keep the
     WHOLE string (ru + en halves together; trigram similarity works across
     both).
  4. Insert in CHUNKS of 1 000 (one multi-row INSERT per chunk, the pool is
     fine — but NEVER call getSetting or any pooled helper from inside a
     transaction here; #714). Update `row_count` every ~20k so the screen's
     AutoRefresh shows progress.
  5. Finish: status 'ready', period_from/to = min/max declared_at. Any throw:
     status 'failed' + error text. The job must be RESUMABLE-safe: on retry,
     delete the batch's rows first (idempotence by wipe-and-redo — the batch
     id is the claim).
- Screen shows: batches list (date, file, rows, skipped, status, period,
  uploader), a failed batch's error, delete button for failed batches only.
  Keep his 2b: NEVER auto-delete old ready batches.

### 2.3 Suggestion service `src/modules/wms/calc/import-baza.ts`

```
suggestImportBaza(input: {
  tnvedCode: string; name: string;
  unit: 'kg'|'dona'|'m2'|'juft'|'litr';   // the row's law/measure unit
  weightPerUnitKg?: number | null;         // request item: weightKg/quantity
}): Promise<{ auto: ImportBazaRow | null; candidates: ImportBazaRow[] }>
```

- Reads the NEWEST 'ready' batch only (his 2b). EXACT code match only in v1
  — a price is code-specific; the LAW's prefix fallback does not apply to
  prices. No rows → both null/empty (the screen says «bu kod importda yo'q»,
  the VED types by hand — his own sentence).
- Rank in SQL: `similarity(name_norm, ${normalize(name)})` via pg_trgm over
  `WHERE batch_id = $newest AND tnved_code = $code`, LIMIT 10 by score.
  UNIT FILTER: candidates whose `unit` differs from the request row's unit
  are kept in the list (visible, labeled) but NEVER auto-filled — a per-kg
  price must not silently land on a per-dona row.
- Dona re-rank (his rule): when unit='dona' and weightPerUnitKg is known,
  `score = 0.7*name_sim + 0.3*(1 - LEAST(1, abs(w_req - weight_per_unit_kg)
  / GREATEST(w_req, 0.01)))` — compute in SQL, tune the weights on his real
  file before shipping.
- AUTO threshold (his 3a): setting `import_baza_min_sim`, default **0.45**
  (seed it in settings service DEFAULTS; the settings tripwire will demand a
  description ×4 locales). auto = top candidate when its name_sim ≥ threshold
  AND unit matches. Below → auto null.
- The candidate's UNIT decides the basis it would fill: kg→'kg', dona→'unit',
  m2→'m2', juft→'juft', litr→'litr' (all five are legal `baza_basis` values
  after phase 3 — no sm3 exists in the file's units).

### 2.4 Workspace wiring (items-table + saveTable)

- **Server auto-fill** happens inside `saveTable`'s flow, AFTER the
  regroup/sweep/measure passes (membership is final there), for every item
  that (a) has a code, (b) `bazaUsd IS NULL`, (c) was not explicitly given a
  baza in this save. Call suggestImportBaza with the item's name, the
  group's law unit (defaultBasisFor logic) and weight-per-unit
  (weightKg/quantity when both non-null). A hit writes
  `bazaUsd/bazaBasis/baza_source='import'/import_row_id` in the SAME tx.
  LOUD (never silent): `TableSaveResult` grows `importFilled: number[]`
  (seqs) and the sticky bar prints «📥 N qator bazasi importdan (taxmin)».
  The unconfirm pass must treat an import-fill like any baza change (it
  already will — the baza changed).
- **The 📥 chip**: a row whose `baza_source==='import'` renders a small
  `📥` marker beside the baza input (testid `calc-baza-import`), title =
  the source row's name + date. Any hand edit posts source 'typed' (the
  existing save chain already stamps 'typed' on a posted pair — verify, do
  not assume).
- **Warning + confirm record**: add fact + warning kind `baza_import`
  (warnings.ts) listing the seqs whose baza is import-sourced — so the ✅
  records it in `confirmed_warnings` (E1's honesty) and the footer's ⚠/count
  language stays consistent. WARNING_LABELS + i18n ×4.
- **The picker** (his «tanlashib bersin»): in the row's ⋯ menu (RowMenu) —
  NOT a new always-visible control; the 880px table has no width to spare —
  a «📥 Importdan tanlash» button opening a fold listing the 10 candidates:
  truncated name · `$X/birlik` · `N kg/dona` · date · sender, previous-batch
  rows behind a small «oldingi chorak» fold (his 2b). Tap = client drafts
  bazaValue+bazaBasis AND records `draftImportRowId[itemId]`; `save()` posts
  it as `TableItemEdit.importRowId`; the SERVER validates the row id exists,
  belongs to a READY batch and its tnved_code equals the item's code — a
  hand-posted foreign id must not stamp false provenance (the id-teleport
  family). Posting importRowId with a differing typed price = provenance
  lie → server keeps the price but stores source 'typed', no importRowId.
- Phone stays read-only (existing design) — no picker there.
- **Live figures need no work**: once the baza pair is on the row, phase 3's
  live engine prices it (his «tahminiy rastamojka summasi» is the existing
  live footer/bar + ИТОГО).

### 2.5 Sub-round A tests (the proof pattern of this repo)

- Unit: header-recognition matrix (renamed/missing/reordered columns; the
  missing-required sentence); unit mapping incl. the skip; name_norm rules
  («1. » prefix, case, spaces); the dona re-rank formula; the auto threshold
  edge (0.449 vs 0.451).
- Integration (fresh gsr_ci, fixture file end-to-end through the JOB
  function — not through HTTP): import the 12-row fixture → batch ready,
  counts right; suggestImportBaza exact-code + similarity order; unit
  mismatch never auto; newest-batch-wins (import twice, suggestions flip);
  saveTable auto-fill writes source='import'+row id and answers
  importFilled; hand-posted foreign importRowId refused/downgraded; deleting
  a batch SET NULLs import_row_id and the workspace still loads.
- e2e (m9zu): admin uploads the fixture via the real screen → ready; a
  request row with a fixture code gets 📥 auto-fill after save; picker shows
  candidates; ✅+seal work. Cleanup deletes the batch (an import is
  CONFIGURATION for other specs — #183 — and its rows would auto-fill OTHER
  specs' bazas! → the e2e MUST delete its batch as a final test, and the
  fixture's codes must be codes no other spec types: use codes absent from
  pp3818 tests, e.g. keep the fixture's own 8482109008/8427201909 and check
  no other spec uses them — m9zp/q/r/t use 8528520000 and 6907, safe).
- Red proofs by string edit (#430 — NEVER `git checkout`, broken four times):
  unit-match guard stripped → auto fills kg price on dona row → test red;
  newest-batch clause stripped; the provenance validation stripped; the
  threshold comparison inverted.
- The tx-pool fence (`tests/unit/tx-pool.test.ts`) DERIVES pooled calls
  transitively — the import job and the saveTable fill must not call any
  pooled helper inside a tx or that fence goes red (it is right).

## 3. Sub-round B — the AI VED hodimi (staff bot)

Builds ON TOP of the existing 🧮 hisoblatish intake
(`telegram/calc-intake.ts`, `wms/calc/intake*.ts`) — do not build a second
collector. Staff bot ONLY (his 5a).

- **Collection loop**: the intake already extracts items + missingFields and
  asks for what is absent (in-memory 30-min TTL; a bot restart loses the
  typed text — stated long ago). EXTEND the checklist for
  rastamojka/podklyuch: per-item `quantity` and (for dona-shaped goods)
  per-item weight; the AI asks follow-ups in the same chat until complete or
  the user says «Bo'ldi» (then it computes with holes named). Keep round
  101's law: the model call is DISPATCHED off grammy's sequential poller
  with a 60 s deadline (`suggestTnved` already has the timeout — reuse its
  client shape).
- **After landing** (the request already lands in the queue via
  intake-land): run `aiPrefill(requestId)`:
  1. Codes: TNVED memory first (existing), then the model's suggestTnved for
     the rest — codes land on ITEMS, the sweep groups them (all existing
     machinery; call `saveTable` with the code edits so the rev clock, the
     sweep, the measure pass and rates-at-mint all run — NEVER a parallel
     writer).
  2. Bazas: the SAME saveTable-integrated import fill from sub-round A does
     the rest. Where only candidates exist (below threshold), give the model
     the TOP-5 rows and let it PICK one or none (structured output with a
     one-line reason) — the model chooses a ROW; the NUMBER is the file's;
     the pick is applied through the same importRowId path and marked like
     any import fill. **rate_source/baza_source never gain 'ai'** — the
     ai-advisory fence stays; the pick's provenance is the import row.
  3. Read `loadWorkspace`: customs priced → reply in the chat
     «Tahminiy rastamojka: ~$X — rasmiy emas, VED tasdiqlaydi» (+ freight
     line if the section has it and a zone is inferable — if not, say
     freight kutilmoqda); blockers remain → reply naming them in words
     (the engine's own refusal codes mapped to sentences).
  4. The request STAYS in the VED queue exactly as today; the VED opens a
     PRE-FILLED workspace, reviews the 📥 marks, ✅ + seals. Official price
     = the seal (or Готово where unsealable), exactly as now (his 6).
- Rate limiting: intake AI already runs per-request; no new cap in v1, but
  log token use; the ANTHROPIC key absent → the whole AI half degrades to
  today's behavior with the honest «sozlanmagan» (existing pattern).
- Tests: intake checklist extensions (pure); aiPrefill integration with the
  model MOCKED (the pick function takes candidates and returns an index —
  inject it); the reply-shaping pure function (tahminiy wording, blockers
  named); NOT live-testable against Telegram here — watch the first real run
  in `docker compose logs` (the standing pattern).
- i18n: bot texts are Uzbek strings in the bot modules (the staff bot speaks
  Uzbek) — follow `staff-bot.ts`'s existing conventions.

## 4. Laws that bind this work (do not re-derive)

- The model proposes WORDS/ROWS, never a number a customer pays: baza values
  come from the FILE, rates from PP-3818, the total from the pure engine; a
  person ✅s and seals. `tests/unit/ai-advisory.test.ts` is the fence —
  extend for 'import', never for 'ai'.
- Law 6: never $0 — every refusal is a worded sentence.
- #171: what a control renders is what the save posts (the picker drafts the
  pair; save() and the live engine share the chain — phase 4's
  defaultBasisFor discipline).
- #432: no per-row queries on list surfaces — the auto-fill runs per SAVE
  over the changed/ungrouped set, batched into one or two queries.
- #714: nothing pooled inside a transaction.
- #291: files go through route handlers.
- Platform must never import wms.
- Round 101: model calls off the bot poller + explicit timeouts.
- The bot may know only what the person already knows (round 36) — the AI
  hisobchi answers into the STAFF chat that asked.

## 5. Build discipline for the next session (verbatim ritual)

- Postgres dies between turns:
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/local/pg/data -l /var/local/pg/log/pg.log -o '-k /tmp' start"`.
- Dev loop DATABASE_URL: `postgres://postgres@127.0.0.1:5432/gsr_ci` (TCP;
  `?host=/tmp` breaks postgres.js).
- Full pipeline in CI's order (script exists at the previous session's
  scratchpad shape): drop/create gsr_ci → db:migrate → db:seed → SEED_DEMO=1
  db:seed:demo → FULL vitest → build → `fuser -k 3000/tcp` → e2e WITHOUT
  CI=1. Per-gate exit codes via `${PIPESTATUS[0]}` — grep each gate's OWN
  marker (#738/#803).
- `pnpm typecheck` before every push (tests/ are typed only there).
- Next build lint reads `.next/cache/eslint` and can serve PRE-edit
  diagnostics — `rm -rf .next/cache/eslint` when a build contradicts
  `pnpm lint` (#871).
- A red proof is undone by a STRING EDIT, never `git checkout` (#430 —
  broken four times; commit the surgery BEFORE running proofs).
- Playwright webServer timing out at 60 s locally = stale
  `pgboss.version.maintained_on` → `UPDATE pgboss.version SET maintained_on = now()`.
- BEFORE minting migration 0094 and DECISIONS numbers: `git fetch origin
  main`, re-read `_journal.json`'s tail AND `DECISIONS.md`'s tail — the
  other session is active and has collided FOURTEEN times. DECISIONS tail as
  of this writing: **#888**.
- Ship pattern: push → draft PR → subscribe_pr_activity → drive to green →
  merge → Uzbek deploy commands ending with the LEDGER COUNT (0094 → 95).
- Reply to the owner in UZBEK, business terms, numbered questions only when
  a decision is genuinely his.

## 6. Open items / stated cuts

- The full 500k file is NOT yet delivered — he sends it (xlsx or csv both
  accepted) when sub-round A's import screen exists. First real import:
  watch duration and the За.ед.из.$≈value/netto self-check drift in logs.
- Prefix fallback for prices: CUT in v1 (exact code only) — a neighboring
  code's price is not this code's price; revisit only if he asks.
- Auto-fill threshold 0.45 is a first guess — tune on the real file and
  record the measurement.
- The AI hisobchi does not quote FREIGHT unless the zone is known — freight
  needs his tariff zone; the reply says so rather than guessing.
- Client-facing AI: refused (his standing decision).
