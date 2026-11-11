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
