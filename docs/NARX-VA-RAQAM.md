# Mashina narxi har bitimga bir jadvalda + bekor qilingan partiya raqami

Agreed 2026-11-08. His two reports:

1. «1 mashinada 1 clientda 10 15 ta prixoda va har birida bitim bolsa narx berishda faqat 1 dona bitim tanlaydigan bolib qolgan»
2. «partiya nomlarida … yw10 keyin u bekor qilinsa yw10 qolyabti lekin ozi yolga chiqmagan biz esa 10 11 qilib mashina sonini hsoblaymiz»

His answers, verbatim: **«1a 2a 3a 4a 5a 6a 7a 8a»** to the eight questions below (each «a» was the ⭐ default).

| # | Question | His «a» |
|---|---|---|
| 1 | How is a 15-deal client's truck price entered? | One TABLE on the truck's «Narx» tab: one row per deal of his on the truck (plus «Bitimsiz» when some of his cargo there has no deal), each with its own amount box, ONE «Saqlash». For the owner and the accountant each row is pre-filled with that deal's own sold price for its cargo on this truck. |
| 2 | Who prices trucks; may they see the sold prices? | Usually the accountant / admin (pre-filled). The VED, who may not see client prices (law 4), types the amounts himself; nothing is pre-filled for him. |
| 3 | May a save leave some deals without a price? | Yes. A blank deal stays loud «narx yo'q» in «Bu mashinadagi narxlar» and on the deal card. The counter rule does not change. |
| 4 | YW-010 cancelled before it left, YW-011 not opened yet: does the next truck get 010? | Yes. The cancelled one is renamed «YW-010 (bekor)» and stays in the archive. |
| 5 | YW-010 cancelled after YW-011 already exists? | The gap stays; the cancel SAYS so: «raqam qaytmadi: YW-011 allaqachon ochilgan». |
| 6 | Fix a wrong destination without cancelling? | Yes: change the destination of a truck that has not left (same truck, same number), and a one-line confirm on the quick batch («YW → Toshkent, yangi partiya ochilsinmi?»). |
| 7 | Trucks cancelled before this round? | A dry-run list per warehouse read to him first; then only the TRAILING cancelled, never-departed numbers come back; gaps in the middle stay; a truck ticked «agentga yuborildi» keeps its number. |
| 8 | What does «YW-10, 11» count? | Every truck that left that warehouse, internal legs included — today's behaviour, no change. |

Research behind it: the code maps of both problems (file:line) were read
before the questions were asked; the facts this spec relies on are cited inline.

---

## Part 1 — «Narx» tab: one row per deal, one save

### 1.1 What is wrong today

