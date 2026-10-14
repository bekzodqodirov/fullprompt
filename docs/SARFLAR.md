# «Pul qayerga ketdi» — the spending map and truck-bill entry

Agreed 2026-10-13. This is the spec the round is built from. §8 holds the
BINDING corrections the design judge added before code, and it overrides
§1-§6 wherever they disagree.

## 0. His words

The request, 2026-10-13:

> «moliya bolimida shunday feature page kerak qayerda qanday rasxod bolayotganini
> 1 pageda koradgan va partiyalarga bolayotgan rasxodni obshiy joydan ham
> kirgazish imkoniyati»

Nine questions were sent with ⭐ defaults. His answer:

> «Hammasi ⭐
> 3. Yonalish boyicha degan narsani ozi kerak emas chunki ichki reyslarga faqat
> tan narx yoziladi va partiya foydasi belgisi bor partiyada pul yegiladi. Yani
> yonalish ozgarib turadi.
> 6 saqlashdan oldin ogohlantirsin qayerda shu qayta yozilayotganini»

So the questions resolve as follows:

| # | Question | Answer |
|---|---|---|
| 1 | Who opens the map | **a** — the owner, admins and the accountant (`companyMoneySight`) |
| 2 | Which date counts | **a** — the date written on the cost or expense, the P&L's own clock |
| 3 | Truck money in «Sklad bo'yicha» | **CHANGED** (see below) |
| 4 | Trucks offered for entry | **a** — every truck except cancelled ones; open trucks first; closed trucks only through search, marked «⚠ yopilgan» |
| 5 | How entry works | **a** — one bill at a time; the form stays open |
| 6 | A bill that already exists in the other book | **CHANGED** (see below) |
| 7 | Default period | **a** — this month |
| 8 | Rasxod xabari onto a truck | **a** — not now |
| 9 | Warehouse mandatory on overheads | **a** — not now; the gap is shown as a row |

**Q3, his correction.** There is no «Yo'lda» block grouped by route anywhere.
His reason is the cargo's own life: internal legs carry cost only (tannarx),
and the money is earned on the truck that carries the «partiya foydasi» mark.
The same cargo rides several legs, so a direction is not a stable fact about
money. Two consequences:

- Truck money never appears in the warehouse breakdown at all.
- Each truck is a row of the «Partiyalar» block. The row carries the truck's
  KIND as `tripKind` already names it, as a chip:
  - «💰 foyda hisobi» — `profit_tracked`;
  - «ichki reys · faqat tannarx» — internal;
  - «davomi» — continuation.

**Q6, his correction.** The warning comes BEFORE the save and names WHERE the
same money is already written. It is a confirm, never a refusal: the person
may still save (§3).

## 1. The map — `/accounting/sarflar`

### Door and placement

- **Door:** `companyMoneySight(actor)`, otherwise `redirect('/')` before any
  read. It reaches the owner, admins and the accountant. It never reaches the
  VED, a seller, the logist or the viewer.
- **Who sees expense rows:** individual expense ROWS, employee names and
  staff-payer names render only under `maySeeStaffMoney`. Any other reader of
  the page gets category totals only, as on the P&L.
- **Menu:** a non-NAV tab in the «Pul» workspace, placed right after
  «Xarajatlar».
  - `need: [['finance.manage','clients.manage'],['finance.reports']]`,
    via `['/accounting','/accounting/expenses']` — the same shape as
    qarzga-berilgan.
  - The tab word is «Sarflar» (`ws.tab.spendMap`); the title is «Pul qayerga
    ketdi».
