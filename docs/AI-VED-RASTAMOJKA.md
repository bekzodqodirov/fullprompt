# AI-VED — Telegramda tahminiy RASTAMOJKA hisobi (handoff spec)

> **Kimga.** Bu hujjat BOSHQA model / boshqa sessiya uchun yozilgan: u shu
> repodan hech narsa eslamaydi. Hamma narsa shu yerda — nima bor, nima yo'q,
> nimani qanday qurish kerak, qaysi qonunlar buzilmaydi, qanday tekshiriladi.
> Kodning batafsil xaritasi (har bir fayl, funksiya, jadval, xato kodi, test)
> **`docs/AI-VED-RASTAMOJKA-MAP.md`** da — o'sha faylni ham o'qing.
>
> **Egasi (Bekzod) nimani xohlaydi — uning so'zlari, 2026-09-05:**
> «telegramda ai ni o'zi tahminiy hisoblab bersin rastamojka qancha bo'lishini.
> AI-VED faqat rastamojka hisoblaydi. Sotuv menejerlar ma'lumotni yuboradi,
> AI-VED rastamojka to'lovini hisoblab beradi.»
> Ikkita aniqlashtiruvchi javobi: **(1)** «ha» — AI darhol chatga tahminiy
> summani yozadi VA so'rov VED navbatiga tushadi; rasmiy narx VED muhridan
> keyin; **«shu muhrlangan datani AI xotirasiga qo'yish kerak, iloji bo'lsa»**;
> **(2a)** javob sotuvchining Telegram chatiga HAM, bitim/lid kartasidagi
> lentaga HAM yoziladi.
>
> Egasi bilan muloqot: **faqat o'zbekcha**, biznes tilida (mijoz, prixod,
> bitim, sklad, kub, tannarx, VED hodimi, sotuvchi, buxgalter) — jadval va
> funksiya nomlari emas. Raqamlangan savollar, variantlar bilan.

---

## 0. One paragraph: what to build

In the **staff Telegram bot** (`src/modules/platform/telegram/*`), a sales
manager sends the goods of a shipment (text, photos, invoice PDF/XLSX, per-line
quantities or weights). **AI-VED** — the machine — classifies each line to a
TNVED code, takes a base price (baza) per unit, applies the Uzbek customs law
(PP-3818 duty in four shapes, the additional duty when no certificate, excise,
12 % VAT, the VMQ-55 BHM declaration fee) through the EXISTING pure engine, and
answers **in the same chat within a minute**: per-line breakdown, the total
**customs payment (rastamojka)**, what is missing, and the sentence
**«⚠️ Rasmiy emas — VED hodimi tasdiqlaydi»**. The same text goes onto the
card's lenta. The request lands in the VED queue pre-filled; the VED reviews,
✅-confirms and seals — the seal is the official price. **Every seal feeds the
AI's memory**: the next time a similar product name arrives, the AI takes the
VED-confirmed code · baza · basis · rates FIRST, the quarterly customs file
second, the model's own guess last. The AI **never prices freight** (yo'lkira)
— that stays the VED's.

Roughly 70 % of this already exists (sub-rounds A and B of
`docs/VED-IMPORT-AI.md`, shipped 2026-09-04 and live on the owner's server).
This round is the remaining 30 %: rastamojka-only reply with a breakdown,
immediate + lenta delivery, the sealed memory, the follow-up questions, invoice
reading, the prefill from every door, the reason chip, a cost cap — and the
audit defects on this exact path that would make the feature lie.

---

## 1. Fixed product decisions (do not re-ask)

From `docs/VED-IMPORT-AI.md` §0 (2026-09-04), all still in force:

1. Import file columns are matched by **header name**, never position.
2. Quarterly imports **accumulate**; suggestions read the **newest READY** batch.
3. **Auto-fill** when name similarity ≥ threshold (setting `import_baza_min_sim`,
   0.45); below it the cell stays empty and a picker lists candidates; for
   dona goods weight-closest candidates rank first.
4. The **admin uploads** the customs file; the VED only reads.
5. **Staff bot only. NO client-facing AI** (standing decision, reconfirmed).
6. **AI is never official**: it replies «Tahminiy … (rasmiy emas)» AND the
   pre-filled request lands in the VED queue; the official price exists only
   after the VED's ✅ + seal.
7. **Only the BAZA comes from the file.** Duty/VAT/fee are OUR law engine's,
   never the file's own customs figures.

From 2026-09-05 (this handoff):

8. **AI-VED computes RASTAMOJKA only.** The bot's AI reply carries no freight
   line. (Freight = the VED's tariff work; the request still carries the
   section the seller chose.)
9. **Immediate reply + VED queue** (answer 1): the estimate is answered in the
   chat as soon as the pass finishes; the job stays in the queue; the seal is
   the official price.
10. **Sealed data becomes AI memory** (answer 1, second half): what the VED
    sealed — per product name: code, baza, basis, duty shape, lgota — is the
    FIRST source for the next similar name. Priority: **sealed memory →
    dictionaries (`calc_bazas`, `calc_rates`) → quarterly import → model**.
11. **Reply goes to the chat AND the card lenta** (answer 2a).

Laws that bind every line of this work (from `docs/VED.md` and the code):

- **Law 1 — the model proposes WORDS and ROWS, never a number a customer pays.**
  `rate_source` CHECK admits `'dictionary'|'typed'`; `baza_source` admits
  `'dictionary'|'typed'|'import'` (this round adds `'memory'`); there is **no
  `'ai'`** and there never will be. `tests/unit/ai-advisory.test.ts` pins it.
- **Law 4** — the VED never sees a client price; the seller never sees the floor
  as a cost breakdown on shared lists. (Not touched by the bot reply: the reply
  goes to the person who asked, about a job with no client price yet.)
- **Never $0 and never a bare code** — every refusal is a worded sentence
  (`prefill-reply.ts` maps every refusal union to Uzbek; a missing entry is a
  compile error).
- **#171** — what a control renders is what the save posts.
- **#432** — no per-row queries on list surfaces.
- **#714** — nothing pooled inside a transaction (`tests/unit/tx-pool.test.ts`
  derives the pooled set transitively).
- **#291** — files go through route handlers, never server actions.
- **`platform` must never import `wms` statically** — the house idiom on this
  path is `await import('../../wms/...')` (see `staff-bot.ts`, `keyboards.ts`).
- **Round 101** — every model call is dispatched OFF grammy's sequential poller
  and carries an explicit timeout (60 s).
