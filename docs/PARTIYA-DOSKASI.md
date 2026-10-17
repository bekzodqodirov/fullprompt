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
| 3 | «Yo‘lda» sections | **a** | Four: Xitoy ichida · Chegarada (navbatda) · Tranzitda · O‘zbekistonda |
| 4 | The road % | **a** | By DISTANCE along the road — and the customer's cabinet follows, one number everywhere |
| 5 | GPS | **a** | A fresh fix decides the place and the % (not the schedule) |
| 6 | Loading date | **c** | Both: «Yuklandi 12–14.10» (first and last carton) |
| 7 | m³/kg while loading | **a** | «yuklangani / rejada» |
| 8 | Truck fill bar | **b** | NOT shown |
| 9 | Factory trips | **b** | In the matching column with a «zavod reysi» badge; a warehouse worker sees only trips coming to HIS warehouse (the ⭐ of the sub-question, unanswered → default) |
| 10 | Managing from the board | **b** | A «⋯» on the card: the logist's pins and a call to the driver |
| 11 | Horgos | **A** | Our warehouse there is a BORDER warehouse, like Kashgar |
| 12 | «ichki reys» badge | **A** | Yes |

## 1. Place — one vocabulary

Four places and «unknown», ONE type `RoadZone = 'cn' | 'border' | 'transit' | 'uz'`
(`tracking/place.ts`):