- A truck may carry any number of a client's prices; nothing limits it
  (only `client_transactions_fx_anchor_uniq` is unique). Q8 «c» (#1512-#1516)
  made every press choose ONE deal (`TruckDealSelect`, `name="dealId" required`).
- For 15 deals that is 15 presses, each stopped by a confirmation
  (`choiceAsks = question !== null && shown !== ''`, pricing-form.tsx:145),
  each followed by a full redraw of the tab.
- From the 2nd press on, the confirmation ALSO says «… allaqachon narx bor:
  … Bu narx qo'shimcha hisob bo'ladi» (`pricedHere.length > 0`,
  pricing-form.tsx:243) — about the correct next deal's part, which is not an
  extra bill at all. e2e m9zzzg pins that false line as intended.

### 1.2 What is built

**The screen (`batches/[id]/pricing`).** When `DealCandidates.ambiguous` (two
or more of the client's OWN deals ride the truck), the client's row no longer
draws the single-deal `PricingForm`; it draws `PricingTable` (new, client
component, same folder):

- One shared **date** (Tashkent today, editable, `max={latestTxDate()}`) and
  one shared **currency** (USD first) on top — a press is one moment in one
  currency.
- One row per own deal, in the order the select used (unpriced here first,
  then by deal code), then «Bitimsiz» when `question.none`. Each row:
  - the deal's label as the select drew it (`code · goods · pct % · m³ · kg`,
    ⏳ for a live «muddat»); «Bitimsiz»'s own words;
  - beside it what already stands: «bu mashinada: $a» (the deal's live
    prices here, summed) / «bitim kartasida narx bor» (`unpricedDealsOf` →
    `card`) / «butun yukka narx bor» (`whole`) — muted, read-only;
  - its amount box (controlled, never disabled, #171/#377), `inputMode=decimal`,
    read through `parseTypedMoney` like every price door.
- **Pre-fill (his 1a/2a):** only for the quote sight (`dealPriceSight`), only
  while the currency is USD, only for a deal row that has NO price of its own
  here, is NOT `card`, and only when no `whole` price stands (each of those
  would make the pre-fill a second bill by default). Value =
  `expectedByDeal[deal]` to the cent. The «Bitimsiz» row is never pre-filled
  (it has no quote). A pre-filled value the person has not touched is cleared
  when the currency leaves USD (a dollar figure in a som box is a wrong
  price); a touched one stays.
- One button «🧾 Saqlash». Blank rows write nothing (his 3a). A press with no
  filled row is refused in the browser and on the server (`deal_parts_empty`).

**One confirmation per press, only when there is something to ask** — never
«is this deal's part this deal's part» (each row names its deal):

- `secondBill` — the client's cartons aboard already priced on an earlier
  truck (unchanged rule, #1243-#1246);
- **extra bill, per ROW** — a filled row whose deal already has a live price
  on this truck; the «Bitimsiz» row when a no-deal price already stands; every
  filled row when a `whole` price stands. This is the false-line fix: a row
  whose deal has nothing here is never called an extra bill;
- the 5 % deviation, per row, quote sight + USD only, against that row's
  `expectedByDeal` (`needsConfirmation`);
- ⏳ the rows whose deal carries a live «muddat» (the price lets that deal's
  cargo through the handover — said, as Q8 said it);
- every line names its deal code; a «Jami: N ta bitim · $X» line heads the
  alert when it shows.

The alert is bound to what it was asked about (amounts, currency, date and
`dealsSeen` as asked); any edit takes it back (`reask`, the form's own rule).
«Ha, saqlash» is disabled while the save runs.

**After a save:** every row clears (and pre-fill is re-derived from the redrawn
page — a deal now priced here gets none); date and currency stay.
`deals_changed` → `router.refresh()` and the rows redraw from the new
question, typed amounts kept only for deals still offered (keyed by deal id —
a figure typed for a deal that left the truck is dropped, never moved).

**The non-ambiguous client** (one deal, deal-less, or one deal beside
deal-less cargo) keeps `PricingForm` exactly as it is, including its
«pricedHere» ask — for such a client any further price IS an extra bill (one
price covers all of his cargo there, R3a).

**The client's ledger door** (`finance/[clientId]`) keeps one deal per save
(stated): it is the rare door, the table is where 15 deals are priced.

### 1.3 The server

**Pure rule, beside `truckDealDecision` (truck-deal.ts, import-free):**

```ts
export type TruckDealPart = { choice: TruckDealChoice; /* 'deal' | 'none' only */ amount: number };
export function truckDealParts(candidates, parts, seen):
  | { ok: true; parts: { dealId: string | null; via: 'chosen' | 'none'; amount: number }[] }
  | { ok: false; code: TruckDealRefusal | 'deal_parts_empty' | 'deal_part_duplicate' };
```

- `seen !== candidates.key` → `deals_changed` (first, the Q8 rule);
- `!candidates.ambiguous` → `deal_choice_invalid` (the table is only drawn for
  an ambiguous client; anything else is a stale or forged post);
- zero parts → `deal_parts_empty`; the same deal (or «bitimsiz») twice →
  `deal_part_duplicate`;
- each part through `truckDealDecision`'s own branches (a deal not aboard →
  `deal_not_aboard`; «bitimsiz» without deal-less cargo → `deal_choice_invalid`;
  `derive` is not a part kind → `deal_choice_invalid`).

**Service `addTruckPrices(input, ctx)` (finance/service.ts).** Input:
`clientId, batchId, currency, txDate, dealsSeen (required), parts[1..40]
{ dealId: uuid | 'none', amount: nativeAmount() }, note?`.

The truck-price write is ONE body shared with `addTransaction`'s truck branch
(#513), factored out as `writeTruckChargesTx(tx, …)` / its pool half, so the
two doors cannot drift:

1. pool, before the transaction (#714): `future_date`; `batchRoute` →
   `batch_not_found` / `internal_batch`; `cargoAboard` → `client_not_aboard`;
   the decision (`truckDealParts`); `rateFor(currency, txDate)` ONCE →
   `fx_missing`; per part `amountUsd = round(amount × rate, 2)` and
   `exceedsRowUsd` → `amount_too_large`;
2. one transaction: `lockOwnersTx({clientIds:[client]})` → the truck row
   `FOR SHARE` (`batch_cancelled`) → `cargoAboard(…, tx)` and the SAME
   decision again → any part's deal differing → `deals_changed` → N inserts
   (one `client_transactions` row per part: type `charge`, `deal_id`, the
   shared rate, date, currency, batch) → ONE `reconcileFxResidueTx` → one
   audit row per inserted charge (`dealId`, `dealVia: 'chosen' | 'none'`,
   plus `parts: N` so the history says it was one press).

The action `addTruckPricesAction` (finance/actions.ts): `authorize('finance.manage')`
exactly as `addTransactionAction`; posts are `deal:<id>` / `deal:none` amount
fields; blank ones dropped BEFORE the schema; revalidates `/finance`,
`/finance/<client>`, `/batches/<id>/pricing`, and `/bitimlar/<deal>` for every
deal written.

Refusal words in all four locales: `deal_parts_empty`, `deal_part_duplicate`
(+ the existing Q8 codes through `truckDealErrorKey`).

### 1.4 What does not change (stated)

- Coverage stays deal-blind (`unpriced.ts`): one row priced makes the client
  «narx qo'yilgan» on the header, «Narxsiz yuk» and the counter — his 3a.
  «Bu mashinadagi narxlar» (`unpricedDealsOf`) and the deal card stay the
  per-deal indicator, loud for every blank deal once any price stands.
- A carton is paid only when every price covering it is paid (#1515); a
  «muddat» excuses its own deal's part only.
- Parts written in one press share `created_at` (transaction start), so FIFO
  orders them by id — harmless: every carton waits on every part.
- Nothing already written is re-split: a truck priced on one deal since Q8
  stays so until voided and re-entered.

### 1.5 Tests

- unit `truck-deal-parts.test.ts`: every refusal and the happy shapes.
- unit fence (`truck-deal-wire.test.ts` grows): both doors call the ONE shared
  write body; the table posts `dealsSeen`; the new codes have words in four
  bundles; `PricingForm` is no longer drawn for an ambiguous client.
- integration `truck-price-table.integration.test.ts`: 3 deals + deal-less
  cargo → 3 parts written in one press, one reconcile, audit rows `parts: 3`;
  partial save; duplicate / not-aboard / empty / stale-seen refusals; a
  prixod re-filed between the pool read and the transaction → `deals_changed`
  and NOTHING written (all-or-nothing); internal truck refused; cancelled
  truck refused.
- e2e `m9zzzg-narx-bitim.spec.ts` rewritten to the table: pre-fill for the
  admin, blank row stays «narx yo'q», a second press on an already-priced deal
  asks «qo'shimcha hisob» for THAT row only, and the old false line is gone
  for a deal with nothing here. Measured at 360×800: document width =
  viewport, «Saqlash» reachable.

---

## Part 2 — a cancelled truck gives its number back

### 2.1 What is wrong today

- `nextBatchCode` (codes.ts:52-82) bumps the counter `('batch_seq', prefix)`
  and walks past any code `codeEverWorn` says is taken; a cancelled truck
  keeps its `code` for ever (`cancelBatch`, unload.ts:1698), so YW-010
  cancelled → the next truck is YW-011 and «10, 11» is wrong by one.
- The commonest cause is a mis-pick: the quick batch is one press on two
  selects with no confirm, and nothing can change `dest_warehouse_id` before
  departure (`reroute.ts` refuses anything not `in_transit`), so a wrong
  destination is fixed only by cancel + a new number.

### 2.2 The number comes back (his 4a / 5a)

**Rule — «trailing, never left, never at the agent».** For a prefix `P`
with counter value `N`, the number N is RELEASABLE when the truck whose
`code = P-pad(N)` (case-sensitive, the string the mint builds — not a parse,
so a truck minted under an older prefix never matches) is `cancelled`,
`departed_at IS NULL`, `sent_to_agent_at IS NULL`, and no audit row makes
`P-pad(N)` a former road name of any truck. Release = rename that truck to
«P-pad(N) (bekor)» (or «(bekor 2)», «(bekor 3)» … when that name was worn —
`codeEverWorn` under its lock) and rewind the counter `N → N-1` by
compare-and-set. Then the same question for `N-1`, and so on — the walk
stops at the FIRST number that is not releasable, including a number nobody
wears (a truck renamed to its plate before it left counts in his count, so
its number is never handed out again).

**Writer `releaseTrailingCodes(prefix, ctx)` — in `batches/rename.ts`**, so
`batches.code` keeps its one writer and `before.code` audit rows stay inside
rename.ts (the fence at batch-rename-wire.test.ts:130). One short transaction
per number, locks in the mint's own order and never a truck's loading lock:

1. the counter row `SELECT value FROM counters WHERE kind='batch_seq' AND
   scope_key=P FOR UPDATE` (a mint waits here; a rename never takes it);
2. `lockBatchCode(P-pad(N))`, then `lockBatchCode(<new name>)` (the name
   lock is what mints and renames take FIRST; the release has no truck lock
   before it, so there is no cycle);
3. the truck row `FOR UPDATE` (`code` sits under the unique index);
4. re-check everything under the locks; any miss → stop, nothing written;
5. `UPDATE batches SET code = <new>`; `UPDATE counters SET value = N-1 WHERE
   kind='batch_seq' AND scope_key=P AND value = N`;
6. ONE audit row: `entity batch, action 'update', before {code: old}, after
   {code: new, released: true}` — **never a `reason` key**: the former-name
   predicate (former-codes.ts:38-39) counts a road rename by `after.reason`,
   and a release written with one would make P-pad(N) «ever worn» and burn it
   for ever (audit_log is immutable).

**Called by `cancelBatch`, after its commit** (#714 — never inside the
cancel's transaction, which holds the truck's loading lock that a rename
waits on). Every cancel — the action, a script, a test — releases; the
service is the door a test can press (#531). A failure in the release is
logged and answered as «raqam qaytmadi» — never a failed cancel.

**The cancel's answer** grows `number`:
`{ kind: 'returned', codes: string[] } | { kind: 'kept', why: 'newer' |
'agent' | 'prefix' | 'error', newer?: string }`, where `newer` is the code of
the truck at the counter's top (the one that blocks). The dialog prints:

- «✅ YW-010 raqami qaytdi — keyingi mashina YW-010 bo'ladi» (plus any
  trailing old ones the walk also freed, named);
- «Raqam qaytmadi: YW-011 allaqachon ochilgan» (his 5a, verbatim);
- «Raqam qaytmadi: hujjatlari agentga yuborilgan» (his 7a);
- «Raqam qaytmadi: ombor prefiksi o'zgargan».

**What the renamed truck looks like:** the archive and ⌘K still find it by
«YW-010» (substring); the bot's exact lookup sends «YW-010» to the live
truck; its history says «Nomi: YW-010 → YW-010 (bekor)» by the canceller;
no «Oldingi nomi» (not a road name). Frozen copies (Telegram already sent,
event payloads, downloaded drafts) keep «YW-010» and open the cancelled truck
by id — stated, as #1256 stated it for renames.

### 2.3 Old cancelled trucks (his 7a)

`scripts/batch-raqam.ts` (through `migrate`, never a package.json command,
#1228): per prefix — the counter value, the highest `P-<digits>` code, every
cancelled truck with `departed_at IS NULL` (code, created, agent tick), the
GAPS between 1 and the top, and which of those `--apply` would return (the
trailing walk, same predicate as 2.2). Dry run by default; `--apply` calls
`releaseTrailingCodes` per prefix and prints what it returned. Read to him
before `--apply`.

### 2.4 A wrong destination is fixed before departure (his 6a)

`rerouteBatch` stays the ONE writer of `dest_warehouse_id` (fence
`batch-reroute-wire.test.ts`). A second exported function in the same file,
`changeDestBeforeDeparture(actor, batchId, {destWarehouseId,
seenDestWarehouseId}, meta)`:

- status `forming` or `loading` (`not_before_departure` otherwise — the road
  has its own door);
- door: the cancel's — `batches.depart_close` at the ORIGIN, or `plans.manage`
  (unscoped, or in scope of the origin): whoever may cancel and re-open the
  truck may fix it in place;
- compare-and-set on `seenDestWarehouseId` (`dest_changed`), target active,
  ≠ origin (the CHECK), ≠ current;
- **money:** when the truck carries a live cost or charge and the leg's kind
  would change (internal ⇄ crossing — `batches/internal.ts`'s own rule), it
  is refused `dest_money_kind` in words: a price may not sit on an internal
  leg and a bill split for one kind of road must not become the other's.
  Same kind → allowed;
- no reason required (a name changed before departure needs none either);
  one audit row `{before:{destWarehouseId}, after:{destWarehouseId,
  beforeDeparture:true}}`; no Telegram (nothing has left; every live reader —
  board, homes, card — follows the column);
- the approved plan's destination, `batches.type` and the pairing stay, as
  the reroute leaves them.

UI: the truck card's «Mashina» area (where the reroute lives on the road)
offers «Qabul skladini o'zgartirish» while forming/loading to whoever the door
admits; a select of active warehouses ≠ origin, one press.

**Quick-batch confirm:** the quick form becomes a client component that asks
«YW → Toshkent: yangi partiya ochilsinmi?» (warehouse codes/names from the
selects) before it posts; no other change to the action.

### 2.5 What does not change (stated)

- 8a: the counter stays per origin prefix and counts every truck, internal
  legs included.
- A truck renamed to a plate before it left still leaves its number unused
  (the counter never comes back for it) — his count includes that truck.
- A gap in the middle (10 cancelled after 11 opened) stays for ever.
- A departed truck that the annul cancelled keeps its number (it left).

### 2.6 Tests

- integration `batch-number-release.integration.test.ts`: cancel the top →
  next mint returns it; cancel below the top → kept 'newer' naming the top;
  cascade (11 cancelled while 12 lived, then 12 cancelled → both back); a
  number nobody wears stops the walk; agent-ticked → kept 'agent'; prefix
  changed → kept 'prefix'; the release audit row is NOT a former name
  (`codeEverWorn` false for the old code after); a concurrent mint between
  cancel and release → kept 'newer', never a duplicate; the release twice is a
  no-op.
- integration for `changeDestBeforeDeparture`: forming ok; in_transit refused;
  money + kind change refused; same-kind with money ok; stale seen refused;
  door (warehouse manager at origin ok, at another warehouse refused).
- unit fences: release audit has no `reason`; lock order in the release;
  `rerouteBatch`'s file stays the only writer of the column; `cancelBatch`
  calls the release after its transaction.
- e2e: `m9m-cancel-batch` asserts the answer line; the quick-batch confirm
  pressed in a browser.
- Re-read every integration file that calls `cancelBatch(` (6 files) for a
  test that now gets the same code back.

---

## §3 — v2: the judge's findings, absorbed (BINDING; overrides §1-§2 where they differ)

Six lenses read v1 against the code (47 findings: 0 blockers, 31 defects,
16 nits; every one with file:line evidence). Decisions:

### 3.1 Part 1

1. **Prices as drawn (`pricesSeen`).** The table posts the sorted ids of the
   client's live charges on this truck as drawn; the write body re-reads them
   under `lockOwnersTx` + the truck lock and refuses `prices_changed` (redraw,
   typed amounts kept by deal id). Closes the stale-tab / two-person double
   write (the client lock serialises two presses).
2. **The truck lock reads the kind too.** ONE helper `lockTruckForPriceTx(tx,
   batchId)` = `SELECT b.status, o.country, d.country … FOR SHARE OF b`,
   refusing `batch_cancelled` and `internal_batch` (`internal.ts`'s rule on the
   locked row). Used by the shared write body (so `addTransaction`'s truck
   branch too) AND by `moveCharge` on each target truck — it took no truck lock
   at all (the cancel race the price door already closed). A destination
   change (§2.4) can no longer slip a price onto an internal leg.
3. **The shared body OWNS its transaction** (tx-pool fence): `writeTruckCharges
   (pre, ctx)` opens `db.transaction` and runs, inline: `lockOwnersTx` →
   `lockTruckForPriceTx` → `cargoAboard(…, tx)` → the decision again (key +
   parts) → `pricesSeen` → N inserts → ONE `reconcileFxResidueTx` → an audit
   row per charge. Its pool half `prepareTruckCharges` (route, cargo, decision,
   rate once, per-part dollars + `exceedsRowUsd`) is shared too.
   `addTransaction`'s `charge && batchId` path calls both and returns before
   its own transaction; payments/refunds keep today's body. No `= db` default
   on a writer.
4. **Pre-fill is a PURE rule** `prefillFor(row)` → `{ usd } | { none: why }`,
   unit-tested, and the row prints the why (muted). A value only when ALL hold:
   quote sight (`dealPriceSight`); currency USD; the figure was SCALED by a
   measure (never the whole-quote fallback — `expectedPartFor` answers null
   where `expectedPriceFor` falls back); the deal's discount is 0; the deal has
   NO live charge anywhere (this truck, another truck, its card — so a deal
   split over two trucks is pre-filled on the first only, and a second truck
   reads «YW-009 da narx bor»); no davomi carton of the deal aboard
   (`carriage.byLot.follows`); the trip is not a continuation; the client has
   no `offElsewhere` price here; no `whole` price stands (3.1.6). The value is
   the deal's quote × this truck's EXACT share (Σ lot volume/weight ×
   onBatch/boxCount, unrounded, on the basis the upsale uses — kg for a
   per-kg version, else m³, else kg), **rounded UP to the cent**, so a
   pre-filled single-truck deal never reads `no_invoice` by a rounding
   (integration test pins it). «Bitimsiz» is never pre-filled.
5. **Clear only what was written.** After a save only the rows that were
   written clear; a row the person emptied on purpose stays empty
   (per-deal «touched» mark for the component's life); pre-fill only ever fills
   an untouched row.
6. **What counts as «already priced here» — ONE pure reading**, shared by
   `unpricedDealsOf` and the table (#513): a deal's own live prices here; the
   «bitimsiz» part = deal-less prices whose create audit says `dealVia: 'none'`;
   **`whole`** = every OTHER deal-less price here (pre-Q8, or before the deals
   were known — on a `none` truck too) and every price on a deal no longer among
   the candidates. While a `whole` stands: no pre-fill anywhere, and every
   filled row asks, naming it.
7. **The per-row ask** (one alert per press, only when something is asked):
   `secondBill`; a filled row whose deal is priced here («qo'shimcha hisob»);
   the «Bitimsiz» row when a chosen-bitimsiz price stands; every filled row
   while a `whole` stands; a filled `card` row («bitim kartasida narx bor»);
   a filled row whose deal is priced on another truck (soft: «YW-009 da ham
   narx bor»); the 5 % deviation per row (quote sight, USD); ⏳ rows.
   «Jami» in the chosen currency.
8. **One wrapper per client card** (`ClientPricing`) holds the last refusal
   sentence and renders the table or the single form; a `deals_changed` that
   flips ambiguity keeps the sentence (typed amounts of a flipped body are not
   carried — stated).
9. **PricingForm loses its question branch** (TruckDealSelect, choiceAsks,
   chosen, truckDealAsk*, expectedByDeal) — it is now only the non-ambiguous
   form; its fences move to the table file honestly. `TruckDealSelect` stays for
   the ledger door.
10. **Rows are read in the browser** with `parseTypedMoney`; only `trim() === ''`
    rows are blank; an unreadable row is marked on that row and refused as
    `validation` with its deal id (server too). A press with no filled row:
    `deal_parts_empty` returned by the action BEFORE the schema.
11. **«Bu mashinadagi narxlar»** keeps his 3a words but the missing deals become
    ONE loud line «Narx yo'q: B-…, B-…» (not one line per deal); the row label
    wraps (`min-w-0 [overflow-wrap:anywhere]`).
12. **Compensation and Ko'chirish learn the parts:** `lostCargoChargesOn` ranks
    the prixod's own deal's part first, then deal-less, then the rest, with an
    `id` tiebreak; every line in both forms prints `batchCode · dealCode`.
13. **Fences:** truck-deal-wire grows (both doors call the shared halves;
    addTransaction holds no second `cargoAboard(`/`truckDealDecision(`; the
    in-tx check is the parts check); the three addTransaction slicing fences are
    rewritten against the shared halves (sliced by function); the confirm-
    machinery fences loop over both form files; the action fence covers
    `addTruckPricesAction` (one `authorize('finance.manage')`, no kassa branch).
14. **e2e** m9zzzg is rewritten test by test to the table; the fixture grows to
    ≥12 deals with one 40+ character unbroken goods name and one deal-less
    prixod; 360×800 measured (document width = viewport, Saqlash and its alert
    reachable).

### 3.2 Part 2

1. **The holder of number N** is the truck wearing `P-pad(N)` now; if nobody
   wears it, the truck whose newest batch audit row renamed AWAY from it
   (`before->>'code'`, read in former-codes.ts, its fenced home). Releasable =
   that truck is cancelled, `departed_at IS NULL`, never at the agent (3.2.3),
   and `P-pad(N)` is no road former name. A truck renamed to its plate before
   it left and then cancelled therefore gives its number back (no rename
   needed — it wears the plate); one that LEFT stops the walk
   (`why: 'renamed_left'`, naming its name). A number with no holder at all
   stops it (`'unworn'`); no counter row → `'no_counter'`; a truck whose code
   is not in today's prefix → `'prefix'`.
2. **Release, per number, in one short transaction:** counter row FOR UPDATE →
   plain read of the holder → only if it reads releasable: `lockBatchCode(old)`,
   `lockBatchCode(new)`, truck row FOR UPDATE, re-check under the locks →
   rename (only when it still wears the number) + counter CAS `value = N` →
   audit `{before:{code}, after:{code, released:true}}` (never `reason`), with
   `warehouseId` = the truck's OWN origin. `SET LOCAL lock_timeout = '3s'`; a
   timeout is `'busy'`, answered as «raqam qaytmadi» — never a failed cancel.
3. **«Never at the agent»** = `sent_to_agent_at IS NULL` AND no audit row of
   the truck that ever ticked it (an untick does not un-send papers). The
   agent tick is refused on a cancelled truck under its row lock and hidden
   there.
4. **The answer is read from the truck's own row after the walk** (whoever's
   walk freed it). And it is DURABLE on the card: a cancelled truck's header
   prints `batch-number-state` — «Raqami qaytarildi» when it wears «… (bekor…)»
   or was released from a plate, else «Raqam qaytmadi: …» with the live reason
   (the same predicate, read-only). `cancelBatchAction` passes `number` too.
5. **Bot:** `upper(code) = X` finds nothing for a released number until it is
   minted again — a fallback in former-codes.ts (`releasedNameSql`, «X (BEKOR%»)
   answers «bekor qilingan, raqami qaytarildi».
6. **History labels:** `released` and `destBeforeDeparture` get `audit.fields`
   words in four bundles and `AUDIT_FIELD_LABELS`.
7. **The dry run** iterates `counters WHERE kind='batch_seq'` (old prefixes
   included), prints every warehouse using each prefix today, labels every gap
   («30: 01A777BA nomi bilan jo'nagan», «bekor, agentga yuborilgan», «hech kim
   olmagan»), escapes the prefix in its match. A cascade may rename another
   warehouse's cancelled truck when they share a prefix — stated.
8. **Destination before departure** (`changeDestBeforeDeparture`): first
   statement `lockTruckLoading`, then the truck row FOR NO KEY UPDATE (status
   re-check), then money counted under it, then the target warehouse FOR SHARE,
   then the UPDATE with a CAS (`status IN forming/loading AND dest = seen`).
   Refused: `dest_money_country` — live money and the destination's COUNTRY
   would change (not merely internal ⇄ crossing: `crossesBorderSql` and
   `bearsPriceSql` read countries); `dest_agent_sent` while ticked. Audit under
   its OWN key `destBeforeDeparture` (before/after), never the reroute's — the
   road reroute's «told» readers must not take it for a «keladi». Both writers
   go through ONE private `writeDestTx` in reroute.ts (the fence counts
   UPDATE sites). Added to count-kernel-wire's «loading change takes the truck
   lock first» list. /plans/[id] prints «Mashina hozir: <dest>» when the
   truck's destination differs from the plan's.
9. **Quick-batch confirm** is IN-PAGE (testids), not `window.confirm`: the
   press shows «<origin name> → <dest name>: yangi partiya ochilsinmi?
   [Ha, ochish] [Bekor]» (names passed in, the single-warehouse branch read from
   its fixed origin). Every e2e that creates a quick batch (9 presses, 8 specs)
   goes through ONE helper `createQuickBatch(page, …)`.
10. **m9m** asserts the archive row by id/href and the card's
    `batch-number-state`, not a count over a substring.