- **Round 36** — the bot may tell a person only what they could already see.
- **#430** — a red proof is undone by a STRING EDIT, never `git checkout`.

---

## 2. What exists today (build ON it, never beside it)

Read the map for signatures and line numbers; this is the shape.

### 2.1 The bot intake (🧮 Hisoblatish)

`src/modules/platform/telegram/staff-handlers.ts` (grammy shell),
`staff-bot.ts` (decisions, testable), `calc-intake.ts` (in-memory state, 30-min
TTL, `MAX_INTAKE_IMAGES = 6`), `keyboards.ts`.

Conversation: `🧮 Hisoblatish` → section keyboard (`c:yolkira | c:rastamojka |
c:podklyuch`) → «Mijozni yozing: kodi (GS777) yoki telefon raqami» → material
stage (every text/photo/document is swallowed as material; photos downscaled
to 1568 px JPEG for the model; documents stored but NOT read) → `Bo‘ldi`
(`c:done`) → `analyseIntakeAndReply` off the poller → `analyzeCollected` =
`parseManualFacts` (regex, typed facts WIN) + `analyzeIntake`
(`wms/calc/intake-ai.ts`, claude-opus-5, json_schema, 60 s) → summary with the
section's missing `REQUIRED_FIELDS` → `✅ Tasdiqlash` (`c:save`) →
`landCollectedIntake` → `wms/calc/intake-land.ts` `landIntake`:
coded client → newest OPEN deal (`dealFor`) or a new one; stranger → open lead
by phone or a new lead; ONE `crm_activities` note (id pre-minted so files are
pre-bound); `openCalcRequest` (`wms/calc/service.ts`, `source:'bot'`) →
`moveToCalcStage` → the bot enqueues `JOB_CALC_PREFILL` with the request's
`rev` (`queuePrefill`). Reply today: «✅ Saqlandi … 🧮 Hisoblash navbatiga
tushdi — VED xodimi javob beradi.»

`REQUIRED_FIELDS` (`wms/calc/intake.ts`): yolkira = fromCity, toCity, weightKg,
volumeM3, goods; rastamojka = weightKg, volumeM3, goods, **itemMeasure**;
podklyuch = all six. `itemMeasure` is ONE field: a line lacks it when it has
neither quantity nor weight nor measureQty; a single line's weight is DERIVED
from the shipment total (`loneWeightKg`). `CalcItemInput` has NO
measureQty/measureUnit — the law's own units (m²/juft/litr) are typed only in
the workspace.

Callback grammar (64-byte cap): `e:s|e:c`, `c:<CALC_STEPS>`, `t:<uuid>`,
`a:[01]:<uuid>`. A new step MUST be added to `CALC_STEPS` or `parseCallback`
returns null.

Two more doors land in the SAME queue with the SAME item derivation: the card
form (`components/calc-send-form.tsx` → `hisoblash/actions.ts submitCalcAction`,
`source:'card'`) and the CRM Telegram-thread door (`wms/calc/from-thread.ts`).
**Only the bot door enqueues the prefill today.**

### 2.2 The queue and the request

`calc_requests` (0085) + `calc_request_items`; `openCalcRequest` is the ONE
writer; assignment = `nextVedAssignee()` fewest-open over ACTIVE
`ved.docs` holders (never-had-one first); a priority-1 task `Hisoblash: <label>
(<n>)` with `due_at = now + calcDueMinutes(items, hasMaterials)`; overdue sweep
`calc.overdue` every 5 min claims by `overdue_notified_at`. Four endings via
`completed_via`: `'sealed'` (the seal), `'task'` (Готово with a typed answer,
or a hand-closed task with none), `'returned'`, `'lines'`. A correction is a
NEW request (`recalcFromSealed`, `supersedes_request_id`); «V2» is DERIVED
(`chain.ts`). Screens: `/hisoblash` (queue), `/hisoblash/[id]` (workspace),
`/hisoblash/tarix` (registry), `/hisoblash/narxlar`, `/hisoblash/nazorat`,
`/hisoblash/lugatlar`; the card's 🧮 panel `components/calc-panel.tsx`.

### 2.3 The engine and the law

`wms/calc/pricing.ts` — pure, zero imports, «never returns a number it had to
invent»: `customsFor(group, items)`, `requestCustomsFor(...)` (the BHM fee per
DECLARATION), `customsFeeFor`, `totalsFor`, `bandFor`, `itemMeasure`,
`sectionParts(section)` (customs half exists iff section ≠ yolkira). Duty
shapes advalor/specific/max/plus (`duty_mode`, `duty_specific`, `duty_unit`);
additional duty by band when `has_certificate` is false (inclusive-high);
excise in the VAT base; `fee_override_usd`; refusals `baza_missing`,
`rates_missing`, `measure_missing`, `fee_fx_missing`, `band_missing`,
`band_ambiguous`, `not_a_number`, … (the full unions are in the map). PP-3818's
1,489 rates seeded into `calc_rates` (`rates-seed.ts`, vat 12 on every row);
longest-prefix lookup `ratesForCodes`; `calc_bazas` and `calc_price_book`
ship EMPTY. Settings: `bhm_uzs`, `quote_valid_days`, `import_baza_min_sim`.

`wms/calc/workspace.ts` (3,800 lines) — `loadWorkspace` recomputes a DRAFT
every render; `saveTable` is the ONE table write door (validate → pool reads →
`FOR UPDATE` → edits by id → regroup + SWEEP by typed code → measure pass →
import auto-fill → unconfirm → recount → ONE audit); every mutator through
`mutateRequest`/`lockRequestInTx` and the `rev` clock; `sealCalc` = the one
door from draft to FACT (`calc_versions` with the whole `breakdown` snapshot).
`proposeGroups` (✨) claims `ai_proposal_started_at`, asks
`tnved/service.ts proposeGoodsGrouping` (claude-opus-5, batches of 200),
`applyProposal` writes only `ai_*` columns, then `priceProposedGroups` pulls
PP-3818 rates per coded group and stamps codes onto items through `saveTable`.

### 2.4 The AI VED hodimi pass (sub-round B) and the import baza (sub-round A)

