# Partiya doskasi — hamma mashinalar bir joyda (`/batches`)

Agreed 2026-10-17. His message of 2026-10-17: «pogruzga qattaligini bilishim
kerak visual — ichki xitoydami yokida chegaradami · yolda bosqichida mashina
qayerda ichki xitoymi yokida transitmi · zavot reyslariniyam shu yerda … hamma
mashinalarni manage qiladgan joy · kartalarda: neccha kub necha kg, yuklandi
sanasi, yolga chiqgan kuni, necha foiz yolni bosib otdi». The proposal was a
canvas (A ⭐ / B / C) and twelve questions; his answers:

| # | Question | His answer | Meaning here |
|---|---|---|---|
| 1 | The board's shape | **A** | The four columns stay (Shakllanmoqda · Pogruzka · Yo‘lda · Yetib keldi); inside them, sections by PLACE |
| 2 | The road strip on top | **a** | A strip of counts per place; a tap filters the board to that place |
| 3 | «Yo‘lda» sections | **a** | Four: Xitoy ichida · Chegarada · Tranzitda · O‘zbekistonda |
| 4 | The road % | **a** | By DISTANCE along the road — and the customer's cabinet follows, one number everywhere |
| 5 | GPS | **a** | A fix decides the place and the % (not the schedule) |
| 6 | Loading date | **c** | Both: «Yuklandi 12–14.10» (first and last carton) |
| 7 | m³/kg while loading | **a** | «yuklangani / rejada» |
| 8 | Truck fill bar | **b** | NOT shown |
| 9 | Factory trips | **b** | In the matching column with a «zavod reysi» badge; a warehouse worker sees only trips coming to HIS warehouse (the ⭐ of the sub-question, unanswered → default, stated to him) |
| 10 | Managing from the board | **b** | A «⋯» on the card: the logist's pins and a call to the driver |
| 11 | Horgos | **A** | Our warehouse there is a BORDER warehouse, like Kashgar |
| 12 | «ichki reys» badge | **A** | Yes |

The design was judged by three lenses before code (tracking math, data and
doors, the screen and its tests — 41 findings, 3 blockers); this text is the
judged version.

## 1. Place — one vocabulary (`tracking/place.ts`)

`RoadZone = 'cn' | 'border' | 'transit' | 'uz'`, and «Joyi aniq emas» when
nothing honest can be said.

- **A warehouse's place** (`zoneOfWarehouse(country, type)`): a CN warehouse of
  type `hub` → `border` (Kashgar; Horgos once its type is set — §6); any other
  CN warehouse → `cn`; a UZ warehouse → `uz`; anything else → null. By TYPE and
  COUNTRY, never by code or name (the cabinet ladder's rule, `stages.ts`).
- **A leg's place** (`LEG_ZONE`, a Record over `LEG_KEYS`, so a leg added to
  the route table without a place fails the build): `cn_transit` → `cn`;
  `to_border`, `border_wait`, `uz_queue` → `border` (the road from the border
  hub to the post is «Chegara tomon yo‘lda», and a border-hub truck must not
  read «Chegara» → «Xitoy ichida» → «Chegarada»); `kg`, `kz` → `transit`;
  `uz` → `uz`; the generic `transit` leg → decided from the road's two ends
  (`zoneOfGenericRoad`: two Chinese ends → `cn`, two Uzbek ends → `uz`).
- The card always prints the LEG in words beside the place (`map.seg_*`:
  «Chegarada navbatda», «Qirg‘iziston hududida», …).

Stated approximations: on the Kashgar road the `uz` leg starts at Osh, so the
~25 km Osh → Dostlik read «O‘zbekistonda»; TAS2's dot is drawn 85 km from
Tashkent so both stay clickable, so a phone standing at the TAS2 yard reads
~90 % on a Kashgar → TAS2 truck until it is unloaded.

## 2. Where the truck is — the walk from the newest evidence (4a, 5a)

ONE mechanism, the pin's: the schedule walked from the NEWEST evidence
(`placeTruck`, eta.ts — the one assembler for the board, the dashboard, the
truck card, the map, the bot and the customer's cabinet).

**Evidence**:
1. the departure — leg 1 at `departed_at`;
2. the logist's pin — the start of its leg at the press (unchanged);
3. the driver's phone — its NEWEST fix with known accuracy ≤ 5 km (0 = the
   phone did not say, kept), timed `least(recorded_at, received_at)` so a
   phone clock running ahead never makes a fix newer than its arrival, taken
   after the departure (a fix from the yard is not the road), laid on the
   truck's road (`projectOnRoute`) within 2.5° (the Horgos road is still
   hand-drawn town chains whose chords run 2-5° off the real road; the map's
   drawing snap stays 0.15°):
   - on a moving leg: that leg at its DISTANCE fraction, the leg begun
     `fraction × the leg's typical hours` before the fix;
   - within 0.05° of a queue's post on the APPROACH side (every stationary
     leg — Irkeshtam too, not only the typed posts): IN that queue, entered at
     the pin's moment if the pin names this queue, else the schedule's own
     entry if it came before the fix, else the fix's moment — never before
     the departure. The far side of the post is the next leg (a truck past
     Yallama is in Uzbekistan).

