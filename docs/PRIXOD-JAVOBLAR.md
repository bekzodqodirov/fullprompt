# Prixod javoblari — his «1 b · 2 b · 4 b» of 2026-11-12

His message, answering the seven ⭐ questions the «Prixod xabari» round sent with its result
(CHANGELOG 2026-11-11, «Savollar»):

> 1 b
> 2 b
> 4 b
> 7 egasz yuk hech kimga habari bormasin va hech kimga birik tirilmasin adminga va logistga habar kelsa yetarla

The questions as he read them:

1. Yuk qayta tortilganda (kg/kub o'zgarganda) mijozga savol **o'zi** qayta borsinmi? ⭐ a) yo'q — lot «o'zgardi»
   bo'lib ❓ ro'yxatiga tushadi, xodim «Mijozdan so'rash»ni bosadi · **b) ha, o'zi qayta so'rasin.**
2. Xodim qo'ygan ✅ (yoki yozilgan tarkib) ham kg/kub o'zgarsa «o'zgardi» bo'lsinmi? ⭐ a) yo'q, faqat mijozning
   Telegram tasdig'i · **b) ha.**
3. Yuk Xitoydan chiqib ketgandan keyin qayta tortilsa, mijozning ✅ belgisi ham olib tashlansinmi? **⭐ a) ha** — not
   answered, so the ⭐ stands.
4. Sotuvchi prixod kartasida (saytda) ham fayl **qo'sha** olsinmi? ⭐ a) hozircha faqat bot orqali · **b) ha.**
5. Fayl qo'shilganda logist/VED ga xabar borsinmi? **⭐ a) yo'q, kartada va tarixda ko'rinadi** — stands.
6. «Hisob-kitobga to'g'ri kelmadi» / «va'dadan farq qildi» ham «Prixod keldi» xabariga qo'shilsinmi? **⭐ a) yo'q** —
   stands.
