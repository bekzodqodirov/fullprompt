# One card per truck, and the client's «Pul» tab (2026-09-28)

The owner's answers to the UX review (canvas «GSR tizimi — qulaylik xaritasi»,
boards 3 and 4):

- **3a** — «Partiya bitta kartaga yig'ilsinmi? Skanerlash ekrani telefonda
  baribir alohida, to'liq ekran bo'lib qoladi.» → **ha**. Board 4's title was
  «6 sahifa o'rniga bitta»; the six pages it counted were the card, the
  loading scan, the unloading scan, the cost grid, the prices and the TNVED
  codes.
- **4a** — «Mijozning hisob varag'i mijoz kartasiga «Pul» bo'limi bo'lib
  kirsinmi? Kim pulni ko'radi, degan ruxsatlar o'zgarmaydi.» → **ha**.

The first draft of this file was judged by four adversarial lenses before any
code: access and money sight, regressions and tests, the phone, and data truth
and speed. Their findings are folded in below. The ones that changed the
design are marked **(R)**.

## Rules that do not move

1. **No route moves.** `/batches/<id>`, `/xarajatlar`, `/pricing`, `/tnved`,
   `/load`, `/unload`, `/admin/clients/<id>` and `/finance/<id>` all keep
   answering (Telegram, notifications and fifteen money screens link them).
2. **A tab is a URL** — a link, not client state. Each tab page asks its OWN
   door. The strip draws a tab exactly when that door admits the viewer, and
   the page and the strip call the same function.
3. **Money sight does not change** (4a; law 4; Q19). A money figure or a
   money-derived COUNT reaches only the audience of the page it links to. The
   loaders take the sight as plain values, keeping the pricing page's
   «price-only never READS the tannarx» shape **(R)**.
4. **Every header number is the destination's own function** (#513). It links
   there, and a tile pointing at the tab you are on renders without a link.
5. **The scan screens stay full-screen.** `/load` and `/unload` are not tabs.

## The truck: one card, six tabs

`BatchCard` is a server component that draws the header and the strip. Every
tab page renders it around its body. It is not a Next layout, because a layout
would:
- wrap `/load` and `/unload`;
- be kept, and go stale, across tab switches;
- need a client hook to know the lit tab.

Shared reads are module-level `cache()` wrappers keyed by primitives only.
React keys object arguments by identity, so `costSightFor(actor)`,
`{batchIds:[id]}` and `[id]` would miss every time **(R)**. Each money read
catches its own failure and drops the figure, because `cache()` memoises
errors and one bad read must not take every tab down **(R)**.

| Tab | URL | Door (page and strip call the same predicate) |
|---|---|---|
| **Tarkib** | `/batches/<id>` | card door: origin OR destination in scope (unchanged) |
| **Yuklash** | `/batches/<id>/yuklash` (new) | card door |
| **Xarajatlar** | `/batches/<id>/xarajatlar` | `costs.enter_batch ∨ reports.all_warehouses` + card door |
| **Narx** (internal leg: **Tannarx**) | `/batches/<id>/pricing` | `pricingSight ≠ 'none'` + card door |
| **Bojxona** | `/batches/<id>/tnved` | `ved.docs ∨ plans.manage` + card door. **The scope half was missing — closed** |
| **Mashina** | `/batches/<id>/mashina` (new) | card door |

Tab labels are short on every width. The pricing page's h1 and the grid
page's h1 became h2s, so the code stays the page's one h1; Tarkib carries no
title of its own, because the lit tab names it. On a phone the strip is a
3-column grid of chips: no JS, every tab and badge visible, labels at 12 px so
«Себестоимость» fits a third of 328 px and a label that still does not fit
wraps rather than being cut to «Тамо…» (measured, first build). From `md` it is
a wrapping row. Each link carries `#tabs`, and the strip has
`id="tabs" tabIndex=-1`:
- on a phone `scroll-mt` lands the strip under the app bar, so a tap SHOWS the
  new body instead of the same header;
- from `lg` a margin larger than the header clamps the scroll to 0, so the
  whole header stays in view.