**Precedence**: the newest wins. A pin newer than the fix that names the fix's
own leg adds nothing the fix did not say and keeps the fix's position (a
coarse «in Kazakhstan» must not drag a truck back to the start of
Kazakhstan). A stale fix is NOT thrown away: it anchors exactly like a pin,
so the truck does not jump back to the departure schedule when a phone goes
quiet. Freshness (`FRESH_MINUTES`, 8 h) only decides whether the map draws the
dot AT the fix and how the source line reads.

From the anchor the engine walks as today — the typed queues through
`routeWithWaits` counted from the anchor's leg-start moment — so the leg, the
%, the remaining hours and the date come from ONE walk.

**The %** (4a): the road's LENGTH behind the dot ÷ the whole road
(`chordDeg`, the engine's own measure). A queue has no length: a truck
waiting at the border keeps its % for the whole wait, which is why the leg's
words («Chegarada navbatda») always print beside it.

**Overdue** (the walk from the newest evidence is spent): no date, «kutilgan
muddatdan oshdi — haydovchi bilan bog‘laning» as today. The place is the
evidence's own leg and the % its position (a fix: its point; a pin: its leg's
start); with nothing but the departure the place is the road's single place
when every leg shares one (Yiwu → Kashgar is inside China), else «Joyi aniq
emas», and no %. The map draws an overdue truck at its last fix or pin.

`TruckPlace = { zone, segKey, progress | null, remainingHours | null,
overdue, source: 'gps' | 'manual' | 'pin' | 'schedule' | null, evidenceAt,
fresh, point, route }`.

**Readers**:
- `TruckRow` (dashboard, truck card header, the client card's «Yuklar», the
  board): the fixes are read for EVERY truck in scope before the rank (one
  statement), so a fix that changes a row's kind changes the counts too;
  `kind` keeps its meaning (`overdue` = the walk is spent); `roadPct` = the
  place's %; the date only on a moving rung (O15, unchanged).
- The office's words (`truckRoadWords`, one builder for the four screens): the
  WORD is the place's leg (`map.seg_*`, or «Joyi aniq emas»), the customs
  stamp a part of the sentence; the date's qualifier says its source
  (schedule / pin / GPS) and the evidence is dated once («GPS 3 soat
  oldin», «belgi 2 kun oldin»).
- The customer's rung (`stages.ts`) does NOT follow GPS: it moves on a
  person's pin or the arrival, as he designed it. So a truck GPS puts in
  Uzbekistan is «O‘zbekiston hududida» for the office and still «yo‘lda» for
  the customer until somebody pins it — stated, deliberately.
- The map (`truckFor`): the place; the dot at a fresh fix (snapped), else the
  walk's dot; `live` = a fresh fix anchors the walk.
- The cabinet (`trucksFor`): one fix read and `placeTruck`, so its % is the
  office's %; a truck with no % draws no bar.
- The bot and the cabinet map print days only for a dated place (O15 — they
  printed «~a–b kun» for a truck pinned in Uzbekistan).

## 3. The board

Header (title, «Yo‘lda» → /transit as today, «Xarita» → /map for its
readers, the quick-batch form unchanged — five specs fill its selects), the
**road strip**, the filters, the four columns, the archive (unchanged, its
box count now the riders' like the board's).

**Strip** (2a): one stop per place with its count, a link `?joy=<stop>`;
zero-count stops are plain text. Stops: `forming` Shakllanmoqda · `loading`
Pogruzka · `road_cn` Xitoy ichida · `road_border` Chegarada · `road_transit`
Tranzitda (with «Qirg‘iziston N · Qozog‘iston N») · `road_uz` O‘zbekistonda ·
`road_unknown` Joyi aniq emas (only when > 0) · `arrived` Yetib keldi.
Factory trips count where they stand. Counts are taken with every filter but
`joy`, from the SAME rows the cards are drawn from, uncapped (the oldest
open trucks are the stuck ones). The active stop carries
`aria-current="true"` (the menu already says «page» for /batches).

**Filters** (GET, every value validated, first value only, links built with
`hrefWith`, #514): `sklad` = a uuid among the viewer's own active warehouses
(a truck's either end, a trip's destination); `yonalish` = `irkeshtam` (the
road has a `kg` leg) | `horgos` (a `kz` leg) | `ichki` (no border crossed);
`ogoh=1` = cards carrying a warning; `joy` as above.

**Columns and sections** (every column has a «Joyi aniq emas» catch-all):

| Column | Batches | Factory trips (9b) | Sections |
|---|---|---|---|
| Shakllanmoqda | `forming` | `planned` | by the origin's place (a trip: its destination's) |
| Pogruzka | `loading` | — | by the origin's place: Ichki Xitoy · Chegara · O‘zbekiston |
| Yo‘lda | `in_transit` | `on_road` | by the place (§2); a trip on the road is `cn` (`uz` to an Uzbek warehouse) — a factory truck is on a road, not in a queue |
| Yetib keldi | `arrived` | `arrived` (open) | by the destination's place |