- **A warehouse's place** (`zoneOfWarehouse(country, type)`): a CN warehouse of
  type `hub` → `border` (Kashgar; Horgos once its type is set — §11); any other
  CN warehouse → `cn`; a UZ warehouse → `uz`; anything else → null. By TYPE and
  COUNTRY, never by code or name (the cabinet ladder's rule, `stages.ts`).
- **A leg's place** (`zoneOfLeg(segKey)`): `cn_transit`, `to_border` → `cn`;
  `border_wait`, `uz_queue` → `border`; `kg`, `kz` → `transit`; `uz` → `uz`;
  the generic `transit` leg → null. A Record over the leg keys, so a new leg
  that forgets its place fails the build.

Known approximation, stated: on the Kashgar road the `uz` leg starts at Osh, so
the ~25 km Osh → Dostlik read «O‘zbekistonda». The schedule has no Dostlik
point; adding one changes the legs every pin anchors to.

## 2. The road % — by distance (4a), from GPS when fresh (5a)

- `estimateTransit`'s `progress` becomes the DISTANCE share: chord length along
  `route.points` up to the dot ÷ the whole route (`chordDeg`, the engine's own
  measure). A stationary leg (a queue) has no length, so a truck waiting at the
  border keeps its % — the point of 4a. Every reader follows with no change of
  its own: the dashboard's bar (`TruckRow.roadPct`), the map popup's bar
  (`TruckMarker.progress`), the cabinet's «{from} N% {to}» (`CargoTransit`).
- The engine also returns `segIndex` and `segFrac` (the fraction of the leg, by
  distance, the dot already used) so the % and the GPS projection share one
  geometry.
- **GPS** (`placeTruck`, eta.ts — the one assembler): a FRESH fix (device or
  manual, ≤ `FRESH_MINUTES`) projected onto a known road within the snap
  tolerance (0.15°) places the truck: its leg, its %, and the remaining hours
  from THAT point (rest of the leg by distance + the later legs, the typed
  queues included). Within 0.05° of a queue's post the truck is IN the queue.
  A pin NEWER than the fix wins (the logist's word is the latest fact). A fix
  off the road, stale, or on a generic route places nothing; the schedule does.
- `TruckPlace = { zone, segKey, progress (0..1) | null, remainingHours | null,
  source: 'gps' | 'manual' | 'pin' | 'schedule' | null, evidenceAt, late,
  point }`. `late` = the schedule is spent (the truck is late) — with GPS the
  truck is still placed and dated from its fix; without GPS it is «overdue»
  exactly as today (no %, no date, `map.overdue`'s sentence), its zone the
  pin's if it has one, else unknown.
- `TruckRow` (`on-road-state.ts`) takes the fix as input and carries `zone`,
  `source`, `evidenceAt`, `late`; `roadPct` = the place's %. `kind` stays as
  today except a late truck placed by GPS is `on_road` (it is somewhere real);
  O15 is kept: no date on a rung the customer is shown no date for.
- `truckFor` (map) and the cabinet's `trucksFor` call `placeTruck` too — the
  cabinet gains ONE `latestPositions` read so its % is the office's %.
- Factory trips: `pickupPosition.progress` becomes the distance share of the
  trip's road (done legs + hops), the same rule.

## 3. The board

Header (title, «Xarita», the quick-batch form unchanged — five specs fill its
selects), the **road strip**, the filters, the four columns, the archive.

**Strip stops** (2a), each `count` + a small breakdown, a link `?joy=<key>`:
`forming` Shakllanmoqda · `loading` Pogruzka (Ichki Xitoy N · Chegara N) ·
`road_cn` Xitoy ichida · `road_border` Chegarada · `road_transit` Tranzitda ·
`road_uz` O‘zbekistonda · `road_unknown` Joyi aniq emas (only when > 0) ·
`arrived` Yetib keldi. Factory trips count where they stand («shundan N zavod
reysi»). `?joy=` filters the cards; a chip clears it.

**Filters** (GET, validated, #514): `sklad` = a warehouse the viewer may see
(origin OR destination; a trip's destination); `yonalish` = `irkeshtam` (a
route whose border leg has no post) | `horgos` (a `khorgos` post on the route)
| `ichki` (same country at both ends; every factory trip); `ogoh=1` = cards
carrying a warning.

**Columns and sections**:

| Column | Batches | Factory trips (9b) | Sections |
|---|---|---|---|
| Shakllanmoqda | `forming` | `planned` | by the origin's place (a trip: its destination's) |
| Pogruzka | `loading` | — | by the origin's place: Ichki Xitoy · Chegara · O‘zbekiston |
| Yo‘lda | `in_transit` | `on_road` | by `TruckPlace.zone` (a trip: its destination's place) + «Joyi aniq emas» |
| Yetib keldi | `arrived` | `arrived` (open) | by the destination's place |

**The card** (`/batches/<id>` or `/zavod/<id>`):

- code · route codes · plate · badges: «ichki reys» (12A, same country both
  ends), «zavod reysi» (9b), «Horgos orqali».
- cargo: forming «Rejada: N karobka · m³ · kg»; loading «Yuklandi a / b
  karobka» + «x / y m³ · x / y kg» (7a); departed: what RODE (`riderLoad` — its
  box count too, so one card never prints two counts); a trip: the logist's
  lines (driver recount over factory count) and «a / b zavoddan olindi».
- dates (6c), each in the WAREHOUSE's own zone (the agent sheet's rule): loading
  «Yuklanmoqda 15.10 dan» → departed «Yuklandi 09–10.10 · Jo‘nadi 10.10» →
  arrived «Jo‘nadi … · Keldi …». First/last carton = min/max `scan_events`
  (`type = 'load'`, the phone's capture time). A trip: «Rejada 19.10»,
  «Zavodlardan olindi 12–14.10», «Keldi …».
- on the road: a bar split into the route's places by distance, the %, the
  place in words (`map.seg_*`), the ETA (`dashboard.truckEta`) where O15 allows,
  and the source («jadval bo‘yicha taxmin» / «logist belgisi · 15.10» / «GPS ·
  2 soat oldin»).
- arrived: «Tushirildi a / b karobka» (departed − awaiting); stuck → the
  attention list's own `STUCK_AT_GATE_DAYS` warning.
- warnings: «sanash kutilmoqda» (unchanged), late, stuck, no GPS + overdue.
- **⋯** (10b): the pins of THIS truck's road (`checkpointsFor`, the Mashina
  tab's `CheckpointButtons` and action — it now also revalidates `/batches`)
  for `batches.vehicle_info` holders on an `in_transit` truck, and «📞
  Haydovchi» (`tel:`) when the phone is known. Nothing else: departure,
  cancel, reroute stay on the card.

**Phone**: the strip scrolls; the four columns become tabs (one at a time, the
counts on the chips); the cards are full width.

## 4. Who sees what

- The board's door is unchanged (`scan.load | scan.unload | ved.docs |
  plans.manage | batches.depart_close`) and its warehouse scope too.
- Factory trips: `mayReadPickups` → every open trip; otherwise `receipts.create`
  at a trip's destination (the card's own `mayReadPickup`) → those trips;
  otherwise none.
- The ⋯ pins: `batches.vehicle_info` + the card door (the service checks both
  again). The driver's phone: whoever sees the card (the Mashina tab prints it).

## 5. Not built (stated)

- The truck fill bar (8b).
- A GPS position for factory trips (no phone reports one).
- A Dostlik point on the Kashgar road (§1).
- Per-truck history of places (where it was yesterday).

## 6. Deploy

No migration. One step on his server: **Boshqaruv → Skladlar → Horgos →
Turi = «Konsolidatsiya habi»** (like Kashgar), or Horgos loads read «Ichki
Xitoy» (11A).