7. Egasiz yuk sotuvchisi yo'q mijozga biriktirilganda adminlarga xabar borsinmi? — his sentence is not one of the two
   options. ASKED AGAIN on 2026-11-13 as 7.1 (a ⭐ as today · b admin + logist when the client has no seller · c
   always admin + logist only) and 7.2 (a ⭐ such cargo goes to the seller named later · b never into anybody's KPI).
   **Nothing of 7 is built until he answers**; «a» changes nothing, because what he described — «❓ Egasiz yuk» to
   logist + admin only, nothing attached by the system — is what the code does today (the map: follow-0/1).

The map behind this spec: a 12-agent read of the code at `b4ff5f1` (five slices, a completeness critic per slice,
six follow-ups). Its findings are cited here by `file:line` at that commit.

---

## §0 What changes, in his words

- **(1b)** Yuk qayta o'lchansa yoki qayta sanalsa va mijozga ilgari yuborilgan savol (yoki uning javobi) endi yukka
  to'g'ri kelmasa — mijozga yangi savol **o'zi** boradi, oxirgi tuzatishdan 10 daqiqa keyin. Mijoz yangi
  ma'lumotni ✅ yoki ❌ bilan tasdiqlaydi. Xodim hech narsa bosmaydi.
- **(2b)** Xodim qo'ygan «✅ To'g'ri» endi og'irlik va hajmni ham eslab qoladi: kg yoki kub o'zgarsa (ro'yxatda
  ko'rinadigan aniqlikda — kg yuzdan bir, m³ mingdan bir), lot «o'zgardi» bo'ladi. Tarkib uchun bu **hozir ham
  shunday** (tarkib aniq solishtiriladi) — tekshirildi, test bilan mahkamlanadi.
- **(4b)** Prixod kartasidagi «Fayllar»da 📎 tugmasi prixodni ochib ko'ra oladigan har kimga (botdagi «📎 Fayl
  qo'shish» kimga ochiq bo'lsa, o'shalarga) chiqadi. Sotuvchi yuborgan rasm hujjat sifatida saqlanadi (karobka rasmi
  o'rnida chiqmaydi), har bir fayl tarixda yoziladi, hech kimga xabar bormaydi (5a).

---

## §1 1b — the automatic re-ask

### 1.1 The trigger: the question the client HOLDS no longer describes the cargo

A customer's ✅/❌ is one press under one message about ONE prixod (every lot of it): `askTag` (client-confirm.ts:139)
hashes what the message printed — per lot both names, the carton count, the tarkib's goods and, for a `full`
question (0146), the kilos and cubic metres at display precision — and the press counts only while the facts read
NOW give the same tag (`answerClientAsk`, :441-447). So after a re-weigh every button the client holds answers
«Bu xabar eskirgan» — whether or not they had already answered.

The rule (ONE function, `reaskDue(facts)`, asked when the question is ARMED and again when it is SENT):

- **Q** = the newest question DELIVERED to the prixod's current owner about this prixod that carried buttons — over
  the three kinds that can: `received_cn` (the C1 push, when `clientAskOffer` gave it buttons), `lot_ask` (a person's
  «Mijozdan so'rash») and `lot_reask` (this round's). Its tag is remembered at delivery (§1.5, 0147).
- **Due** iff Q exists and Q's tag ≠ the tag of the question that would be sent now (`facts.tag`). This is exactly
  «every button the client holds is stale» — answered or not.
- **Fallback for messages delivered before 0147** (no remembered tag): due iff some lot carries this owner's FULL
  answer (`client.ofOwner && client.measures`) that no longer holds (`!client.holds`) — the 0146 comparison, read
  through `lotCheckViewsFor` (no restatement, #513). A question delivered before 0147 and never answered is NOT
  re-asked (stated: no record of what it showed).
- A BASIC answer (pre-0146, `shown_kg` NULL) is never a fallback trigger — that client was never asked a weight.

Consequences, stated:
- A re-weigh reverted inside the settle window asks nothing (the tag is back to Q's).
- A change below display precision (40.004 kg after 40.000) moves no tag and asks nothing.
- A client who was never sent a question with buttons (no linked chat at the time; C1 without buttons — >12 lots,
  a tarkib written, the switch off) is never «re-asked»: there is no «qayta». The lot reads «o'zgardi»/❓ as today and
  «Mijozdan so'rash» stays the person's door.
- His literal subject is kg/kub. The hook fires only after a write that moved the lot's stored totals (§1.3); the
  question it sends is the full question about every lot, as the person's is.

### 1.2 Where it is asked: only while the person's door would ask

The same three conditions as `askClientAboutReceipt` (client-confirm.ts:716-733), restated by CALLING the same
functions: the receipt confirmed with an owner and lots (`clientAskFacts`), a linked chat (`linkedChats`), some lot
askable (`lotCheckViewsFor(...).askable` = `lotAskableSql`: a live carton on a CN shelf, or on a truck out of China
not yet unloaded), at most `ASK_MAX_LOTS` lots and `askFits`. Anything else: no row at all (never a skipped row that
would print a ⚠ about a question nobody meant to send).

With 3a ⭐: once every carton is unloaded outside China, nothing is asked and the client's ✅ just goes (as today).
Stated precisely (the map's r3 note): «Xitoyda» in the code means «on a Chinese shelf OR on a truck out of China that
has not unloaded» — an office count at the Uzbek unload door while cartons are still on the arrived truck DOES ask.

The switch: a NEW setting `client_reask_on_reweigh` (default **true** — his «b»), described in all four bundles. Not
`client_confirm_on_receipt`, whose words (uz.json:757) say it governs the receipt push's buttons only.

### 1.3 Who arms it: the three re-weigh writers, after their commit

Only three runtime writers change an existing lot's totals (map r1b): `editLot` (✏️, edit.ts), `growLotInTx` and
`shrinkGrownInTx` (grow-lot.ts, through the count doors). Each already has a post-commit point that never throws:

- `editLot`'s `.then` (edit.ts:450-510): after the author's notice, in its own try/catch, only when `totalsChanged`.
- `afterLotGrown(lotId)` (grow-lot.ts:201-214), called by count-load after its commit (count-load.ts:625) and by
  count-accept's `finally` keyed on `grew` (count-accept.ts:471 — what COMMITTED, chunks included): the arm goes
  inside it, in its own try/catch, by dynamic import (grow-lot.ts ← lot-check.ts ← client-confirm.ts would be a cycle).

U41: nothing after a commit may throw — the arm logs and returns. Post-commit and not in the writers' transactions:
every read it needs (probe, setting, facts, chats, views) is pooled (#714), and the count transactions run under
`lock_timeout 10s` where one more statement could turn a committed count into `busy_retry`. The crash window between
commit and arm is accepted; its net is the ❓ worklist and «Mijozdan so'rash» — exactly today's ⭐a behaviour.

A derived fence (`tests/unit/client-reask-wire.test.ts`) lists every module that writes `receipt_lots`
`total_weight_kg`/`total_volume_m3` after confirm and requires each to reach the arm — a fourth writer is red the day
it is written.

### 1.4 The row: its own kind, a sliding 10-minute window

- **Kind `lot_reask`** (client_notices.kind is free text — 0076:30-32; no migration for it). Not `lot_ask`: sharing
  that row would erase who asked (`asked_by = EXCLUDED.asked_by`, client-confirm.ts:743 — the asker hears either answer
  past their mute), print «Telegram kutishni so'radi» about our own hold (`ASK_LATER_MINUTES`, :838-841), disable the
  person's 📨 for the window (client-ask-panel.tsx:153) and null the person's delivery record on a quiet skip
  (`settleArrivalNotice` writes `sent_at = NULL`, arrival.ts:454).
- **One row per (client, prixod)** by `client_notices_once`. Armed by
  `INSERT … ON CONFLICT DO UPDATE SET status='pending', send_after = now() + 10 min, attempts=0, last_error=NULL,
  claimed_at=NULL` from ANY status: pending → the window SLIDES (an office walk of several presses sends one question
  about where it ended); sent/failed/skipped → re-armed; sending → re-armed (§1.6).
- `REASK_SETTLE_MINUTES = 10` — the house's correction window (`RECEIVED_WINDOW_MINUTES`). It also keeps #834's «the
  person whose record changed hears it first»: the author's `ReceiptMeasureCorrected` goes at once, the customer's
  question ten minutes later. **#834's «never the client» is REVERSED by his 1b** (a new decision cites #834 and
  #353; edit.ts:493-495's comment is rewritten).
- `staff_notified_at = now()` on insert (every non-arrival writer does — client-claims.ts:86-88), so the arrival's
  staff sweep never reads it.
- **Not armed** while a `received_cn` or `lot_ask` row of this owner and prixod is `pending` (not yet claimed): that
  message is rendered from the facts at SEND time and will carry the new figures itself.

### 1.5 Remembering what was delivered (0147)

Two SQL-only columns on `client_notices`: `asked_tag text` and `asked_at timestamptz` — the tag of the LAST question
with buttons this row delivered and when. Written right after a successful `sent` settle (only when the settle itself
wrote — §1.6), for `received_cn` (only when it carried buttons), `lot_ask` and `lot_reask`; never cleared by a later
outcome (a re-armed row that then fails still remembers what the client holds). A pair CHECK (both or neither; the tag
is 8 hex digits). SQL-only (never on the drizzle table — `claimReceivedNotice` inserts through it inside
`confirmReceipt`'s transaction; ai-press.test.ts:319-322's rule) and probed (§4) — one migration behind, nothing is
remembered and nothing is re-asked.

### 1.6 The settle must not overwrite a re-arm

`settleArrivalNotice` and `deferNotice` write by id unconditionally (arrival.ts:385-392, 445-458): a re-arm that lands
while the row is `sending` was overwritten to `sent` and lost. Both now add `AND status = 'sending'` (`releaseNotices`
already does, :365). Behaviour-identical for every existing writer — none touches a `sending` row (the person's door
and `rearmArrivalNotice` re-arm only rows that have spoken); a late settle after a reclaim still finds `sending`.
`settleArrivalNotice` returns whether it wrote; the tag is remembered only then.

The narrow race left, stated: the sweep reads the facts AFTER a re-weigh committed and BEFORE its arm ran (ms) — the
question delivered already carries the new figures, its tag is remembered, and the re-armed row's send-time check
(`reaskDue`) finds Q's tag equal and skips it quietly. No duplicate.

### 1.7 Sending it: the preparer re-proves everything

`prepareLotReask(notice)` in arrival-jobs.ts (registered in `PREPARERS`, so `SWEPT_NOTICE_KINDS` claims it):

1. the switch is on, else quiet skip `switched_off`;
2. `clientAskFacts` — its skips as words (`receipt_changed`); owner changed → `client_changed`; too long → `too_long`;
3. a `lot_ask` or `received_cn` of this owner still `pending` → quiet `superseded`;
4. no lot askable → quiet `not_askable`;
5. `reaskDue(facts)` false → quiet `not_needed`;
6. render `askText(facts, locale, { reason: 'updated' })` — the person's question with ONE line under its title
   (client-labels.ts, uz/ru/en): uz «🔄 Yukingiz ma'lumoti yangilandi — iltimos, qayta tekshirib tasdiqlang.»,
   ru «🔄 Данные о вашем грузе обновлены — пожалуйста, проверьте и подтвердите ещё раз.», en «🔄 Your cargo details were
   updated — please check and confirm again.» — true for a weight, a volume and a count; `askFits` measures the text
   WITH the line. Keyboard: the confirm row with `facts.tag`. No photograph (the person's question has none).
7. after a `sent` settle: the tag is remembered (§1.5) and the History gets one line, actor null («Tizim»):
   `clientAsk` = «Telegram · ma'lumot o'zgargani uchun o'zi qayta so'raldi · N lot».

Quiet skips are a CLOSED list (`switched_off`, `superseded`, `not_askable`, `not_needed`): the card never prints them
as a failure (`reaskFailureOf` → null). Every other reason maps through the existing `SKIP_FAILURE` words. The skip-
literal fence (client-confirm-wire.test.ts:646-680) is extended to `prepareLotReask` with its own expected list.

### 1.8 The answer

`answerClientAsk` is unchanged except `lastAsk` (client-confirm.ts:356-364): the last question is the newest DELIVERED
of `lot_ask` and `lot_reask`; when the auto one is newer, `askedBy` = null (the system asked — nobody is told a plain
✅; a ❌ still goes to the seller and `plans.manage`, :476-480) and `askedAt` = its delivery. A person's question
still WAITING keeps today's meaning (its asker is told). Stated: a ✅ to the automatic question tells nobody — the lot
leaving the ❓ list is the news, the push's own rule.

The lot panel's attribution line: `askedBy` NULL used to mean «the receipt's own push asked»
(«'qabul qilindi' xabaridagi tugma orqali», lot-check-panel.tsx:179). It now means «the system asked» —
`lotCheck.clientViaPush` is reworded in all four bundles to be true of both (uz «tizim yuborgan savol orqali (Telegram)»).

### 1.9 The person's door and the card

- **«📨 Mijozdan so'rash» stays pressable** while an automatic question waits; a press sends the person's question now
  and stands the automatic one down (`UPDATE … SET status='skipped', last_error='superseded' WHERE kind='lot_reask'
  AND status='pending'`, in `askClientAboutReceipt` after its own arm). Two questions minutes apart never go.
- **The card's «📨 Mijozdan so'rash» block** gains ONE line about the automatic question (`clientAskCardFor` returns
  `auto: { state: 'waiting' | 'sent' | 'failed', at, failure } | null`; a quietly skipped row is `null`):
  - waiting: «🔄 Yuk ma'lumoti o'zgardi — mijozdan {when} da o'zi qayta so'raladi»;
  - sent, newer than the person's last delivered question: «🔄 Mijozdan o'zi qayta so'raldi: {when}»;
  - failed / a skip with a word: «⚠️ O'zi qayta so'ralgan savol yetib bormadi: {word}» (the closed `askFailed.*`
    words).
  New keys in all four bundles, rendered by a render test (red-proven).
- The lot lines' «… — qayta so'rang» stay: the block above says it is being asked; the lines say why the lot is ❓.
- The ✏️ lot form gains one warning line (beside the tarkib one, lot-edit-form.tsx:90-92), drawn when the lot is
  vouched by a tick or a client's ✅: «Og'irlik yoki hajm o'zgarsa — ✅ «o'zgardi» bo'ladi; mijozga savol o'zi qayta
  boradi.» ×4 (the corrector learns the consequence before pressing).

### 1.10 Count doors: the walk must be exact (the kernel fix)

A mixed lot (no per-box dims) grows and shrinks by scaling its CURRENT totals (`totalWeightKg × after / before`,
rounded to kg 3 / m³ 4 — grow-lot.ts:113-114, :289-290). Every rounding is kept, so a walk drifts: grow 10→15 then
take back one per press lands a thousandth away from where it began, and the map measured the printed figure moving
in 8-18 % of synthetic mixed lots. Under 1b that is a question to a customer about a weight nobody changed; under 2b
a lost ✅. The comment already claims «a dial up and back lands where it started» (:236-244) — it is made true:

- Every growth/shrink audit row carries `base` = `{boxCount, totalWeightKg, totalVolumeM3}`: the lot as it stood
  before the FIRST growth of its unbroken chain.
- The next growth/shrink reads the newest such row for the lot (audit_log by `(entity_type, entity_id)`, newest by its
  identity id — the lot row is locked, so the ids are in order). The chain is unbroken iff that row's `after` equals
  the lot now (count, kg, m³); then `base` = the row's `base` (or, on a row written before this change, its `before`).
  Broken (a ✏️ edit since, or no row) → `base` = the lot now.
- Totals for a count N: N = base count → the base's own figures, exactly; else
  `computeLotTotals(mixed, N, base.kg × N / base.count, base.m3 × N / base.count)`. Walk-independent: any route to N
  lands on the same figures. Uniform lots are already exact and untouched.

Pinned by a walk test (grow by 5, take back one per press; grow in three presses, take back two; a ✏️ edit between
breaks the chain) on mixed lots — `count-money` covers uniform only.

---

## §2 2b — the staff tick remembers kg and m³

### 2.1 The tarkib half is already true

`tarkibStandsSql` (lot-check-sql.ts:129-134) compares the tarkib's Σ kg and Σ m³ with the lot EXACTLY; a re-weigh
makes a standing tarkib stale. Pinned today by lot-check.integration test 12 (kg-only 1000.500, m³-only 2.5001 →
`stale`). Nothing is built; the new answers' pin file names that test.

### 2.2 The tick half

- 0147: `lot_checks.seen_kg numeric(12,2)`, `seen_m3 numeric(12,3)` — DISPLAY precision, the client's full ✅'s own
  (`lotShownKgSql` / `lotShownM3Sql`): one rule for «the figures a ✅ vouched for», the precision he was told
  (CHANGELOG 2026-11-11: «kg — yuzdan bir, m³ — mingdan bir»), both sides rounded by the DATABASE (#1708). Pair CHECK
  (both or neither, ≥ 0, `<> 'NaN'`). SQL-only (never on the drizzle `lotChecks`: tests insert through it).
- **Backfill**: every existing tick takes the lot's CURRENT display figures in the migration (the same two
  expressions), so nothing moves on deploy day and from then on every tick — old ones included — goes «o'zgardi» on
  a re-weigh, which is what «ha» asked. Stated: an old tick's figures are the deploy day's, not the tick day's (those
  were never recorded).
- The NULL arm stays (`seen_kg IS NULL OR …`): a tick written by the OLD process in the minutes between the migration
  and the restart holds on kg/m³, as a pre-0146 basic answer does.
- `checkTermsSql` gains `measures` (TRUE while 0147 is not live); `lotCheckStateSql`'s ONE `ticked` ANDs it — both
  sentence forms — so every list (stock, Σ, Ostatka, plan editor, Yuklar, homes, worklist) inherits it with no call-site
  change. `lotCheckViewsFor` selects the term into `moved.measures` AND the JS `holds` (or the card draws ✅ beside a
  lot every list calls stale).
- `checkLot`: `lockLot` also reads the lot's display figures under the lock; the posted `seen` gains OPTIONAL `kg`/`m3`
  (the strings the card printed — absent on a page opened before the deploy) compared with the locked stored totals
  (`lot_changed`); `holdsNow` compares the measures (a NULL snapshot is «says less» → the re-tick WRITES); the upsert
  writes both columns from the locked row in VALUES and in DO UPDATE SET; the History value says
  «… × 100 · 200 kg · 1.5 m³ · GS777».
- Words: `lotCheck.movedMeasures` ×4 (uz «og'irlik yoki hajm») joins the panel's `movedWords`.
- Outside China (3a ⭐ analogue): a re-weigh in Uzbekistan takes the tick's ✅ off every list and the card offers no
  re-tick there (askable-gated) — consistent with the client's ✅; stated to him.
- Unchanged: the arm order, the ❌ semantics (kg/m³ still lift no ❌), the four states, the lock order.

Docs made false and corrected: YUK-TEKSHIRUV.md:24 and §7 :151, lot-check-sql.ts:30-33 and :268-270, lot-check.ts:27-31,
schema/wms.ts:373-379, PRIXOD-XABARI.md:127, TARKIB-TAKLIFLAR.md:704 («kg and m³ are in no arm»); DECISIONS #1264 is
superseded by a new entry («2b of 2026-11-12» — «his 2b» in the code means the 2026-10-03 answer).

---

## §3 4b — the seller attaches files on the card

### 3.1 One rule, the bot's

The bot's «📎 Fayl qo'shish» is open to every reader of a confirmed, live prixod (`receiptFilesDoor`, files-door.ts),
and he was told so (CHANGELOG 2026-11-11: «sotuvchi, logist, VED, admin; skladchi — o'z skladidagi yukka»). The card's
tile asks the SAME rule: `mayAttachReceiptFile({status, voidedAt})` = confirmed and not voided — a pure predicate in
files-door.ts, used by the bot door too (one home). The card already passed `mayReadReceipt` to render. Superset of
today's tile holders (`canEdit`), so nobody loses it. The upload route already admits every such reader
(route.ts:131-139).

### 3.2 The tile is not `canEdit`

`canEdit` (page.tsx:336) also draws the ✏️ lot form, ✕ on lot photos, the rename hint, the QR switch and ✕ on EVERY
file — dead or wrong controls for a seller (#531). It stays exactly where it is. `AttachmentsPanel` gains an optional
`attachable` (default = `editable`, so the six other callers keep their meaning): it draws the 📎 tile and keys
`refreshWhenEmpty` on `!attachable`; `editable` keeps «✕ on every file». The card passes `editable={canEdit}`,
`attachable={mayAttach}`, `removableIds={ownFileIds}`. `showFiles = mayAttach || receiptFiles.length > 0`
(PRIXOD-KARTA §7.1's «no files card for a reader who cannot attach when there is nothing to list» stays true).

### 3.3 A seller's picture is a paper

The route stores a picture as a PAPER (`saveAttachment(…, { asPaper: true })`, `kind 'file'`) when it lands on an
EXISTING confirmed prixod from an uploader without `receipts.edit` — the bot's own rule (0146): a prixod's `photo`
attachments are its CARTON photos (the loader's list, /stock, the Ostatka Excel), and an invoice must never stand
there. The warehouse (`receipts.edit`) keeps adding missed carton photos as photos. The route answers `{ id, kind }`
and the panel draws what was stored; such a reader's pictures are compressed at the document grade (the tarkib
editor's), not the 0.3 MB carton grade.

### 3.4 The route refuses a voided prixod

As the bot does («Bu prixod bekor qilingan») — 403, the panel's own «Fayl yuklanmadi»; the tile is not drawn there
anyway. A receipt id that does not exist yet (the wizard's pre-binding, #180) still passes.

### 3.5 Every file added on a confirmed prixod writes a History line (5a ⭐ made true)

5a's ⭐ told him «kartada va tarixda ko'rinadi», and only the BOT wrote a History line (files-door.ts:76-77). The route
now writes one for every upload onto an existing confirmed prixod: `fileAdded:<attachmentId>` = the file name (no
«· Telegram»), action `update` (never `create`: `staffActivity` counts receipt `create` rows as receipts made),
through the one writer `recordReceiptFile` (generalised with `via`), never failing the upload. No event, no
notification (5a).

### 3.6 Fences and specs that move

`receipt-files-wire.test.ts:172-182` (the two literals); e2e `m9zzzi-prixod-xabari.spec.ts` XF tests used the seller
as «a reader who cannot attach» — they move onto a VOIDED prixod (own file with ✕, no tile; the last ✕ takes the card
away), and new assertions say the seller sees the tile, keeps the card after his last ✕, and still has no ✕ on the
office's file, no ✏️ and no lot-photo ✕ (red-proven by widening `canEdit`). Width in `ru` at 360 (#1706).

---

## §4 One migration, one probe

**0147 `prixod_javoblar`**, `when` 1785190000126 — ledger **148**:
`lot_checks.seen_kg/seen_m3` + CHECK + backfill; `client_notices.asked_tag/asked_at` + CHECK.

`lot-check-ready.ts`'s one catalog statement gains two answers (pg_attribute, as 0146's): `tick_measures`
(`lot_checks.seen_kg/seen_m3`) and `asked_tag` (`client_notices.asked_tag/asked_at`); the early return is over ALL
five flags (#1710's lesson). Readers get sync reads (`lotTickMeasuresReady()` for the sentence and the view);
writers ask the probe themselves (`tickMeasuresReady()`, `askedTagReady()` — L1-1). One migration behind: the tick
reads and writes as 0146 did, nothing is remembered at delivery, nothing is re-asked. Tests: a «0147 behind» test with
the `begin` spy (the 0146 CA-1 model), the three probe mocks gain the new exports, `lot-check-ready.test.ts`'s fixtures
the new fields.

Fences extended: the columns' namers (lot-check-wire, client-confirm-wire, ai-press), the setting's description ×4
(locales.test.ts:201-208), i18n literal keys.

---

## §5 The ⭐ that stand (3a, 5a, 6a) — pinned, not built

A pin file for the 2026-11-12 answers (the `prixod-xabari-answers.test.ts` shape): 1b, 2b, 4b by the code and tests
that hold them; 3a by `clientMeasuresHoldSql` and the new tick term carrying no country or askable term (location-free
comparison); 5a by the route and `recordReceiptFile` emitting no event and no notification; 6a by `DealDeviation` and
`ArrivalDiff` outside `ARRIVAL_ROW_TYPES` (receipt-arrival.ts:42) and `event.type !== 'DealDeviation'`
(notifications/service.ts:403).

---

## §6 Tests that must exist (each red-proven by string edit)

1b, through the REAL doors (#531 — the existing re-weigh tests write `receipt_lots` directly):
- `editLot` re-weigh after a delivered full question → a `lot_reask` row, due in ≈10 min; a second edit slides it; an
  edit and its reversal → the send skips `not_needed`; 40.004 after 40.000 → no row; no linked chat → no row; cargo
  unloaded in Uzbekistan → no row; switch off → no row; a `lot_ask` pending → no row.
- `countLoadLot` and `countAcceptLot` growth → armed; a throwing arm never fails the press (the U41 mirror of
  lot-edit-retry); count-accept armed on a refusal at chunk ≥ 1 after a committed chunk.
- The sweep sends it with the reason line, remembers the tag; `answerClientAsk` on it records `asked_by` NULL and tells
  nobody on ✅; a person's press stands it down; a re-arm during `sending` survives the settle.
- Pre-0147 fallback: a full ✅ that no longer holds and no remembered tag → armed.
- The kernel walk is exact on mixed lots.
- Card render: the three automatic lines; the ✏️ form's warning.
2b: lot-check.integration test 5 INVERTED (kg alone, m³ alone, the self-heal back, sub-display stays ✅); tests 2/3/4
gain `measures: false`; test 13's oracle gains the new term (and the 0146 client term it already lacks); a NULL
snapshot holds; a re-tick over a NULL snapshot writes; the panel names the weight.
4b: as §3.6; the route stores a seller's picture as `file` and writes the History line; refuses a voided prixod;
pre-binding passes.

---

## §7 Not built, stated

- 7 — waits for his 7.1/7.2.
- A question delivered before 0147 and never answered is not re-asked after a re-weigh (nothing recorded what it
  showed).
- No reminder when a client never answers the automatic question (one question per change, never a nag).
- A tarkib written or changed later does not ask the client by itself (not a re-weigh; «Mijozdan so'rash» as today).
- The crash window between a re-weigh's commit and its arm (net: the ❓ worklist and the person's door).