`wms/calc/prefill.ts aiPrefill(requestId, {actorId: null})` run by
`calc/jobs.ts registerCalcPrefillWorker` after `prefillStanding(requestId, rev)
=== 'ok'`: (1) `proposeGroups` + `priceProposedGroups`; (2) an empty
`saveTable` SWEEP that also fires the deterministic import auto-fill
(`customs/import-baza.ts suggestImportBaza`, `word_similarity` on `name_norm`,
`unitsForRow`, threshold 0.45, newest READY batch); (3) `pickBazas` — for still
empty coded rows (cap 40) the model (`prefill-ai.ts pickImportRows`, ONE call)
picks an INDEX into ≤10 real candidates, re-checked, basis-fenced, written
through `saveTable`'s `importRowId` path so the PRICE is re-read from the
FILE; (4) `loadWorkspace` → pure `prefill-reply.ts prefillReplyText` →
`notifyStaffTelegram({type:'CalcPrefilled'})` to the seller through the
notification drain (`JOB_SEND_TELEGRAM`). The reply today: «🧮 Tahminiy:
rastamojka ~$X (N ta tovarsiz) · yo‘lkira ~$Y», «⚠️ Rasmiy emas — VED xodimi
tasdiqlaydi.», blockers in words (cap 6), counts. A pass killed half-way is NOT
retried (its first half moved the rev; `prefillStanding` reads `touched`).

Import: `/admin/bojxona-import` (gate `admin.dictionaries.manage`) → route
handler `POST /api/admin/customs-import` → `JOB_CUSTOMS_IMPORT` streams the
file, beats `heartbeat_at` every 10 s, `ready`/`failed` with a sentence,
sweep every 5 min; `deleteImportBatch` refuses `in_use`.

### 2.5 The memories that exist

- `tnved_assignments` (`wms/tnved/service.ts`): **exact** normalised product
  key → code, written by `saveTnved` (the deal-lines TNVED assistant; source
  `'manual'|'ai'`), read by `tnvedFor(names)` in `openCalcRequest` and in
  `saveTable`'s adds. **The seal does NOT write it today.**
- `lgotaLastByCode` (`workspace.ts`): the newest SEALED group per code carrying
  an exemption — «the memory is the sealed record itself». This is the pattern
  to extend.
- `calc_versions.breakdown` (jsonb) snapshots per sealed group: code, dutyPct,
  vatPct, feeUsd, dutyMode/specific/unit, excisePct, hasCertificate, lgota,
  rateSource, and per item: label, quantity, weightKg, volumeM3, bazaUsd,
  bazaBasis, bazaSource, measureUnit, measureQty. Old snapshots lack newer
  keys — every reader tolerates absence.

---

## 3. The target, concretely

### 3.1 The conversation (Uzbek, verbatim texts the bot must print)

Entry: the staff keyboard gains a second button beside «🧮 Hisoblatish»:
**«🤖 AI rastamojka»** (`c:ai_rastamojka`, add to `CALC_STEPS`). It is the
same intake with `section = 'rastamojka'` preset (no section question) and the
AI flags below. The old 🧮 stays for yolkira/podklyuch; when it lands a
podklyuch job the AI still answers — customs half only (decision 8).

```
Sotuvchi:  🤖 AI rastamojka
Bot:       Mijozni yozing: kodi (GS777) yoki telefon raqami. Kod bo‘lmasa — ismini yozing.
Sotuvchi:  GS323
Bot:       Endi tovarlarni yuboring: ro‘yxat (nomi · soni yoki kg), invoys (PDF/Excel/rasm),
           umumiy kg. Tugagach «Bo‘ldi» ni bosing.
Sotuvchi:  monitor 24" — 100 dona
           erkaklar kurtkasi — 300 kg
           [invoice.pdf]
Bot:       Qabul qilindi: ✍️ 1 ta xabar · 📎 1 ta fayl (o‘qiladi) · 🖼 0 ta rasm
           Yana yuboring yoki «Bo‘ldi» ni bosing.
Sotuvchi:  Bo‘ldi
Bot:       ⏳ Tahlil qilinmoqda…
Bot:       📋 Rastamojka uchun o‘qildi:
           1. Monitor 24" — 100 dona
           2. Erkaklar kurtkasi — 300 kg
           3. Sumka (invoysdan) — soni ham, kg ham yo‘q ⚠️
           Umumiy og‘irlik: 1 500 kg · Sertifikat: bor (deb hisoblanadi)
           ❓ 3-qator «Sumka» — nechta dona yoki necha kg?
           [✅ Tasdiqlash] [➕ Yana ma’lumot] [🔁 Sertifikat: yo‘q] [✖️ Bekor]
Sotuvchi:  sumka 50 dona
Bot:       ✔️ 3-qator: Sumka — 50 dona. Hammasi to‘liq.
           [✅ Tasdiqlash] [➕ Yana ma’lumot] [🔁 Sertifikat: yo‘q] [✖️ Bekor]
Sotuvchi:  ✅ Tasdiqlash
Bot:       ✅ Saqlandi: GS323 · B-000067. 🤖 AI hisoblayapti — 1 daqiqa ichida javob beraman.
           So‘rov VED navbatiga ham tushdi.
Bot (≤60 s later, the AI-VED reply):
           🤖 AI-VED · tahminiy rastamojka · GS323 · B-000067
           1. Monitor 24" · 8528520000 · 100 dona × $20/dona 🧠
              boj 10 % · QQS 12 % → $496.96
           2. Erkaklar kurtkasi · 6201400000 · 300 kg × $8.2/kg 📥
              boj 20 % (min $3/dona) · qo‘shimcha boj 15 % (sertifikat yo‘q) · QQS 12 % → $1 254.00
           3. Sumka · kod topilmadi ⚠️ — VED hodimi qo‘yadi
           Deklaratsiya yig‘imi (VMQ-55): 5 BHM ≈ $164.80
           ━━━━━━━━━━━━
           Rastamojka jami (2 ta qatordan, 1 tasi hisoblanmadi): ≈ $1 915.76
           ⚠️ Rasmiy emas — VED hodimi tasdiqlaydi.
           🧠 avvalgi muhrdan · 📥 bojxona faylidan · 🤖 model taxmini
           Karta: https://gsrwms.uz/bitimlar/<id>
```

Rules the texts encode:

- The reply is **customs only**: per line — name · code · quantity/weight ×
  baza (with its SOURCE emoji) · duty (its shape in words) · additional duty
  when it applies · excise when it applies · VAT → the line's customs; then the
  declaration fee line; then the total with «(N ta qatordan, M tasi
  hisoblanmadi)» whenever a line is blocked; **never `$0`, never a bare code**.
  A blocked line prints WHY, in the words `prefill-reply.ts` already maps.
- **No freight line.** If the section is podklyuch: one extra sentence
  «Yo‘lkira VED hodimi hisoblaydi.»
