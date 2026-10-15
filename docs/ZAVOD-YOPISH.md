# Zavod reysi — yopilish, prixod qatorni eslab qoladi, packing listda reys nomi

Agreed with the owner 2026-10-15. This is the spec AND the build plan; it is
read by the packages that build it. The original factory-pickup round is
DECISIONS #1002-#1008 (migration 0100).

## 0. His words

> «zavot partiyalarni yuklagandan keyin qabul qilib olsa ham keyinchalik yana
> reyslar chiqib qolyabti bug topildi shunday. korib chiq va nega unday
> bolayotganini men bn maslahatlashib ayt»

Diagnosis sent, his answers:

> «1a 2a 3a 4a 5a
> 6 men yukni zavotdan kelgan deb qabul qilib olaman deganimda oldin qabul
> qilgan reyslarim yana chiqib qolyabti. va packinglistlarni skachat qilib
> olaman degandimda shu skladda qabul qilingan deb chiqib qolyabti u esa
> excelda ham boshqa joyda ham shu mashinada kelgan yuk bolib koirinishi kerak
> shu zavotdan shu mashinada kelgan deb
> 7 ha»

| # | Question | His answer |
|---|---|---|
| 1 | When does a trip close? | **a** — by itself when every line is received, plus a logist «Reysni yopish» button (with a reason) for lines the factory never gave |
| 2 | A closed trip's prixod is voided later | **a** — the trip stays closed |
| 3 | Cargo received through the ordinary form while its owner has a trip heading here | **a** — the receive screen asks «Bu yuk ZR-… reysidan keldimi? Ha / Yo'q» |
| 4 | «Biriktirilmagan prixod» search | **a** — only while the trip is open |
| 5 | Truck paid elsewhere | **a** — a «xarajat yo'q» mark with a reason |
| 6 | Where he saw it | the receive screen («Zavoddan kelayotgan yuk») shows trips he already received; **and the packing list says «Принято на складе / Received here» — it must say, in Excel and everywhere else, that the cargo came on THIS truck from THIS factory** |
| 7 | A read-only server check for factory cargo received twice | **yes** |

## 1. Why it happened (proven on a throwaway db, 2026-10-15)

A trip had no «finished» state, and «is this line received» was recomputed on
every read by matching the line's client id or marking text against the
prixods linked to its stop — with no time bound. So:

| Probe | What happened | Where the trip came back |
|---|---|---|
| S2 | marking line received unclaimed → office assigned the client | /receive list, status «yetib keldi», fold opens itself; **«Qabul qilish» offered again and a SECOND receipt of the same cargo was accepted** |
| S3 | the linked prixod voided | /receive list |
| S4 | line says marking, receipt typed under a client code | never leaves the /receive list |
| S5 | fully received trip, same client gets other cargo later | logist home «N tasida biriktirilmagan prixod» (one new prixod lit up three old trips) and the card's candidates |
| S6 | received through the plain form, no link | trip stays «yo'lda»: /receive list, /zavod «Faol», map |
| S7 | 50 finished trips at a warehouse | a NEW truck never reaches the /receive list (oldest 50 read before the finished ones are dropped) |

And the agent sheet files factory cargo under `DOC.receivedHere`, because the
arrival rule (`documents/arrivals.ts`) names a truck only for a `batch`
movement and a receipt landing is `cause='receipt'`.

## 2. The model

### 2.1 Status: a fifth value `closed`

`pickups.status ∈ planned | on_road | arrived | closed | cancelled`.
`closed` is terminal and never reopens (his 2a). A fifth value and not
`arrived + closed_at`, because the readers that caused the bug list states
with `IN (…, 'arrived')`, and under a fifth value they drop closed trips with
no edit (the /receive list, the unlinked count, `pickups_live_idx`,
`arriveInTx`). Every reader written `!== 'cancelled'` / `=== 'arrived'` is
listed in §4 and edited.

New columns on `pickups` (0133):

- `closed_at timestamptz`, `closed_by uuid → users` (nullable),
  `close_kind text ∈ ('auto','manual')`, `close_reason text`.
  - `(status = 'closed') = (closed_at IS NOT NULL)`,
    `(closed_at IS NULL) = (close_kind IS NULL)`.
  - a manual close carries a reason of 3..500 characters; an auto close
    carries none.
- `no_cost_at timestamptz`, `no_cost_by uuid → users`, `no_cost_reason text`
  — the «xarajat yo'q» mark (his 5a), paired, reason 3..500.

### 2.2 A prixod remembers the lines it answers

