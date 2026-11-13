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
  `?qaytish=`. Since the merge with «Prixod xabari» the card also
  answers `#bitim` and `?bitim=1` (the deal cell — §8, «After the merge»).
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
- **A client's ❌** that vetoes puts a red chip under the lot's name
  (`lot-veto`), because the check block now comes after the row and the
  photographs. (Phone nit. «Beside the name» as first written and built —
  see §8, «After the first push».)
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

## 8. As built

Built to §7. What the build added to it, and what it measured.

**Sizes** (the same three-lot prixod; before → after): admin 4,223 → 3,804 px at 360 and 3,754 → 2,658 at 1280;
YW operator 2,420 → 2,402; VED 2,656 → 2,472; seller 1,858 → 1,690. The operator's card is barely shorter and
that is the point of §7.1: his whole first lot — print, «✏️», the pallet door — is on the first screen, which the
first draft had pushed off it. Document width equals the viewport on every card looked at: 360, 768 and 1280, as
admin, operator, VED, seller and logist, on eleven prixods (claimed, ownerless, on a deal, off a factory trip,
QR-less, voided, with costs).

**The three lenses that did not come back** were done against the built card:

- *Regression.* Twenty-two source-shape unit fences that read this page or its components are green UNEDITED —
  the calls they pin did not change. One was red and right: `lot-composition-fence` refused `card-totals.ts`
  importing `composition-math`; the file keeps its own fifteen lines of arithmetic. `locales.test` wanted the
  plural shape in all four bundles. Three e2e specs open the fold before the void form (`m9zzq-1`, and `m9zzq-4` /
  `m9zzs`, which reach it as `#void-reason` — a testid grep had missed them).
- *CSS.* `.btn-sm` is declared after every `.btn-*` variant and wins on source order; nothing on the card carries
  a bare utility that `.btn` or `.input` would beat (`style-cascade`, `tokens` green). Only tokens for colour —
  the marking's raw orange became `warn`.
- *House.* The words are the ones the rest of the system says: «Tovarlar», «Jami», «Fayllar», «Xarajatlar»,
  «Tarix»; `Panel` for the folds; `section-title` for a zone's caption. What is deliberately NOT the house
  pattern is `CardCols` (§2.1, §7.4).

**Decided while building**

- The row's order is corrections, stickers, pallets (§7.2): seen on a phone screenshot, a manager's lot was five
  lines of buttons with the write-off last, and «✏️» + «⚠️» fit one line.
- The pickup's value line is a dash, not gone (§7.1): seen on the VED's desktop screenshot, the two selects of
  «Bitim» | «Zavod reysi» started 26 px apart without it.
- A client's name is no longer set in the code's monospace: «GS777» is, «— Alisher aka» is not.
- `ClientAskPanel` is a card like the lots it heads, its button as wide as its words from `sm`.
- History's `lots` line (`formatAuditValue`) and the list's «3 tovar» — the two places off the card that printed
  the card's own facts worse than it does.

**Tests**

- `tests/unit/receipt-card-totals.test.ts` — literals a person can add on paper; the float case.
- `tests/unit/audit-fields.test.ts` — a prixod's lots as cargo; a record that merely has `boxes` keeps its JSON.
- `tests/e2e/m9zzzi-prixod-karta.spec.ts` (phone) and `.desktop.spec.ts`, over `prixod-karta-fixture.ts` (two
  prixods by SQL, removed by a final TEST): «Jami» as literals AND against the lots' own lines; the phone's order;
  the first lot above the tab bar; the row unmoved when «✏️» and «⚠️» open (positions read in ONE frame); the fold
  closed and naming its contents; the ownerless card and a fifty-character marking at 360 and at 1280; the ties
  above the cargo and a select at most half the card; files | costs side by side at 1280 and stacked at 768.
- Eight red proofs by paired string edit (DECISIONS #1705).

**Not done, and why**

- `CompositionPanel` and the tarkib-read dialog are untouched inside, except two printed strings (§7.3) and the
  open button's class. Their editor is the most tested component on the card and a layout round is not the
  place to move it.
- The check block's status line is not lifted into the lot's head: it would mean splitting a client component
  that holds state. The ❌ chip covers the one state that must lead.
- The History tab is still an open list, last. Folding it was not asked and specs read it without opening
  anything.

**After the first push** (DECISIONS #1706). CI failed one spec the local run passed: 362 px in a 360 px screen,
in Russian, on a lot whose client had pressed «❌». §7.2 put the `lot-veto` chip «beside the lot's name» — in a
row with the letter and the print, three members that do not shrink; the runner's fonts are wider than this
container's and my looks had been in Uzbek. The chip is on a line of its own under the name. The card was then
measured in Russian at 360 with every glyph widened by up to 10 % and everything that opens opened: 360 px for
admin, operator, VED and seller, the ❌ state included.

**Asked of him** (⭐ = as built): the ties below the lots on a phone; the void inside the fold; the long QR-less
label kept whole.

**After the merge with «Prixod xabari»** (2026-11-12; DECISIONS #1738-#1743, and `docs/PRIXOD-XABARI.md` §G.H).
That round added to this card while this one rearranged it; the order above stands, and its additions were
seated in it:

- The «Bitim» cell is the landing of the seller's Telegram button: `id="bitim"`, a scroll margin, a `:target`
  OUTLINE (a ring would sit on the bare cell's letters) and `?bitim=1` for the way back from the new-deal form.
- It is the one cell that may carry more than the anatomy's three lines, in a fixed order: label → value →
  «⚠ the prixod is voided» (above the row — on a voided prixod there is no factory-trip select to align with)
  → the control row → «still on another client's deal» → «+ Yangi bitim ochish» (a second door, for whoever may
  open a deal) → the compensation hint → the refusal. «Saqlash» also stands while another client's deal does,
  so that «— uzish» can take the prixod off it.
- The left stack's two cells are keyed on the facts they draw, so a correction made in «Boshqa amallar» —
  which revalidates without a remount — starts them again from what is stored; «Hisob» offers the calculations
  of the prixod's OWN deal only.
- The «Fayllar» card goes when a reader who cannot attach removes the last file (`refreshWhenEmpty`).
- The workspace tab strip no longer scrolls the window: on a desktop it had pulled `#lot-<id>` and `#ichki`
  landings back to the top as well as `#bitim`.
