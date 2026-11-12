# Prixod kartasi — one order for the card

His words, 2026-11-11: «Prixodning interfaceini togirlab qoy ui ux designini
hamma narsa har hil joyda bolib ketgan».

Read as: the prixod CARD, `/receipts/[id]`. The receive wizard `/receive`
was looked at first (360 and 1280) and is tidy — three steps, one job each.
The card is where two years of rounds each added a block wherever there was
room. Said to him in the reply; the wizard is untouched.

**A layout round and nothing else.** No door, no action, no service, no
query, no URL and no `data-testid` changes. What a person may see or press
is exactly what it was the day before.

## 1. What was measured (main at 6b617d9e, fixture prixod of three lots)

| Reader | 360 px | 1280 px |
|---|---|---|
| admin | 4,223 px tall | 3,754 px |
| VED | 2,656 | — |
| YW operator | 2,420 | — |
| seller | 1,858 | — |

One column of cards in the order they were written:

1. number + status + «Stiker chiqarish»
2. a facts card (client, date, note)
3. «Zavod reysi» card — a 900 px wide select
4. «Bitim» card — another
5. «Yuk turi» card
6. «Hisob» card
7. «Mijozdan so'rash», then the lots
8. «Mijozni o'zgartirish» — a search box that is always open
9. «Boshqa skladga ko'chirish» — a full-width button
10. files and costs in one card under two headings
11. the void form (always open) or «Anulirovka…»
12. the staff thread
13. tasks, custom fields
14. history

Inside every lot the actions have six shapes in six places: print top
right, the QR switch, the QR-less print links, the pallet links, «✏️
Tahrirlash», and a text fold for the write-off — with the check box, the
photographs and the tarkib between them. Each lot of a VED's card carries a
full-width red button. Nothing on the card says how much cargo the prixod
holds: three lots mean three sums in the head.

## 2. The order

The same order on a phone and on a desktop; a desktop only puts two cards
side by side where both are short.

```
← back
NUMBER  [status] [🚛 FTL]                          [🖨 Stiker chiqarish]

┌ 1. SUMMARY  receipt-summary ─────────────────────────────────────────┐
│ MIJOZ                  JAMI                    QABUL                 │
│ GS777 — Alisher aka    3 lot · 100 📦           9-noy, 21:08 · YW     │
│                        2 070 kg · 5.2938 m³     👤 qabul qilgan …     │
│                                                ✍️ kiritgan …         │
│ 📝 izoh   ·  bekor qilish sababi                [✏️ tuzatish]         │
└──────────────────────────────────────────────────────────────────────┘
┌ 1a. EGASI ANIQLANMAGAN — only on an unclaimed prixod ────────────────┐
│ AssignClient (open, as today)        ReturnToSender                  │
└──────────────────────────────────────────────────────────────────────┘
┌ 2. BOG'LANISHLAR  receipt-links ─────────────────────────────────────┐
│ BITIM   current · [select][Saqlash]  │ ZAVOD REYSI  current · [select]│
│ YUK TURI  chip · [button]            │ HISOB  current · [select][…]   │
└──────────────────────────────────────────────────────────────────────┘
3. TOVARLAR
   «Mijozdan so'rash» (as today)
   lot card × n            — §3
┌ 4. FAYLLAR ─────────────────────┐ ┌ XARAJATLAR ──────────────────────┐
└─────────────────────────────────┘ └──────────────────────────────────┘
┌ 5. SAVOL-JAVOB (thread) ────────┐ ┌ ▸ Vazifalar ─────────────────────┐
│                                 │ ┌ ▸ Qo'shimcha maydonlar ──────────┐
│                                 │ ┌ ▸ ⚙️ Boshqa amallar  receipt-more ┐
└─────────────────────────────────┘
6. TARIX
```

### 2.1 Why not the deal card's two columns (`CardCols`)

Measured, not preferred. The content column of this app is at most ~900 px
(`max-w-6xl` less the sidebar). A 24 rem rail leaves the lots ~500 px, and
the tarkib editor draws its table (`xl:grid`, six columns) only with ~700 px
— the VED would get the phone's stacked editor on every desktop there is.
The deal card can afford a rail because its main column is a lenta. Here the
main column is the cargo, and the cargo's editor is the widest thing on the
page. So: full-width zones, pairs only where both halves are short.

### 2.2 Zone by zone

**Header.** As today, plus the FTL chip (`receipt-ftl-chip`) beside the
status for a reader who gets no «Yuk turi» row — it was a paragraph of its
own between two cards.

