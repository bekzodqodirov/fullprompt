# Yuk ma'lumoti tekshiruvi — «✅ tekshirildi» belgisi

Agreed 2026-10-03. His request, verbatim: «yuk malumoti toldirildi degan znacok
yani state kerak boladi logist klientga chiqib soradi 100 karobkangiz keldi
undan klaviatura ekan togrimi agar togri bolsa check qoyadi va bu sklad
ostatkani korganda va plan berganda korinib turishi kerak … filterlash imkoni
bolishi kerak … malumoti olinmagan prixod bolsa uni filter qilib korib qaysi
prixodlarda malumot yoq shunga qarab malumot toldirish imkoni».

His answers to the five questions: **1a 2b 3a 4a 5b**. The same message
added «ostatkada yashiklar kop bolsa uzun yashiklar korinib qolyabti
colapsable bolsin» (§9).

## 1. The answers, as rules

| # | Question | Answer | Rule |
|---|---|---|---|
| 1 | Who ticks | **a** — logist + admin, AND the VED | `mayCheckLot` = the lot tarkibi door `ved.docs ∨ plans.manage` (`mayOpenBatchVed`), plus `mayReadReceipt`. No new permission code (#170). |
| 2 | What ✅ vouches for | **b** — goods name + carton count + client | The tick SNAPSHOTS `product_name_zh`, `product_name_ru`, `box_count`, `receipts.client_id`; any of them moving reads ⚠ «o'zgardi — qayta so'rang». kg/m³ re-weighs do NOT un-tick. |
| 3 | Tarkib with the client's document | **a** — counts as ✅ «hujjat bo'yicha» | DERIVED, never written: a lot whose composition stands (not `isStale`) is checked. Clearing the composition takes it away by itself. |
| 4 | Which cargo is on the ❓ list | **a** — only cargo standing in a CHINESE warehouse | «Askable» = the row's warehouse `country = 'CN'`. Cargo in Uzbekistan shows ✅ when checked and nothing otherwise — on every surface, the prixod card included (there «askable» = any live carton still in China: on a Chinese shelf, or on a truck out of China that has not unloaded, `lotAskableSql`). |
| 5 | Telegram ✅/❌ on the client's «yukingiz keldi» | **b** — later | Not built. Owed to him as a later round. |

## 2. Grain: the LOT, spoken as the PRIXOD

Both screens he named are lot-grained (/stock = lot × warehouse,
`plannableStock` = lot at the origin), the call vouches for one lot's name and
count, and the lot tarkibi is per lot. His data carries 1.0 lots per receipt
(#563), so a per-lot state reads «per prixod» on nearly every row; the screens
COUNT in prixods (`count(DISTINCT receipt_id)`). A prixod whose lot A is
checked and lot B is not appears under both filters — «some lot is unchecked»
is exactly what he must fix.

## 3. Data — migration 0123 `lot_check`

```
lot_checks (
  lot_id         uuid PK → receipt_lots ON DELETE CASCADE,
  seen_name_zh   text NOT NULL,
  seen_name_ru   text,                 -- NULL, never '' (the lot column's own idiom)
  seen_box_count integer NOT NULL > 0,
  seen_client_id uuid NOT NULL,        -- a remembered value, deliberately NO FK
  note           text ≤ 500,
  checked_by     uuid NOT NULL → users,
  checked_at     timestamptz NOT NULL DEFAULT now()
)
```

One row per lot = the PERSON's confirmation (basis «mijoz»). The tarkib basis
is not a row: it is the composition itself, read through its own staleness
rule — so `saveComposition`/`clearComposition` stay untouched, a half-applied
deploy cannot break the shipped lot tarkibi, and there is no pair rule to keep
(#528). The current check lives in the row, its history in `audit_log`. Not
granted to `gsr_ai_reader` (deny by default, the 0122 precedent).

## 4. The ONE state sentence — `receipts/lot-check-sql.ts`

Every reader LEFT JOINs `lot_checks lc` and the derived per-lot composition
sums `lot_tarkib` (one grouped subquery over `lot_compositions` ⋈ lines), then
asks one CASE:

1. `checked` — the composition stands (`seen_box_count = box_count` AND Σ kg =
   lot kg AND Σ m³ = lot m³, the SQL twin of `isStale`, pinned against it by a
   test), OR the person's row matches the lot on all four terms;
2. `unclaimed` — no client: nobody to ask (it has its own list, /unclaimed);
3. `stale` — a row or a composition exists and nothing matches;
4. `none`.

`checkFilterSql`: `ha` = `checked`; `yoq` = `none|stale` AND the row stands
in a CN warehouse. Absent = everything. The rows, the Σ, the chip counts and
the XLSX read the same fragments (#513). A JOIN, never a correlated subquery
in a WHERE (the design review measured that shape at 3.3 s against 41 ms),
and the filter applies AFTER grouping (HAVING) — as a WHERE the planner
misjudged it at ≈1 % and walked every lot ever received (the build review).

**A server whose migration has not landed (#472)** runs every list in its
pre-0123 shape: `lotChecksReady()` (one catalog probe, remembered once true)
says the tables are missing, `withLotCheckJoins` makes no joins, the state is
NULL (no chip, never ❓), `tek` is ignored and the filter row is not drawn.
Planning, Ostatka and its XLSX keep working — measured on a copy whose
ledger is 123.

## 5. The writer — `receipts/lot-check.ts`

`checkLot({lotId, seen, note})` / `uncheckLot({lotId})`, the only writer of
`lot_checks` (derived fence). On the pool: the door, the lot and prixod, a
confirmed prixod with a client (`no_client`, `receipt_not_confirmed`). In one
transaction: the lot `FOR NO KEY UPDATE` (the composition's prefix, so no
cycle with `editLot` and the count doors) → the prixod `FOR SHARE NOWAIT`
(raw, #1174) → re-read status + client → compare the posted snapshot with the
LOCKED values (`lot_changed` — a person cannot confirm a name they did not
see; '' and NULL are one value) → the check row `FOR UPDATE`, compared with
the one the panel DREW (`seenCheckedAt` = `checked_at::text`; `check_changed`
— a colleague confirmed or undid meanwhile, so a press never replaces or
erases a confirmation it did not see; the same person's same press is a
no-op, never a refusal) → upsert → one audit row on the prixod, keyed PER
LOT (`lotCheck:A` / `lotCheckNote:A` — the History nets a sitting per key,
and a shared key turned «ticked A, B, C» into one line about C), value
`A: 键盘 (Клавиатура) × 100 · GS777` so a re-check after a rename differs.
`uncheckLot` takes the same token and refuses a non-confirmed prixod (a
voided one is off every shelf; its row stays as history).

## 6. Surfaces

- **Prixod card** — per lot, under «N 📦 · kg · m³», for everyone who opens
  it: the face (✅ mijoz tasdiqladi · who · day · note / ✅ hujjat bo'yicha /
  ⚠ what moved / ❓ / egasi aniqlanmagan). ✅ wherever the lot stands; ⚠ «qayta
  so'rang», ❓ and the button only while a carton is still in China (4a); a
  basis that went stale while the OTHER holds is a muted history line, never
  «ask again» about a lot every list calls ✅. For `mayCheckLot` on a
  confirmed prixod with a client: the client's phones (📞 + 💬 Telegram — the
  reader passed `mayReadReceipt`, which is the bot's «cargo in reach» rule),
  «✅ To'g'ri — mijoz tasdiqladi» with an optional note, «Bekor qilish», and
  one line saying where the two other answers go (rename → the ✏️ below for
  `receipts.edit` holders, «logistga ayting» for the VED, whose card draws no
  ✏️; mixed → 🧩 tarkib). `?qaytish=/stock?…` makes the back link return to
  the filtered list.
- **/stock** — the chip as a SIBLING after the code cell's link (never an
  `<a>` inside an `<a>`), linking to the lot on the prixod card with the way
  back; a filter row of links «Hammasi · ✅ N prixod · ❓ M prixod» on its own
  wrapping line; `tek` survives 🔍, sort, paging, views and the export.
- **Ostatka XLSX** — export-always «Tekshiruv» column, honours `tek`.
- **Plan editor** — the chip in the code cell (a new-tab link for ❓/⚠, so the
  plan in progress survives; coming back to the tab re-reads the list in
  place, so the tick made there shows without losing the plan); crates «✅»
  only when every member lot is checked, else «❓ n/m» on a CN origin; a
  render-only filter (the selection and the Σ are never filtered), «k ta
  tanlangan yashirin», «mos yuk yo'q» (crates counted); a list that did not
  load is said, never drawn as an empty warehouse.
- **Client card «Yuklar»** — the chip on the China rows (one call covers all
  of a client's cargo).
- **Logist and VED homes** — «❓ Tekshirilmagan yuk (Xitoy)», N with «N prixod»
  under it → `/stock?tek=yoq` (the same number the screen's chip prints).
- **/stock «Hammasi»** is `/stock?tek=`, never a bare `/stock` — a bare visit
  redirects to the person's saved default view, and a ❓ worklist saved as
  the default would make «Hammasi» unreachable.

Not in v1, stated: the truck card's tabs (Bojxona tab chip), the staff bot,
the client cabinet, the /receipts list.

## 7. What resets, and what does not

Nothing hooks a writer; staleness is DERIVED (the lot tarkibi §7 house rule).
A rename (zh or ru), a count change (`editLot`, the QR-siz count growth, its
take-back — which SELF-HEALS back to ✅), or a new client turns a person's ✅
into ⚠. kg/m³/dims, notes, moves, trucks, deal links: untouched. A
composition's ✅ follows `isStale`. Void/annul take the cartons off every
shelf screen; the row stays as history.

## 8. Never

- A check never blocks a plan, a load or a handover (he asked for visibility
  and a filter; the house rule is flag, never lock).
- The stock and plan screens never learn the composition's LINES — only
  «✅ hujjat bo'yicha».

## 9. The crate list on /stock folds

`CrateRows` is a native `<details>`: open when there are at most five crates,
closed above that, its summary carrying the count and «⚠ sig'magan · N» (with
«+» when the list is capped) — so the warning he asked to have on top is
still on top while folded. One component, both screens (the truck card reads
the same list).