**The card** — a plain `div` holding a `Link` (text only) and, beside it, the
⋯ fold: interactive content is never inside the link.

- code · route codes · plate · badges: «ichki reys» (12A, no border crossed —
  his own word for Andijan → Tashkent on 2026-09-28; the money screens' «ichki»
  is the narrower China-only rule U1b and stays), «zavod reysi» (9b, alone on
  a trip).
- cargo: forming «Rejada: N karobka · m³ · kg» («rejasiz» on an empty quick
  truck); loading «Yuklandi a / b karobka · x / y m³ · x / y kg» (7a) — the
  server's number, the truck header's own rule (`batchLoadProgress` grouped
  for many trucks), which counts what has REACHED the server and so can trail
  the loader's phone; after «yuklash tugadi» the short-loaded cartons have
  gone back to the shelf and the truck reads a / a «hammasi yuklandi»;
  departed: what RODE (`riderLoad`); arrived: «Tushirildi a / b» = riders −
  still aboard (`awaitingUnloadCounts`). The words builder is called with
  `counts: false`, so one card never prints two box counts.
- dates (6c), all in TASHKENT time like the truck card's header and every
  date the office reads (R5): «Yuklanmoqda 15.10 dan» (nothing before the
  first carton), «Yuklandi 09–10.10 · Jo‘nadi 10.10», «Keldi 12.10». First and
  last carton = the truck's CURRENT cargo, each carton's latest load scan on
  THIS truck, timed `least(scanned_at, created_at)` and kept between the
  truck's creation and its departure (a phone's clock is not trusted, and a
  carton scanned by mistake and taken off is not cargo). One formatter,
  locale-free: «12–14.10», «30.09–02.10», one date when both are one day.
- on the road: a bar coloured by the route's places by distance (literal
  colour map, the queues as a notch — they have no length), `aria-hidden`,
  with the %, the place in words, the date and its source printed beside it.
- warnings (`ogoh=1`): «sanash kutilmoqda» (unchanged), overdue, stuck at the
  gate (`STUCK_AT_GATE_DAYS`), a trip arrived and still open after
  `INCOMING_STALE_DAYS`.
- **⋯** (10b), an in-flow fold (the card grows; one open at a time): the pins
  of THIS truck's road for `batches.vehicle_info` holders on an `in_transit`
  truck — the Mashina tab's option rule and buttons, the current pin drawn as
  a chip and NOT offered (clearing stays on the Mashina tab), every press
  compared with the pin the screen saw (`checkpoint_changed` — a press must
  never clear a colleague's pin it never saw) — and «📞 Haydovchi» (`tel:`,
  digits only, the number shown) when the phone is known. Nothing else:
  departure, cancel, reroute, rename stay on the card. A pin moves the card
  to its new section on the refresh; the fold closes with it.
- a factory trip: «a / b zavoddan olindi», its lines (driver recount over
  factory count, «noma‘lum» where the logist wrote no m³/kg), «Rejada 19.10»,
  «Zavodlardan olindi 12–14.10», «Keldi …», and its arrival range. NO % on a
  trip: its road is re-planned by every out-of-order press (B3), and a % would
  run backwards.

**Phone and narrow screens** (below `xl`, where four columns are ~120-215 px):
the four columns become tabs — a native radio group, ONE DOM (every panel
rendered, the tab shows one), the default the first column with a card, and a
strip tap opens the stop's column. Desktop (`xl`) shows the four columns.

## 4. Who sees what

- The board's door is unchanged (`scan.load | scan.unload | ved.docs |
  plans.manage | batches.depart_close`) and its warehouse scope too.
- Factory trips: `mayReadPickups` → every open trip, or a warehouse-scoped
  viewer's own destinations only (a role grant must not widen the board past
  its trucks); otherwise `receipts.create` at a trip's destination (the trip
  card's own `mayReadPickup`) → those trips, without the stale arrived ones
  (/receive's rule); otherwise none.
- The ⋯ pins: `batches.vehicle_info` + the card door (the service checks both
  again). The driver's phone: whoever opens the card (the Mashina tab prints
  it already).

## 5. Not built (stated)

- The truck fill bar (8b).
- A GPS position or a % for factory trips.
- A Dostlik point on the Kashgar road, and TAS2's real yard as a route end (§1).
- The customer's rung following GPS (§2).
- Per-truck history of places.

## 6. Deploy

No migration. On his server: **Boshqaruv → Skladlar → Horgos → Turi =
«Konsolidatsiya habi», mamlakati = CN** (like Kashgar), or Horgos loads read
«Ichki Xitoy» (11A). The Horgos road reads its place better once its roads are
fetched (`road-geometry.yml`, owed since the Horgos round).
