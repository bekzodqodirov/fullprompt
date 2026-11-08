# Horgos and Yallama queues hold the truck until the logist says it has crossed

Agreed with the owner on 2026-11-08. This is the spec for the round.

## 0. His words and answers

The request, verbatim:

> «men hohlagan narsa shu ediki sklad lan longi bor endi mashina yurib
> ketgandan keyin xtoydagi ochered va yallamadagi ochered kiritilgan endi.
> skladdan yolga chiqib ketganda shu yolda kutib seeekin yursin va agar logist
> qozoqda tugmasini bossa mashina chegaradan otib keyin yurishda davom etsin
> yallamada yana ocheretda turgandek seeekin yursin va logist ozbekistonda
> deganda ozbekistonga kirib skladga yurishni davom etsin. agar kopi bnda
> kiritilgan kundan otib ketsa logistga ogohlantirish kelsin»

His answers, all ⭐: **1a 2a 3a 4a 5a, kod HOR**.

1. **1a** — the truck stays in the queue until the logist presses the button.
   The typed days running out does not move it on.
2. **2a** — «ko'p oshdi» means more than one day past the typed MAXIMUM.
3. **3a** — the warning goes to the logists by Telegram, once per queue.
4. **4a** — the driver's phone is the truth. A fix beyond the queue moves the
   truck on without a press.
5. **5a** — on the map the truck stands at the post, with
   «navbatda: 2-kun (3 kundan)» beside it.

The Horgos warehouse code is `HOR`.

## 1. What already existed (2026-11-08)

- **The road.** `routeFor('HOR', TAS1|TAS2|AND)` builds `hor2uzLegs`, in this
  order:
  - `to_border` [1,3] h
  - `border_wait` at NZL, stationary, `post: 'khorgos'`, default [60,84] h
  - `kz` [18,30] h
  - `uz_queue` at the Kazakh road's end, stationary, `post: 'yallama'`,
    default [72,96] h
  - `uz` [2,6] h (TAS) or [14,30] h (AND)
- **Typed queues.** The logist types them on /trucks (`border_queue`,
  `loadBorderHours`) and `routeWithWaits` puts them in place of the defaults.
- **Pins.** `at_border` → `border_wait`, `in_kz` → `kz`, `in_uz` → `uz`. A pin
  re-anchors the walk at the press: the leg starts at the press.
- **The fix.** The driver's fix anchors the walk the same way a pin does
  (`fixAnchor`). The newest evidence wins.
- **The defect.** The schedule walks the truck OUT of a queue once the queue's
  midpoint passes, with no press and no fix. When the whole schedule is spent
  (186 h for TAS, 204 h for AND) and only the departure speaks, the place is
  `zoneOfRoute(base)`. That is null for a multi-zone road, so the truck reads
  «Joyi aniq emas» with no point. This was his first report of the day.
- **No warning.** No Telegram warning exists for a long queue. `TruckSilent`,
  for a phone that has gone quiet, is the only truck alarm.

## 2. The rule

A **held queue** is a stationary leg (`span[0] === span[1]`) that carries a
typed-queue `post`. Today those are Horgos (`border_wait`) and Yallama
(`uz_queue`), on the HOR routes only.

The Kashgar road's `border_wait` has no `post`, so it is NOT held. Its
behaviour is unchanged (regression fence).

**The walk never leaves a held queue by time alone.** It goes from the newest
evidence (departure, pin or fix) at the usual pace until it reaches the first
held queue at or after the anchor's leg. Then it STOPS there. Only newer
evidence on a later leg moves the truck past it:

- a pin `in_kz` or `in_uz`;
- a fix projected onto a later leg (4a).

That evidence becomes the anchor, so the next held queue ahead is the next
stop.

### 2.1 Entry: when the truck entered the held queue