- **No `<Suspense>`** on the page (#1242).

### Top to bottom

Phone (360) shows one column of two-line rows. Desktop has an 896 px main
column; nothing is put in a side rail.

1. **Period.**
   - Chips: «Bu oy» ⭐ (month start → Tashkent today), «O'tgan oy», «Yil
     boshidan», and custom from/to dates read through `resolvePeriod`.
   - Every link is built with `hrefWith`, so filters survive a period change.
   - One muted line names the clock: «xarajat sanasi bo'yicha — Foyda-zarar
     va bosh sahifadagi Xarajat bilan bir xil».
2. **Hero «Jami xarajat».**
   - The figure is `pnlParts(profitAndLoss).cost`, which is the dashboard
     tile's own number.
   - It is printed in three parts that visibly add up to the figure: Yuk
     xarajatlari (direct), Umumiy xarajatlar (opex), Kurs farqi (signed).
   - ▲▼ shows the dollar change against `priorPeriodOf`, with the comparison
     window printed as dates.
   - `PnlGapsNote` sits directly under the hero. Unconverted money is named per
     currency and never shown as $0.
3. **«Qayerga»** — bar rows of label, $, %, ▲▼.
   - (a) **Yuk.** One disjoint CASE (`spendKind`), shared by the bars and the
     register filter. The four kinds sum exactly to direct:
     - Partiyalar = scope `batch`, OR scope `receipt` with a truck stamp
       (`batch_id`);
     - Prixodlar = a receipt cost with no truck stamp;
     - Yashiklar = scope `crate`;
     - Zavod reysi = scope `pickup`.
   - (b) **Umumiy.** By expense category: the top 6 plus «yana N», summing
     exactly to opex.
   - The two groups are stacked below `xl` and side by side from `xl`.
4. **Folds** (native `<details>`).
   - **«Partiyalar».** One row per truck: code, the kind chip (Q3), «shu
     davrda yozilgan $», the truck's all-time Σ beside it, and «tannarx emas →
     Partiya foydasi». The top 10 show, and «Hammasi» pages inside the map.
     There is no route grouping.
   - **«Sklad bo'yicha».** Truck money is never placed under a warehouse
     (Q3). The block holds:
     - prixod costs at `receipts.warehouse_id`;
     - zavod reysi at its destination;
     - yashik costs at the PACKING warehouse, read from the crate's
       `crate_packed` movements and never from `crates.warehouse_id`, which
       unloading rewrites;
     - overheads at `expenses.warehouse_id`, plus an honest «sklad
       ko'rsatilmagan» row.

     Its last line reads «Partiyalarda: $X → yuqoridagi Partiyalar», so the
     block plus that line equals the hero.
   - **«Turi bo'yicha».** Cost types and categories.
   - **«Kim to'ladi».** One ordered CASE, shared by the grouping and the
     filter:
     1. kassa;
     2. o'z puli (`staffPartnerSql`);
     3. firma (qarz);
     4. hisob yozuvi (non-cash category);
     5. navbatda (`unplacedCostSql(since)`, labelled «xarajatga kirgan,
        kassasi aytilmagan»);
     6. tarix.

     The buckets sum to the book total, and a test pins it. The kassa bucket
     is labelled «tannarx dollarida» and links to Kassalar.
5. **«Tekshiring»** — links only, never part of any total.
   - «🔁 N juft takror bo'lishi mumkin». The count is REAL pairs, computed by
     the §3 twin rule over the period, uncapped in SQL.
   - «⏳ Kutilmoqda»: due rent and salaries (`recurringArrears`) and open
     rasxod xabari.
   - Every link asks its destination's own door. Where the door would refuse,
     the line is plain text.
6. **Register.**
   - Full width, newest first, 100 per page, with an uncapped count over the
     same predicate.
   - **Filter fold.** One GET form; every URL value is validated. Fields:
     - kitob, turi (two optgroups), sklad, partiya chip;
     - joy and kim to'ladi, which use the SAME CASEs as the grouping;
     - «faqat men».
   - **Row line 1:** date · type · book badge · native amount + $ (or «kurs
     yo'q»).
   - **Row line 2:** target link · where · payer (`tillView`) · who typed it.
   - There is no 🗑: voids stay on each row's home card.
   - XLSX uses the same predicate, capped at 5000 with the uncapped total
     printed.

## 2. Truck-bill entry — `/accounting/sarflar/kiritish`

- **Door:** `seesCompanyMoney && costs.enter_batch`. The map's «＋ Partiyaga
  xarajat» button is drawn only for that combination.
- **A light page.** It runs no report readers, so picking a truck costs
  milliseconds.
- **Picker:** a GET form with `q`, answered by `trucksForCostEntry(actor, q)`.
  - It never offers a `cancelled` truck. It keeps `warehouseScope` on the
    origin together with `costs.enter_batch` (today's rule, stated).
  - With no `q`: open trucks (forming … unloaded), newest first. A truck with
    zero cost entries carries a «xarajatsiz» chip.
  - A typed `q` also finds closed trucks, marked «⚠ yopilgan».
  - Order: exact code, then code prefix, then former names
    (`batchTextMatchSql`), then recency.
  - The count is printed as «N tadan 20».
  - Each row shows its per-truck Σ from one `inArray` grouped query.
- **`?p=<id>`** re-asks `mayEnterBatchCost(actor, batch)` = status ≠ cancelled
  && `mayAt(origin)`. If that fails, the page prints a sentence, never a form.
- **With a truck chosen:**
  - its head line, «Partiya kartasida ochish →» and «Prixodlar jadvali →»;
  - `<CostPanel key={id} scope="batch">`, fed by
    `batchCostSheet(id, costSightFor(actor))` through `tillView`;
  - one shared `costPanelOptions(actor, id)` for this page AND the truck tab:
    types, currencies, `listPartners({includeStaff})`, `tillOptionsFor`, and
    RIDER clients from `batchLots`. Using the riders fixes the truck tab's
    empty live-pointer client list.
- **Keeping the form.** `CostPanel` grows `afterSave: 'again'` here: the form
  stays open and keeps type, currency, date and payer. The truck tab keeps
  `'close'`.
- **«Bugun men kiritganlar»** lists rows with `created_at` today and
  `entered_by` = me. A row whose date falls outside «Bu oy» says «davrdan
  tashqari — O'tgan oy →».
- **Saving** goes through the same `addCostEntryAction` → `addCostEntry` path
  as the truck card. Nothing about the money path differs.

## 3. «Bu pul allaqachon yozilganmi?» — the pre-save twin warning (his 6)

**The danger.** One payment is written twice: once as a truck cost and once as
an expense in «Xarajatlar», or the same pair the other way round. If both name
a kassa, the drawer is debited twice. If one has no kassa, the P&L is doubled
and the merge (M4a) can still fix it.

**One rule, one home.** `accounting/twins.ts` holds `twinsFor(candidate)`. It
works in both directions:

- a candidate COST is checked against live expenses;
- a candidate EXPENSE is checked against live costs.

A twin is any live row on the other book that meets all of the following:

- **The same money.** The same currency and the same amount (the `sameMoney`
  sense), dated within `MERGE_DAYS`.
- **The same payer, where both carry one:**
  - the same kassa;
  - or the same staff partner;
  - or, when the cost has no kassa, any cash-category expense — the shape the
    M4a merge pairs.
- **Never one of these:** a recurring posting, an upsale or KPI payout, a
  partner-settled expense, or a merged-away row.

**Each twin is returned with WHERE it is written:**

- which book;
- the date;
- the type or category;
- the truck, prixod, crate or pickup code, or the category name;
- the kassa;
- who typed it;
- a link, but only if the reader's door to it opens.

**The flow (a confirm, never a refusal):**

1. The action computes the twins on the server, before anything is written.
2. If any twin is not in the posted `twinAck` list, it returns `{ twins }` and
   writes NOTHING.
3. The form shows «⚠ Bu pul allaqachon yozilgan» with one line per twin and a
   «Baribir saqlash» button.
4. That button re-posts the same values with `twinAck` = the twin ids shown.
5. A twin that appeared after the warning was drawn is asked about again.
   This is a compare-and-set on what the person SAW, not on a boolean.

**Doors:**

- `CostPanel`, every scope, every page it is mounted on;
- the expense form on /accounting/expenses, including its rasxod xabari
  «Kiritish» prefill, which is the same form;
- the receipt-cost grid: ONE warning for the sheet, listing every cell that
  has a twin.

**Holding the inputs.** A form that can be answered with «are you sure» must
keep what was typed (#463/#377). `CostPanel` is controlled already. The
expense form is `useActionState` with uncontrolled inputs, so a returned
warning would reset it. Its inputs become controlled, or are re-keyed from the
values the state carries back, and the e2e asserts the typed amount survives
the warning.

The map's «🔁» count (§1.5) reads the SAME rule over the period, so the warning
and the count can never disagree.

## 4. Shared write-path fixes (built, not optional)

Found by the design judge on the door this round leans on:

- **A forged second target.** `costEntrySchema` takes `receiptId`, `batchId`
  and `crateId` regardless of scope. `addCostEntry` writes them, and the DB
  CHECK demands only the scope's OWN id. So a hand-built `scope:'receipt'`
  post carrying any truck's id is a warehouse operator writing a «grid-stamped»
  cell onto a truck.
  - Fix: `addCostEntry` nulls every target id the scope does not name.
  - Only the grid's own internal call passes `stampTruck`, which no action
    exposes (the #731 `viaConvert` idiom).
- **A cancelled truck takes a cost.** Today the cancellation is fenced only in
  pickers.
  - Fix: `addCostEntry` refuses `cancelled`. The INSERT and a raw `FOR SHARE`
    on the batch run in one short transaction; rates are read BEFORE it on the
    pool (#714).
  - Its lock compatibility with `cancelBatch`'s lock is proven with a held
    second connection.
- **Words for refusals.** `PAYER_ERRORS` gains sentences for `cancelled`,
  `forbidden` and `not_found`.
- **One door predicate.** `mayEnterBatchCost(actor, batch)` is asked by the
  action, by the truck tab's `canEdit` (today a bare `has()`), and by the
  picker.

## 5. Deliberately not built

- No overhead form on the map — only a «＋ Umumiy xarajat → Xarajatlar» link.
- No per-prixod grid on the entry page — it links to the truck's.
- No prixod, yashik or zavod cost door here.
- No multi-row desk (his 5a).
- No rasxod xabari → truck conversion (his 8a).
- No mandatory warehouse on overheads (his 9a).
- No `cost_date` index (measured fast at the shaped copy's size, stated).
- The merge is not widened to kassa-paid costs. The warning prevents the
  duplicate; a kassa-paid one already written is cured by a void.

## 6. Honest limits (stated to him)

- **A truck's figure here is not its tannarx.** It is the money written on
  that truck in the period. Landed cost («shu reysgacha», «keyingi yo'l») stays
  on «Partiya foydasi», and the page says so.
- **Overheads split by warehouse only as far as the optional Sklad field is
  filled.** The «sklad ko'rsatilmagan» row shows the gap.
- **A rasxod xabari about one truck still lands as overhead.**
- **The scale is measured on a shaped copy only:** 6.6k costs, 0 expenses. A
  read-only count on the live server (cost_entries by month × scope ×
  currency, expenses by month) is worth having before he relies on the speed.

## 7. Verification plan

**Integration**

- The money adds up:
  - hero == `pnlParts.cost`; Yuk == direct; Umumiy == opex.
  - Fixtures: partner-paid, merged-away, unconverted CNY, a grid-stamped cell,
    voided, non-cash, crate, pickup.
- Totals reconcile:
  - Σ payer buckets == book total;
  - Σ «Sklad bo'yicha» + the trucks line == hero.
- The picker:
  - destination-only scoped actor → nothing;
  - scoped actor with no warehouse → nothing;
  - cancelled → never;
  - an exact code wins past YW-1009.
- The write path:
  - a forged `receiptId` on a batch post is stripped;
  - a forged `batchId` on a receipt post is stripped;
  - cancelled is refused, including the race;
  - a `finance.reports`-only analyst sees no expense rows.
- Twins:
  - kassa-cost × expense on the same kassa → warned;
  - a different kassa → not warned;
  - kassa-less cost × cash expense → warned;
  - a recurring posting → never;
  - a stale ack (a new twin after the warning) → asked again;
  - acked → saved.

**Unit**

- workspaces `GATES` + PEOPLE gains (analyst, ved_manager + finance.expenses);
- the Q19 not-offered list;
- money-sight wire pins;
- a no-Suspense fence;
- the twin rule's pure half.

**e2e** (as the accountant, at 360 and 1280)

- Pick a truck → type a bill → «yana bitta» → switch trucks (the form is
  empty) → the row is in «Bugun» and on the truck tab.
- Then a twin: write an expense on the same kassa and amount, type the same
  bill on the truck → the warning names the expense → «Baribir saqlash» saves.
- Every row this spec created is voided as the final TEST.
- `clientWidth` == viewport at both widths.
- m9zz returns 200 on an empty seed.

**Screenshots**: look at them.

## 8. Binding corrections from the design judge

The judge ran four lenses: twins, money, access and the write path. It raised
55 objections; 54 were confirmed or partly confirmed by a refuter, 5 of them
blockers, and 1 was refuted. Every surviving one is absorbed below. Where two
objections pulled in different directions, the choice is stated.

### 8.1 The twin rule (§3) — ONE symmetric predicate

`accounting/twins.ts` holds the pure `isTwinPair(cost, expense)` and its SQL
twin. The pre-save warning AND the map's count both call it, with the same
constants, and a unit test runs the pure half and the SQL half over the same
rows. It decides from each row's **payer kind**:

- a cost is one of:
  - K = has a kassa;
  - S = staff partner (`staffPartnerSql`);
  - F = any other partner;
  - ∅ = none of these.
- an expense is one of:
  - K' = has a kassa;
  - S' = staff partner;
  - F' = firm partner;
  - ∅c = cash category with no kassa and no partner (old history);
  - B = non-cash category.

| cost \ expense | K' | S' | F' | ∅c | B |
|---|---|---|---|---|---|
| K | twin iff same kassa | twin (mirror of payment) | twin (mirror of payment) | twin | no |
| S | twin («qarzning to'lovi») | twin iff same partner | no | no | no |
| F | twin («qarzning to'lovi») | no | twin iff same partner | no | no |
| ∅ | twin (M4a) | no | no | twin (M4a) | no |

**Money is matched per shape (B1, the judge's blocker).**
- **K × K'.** Compare `cost.account_amount` with `expense.amount`. Both are in
  the kassa's currency, so they must be equal to the cent.
  - For a candidate cost, the kassa side is derived exactly as `addCostEntry`
    does: `assertTill` + `tillAmountFor`, both on the pool, before the check.
  - The words «the same currency» are deleted.
- **Every other shape.** Use `sameMoney([cost], expense)` exactly as
  `mergeDuplicate` does: equal to the cent in one currency, otherwise dollars
  within `fxResidueAllowance`.
  - `no_rate` means «cannot check». It is NOT a twin, and the warning area
    says so in words.

**The cost side of shape ∅** is M4a's own pair: no kassa, no partner, not
merged — `unplacedCostSql`'s terms without `since`. The expense side reuses
`mergeableExpenseSql` (exported from cost-merge.ts, never restated).

**Rows that are never a twin, applied to BOTH rows (the candidate as well as
the stored one):**
- voided;
- `recurring_id` set;
- `commissionPayoutSql`;
- non-cash category.

**A MERGED cost** (`merged_expense_id` set) is a candidate like any other cost.
It now carries the kassa the merge moved onto it, so it reads as K. The merge's
own cost fence is NOT reused for this query.

**The window.**
- Dates within `MERGE_DAYS`.
- OR, when a cost is checked against an expense, an expense that an un-merge
  restored (`restoredSql`, exported from cost-merge.ts, within
  `RESTORED_DAYS`).

**Sums, not only pairs (B2).**
- (a) On the grid, the whole sheet's Σ is checked against expenses: one
  currency, one kassa, one date.
- (b) Completing-sum. A candidate cost plus the same truck's live costs on the
  same `cost_date`, in the same currency and with the same payer, equal to one
  expense — and the mirror for a candidate expense. This is one grouped query,
  never a subset search.
- STATED as not checked: sums spread over several trucks or several days.

### 8.2 Who sees a twin, and the flow

- **The check runs only for the expense book's readers (B3, a blocker).** On
  a COST door the twin check runs only when `mayPickTill(actor.permissions)`
  holds, i.e. `finance.expenses`. For anyone else the action runs NO twin
  query and the response never carries `twins`. Why nothing is lost:
  - a non-holder can only write a kassa-less, non-staff cost (`payerRefusal`);
  - that shape is caught by the xarajat-kassa queue, the M4a merge and the
    map's count;
  - the accountant gets the warning from the expense side.

  The pages pass `twinCheck` from the same predicate. `twinsFor(candidate,
  reader)` takes the reader as a REQUIRED argument.
- **What a twin line shows.**
  - The kassa goes through `tillView`.
  - A staff payer's name prints only under `maySeeStaffMoney`.
  - On the expense door, a reader who sees only their own costs
    (`costSightFor(reader).ownOnly`) gets a colleague's cost twin redacted:
    the book, the date and «boshqa xodim yozgan — buxgalter tekshiradi». No
    truck code, type, typist or link.
- **Where the check runs.**
  - In `addCostEntryAction`: after the target's authorize and after
    `payerRefusal`, before `addCostEntry`.
  - In `saveReceiptCostGridAction`: inside `addReceiptCostsBulk`'s pre-loop
    block, over EVERY posted cell, before a single cell is written.
  - In `addExpenseAction`: after `needsKassaOrPayer` and BEFORE
    `claimExpenseRequest`, because the claim is a write.
  - A fence: `addCostEntry` and `addGridCell` never reference `twinsFor`.
- **The ack is single-use (B4).**
  - The warning returns `ackToken` = a sha256 over: the candidate's own
    fields, the sorted twin ids, and the ids of live same-target, same-money
    rows on the candidate's OWN book.
  - Only «Baribir saqlash» sends the token. The server recomputes it; any
    difference returns `{twins}` again.
  - Once a bill is saved, the next identical bill's token differs, so it is
    asked again.
  - No secret is needed: the person may always save. No raw ids of redacted
    rows reach the browser.
  - This is best-effort. The two books are not serialised against each other,
    and the count is the backstop. The word «compare-and-set» is withdrawn.
- **The answer is remembered.** The saving door writes the acked twin ids into
  the new row's create audit as `after.twinAck`. The map's count excludes a
  pair either row's audit acked.
- **Ranking.**
  - Order: same warehouse first, then the smallest day gap, then an expense
    with no employee.
  - The display shows the top 5 plus «yana N». The token covers the full set.
- **Words per shape.**
  - same partner: «qarz ikki marta yozilmoqda — bittasini bekor qiling»;
  - partner × kassa: «bu qarzning to'lovi bo'lsa — xarajatni bekor qilib,
    kontragentga to'lov sifatida yozing»;
  - mergeable (∅ shapes): «Xarajat kassasi → Birlashtirish» link;
  - every other shape: «bittasini bekor qiling».
- **The rasxod xabari path.**
  - A twin warning leaves the request `open` (no claim). `AccountingFormState`
    gains `{ twins, ackToken, values }`.
  - An own-pocket request whose money is already a kassa-less cost on a truck
    cannot be closed by any door. STATED in §6 and printed in the warning:
    «o'z pulidan» is set on the cost, then the request is closed by «Rad
    etish» with a reason.
- **The expense form holds its inputs (B5).**
  - Drop `action={formAction}` and post from `onSubmit` with
    `preventDefault` + `startTransition`, so React's auto-reset never runs.
  - After a clean save, reset explicitly.
  - A source-shape fence refuses `action=` on that form.
  - The e2e asserts that every field survives the warning on both the kassa
    path and the payer path.
- **Not covered, on purpose.**
  - The crate builder's own fee (`createCrate`, a warehouse door, kassa-less;
    the count and the merge catch it).
  - `confirmReceipt`'s `extraCosts`, which no screen sends since #1045. That
    door is closed: the schema refuses a non-empty list with
    `extra_costs_retired`.

### 8.3 The map's money (§1)

- **«Kitob jami».** Kitob jami = direct + opex, from the same `profitAndLoss`
  call. The hero = kitob jami − fxTotal = `pnlParts.cost`.
- **Every breakdown reconciles to kitob jami, never to the hero.** A bridge
  line follows it: «Kurs farqi ±$F — hech bir sklad/partiyaga tegishli emas»,
  then = Jami. The bridge is rendered from the same `pnlParts` result.
- **Kurs farqi prints as its effect on the cost.** That is −fx: a gain prints
  «−$X». The figure and its parts print in cents.
- **Percentages are taken within each group.** Kinds as a % of direct,
  categories as a % of opex.
- **`spendKind` tests the truck stamp FIRST:** `batch_id IS NOT NULL` →
  partiya, then receipt / crate / pickup by scope. One SQL fragment serves the
  bars, the Sklad grouping and the register's «joy» filter. A grid-stamped
  cell is never under its receipt's warehouse.
- **The yashik packing warehouse.** A `LEFT JOIN LATERAL` to the crate's
  `crate_packed` movement, with no box-status filter. With no movement the cost
  goes to «sklad ko'rsatilmagan».
- **«Kim to'ladi».**
  - `payerKindSql({ seesStaff })` takes `seesStaff` as REQUIRED. Without staff
    sight there is no «o'z puli» branch: the row lands in «qarzga yozilgan
    (kontragent)», and `?payer=own` is dropped from the URL.
  - Expense rows get their own seventh bucket, «kassasiz yozilgan xarajat».
    «navbatda» and «tarix» apply to costs only.
  - Σ buckets == kitob jami for every reader.
- **Unconverted money.** Every money row from cost entries carries
  `count(*) FILTER (WHERE amount_usd IS NULL)` in the same query. A zero sum
  with N > 0 prints «kurs yo'q», never $0.
  - A truck row exists when the truck has a live cost dated in the period.
  - Order: dollars, then the unconverted count, then code.
  - A truck with N > 0 is always listed.
- **The kind chip.** One pure `spendTruckChip({ internal, continuation,
  revenueUsd, tracked })`:
  1. internal → «ichki reys · faqat tannarx» (even when tracked);
  2. `tripKind`'s continuation → «davomi»;
  3. tracked → «💰 foyda hisobi»;
  4. otherwise no chip, with one legend line.

  The inputs are read for the DRAWN rows only, ideally through one extracted
  `truckKindInputs(ids)` shared with `profitByBatch`.
- **Truck row links.**
  - «tannarx →» goes to the truck's Narx tab (`batchTabHref(id,'narx')`) when
    `mayOpenBatchCard && mayOpenBatchPricing(internal)`.
  - Otherwise to the xarajat tab when `mayOpenBatchCosts`.
  - Otherwise plain text.
  - The fold heading carries one «Partiya foydasi →» link with its from/to.
    Its muted note says that page lists marked trucks by departure date.
- **The period.** A pure `sarflarPeriod(params, now)`: with no valid from/to it
  is month start → Tashkent today; otherwise `resolvePeriod`. Every outbound
  link carries from/to explicitly.
- **Which period owns a twin pair.** The period containing the later row's
  date. The count reads rows: «N ta yozuv tekshirilmagan» = distinct rows with
  at least one unacked twin.
- **The read-only live count before shipping** includes the judge's three:
  - forged-scope rows (crate/pickup carrying `batch_id`, etc.);
  - live costs on cancelled trucks;
  - twin hit rates.

### 8.4 Doors and links

- **One page-wide link rule.** Every link on the map or /kiritish asks its
  destination's own predicate; where it would refuse, plain text. The helper is
  `costTargetHref(actor, row)`:
  - truck → `mayOpenBatchCard`;
  - receipt → `receiptsReadableBy`, asked once per page;
  - crate → `crates.manage && inScope`;
  - pickup → always a link.
- **Kassa-side links** (Kassalar, «＋ Umumiy xarajat», category →
  Xarajatlar, navbatda → xarajat-kassa) are drawn only under `mayPickTill`.
  Otherwise the kassa bucket links to /accounting/balance.
- **Expense rows on the map.** The row gate is a REQUIRED reader argument,
  `expenseRows: maySeeStaffMoney(…)`.
  - The test actors are two invented roles, A = finance.manage +
    finance.reports and B = clients.manage + finance.reports, neither holding
    finance.expenses.
  - The accountant is the control.
  - Never «analyst», a word this codebase reserves for the admin roles.
- **XLSX.** Its own route, `api/accounting/sarflar/route.ts`.
  - Door: `companyMoneySight`, else 403.
  - The builder takes the sight, `includeStaff`, `costSightFor` — all required
    — and the page's own validated filters.
  - It never reuses `buildExpensesXlsx`'s row reader.
  - The download writes an audit row.
- **The money-reader fence** learns `companyMoneySight(` as a gate, and every
  new loader joins MONEY_READERS with the sight as a required argument.
- **A crate cost has no void door for the accountant** without
  `crates.manage`. STATED in §6; the register still offers no 🗑.

### 8.5 The write path (§4)

- **The cancelled race (B6, a blocker).**
  - `cancelBatch` moves its cost and charge guards BELOW the member-box
    `FOR UPDATE`. Before them it takes a raw `SELECT status … FOR NO KEY
    UPDATE` on the truck and re-checks the status.
  - The order is advisory → boxes → truck. It is never truck before boxes,
    because the phone's scan path locks boxes and then the truck.
  - `addCostEntry`: every validation, rate, till and target-nulling stays on
    the pool. Then one short `db.transaction`:
    1. if the entry names a receipt, `SELECT … FROM receipts … FOR KEY SHARE`
       (refuse voided);
    2. then `SELECT status FROM batches … FOR SHARE` on the resolved truck —
       `batchId` for a batch, the internal `stampTruck` for a grid cell —
       refusing `cancelled`;
    3. INSERT;
    4. `writeAudit(tx, …)`.

    `recomputeEntry` and `chargeForCost` stay after the commit.
  - The race tests assert OUTCOMES on a held second connection:
    - cost-first → `batch_has_costs`;
    - cancel-first → `cancelled`, no row;
    - a stamped grid cell;
    - an annul-shaped holder → no 40P01;
    - a phone-shaped holder → a wait, never a deadlock.
  - Red proof: the guards moved back above the lock.
- **Normalisation.**
  - `addCostEntry` nulls every target id the scope does not name.
  - `stampTruck` is a separate second parameter that only `addGridCell`
    passes; the schema is non-strict, so a posted key is stripped.
  - `clientId` is stored only on a `direct_to_client` basis — a service rule,
    never a CHECK (`createCrate` legitimately stores a client on its weight
    fee).
- **The doors.**
  - `mayEnterBatchCost(actor, batch)` = status ≠ cancelled && `mayAt(actor,
    'costs.enter_batch', origin)`. Its SQL twin `mayEnterBatchCostWhere(actor)`
    sits in the same file, feeds the picker's rows AND its count, and is pinned
    against the JS form by a role × status × scope matrix.
  - Four askers: `addCostEntryAction`'s batch branch,
    `saveReceiptCostGridAction`, the tab's single `mayEnter`, and the picker
    / `?p=`.
- **`CostPanel` splits `canEdit` into `canAdd` and `canVoid`, both REQUIRED.**
  - The truck tab: `canAdd` = `mayEnter`; `canVoid` = `costs.enter_batch` at
    origin, status-blind.
  - The annul deliberately leaves kassa-paid costs live on a cancelled truck,
    so the void path never learns the status.
  - Receipt, crate and pickup mounts pass one value to both.
- **`costPanelOptions(actor, batchId, { mayEnter })`.** `mayEnter` is REQUIRED.
  When it is false: no `listPartners` call, and empty tills and clients.
  - Cost types come from one ordered reader, `activeCostTypes()`
    (`createdAt`, `code`), shared with the grid.
  - A batch-scope panel with no last-used type defaults to the `freight` code
    when it is active.
- **`?p=`.**
  - `isUuidShaped` first; otherwise the picker, with no query.
  - Not found and out of scope → the same sentence, «Partiya topilmadi».
  - Cancelled → «Partiya bekor qilingan — xarajat yozilmaydi».
  - A `batchForCostEntry(actor, raw)` loader serves both.
- **The picker.**
  - Filter: `batchTextMatchSql(likeNeedle(q))` AND `mayEnterBatchCostWhere`.
  - Order:
    1. exact code;
    2. `prefixNeedle(q)`, a new sibling of `likeNeedle`;
    3. a former-name hit;
    4. the rest by `created_at` DESC.
  - Unaliased `batches`.
  - The YW-1009 test gives YW-1009 the NEWER date.
- **`afterSave: 'again'`.** It opens the panel on mount and keeps it open after
  a save.
  - Amount, kassa amount and note are cleared.
  - Type, currency, date, payer and a proportional basis are KEPT — across a
    truck switch too (his 5a), held by a small client wrapper above the keyed
    panel and passed in as initial values.
  - A `direct_to_client` bill is a one-off: after any save the basis returns
    to the scope default and the client to empty, on every mount.
  - `key={id}` stays.
- **No `<Suspense>`** on either page, fenced.
  - Keep `router.refresh()` unless the action revalidates the panel's paths;
    it also revalidates /accounting/sarflar and /kiritish.
  - Picker rows are inert while a save or a twin confirm is in flight.
- **«Bugun men kiritganlar».** `entered_by = me AND created_at >=
  tashkentDayStart(tashkentDay())` as an ISO string `::timestamptz`, AND
  `voided_at IS NULL`. The out-of-period note:
  - tomorrow → «ertangi sana bilan» + that month's link;
  - before the month → that row's own month (named, or «O'tgan oy» when it is
    the previous month).

  The fixtures run at 00:00-05:00 Tashkent.
- **The refusal map.** `PAYER_ERRORS` is exported and fenced: every value
  exists in all four bundles, and every refusal code the actions and services
  can return is a key or sits on a counted allowlist.
- **360 px.** CostPanel's note line and chips get `[overflow-wrap:anywhere]`.
  The e2e types a 60-character unbroken note and asserts `scrollWidth <=
  clientWidth`.

### 8.6 Deliberately overridden or narrowed

- **J3 said partner × kassa is never a twin, matching M4a; J4 said it is.**
  Built as a twin with the payment wording. That pair doubles the P&L and
  leaves the debt standing, and warning about it is cheap. Stated to him as the
  judgement call.
- **J9 counted rows; J28 counted edges.** The count is ROWS («N ta yozuv
  tekshirilmagan»), so it reaches zero once he has answered them. The linked
  list groups the edges by the shared row.
- **J8(c), closing an own-pocket request onto an existing cost,** needs a
  migration and touches his 8a («not now»). Not built; stated.

## 9. As built — what the build and its two reviews changed (2026-10-14)

Read this before §8: where they disagree, this section is what the code does.
Decisions #1355-#1363.

- **The cross-currency arm of the twin rule is NARROWER than `sameMoney`**
  (overrides §8.1's «`sameMoney([cost], expense)` exactly» for two
  currencies). Measured on a dense synthetic book, the merge's band (2 % or
  $5, 14 days) produced 11 false twins per bill. The alarm keeps M4a's rule
  AND, between two currencies, `TWIN_FX_PCT` = 1 % of the expense's dollars
  (no floor) and `TWIN_FX_DAYS` = 3 days. One currency and one kassa stay
  exact; a restored expense keeps no day check. Everything the alarm calls
  «mergeable» the merge still accepts. A dollar-matched line is marked «≈»
  and ranked after the exact ones.
- **The count is answerable** (extends §1.5/J9). Each pair prints both rows;
  «✓ Ikki xil pul» (`ackTwinPair`, gate `companyMoneySight` + `mayPickTill`)
  re-decides the pair and writes a `twin_check` audit row with `twinAck` —
  read beside the create audit's. The expense side of the count is one
  MATERIALIZED pass bounded to the period's window.
- **`no_rate` is said after a CLEAN save too** (§8.1): `twinGap` rides on the
  success result of all three doors; the expense door also counts the
  rate-less truck bills in its window (`uncheckedOthers`).
- **Candidate figures are compared as stored** (`storedCents`: postgres
  rounds the decimal text half away from zero). A kassa-less cost already
  merged is `kassa_cash` (void), never `mergeable`. A completing-sum reads
  its group whole and ordered or not at all (`SUM_GROUP_CAP` 500). The expense
  door ranks by the cost's places (a truck by either end) — §8.2's order.
- **The extra-cost door is closed in the SERVICE**, not the schema (§8.2 said
  schema): `confirmReceipt` throws `extra_costs_retired` after its
  already-confirmed replay check, so an old phone resending a confirmed
  receipt still gets its answer.
- **Lock order** (§8.5): `cancelBatch` = advisory → truck FOR NO KEY UPDATE →
  costs and charges counted → cartons FOR UPDATE. A truck price
  (`addTransaction`, charge with `batch_id`) takes the truck FOR SHARE and
  refuses `batch_cancelled`.
- **The map's links ask the register** (§8.4): the register form is keyed by
  its filters; a payer or warehouse row links only where the reader's
  register has rows; the payer filter refuses expense-only buckets to a
  reader without expense rows; the truck's all-time Σ follows the «kurs
  yo'q» rule.
- **Still stated, not built:** sums across trucks or days; a sum in the map's
  count; closing a rasxod xabari onto an existing cost (J8(c)); a desk
  conversion beyond 1 % / 3 days is left to the M4a queue; two unrelated
  payments of the same round amount in one currency still warn.