**1. Summary** (`receipt-summary`). One card, `sm:grid-cols-3`:

- *Mijoz* — code and name, or «❓ ANIQLANMAGAN» + the marking chip.
- *Jami* (`receipt-total`) — lots · cartons · kg · m³. Summed from the lots
  the page already holds, in integer units (`storedUnits` / `fromUnits`,
  the tarkib's own arithmetic — no float), trailing zeros trimmed. NEW on
  the card; no new read.
- *Qabul* — `receipt-received-date` (with `data-day`), `receipt-received-by`,
  `receipt-entered-by`, exactly the nodes and conditions of today.

Under the grid: the note, the void reason, and `ReceivedEditForm`'s opener.

**1a. Owner unknown.** On an unclaimed prixod `AssignClient` and
`ReturnToSender` stay OPEN and move UP, directly under the summary, in one
card: naming the owner is the one job that card has (his 3.2a — the
handover screen's «egasi aniqlanmagan yuk» row is a door to exactly this).
On a CLAIMED prixod «Mijozni o'zgartirish» is a correction and goes into
«Boshqa amallar».

**2. Bog'lanishlar** (`receipt-links`). ONE card for what the prixod is
tied to; a row per tie the reader already gets today, each with the same
condition as today:

| Row | Condition (unchanged) | Root keeps |
|---|---|---|
| Bitim | `canLinkDeal` | `DealLink` |
| Zavod reysi | `pickupInfo \|\| canLinkPickup` | `receipt-pickup` |
| Yuk turi | `loadView && (ftlOffice \|\| own seller on LTL)` | `receipt-load` |
| Hisob | `mayLinkCalc && calcOptions.length > 0` | `receipt-calc-link` |

The four components lose their own `card` (a new `bare` look, never a new
prop that changes behaviour) and sit in a `md:grid-cols-2` grid with
dividers. No row → no card. A select is at most half the page wide.

**3. Tovarlar.** A `section-title` («Tovarlar»), `ClientAskPanel`, the lot
cards (§3).

**4. Fayllar | Xarajatlar.** Two cards side by side from `md`, stacked on a
phone. Same components, same props, same `key` on the attachments panel.
The costs card is drawn under today's condition (`costMeta`, or a reader's
list when there is something to list).

**5. Savol-javob | the folds.** Left: `CargoThread` (its `#ichki` anchor
kept) or the «elsewhere» sentence. Right: `TasksPanel`,
`CustomFieldsPanel`, and **«⚙️ Boshqa amallar»** — a closed `Panel`
(`receipt-more` on its summary) holding, each under today's condition:

- «Mijozni o'zgartirish» (`canAssign && client`)
- «Boshqa skladga ko'chirish» (`canVoid`)
- the void form (`canVoid && !canAnnul`) / «Anulirovka» (`canAnnul && preview`)

The panel is drawn only when it would hold something. Slots are positional
(`{cond && <X/>}` in a fixed order), so a component that holds its own
answer — «✅ ko'chirildi», the annul's done state — keeps its place in the
tree across the revalidation, and a panel the person opened stays open (the
`open` prop does not change, React leaves the attribute alone). With no
thread the right column takes the full width.

**6. Tarix.** Last, open, unchanged.

## 3. One anatomy for a lot

```
┌ lot-<id> ─────────────────────────────────────────────────────────────┐
│ A  化妆品 (Косметика)                                    lot-name      │
│ 10 📦 · 250 kg · 1.25 m³ · 50×50×50 cm                                 │
│ 📝 note        ⚠ QR-siz since … (lot-qrless)                          │
│ [photos]                                                              │
│ ── lot-actions ───────────────────────────────────────────────────────│
│ [🖨 A] [✏️ Tahrirlash] [🏷 QR…] [🖨 YW · n] [🧱 Palet · YW · 6] [⚠️ …]  │
│ (an opened editor takes the full width under the row)                 │
│ ┌ lot-check ────────────────────────────────────────────────────────┐ │
│ │ ❓ … · [izoh ………………] [✅ To'g'ri]      (one row from sm)           │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ lot-tarkib (CompositionPanel — untouched inside)                      │
└───────────────────────────────────────────────────────────────────────┘
```

What it is (name, figures, note, photographs) → what can be done to the
LOT (one row) → its two papers (the check, the tarkib), each owning its own
button as today.

- **Figures**: trailing zeros trimmed («250 kg · 1.25 m³»); never rounded —
  the tarkib must sum to these exactly.
- **`lot-actions`**: one `flex flex-wrap gap-2` row of one button shape
  (`btn-secondary btn-sm`, a new 36 px class defined once in `globals.css`
  — the «`!min-h-9 px-2 text-sm`» idiom that 55 places spell by hand, where
  bare `px-2`/`text-sm` lose to `.btn`). Members, each under today's
  condition and with today's testid: the lot's print (`print-labels`), «✏️
  Tahrirlash», `lot-qr-toggle` / `lot-qr-remark`, `lot-qr-print`,
  `lot-make-pallet`, the write-off fold. The row is not drawn when empty.
- `LotEditForm` and `MarkLostForm` open INTO the row: the opened one takes
  `w-full` and `order-last`, so the buttons stay where they were.
- `MarkLostForm`'s summary becomes a button of the same shape; its label is
  shortened in the button and kept whole in the opened form's first line.
- **`lot-check`**: from `sm` the note and «✅ To'g'ri» share one row and the
  button is as wide as its words; on a phone they stack as today.
- **Tarkib**: `CompositionPanel` is not edited.

## 4. What does not change

- Doors: `mayReadReceipt`, every `can*` on the page, every action.
- Reads: none added, none removed.
- Anchors and deep links: `#lot-<id>`, `#ichki`, `?tarkib=`, `?from=`,
  `?qaytish=`.
- Every existing `data-testid`. New ones: `receipt-summary`,
  `receipt-total`, `receipt-owner`, `receipt-links`, `lot-actions`,
  `receipt-more`.
- DOM order of `print-labels`: the header's first, then per lot — specs
  read `.first()`.

## 5. Tests that move with it

- `m9zzq-1-qrsiz` T5 opens `receipt-more` before `void-receipt-reason`.
- Any spec asserting a lot's raw figures («250.000 kg») reads the trimmed
  spelling.
- New `m9zzzi-prixod-karta` (+ `.desktop`): the zones in order; the total
  equals the sum of the lots; an unclaimed prixod shows the owner block
  above the lots; «Boshqa amallar» is closed and holds the void form; the
  document is as wide as the viewport at 360 with a 60-character goods name;
  on a desktop a link select is no wider than half the card.
- The source-shape unit tests that read `receipts/[id]/page.tsx` (thread,
  cost-kassa, lot-check, client-confirm, lot-name fence, …) stay green
  unedited — the calls they pin do not change.

## 6. Open, asked of the judges

1. Lot actions before or after the two paper blocks?
2. Is folding the void form one tap too many for a warehouse manager?
3. Should «Bog'lanishlar» sit above the lots (as drawn) or below them on a
   phone, where the operator opens the card for the cargo?

## 7. As judged — BINDING, overrides §2-§5 where they differ

Five lenses were sent before any code. Two came back whole — the phone
(operator, seller) and the desktop (VED, office): 14 defects and 13 nits,
each measured in the running app. The regression, CSS and house-consistency
lenses and all three refuters died on the account's weekly limit, so those
three were done by the builder against the built card (§8), and no objection
below was refuted by an independent reader — each was checked against the
code before it was accepted.

The drawings above are shorthand: no label, date format or number spelling
changes except those listed here.

**Their answers to §6.** (1) Before the papers — both; the phone adds
«before the photographs». (2) Fold it — both, provided the fold's closed
line names what is inside. (3) Split: the phone measured the seller's first
lot at y≈725 of a 741 px screen with the ties above; the desktop wants one
order. Resolved below by `order` under `md` — one DOM, one class.

### 7.1 The page

- **Order.** DOM: back · header · summary · owner · ties · lots · files |
  costs · thread | folds · history. Under `md` the ties and everything after
  the lots carry `max-md:order-1`, so a phone reads summary → lots → ties →
  the rest. (Phone-7; the operator gets no tie row but a factory trip's.)
- **Pairs switch at `lg`, never `md`.** The sidebar takes 224 px from `md`,
  so at a 768 px window each half of an `md` pair was 248 px — narrower than
  a phone (measured). Summary columns, the ties' two stacks, files | costs
  and thread | folds all turn on at `lg` (content ≥ 768 px). (Desktop-1.)
- **A half with no sibling spans the row** — one wrapper whose class
  switches, children in fixed slots, `lg:items-start`. No files card for a
  reader who cannot attach when there is nothing to list; no costs card
  under today's own condition. (Desktop-2.)
- **Summary.** Inline «label: value» lines on a phone (today's 87 px card
  plus one «Jami» line — the stacked draft measured 206 px and pushed the
  first lot's controls off the first screen); from `lg` three columns with
  the label above. Cells `min-w-0`; the client line and the marking chip
  wrap anywhere — a 30-character unbroken marking makes TODAY's card 424 px
  wide at 360. The marking takes the `warn` tokens (it was raw orange).
  `ReceivedEditForm` sits in the «Qabul» column. (Phone-1, -6; Desktop-7.)
- **Ties** (`receipt-links`, no title — every cell names itself). Two
  independent stacks, never a 2×2 row grid: left «Bitim → Hisob» (the
  calculation's options ARE the linked deal's), right «Yuk turi → Zavod
  reysi». One cell anatomy: `section-title` label → one value line → one
  control row. One save idiom — the button appears when the value differs
  (the pickup's, #422). The pickup's value line, which repeated its
  select's empty option word for word, is a dash: gone entirely, the two
  selects of a VED's card («Bitim» | «Zavod reysi») started 26 px apart.
  Controls are `input-sm` / `btn-sm`. (Desktop-3.)
- **«Boshqa amallar»** (`receipt-more`). Its closed line lists what this
  reader's fold holds, each word under its own condition. The forms inside
  lose their own `card`. Slot A (thread | the «elsewhere» sentence | nothing)
  and slot B (the folds) keep their positions whichever is drawn.

### 7.2 The lot

```
A  name (ru)                         [❌ veto chip]        [🖨 A]
figures (trimmed)
📝 note · lot-qrless
lot-actions:  [✏️] [⚠️ write-off] [🏷 QR] [🏷 remark] [🖨 YW: n] [🧱 …]
              (an opened panel: its own full-width line under the row)
photos
lot-check
lot-tarkib
```

- **The lot's print stays in the head**, 112×48, where it is today: in the
  row it measured 46×36 with a neighbour 8 px away, and a missed tap there
  loads a document and opens the print dialog. (Phone-2.)
- **The row sits before the photographs**, next to the `lot-qrless`
  sentence that explains its QR buttons. (Phone-1.)
- **Nothing in the row moves when something opens.** Every opener is always
  drawn (`aria-expanded`); its panel, its «✅ saqlandi · 🖨 … · 🗑 …» line
  and every refusal are siblings with `order-last basis-full`, scrolled into
  view (`block: 'nearest'`) on open. `LotEditForm`, `QrSkipToggle` and
  `MarkLostForm` return fragments; `MarkLostForm` is a button and state, not
  a `<details>`. (Phone-3; Desktop-6.)
- **The order**: the two corrections first («✏️ Tahrirlash», «⚠️ Hisobdan
  chiqarish» — 285 of a phone's 302 px, so they share a line), then the
  stickers, then the pallets. As first built, with the write-off last, a
  manager's lot was five lines of buttons on a phone; it is four.
- **Fixed slots**, one `{cond && <X/>}` per member in one order, the two
  mapped lists each ONE slot with its own key prefix (`qr:` / `pallet:` —
  the sibling-keys fence). «Empty» is decided from the members' own
  conditions, including the write-off's offerable cartons. (Phone-4.)
- **`btn-sm`** never carries `nowrap` or `shrink-0`: the longest label is
  292 px of the 302 px a phone's card has, and wraps.
- **A client's ❌** that vetoes puts a red chip beside the lot's name
  (`lot-veto`), because the check block now comes after the row and the
  photographs. (Phone nit.)
- **`lot-check`**: one row from `sm` — the note, then whichever of «✅» and
  «E'tirozni yopish» is offered; both hints under the row. Every label
  whole. (Desktop nit.)
- **Words that change** — the only ones in a layout round:
  `lotCheck.otherAnswers` loses its direction («pastdagi ✏️» / «✏️ ниже» —
  the ✏️ is above now) in all four bundles.

### 7.3 One spelling for a measure

What the card PRINTS is trimmed — the lot's figures, «Jami», the tarkib's
read face and its stale sentence. What an EDITOR holds — the tarkib's boxes,
its remainder bar, the AI reading's sums, the lot form's inputs — keeps the
column's spelling, because it sits beside boxes that hold exactly that.
(Desktop-5: the mix was never to ship unstated.)

### 7.4 Corrected

§2.1's mechanism was wrong and its conclusion stands: in a narrow column the
tarkib editor does not stack, it OVERFLOWS — `xl:` is the viewport's 1280
px, not the container's. At a 1280 px viewport a lot card must stay ≥ ~712
px wide and must not be wrapped in anything padded.