| Anchor | Entry |
|---|---|
| Departure (or a moving-leg fix) before the queue | anchor leg start + Σ midpoints of the legs before the queue (the engine's own walk, `routeWithWaits` hours) |
| Pin `at_border` | the press. «Chegarada» means «count the queue from now» — the meaning it has always had, and the logist's way to restart the clock after phoning the driver |
| Fix at the post (`QUEUE_RADIUS_DEG`) | as today: the pin's press if the pin names this queue, else the walk's entry if it came before the fix, else the fix's moment, never before the departure |

**Changed:** the «disproved entry → count from the fix» reset in `fixAnchor`
no longer applies to a held queue. Under the hold a walk can never be
«disproved» by a fix that still sees the truck in the queue. A reset on every
fix would also restart the clock on every report, so a truck phoning from the
queue would never be late.

**Changed:** `underNewerPin` in a held queue. A pin newer than a fix in the
same held queue wins, so entry is the press.

### 2.2 What the held place says

`stood` = now − entry, in hours. `[h0, h1]` = the queue's hours as given
(typed or default, `routeWithWaits`). `after` = Σ of the later legs'
`[min, max]`.

| Field | Value |
|---|---|
| zone, segKey | the leg's (`border`, `border_wait` / `uz_queue`) |
| point | the post. A FRESH fix that is itself in the queue keeps the fix point |
| progress | the length up to the post |
| remainingHours | `[max(0, h0 − stood) + after0, max(0, h1 − stood) + after1]` while `stood ≤ h1`. **null** once `stood > h1`, because nobody knows when it will leave |
| overdue | `stood > h1 + 24` (2a, `QUEUE_LATE_HOURS = 24`) |
| queue | `{ post, enteredAt, stoodHours, hours: [h0, h1], afterHours, over: stood > h1, late }` |

The remainder `h − stood` (not the engine's `h × (1 − stood/mid)`) is
`slowestArrivalMs`'s own queue rule. Inside a held queue this replaces the
engine's proportional remainder, so the date and the deadline agree. It
moves today's dates for HOR trucks inside a queue a little: the lower bound
comes earlier and the upper bound later. Stated, not hidden.

### 2.3 Readers (all through `placeTruck`)

- **`truckRow`**
  - late → kind `overdue` (the card's «Kechikkan», ranked first, the board's
    warning);
  - over but not late → `on_road`, no date, `arrivalOrder = after0`;
  - inside the window → `on_road` with the date (`placeDated`).
- **`TruckRow.queue`** is new, passed through.
- **`truckRoadWords` sentence** (5a), keyed by `trucks.queue.post` names:
  - «Horgos navbatida: 2-kun (2–3 kundan)»;
  - over: «… 4-kun — kiritilgan 2–3 kundan oshdi», in warn colour;
  - late: also «haydovchi bilan bog‘laning».

  It replaces `map.overdue` for a queue row.
- **Map popup** (`TruckMarker.queue`): the same words. The bot's transit line
  has its own Uzbek literal.
- **Customer's cabinet:** no new words. Inside the window there is a date; once
  over, there is none (`placeDated`).
- **Board:** zone `border` → the «Chegarada» section. «Joyi aniq emas» is gone
  for a departure-only HOR truck.

`scheduleEstimate` has no production reader (only tests). It stays the raw
walk with no hold, and its doc says so.

## 3. The warning (3a)

`alertLateQueues(now)`:

- **Rows:** every in-transit truck's TruckRow, built as the dashboard builds
  them (inTransitBatches → evidence → truckRow). Keep those with
  `queue?.late`.
- **The claim:** `truck_queue_alerts(batch_id, post)`, primary key on both,
  migration **0140**. `INSERT … ON CONFLICT DO NOTHING RETURNING` runs in the
  SAME transaction as `queueStaffTelegram(tx, …)` — `notifyStaffTelegramOnce`'s
  shape. Then the drain is kicked. Once per (truck, post), never re-armed: a
  later «Chegarada» press restarts the screen's clock but sends no second
  message (3a).
- **Recipients:** `usersWithPermission('plans.manage')`, read on the pool
  BEFORE the transaction (#714), the same list `TruckSilent` uses.
- **Type:** `TruckQueueLate`, in the `alerts` mute group (a newcomer, never in
  FOUNDERS).
- **Text** (Uzbek, like `silentTruckText`):

  > «⏰ {code} ({plate · driver}): Horgos navbatida {n}-kun turibdi —
  > kiritilgan {given} kundan oshdi. Haydovchidan so‘rang. Chegaradan o‘tgan
  > bo‘lsa, mashina kartasida «Qozog‘istonda» tugmasini bosing.»

  For Yallama the button is «O‘zbekistonda». The message ends with the link to
  the Mashina tab.
- **Schedule:** every 30 minutes in the Tashkent office day,
  `'*/30 3-14 * * *'` UTC. A threshold crossed at night is told at 08:00.

## 4. Not done, stated

- **The queue clock starts at the walk's entry.** There is no «first fix at
  the post» history. A truck that left the yard late reads as having stood
  longer than it has.
- **After «O'zbekistonda» nothing changes.** Once the uz leg is spent, the
  truck reads «Kechikkan» until the unload scan, as before.
- **The Kashgar road's Irkeshtam wait is not held.** It has no typed queue.

## 5. As built — the design judge's corrections (BINDING; they override §2-§4)

Five lenses judged v1 before code (placement, readers, alert, regressions, intent). Their
confirmed objections changed the design. Where §2-§4 and this section disagree, this section
wins.

1. **The walk never dates an entry across a held queue.** v1 dated a phone first seen at Yallama
   from the departure by walking Horgos at its typical 72 h. That made the truck 96 h into a queue
   it had just reached, and spent the once-only warning (the blocker).
   - The walk now dates an entry only when no held queue lies between the prior anchor and this
     queue.
   - Otherwise the entry is the phone's own history: `queueSinceFor`, the first fix within
     `HELD_QUEUE_RADIUS_DEG` = 0.15° of the post AFTER a fix outside it, i.e. an arrival the
     phone saw.
   - If there is no history, the entry is the fix.
   - Within reach of the walk, the phone that saw the arrival outranks it (4a).
2. **The held radius is 0.15°, not 0.05°.** A queue is kilometres of lorries. A phone in its tail
   read as «driving to the post», and its clock restarted on every report.
3. **The wait is the one the /trucks panel shows** (`givenWait`: typed, or his default). It is
   counted from the entry, or from the typing if it was typed while the truck already queued.
   - It is SHIFTED, never stretched. `withLead`'s scaling printed «2–4 kun» beside a typed
     «0,5–1».
   - The «had it crossed before the change» branch of `queueHours` has nothing to say about a
     held truck, which has not crossed by definition.
   - Later queues are priced at the wait they give NOW.
4. **«kiritilgan» only for a typed number, «odatdagi» for his default** — on every screen and in
   the message.
5. **A fresh fix is drawn where the phone is, held or not** (round 100 9a).
6. **The cabinet ranks a held-over truck as latest** (`arriveBy` '9999'). Otherwise a lot split
   over two trucks showed the other truck's date for the cartons stuck at the border.
7. **The warning re-arms on a wait that BEGAN after it**, i.e. a «Chegarada» press after the
   call. Time alone never re-arms it. The claim stores `entered_at`.
8. **ONE message per sweep, listing every truck that turned late** (capped at
   `LATE_QUEUE_LINES`). On deploy morning every HOR truck nobody ever pressed past Horgos turns
   late at once. The buttons are named with their flags, and from Horgos both are named.
9. **`TruckQueueLate` is in the `alerts` mute group** and pinned by a named test. A
   direct-queued type is invisible to the routing scan.
10. **One migration behind, the sweep says so once and sends nothing.**
11. **The map label shows the day of the wait beside the code** («HR-001 ⏳2»), in both
    renderers.

12. **On the Horgos road a standing pin is not pressed off** (`pin_kept`, checkpoint.ts). A
    second tap of «Qozog‘istonda» to «confirm» used to clear it and send the truck back into the
    Horgos queue, late. A pin off the road still clears; moving it is pressing another place.
13. **The border pin is named «🛃 Horgosda turibdi» on a road that holds** (`pinLabel`), on the
    Mashina tab, the board's ⋯ and the card's road line. A Yallama truck is «at the border» too;
    the Yallama warning says not to press it.
14. **The warning re-arms on the wait's COUNTING start** (`QueueHold.countedFrom`: the entry, or
    the typing on /trucks if later). With the toggle gone, typing a new wait is how the logist
    restarts the count, and a wait typed after the warning is a new wait.

**Rejected or stated:**
- **To restart the Horgos count, type the wait again on /trucks** (the panel says so). It moves
  the count for every truck in that queue — the panel's own rule since 2026-09-29. A
  «Horgosda turibdi» press restarts it for a truck that has no pin yet.
- **`scheduleEstimate` stays the raw walk.** It has no production reader. The panel's promise is
  now pinned through `placeTruck` (queue-hold.test.ts).
- **Deploy morning:** trucks the old walk had moved past Horgos snap back to Horgos «late» until
  the logist presses. This is said to him, and the one listing message is that list.