- **Source legend** appears only for the sources actually used.
- **The certificate assumption is printed** («Sertifikat: bor (deb
  hisoblanadi)») and can be flipped with one tap before landing; it lands as
  `calc_requests.has_certificate`.
- Follow-up questions: ONE question per missing line-level fact, asked in the
  same chat; each answer re-runs the manual parser over the new text and
  patches ONLY that line (see §4.3); at most **3 rounds**, then «Tasdiqlash»
  lands with the holes named (decision 6 — the AI computes with what it has).
- Delivery: the reply goes to the seller's chat through the existing drain
  (`CalcPrefilled`) AND is written as a system note on the card's lenta
  (§4.5). The VED also gets a short line on their existing `TaskAssigned`
  message? — NO: the VED already receives the task; the AI's text is on the
  workspace (the 📥/🧠 chips) — do not add a second Telegram to the VED.

### 3.2 Who may use it

Every linked staff member (`mayCollect` = `staffForChat !== null`) — the owner's
phase-A answer «hisoblatish for all staff». The AI answers the person who
asked; a `crm.leads`-less warehouse operator who asks about a lead still gets
the answer about THEIR request (round 36 holds: they sent the data).

### 3.3 What the VED sees afterwards

The pre-filled workspace exactly as today, plus: a **🧠 chip** on rows whose
baza/code came from the sealed memory (title: «V<no> · <date> · <sealer>»), a
**📥 chip** (exists) for the file, and the **reason chip** (owed since #909) on
model-picked rows. The VED's ✅ records `confirmed_warnings` incl. the new
`baza_from_memory` kind. The seal is unchanged — but now WRITES the memory
(§4.4).

---

## 4. Build plan — step by step

Order matters: each step ships with its tests and red proofs, commits go to
the branch you are told to use, and the full pipeline (§7) runs before every
push. Do the audit-defect fixes of §5.1 FIRST — the feature cannot be honest on
top of them.

### 4.1 Migration `0096_ai_ved_memory` (ledger must reach 97)

**Before minting**: `git fetch origin main`, read the tail of
`src/modules/platform/db/migrations/meta/_journal.json` (today: idx 95, when
1785190000074, `0095_customs_import_heartbeat`) and the tail of `DECISIONS.md`
(today #925). Fourteen number collisions so far — the `when` must move too.

Hand-written SQL + a `_journal.json` entry (Drizzle wraps all pending
migrations in ONE transaction — no `CREATE INDEX CONCURRENTLY`). Additive only:

```sql
-- 1. the memory provenance on the item (no CHECK may span an ON DELETE SET NULL FK — #809)
ALTER TABLE calc_request_items
  ADD COLUMN memory_item_id uuid NULL REFERENCES calc_request_items(id) ON DELETE SET NULL,
  ADD COLUMN baza_reason text NULL;                      -- the model's one-line reason (#909, owed)
-- 2. widen baza_source: find the constraint name in 0094 (it was re-added there), DROP + ADD
ALTER TABLE calc_request_items DROP CONSTRAINT calc_items_baza_source_check;
ALTER TABLE calc_request_items ADD CONSTRAINT calc_items_baza_source_check
  CHECK (baza_source IS NULL OR baza_source IN ('dictionary','typed','import','memory'));
-- 3. one correction per parent — A11 (two simultaneous «Qayta hisoblash»)
CREATE UNIQUE INDEX calc_requests_supersedes_uniq ON calc_requests (supersedes_request_id)
  WHERE supersedes_request_id IS NOT NULL;               -- count duplicates FIRST; production should have none
-- 4. the AI cost ledger for calc passes (the assistant's ai_questions is a different audience)
CREATE TABLE ai_calc_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES calc_requests(id) ON DELETE CASCADE,
  staff_id uuid NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('intake','grouping','pick','memory')),
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calc_passes_day_idx ON ai_calc_passes (created_at);
-- 5. name_norm on items for the sealed memory's trigram search (pg_trgm exists since 0001)
ALTER TABLE calc_request_items ADD COLUMN name_norm text NULL;
UPDATE calc_request_items SET name_norm = lower(regexp_replace(btrim(name), '\s+', ' ', 'g'));
CREATE INDEX calc_items_name_norm_trgm ON calc_request_items USING gin (name_norm gin_trgm_ops);
```

Drizzle mirror in `src/modules/platform/db/schema/wms.ts` (the SQL is the
truth; the TS mirror omits several CHECKs already — keep it in step for the
columns you add). `name_norm` is written by every item writer (`openCalcRequest`,
`saveTable` adds/edits, `recalcFromSealed` copy) through ONE helper
`itemNameNorm(name)` in `wms/calc/intake.ts` — not a trigger, so the tx-pool
fence and the audit see it.

Fences to extend, deliberately: `tests/unit/ai-advisory.test.ts` (accept
`'memory'` with the recorded reason: memory = a PERSON's sealed confirmation;
`'ai'` stays forbidden), `tests/unit/calc-rekey.test.ts` (derived from the
schema — `ai_calc_passes` carries `request_id`, not the entity pair, so it
needs nothing), the settings tripwire (new setting keys need a description ×4).

New settings (`platform/settings/service.ts` DEFAULTS + descriptions ×4):
`calc_memory_min_sim` (0.60 — name similarity for the sealed memory; higher
than the import's 0.45 because a memory hit overrides the file),
`ai_calc_daily_limit` (200 passes/day, all kinds), `ai_calc_reply_lenta`
(true — write the reply onto the lenta; the owner's 2a, kept as a switch).

### 4.2 The sealed memory — `src/modules/wms/calc/memory.ts` (new)

```ts
export interface MemoryHit {
  itemId: string;            // the sealed calc_request_items row (provenance)
  versionId: string; quoteNo: number; sealedAt: Date; sealedByName: string | null;
  tnvedCode: string | null;
  bazaUsd: number | null; bazaBasis: BazaBasis | null;
  measureUnit: string | null;
  // the sealed GROUP's law snapshot, for the VED's chip only — the engine
  // re-reads calc_rates by code, never these:
  dutyPct: number | null; vatPct: number | null; dutyMode: DutyMode | null;
  hasCertificate: boolean | null; dutyFree: boolean; vatFree: boolean;
  nameSim: number;
}

/** ONE grouped query for many names (#432): per name the NEWEST sealed item whose
 *  name_norm is word_similarity-close (>= calc_memory_min_sim), excluding the
 *  request being worked on. Only items whose request has a calc_versions row
 *  and whose group was ✅-confirmed count — an unconfirmed group is not a
 *  person's word. Superseded requests DO count (their seal was a person's
 *  word on that day); the newest wins. */
export async function sealedMemoryFor(
  names: string[], opts: { excludeRequestId: string; minSim?: number },
): Promise<Map<string, MemoryHit>>;
```

SQL shape (mirror `lgotaLastByCode`): `SELECT DISTINCT ON (needle) …
FROM unnest($needles) n(needle) JOIN calc_request_items i ON
word_similarity(n.needle, i.name_norm) >= $min JOIN calc_groups g ON g.id =
i.group_id AND g.confirmed_at IS NOT NULL JOIN calc_versions v ON v.request_id
= i.request_id WHERE i.request_id <> $exclude ORDER BY needle,
word_similarity(...) DESC, v.sealed_at DESC`. Bind the names with
`sql.join`/`inArray` — a JS array in a raw fragment is not a postgres array.
Measure it on gsr_dev-shaped data: the GIN trgm index makes this cheap, but
`word_similarity` against every sealed item is O(items) per needle — cap the
candidate set with `i.name_norm % n.needle` (the trgm operator uses the index)
before ranking.

Where it is consulted (the priority order of decision 10):

1. `openCalcRequest` — codes: memory hit's code BEFORE `tnvedFor` (exact key)
   BEFORE nothing. Stamp `memory_item_id` on the item when the CODE came from
   memory (the baza is not written here — the workspace's sweep does that).
2. `saveTable` pre-tx reads (`suggestImportFills` sits there): add
   `suggestMemoryFills` — for coded items with `baza_usd IS NULL`, a memory hit
   with a baza whose basis `unitsForRow` allows → write `baza_usd/baza_basis/
   baza_source='memory'/memory_item_id` in the SAME tx, BEFORE the import
   auto-fill (memory wins over the file). Loud: `TableFormState.memoryFilled:
   number[]` and the bar sentence «🧠 N qator bazasi avvalgi muhrdan».
3. `pullBazasFromDictionary` unchanged (dictionary stays the VED's explicit
   door; when the VED presses it, the dictionary wins by their hand).
4. `aiPrefill` step 0 (new): `sealedMemoryFor` over all items — codes stamped
   through `saveTable` edits (so the sweep groups them with PP-3818 rates at
   mint); the bazas then fill in step 2's save. The model (`proposeGroups`)
   runs only over items STILL without a code after memory + `tnved_assignments`.

Warning kind `baza_from_memory` (`warnings.ts` + `WARNING_LABELS` + i18n ×4 +
the `prefill-reply.ts` legend) — like `baza_from_import` it carries no
dictionary clause: it means «a person confirmed this ONCE before, on another
job», and the ✅ records that somebody looked.

### 4.3 The bot: rastamojka entry, follow-up questions, invoices

`staff-handlers.ts` / `staff-bot.ts` / `calc-intake.ts`:

- New keyboard button «🤖 AI rastamojka» (`keyboards.ts` staff row; the merged
  `bothKeyboard` gets it too — `isCabinetText` derives from the cabinet labels,
  so nothing else changes). Callback `c:ai_rastamojka` → `startIntake(chatId,
  'rastamojka', {ai: true})`; `IntakeState` grows `ai: boolean`,
  `hasCertificate: boolean` (default true), `questions: {seq: number; asked:
  number}[]`, `round: number`.
- **Follow-up loop** (decision 6, the spec'd «asks ONLY for what is missing»
  that was never built): after `analyzeCollected`, compute `missingLines =
  items where itemMeasure is missing` (the same predicate as
  `missingFields`). If any and `round < 3`: print the summary + ONE question
  for the FIRST missing line («❓ 3-qator «Sumka» — nechta dona yoki necha
  kg?») with the confirm keyboard. A text in that state is parsed by
  `parseLineAnswer(text, line)` (new, pure, in `intake-manual.ts`): «50 dona»
  / «50 шт» / «300 kg» / «300 кг» / a bare number → dona when the line is
  dona-shaped else refuse; patch ONLY that line's quantity/weightKg; `round++`;
  ask the next. Anything the parser cannot read is appended to `material` as
  before and re-asked once. `MAX_QUESTION_ROUNDS = 3`, then the summary offers
  «Tasdiqlash» with the holes named. Pure functions, unit-tested: the parser
  (uz/ru/en spellings, comma decimals, «120кг» — JS `\b` is ASCII-only, use
  the `u` flag + lookahead, #412's lesson).
- **Certificate toggle**: inline button «🔁 Sertifikat: yo‘q» ↔ «🔁 Sertifikat:
  bor» flips `state.hasCertificate`; landing passes it to `openCalcRequest`
  (`CalcRequestInput.hasCertificate?: boolean`, written to
  `calc_requests.has_certificate`, default true — the request column exists
  since 0091).
- **Invoices**: today documents are stored and never read. Add: XLSX/CSV →
  `wms/deals/goods-import.ts` parser (header detection ru/uz/zh/en, exists)
  → items; PDF → sent to the model as a document block (Anthropic supports
  `document` content blocks with base64 PDF; cap 10 MB / 20 pages) in
  `analyzeIntake` beside the images; DOCX → refused with a sentence («DOCX
  o‘qilmaydi — PDF yoki Excel yuboring»). The seller's typed lines still WIN
  over what the invoice says (typed facts win — existing rule).
- Fix while there (the map's gaps): a photo sent in the `client` stage must be
  answered («Avval mijozni yozing»), not swallowed by the cabinet; `📋 Bugun`
  and `/bugun` must work during a collection (exempt from the material
  capture); `saveIntakeFile`'s Telegram download gets a 30 s `AbortSignal`;
  a section button pressed during a live collection asks «Boshqatdan
  boshlaymizmi?» instead of silently replacing the state.

`landIntake` returns the `CalcError` code on a refused queue open so the bot
can say WHY («Sizda 20 ta ochiq so‘rov bor — VED javob bergach qayta
yuboring», «Mijoz kodi topilmadi» …) — audit A38.

### 4.4 The seal feeds the memory

In `sealCalc`, AFTER the transaction (pooled writes never inside it — #714):
for every sealed item with a code, `saveTnved({nameZh: item.name, nameRu:
null, code, source: 'manual'}, {actorId: sealer})` — the exact-key memory
grows with every seal (today only the deal-lines assistant writes it). The
fuzzy memory needs no write: `sealedMemoryFor` READS the sealed record itself
(decision 10 = «the memory is the sealed record», `lgotaLastByCode`'s rule).
Also: `sealCalc` must close the VED's TASK (audit A20 — today it never does):
call the same task-closing code `endRequest` uses, with result «Muhrlandi».

### 4.5 The reply: rastamojka-only, breakdown, chat + lenta

`prefill-reply.ts prefillReplyText` becomes `aiVedReplyText(input)` (keep the
old export name as an alias for the wire test):

- Input grows per-line rows from the workspace: `{seq, name, code, qty|kg,
  bazaUsd, bazaBasis, bazaSource ('memory'|'import'|'dictionary'|'typed'|null),
  dutyText (the shape in words: «boj 20 % (min $3/dona)»), addDutyPct|null,
  excisePct|null, vatPct, customsUsd|null, refusal|null}` + `fee {bhm,
  usd}|null` + totals + the certificate assumption + `section`.
- Output = §3.1's text. No freight line ever. `customsUsd` is printed only when
  the group priced; a blocked line prints its refusal words. Total line says
  how many lines it covers. Legend only for used sources. Card link = the
  existing `linkLine`. Length cap: Telegram 4096 chars — over 25 lines,
  collapse to «… va yana N qator» and keep the total.
- Pure + unit-tested (`tests/unit/prefill-reply.test.ts` grows: every refusal
  union member still has a sentence — the `Record<Union,string>` maps are the
  fence; a new engine reason is a compile error here).

Delivery (`calc/jobs.ts` worker): after `notifyStaffTelegram('CalcPrefilled')`,
if `ai_calc_reply_lenta` → `addActivity({entityType, entityId, kind:'note',
note: text, createdBy: null, system: true})` on the request's card (the
`crm_activities.created_by` is nullable since 0066; the lenta renders a
null-author note — verify with the feed test). One note per pass; a re-run
after `touched` never happens (§2.4), so no duplicates.

**Timing**: the drain runs on `JOB_SEND_TELEGRAM`; measure the landing → reply
latency on gsr_ci with the worker running (target ≤ 60 s). If the drain's
schedule is the bottleneck, kick it right after the notification insert
(`enqueue(JOB_SEND_TELEGRAM)` is already how `notifyStaffTelegram` works —
check `notifications/staff.ts`).

### 4.6 Every door gets the pass

`submitCalcAction` (card form) and `threadCalcSend` (thread door) enqueue
`JOB_CALC_PREFILL` after `openCalcRequest` exactly as the bot does
(`prefillTicket` → `enqueue`), with `staffId = actor.id`. `calc-prefill-wire.
test.ts` today pins the BOT source only — extend it to the three doors
(derived: every file calling `openCalcRequest(` outside `calc/service.ts`
must also call `queuePrefill(`/`enqueue(JOB_CALC_PREFILL`). Gate: only when
`sectionParts(section).customs` (a yolkira job gets no AI pass and no reply —
say so on the card form: «AI faqat rastamojkani hisoblaydi»).

### 4.7 The reason chip and the source chips (owed since #909)

`pickImportRows` already returns `reason` per pick; write it to
`calc_request_items.baza_reason` through the `saveTable` edit (a new optional
`TableItemEdit.bazaReason`, server-side only — the browser never posts it; the
import-pick path and the memory path set it, a typed baza clears it). Chips in
`items-table.tsx` (both the desktop row and the PHONE card — audit A18/A31/A32:
the phone card must print what the ✅ is about): 🧠 (memory, title «V2 ·
04.09 · VED Demo»), 📥 (import, exists), 🤖 + the reason text when
`baza_reason` is set. The seal's `breakdown.items[]` snapshot gains
`bazaReason` and `memoryItemId` (readers tolerate absence).

### 4.8 Cost cap and configuration honesty

- Every model call on this path (`analyzeIntake`, `proposeGoodsGrouping`,
  `pickImportRows`) inserts an `ai_calc_passes` row with usage; `aiPrefill`
  and the intake first ask `aiCalcBudgetLeft()` (`count(*) today <
  ai_calc_daily_limit`, one query) — over the cap: the intake degrades to the
  manual parser with the sentence «AI kunlik limiti tugadi — VED qo‘lda
  hisoblaydi», the prefill runs memory + import only (no model) and the reply
  says so. Not an atomic claim (the assistant's cap is; this one is a soft
  budget on a queue of one worker — say so in the DECISIONS entry).
- ONE definition of «AI configured»: `platform/ai/model.ts aiConfigured()`;
  replace the raw `process.env.ANTHROPIC_API_KEY` reads in `intake-ai.ts`,
  `prefill-ai.ts`, `tnved/service.ts`. `proposeGroups` rethrows
  `ai_not_configured` unchanged (audit A25) and the ✨ button is hidden when
  not configured. Model ids: keep the constants in `platform/ai/model.ts`
  (`ANALYST_MODEL`) and import them — three files hard-code the string today.
- Without a key: the whole AI half degrades to memory + import + manual parser
  with the honest «AI sozlanmagan» — the CI database has no key, so every test
  must pass in that mode too.

### 4.9 Records

`DECISIONS.md` entries (newest last; numbers after `git fetch`), a `CHANGELOG.md`
entry in Uzbek (newest first: what changed for him, test counts, red-proof
count, the ledger number 97), a `CLAUDE.md` State paragraph, and this file's
header updated to «SHIPPED» with what differed and why. Fix the stale line 3 of
`docs/VED-IMPORT-AI.md` («NOT yet built» — it is) while there.

---

## 5. Defects on this path that the feature must not inherit

From the 7-lens audit of 2026-09-04/05 (statuses as recorded; the full list
with mechanisms is in the map's «Audit findings» section). **Fix in this
round** — they make the AI's number wrong or the bot's word false:

### 5.1 Fix first

| # | What | Where | Fix |
|---|---|---|---|
| A17 (3/3) | Podklyuch/rastamojka with NO coded goods prints «Растаможка $0.00» and a bold total = freight | `pricing.ts requestCustomsFor` (vacuous `every` over `[]`) | empty group list on a customs section → `customsUsd: null`, reason `no_groups`; totals stay null |
| A2 | Group ⚙ «Сбор $» is ADDED on top of the automatic BHM fee — the fee twice | `customsFor` + `requestCustomsFor` | remove the per-group fee box from the ⚙ form and the lugatlar rates form (column stays, never written by a screen); the request-level `fee_override_usd` is the ONE fee door (give it its input, A29) |
| A25 (3/3) | No API key → ✨ says «ИИ не ответил» | `proposeGroups` | rethrow `ai_not_configured`; hide the button when `!aiConfigured()` |
| A38 | Bot's «navbatga tushmadi» names no cause | `landIntake` swallows the `CalcError` | return the code; the bot prints the sentence |
| A13 | The owner and every admin are in the auto-assign pool — a fresh bot request lands on the OWNER first | `nextVedAssignee` (`usersWithPermission('ved.docs')` includes admins) | exclude `super_admin`/`admin` ROLES from the auto-assign pool (they keep «Olaman»); **owner decision** — ask: 1) shunday; 2) per-person «hisoblash navbatida» flag on /admin/taqsimot |
| A20 | The seal never closes the VED's task — it stays red on /bugun | `sealCalc` | close the task inside the seal path («Muhrlandi»); one-off script for existing rows |
| A14 | Saving the deal's «Позиции» silently CLOSES the VED's open workspace (`completed_via='lines'`) | `deals/service.ts saveLines → completeCalcForDeal` | retire the 'lines' ending for requests that have a workspace (groups/items/rev moved); keep it readable |
| A3 | Готово «1 000» → closed with NO amount, «💵 NaN USD» in Telegram | `finishCalcRequest` | `mustBeNumber` before `endRequest`; never write `answer_currency` without an amount; parse spaces/NBSP |
| A11 | Two simultaneous «Qayta hisoblash» → two corrections both «amalda», commission paid twice | `recalcFromSealed` | the partial UNIQUE index of §4.1 + catch 23505 → `recalc_open` |
| A5 | An offer on a SUPERSEDED or EXPIRED seal is accepted server-side | `recordOffer` version branch | re-derive `currentVersionSql() AND notSupersededSql()` and `valid_until >= now()`; refuse `quote_expired`/`superseded` in words |
| A1 | Upsale paid TWICE on one job after a re-offer | `payableOffersSql` | «one payable per job» must hold ACROSS payouts: a request with a paid offer is settled, or pay the delta only |
| A56 | Four refusal codes reach the screen raw (`superseded`, `fx_missing`, `category_not_found`, `account_currency_mismatch`) | i18n | add the keys ×4 + a derived fence CalcError codes ↔ `calc.errors` keys |
| A18 (3/3) | The phone ✅ records «warnings seen» for a card that never showed the rates | `items-table.tsx` phone card | print the rates line + chips on the phone card; stamp `confirm_via='phone'` |
| A31/A32 (3/3) | Phone: bare ⚠ with no reason; ungrouped items invisible | same | print the refusal word; list ungrouped items |

### 5.2 Fix if the round has room, else record as owed

A21 (recalc mints no task, notifies nobody; the correction's seal goes to the
admin, not the seller), A22 (discount/band override not previewed before the
irreversible seal), A34 (a VED can seal a colleague's taken job), A27
(«✅ Bajarildi» on the task closes a SEALABLE job with no price), A28 (expired
seal: nobody but an admin can start the correction), A36 (the fee's UZS rate
and BHM value are not in the snapshot), A9 (band override offered on a
rastamojka-only seal), A44/A19 (who reads the floor and the client price on the
card — **owner decision**, ask: 1) sotuvchi tannarxni ko‘rsin (hozirgidek);
2) ko‘rmasin), A33 (the VED's deal board is always empty — **owner decision**,
three options in the map), A26 («База из справочника» shows no counts), A39
(the sealed breakdown is shown nowhere — the AI reply's per-line block is the
same shape; render it under `SealedPanel` from the snapshot).

### 5.3 Do NOT do

- No client-facing AI (decision 5). No AI number written as official (law 1).
- No second collector beside `calc-intake.ts`; no second queue writer beside
  `openCalcRequest`; no second table writer beside `saveTable`.
- No freight in the AI reply (decision 8). The freight tariff stays at
  `/admin/tarif`.
- No `Date.now()`-only fixture ids in tests (#598 — add a per-run counter).
- No `git checkout` to undo a red proof (#430).

---

## 6. Tests to write (the repo's proof pattern)

**Unit (no database)** — `tests/unit/`:
- `ai-ved-reply.test.ts`: the reply text for: all lines priced; one blocked
  line (words, not $0); podklyuch (freight sentence, no freight number); no
  groups (no total, the sentence); certificate false (additional duty line
  present); legend only for used sources; >25 lines collapsed; every refusal
  union member has a sentence (derive the unions from `pricing.ts`).
- `intake-line-answer.test.ts`: `parseLineAnswer` matrix (uz/ru/en units,
  bare number, comma decimal, «120кг», refusals).
- `calc-memory.test.ts` (source-shape): every item writer calls
  `itemNameNorm`; `sealedMemoryFor` excludes unconfirmed groups and the own
  request (string anchors in the SQL — the wire style of `calc-prefill-wire`).
- `calc-prefill-wire.test.ts` extended: all three doors enqueue the prefill;
  `aiPrefill` consults memory BEFORE `proposeGroups`; `prefill.ts` writes no
  `bazaSource` of its own; the reply never prints `freight`.
- `ai-advisory.test.ts`: `baza_source` set = {dictionary, typed, import,
  memory}; still no `ai`.
- `tx-pool.test.ts` must stay green (the memory read is PRE-tx; `saveTnved`
  after the seal's tx).

**Integration (real Postgres, fresh `gsr_ci`, own fixtures, deleted in
`afterAll`, run-tagged names, never the shared demo data)** —
`tests/integration/`:
- `ai-ved-memory.integration.test.ts`: seal a job with a confirmed group
  (code + baza) → open a NEW request with a similar-but-not-identical name
  («Monitor 24 dyuym» vs «monitor 24"») → `openCalcRequest` stamps the code
  from memory (`memory_item_id` set); `saveTable` sweep fills the baza with
  `baza_source='memory'` BEFORE the import fill (fixture: an import batch with
  a DIFFERENT price for the same code — the memory price must win); a
  below-threshold name gets nothing; an UNCONFIRMED sealed group is not a
  memory; the own request is excluded; `sealCalc` wrote `tnved_assignments`.
- `ai-ved-prefill.integration.test.ts` (model MOCKED — inject the pick and
  grouping functions as `calc-prefill.integration.test.ts` already does):
  landing → pass → the reply text carries the per-line block and the total,
  no freight; the lenta note exists on the card with `created_by NULL`; the
  daily cap refuses the model half and the reply says so; a request with no
  groups yields no `$`.
- The §5.1 fixes: one red-proven test each (`requestCustomsFor([])` → null;
  fee not doubled; `finishCalcRequest('1 000')` refused; second concurrent
  `recalcFromSealed` → `recalc_open` (deterministic: hold the first in an open
  tx, #873's observer through the POOL); `recordOffer` on a superseded/expired
  version refused; the seal closes the task; `saveLines` leaves a workspace
  job open; upsale not paid twice).

**E2E (Playwright, one worker, one shared database, lexical order, cleanup as a
final TEST)** — the bot itself cannot run here (no Telegram, no key): prove the
screens. `m9zw-ai-ved.desktop.spec.ts`: as VED open a request prefilled by the
integration-shaped fixture (or press ✨ on a keyless server and read the honest
«AI sozlanmagan»), see the 🧠/📥/🤖 chips, confirm on the PHONE project and
read the rates line there, seal, open the card and read the lenta note; the
phone spec asserts the chips at 360×800 and document width = viewport.

**Red proofs** by string edit, restored by string edit, each named in the
CHANGELOG: memory priority swapped with import → the price test red; the
own-request exclusion stripped → red; `no_groups` reverted → the $0 test red;
the fee guard stripped → red; the unique index dropped → the concurrency test
red; the freight line restored → the reply test red.

**Manual, in production only** (no Telegram/model here): the first real
«🤖 AI rastamojka» run — watch `docker compose logs -f app | grep calc-prefill`
and the seller's chat; a Telegram message longer than 4096 chars is refused by
Telegram, so test a 30-line invoice once.

---

## 7. Verification ritual and ship (verbatim, it catches real bugs)

1. Postgres dies between turns; a stale `postmaster.pid` after a container
   restart blocks the start — `pgrep -a postgres` first, remove the pid only
   when nothing runs:
   `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/local/pg/data -l /var/local/pg/log/pg.log -o '-k /tmp' start"`
2. `gsr_dev` = the owner's real imported data — never test on it.
   `DATABASE_URL=postgres://postgres@127.0.0.1:5432/gsr_ci` (TCP).
3. Full pipeline in CI's order, ONE database: drop/create gsr_ci →
   `pnpm db:migrate` → `pnpm db:seed` → `SEED_DEMO=1 pnpm db:seed:demo` →
   `pnpm vitest run` → `pnpm build` (`rm -rf .next/cache/eslint` first) →
   `fuser -k 3000/tcp` → `pnpm e2e` WITHOUT `CI=1`. Playwright does NOT
   re-seed. Read each gate's OWN marker; `cmd | tail && echo $?` reports the
   pipeline's code (`${PIPESTATUS[0]}`).
4. `pnpm typecheck` before every commit — vitest transpiles without checking
   and `next build` types `src/` only.
5. `pnpm lint` — the build's lint reads `.next/cache/eslint` and can serve
   pre-edit diagnostics.
6. Look at the screens: 360×800 and 1280×900, document width = viewport.
   A permission change is half-verified until a NON-admin opens it.
7. Never two vitest runs against one database at once.
8. Before minting the migration and DECISIONS numbers: `git fetch origin main`
   and re-read both tails.
9. Ship: commit (Uzbek subject; the two trailers used throughout `git log`;
   never a model identifier, key or token in any pushed artifact) → push to
   the branch you were told to use → DRAFT PR (Uzbek title, body ending with
   the standard footer) → subscribe → green → the owner says «merge qil» →
   merge → tell him in Uzbek: backup first, `git pull`,
   `docker compose build migrate app`, `docker compose up -d`, then COUNT the
   ledger: `docker compose exec -T postgres psql -U gsr -d gsr -tAc "select count(*) from drizzle.__drizzle_migrations"`
   must read **97** (his server reads 95 today; main is at 96).

---

## 8. What the owner still owes (say it to him, do not wait for it)

- The **FULL quarterly customs file** at Boshqaruv → «📥 Bojxona bazasi» —
  without it the AI has no baza source but memory and the dictionaries.
- The **NEW `ANTHROPIC_API_KEY`** in the server `.env` (the old one is burned)
  — without it the AI half says «sozlanmagan» honestly.
- The VED fills `/hisoblash/lugatlar` (bazas, price book) — nothing seals
  until then, by design; the memory grows only from seals.
- His answers to the two decisions in §5: A13 (who is in the auto-assign
  pool) and A44/A19 (who sees the floor / client price on the card).

---

## 9. The instruction to paste to the other model

> **Uzbekcha (egasi uchun):** Boshqa modelga shu ikki faylni bering:
> `docs/AI-VED-RASTAMOJKA.md` (bu spec) va `docs/AI-VED-RASTAMOJKA-MAP.md`
> (kod xaritasi), plus `CLAUDE.md`. Quyidagi matnni yuboring:

```
Sen GSR LOGISTICS reposida ishlaysan (/home/user/fullprompt). Avval CLAUDE.md
ni, keyin docs/AI-VED-RASTAMOJKA.md ni TO'LIQ, keyin
docs/AI-VED-RASTAMOJKA-MAP.md ni o'qi. Vazifa: docs/AI-VED-RASTAMOJKA.md §4
build-planini §5.1 tuzatishlari bilan birga qur — Telegram staff botida
«🤖 AI rastamojka»: sotuvchi tovar ma'lumotini yuboradi, AI tahminiy
rastamojka to'lovini (kod · baza · boj · QQS · yig'im, har qator + jami)
1 daqiqada chatga va karta lentasiga yozadi, so'rov VED navbatiga tushadi,
muhrlangan ma'lumot AI xotirasiga kiradi. Faqat rastamojka — yo'lkira yo'q.
Qonunlar §1 da; ularni buzma. Har bir tuzatish uchun avval qizil test, keyin
tuzatish; to'liq pipeline (§7) yashil bo'lmaguncha push qilma. Migratsiya
0096 — avval `git fetch origin main` va jurnalning oxirini o'qi. Egaga
faqat o'zbekcha, biznes tilida yoz; qaror kerak bo'lsa raqamlangan variantlar
ber. §5 dagi ikkita savolni (A13, A44/A19) egadan so'ra, javobigacha
§4 ni qurishda davom et.
```

> **English (for the model):** Read `CLAUDE.md`, then this file in full, then
> the map. Build §4 with §5.1's fixes; every fix red-proven first; the full
> pipeline (§7) green before any push; migration 0096 after `git fetch origin
> main`; reply to the owner in Uzbek, business terms, numbered options for
> decisions; ask the two §5 questions and keep building §4 meanwhile.