Links from Telegram and other screens carry no hash and land at the top **(R)**.
Each page sets its title («B-00123 · Xarajatlar») for browser tabs and the
route announcer **(R)**.

### The header — measured, and compact **(R)**

The first draft put the tab body at y = 756 for a loader, 1250 for the
accountant and 1633 for a logist with missing cartons at 360×800. It was
1000+ px of header on EVERY tab. At 1280×900 the body started at 926.

The header now is:

1. **«← Partiyalar»** — only for `mayReadBatches`. /batches bounces the
   accountant, sellers and the viewer **(R)**.
2. **The identity card** (`!p-3`):
   - Row 1: the code (`BatchCodeForm`, the one h1), the route, and the status
     chip «Yo‘lda · 3/6» (the fraction below lg only). Then ProfitTracked as a
     chip, for `finance.reports`, with its hint moved to the Narx body; and the
     created date from lg.
   - The ladder (below).
   - While forming/loading: the loaded line «N/M 📦», counted over the LIVE
     pointer only. Its status filters were not tied to the pointer: every
     closed truck read «0/0» and unloaded ones counted cartons now planned on
     the next truck **(R)**. Its chips follow: on-spot and counted.
   - After departure, one `text-xs` facts line:
     - «🚀 date»;
     - «Rastamojka ✅ dd.mm / —», for a truck that crosses a border by the
       VED's `sameCountryLeg` rule;
     - the on-spot and over-arrived chips.
   - While in transit or arrived: the dashboard's own word and sentence
     (`components/truck-road.tsx`, moved out of the dashboard's trucks card) —
     days on the road, the ETA where a schedule gives one, and the latest pin
     as a DATED fact («belgi 2 kun oldin», never «still there»).
   - The pairing code, while forming/loading only, on one line.
   - The stage buttons this viewer can press, and only those:
     - `open-loading`;
     - `BatchActions`, with its «Yakunlash» now drawn only for a loader at the
       origin — it answered 'forbidden' for everyone else;
     - `open-unloading`.
3. **KPI tiles, from `lg` only.** On a phone they repeated the tab below them
   and cost 130–384 px.
4. **«Qolgan ishlar»** — one wrapping row of warn chips under the card,
   absent when empty. The first build folded it into a `<details>` on a phone
   and the fold cost a tap to learn there were three things to do; the chips
   are shorter than the fold's own summary was once the labels were cut to
   two words. Each item is a label plus a count, so no plurals are needed.
5. **The strip.**

`UnloadActions` (acceptance, finish, the missing-carton resolution, close) and
the two count panels move INTO the Yuklash body. UnloadActions measured 812 px
for three missing lots and ~1 800 px for twelve, which would sit above every
other tab **(R)**.

### What each tab holds

**Tarkib**
- The contents table and crates, then tasks and custom fields, stacked AFTER
  the table.
- Membership is the RIDERS rule, void excluded — the membership of the money
  tabs, the grid and «Partiya foydasi» **(R)**. The old `batchMemberFilter`
  put 100 cartons on the tile and 99 on the cost line on 1 200 of 1 422
  shaped trucks: a carton found back at the origin, an annulled one, or an
  office count-over.
- The documents keep `batchMemberFilter` (what was declared).

**Yuklash** — `UnloadActions` (anchor `#missing`), the count-accept `Panel`
(`#count-accept`), `CountLoadPanel` (`#count-load`), then the box-by-box
loaded list, with an empty sentence while nothing is aboard.

**Xarajatlar** — the truck's own bills first (`CostPanel`, «xarajat
yozilmagan», Σ, «🔒 others»), then the receipt grid. Nothing in the tile ever
prints «≈», which the m9 specs read strictly.

**Narx** — the pricing page. «Foyda» on an unpriced truck used to be a red
−tannarx. It now says «narx yo‘q» through the dashboard's `tripKind` (|revenue|
≤ 0.009), on the page AND the tile **(R)**.

**Bojxona**
- The papers first (`#hujjatlar`: invoice, packing photos, attachments,
  «agentga yuborildi»), then «🛃 Rastamojka» (the same folded panel and badge),
  then the TNVED editor.