Side table (a side table and not a column: 45 whole-row reads of `receipts`
would 42703 on a deploy morning one migration behind — 0132's reason):

```sql
pickup_line_receipts (
  line_id    uuid NOT NULL → pickup_lines(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL → receipts(id)     ON DELETE CASCADE,
  created_by uuid → users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_id, receipt_id)
)  + index on receipt_id
```

**A line is ANSWERED when a LIVE (not voided) receipt is in this table for
it.** One predicate, one home (`lineAnsweredSql` + the TS fold in
`stopsFor`), read by: the /receive list, the receive prefill, the door
question, the candidates, the home count, the card, the auto-close, the
checker script. Nothing recomputes «received» from owner text any more.

Owner text is still used once — to DERIVE which lines a receipt answers at
the moment it is linked, when nobody said explicitly. The owner rule, one
home (`lineOwnerMatches` in TS and `ownerMatchSql` in SQL, pinned equal by a
test): a client line matches a receipt of that client; a marking line
matches a receipt whose `unclaimed_marking` equals it (trimmed,
case-folded) **whether or not a client has since been assigned** — a claimed
receipt keeps its marking (#… round 98), and today's `!receipt.clientId`
clause is exactly probe S2.

The memory is written in the same transaction as the link, by exactly three
writers in `pickups/service.ts`:

1. **`confirmReceipt`** (the receive door) with `pickupStopId` and, new,
   optional `pickupLineIds`.
2. **`linkReceiptToStop`** (the receipt card's control and the trip card's
   candidate buttons) — attach, move or detach.
3. The migration's backfill (§6).

Rules (all inside the transaction, after the trip row is locked FOR UPDATE):

- **Explicit ids** (from the /receive list's prefill or the door question's
  «Ha»): every id must be a line of THIS stop (`line_not_on_stop`), and none
  may already be answered by a live receipt (`line_answered`). The receipt's
  owner is NOT compared — an operator who received a marking line under the
  client he knows it belongs to (probe S4) answered that line.
- **No ids** (an old phone bundle, a stale draft, the card controls): the
  lines of the stop whose owner matches the receipt are L, the unanswered
  ones U. L non-empty and U empty → `line_answered` (the double receive).
  Otherwise answer U — which may be empty when the receipt's owner has no
  line on the stop: the cargo is linked to the factory as extra cargo and
  answers nothing (the card lists it under «qatorga mos kelmagan»).
- A detach deletes the receipt's rows. A move deletes them and derives anew.
- A void or annul leaves the rows (history); the receipt is no longer live,
  so on an OPEN trip its lines become unanswered again (the cargo still needs
  a prixod), and on a CLOSED trip nothing happens (2a).
- `assignReceiptClient` and every other receipt edit leave the rows alone —
  which is the fix.

### 2.3 Closing

- **Auto (1a).** After any memory write, in the same transaction: a trip in
  planned/on_road/arrived with at least one line, every line answered → `closed`,
  `close_kind='auto'`, `closed_by` = the presser, audited `status_change`.
  A trip with no lines never auto-closes.
- **Manual (1a).** «Reysni yopish» on the trip card: `plans.manage`
  (PICKUP_WRITE), reason required, allowed from planned/on_road/arrived (a
  truck that went and brought nothing, with a cost already entered, can only
  end here — cancel refuses a costed trip). The form lists the unanswered
  lines read-only and carries the optional «Xarajat yo'q» tick + its own
  reason (5a).
- **Closed never reopens (2a).** Refused on a closed trip: collect, lines
  edit, add/remove stop, header edit, «Yetib keldi», cancel, attach a
  prixod, the receive prefill, the door question, receiving with its stop.
  Allowed on a closed trip: costs (the bill comes after the truck), the
  «xarajat yo'q» mark, the stamp attachments, and DETACHING a prixod (a
  wrong link must stay correctable; the trip stays closed).

### 2.4 «Xarajat yo'q» (5a)

Set with a reason, or cleared, by whoever may enter the truck's cost
(`costs.enter_batch` at the destination — the logist holds it). Refused
while a live cost exists (`has_costs`). A cost added after the mark wins
silently (the warning predicate is «no live cost AND no mark»; the card
shows the mark only while there is no cost). The no-cost warning — home
row, list chip, card banner — reads `status IN ('arrived','closed') AND no
live cost AND no mark`. The card's own count is `costs.length +
costOthers.count` (a VED sees only his own entries — the pre-existing false
banner).

## 3. The receive door asks (3a)

Route `GET /api/receive/pickups?warehouseId=…&client=<uuid>|marking=<text>`
(`receipts.create` in scope of the warehouse, else 403; `no-store`, and
NetworkOnly in `sw.ts` — a cached answer would offer a line answered
yesterday). Answer: open stops heading to that warehouse with UNANSWERED
lines of that owner — `{ results: [{ pickupId, code, vehiclePlate, stopId,
seq, factoryName, collected, lines: [{ id, goods, factoryBoxes, driverBoxes,
weightKg, volumeM3 }] }] }`, collected stops first then newest, cap 10.
Errors → `{ results: [] }` logged `[receive-pickups]`.

Wizard:

- Asked when the draft has a warehouse, a client or a marking, no stop, and
  the owner is not the one «Yo'q» was answered for. Client → at once;
  marking → debounced 400 ms. Silent on failure. NEVER part of the confirm
  gate.
- «🏭 Bu yuk ZR-00012 reysidan keldimi?» — one row per stop (factory · goods
  · N 📦), a «Ha» per row, one full-width «Yo'q».
- «Ha»: links the stop with its lines (`pickupLineIds`), and if the draft is
  pristine builds one lot per line exactly like the prefill (one helper for
  both). «Yo'q» / the chip's ✕ record the owner as declined for this draft.
- The /receive list's prefill carries the line ids too.
- A warehouse change clears the link (the stop heads somewhere else). A
  client change KEEPS it (explicit ids answer the lines whoever owns them —
  probe S4's case).
- The wizard renders refusal codes by their first segment
  (`error.split(':')[0]`) — the existing `pickup_invalid` sentence has never
  rendered because the code arrives as `pickup_invalid: wrong_warehouse`.
  New sentences: the trip is closed, this cargo is already received.
- The receive action revalidates `/receive` and `/zavod`.

## 4. Every reader of a trip's state

| Reader | Today | Now |
|---|---|---|
| `incomingForWarehouses` (/receive) | planned/on_road/arrived, oldest 50, finished dropped in JS AFTER the limit | same states AND an unanswered line exists — in SQL, before the limit |
| `receivePrefillFor` | refuses cancelled | refuses cancelled and closed; carries line ids |
| `pickupCandidates` (card) | any non-cancelled trip; any receipt of a line owner since the first «olindi» | open trips only (4a); only receipts whose owner matches an UNANSWERED line; the SQL is one fragment shared with the home count |
| `pickupAttentionCounts` | noCost `= 'arrived'`; unlinked on_road/arrived, any later receipt | noCost `IN ('arrived','closed')` minus the mark; unlinked through the shared candidate fragment (closed drops out) |
| `stopOptionsForWarehouse` (receipt card picker) | non-cancelled, includes finished trips | open trips only (the page still prepends the current stop) |
| `listPickups` / `/zavod` tabs | live, arrived, cancelled, all | live, arrived (= arrived, still open), **closed**, **xarajatsiz** (arrived∪closed, no cost, no mark), cancelled, all |
| home row `logist-flow-pickups` | links `?holat=arrived` | links `?holat=xarajatsiz` when noCost > 0, else `?holat=arrived` |
| card `live` | `!== 'cancelled'` gates everything | `open` (planned/on_road/arrived) gates trip edits, candidates, ETA, map link; `costable` (`!== 'cancelled'`) gates the cost panel |
| `markArrived` | writes a false audit row on a closed trip | refuses closed |
| `cancelPickup` | could cancel a closed trip | refuses closed |
| `assertStopReceivable` | unlocked read; accepts closed | locks the trip FOR UPDATE; refuses closed |
| `refreshLegs` | every non-cancelled trip | skips closed |
| `pickupsForMap` | planned/on_road | unchanged |
| `pickups/notice.ts` | skips cancelled | unchanged (sent at the press, before any close) — stated |
| `costs/actions.ts` add/void | refuses cancelled | unchanged — a closed trip takes its bill |

`PICKUP_STATUSES` is exported and pinned by a unit fence to the latest
`pickups_status_check` and to `pickups.status.*` in all four bundles (a
missing key throws at render, #163); the tabs likewise.

## 5. «Shu zavoddan, shu mashinada» — the arrival names the trip (6)

`documents/arrivals.ts` answers «which truck brought this lot HERE». A
receipt landing whose receipt is linked to a stop of a trip **whose
destination is this warehouse** now names that trip. Same single query: the
landing CTE, `landedHereSql` and `landingInstantSql` are untouched (every
«when» stays byte-identical); the outer select LEFT JOINs receipts →
pickup_stops → pickups (dest guard) → factories for `cause='receipt'`
landings. The dest guard keeps `grow-lot`'s cartons born at the truck's
origin from being called factory cargo there. Pickup status is not filtered
(a closed trip keeps naming its cargo).

- `ArrivalSource = {kind:'batch', id, code} | {kind:'pickup', id, code,
  factory, plate, destWarehouseId}`; `LotArrival` gains `sources` (parallel
  to `codes`, earliest first) and `labels`. `codes` now includes the trip
  code; `batchIds` stays batch-only (it feeds `cargoTrucks`), and every
  index-pairing of codes with batchIds moves to `sources`.
- One label home `arrivalLabel(source)`: a batch prints its code; a trip
  prints `ZR-00012 · <factory> · <plate>` (plate omitted when unknown).
- `groupByArrival` keys a block on `kind:id`, not the code string.
- **Agent sheet (the packing list he downloads):** a trip block's heading
  is `Заводской рейс / Factory pickup: ZR-00012 · <factory> · <plate> ·
  <date> · <totals>`; the row cell prints the label. The two arrival columns
  stay where they are (photos start at column 8). `receivedHere` stays for
  genuine walk-ins.
- Plan view, plan editor, /stock and its XLSX, the staff bot: print the
  labels. The client card «Yuklar»: a trip arrival links `/zavod/<id>` when
  `mayReadPickup`.
- Not changed, stated: at the NEXT warehouse (Kashgar) the arrival is the
  Yiwu→Kashgar truck, as it is for every cargo; the factory is still on the
  prixod's card. The batch-only readers (`ARRIVED_ON_A_TRUCK`: cabinet
  customs/legs, calc actuals, count-accept) are untouched.
- Disclosure, stated to him: the agent sheet leaves the company and now
  carries the factory's name and the truck's plate.

## 6. Migration 0133 `pickup_close` and the backfill

ADDITIVE: the CHECK widens, columns and one table are added, nothing
existing changes meaning. Not granted to `gsr_ai_reader` (stated in the
header). Backfill, between comment markers so the test can run the
migration's own statements in a rolled-back transaction:

1. memory rows for every linked receipt (live and voided) × the lines of its
   stop that its owner matches (the kept-marking rule) — `ON CONFLICT DO
   NOTHING`;
2. close every trip in planned/on_road/arrived with ≥1 line whose every line
   is answered by a live receipt: `close_kind='auto'`, `closed_at` = the
   latest answering receipt's `confirmed_at`, `closed_by` NULL.

Trips left open by the backfill (a line the factory never gave, probe S4's
mismatches, a voided prixod) appear on the «Yetib kelgan» tab for the logist
to close by hand — listed by the checker.

## 7. The checker (7)

`src/modules/wms/pickups/double-received.ts` (the query, integration-tested)
and `scripts/zavod-tekshir.ts` (prints, Uzbek, read-only pool via
`default_transaction_read_only=on`, prints the ledger count first). Run on
the server — no `package.json` entry, because any `package.json` edit
re-downloads every package on the next deploy (#1228):

```
docker compose run --rm migrate pnpm exec tsx scripts/zavod-tekshir.ts
```

Three lists: (1) lines answered by MORE than one live prixod — cargo
probably received twice (trip, factory, owner, goods, factory count, each
prixod's number · date · boxes); (2) open trips with unanswered lines (what
the logist should close or receive); (3) live prixods linked to a stop that
answer no line. Exit 0 whether or not it finds anything.

## 8. Packages

| Package | Owns |
|---|---|
| P1 core | 0133 + schema, `pickups/service.ts` (close, mark, memory, predicates, readers), `confirmReceipt`'s stop branch, `linkReceiptToStop`, /zavod list + card + forms + actions, receipt card control, home row, i18n `pickups.*`, integration + unit + backfill tests |
| P2 door | the route, the wizard question + line ids + error rendering, `sw.ts`, the receive action's revalidation, e2e |
| P3 arrivals | `documents/arrivals.ts` and every «which truck» consumer, DOC labels, tests |
| P4 checker | the module, the script, its integration test, `docs/UPDATE.md` section |

## 9. Stated, not built

- No reopen of a closed trip, by design (2a). A wrong manual close is
  answered by receiving the late cargo as an ordinary prixod.
- No line chooser on the card controls: a link answers all of that owner's
  unanswered lines on the stop, as before.
- The cabinet's per-handover legs do not show a «Zavod → Yiwu» leg.
- At later warehouses the arrival names the truck that brought it there,
  not the factory.