- Its lot list is fixed **(R)**. It read the live pointer whenever ANY carton
  still pointed at the truck, so mid-unload — at a customs warehouse, exactly
  when the VED declares — it hid every lot already scanned off: 58 lots on 25
  trucks of one database. Before departure it now reads the live pointer, after
  departure the departed cartons (`aboardFilter`).

**Mashina** — vehicle and driver, the driver's phone (the pairing code lives
here after departure), «Mashina qayerda?» pins, and «Xaritada ko'rish» for
`mayReadBatches` only; /map bounces everybody else **(R)**. The sections were
the card's folded rail panels; here they are the page, so each is open. The ETA
is the header's, said once. (Named «Yo'l» in the first draft: the tab holds
the lorry, the driver and his phone, and the road is the header's sentence.)

### Header numbers (lg tiles; links)

**Yuk** — riders Σ boxes, with m³ · kg beneath.
- Source: `batchLots(id)` — the Tarkib table's own rows, and its Σ equals
  `riderLoad` (pinned by `truck-card.integration.test.ts`).
- Audience: the card.
- Links to: Tarkib.

**Mijozlar** — distinct clients (+ markings) · prixods.
- Source: the same rows.
- Audience: the card.
- Links to: Tarkib.

**Xarajatlar** — `$X`.
- Source: `batchCostSheet(...).totalUsd` (the tab's Σ). Unconverted entries
  show as «⚠ N» exactly as the Σ line does.
- Audience: the cost door, and only a non-null total (the VED's is null).
- Links to: Xarajatlar.

**Narx qo‘yilgan** — «N / M».
- Source: `pricingView(...).totals.priced / clients` — the page's own
  `pricedOf`. Neutral colour (see the open question).
- Audience: the pricing door, and not on an internal leg.
- Links to: Narx.

**Foyda** — margin, or «narx yo‘q».
- Source: `pricingView` totals through `tripKind`. Beneath it: «narx $P ·
  tannarx $C», plus «oldingi reyslar $P'» when present.
- Audience: `pricingSight = 'full'`, and not on an internal leg.
- Links to: Narx.

The money values use the house compact format (`compactUsd` + exact on hover).
Xarajatlar ($X, the truck's own bills) and tannarx ($C, the landed cost) are
different figures. Each carries its destination's own label.

### «Qolgan ishlar» — each gated by the door of the exact thing it links to **(R)**

- **«Qabul qilinmagan N»** → `/yuklash`
  - Rule: `remainingToUnload`.
  - Shown to: in_transit/arrived, for whoever can act: `scan.unload` or the
    destination's shortcut or count door.
- **«Yo‘lda yo‘qolganlar N»** → `/yuklash#missing`
  - Rule: the missing list.
  - Shown to: the resolution doors (`receipts.void` at the destination, or its
    count door).
- **«Sanab yuklash N»** (lots) → `/yuklash#count-load`
  - Rule: `qrlessUncountedByTruck`.
  - Shown to: loading, `countDoorFor(actor, origin)`.
- **«Sanab qabul N»** (lots) → `/yuklash#count-accept`
  - Rule: lots with `mode ≠ null` and awaiting > 0. «awaiting» alone is every
    carton still aboard **(R)**.
  - Shown to: unloading, `mayCountMove(actor, dest)`.
- **«Xarajat yozilmagan»** → `/xarajatlar`
  - Rule: `batchCostEntryCount = 0` after departure (the tab's own warning).
  - Shown to: the cost door.
- **«TNVED kodsiz N»** (products) → `/tnved`
  - Rule: distinct `productKey` over the editor's own list with no
    `tnved_assignments` row.
  - Shown to: `ved.docs ∨ plans.manage`, while customs is not cleared.
- **«Agentga yuborilmagan»** → `/tnved#hujjatlar`
  - Rule: `vedFlowCounts`' `docsPending` predicate as ONE SQL fragment, asked
    of this truck. It is three-valued (an empty country ⇒ not pending).
  - Shown to: `ved.docs` only — the one person who can clear it **(R)**.

Tab badges count ITEMS, never cartons or clients, so no badge mixes units.

**Deliberately NOT items (R):**
- «N clients unpriced» — pricingView's `priced` would be a fifth «unpriced»
  rule; `finance/unpriced.ts` owns that word.
- «N prices differ from the cargo» — the page's blocks come from two reads.

The Narx tab shows both, where they are explained.

### The ladder

Board 4 drew seven ordered steps. The data cannot fill an ordered bar
honestly:
- the border is one latest pin;
- «rastamojka tugadi» is a toggle, usually stamped after arrival at a customs
  warehouse;
- `finishUnload` can skip «arrived».

So the ladder is the status chip's own six words, one `<ol aria-label>` with
`aria-current="step"`: Shakllanmoqda · Pogruzka · Yo‘lda · Yetib keldi ·
Tushirilgan · Yopilgan.
- Dates appear only where a column stores one, as `<time>`.
- Below lg the labels are `sr-only` and the bar shows, as one markup (#509).
- The pin and customs are FACTS, outside the `<ol>`, and appear only after
  departure.
- A cancelled truck shows «Bekor» instead of the ladder.

**ETA:** the dashboard's sentence builder moves next to `truckRow` and is read
by both. The input comes from `inTransitBatches` filtered to this truck (the
departed count, the names). It is only for in_transit/arrived — fed an
unloaded truck, `truckRow` says «overdue».

### Holes found on the way, closed here (R)

- **Eight batch actions called `authorize(code, {})` with no warehouse:**
  sent-to-agent, customs firm, per-prixod customs, customs cleared, profit
  tracked, map pin, pair, revoke. The three `batches.vehicle_info` ones are
  held by SCOPED seeded roles, so a Yiwu operator could move any truck's map
  pin — the customer's stage and ETA — and pair or revoke any truck's driver
  phone.
  - All eight now pass one door, `authorizeOnBatch(permission, batchId)`
    (`wms/batches/batch-authorize.ts`): the permission, then the truck, then
    `mayOpenBatchCard` — the card's own door, never restated — refused as
    authorize's own `AuthError('forbidden')`. A truck that is not there is
    `null` and the action returns quietly, as before; an id that is not a uuid
    counts as not there instead of reaching postgres as a 22P02.
  - Per-prixod customs also checks that the prixod is one of
    `batchCustomsRows(batchId)` — the list the panel draws.
  - Revoke checks that the phone belongs to the truck.
  - Only the three `batches.vehicle_info` actions were reachable by a seeded
    scoped role; the other five matter for a scoped role he invents. All
    eight are pinned by a DERIVED source fence over every exported action
    (`batch-door-wire.test.ts`) and pressed for real as the demo people
    (`batch-door.integration.test.ts`).
- **`suggestTnvedForLotAction` took any lot id in the company,** read its
  photo and spent the AI budget. It now takes the truck and asks the card's
  door, and the lot must ride the truck.
- **`/load` and `/unload` had no scope check** (only the code leaked; their
  data routes are scoped). They now ask the card's door.
- **`VehicleForm` and `BatchCodeForm` were drawn to people their actions
  refuse** (a destination-scoped holder). They are drawn with the action's
  own door now.

### How it is pinned

- `tests/unit/truck-card.test.ts` — the tabs each seeded role is offered (this
  file's table, literal); for every role and both kinds of leg, «Xarajat» is
  `mayOpenBatchCosts`, «Bojxona» `mayOpenBatchVed`, «Narx» exactly when the
  pricing page's sight is not 'none'; every tab page lives where the strip
  links, lights its own tab, asks the two-ends door before drawing the card
  and keeps no permission redirect of its own; each «Qolgan ishlar» chip asks
  the door of the tab it links to.
- `tests/integration/truck-card.integration.test.ts` — one truck carrying
  every edge the membership rules disagree on. The UNION rewrites of
  `batchMemberFilter`/`aboardFilter` answer the old OR forms; the contents Σ
  is `riderLoad` (the old card counted two cartons that never rode and missed
  one that did); the loaded line reads the live pointer only; the TNVED list
  keeps a lot scanned off mid-unload; «Agentga yuborilmagan» is the VED home's
  sentence; the header's road row is the dashboard's.
- `tests/e2e/m9zzr-partiya-karta.spec.ts` — the SERVER as the oracle: as each
  demo person, every drawn tab answers 200 and every other one refuses; a
  third warehouse's operator is refused the whole card; at 360 px every tab
  fits and its body starts on the first screen. The `.desktop` twin: the
  tiles, one `aria-current="page"` on the page, and a tab link at 1280 keeps
  the header in view.

## The client: «Umumiy» and «Pul»

`ClientCard` (a server component, no CardCols) draws a back row, the h1
«GS777 — Name» (the page's one h1; m0/m8/m9zd read it strictly), the copy
chip and a two-tab strip:

| Tab | URL | Door |
|---|---|---|
| **Umumiy** | `/admin/clients/<id>` | `mayOpenClientCard(actor)` = `clients.manage ∨ clients.view_own ∨ crm.leads` (in `platform/clients`; `admin/layout.tsx` asks it too) |
| **Pul** | `/finance/<id>` | `mayOpenClientLedger(actor, client)` in `wms/finance/scope.ts` = `mayReadLedgers(actor)` (else redirect, BEFORE the lookup) ∧ `ownsLedger(actor, client)` (else notFound). The order is kept, or the URL answers «does this client exist» **(R)**. The card's `canSeeMoney` is this call |

- **The Pul badge** uses the ledger's own sign and colour, never a bare signed
  number **(R)**: «qarzdor $1,240» in red, «avans $300.00» in good, nothing at
  zero. The source is `clientBalanceUsd` (cached, ~1 ms).
- **The strip only when both tabs are drawn.** The accountant and the VED open
  the ledger but never the card; a seller opens any card but only their own
  client's ledger.
- **The back row** is on both tabs, so the strip never jumps: Pul →
  `/finance`, Umumiy → `/admin/clients` for `clients.manage`, else
  `/my-clients`. The VED's phone has no other way back from a ledger opened
  from the pricing page **(R)**.
- **Deactivate** and the dock marker stay in the Umumiy body.

### The lenta leaked money — closed **(R)**

`ClientFeed` printed every charge, payment, refund and compensation to anyone
holding `crm.leads`, for ANY client: on the client card, the deal card and the
lead card. That is the seller who, since round 91, may read only their own
clients' money. It was the one surface that never learned the rule, and it
would have kept showing money on «Umumiy» to exactly the people the «Pul» tab
excludes.

`clientFeed` now takes money as a REQUIRED argument (an optional one fails
open). Every card passes `mayOpenClientLedger` for the card's client, and the
money branches are dropped from the query, not just hidden.

### «Current page» is said once

A card tab carries `aria-current="page"`. Three places lit a PREFIX with
`"page"`:
- the workspace strip's tabs;
- its ⚙ settings;
- the phone tab bar.

They now say `"page"` only on their exact page and `"true"` beneath it.

## Open question for the owner

«Narx qo‘yilgan N / M» counts clients with a price on THIS truck. A client
whose prixod was priced on another truck, or on the deal, reads as unpriced
there, although the handover gate treats that cargo as priced. The page names
such clients «boshqa mashinada narxlangan». Should «N / M» count them as
priced?

## Deliberately not built

- A price column in Tarkib. The warehouse reads Tarkib, and money has its own
  tab.
- A mini-map in the card, and a per-truck focus on /map.
- Board 4's «2 turi hali kiritilmagan». No rule says which cost types a truck
  must carry.
- Narrowing the card's own door (any in-scope login).
- Board 3's full client redesign (KPI row, Yuklar/Bitimlar/… tabs). 4a is the
  Pul tab.
- A sweep of bare `authorize(code)` calls outside the truck's two action
  files. The eight truck actions and the TNVED suggestion were the ones this
  card draws; `saveTnvedAction` writes the company-wide TNVED memory, shared
  across trucks by design, so it takes no truck and stays as it is.
