# Lot tarkibi — one lot, several goods on the papers (2026-10-01)

## His case and his answers

A lot of 100 cartons for GS777 was received. The warehouse opened ONE carton,
saw keyboards, typed «klaviatura» for the whole lot and stuck 100 labels
GS777-A. Later, while the VED and the logist prepared the customs invoice (the
truck already loaded), the client's papers showed 50 mice + 50 keyboards:
separate TNVED codes on the invoice, separate customs pricing.

His answers to the numbered questions (2026-10-01), verbatim:

> 1c
> 2c
> 3b
> 4c
> 5a
> 6 ved va logist hujjat biriktrb yozadi lekin skladchi yangi sticker yopiwtirish imkoni yoq
> 7a
> 8 a
> Bir narsani aytmohciman sen bergan lot ozgarmaydi sticker ozgarmaydi faqat tarkibi degan joy qoshiladi degan narsang yahwi deb oylayman va shu tarkibi ichiga toldirilgan bolsa packing list va invoice hujjatlarida alohida korsatilsa yahwi bolar edi.
> Misol uchun 100 ta karobka keldi skladchi klaviatura deb kirgazib qoygan va ved hodimi shu prixodni ichiga kirib tarkibini ochib 50 tasi klaviatura neca kub neca kilo har klaviatura soni nechtaligini yozadgan joyi bolsa yahwi bolar edi va tenved soraydigan joyda ham 100 ta klaviatura emas 50 ta klaviatura 50 ta mishka korsatilsa packing list va invoiceda ham ajratib korsatilsa boladimi

What the letters mean (the questions are in the research synthesis):

| Q | Answer | Meaning for the build |
|---|---|---|
| 1 | c | Sometimes each carton holds one good, sometimes a carton holds both — unknown in advance. Both shapes must be expressible. |
| 2 | c | The warehouse cannot tell them apart without opening. No carton identity, ever. |
| 3 | b | Usually found after loading, while the VED makes the invoice, truck on the road. |
| 4 | c | Almost every truck. A migration is justified. |
| 5 | a | Customs priced per TNVED in the VED calc as today; the client gets ONE total per truck (his 1c, DECISIONS #980, stands). Money is untouched. |
| 6 | — | The VED and the logist write it WITH A DOCUMENT ATTACHED; the warehouse cannot re-sticker. No physical split. |
| 7 | a | The Chinese-side papers (the agent's approved plan, export/transit papers) are built from our invoice, so the correction must be possible before the truck leaves Kashgar, and the agent file shows it too. |
| 8 | a | Both goods are always one deal, collected together. |

## What this is, in one paragraph

A lot keeps its body — cartons, letter, stickers, scans, plans, counts, stock,
crates, cabinet, pushes, bot, handover act, manifest, costs, price — and gains
an optional **tarkibi** (composition): two to twenty paper lines, each a goods
name, optional total pieces, optional cartons, kg and m³, and an optional TNVED
code, stated by the VED or the logist against a document on the prixod. Only
the papers that go to customs and to the agent read it: the customs invoice,
both packing lists and the agent file print a composed lot as one row per line
(of the lines that are on that truck); the truck's Bojxona tab asks a TNVED code
per line; «📈 Oldingi narx» counts the lines as kinds. When the VED ticks
«hujjat yuborildi» on a truck, that truck's papers are **frozen** with the
compositions they were printed from; a later correction reaches only the trucks
whose papers have not gone. Everything else goes on saying «klaviatura»,
because nobody knows which carton is which (2c).

## ⚠ Changed by the judge — read this first

The adversarial judge (five lenses, «Judge findings» at the end) proved four of
the lead's fixed decisions defective. Each is changed minimally; everything
else the lead fixed stands as written.

1. **Decision 5 — the lock becomes a FREEZE.** As decided («refuse a save once
   any cross-border truck that carries or carried the lot's cartons is
   ticked»), it (a) deadlocks against the loading count door — reproduced:
   the save held the truck FOR SHARE and waited for the lot while
   `countLoadLot` held the lot and waited to flip the truck to `loading`
   (finding DM1); (b) traps every split lot — truck A left Kashgar with 40
   cartons and was ticked, the mix is found while truck B (60 cartons) is
   formed, and the only way to compose for B is to un-tick A, which rewrites
   papers customs already holds (DM4, Access-2; 801 of 4,022 crossing lots on
   the shaped copy rode ≥ 2 trucks); (c) never tied what the agent RECEIVED to
   a revision — it ordered two commits, so a save between the download and the
   tick went unnoticed (DM3). **Now**: a save is never refused because papers
   went. Ticking «hujjat yuborildi» copies, in ONE statement, the composition
   of every lot on the truck into `batch_sent_compositions`; while ticked, that
   truck's papers and its Bojxona tab print the frozen copy; un-ticking (still
   audited, still the way back) drops it. The tick itself refuses
   (`paper_moved`) when a composition on the truck changed after the page the
   VED downloaded from was drawn. No truck row is locked by any composition
   write, so the deadlock cannot form. *Fallback if the lead keeps the lock*:
   lock the lot `FOR NO KEY UPDATE NOWAIT` in raw SQL (the warehouse press
   always wins, `busy`), skip the truck lock when the candidate list is empty
   (`IN ()` is a 42601), keep the tick stamp of §5, and state the split-lot
   trap to the owner as an open risk.
2. **Decision 6 — the per-truck arithmetic.** «Line share × (cartons on this
   truck ÷ box_count), largest remainder per truck» made a split lot's papers
   NOT add up to the composition (100 cartons, 50/50, trucks 33/33/34 → 51
   keyboards and 49 mice declared; pieces 5 over two half-trucks → 6 printers)
   and, in «alohida», printed a line with 0 cartons and 4 kg on a 1-carton truck
   (Papers-1, Papers-2). **Now**: cartons and pieces are allocated CUMULATIVELY
   over the lot's cross-border trucks in departure order (a house-monotone
   Sainte-Laguë prefix for cartons), so they sum to the typed composition; in
   «alohida» kg/m³/pieces follow the line's cartons on THIS truck and a line
   with no carton on the truck is left off that truck's papers; places are
   split by the lines' cartons on the truck (a pallet no longer goes whole to
   the dominant line) and marked «taxminiy» when a pallet is present
   (Papers-4); a row whose pieces come out 0 prints in kg (Papers-5).
3. **Decision 3 — the document, tightened.** Every prixod received with a
   general photo already carries the warehouse's CARTON photos as `'receipt'`
   attachments, so «any file on the prixod» let a keyboard-carton photo stand
   in for the client's packing list (Access-1). **Now** the cited file must be
   a non-photo file, or a file uploaded after the prixod was confirmed; and
   `/api/files/upload` asks the receipt read door for a `'receipt'` target that
   exists (it asked nothing).
4. **Decision 8 — the TNVED tab.** A line with no carton on the truck has no
   row there (it is not on that truck's papers); product rows keep the lot's
   own `box_count` (a test pins it) and line rows say «shu mashinada»
   explicitly; on a ticked truck the line rows are the frozen copy, read-only.

Decision 2's exact sums stand; the editor gains a person-pressed «Sklad
o'lchoviga moslashtirish» for the common case that the client's paper and the
warehouse scale disagree (#768 holds — a person presses it). Decision 11 now
covers three objects (a sequence and three tables), all denied to
`gsr_ai_reader`.

## Rules that do not move (the lead's decisions, as amended above)

1. **The lot keeps its body.** No reader outside the list in §9 learns the
   composition. Pinned by a derived source fence (§11.1).
2. **A composition is 2-20 lines.** name (required, what the invoice prints),
   total pieces «dona» (optional positive integer), cartons (optional), kg and
   m³ (required), TNVED (optional, 4-10 digits). Cartons are **all-or-none**:
   all given → «alohida karobkalar» and Σ cartons = the lot's `box_count`; none
   given → «aralash karobkalar». Σ kg and Σ m³ equal the lot's stored totals
   **exactly at storage scale** (kg numeric(12,3), m³ numeric(12,4)). The
   system never divides on save (#768); the UI offers person-pressed prefills
   and shows the live remainder. Clearing = deleting the composition.
3. **A document is mandatory** (his answer 6): one attachment of type
   `'receipt'` on THAT prixod, uploaded through the existing
   `/api/files/upload` path or chosen from the prixod's files, which is a
   **paper document** — `kind = 'file'`, or uploaded after the prixod's
   confirmation (CHANGED, see above). No new attachment type, so no new
   `decide()` branch (#937).
4. **Door**: writers = `ved.docs ∨ plans.manage` (the Bojxona tab's audience)
   AND `mayReadReceipt`. `receipts.edit` is NOT widened. The seeded
   `ved_manager` and `logist` are NOT warehouse-scoped
   (`WAREHOUSE_SCOPED_ROLES` = warehouse_manager, warehouse_operator —
   `rbac/catalog.ts:102`; `scripts/seed-demo.ts:78-79`), so `mayReadReceipt`
   already answers yes for them and **no read door is widened**; a VED role the
   owner scopes on /admin/roles gets exactly the receipt card's own rule.
5. **Freeze (7a, CHANGED)**: the papers of a truck ticked «hujjat yuborildi»
   print the compositions frozen at the tick; a composition saved later reaches
   only trucks not ticked. The tick refuses when the compositions moved after
   the page was drawn. Un-ticking (audited, `setSentToAgentAction`) re-opens
   that truck's papers.
6. **Papers**: one row per line on the truck, cumulative per-lot arithmetic in
   §2 (CHANGED).
7. **Stale**: a lot whose totals moved after the save shows ⚠ and the papers
   scale the line ratios onto the current totals, flagged «taxminiy».
8. **Money untouched**: one price per client per truck (5a). No per-line
   charge, no per-line cost scope, no tannarx change.

---

## 1. Data — migration `0122_lot_composition`

**Before writing it**: `git fetch origin main`, re-read the tail of
`src/modules/platform/db/migrations/meta/_journal.json`. At this spec's
revision (re-read after a fetch) the tail is idx 121, `when` 1785190000100, tag
`0121_batch_rename` (both on the branch and on `origin/main`), and 122 `.sql`
files exist. So: file `0122_lot_composition.sql`, journal entry
`{ idx: 122, version: '7', when: 1785190000101, tag: '0122_lot_composition', breakpoints: true }`,
**ledger must reach 123**. If the other session minted 0122 first, take the
next free number AND the next `when` (#1040; `tests/unit/migration-journal.test.ts`
fences order and holes).

One sequence and three tables, additive, and ONE backfill: a frozen row per
lot for every truck already ticked «hujjat yuborildi» when 0122 deploys
(added by the review of the build — see «Review of the build» at the end).

```sql
-- Lot tarkibi (the owner's 1c/2c/3b/4c/5a/6/7a/8a, 2026-10-01): a lot may
-- carry a paper composition — the goods its cartons hold, as the client's
-- packing list states them. The lot, its cartons, letter and stickers do not
-- change (nobody knows which carton is which, 2c); only the customs papers
-- and the agent file read these rows. One header per lot (the document, the
-- count it was stated against, the revision token), lines beneath it, and a
-- frozen copy per truck whose papers went to the agent (7a).
-- Not granted to gsr_ai_reader — 0080's allowlist denies a table no
-- migration names (0088's, 0106's precedent).

-- The revision TOKEN. A sequence and not a per-row counter: a clear deletes
-- the header, and a counter that restarts at 1 lets an editor still holding
-- the OLD composition's «1» overwrite a colleague's NEW «1» (ABA). A value
-- drawn from a sequence is never drawn twice.
CREATE SEQUENCE "lot_composition_rev_seq";
--> statement-breakpoint
CREATE TABLE "lot_compositions" (
  "lot_id" uuid PRIMARY KEY REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "attachment_id" uuid NOT NULL REFERENCES "attachments"("id"),
  "seen_box_count" integer NOT NULL,
  "rev" bigint NOT NULL DEFAULT nextval('lot_composition_rev_seq'),
  "saved_by" uuid NOT NULL REFERENCES "users"("id"),
  "saved_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lot_compositions_seen_box_count_check" CHECK ("seen_box_count" > 0)
);
--> statement-breakpoint
ALTER SEQUENCE "lot_composition_rev_seq" OWNED BY "lot_compositions"."rev";
--> statement-breakpoint
-- deleteAttachment's FK check (and its `in_use` answer) reads by this column.
CREATE INDEX "lot_compositions_attachment_idx" ON "lot_compositions" ("attachment_id");
--> statement-breakpoint
CREATE TABLE "lot_composition_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lot_id" uuid NOT NULL REFERENCES "lot_compositions"("lot_id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "name" text NOT NULL,
  "pieces" integer,
  "cartons" integer,
  "weight_kg" numeric(12,3) NOT NULL,
  "volume_m3" numeric(12,4) NOT NULL,
  "tnved_code" text,
  CONSTRAINT "lot_composition_lines_seq_check" CHECK ("seq" BETWEEN 1 AND 20),
  CONSTRAINT "lot_composition_lines_name_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 200),
  CONSTRAINT "lot_composition_lines_pieces_check" CHECK ("pieces" IS NULL OR "pieces" > 0),
  CONSTRAINT "lot_composition_lines_cartons_check" CHECK ("cartons" IS NULL OR "cartons" > 0),
  CONSTRAINT "lot_composition_lines_kg_check" CHECK ("weight_kg" > 0 AND "weight_kg" <> 'NaN'::numeric),
  CONSTRAINT "lot_composition_lines_m3_check" CHECK ("volume_m3" > 0 AND "volume_m3" <> 'NaN'::numeric),
  CONSTRAINT "lot_composition_lines_tnved_check" CHECK ("tnved_code" IS NULL OR "tnved_code" ~ '^[0-9]{4,10}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lot_composition_lines_lot_seq_unique" ON "lot_composition_lines" ("lot_id", "seq");
--> statement-breakpoint
-- The papers a truck SENT (7a): written by the «hujjat yuborildi» tick for
-- every lot on the truck — `lines` NULL = the lot had no composition then, so
-- a composition stated later never rewrites a sent truck's invoice — and
-- deleted by the un-tick. `lines` is a copy, not a reference: the live lines
-- are replaced on every save.
CREATE TABLE "batch_sent_compositions" (
  "batch_id" uuid NOT NULL REFERENCES "batches"("id") ON DELETE CASCADE,
  "lot_id" uuid NOT NULL REFERENCES "receipt_lots"("id") ON DELETE CASCADE,
  "rev" bigint,
  "seen_box_count" integer,
  "lines" jsonb,
  "segments" jsonb,
  "frozen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "batch_sent_compositions_pk" PRIMARY KEY ("batch_id", "lot_id"),
  CONSTRAINT "batch_sent_compositions_shape_check" CHECK (
    ("rev" IS NULL) = ("lines" IS NULL) AND ("rev" IS NULL) = ("seen_box_count" IS NULL)
    AND ("lines" IS NULL OR jsonb_typeof("lines") = 'array')
  ),
  CONSTRAINT "batch_sent_compositions_segments_check" CHECK (
    "segments" IS NULL OR jsonb_typeof("segments") = 'array'
  )
);
--> statement-breakpoint
CREATE INDEX "batch_sent_compositions_lot_idx" ON "batch_sent_compositions" ("lot_id");
--> statement-breakpoint
-- The trucks already ticked when this deploys: frozen as they were sent,
-- every lot ONE row (`lines` NULL), no positions. batchMemberFilter's halves.
INSERT INTO "batch_sent_compositions" ("batch_id", "lot_id")
SELECT DISTINCT t.id, b.lot_id FROM "batches" t JOIN "boxes" b ON b.current_batch_id = t.id
 WHERE t.sent_to_agent_at IS NOT NULL AND t.status <> 'cancelled'
UNION
SELECT DISTINCT t.id, b.lot_id FROM "batches" t
  JOIN "box_movements" m ON m.ref_type = 'batch' AND m.cause = 'batch_departed' AND m.ref_id = t.id
  JOIN "boxes" b ON b.id = m.box_id
 WHERE t.sent_to_agent_at IS NOT NULL AND t.status <> 'cancelled'
ON CONFLICT DO NOTHING;
```

- **`segments`** = the POSITIONS the truck's cartons of the lot held in the
  lot's order at the tick (`[[start, end), …]`, §2). A split lot's lines are
  allocated cumulatively over its trucks, so a copy of the lines alone did
  not freeze the paper: another truck of the lot departing first moved it.
  NULL on a truck that does not cross the border and on the backfilled rows.
- **The backfill.** A truck ticked before 0122 had no copy, so it read the
  LIVE composition: the first composition saved after the deploy rewrote a
  sent invoice while the receipt card said it stays as sent — and the tick is
  routinely pressed on the road (the VED's queue is in_transit/arrived trucks
  with no tick), which is his 3b's moment exactly. 0122 had not deployed, so
  the backfill went into 0122 itself and the ledger still reaches 123.

Why each choice:

- **Header PK = `lot_id`**: one composition per lot; the lines hang off it.
  `ON DELETE CASCADE` from `receipt_lots` because the app never deletes a lot
  and the test fixtures do (`tests/fixtures/stamped-cargo.ts:86`,
  `deal-cargo.ts:75` and four integration files) — a RESTRICT would turn every
  one of them red the day a composed lot exists in a shared database. The same
  for `batch_sent_compositions` (both FKs): fixtures delete trucks too.
- **`attachment_id` is NO ACTION** (no `ON DELETE`): `deleteAttachment`
  (`platform/files/service.ts:232-252`) already maps a 23503 to
  `AttachmentDeleteError('in_use')`, so the client's packing list cannot be
  deleted while a composition cites it. No SET NULL anywhere, so #809 does not
  arise. The frozen copy carries no document reference at all (the papers
  print none), so once the live composition moves to another document, the
  old one may be deleted.
- **No `mode` column.** The mode is DERIVED from the lines
  (`compositionMode`, §2): one fact, one home. The all-or-none rule spans rows
  and a CHECK cannot see across rows, so the service enforces it; a reader
  meeting the impossible half-state prints it as «aralash» flagged estimate,
  never crashes a customs paper.
- **No stored line kg/m³ total on the header.** Σ lines = the lot's totals at
  save time, so the sums are the «seen» kg/m³; only the count needs storing
  (`seen_box_count`), because an aralash composition has no cartons to sum.
- **`rev`** is a TOKEN, not a counter (finding DM2/R3/UX10): every write (save,
  clear, a line code from the Bojxona tab) sets `rev = nextval(…)`, every write
  compare-and-sets it (`composition_changed`). `bigint` read in drizzle's
  `mode: 'number'` (a sequence will not pass 2^53 here). The editor is keyed on
  it, so a new composition always remounts a stale editor.
- **No DB unique on the line name**: duplicate names are refused by the
  service on `productKey(name)` (whitespace/case-normalised), which a plain
  `lower()` index would not match.
- **`'NaN'` excluded** on both measures (#777).
- **`batch_sent_compositions` rows for uncomposed lots too** (`lines` NULL):
  without them a lot composed after the tick would print as lines on the sent
  truck. A lot that boards AFTER the tick has no row and reads live (stated).

Drizzle (`src/modules/platform/db/schema/wms.ts`, right after `receiptLots`;
`attachments`, `users` and `batches` are already imported there):

```ts
export const lotCompositions = pgTable(
  'lot_compositions',
  {
    lotId: uuid('lot_id').primaryKey().references(() => receiptLots.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id').notNull().references(() => attachments.id),
    seenBoxCount: integer('seen_box_count').notNull(),
    rev: bigint('rev', { mode: 'number' }).notNull().default(sql`nextval('lot_composition_rev_seq')`),
    savedBy: uuid('saved_by').notNull().references(() => users.id),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('lot_compositions_seen_box_count_check', sql`${t.seenBoxCount} > 0`),
    index('lot_compositions_attachment_idx').on(t.attachmentId),
  ],
);

export const lotCompositionLines = pgTable('lot_composition_lines', { /* as the SQL */ },
  (t) => [ /* the seven CHECKs by the SQL's names + the unique index */ ]);

export const batchSentCompositions = pgTable('batch_sent_compositions', {
  batchId: uuid('batch_id').notNull().references(() => batches.id, { onDelete: 'cascade' }),
  lotId: uuid('lot_id').notNull().references(() => receiptLots.id, { onDelete: 'cascade' }),
  rev: bigint('rev', { mode: 'number' }),
  seenBoxCount: integer('seen_box_count'),
  lines: jsonb('lines').$type<FrozenLine[] | null>(),
  frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [ primaryKey({ name: 'batch_sent_compositions_pk', columns: [t.batchId, t.lotId] }),
            check('batch_sent_compositions_shape_check', sql`…as the SQL…`),
            index('batch_sent_compositions_lot_idx').on(t.lotId) ]);
```

(Drizzle's `check()` names must equal the SQL's `CONSTRAINT` names.)
`FrozenLine` = `StoredLine` of §2 (`seq, name, pieces, cartons, kg, m3,
tnvedCode`), exported from `composition-math.ts`.

### The owner's AI assistant: DENIED, deliberately

None of the three tables nor the sequence is granted to `gsr_ai_reader`, and
none joins `ANALYST_TABLES` (`platform/ai/schema-card.ts`). Reasons:

1. **Precedent and the fence.** No migration since 0080 has granted a table
   (0088 and 0106 deny in a comment); `tests/unit/ai-schema-card.test.ts`
   reads 0080's GRANT alone and demands it equal the card. Granting means
   teaching that security fence a second GRANT source — a change to a
   credentials fence inside a paperwork round.
2. **What the assistant answers about.** A composition is a statement for the
   customs papers, not the cargo's identity; the assistant's cargo answers keep
   the lot name like every other non-paper reader (rule 1).

Say in the migration comment: «Not granted to gsr_ai_reader». Stated to him
as a limit: «AI yordamchi tarkibni ko'rmaydi — kerak bo'lsa alohida qo'shamiz».

---

## 2. The pure arithmetic — `src/modules/wms/receipts/composition-math.ts`

Zero imports from `db`, `next` or `react` (the receipt panel imports it in the
browser for the live remainder). Every money-free number on the papers comes
from here.

```ts
export const KG_SCALE = 3;
export const M3_SCALE = 4;

/** A typed MEASURE → integer units at `scale`, by string arithmetic (never
 *  `x * 1000` in floating point). Spaces, NBSP and apostrophes group digits;
 *  a single «,» or «.» is the DECIMAL mark — «2,125» m³ is 2.1250, «450,500»
 *  kg is 450.500 (finding UX6: ru is the default locale and m³ is written to
 *  three or four decimals; `parseTypedMoney`'s «,ddd = thousands» rule turned
 *  «2,125» into 2125 m³). Both marks present → the LAST is the decimal and the
 *  other must group threes («1,200.5», «1.200,5»). null for anything else, for
 *  more decimals than the column holds, for ≤ 0. Deliberately NOT
 *  `crm/field-map.ts parseMeasure` (lenient: «5-10» → 5 is right for a form
 *  answer and wrong for a declared figure) nor `parseTypedMoney` (money). */
export function toUnits(raw: string, scale: number): number | null;
export function fromUnits(units: number, scale: number): string; // '600.000'
/** A positive whole number («1 000» → 1000), else null — pieces and cartons. */
export function toCount(raw: string): number | null;

/** Hamilton / largest remainder in INTEGERS over BigInt weights:
 *  floor(total·wᵢ/W), the rest one unit at a time to the largest fractional
 *  parts, a tie to the LOWER index. BigInt because at the columns' limits
 *  total·w passes 2^53 and because the «alohida» kg weights are rationals
 *  brought to a common denominator (below). Σ out = total exactly. */
export function largestRemainder(total: number, weights: readonly bigint[]): number[];

/** The first `x` seats of the Sainte-Laguë (Webster) sequence over the
 *  integer weights `w`: one seat at a time to the largest wᵢ/(2sᵢ+1), compared
 *  by cross-multiplication in BigInt, a tie to the lower index. HOUSE-MONOTONE
 *  (every sᵢ is non-decreasing in x — largest remainder is not: the Alabama
 *  paradox), and at x = Σw it returns w exactly (an under-seated line always
 *  outranks an over-seated one: wᵢ/(2wᵢ−1) > ½ > wⱼ/(2wⱼ+1)). */
export function seatsPrefix(x: number, w: readonly number[]): number[];

/** round-half-up of num/den in BigInt. */
export function roundHalfUp(num: bigint, den: bigint): number;

export type CompositionMode = 'separate' | 'mixed' | 'invalid';
export function compositionMode(lines: readonly { cartons: number | null }[]): CompositionMode;

export interface DraftLine { name: string; pieces: string; cartons: string; kg: string; m3: string; tnved: string }
export interface ParsedLine {
  seq: number; name: string; pieces: number | null; cartons: number | null;
  kgUnits: number; m3Units: number; tnvedCode: string | null;
}
export interface LotTotals { boxCount: number; kg: string; m3: string } // as stored
/** A saved line as the readers get it — also the frozen copy's element. */
export interface StoredLine {
  seq: number; name: string; pieces: number | null; cartons: number | null;
  kg: string; m3: string; tnvedCode: string | null;
}
export type FrozenLine = StoredLine;

export type MeasureField = 'pieces' | 'cartons' | 'kg' | 'm3';
export type DraftRefusal =
  | { code: 'lines_count' }
  | { code: 'bad_line' | 'bad_tnved' | 'duplicate_name'; seq: number }
  | { code: 'bad_number'; seq: number; field: MeasureField }
  | { code: 'cartons_partial' }
  | { code: 'cartons_sum'; sum: number; lot: number }
  | { code: 'kg_sum'; sum: string; lot: string }
  | { code: 'm3_sum'; sum: string; lot: string };

/** Shape + numbers, in the order the person reads the lines: the first bad
 *  row is named by its seq (and, for a number, its FIELD — finding UX-nit).
 *  Names trimmed and measured in CODE POINTS (`[...name].length`, what the
 *  CHECK's char_length counts — «📦» is 2 UTF-16 units and 1 character);
 *  empty name with every other field empty = a blank row the UI dropped. */
export function parseDraft(lines: readonly DraftLine[]):
  | { ok: true; lines: ParsedLine[] }
  | { ok: false; refusal: DraftRefusal };

/** The sums against the lot (cartons only when mode = separate). */
export function checkSums(lines: readonly ParsedLine[], lot: LotTotals): DraftRefusal | null;

/** The live counter, PER MEASURE: what is left (or over) for kg, m³ and
 *  cartons separately. An unreadable cell counts as 0 and sets `incomplete`. */
export function remainderOf(lines: readonly DraftLine[], lot: LotTotals):
  { kgUnits: number; m3Units: number; cartons: number | null; incomplete: boolean };

/** «Karobka soniga qarab taqsimlash»: kg and m³ by largest remainder over
 *  the typed cartons — only when every row has cartons and Σ = box_count. */
export function prefillByCartons(lines: readonly DraftLine[], lot: LotTotals):
  { kg: string; m3: string }[] | null;

/** «Sklad o'lchoviga moslashtirish»: the typed kg (and, separately, m³)
 *  scaled onto the lot's stored totals by largest remainder over the typed
 *  values — the client's paper says 450 + 450 kg, the warehouse scale said
 *  1000.000. Null when a row is unreadable or the sum already matches. A
 *  PERSON presses it; save re-checks. */
export function scaleToLot(lines: readonly DraftLine[], lot: LotTotals, field: 'kg' | 'm3'):
  string[] | null;

/** «=» beside ONE field of one row: the lot total minus the OTHER rows of
 *  that field, when positive. Per field, so balancing kg never overwrites an
 *  m³ copied from the document (finding UX-nit). */
export function fillRest(lines: readonly DraftLine[], index: number, field: 'kg' | 'm3', lot: LotTotals):
  string | null;

/** The lot moved after the save: box_count ≠ seen, or Σ lines ≠ the lot's
 *  current kg or m³ (compared in units). */
export function isStale(
  comp: { seenBoxCount: number; lines: readonly { kg: string; m3: string }[] },
  lot: LotTotals,
): boolean;

/** A run of the lot's carton POSITIONS, [start, end) — position 0 is the
 *  lot's first carton in the order of its crossing trucks. */
export type Segment = readonly [number, number];
export interface LotTruck {
  batchId: string; departedAt: string | null; createdAt: string; crosses: boolean; n: number;
  /** The positions frozen with the truck's «hujjat yuborildi» copy; null when none. */
  frozenSegments?: readonly Segment[] | null;
}

/** Every crossing truck's positions (the cumulative offset, generalised so a
 *  SENT truck keeps its place): a ticked truck holds its frozen positions;
 *  every other crossing truck takes the next FREE positions in the order —
 *  departed first by `departedAt`, then not departed by `createdAt`, then id.
 *  With nothing ticked this is exactly the old prefix. `plan` = the agent
 *  file of a plan with no truck, after every truck. */
export function lotSegments(trucks: readonly LotTruck[], plan?: { n: number }): Map<string, Segment[]>;
/** This truck's runs; [] for a truck that does not cross (or is not named) — «from 0». */
export function truckSegments(trucks: readonly LotTruck[], batchId: string): Segment[];
export function planSegments(trucks: readonly LotTruck[], n: number, crosses: boolean): Segment[];
/** A document's runs: the truck's trimmed (or extended past their end) to
 *  the document's own n; past the lot's end → the old clamp, flagged. */
export function fitSegments(segs: readonly Segment[], n: number, B: number, start?: number):
  { segs: Segment[]; clamped: boolean };

/** What ONE document prints for a composed lot. */
export interface PaperPortion {
  /** `truckSegments` for this lot and this document's truck (absent: one run from `before`). */
  segments?: readonly Segment[];
  /** The start of a single run — the unit tests' shorthand. */
  before?: number;
  /** The lot's cartons in THIS document's population (n). */
  cartons: number;
  /** The single figure today's builder prints for this lot — the builder's
   *  OWN rounded value (invoice `Math.round(x·10)/10`, packing-photos
   *  `Number(x.toFixed(1))`), passed on, never recomputed here. */
  kg: number;
  m3?: number;
  /** Invoice only: `invoicePlaceParts` for this lot; `onPallets` = its
   *  cartons on ANY pallet of the truck, its own or another lot's. */
  places?: { loose: number; pallets: number; onPallets?: number };
}
export interface PaperLine {
  seq: number; name: string; tnvedCode: string | null;
  pieces: number | null;                // null when the line states none
  cartons: number | null;               // null in aralash
  kg: number;                           // at kgDecimals
  m3: number | null;                    // null when the portion has no m3
  places: number | 'part' | null;       // null when the portion has no places
}
export interface PaperView { lines: PaperLine[]; estimate: boolean; reasons: ('share' | 'stale' | 'invalid' | 'pallet' | 'clamped')[] }
export function paperLines(
  comp: { seenBoxCount: number; lines: readonly StoredLine[] },
  lot: LotTotals,
  portion: PaperPortion,
  opts?: { kgDecimals?: number; m3Decimals?: number }, // default 1 and 3
): PaperView;
```

### `paperLines` — the rule, once

Let B = `lot.boxCount`, S = `comp.seenBoxCount`, n = `portion.cartons`,
mode = `compositionMode(lines)` (invalid prints as mixed). The document's
POSITIONS are `fitSegments(portion.segments, n, B)`: the truck's runs from
`lotSegments`, trimmed (or extended past their end) to the document's n — in
the common case ONE run [b, b+n), b the lot's cartons on its earlier crossing
trucks. If they run past B (a carton counted on two crossing trucks — a
return, a re-send), the document takes [max(0, B − n), …) and the view is
flagged `clamped`. Every rule below that names [b, b+n) sums over the runs.

- **Cartons on this truck** (separate): cᵢ = `seatsPrefix(b+n, cartons)ᵢ −
  seatsPrefix(b, cartons)ᵢ`. Σcᵢ = n. Over all of a lot's crossing trucks
  they sum to the typed cartons (house monotone), so «100 cartons, 50/50,
  trucks 33/33/34» declares 17+16+17 keyboards and 16+17+17 mice — 50/50, not
  the 51/49 a per-truck largest remainder declares.
- **Which lines print**: separate → only lines with cᵢ ≥ 1 (a line none of
  whose cartons are on this truck is not on this truck's paper — finding
  Papers-1; at least one line prints, because Σcᵢ = n ≥ 1); mixed → every line.
- **kg**: target T = round(`portion.kg`·10^d) units. Weights: separate
  wᵢ = cᵢ·kgUnitsᵢ/cartonsᵢ — exact rationals brought to the common BigInt
  denominator Π cartonsⱼ (≤ 20 factors; BigInt is unbounded); mixed
  wᵢ = kgUnitsᵢ. kgᵢ = `largestRemainder(T, w)`ᵢ / 10^d. Σ = `portion.kg`
  exactly, so the invoice's `SUM(G)` / `SUM(H)` is unchanged. In the exact case
  each line is **within 0.1 kg of its typed figure** — not «the typed figure
  rounded»: a tie in the remainder goes to the lower seq (U12 pins it).
- **m3** (when the portion has one) = the same over m3Unitsᵢ.
- **pieces** (when stated), cumulative so a line's pieces over all its trucks
  sum to the typed pieces: separate Pᵢ(x) = `roundHalfUp(piecesᵢ·x, cartonsᵢ)`
  and the truck prints Pᵢ(seatsᵢ(b+n)) − Pᵢ(seatsᵢ(b)); mixed
  Pᵢ(x) = `roundHalfUp(piecesᵢ·x, S)` and the truck prints Pᵢ(b+n) − Pᵢ(b).
- **places** (invoice only), P = loose + pallets (= today's `invoicePlaces`
  value for the lot):
  - separate: `largestRemainder(P, cᵢ)` over the printed lines (each ≤ cᵢ,
    because P ≤ n); a printed line whose places come out 0 → `'part'`. When
    any of the lot's cartons stands on a pallet (`onPallets` > 0 — its own
    pallet or ANOTHER lot's; the review: keyed on owned pallets, a lot riding
    a neighbour's pallet read as exact) and more than one line prints, the
    view is flagged `pallet`:
    which line's cartons sit on the pallet is unknown (finding Papers-4 — the
    old «all pallet places to the dominant line» was stronger than today's
    per-pallet rule it claimed to mirror).
  - mixed: all P places on the first printed line; every other line `'part'`.
- **estimate** = reasons ≠ ∅, reasons ⊆ { `share` (n ≠ B), `stale`
  (`isStale`), `invalid`, `pallet`, `clamped` }. «n = box_count» and not «every
  live carton» on purpose (D1): every builder's single figure today is n × (lot
  total ÷ box_count) (`ved-xlsx.ts:226-230`), and `box_count` counts a carton
  voided on the box card or marked lost (`grow-lot.ts:85-93` states the
  divisor).

**When a truck's paper is final.** A truck whose papers were SENT (ticked
«hujjat yuborildi», 7a) holds the positions it held at the tick — they are
frozen with its copy — and every other crossing truck takes the free
positions around it, so nothing another truck does (departing first, being
re-counted or cancelled) moves it. A DEPARTED truck's predecessors in the
order are trucks that departed before it, and its own n is its departure
movements — so its paper does not move because of another truck either (the
unit test walks every order of ticks and departures and asserts both, and
that the positions tile the lot). Before either, a truck's paper follows its
own cartons AND the lot's other trucks — which before this round no paper
did: the cumulative rule is what makes a forming truck's paper depend on its
siblings (the review corrected this sentence, which said «it did so before
this round too»). A truck that does not cross the border prints from
position 0 (its papers do not go to customs; stated).

### Worked example (the unit tests' fixtures)

Lot GS777-A: 100 cartons, 1000.000 kg, 2.5000 m³. Lines: «Клавиатура» 50 kar,
600.000 kg, 1.5000 m³, 500 dona; «Мышь» 50 kar, 400.000 kg, 1.0000 m³,
1000 dona. (Codes illustrative.) Every figure below was computed with the
rule above (`node` simulation kept with the judge's notes).

| Case | Portion | Клавиатура | Мышь | estimate |
|---|---|---|---|---|
| U1 whole lot, loose | b=0 n=100, kg 1000.0, places {100,0} | 50 kar · 600.0 kg · 1.500 · 500 dona · 50 pl. | 50 · 400.0 · 1.000 · 1000 · 50 | — |
| U2 first truck of 40 | b=0 n=40, kg 400.0, places {40,0} | 20 · 240.0 · 200 · 20 | 20 · 160.0 · 400 · 20 | share |
| U3 second truck of 60 | b=40 n=60, kg 600.0, places {60,0} | 30 · 360.0 · 300 · 30 | 30 · 240.0 · 600 · 30 | share |
| U4 trucks 33/33/34 | b=0/33/66 | 17, 16, 17 kar · 170, 160, 170 dona | 16, 17, 17 · 320, 340, 340 | share |
| U5 whole lot, 80 loose + 1 pallet of 20 | places {80,1} | 41 pl. | 40 pl. | pallet |
| U6 whole lot on 4 pallets of 25 | places {0,4} | 2 pl. | 2 pl. (old rule: 4 / part) | pallet |
| U7 aralash (no cartons), whole lot | places {100,0} | — kar · 600.0 · 500 · 100 pl. | — · 400.0 · 1000 · `'part'` | — |
| U8 stale: grew to 102 / 1020.000 kg, all aboard | n=102, kg 1020.0 | 51 · 612.0 · 510 | 51 · 408.0 · 1020 | stale |
| U9 one-carton lot, aralash | n=1, places {1,0} | 1 pl. | `'part'` | — |
| U10 first truck of 1, separate | b=0 n=1, kg 10.0, places {1,0} | 1 kar · 10.0 kg · 10 dona · 1 pl. | **not printed** (0 cartons) | share |
| U11 aralash, «Клавиатура» 999.000 kg / 2000 dona + «Принтер» 1.000 kg / 1 dona, truck of 40 then 60 | kg 400.0 then 600.0 | 399.6 · 800; then 599.4 · 1200 | 0.4 kg · **0 dona → prints «кг 0.4»**; then 0.6 · 1 шт | share |
| U12 aralash, 333.350 / 333.350 / 333.300 kg, whole lot | kg 1000.0 | 333.4 / 333.3 / 333.3 (within 0.1, Σ 1000.0) | | — |

(U8's row is «stale» alone: n = B = 102.)

### Unit tests — `tests/unit/composition-math.test.ts`

- `largestRemainder`: Σ = total for 1000 random (total, weights) pairs; the
  three-way case 70.0 over 333.333/333.333/333.334 → 23.3/23.3/23.4; a tie
  goes to the lower index; weights at the column limit (999 999 999.999 kg ×
  target 9 999 999.9) stay exact (a float version fails this: red proof R-U1).
- `seatsPrefix`: for 2 000 random weight vectors (2-6 lines, 1-60 cartons):
  Σ = x for every x; every sᵢ non-decreasing from x to x+1; x = Σw returns w.
  U4's 33/33/34 sums to 50/50 (per-truck largest remainder gives 51/49: red
  proof R13).
- `toUnits`: «12,5»→12500 (kg), «1 200»→1200000, «2,125» m³ → 21250,
  «450,500» kg → 450500, «1,200.5» → 1200500, «0.0001» at scale 3 → null,
  «-1»/«abc»/«NaN»/«1e3»/«1,2,3» → null. The float trap: «0.1» + «0.2» summed
  in units equals «0.3». `toCount`: «1 000»→1000, «1.5»/«0» → null.
- `compositionMode`: all null → mixed, all set → separate, mixed → invalid.
- `parseDraft` + `checkSums`: one test per refusal code, each naming the seq
  (and `bad_number`'s field); kg off by 0.001 refused; m³ off by 0.0001
  refused; equal by «12,5» vs «12.500» accepted; 1 line and 21 lines refused;
  duplicate «Мышь»/« мышь » refused; TNVED «8471 60 7000» accepted, «847»
  refused; a name «📦x» (2 code points) accepted, «📦» alone refused.
- `prefillByCartons`, `scaleToLot` (450 + 450 onto 1000.000 → 500.000 /
  500.000; 2.1 + 2.1 onto 2.5000 → 1.2500 / 1.2500), `fillRest` per field,
  `remainderOf` (half-typed row → incomplete; kg over while m³ exact reads as
  two different states), `isStale` (each of the three triggers alone),
  `truckSegments` (order: departed by time, then undeparted by creation;
  internal truck → from 0; this truck's own n never counted), `fitSegments`,
  and the freeze: a sent truck keeps its runs when a sibling forms, departs or
  is dialled; every order of ticks and departures over 3/2/2 keeps sent and
  departed trucks still and tiles the lot.
- `paperLines`: U1-U12 above; «invalid» prints as mixed with estimate; a
  sweep over B = 7, lines 3/2/2, every split of 7 cartons into two and three
  trucks: Σ kg = `portion.kg` per truck, Σ numeric places = P per truck, and
  Σ cartons and Σ pieces per line over the trucks = typed; and **no separate
  row ever has cartons 0** (Papers-1's assertion).

---

## 3. The service — `src/modules/wms/receipts/lot-composition.ts`

The ONE writer and the ONE reader of the three tables (apart from the price
history CTE, §6, and `tnvedHintsFor`, §5, which read the lines table in raw
SQL, and the tick in `batch-actions-server.ts`, which calls this module's
freeze/thaw).

### Exports

```ts
export type CompositionRefusalCode =
  | 'forbidden' | 'receipt_not_confirmed'
  | 'lines_count' | 'bad_line' | 'bad_number' | 'bad_tnved' | 'duplicate_name'
  | 'cartons_partial' | 'cartons_sum' | 'kg_sum' | 'm3_sum'
  | 'document_required' | 'document_not_on_receipt' | 'document_is_photo'
  | 'lot_changed' | 'composition_changed';

export class CompositionError extends Error {
  constructor(
    public readonly code: CompositionRefusalCode,
    public readonly seq?: number,
    public readonly field?: MeasureField,
    public readonly sums?: { sum: string; lot: string },
  ) { super(code); }
}

/** The Bojxona tab's audience is the composition's writer — one rule. */
export function mayWriteComposition(permissions: { has(code: string): boolean }): boolean {
  return mayOpenBatchVed(permissions); // batches/card-door.ts
}

/** A paper document, not a carton photo (CHANGED decision 3): a non-photo
 *  file, or anything uploaded after the prixod was confirmed. The editor's
 *  chips and the save ask this one predicate. */
export function isPaperDocument(
  att: { kind: string; createdAt: Date },
  receipt: { confirmedAt: Date | null; createdAt: Date },
): boolean; // att.kind === 'file' || att.createdAt > (receipt.confirmedAt ?? receipt.createdAt)

/** The door, asked on the POOL before any transaction (mayReadReceipt reads
 *  the pool — tests/unit/tx-pool.test.ts). A missing lot or receipt answers
 *  `forbidden` exactly like an unreadable one, so a refusal says nothing
 *  about which ids exist (finding Access-7). `requireConfirmed` false is the
 *  clear's door only. */
export async function compositionDoor(actor: Actor, lotId: string, opts: { requireConfirmed: boolean }):
  Promise<{ lot: typeof receiptLots.$inferSelect; receipt: typeof receipts.$inferSelect }>;

export const compositionInputSchema: z.ZodType<{
  lotId: string;
  seenRev: number;            // 0 = «there was none on my screen»
  seenBoxCount: number;
  seenKg: string;             // the lot's totals as the editor rendered them
  seenM3: string;
  attachmentId: string | null;
  lines: DraftLine[];         // 1..20 raw strings; parseDraft decides
}>;

export async function saveComposition(input: unknown, actor: Actor, ctx: AuditContext): Promise<{ rev: number }>;
export async function clearComposition(input: { lotId: string; seenRev: number }, actor: Actor, ctx: AuditContext): Promise<void>;
/** The Bojxona tab's per-line codes for ONE lot, in ONE transaction ('' clears).
 *  Never writes tnved_assignments. */
export async function setLineCodes(
  input: { lotId: string; seenRev: number; codes: { lineId: string; code: string }[] },
  actor: Actor, ctx: AuditContext,
): Promise<{ rev: number }>;

export interface CompositionView {
  lotId: string; rev: number; seenBoxCount: number;
  attachment: { id: string; fileName: string };
  savedBy: string | null; savedAt: Date;
  lines: (StoredLine & { id: string })[];
}
/** ONE statement: headers ⋈ attachments ⋈ users ⋈ LATERAL json_agg(lines
 *  ORDER BY seq) — two statements could tear (a clear between them gave a
 *  header with no lines, which `compositionMode([])` reads as «mixed» and the
 *  invoice prints as NO row: the lot vanishes from a customs paper — finding
 *  DM-nit). A view with fewer than 2 lines is treated as no composition and
 *  logged. `exec` DEFAULTS to `db` (`= db` in the signature, so the tx-pool
 *  fence classifies it `unlessGivenTx` and flags an in-tx call that forgets
 *  `tx` — an optional `exec?` hides it, finding DM5). A missing table
 *  (42P01 via isServerBehind) answers an EMPTY map and logs
 *  `[lot-composition] server behind` (#472). Empty `lotIds` → no query. */
export async function compositionsFor(lotIds: string[], exec: Db | Tx = db): Promise<Map<string, CompositionView>>;

/** What the PAPERS of one truck read: the frozen copy while the truck is
 *  ticked (a frozen `lines: null` = «no composition» for that truck), the live
 *  composition otherwise and for a lot that boarded after the tick. */
export async function paperCompositionsFor(batchId: string, lotIds: string[], exec: Db | Tx = db):
  Promise<Map<string, { seenBoxCount: number; lines: StoredLine[]; frozen: boolean; rev: number }>>;

/** The lot's trucks — the population of §2's cumulative rule AND the receipt
 *  card's «sent» line, one home (#513): per lot, every non-cancelled truck
 *  that carries or carried a carton of it (the live pointer UNION the
 *  departure movement — `batchMemberFilter`'s two halves restated per LOT, as
 *  CTEs, never `x.id IN (SELECT …)` in a join predicate, #152), with its
 *  carton count and its frozen copy of THIS lot. `exec` REQUIRED. Empty
 *  `lotIds` → empty map, no query (`IN ()` is a 42601 — finding Access-3). A
 *  missing table → empty map on the POOL; rethrown inside a transaction (the
 *  failed statement aborted it — the tick falls back on that). */
export async function lotTrucksFor(exec: Db | Tx, lotIds: string[]): Promise<Map<string, {
  batchId: string; code: string; departedAt: string | null; createdAt: string;
  crosses: boolean; n: number;
  frozen: boolean;                    // a batch_sent_compositions row for (truck, lot)
  frozenSegments: Segment[] | null;   // the positions frozen with it
}[]>>;

/** The tick's stamp: the (lot, rev, positions) of a truck's composed lots,
 *  sorted, hashed (sha256 hex); '' when none. The Bojxona page posts it; the
 *  freeze recomputes it from what it froze. The positions are in it because a
 *  paper moves when they do, even while every composition stands still. */
export function paperStamp(pairs: readonly { lotId: string; rev: number | null; segments?: readonly Segment[] | null }[]): string;
export async function paperStampFor(batchId: string): Promise<string>;
/** Inside the tick's transaction (§5): freeze reads every lot's positions on
 *  the truck (`truckPositions`), then copies in ONE statement and returns the
 *  frozen (lot, rev, positions); thaw deletes them and answers the COMPOSED
 *  lots it thawed (what the tick's audit counted). Both take the tx explicitly. */
export async function freezeCompositionsInTx(tx: Tx, batchId: string): Promise<{ lotId: string; rev: number | null; segments: Segment[] | null }[]>;
export async function thawCompositionsInTx(tx: Tx, batchId: string): Promise<number>;
```

### `saveComposition` — step by step

On the pool (no locks):

1. `compositionInputSchema.parse` → `validation` on a shape error.
2. `compositionDoor(actor, lotId, { requireConfirmed: true })`:
   `mayWriteComposition(actor.permissions)`, lot and receipt exist, and
   `mayReadReceipt(actor, receipt)` — any «no» is `forbidden`;
   `receipt.status !== 'confirmed'` → `receipt_not_confirmed`.
3. `parseDraft(lines)` → its refusal as a `CompositionError` with `seq` /
   `field`.
4. `attachmentId` null → `document_required`.

In ONE transaction, `SET LOCAL lock_timeout = '5s'` first (the count doors'
`setCountLockTimeout` idiom), in this lock order:

5. **The lot**: raw `SELECT … FROM receipt_lots WHERE id = $lot FOR NO KEY
   UPDATE` (NO KEY so a plan line's FK insert referencing the lot is not
   blocked; it still serialises against editLot, the count doors and a second
   save, which all take FOR UPDATE). Compare with the posted `seenBoxCount` /
   `seenKg` / `seenM3` (in units) → `lot_changed`.
6. **The prixod**: `lockReceiptShareNoWait(tx, lot.receiptId)` — EXPORTED from
   `receipts/grow-lot.ts`, raw `FOR SHARE NOWAIT` (drizzle renders «no wait»,
   #1174); then re-read `status` → not `'confirmed'` → `receipt_not_confirmed`.
   Closes the void/annul race (both lock the prixod FOR UPDATE and never touch
   the lot, so a save could otherwise commit a composition onto a prixod voided
   a moment earlier — finding DM-nit 8). NOWAIT is the house idiom
   (growLotInTx's lock-rv2-3); 55P03 → `busy`.
7. **The document**: `SELECT entity_type, entity_id, kind, created_at,
   file_name FROM attachments WHERE id = $a FOR KEY SHARE` → missing, or not
   `('receipt', lot.receipt_id)` → `document_not_on_receipt`; not
   `isPaperDocument(att, receipt)` → `document_is_photo`. FOR KEY SHARE so a
   concurrent `deleteAttachment` waits for this commit and then answers
   `in_use` (a plain SELECT let it slip between this check and the FK insert
   → an unmapped 23503 → a white page — findings DM-nit 7, Access-4). Taken
   BEFORE the header so a delete (attachment → header key-share) cannot cross
   the save (header → attachment).
8. **The header**: `SELECT rev FROM lot_compositions WHERE lot_id = $lot FOR
   UPDATE`. No row and `seenRev ≠ 0`, or a row and `rev ≠ seenRev` →
   `composition_changed`.
9. `checkSums(parsed, lockedLot)` → `cartons_partial` / `cartons_sum` /
   `kg_sum` / `m3_sum` against the LOCKED totals.
10. Upsert the header: `INSERT … ON CONFLICT (lot_id) DO UPDATE SET
    attachment_id, seen_box_count = locked.box_count,
    rev = nextval('lot_composition_rev_seq'), saved_by, saved_at = now(),
    updated_at = now() RETURNING rev`.
11. `DELETE FROM lot_composition_lines WHERE lot_id = $lot`, then INSERT the
    parsed lines (`fromUnits` strings; seq 1..k in the posted order; guard the
    empty list anyway, round 31's rule).
12. `writeAudit(tx, { …ctx, warehouseId: receipt.warehouseId }, { entityType:
    'receipt', entityId: receipt.id, action: 'update', before: { lotComposition:
    summary(old) | null }, after: { lotComposition: summary(new) } })` — the old
    summary read on the tx (`compositionsFor([lotId], tx)`).

**Lock order, stated against every door that touches these rows** (DM1's
lesson — a «cycle-free» sentence must be checked, not asserted):
save = lot (NO KEY UPDATE) → prixod (SHARE NOWAIT) → document (KEY SHARE) →
header (UPDATE). Count doors = advisory → lot (UPDATE) → cartons → truck row →
prixod (SHARE NOWAIT, growth). editLot = lot → cartons. void/annul = prixod
(UPDATE) → cartons → truck. deleteAttachment = document → header (RI key
share). The tick = snapshot INSERT (key-shares lots and the truck) → truck (NO
KEY UPDATE). **No composition write locks a truck row**, so the count door's
«lot, then truck» meets nothing; the only waits are on the lot and the header,
both taken in one direction by everybody. 40P01 and 55P03 → `busy` anyway.

After the commit, in the ACTION: `revalidatePath('/receipts/<id>')` and, for
every truck in `lotTrucksFor(db, [lotId])`, `'/batches/<id>/tnved'` and
`'/batches/<id>'` (the header's «TNVED kodsiz»). The action returns
`{ ok: true, rev, frozen: string[] }` — the codes of the lot's ticked trucks,
so ✅ can say «LTT-031 yuborilgan — uning hujjatlari o'zgarmaydi». No
notification to anyone (stated; the audit row is the record).

The tx body calls only tx-bound functions (`compositionsFor([lotId], tx)`,
`lockReceiptShareNoWait(tx, …)`); `mayReadReceipt`, `lotTrucksFor(db, …)` and
every other pooled read stay outside (`tests/unit/tx-pool.test.ts` follows calls
transitively and will say so).

`clearComposition`: door with `requireConfirmed: false` (a composition on a
prixod voided after the save must be clearable, or its document is undeletable
for ever — finding DM-nit 8), steps 5 (no seen totals) and 8, then `DELETE FROM
lot_compositions` (lines cascade). `setLineCodes`: door (confirmed), step 8,
then `UPDATE lot_composition_lines SET tnved_code` by `(id, lot_id)` — a line id
not in this lot → `composition_changed` — and `rev = nextval(…)`, all codes of
the lot in ONE transaction. Neither is refused because papers went: a ticked
truck prints its frozen copy (§5). Audits:
`{ lotComposition: summary(old) } → { lotComposition: null }` and
`{ lotCompositionCodes: ['Мышь: ∅'] } → { lotCompositionCodes: ['Мышь: 8471607000'] }`.

### The population query (one home — `lotTrucksFor`)

```sql
WITH member AS (
  SELECT b.lot_id, b.id AS box_id, b.current_batch_id AS batch_id
    FROM boxes b
   WHERE b.lot_id IN (…) AND b.current_batch_id IS NOT NULL
  UNION
  SELECT b.lot_id, b.id, m.ref_id
    FROM box_movements m
    JOIN boxes b ON b.id = m.box_id
   WHERE b.lot_id IN (…) AND m.ref_type = 'batch' AND m.cause = 'batch_departed'
)
SELECT mb.lot_id, t.id, t.code, t.departed_at, t.created_at,
       ${crossesBorderSql('o', 'd')} AS crosses, count(DISTINCT mb.box_id)::int AS n,
       (s.batch_id IS NOT NULL) AS frozen, s.segments
  FROM member mb
  JOIN batches t ON t.id = mb.batch_id AND t.status <> 'cancelled'
  JOIN warehouses o ON o.id = t.origin_warehouse_id
  JOIN warehouses d ON d.id = t.dest_warehouse_id
  LEFT JOIN batch_sent_compositions s ON s.batch_id = t.id AND s.lot_id = mb.lot_id
 GROUP BY mb.lot_id, t.id, o.country, d.country, s.batch_id, s.segments
```

- Both halves ride existing indexes (`boxes_lot_idx`, `box_movements_box_idx`).
- **Cross-border = `crossesBorderSql`** (`batches/internal.ts:67`) =
  `coalesce(NOT sameCountryLegSql, true)`: a truck whose warehouse has no
  country counts as crossing (D2 — for the population an unknown leg is safer
  inside than out; the clamp catches a double count).
- The receipt card and the save's ✅ filter `frozen` — a copy of THIS lot,
  never `sent_to_agent_at` (the review: a lot that boarded after the tick has
  no copy and reads live there, and «stays as sent» was a false promise); the
  papers call `truckSegments` on the same rows.

### Refusal codes → screen words

| Code | When | Uzbek sentence (key `tarkib.errors.<code>`) |
|---|---|---|
| forbidden | door (incl. a lot that does not exist) | «Sizda bu prixodning tarkibini yozish huquqi yo'q» |
| receipt_not_confirmed | draft/voided | «Bekor qilingan prixodga tarkib yozilmaydi» |
| lines_count | <2 or >20 | «Kamida 2 ta, ko'pi bilan 20 ta tovar. Bitta tovar bo'lsa — lot nomini logist o'zgartiradi» |
| bad_line {seq} | name <2 / >200 characters | «{seq}-qator: tovar nomini yozing» |
| bad_number {seq} — one key per field | unreadable / ≤0 / too many decimals | `bad_number_kg` «{seq}-qator, kg: son noto'g'ri — verguldan keyin ko'pi bilan 3 raqam»; `bad_number_m3` «… 4 raqam»; `bad_number_pieces` / `bad_number_cartons` «{seq}-qator, …: butun musbat son» |
| bad_tnved {seq} | not 4-10 digits | «{seq}-qator: TNVED kodi 4-10 raqam» |
| duplicate_name {seq} | same productKey | «{seq}-qator: bu tovar allaqachon bor» |
| cartons_partial | some rows have cartons | «Karobka sonini hammasiga yozing yoki hech biriga (aralash)» |
| cartons_sum {sum,lot} | Σ ≠ box_count | «Karobkalar {sum} ta — lotda {lot} ta. Hujjatda boshqacha bo'lsa — «aralash»ni tanlang» |
| kg_sum {sum,lot} | Σ ≠ lot kg | «Kg yig'indisi {sum} — skladda {lot} kg o'lchangan. «Sklad o'lchoviga moslashtirish»ni bosing» |
| m3_sum {sum,lot} | Σ ≠ lot m³ | «Kub yig'indisi {sum} — skladda {lot} m³. «Sklad o'lchoviga moslashtirish»ni bosing» |
| document_required | no attachment | «Mijozning hujjatini biriktiring (packing list / invoys)» |
| document_not_on_receipt | foreign file | «Hujjat shu prixodga yuklangan bo'lishi kerak (mashinaga emas)» |
| document_is_photo | carton photo from receive time | «Bu karobka rasmi — mijozning hujjatini yuklang» |
| lot_changed | totals moved | «Lot o'zgardi — yangilang, yozganlaringiz qoladi» |
| composition_changed | rev moved | «Tarkibni boshqa hodim o'zgartirdi — yangilang» (or, same actor: «Siz allaqachon saqladingiz — yangilang») |
| busy | 40P01/55P03 (`isBusyError`) | «Band edi — qaytadan bosing» |
| server_behind | 42P01 (`isServerBehind`) | «Server yangilanmoqda — birozdan keyin» |
| validation | zod; 23514 from a CHECK (belt) | «Ma'lumot to'liq emas» |

The panel maps codes through a LITERAL `Record<…, string>` built from literal
`t('errors.x')` calls (the `useMoveErrors` pattern), so
`tests/unit/i18n-keys.test.ts` sees every key (#163).

### Audit shape

`summary(comp)` = `{ lotId, letter: 'A', lines: ['Клавиатура — 50 kar, 500 шт, 600.000 kg, 1.5000 m³, 8471607000', 'Мышь — …'], document: 'packing.pdf', attachmentId }`.
Inside a line the parts are joined by «, » after an em dash, because
`formatAuditValue` (`audit/fields.ts:209-216`) joins the record's own fields by
« · » and its array items by «, » — a « · » inside a line made the History line
unparseable (finding R14/UX-nit). History reads «Lot tarkibi: letter: A ·
lines: Клавиатура — 50 kar, 500 шт, …, Мышь — … · document: packing.pdf».
New `AUDIT_FIELD_LABELS` entries: `lotComposition`, `lotCompositionCodes`
(bundles §10; `tests/unit/audit-fields.test.ts` anchors them). Entity
**'receipt'** (`receipts/[id]/page.tsx:695`). The tick's audit (entity
'batch') gains `frozenLots: N`.

---

## 4. The papers

All four builders read, once per document: `paperCompositionsFor(batchId,
lotIds)` and `lotTrucksFor(db, lotIds)` (for `truckSegments`). Each builder
computes its own single figure ONCE and passes that value as the portion's
`kg` / `m3` (finding Papers-6: packing-photos rounds with `toFixed`, the
invoice with `Math.round` — `(1.45).toFixed(1)` is «1.4», `Math.round(14.5)/10`
is 1.5).

### `src/modules/wms/documents/composition-cells.ts` (new, pure)

One home for the words the papers print about a composition (#513):

```ts
export function invoiceRowCells(line: PaperLine): {
  product: string; code: string; unit: 'шт' | 'кг'; quantity: number;
  places: number | string; kg: number;
};
export function packingProductCell(line: PaperLine): string; // 'Мышь — 1000 шт'
export function packingBoxesCell(line: PaperLine, mode: 'separate' | 'mixed', first: boolean): number | string;
export function agentContentsText(lines: PaperLine[], estimate: boolean): string;
export function estimateNote(view: PaperView, n: number, boxCount: number): string;
```

- Invoice **quantity**: `'шт'` + pieces when the line states pieces AND they
  come out ≥ 1 on this truck; otherwise `'кг'` + kg (today's rule). A pieces
  figure that rounds to 0 never reaches `E`, so `J = I×E` is never zeroed by
  an invented count (finding Papers-5, U11). (Deviation D4: the customs
  declaration's supplementary unit for goods like these is pieces; the owner
  asked for the count per good.)
- `'part'` prints `DOC.partOfPlace` = «(часть места) / (part of a place)» (a
  text cell: `SUM(F…)` ignores it). The draft packing list's BOXES column on
  an aralash lot's non-first lines prints `DOC.sameCartons` = «(в тех же
  коробках) / (same cartons)» instead — every carton there is whole and holds a
  mix (finding Papers-9).
- Estimate: the product cell gets `cell.note = estimateNote(…)` (the
  `stock-xlsx.ts:395` precedent) AND a light fill `FFFFF2CC`. Note text RU/EN,
  one clause per reason: «Расчётно / Estimate: доля лота на этой машине (40 из
  100 кор.) / lot share on this truck»; «лот изменён после ввода состава / lot
  changed after the contents were stated»; «места на поддоне распределены по
  коробкам / pallet places split by cartons»; «коробка учтена на двух машинах /
  a carton counted on two trucks».
- `DOC` (`documents/labels.ts`) gains `partOfPlace`, `sameCartons`, `contents`
  («Состав лота (весь план) / Lot contents (whole plan)»), all bilingual like
  every `DOC` value.

### Customs invoice — `buildInvoiceXlsx` (`documents/ved-xlsx.ts`)

- `invoicePlaceParts(rows): Map<lotId, { loose: number; pallets: number; onPallets: number }>`
  is the new exported core; `invoicePlaces` becomes `loose + pallets` of it
  (one home; its signature and `tests/integration/pallet.integration.test.ts`
  unchanged). The per-pallet ownership BETWEEN lots stays as today.
- After `byLot` is built: `paperCompositionsFor(batchId, [...byLot.keys()])`
  and `lotTrucksFor(db, …)`.
- The row loop: a lot with no composition prints exactly today's row (memory
  code, `'кг'`). A composed lot prints `paperLines(comp, lot, { segments:
  truckSegments(trucks, batchId), cartons: agg.boxCount, kg: round1(agg.kg),
  places: parts.get(lotId) })` → one row per printed line through
  `invoiceRowCells`: product = line name, ТНВЭД = the line's own code or blank
  (**never** `tnvedFor` — a line has no memory key), netto = brutto = line kg,
  price blank, amount `I×E` per row. `№` continues across lines.
- Totals rows unchanged; `SUM(G)`, `SUM(H)` and `SUM(F)` equal today's
  figures exactly.

### Packing list (draft) — `buildPackingXlsx` (same file)

A composed lot collapses ALL its `(lot, crate)` groups into one block of line
rows (the same `paperLines`, with `m3`): code `GS777-A`, product
`packingProductCell(line)`, packaging = the lot's packagings joined («короб
×80; CR-12 ×20»), boxes `packingBoxesCell(…)`, kg, m³. The portion's kg/m³ =
`round1` / `round3` of the lot's RAW Σ across its groups. **The footer's
`totalKg` / `totalM3` keep accumulating the RAW per-group figures as today**
(`ved-xlsx.ts:298-310`) and `totalBoxes` adds numbers only — the footer cannot
move by a composed row's rounding (finding Papers-10). (Deviation D5: per-crate
line rows would print a second, finer estimate.)

### Packing list with photos — `buildPackingPhotosXlsx` (`documents/packing-photos-xlsx.ts`)

The packing list the office actually sends. Rows per lot over `aboardFilter`;
a composed lot prints one row per printed line with portion `{ before, cartons:
loaded, kg: Number(kg.toFixed(1)), m3: Number(m3.toFixed(3)) }` — the values
the uncomposed row prints today; the lot's photographs are embedded on the
FIRST line's row only. The title line's totals are computed from the lots as
today, unchanged.

### Agent approval file — `buildAgentXlsx` (`documents/agent-xlsx.ts`)

Rows stay one per plan line (the agent approves the plan's lines). The
composition is computed ONCE PER LOT, over the version's lines of that lot
summed (finding Papers-3: `load_plan_lines_version_lot_unique` is (version,
lot, crate), so a lot planned «81 loose + 19 in CR-12» has two lines, and a
per-line portion flagged a fully planned lot as an estimate twice and split
51/49): portion `{ before, cartons: Σ plannedBoxCount, kg: round1(Σ
plannedKg), m3: round3(Σ plannedM3) }`. The lot's FIRST plan-line row's
product cell gains, with `wrapText: true`, the contents labelled as the lot's
whole planned contents:
`«键盘 (клавиатура)\nСостав лота (весь план) / Lot contents (whole plan): Клавиатура [8471607000] — 50 кор. · 600.0 кг · 1.500 м³ · 500 шт; Мышь — …»`
— each entry carries the line's TNVED code in brackets when it is set (the
sheet is read Chinese-first and the line names are Russian; the code is
language-neutral and is what the export declaration keys on — finding
Papers-8), «≈» before each figure and the estimate note when estimate. Row
height `max(60, 15 × (2 + printed lines))`. The suffix sums to the plan's kg at
0.1 kg (each plan row prints `planned_kg` at its stored 3 decimals — stated).

### Frozen trucks

While a truck is ticked, every builder above reads the frozen copy through
`paperCompositionsFor` — nothing else changes. The arithmetic still runs on the
truck's current cartons (a departed truck's are final, §2).

### Deliberately NOT taught (rule 1)

`documents/manifest-xlsx.ts` (one row per CARTON — nobody knows which carton
is a mouse), `documents/handover-act.ts`, `labels/sheet.ts` and every label
route. The fence (§11.1) lists them by name.

---

## 5. The truck's Bojxona tab

### `tnved/batch-lots.ts` — `batchTnvedProducts(batchId, departed)`

The return type stays `TnvedProductRow[]` and every existing field keeps its
meaning (`tests/integration/truck-card.integration.test.ts:276-284` reads
`nameZh` and `boxCount = 7` for a lot whose box_count is 7 with 2 cartons on
the truck; `tests/unit/count-load-wire.test.ts:173-176` pins
`aboardFilter(batchId)` in this file and `batchTnvedProducts(id,` in the page;
a widened union would break a test's narrowing in CI only, footgun 6).
Additions:

```ts
export interface TnvedProductRow {
  …existing fields…   // boxCount stays the LOT's box_count on every row kind
  /** The lots behind this row, for the per-lot «🧩 Tarkibi» links. */
  lots: { lotId: string; receiptId: string; label: string /* 'GS777-A' */ }[];
  /** Present on a composition LINE row; absent on a product row. */
  line?: {
    rowKey: string;           // 'line:<lineId>' live | 'snap:<lotId>:<seq>' frozen
    lotId: string; lineId: string | null; seq: number; rev: number;
    receiptId: string; label: string; ofLines: number;
    cartons: number | null;   // on THIS truck (paperLines); null = aralash
    pieces: number | null;    // on THIS truck
    kg: number;               // on THIS truck
    estimate: boolean; stale: boolean;
    frozen: boolean;          // the truck is ticked: read-only
    hint: { code: string; from: 'memory' | 'composition' } | null;
  };
}
```

- The query keeps its filter (`aboardFilter` after departure, the live
  pointer before) and becomes a GROUPED select (`count(*) AS n` per lot); the
  product rows keep `boxCount: lot.boxCount` — `n` feeds `paperLines` only
  (finding R8/Papers-10).
- `paperCompositionsFor(batchId, lotIds)` + `lotTrucksFor(db, lotIds)`. A
  composed lot leaves the per-name grouping and contributes one row per
  PRINTED line (`paperLines` — a line with no carton on the truck has no row):
  `nameZh` = the line's name (commented: «the name the row shows»), `nameRu`
  null, `code` = `line.tnvedCode ?? ''`, `source` null.
- `missingTnvedCount` is unchanged and therefore counts the printed lines:
  the header's «TNVED kodsiz · N» and the editor agree by construction (#513).
- `hint`: `tnvedHintsFor(names)` — new, read-only, in `tnved/service.ts`:
  (a) `tnved_assignments` by `productKey(name)` against `product_key` OR
  `productKeySql(product_name_ru)`; else (b) the newest stated
  `lot_composition_lines.tnved_code` whose `productKey(name)` matches (joined
  to its header's `saved_at`) — so «Мышь» typed on last week's truck is offered
  on this one (finding UX-retype; 4c says almost every truck). Never
  auto-fills; never writes the memory. No index on (b): the lines table holds
  a few thousand rows a year — measured, not assumed, when built.

### `tnved/actions.ts`

- New `saveLineCodesAction(batchId, entries: { lotId; lineId; rev; code }[])`:
  card door (`mayOpenBatchCard`) + `mayWriteComposition` + every lot has a
  carton that is a member of the truck (`batchMemberFilter`) else `forbidden`;
  a ticked truck → `frozen` («🔒»); entries GROUPED per lot into ONE
  `setLineCodes` call each (two calls for one lot would refuse the second line
  by the first's rev bump). Returns `{ ok, revs: Record<lotId, rev>, error? }`
  — the revs of the lots that DID commit travel with the first refusal, and
  the editor applies them before showing it (finding DM-nit/UX-partial).
  **No `revalidatePath`** — the editor calls `router.refresh()` after both
  saves, as `saveAll` does (#1242).
- **`saveTnvedAction` gains `batchId`**: it loads the truck and asks
  `mayOpenBatchCard(actor, batch)` (finding Access-5 — it asked no truck door
  at all), derives `departed` from that row, and refuses `not_on_truck` for an
  entry whose `productKey(nameZh)` is not a PRODUCT row (`!row.line`) of
  `batchTnvedProducts(batchId, departed)`. «A line code never writes
  `tnved_assignments`» is then a server rule (#531), and the old hole (any
  `ved.docs` holder could write any name into the company-wide memory) closes.
  (Deviation D3.)

### `tnved/tnved-editor.tsx`

- **Every piece of per-row state is keyed by `rowKey(row)`** = `row.line ?
  row.line.rowKey : row.lotId` — `setCode`, `busy`, `reasonings`, the
  «💾 xotiradan» lookup into `initial`, the post filters and the React key
  (finding R1/UX1, BLOCKER: today `setCode(lotId…)` maps `r.lotId === lotId`,
  and both lines of a composed lot share their lot's id, so typing the mouse
  code wrote it into the keyboard line too — a misdeclaration no planned test
  saw). A line row never shows `fromMemory`.
- The props stay `{ batchId, rows: initial }` (`batch-door-wire.test.ts:231`
  pins the signature) and product rows keep `suggestTnvedForLotAction(batchId,
  row.lotId)` (`:228-230` pin it); line and freeze state ride on the rows.
- A line row: «🧩 GS777-A · 1/2» linking to
  `/receipts/<receiptId>?tarkib=<lotId>&from=<batchId>#lot-<lotId>`, the name,
  `t('lineOnTruck', { cartons, kg, pieces })` («shu mashinada: 20 kar · ≈240.0
  kg · 200 dona») or `t('lineMixed', { kg, pieces })` — numbers from the
  server, words from the bundles (finding UX: no Uzbek string built in a
  server module); ⚠ `tarkib.stale` when stale; the code input (read-only with
  `tnved.lineFrozen` when `frozen`); the 💡 chip («💡 8471607000» /
  «💡 oldingi tarkibdan»); **no 🤖**; the lot's photo on the lot's FIRST line
  row only, a 🧩 tile on the others (the photo is a keyboard carton).
- A product row gains the per-lot chips «GS777-A 🧩» (`row.lots`).
- `missing` for the 🤖 button counts product rows only (`!r.line &&
  !r.code.trim()`) — a truck whose only gaps are lines drew a button that did
  nothing (finding R10/UX). `suggestAllMissing` skips line rows.
- `saveAll` posts product rows to `saveTnvedAction(batchId, …)` and changed,
  non-frozen line rows to `saveLineCodesAction`; the message names both counts
  separately: `t('saved', …)` for the memory, `t('lineSaved', { n })` —
  «{n} ta tarkib kodi saqlandi — faqat shu lot uchun, xotiraga yozilmaydi»
  (finding UX: «endi bu tovarlar avtomatik to'ldiriladi» is false for a line).
  Then one `router.refresh()`. The «(xotiraga)» suffix of the button shows
  only while a product row is changed.
- The page renders `<TnvedEditor key={editorKey} …/>` with `editorKey` = the
  rows' line keys and revs joined, so a refresh after a save — or a
  receipt-card save that replaced every line id — re-seeds the editor instead
  of leaving it posting dead ids for ever; on `composition_changed` it offers
  «🔄 Yangilash» (finding UX-stuck).

### `batches/[id]/tnved/page.tsx`

- **The tick** (`📤 hujjat yuborildi`) posts two hidden inputs: `want`
  (`'sent'` / `'unsent'`, from what the page showed) and `paperStamp`
  (`paperStampFor(batch.id)` at render). `setSentToAgentAction`
  (`batch-actions-server.ts:382`) keeps `authorizeOnBatch('ved.docs', …)`
  first (`batch-door-wire.test.ts:100` pins it) and becomes ONE transaction,
  in the truck doors' own lock order (the review: the first build took the
  copy — which key-shares the lots — BEFORE the truck row, and against an
  unload press holding the truck and wanting the lot that was a 40P01 the
  VED met as an error page): `SET LOCAL lock_timeout '10s'`, count-load's
  advisory lock (`lockTruckLoading`), the truck row `FOR NO KEY UPDATE`
  (re-reading `sent_to_agent_at` — already in the wanted state → no-op),
  then:
  - **sending**: `freezeCompositionsInTx(tx, batchId)` — the positions of
    every lot on the truck, then ONE `INSERT INTO batch_sent_compositions …
    SELECT` over the truck's member lots (`batchMemberFilter` — the invoice's
    population) LEFT JOIN their headers, the positions and a LATERAL
    `json_agg` of their lines, `RETURNING lot_id, rev, segments`; if
    `paperStamp(returned) !== posted` → throw `paper_moved` (the tx rolls the
    copy back); then `UPDATE batches SET sent_to_agent_at = <today>`.
    count-load (advisory → lot → truck) and the unload doors (truck → lot)
    both meet the tick as a wait, never a cycle (case 12f).
  - **un-sending**: `UPDATE … SET sent_to_agent_at = NULL`, then
    `thawCompositionsInTx`.
  - A wait that runs out (`isBusyError`) redirects to `?tarkib=band` and the
    page says `tarkib.errors.busy`; a half-applied deploy (`isServerBehind`:
    no `batch_sent_compositions` yet) is the plain toggle it was, logged
    `[tick] server behind` — no composition can exist without the table
    (case 12g).
  - `want` absent (the integration test's bare post,
    `batch-door.integration.test.ts:357`) = the opposite of the row, today's
    toggle; `paperStamp` absent = `''`, which equals the stamp of a truck with
    no composed lot — so that test stays green unchanged.
  - The audit gains `frozenLots`. `paper_moved` is answered by
    `redirect('/batches/<id>/tnved?tarkib=yangilandi#hujjatlar')` (outside the
    tx's try — NEXT_REDIRECT), and the page shows `tarkib.paperMoved`: «Tarkib
    o'zgardi ({lots}) — hujjatlarni qayta yuklab oling, keyin belgilang».
  This closes DM3's window for the case it describes (download, a colleague
  saves, tick). It cannot see a download made from an OLDER page load than
  the one the tick is pressed on — stated in §13.
- **«Prixod hujjatlari»**: below the truck's own documents, a `Panel`
  COLLAPSED by default with badge «{n} ta fayl» (round 43), listing the files
  of the prixods of the rows' lots, grouped per receipt under «GS777 ·
  {receipt number}» — the receipt ids FILTERED by `receiptsReadableBy(actor,
  …)` first (`receipts/read-door.ts:47`, one query): a scoped reader of the tab
  outlives `cargoNearActor` once the cartons move on, and a client's invoice
  file NAME often carries the client and an amount (finding Access-6). Group
  links and the line rows' 🧩 links are drawn only for readable receipts
  (#1023: a link that bounces is worse than no link). Bytes stay behind the
  `'receipt'` branch of `attachments/access.ts`.

---

## 6. «📈 Oldingi narx» — a composed lot counts as its lines

`finance/price-history.ts`, inside `pricePairs`: `kinds` leaves the `load` CTE
and gets its own two CTEs over the SAME `members`:

```sql
kind_lots AS (
  SELECT DISTINCT m.batch_id, rr.client_id, rl.id AS lot_id,
         ${productKeySql(sql`rl.product_name_zh`)} AS key
    FROM members m
    JOIN boxes bx ON bx.id = m.box_id
    JOIN receipt_lots rl ON rl.id = bx.lot_id
    JOIN receipts rr ON rr.id = rl.receipt_id
    JOIN pairs p ON p.client_id = rr.client_id AND p.batch_id = m.batch_id
),
kinds AS (
  SELECT k.batch_id, k.client_id,
         count(DISTINCT coalesce(g.id::text, k.key))::int AS kinds
    FROM kind_lots k
    LEFT JOIN lot_composition_lines g ON g.lot_id = k.lot_id
   GROUP BY k.batch_id, k.client_id
)
```

and the final SELECT joins `kinds`. The DISTINCT collapses cartons to lots
BEFORE the lines join, so the join multiplies lots, never cartons; a join in
`load` would multiply every carton row by the line count and double the kg the
per-cube figure divides by (#432's fan-out) — red proof R5. A line is its own
kind (its id), so a composed lot of two lines makes the pair `isMixed`
(`price-history.ts:88`) and its blended price is never served as a clean
precedent. Overcounting a keyboard line and a «键盘» lot as two kinds is the
safe direction. (The live lines and not the frozen copy: a precedent is about
what the cargo WAS, and the latest statement is the best knowledge.)

**Measure before and after** (finding R11): `members` becomes referenced twice,
so postgres 12+ MATERIALIZES it instead of inlining it, under the 1.5 s
`HINT_STATEMENT_MS` ceiling — #1251 was exactly a plan that was fine on the
small copies and not on `gsr_card_perf`. Time `priceHistoryForLots` on
`gsr_card_perf` with and without the change; if it is slower, compute `kinds`
inside `load` from a lot-level subselect over `SELECT DISTINCT lot_id` (still
no carton fan-out). On a half-applied deploy the CTE fails and the read's
existing `failed` path renders «could not read» — stated, not caught.

`pricePairs` is EXPORTED for the integration test (a commented test seam: its
public callers pass through `pricedTruckSql`, which needs a second «needle»
truck, a 12-month window and a live charge — finding R6).

---

## 7. Stale

`isStale` (§2) is the one test. Nothing hooks into `editLot`, `growLotInTx`
or `shrinkGrownInTx` — they change the lot, the composition stays as stated,
and every reader compares. Shown:

- receipt card: ⚠ `tarkib.stale` on the lot's panel, with the stated and
  current totals side by side, and a one-line warning on `LotEditForm` when a
  composition exists: «⚠ Lotda tarkib bor — kg/karobka o'zgarsa tarkibni qayta
  tekshirish kerak» (finding UX-nit);
- Bojxona tab: ⚠ on each line row;
- papers: estimate fill + note «лот изменён после ввода состава».

Saving again clears it («Sklad o'lchoviga moslashtirish» is the one-press
repair for kg/m³).

---

## 8. UI

### Receipt card — `receipts/[id]/composition-panel.tsx` (client) + `composition-actions.ts`

Server side (`receipts/[id]/page.tsx`): `compositionsFor(lotIds)`,
`lotTrucksFor(db, lotIds)` (the «sent» line), `mayWriteComposition(actor.
permissions)` (the page already passed `mayReadReceipt`), the receipt's files
(`receiptFiles`, already loaded) each flagged `isPaperDocument`. Each lot card
gets `id={\`lot-${lot.id}\`}` + `scroll-mt-20`; `?tarkib=<lotId>` opens that
lot's editor, `&from=<batchId>` draws «← Bojxona · LTT-…» on its ✅ (finding
UX-nit: the PWA has no address bar and the card's only link was «← Prixodlar»).
The panel renders after the `PhotoGallery`, before `LotEditForm`, for:

- **every reader** when a composition exists: a compact read-only face
  «🧩 Tarkibi: Клавиатура · Мышь» that unfolds to the lines, the document link
  and «{name} · {date}» (deviation D9);
- **writers** (`mayWriteComposition`, receipt confirmed): «➕ Tarkibi» or
  «✏️ Tarkibni o'zgartirish»; and, when `lotTrucksFor` names trucks holding a
  copy of this lot (`frozen`),
  the info line `tarkib.frozenInfo` «🔒 LTT-031 hujjatlari yuborilgan — u
  mashina yuborilgan holida qoladi; yangi tarkib faqat hali yuborilmagan
  mashinalarga tushadi. O'sha mashinani ham o'zgartirish kerak bo'lsa: VED
  «yuborildi» belgisini olib, hujjatlarni qayta yuklab, agentga qayta
  yuborsin» (the button stays).

Structure: `CompositionPanel` (NOT keyed; holds `open` and the last ✅) →
`CompositionEditor key={comp?.rev ?? 0}` (a token never repeats, so any new
composition remounts a stale editor). Controlled inputs; the save is
`preventDefault` + `await saveLotCompositionAction(payload)` (no form `action`
prop, #463), so **a refused save keeps every typed value** (#171). While a call
is in flight «Saqlash» and «Tarkibni o'chirish» are disabled (a button
disabled WHILE PENDING is not a grey button with no reason — a double tap
otherwise refused the person's own save as «boshqa hodim», finding UX-double).
The action catches `CompositionError`, `isBusyError` → `busy`,
`isServerBehind` → `server_behind`, a 23514 → `validation`, and
`revalidatePath`s (§3); the client does NOT `router.refresh()` after it
(#1242). On ✅ the editor CLOSES (as `LotEditForm` does — the owner reported
an editor that «just sat there») and ✅ names the frozen trucks. On
`lot_changed` the panel offers «🔄 Yangilash» = `router.refresh()`: totals come
from props, lines stay in state. On `composition_changed` the same button says
«yozganlaringiz o'chadi». A per-lot draft is kept in `localStorage` (try/catch
on every read and write, cleared on ✅) — fetching the client's PDF on a phone
means leaving for Telegram, and iOS may reload the standalone app (the receive
wizard's own reason, `receive-wizard.tsx:28`).

Editor contents, top to bottom:

1. **Document FIRST** (the VED types FROM it): the prixod's paper documents as
   radio chips (file name truncated; a chip opens the file in a new tab; ✕ on
   a chip the actor uploaded that no composition cites — through the same
   `DELETE /api/attachments/<id>`, which already allows the uploader), the
   selected one ringed; the receive-time carton photos are NOT offered.
   «📎 Hujjat yuklash» uploads through `uploadAttachmentFile(file, 'receipt',
   receiptId)` and selects the new file; while it uploads the chip shows ⏳
   and «Saqlash» answers locally `tarkib.uploading` («Hujjat yuklanmoqda —
   tugashini kuting») without calling the action (round 97's lie, one screen
   over); the counter decrements in `finally`. The file input's handler is
   named `addDocument` and is followed by `e.currentTarget.value = ''`
   (#759: re-picking the same file after a failure fires no change), and the
   file joins `tests/unit/photo-inputs.test.ts`'s FILES. After an upload
   succeeds, `router.refresh()` (no action revalidated — #1242 forbids it only
   after one), so the card's own «Hujjatlar» panel, now keyed on its files'
   ids, re-seeds; the editor merges server files with its local uploads by id
   (finding UX-chips). Under the chips: `tarkib.docWhere` «Hujjat shu
   prixodga yuklanadi (mashinaga emas)».
2. Mode chips: «Alohida karobkalar» (default) / «Aralash karobkalar». Aralash
   keeps the cartons cells but makes them `invisible` (state kept, posted
   empty), so nothing shifts under the header labels (finding UX-column). A
   one-carton lot shows only «Aralash» with `tarkib.oneCartonMixed`.
3. Line blocks (2 to start; «+ qator» up to 20; ✕ per line from the third, and
   on any line while more than two exist). Inputs `type="text"` with
   `inputMode="decimal"` / `"numeric"`. Per line: name; **«Jami dona (hammasi)»**
   with, in alohida mode, the live «= {n} dona/karobka» under it (pieces ÷
   cartons — a per-carton figure copied as the total shows up as «= 0.2»
   before it declares 10 mice instead of 500, finding UX-dona); cartons; kg
   with «=» (`fillRest(…, 'kg')`); m³ with «=» (`fillRest(…, 'm3')`); TNVED
   (no 💡 here — the Bojxona tab is the TNVED place the owner named; finding
   UX-nit).
4. «Karobka soniga qarab taqsimlash» (drawn when `prefillByCartons` is
   non-null) and «Sklad o'lchoviga moslashtirish» (drawn when `scaleToLot`
   is non-null for kg or m³; the hint says the sums are the WAREHOUSE's
   measurement and may differ from the client's paper — finding UX-exact).
5. **A sticky bar** `sticky bottom-20 md:bottom-2` (the `cost-queue.tsx:107`
   idiom) holding the remainder and «Saqlash»: one entry per measure with its
   own sign word and colour — «kg: +100.000 ortiqcha · m³ ✓ · kar ✓» — so the
   counter is on screen while the keyboard is up (finding UX-sticky).
6. Error line (`tarkib-error`, the offending input ringed and scrolled into
   view for `bad_number`), «Tarkibni o'chirish» (secondary, confirm names the
   consequence: «invoys yana bitta qator bo'ladi»).

The client also runs `parseDraft` + `checkSums` before calling the action and
shows the same sentence without a round trip; the server re-runs both.

**Phone and tablet, below `xl`** (a 768-px tablet leaves ~485 px of card:
sidebar 225 + main padding 32 + card 26 — finding UX-grid): a line block is a
bordered mini-card: header row «1» + ✕ (44 px target); name full width; then
`grid grid-cols-2 gap-1.5` → dona | karobka, kg | m³; TNVED full width. Labels
above inputs (`label` class). Buttons wrap (`whitespace-normal`). Every input
`!min-h-10` (`.input` carries `min-h-12` and `w-full` — never a bare width on
`.input`, `tests/unit/style-cascade.test.ts`).

**`xl` (1280 and up)**: the same blocks become rows,
`xl:grid xl:grid-cols-[minmax(9rem,1fr)_minmax(4.5rem,6rem)_minmax(4.5rem,6rem)_minmax(5.5rem,7rem)_minmax(5.5rem,7rem)_minmax(7rem,9rem)_2.75rem] xl:items-end xl:gap-2`
(minimum 668 px; the card has ~997 px at 1280 with the sidebar open), one
header row of labels (`hidden xl:grid`), per-input labels `xl:sr-only`, and a
second `xl:col-span-full` row per line for the two «=» and the dona/karobka
hint. Literal class strings only.

testids (exact `getByTestId`): `lot-tarkib` (panel, `data-lot`),
`lot-tarkib-open`, `tarkib-editor`, `tarkib-mode-separate`, `tarkib-mode-mixed`,
`tarkib-line`, inside it `tarkib-name`, `tarkib-pieces`, `tarkib-per-carton`,
`tarkib-cartons`, `tarkib-kg`, `tarkib-m3`, `tarkib-tnved`, `tarkib-fill-kg`,
`tarkib-fill-m3`; `tarkib-add-line`, `tarkib-prefill`, `tarkib-scale-kg`,
`tarkib-scale-m3`, `tarkib-remainder`, `tarkib-doc` (per chip, `data-id`),
`tarkib-upload`, `tarkib-save`, `tarkib-error`, `tarkib-saved`, `tarkib-stale`,
`tarkib-frozen`, `tarkib-clear`. Bojxona tab: `tnved-line-row`,
`tnved-line-code`, `tnved-lot-link`, `receipt-docs`, `tnved-paper-moved`.

### `components/attachments-panel.tsx` — `in_use`

`remove()` today ignores a 403. It reads the body: `error === 'in_use'` →
`receipts.attachInUse` («Bu hujjat lot tarkibida ishlatilgan — VED yoki logist
boshqa hujjatni tanlamaguncha o'chirib bo'lmaydi» — the skladchi who presses ✕
cannot change a composition, finding UX-nit); any other refusal →
`receipts.attachFailed`. (Also fixes the silent refusal of a queued Telegram
photo, the same code.)

### `/api/files/upload` — the `'receipt'` target

A `'receipt'` upload whose receipt row EXISTS now asks `mayReadReceipt(actor,
receipt)` → 403 otherwise; a row that does not exist yet (the wizard pre-binds
to the id it minted, #180) passes as before — staff_note's pattern
(`upload/route.ts:95-113`). These files now back customs papers; any login
could add one to any prixod (finding Access-1). The warehouse at its own
prixod and the unscoped office roles are unaffected.

---

## 9. Readers — taught and deliberately not

**Taught.** Split in two for the fence (§11.1): **MUST** = files that must
name the tables or import the modules (the fence fails if one does not);
**ALLOWED** = MUST plus files that may.

| File | What changes | MUST? |
|---|---|---|
| `platform/db/schema/wms.ts` | the three tables | MUST |
| `platform/db/migrations/0122_lot_composition.sql` + journal | §1 | (SQL; not scanned) |
| `wms/receipts/lot-composition.ts` | writer, readers, freeze (§3) | MUST |
| `wms/receipts/composition-math.ts` | pure (§2) | MUST |
| `wms/receipts/grow-lot.ts` | `lockReceiptShareNoWait` exported | — |
| `wms/documents/composition-cells.ts` | the papers' words (§4) | MUST |
| `wms/documents/labels.ts` | `DOC.partOfPlace`, `sameCartons`, `contents` | — |
| `wms/documents/ved-xlsx.ts` | invoice + draft packing; `invoicePlaceParts` | MUST |
| `wms/documents/packing-photos-xlsx.ts` | line rows | MUST |
| `wms/documents/agent-xlsx.ts` | contents per lot | MUST |
| `wms/tnved/batch-lots.ts` | line rows, `lots` chips | MUST |
| `wms/tnved/service.ts` | `tnvedHintsFor` (read-only, reads the lines table) | MUST |
| `wms/finance/price-history.ts` | `kinds` CTEs; `pricePairs` exported | MUST |
| `app/(protected)/receipts/[id]/page.tsx`, `composition-panel.tsx`, `composition-actions.ts` | §8 | MUST (the three) |
| `app/(protected)/receipts/[id]/lot-edit-form.tsx` | the ⚠ line | ALLOWED |
| `app/(protected)/batches/[id]/tnved/page.tsx`, `actions.ts` | §5 | MUST |
| `app/(protected)/batches/[id]/tnved/tnved-editor.tsx` | rowKey, line rows | ALLOWED |
| `app/(protected)/batches/batch-actions-server.ts` | the tick: freeze/thaw | MUST |
| `app/api/files/upload/route.ts` | `'receipt'` per-record gate | — |
| `components/upload-attachment.ts`, `components/attachments-panel.tsx` | extracted uploader, `in_use` | — |
| `platform/audit/fields.ts` | two labels | — |

**Deliberately NOT taught** (keep the lot's name; nobody knows which carton is
which, the warehouse does no re-stickering):
`labels/sheet.ts` and the print routes; `scanning/*` (load, unload, the
snapshot); `planning/*` (plans reserve the lowest `seq_in_lot`, DECISIONS #3);
`inventory/*`; `crates/*`; `client-cabinet/*`, `notices/*` and
`platform/telegram/*`; `bot/lookup.ts`; `search/service.ts`;
`broadcast/service.ts`; `documents/manifest-xlsx.ts`;
`documents/handover-act.ts`; `issue/*`; `costing/*` and every money reader
(`finance/pricing-view.ts`, `finance/unpriced.ts`, `finance/compensation.ts`,
`finance/similar-ai.ts`, `finance/off-truck.ts`, `staff/*`);
`reports/queries.ts`; `deals/service.ts`; `calc/*` (the VED's own customs
calc stays the price — 5a); `platform/ai/schema-card.ts` (§1).

Consequences stated to the owner: the client's «qabul qilindi» push and the
cabinet still say «klaviatura»; the pricing page's lot row and its 📈 needle
still read the lot's own name for THIS truck (only future lookups see it as
mixed); **composing a lot takes its memory-prefilled ТНВЭД off the invoice
until a code is typed per line** — an uncomposed «键盘» printed the memory's
code, the lines print blank (the 💡 offers one; it never fills itself —
finding R9).

---

## 10. i18n keys (ru · uz · zh-CN · en — all four, same commit)

New namespace `tarkib`: `title`, `open`, `edit`, `hint` («Lot, stiker va
karobkalar o'zgarmaydi — faqat invoys, packing list va agent fayli shu
qatorlarni chiqaradi»), `modeSeparate`, `modeMixed`, `modeMixedHint`,
`oneCartonMixed`, `name`, `nameHint` («Invoysda shu nom chiqadi — ruscha
yozing»), `pieces` («Jami dona (hammasi)»), `perCarton` ({n}), `cartons`, `kg`,
`m3`, `tnved`, `addLine`, `removeLine`, `prefill`, `scaleToLot`, `scaleHint`,
`fillRest`, `remainderKg` / `remainderM3` / `remainderCartons` ({value}),
`remainderOver`, `remainderDone`, `document`, `documentUpload`, `documentNone`,
`docWhere`, `uploading`, `save`, `saved`, `savedFrozen` ({trucks}), `clear`,
`clearConfirm`, `cleared`, `stale` ({stated} {current}), `staleOnLotForm`,
`frozenInfo` ({trucks}), `paperMoved` ({lots}), `savedBy` ({name} {date}),
`kinds` ({n}), `estimate`, `mixedCartons`, `reload`, `reset`, `receiptDocs`
({n}), `lineOf` ({lot} {seq} {n}), `openFromTruck`, `backToTruck` ({code}),
and `errors.{forbidden, receipt_not_confirmed, lines_count, bad_line,
bad_number_kg, bad_number_m3, bad_number_pieces, bad_number_cartons,
bad_tnved, duplicate_name, cartons_partial, cartons_sum, kg_sum, m3_sum,
document_required, document_not_on_receipt, document_is_photo, lot_changed,
composition_changed, composition_changed_self, busy, server_behind,
validation}` (sentences in §3).

Elsewhere: `audit.fields.lotComposition` («Lot tarkibi» / «Состав лота»),
`audit.fields.lotCompositionCodes` («Tarkib TNVED kodlari» / «Коды ТНВЭД
состава»), `receipts.attachInUse`, `tnved.notOnTruck`, `tnved.lineNoAi`,
`tnved.lineOnTruck` ({cartons} {kg} {pieces}), `tnved.lineMixed` ({kg}
{pieces}), `tnved.lineSaved` ({n}), `tnved.lineFrozen`, `tnved.lineHintMemory`
({code}), `tnved.lineHintComposition` ({code}), `tnved.reload`.

Placeholders are ICU arguments; no literal `{` in a message (#520). Every key
is reached through a literal `t('…')` or a literal map (§3).

---

## 11. Tests

### 11.1 Unit

- `tests/unit/composition-math.test.ts` — §2.
- `tests/unit/composition-cells.test.ts` — 'шт' vs 'кг' (incl. pieces 0 → кг,
  U11), `'part'` → «(часть места) / (part of a place)», `sameCartons` in the
  draft's aralash rows, the agent text with codes for U1/U2, the estimate note
  per reason.
- `tests/unit/lot-composition-fence.test.ts` (source shape, comments stripped
  first — the `money-audience-fence.test.ts` helper, #725):
  1. **Derived allowlist, two lists** (finding R2 — «EXACTLY the taught list»
     failed on day one, since `labels.ts`, `fields.ts` and the uploader name
     none of the tokens, and a builder would have loosened it to a subset
     check that also passes when the scan finds nothing): every
     `src/**/*.{ts,tsx}` whose stripped source names `lotCompositions`,
     `lotCompositionLines`, `batchSentCompositions`, `lot_compositions`,
     `lot_composition_lines`, `batch_sent_compositions`, `lot-composition` or
     `composition-math` is in ALLOWED; and every MUST file is among them (a
     scan that finds nothing is red).
  2. The named deny list (labels/sheet.ts, scanning/, planning/, inventory/,
     crates/, client-cabinet/, notices/, bot/, search/, broadcast/,
     manifest-xlsx.ts, handover-act.ts, costing/, finance/pricing-view.ts,
     finance/unpriced.ts, platform/ai/) — redundant with (1), but the failure
     names the rule.
  3. `lot-composition.ts` never imports `saveTnved` and never names
     `tnvedAssignments` / `tnved_assignments`.
  4. `ved-xlsx.ts`'s composed branch calls `paperLines(` and not `tnvedFor(`
     on a line; `invoicePlaces` is computed FROM `invoicePlaceParts`.
  5. `price-history.ts`: the `load` CTE's text does not contain
     `lot_composition_lines` (#432); a `kinds` CTE does.
  6. `tnved-editor.tsx` has no `r.lotId === lotId` comparison left and calls
     `rowKey(`; it posts product rows with a `!r.line`/`!row.line` filter.
  7. the copy (`copyCompositionsInTx`) is ONE `INSERT … SELECT … RETURNING`
     statement carrying the positions, `freezeCompositionsInTx` reads the
     positions before it, and the tick takes `lockTruckLoading` → the truck
     row `FOR NO KEY UPDATE` → the freeze → `UPDATE batches`, catching
     `isBusyError` and `isServerBehind`. 7b: the frozen-truck lists read
     `truck.frozen`, never `sentAt`. 9: the save day is `tashkentDay`, and
     the voided prixod's clear and a document's ✕ set a refusal.
  8. `compositionsFor`'s signature carries `= db` (the tx-pool fence's seed
     shape) and it issues ONE statement.
- Existing fences that check the round for free, and the ones it must keep
  green by construction (finding R12): `i18n-keys`, `audit-fields`, `tx-pool`,
  `style-cascade`, `migration-journal`, `ai-schema-card` (green BECAUSE
  nothing is granted), `e2e-width-oracle`, `photo-inputs` (the editor's file
  input JOINS its FILES list); `batch-door-wire.test.ts:213-235` (the editor's
  props and `suggestTnvedForLotAction(batchId, row.lotId)` — kept as they are;
  `:100` the tick's door — kept first); `count-load-wire.test.ts:173-176`
  (`aboardFilter(batchId)` in `batch-lots.ts`, `batchTnvedProducts(id,` in the
  page — kept); `truck-card.integration.test.ts:276-284` (product `boxCount`
  = the lot's 7 — kept).

### 11.2 Integration — `tests/integration/lot-composition.integration.test.ts`

Fixture written straight to the tables (the `stamped-cargo.ts` /
`truck-card.integration.test.ts` shape), every name run-suffixed: two CN
warehouses and one UZ warehouse; a client; a confirmed receipt with lot
«键盘<SFX>» 100 cartons 1000.000 kg 2.5000 m³ and 100 boxes; on the receipt a
`kind='file'` attachment (the document; no bytes needed), a `kind='photo'`
attachment created BEFORE `confirmed_at` (the carton photo), and a second
receipt with its own file (the foreign document). Trucks, created in this
order: `INTERNAL` (CN→CN, departed first, all 100 cartons — must stay out of
the population), `CROSS` (CN→UZ, departed second, 33 cartons via
`batch_departed`), `CROSS2` (CN→UZ, forming, 67 cartons on the live pointer),
`NOCOUNTRY` (a warehouse with empty country; one other lot). Lines are 50/50 —
with 33/67 a per-truck largest remainder declares 51/49 and the cumulative rule
50/50, which is what makes R13 and R1 bite (a 70/30 split divides 40/60 evenly
and keeps both green — measured; #166). Actors are plain objects (`{ id,
permissions: new Set([...]), warehouseScoped, warehouseIds, roles }`) — no role
rows minted (#183). The memory is snapshotted as ROWS — `(product_key,
tnved_code, updated_at)` for the lot's Chinese key and both line names' keys —
because `saveTnved` UPSERTS and a count cannot see an update (finding R5).

Cases (each named after the rule):

1. Save (separate): header + 2 lines, an opaque rev, audit row on entity
   `'receipt'` with `after.lotComposition.lines.length === 2`,
   `before.lotComposition === null`; re-save → a different rev, before = the
   first summary.
2. Every refusal of §3 once, with `seq`/`field`/`sums` asserted;
   `document_is_photo` with the receive-time photo; a `'receipt'` photo
   uploaded after confirmation is accepted.
3. Door: a warehouse operator's permissions → `forbidden`; a scoped VED whose
   warehouse neither received nor holds the cargo → `forbidden` (R7); a
   random lot uuid → `forbidden` (not a different code); the same VED scoped
   to the destination while the cartons are in transit → allowed.
4. **ABA** (findings DM2/R3/UX10): save C1 (rev r1) → clear → another actor
   saves C2 with seenRev 0 → a save with seenRev r1 → `composition_changed`.
5. `lot_changed` on posted totals; `composition_changed` on a stale rev;
   `receipt_not_confirmed` when a holder transaction voids the prixod first.
6. **Concurrency, deterministic** (#873's method — holder tx left open, the
   observer polls `pg_stat_activity wait_event_type = 'Lock'` through the
   POOL): (a) the count-press shape — holder takes the truck-load advisory
   lock, `receipt_lots FOR UPDATE`, then `UPDATE batches SET status =
   'loading'` on `CROSS2`; a save starts; holder commits; BOTH commit, no
   40P01 (DM1's repro, now green); (b) holder `SELECT … FROM receipts … FOR
   UPDATE` (a void in flight) → the save answers `busy` at once (NOWAIT);
   (c) holder `DELETE FROM attachments WHERE id = <doc>` left open → the save
   waits; holder rolls back → the save commits.
7. **Invoice, cumulative**: before any composition, capture CROSS's and
   CROSS2's single-row figures. Compose. CROSS (33 of 100): two rows, cartons
   17/16, kg summing to CROSS's captured figure, estimate note on both;
   CROSS2: cartons 33/34, kg summing to its captured figure; **Σ cartons and Σ
   pieces per line over CROSS + CROSS2 = typed** (R13, R1). Load 5 more cartons
   onto CROSS2 → CROSS's rows are unchanged (a departed truck's paper does not
   move). A lot with no composition on the same truck prints exactly its old
   row. Whole lot on one truck (the NOCOUNTRY lot) → no note, typed figures.
   A pallet: 4 pallets of 25 on a separate 50/50 lot → places 2/2 + the
   pallet note (R8). A 1-carton truck of a separate lot → one row only (R14).
8. Packing-photos and draft packing: line rows; each lot's lines sum to the
   figure the same builder printed before the save; draft footer kg/m³/boxes
   unchanged.
9. Agent file: a lot half loose, half crated, FULLY planned → no estimate
   note, the contents printed once, equal to the typed lines (R15); a
   40-carton plan → «≈» and the note.
10. Bojxona tab: `batchTnvedProducts(CROSS, true)` returns 2 line rows and no
    «键盘» product row, product rows' `boxCount` unchanged; `missingTnvedCount`
    = 2, then 1 after one `setLineCodes`; the memory ROWS unchanged across the
    whole file (R6: a `saveTnved` call under the lot's own name in
    `setLineCodes` → red); `saveTnvedAction(CROSS, [{ nameZh: 'Мышь', … }])`
    → `not_on_truck`; a scoped holder outside the truck's ends →
    `forbidden` (Access-5).
11. Stale, two halves. (a) `growLotInTx` by 2 inside a tx → `isStale` true,
    invoice rows carry the stale note and sum to the new single figure;
    re-save → not stale. (b) The count clause ALONE: a second lot (aralash)
    gets `UPDATE receipt_lots SET box_count = box_count + 1` with kg/m³
    untouched → stale (R9 anchors here).
12. **Freeze** (CHANGED decision 5): tick CROSS through
    `setSentToAgentAction` with the stamp from `paperStampFor` → a
    `batch_sent_compositions` row for EVERY member lot (composed and not);
    then change the composition → saves (no refusal); CROSS's invoice prints
    the frozen lines, CROSS2's the new; compose the uncomposed lot → CROSS
    still prints it as one row; un-tick → CROSS prints the live composition,
    the rows are gone (R10). A stale stamp (posted before a save) →
    `paper_moved`, nothing frozen, `sent_to_agent_at` still NULL (R12). A
    bare post (no stamp) on a truck with no composed lot ticks, as
    `batch-door.integration.test.ts:357` does today. Both audits count the
    COMPOSED lots (1 and 1 — the un-tick counted every row).
12d. **The freeze holds the positions** (added by the review): EARLY,
    created before CROSS2, takes 11 of A and one carton waits on the shelf —
    CROSS [0,33) · EARLY [33,44) · CROSS2 [44,99). A stamp drawn before EARLY
    was dialled refuses the tick (the positions are in it). CROSS2 ticked →
    its copy carries `[[44,99]]`; CROSS2 then departs while EARLY forms (the
    old order put it at [33,88): 27/28 instead of 28/27), EARLY is dialled
    and departs — CROSS2's invoice and Bojxona rows never move. The odd 11
    and 55 are the point: on a 50/50 lot a run's lines depend only on the
    parity of its start and length, and the first fixture (10/57) printed
    the same lines from both runs and stayed green with the pin stripped.
12e. **A truck ticked before 0122** (added by the review): CROSS ticked with
    no copy, the migration's OWN backfill statement run scoped to CROSS → a
    row per lot, `lines` NULL; a composition saved through the action leaves
    CROSS's invoice as sent and ✅ names CROSS only — not CROSS2, whose
    `sent_to_agent_at` is set but which holds no copy of the lot.
12f. **No deadlock with an unload press**: a holder takes CROSS's row
    `FOR NO KEY UPDATE` (count-accept's first lock), the tick waits on it,
    the holder takes the lot `FOR UPDATE` and commits, the tick commits.
12g. **A half-applied deploy**: the freeze and thaw fail 42P01 (stood in by
    a module mock) → the tick is the plain toggle both ways and logs
    `[tick] server behind` twice.
13. Price history (`pricePairs`, exported): the pair (client, CROSS) has
    `kinds = 2` once composed and the per-cube kg equals the uncomposed figure
    (R5); two lots stated with the same two goods are 2 kinds, not 4 (kinds
    count a line by its NAME — the review). The fixture mints a non-voided charge for the client on CROSS (the
    money CTE inner-joins it) and the final test deletes it.
14. `deleteAttachment` of the cited document → `in_use`; after
    `clearComposition` → deletes. A composition on a prixod voided after the
    save can be cleared (`requireConfirmed: false`).
15. `clearComposition`: rows gone (lines cascaded), audit `after = null`,
    invoice back to the single row.
16. **Cleanup — the FINAL test**, not `afterAll` (round 57's lie; finding
    R7 — an in-transit leftover is the next spec's dashboard, #154): delete
    the compositions, the frozen rows, the charge, the attachments, the
    movements, boxes, lots, receipts, the trucks and the client;
    DEACTIVATE the warehouses (`audit_log` FK); prove nothing with the run
    suffix remains and the memory rows equal the snapshot.

### 11.3 Red proofs to run (string edit and back by string edit — never `git checkout`, #430; commit the WIP first, #1246)

| # | Strip | Expect red |
|---|---|---|
| R-U1 | BigInt → Number in `largestRemainder` | the column-limit unit case |
| R1 | `crosses` filter out of `cartonsBefore` | case 7 Σ over CROSS + CROSS2 (INTERNAL counted → clamp → 49/51) |
| R2 | `kg_sum` check out of `checkSums` | refusal case kg_sum |
| R3 | `cartons_partial` out | refusal case |
| R4 | `largestRemainder` → per-line `Math.round` in `paperLines` | the 333.333 unit case |
| R5 | lines join moved into `load` | case 13 kg |
| R6 | `saveTnved` (lot's own name) added to `setLineCodes` | case 10 memory rows |
| R7 | `mayReadReceipt` out of `compositionDoor` | case 3 scoped VED |
| R8 | places → «all pallets to the dominant line» | unit U6 / case 7 pallets |
| R9 | `seen_box_count` clause out of `isStale` | case 11 (b) |
| R10 | `paperCompositionsFor` reads live for a ticked truck | case 12 |
| R11 | `saveTnvedAction`'s product-row check out | case 10 `not_on_truck` |
| R12 | the stamp comparison out of the tick | case 12 stale stamp |
| R13 | `seatsPrefix` cumulative → per-truck `largestRemainder(n, cartons)` | unit U4 / case 7 Σ |
| R14 | separate-mode weights → kgUnits (no cᵢ) and zero-carton lines kept | unit «no separate row has cartons 0» / case 7 |
| R15 | agent portion per plan line instead of per lot | case 9 |
| R16 | `isPaperDocument` out of the save | case 2 `document_is_photo` |
| R17 | `rowKey` → `lotId` in `setCode` | e2e step 5 (the keyboard code stays empty) |
| R18 | the ABA token → a per-row counter restarting at 1 | case 4 |

The review of the build added (log: the session's `lot-redproofs.log`):

| # | Strip | Red |
|---|---|---|
| F1a | `truckSegments` ignores `frozenSegments` | unit «the freeze holds…» ×3; case 12d (after re-anchoring — see 12d) |
| F1b | the positions out of `paperStamp` | case 12d (stale stamp ticks) |
| F2a | the backfill joins nothing | case 12e |
| F2b | `frozen` ← `t.sent_to_agent_at IS NOT NULL` | case 12e (✅ names CROSS2 too) |
| F6 | the tick's truck row unlocked (copy before truck) | case 12f — a 40P01 after the 1 s deadlock timeout |
| F11 | the `isServerBehind` fallback out | case 12g |
| F3 | `pallet` keyed on owned pallets | unit «a lot on ANOTHER lot's pallet» |
| F5 | kinds counted by line id | case 13 (4, not 2) |
| F13 | thaw counts every row | case 12 audits (2, not 1) |
| F9 | the uuid shape check out / the clear unparsed | case 10 (22P02 / TypeError) |
| F4/F8 | UTC slice / the clear's refusal dropped | fence rule 9 |

A red proof that stays green is evidence about the fixture (#166) — re-anchor
and say so.

### 11.4 e2e — `tests/e2e/m9zzx-lot-tarkibi.spec.ts` (+ `lot-tarkibi-fixture.ts`)

Lexical order: after `m9zzw-yonalish.spec.ts`. Serial, 360 × 800 (the default
project). Fixture in the `partiya-nomi-fixture.ts` shape: `newRun()` marker
`LT<6 digits>`, `mint()` = client `LT…`, receipt at YW (confirmed,
`source_note` = marker), lot letter 'A' **«键盘LT<digits>»** (run-suffixed —
the demo GS777's «键盘» is in the memory, and a defect writing under the lot's
own name would be green there and would change shared configuration, #183)
**mixed dims** 100 cartons 1000.000 kg 2.5000 m³, 100 boxes in transit on a YW →
TAS1 truck `LTT-<digits>` with 100 `batch_departed` movements
(`generate_series`); the memory ROWS for the lot's key and «клавиатура»/«мышь»
captured. `cleanupEarlier()` clears dead runs by the client-code shape, in this
order: lots FIRST (the compositions cascade — the document FK is NO ACTION),
then the run's attachments through `purgeAttachment`-equivalent SQL + storage
delete so the bytes go too (finding R13-nit), then the rest.

1. **mint** (a test, not `beforeAll`).
2. **VED composes on the phone**: login `+998900000004`; open the receipt
   card; `lot-tarkib-open`; the document comes first — `tarkib-upload.
   setInputFiles({ name: 'packing.pdf', mimeType: 'application/pdf', buffer:
   Buffer.from('%PDF-1.4\n%%EOF\n') })`, the new chip is selected; type
   «Клавиатура» 50 kar 500 dona, «Мышь» 50 kar 1000 dona; `tarkib-per-carton`
   of line 1 reads «= 10»; `tarkib-prefill` → kg 500.000/500.000, m³
   1.2500/1.2500; type 600 in line 1's kg; `tarkib-remainder` reads the kg
   excess while m³ reads ✓; `tarkib-fill-kg` on line 2 → kg 400.000, m³
   untouched; `tarkib-remainder` reads «✓» for all three. Measure:
   `document.documentElement.clientWidth === 360` and `scrollWidth <= 360`
   (never `innerWidth`, #1241), every `tarkib-kg`/`tarkib-m3` box ≥ 120 px
   wide, `tarkib-remainder` and `tarkib-save` inside the viewport WHILE line 1's
   kg has focus (the sticky bar).
3. **Refused without a document, values kept**: deselect the chip;
   `tarkib-save` → `tarkib-error` shows the document sentence; line 2's
   `tarkib-name` still reads «Мышь» (#171). Re-select.
4. **Save**: `tarkib-save` → `tarkib-saved`; the editor closed; the read-only
   face lists both names; reload → still there.
5. **Bojxona tab**: `/batches/<id>/tnved` shows two `tnved-line-row`s and no
   «键盘LT…» product row; type `8471607000` on «Мышь» → **«Клавиатура»'s
   `tnved-line-code` is still empty** (R17, the blocker), save; the
   `receipt-docs` panel, opened, shows `packing.pdf`.
6. **The invoice**: `page.request.get('/api/batches/<id>/invoice')`, parsed
   with ExcelJS (`m9u-deal-money.spec.ts`): two rows «Клавиатура» / «Мышь»,
   brutto 600 / 400, places 50 / 50, «Мышь» carries 8471607000 and
   «Клавиатура» a blank ТНВЭД, unit «шт», no estimate note.
7. **The freeze**: press «📤 hujjat yuborildi» → ✅; the receipt card shows
   `tarkib-frozen` naming `LTT-…` and still offers `lot-tarkib-open`; change
   line 1's kg to 550 and line 2's to 450 → saves; the invoice still reads
   600 / 400; un-tick → the invoice reads 550 / 450.
8. **Not a warehouse door**: login YW operator `+998900000006` → the
   read-only face, no `lot-tarkib-open`. **The logist** `+998900000003` → sees
   `lot-tarkib-open` and the `LotEditForm` ⚠ line.
9. **Width at 768** (`page.setViewportSize({ width: 768, height: 1024 })` as
   the VED, editor open): `clientWidth === scrollWidth` (finding UX-grid).
10. **Cleanup — the FINAL TEST**: SQL delete of `lot_compositions` and
    `batch_sent_compositions` for the lot; `DELETE /api/attachments/<id>` as
    the VED (the uploader — removes the bytes too) → 200; SQL cleanup of
    movements, boxes, lot, receipt, client, truck (audit rows stay); prove
    nothing carries the marker AND the memory ROWS equal the ones captured at
    mint.

Before pushing: seed once, vitest, then Playwright without re-seeding (CI's
order); `pnpm typecheck` (footgun 6 — `TnvedProductRow` grew); `fuser -k
3000/tcp` before the e2e; run gates with `&&` and grep each gate's own failure
marker (#803). Screenshots at 360 × 800, 768 × 1024 and 1280 × 900 of the
editor (two lines, remainder ✓, the sticky bar over the keyboard area), the
read-only face, the 🔒 frozen line and the Bojxona tab's line rows — look at
them (#547). Open the invoice through a real spreadsheet render (LibreOffice
headless → PDF → look) once: notes and fills are only visible to a renderer.
Time `priceHistoryForLots` on `gsr_card_perf` before and after §6.

---

## 12. Deviations from the lead's decisions (each flagged, each reversible)

The four CHANGED decisions are at the top («⚠ Changed by the judge»). Smaller
deviations:

- **D1** Exact vs scaled is `n === box_count`, not «every live carton» (§2) —
  the lines must sum to today's single figure, which divides by `box_count`.
- **D2** The population uses `crossesBorderSql` (unknown country = crossing),
  not `docsPendingWhere`'s three-valued `NOT sameCountryLegSql`; the clamp
  catches the double count it can cause.
- **D3** `saveTnvedAction` gains `batchId`, the truck's card door, and refuses
  names that are not product rows of that truck.
- **D4** Invoice quantity = pieces with 'шт' when stated and ≥ 1 on the truck,
  else kg.
- **D5** The draft packing list collapses a composed lot's crate groups.
- **D6** «=» per field per line, «Karobka soniga qarab taqsimlash» and «Sklad
  o'lchoviga moslashtirish» — all person-pressed.
- **D7** A line code and a clear are never refused for papers (the freeze
  replaced the lock); on a ticked truck the line codes are read-only on the
  Bojxona tab.
- **D8** A printed line whose places compute to 0 prints «(часть места)».
- **D9** The read-only composition shows to every reader of the receipt card.
- **D10** The revision is a sequence token, not a counter.
- **D11** `/api/files/upload` asks the receipt read door for an existing
  `'receipt'` target.
- **D12** `clearComposition` is allowed on a voided prixod.

## 13. Open risks

1. **A lot that is ENTIRELY another good** (100 mice, typed «klaviatura»)
   cannot be fixed by the VED: a composition needs ≥ 2 lines and
   `ved_manager` holds no `receipts.edit`. The refusal sentence sends him to
   the logist. Ask the owner whether the VED should get a one-line «paper name».
2. **Line names are free text** with no zh key: a line meets the TNVED memory
   only through its Russian name, and the price history not at all.
3. **A sent truck stays as it was sent.** The mix found after the first part
   of a lot left (and was ticked) is declared correctly only on the later
   trucks; the first truck's customs got «klaviatura». Un-ticking re-opens its
   papers, and re-ticking stamps TODAY as the send date (the toggle has always
   written today — the original date is in the audit only). Stated to him.
4. **The tick's stamp** sees a composition saved after the page the VED
   downloaded from was drawn; a download from an OLDER page load than the one
   he ticks on is not seen.
5. **Partial trucks print estimates.** Cartons and pieces add up across a
   lot's crossing trucks; kg and m³ follow each truck's own single figure as
   today, so they add up only as well as those figures do. Customs weighs; the
   note says so.
6. **Places with pallets** are split by cartons and flagged; a customs officer
   counting pallets per good may disagree.
7. **The client still reads «klaviatura»** in the push, the cabinet and the
   bot (rule 1).
8. **The agent approval is not re-asked.** A plan file regenerated after a
   composition change shows the new contents with no new plan version.
9. **«1,200» kg reads 1.200** (comma = decimal for measures — the opposite of
   the calc's money rule). The live remainder makes a misread visible before
   save.
10. **The document predicate** keeps out the receive-time carton photos; a
    carton photo uploaded AFTER confirmation still qualifies (the audit names
    the file and the person). A JPG packing list attached at receive time has
    to be uploaded again.
11. **Unclaimed cargo** is allowed; its «document» may be a photo of the opened
    carton uploaded after confirmation — there is no client to ask.
12. **The AI assistant does not see compositions** (§1).
13. **Half-applied deploy**: the readers answer «no composition» and log; the
    price history read reports «failed» until the migration lands.
14. **The truck's own files are not offered** as the document: a client paper
    the VED filed on the Bojxona tab must be uploaded again onto each prixod
    (the sentence says where).

## Deliberately not built

A physical split (new letter, re-stickering) — his answer 6. Per-line client
prices, per-line costs or tannarx — 5a. Carton identity of any kind — 2c.
An AI-proposed composition (it would read the one keyboard photo). A link
from a composition line to a calc item (the receipt↔calc join stays at
receipt grain, DECISIONS #814). Notifications on save. Composition on the
pricing page, the stock screen, the cabinet or the bot. Copying a truck's file
onto a prixod.

The lead writes DECISIONS (from #1257) and the CHANGELOG entry; this file is
the spec only.

---

## Judge findings (2026-10-01)

Five lenses, 74 findings. Every one was checked against the tree at `2dfb056`
(journal tail re-read after `git fetch origin main`: idx 121, `when`
1785190000100, unchanged). **74 confirmed, 0 refuted** — several are
duplicates of one another across lenses (marked «= …»), and three were
confirmed against the spec as written but are now moot because the freeze
removed the code they were about (marked «moot»). The arithmetic claims were
re-run in node (Sainte-Laguë prefix: 2 000 random weight vectors, monotone and
exact at x = Σw; the 33/33/34, 1.45, 333.350 and pallet cases reproduced).

### Lens 1 — the customs papers

| # | Sev. | Verdict | Finding → what changed |
|---|---|---|---|
| P1 | defect | CONFIRMED | Separate-mode kg/pieces split independently of cartons (U7: «Мышь · 0 kar · 4.0 kg · 10 dona»). → §2: kg/m³/pieces weighted by cᵢ·kgᵢ/cartonsᵢ; a line with cᵢ = 0 is left off the truck's paper; unit «no separate row has cartons 0»; R14. **Changes decision 6.** |
| P2 | defect | CONFIRMED | Per-truck rounding does not add up across trucks (33/33/34 → 51/49; pieces 6 for 5). → §2: cumulative over the lot's crossing trucks in departure order, Sainte-Laguë prefix for cartons, cumulative pieces; `cartonsBefore`, `lotTrucksFor`; case 7 Σ; R13. **Changes decision 6.** |
| P3 | defect | CONFIRMED | Agent file per plan line; a lot has several lines per version (`load_plan_lines_version_lot_unique` = version, lot, crate). → §4: portion aggregated per lot, contents printed once on the lot's first row, labelled «весь план»; case 9; R15. |
| P4 | defect | CONFIRMED | All pallet places to the dominant line, unflagged; R8 could not go red on U3. → §2: places = largestRemainder(P, cᵢ), flagged `pallet`; U6 (4 pallets → 2/2) re-anchors R8. **Changes decision 6** (the pallet sentence). |
| P5 | defect | CONFIRMED | Scaled pieces 0 → quantity 0 «шт», J = 0. → §4: pieces < 1 on the truck → 'кг' + kg; U11. |
| P6 | nit | CONFIRMED | `toFixed` vs `Math.round` at .x5. → §4: every builder passes its OWN printed value; case 8 asserts the before/after sum. |
| P7 | nit | CONFIRMED | «In the exact case this IS the typed kg rounded» false at ties. → §2 reworded to «within 0.1 kg»; U12 pins the tie. |
| P8 | nit | CONFIRMED | Agent suffix has no code and no Chinese. → §4: the line's TNVED code in brackets; the Russian-name gap stated (§13.2). |
| P9 | nit | CONFIRMED | `DOC.partOfPlace` monolingual; «(часть места)» wrong for aralash boxes. → bilingual; `DOC.sameCartons` for the draft's aralash BOXES column. |
| P10 | nit | CONFIRMED | Draft footer kg/m³ must stay raw; tab carton basis mixed. → §4 states the raw footer; §5 keeps `boxCount` = lot's box_count on every row and labels line figures «shu mashinada». |

### Lens 2 — data model, migration, concurrency

| # | Sev. | Verdict | Finding → what changed |
|---|---|---|---|
| DM1 | defect | CONFIRMED | Truck FOR SHARE → lot vs count-load's lot → truck UPDATE: a deadlock (`count-load.ts:287-303`, `scanning/service.ts:349-350` read). → The freeze removed every truck lock from composition writes; lot `FOR NO KEY UPDATE`; the lock order stated against every door (§3); case 6(a) is the repro, now expected green. **Part of the decision-5 change.** |
| DM2 | defect | CONFIRMED | `rev` restarts at 1 after a clear (ABA). → §1: `rev bigint DEFAULT nextval('lot_composition_rev_seq')`, every write draws a new value; case 4; R18. |
| DM3 | defect | CONFIRMED | The lock orders commits; nothing tied the sent papers to a revision. → §5: the tick posts a stamp of the compositions at render; the freeze recomputes it in the same statement that copies them; `paper_moved`; case 12; R12. Residual window stated (§13.4). |
| DM4 | defect | CONFIRMED | Lot-grain composition + «carries or carried» lock traps every split lot. → The FREEZE (`batch_sent_compositions`): a ticked truck prints its frozen copy, later trucks the current one; no save is refused for papers. **Changes decision 5** (prominent box at the top). |
| DM5 | defect | CONFIRMED | `exec?: Db \| Tx` hides the function from the tx-pool fence (`tx-pool.test.ts:131-134, 208` read). → `exec: Db \| Tx = db` on `compositionsFor` and `paperCompositionsFor`; fence item 8. |
| DM6 | nit | CONFIRMED | Two-statement reader can tear; zero lines read as «mixed» and drop the lot from the invoice. → ONE statement with LATERAL `json_agg`; < 2 lines = no composition, logged. |
| DM7 | nit | CONFIRMED | Step 11's plain SELECT lets a delete slip → unmapped 23503. → `FOR KEY SHARE`, taken before the header (§3 step 7). = Access-4. |
| DM8 | nit | CONFIRMED | Void/annul race; a voided prixod's composition could never be cleared. → step 6 `lockReceiptShareNoWait` (exported from grow-lot.ts) + status re-read; `clearComposition` `requireConfirmed: false`. The «receipt FOR SHARE would deadlock with annul» half is moot: no truck lock remains. |
| DM9 | nit | CONFIRMED | `saveLineCodesAction` loses committed revs on a partial failure. → returns committed revs with the first refusal; entries grouped per lot into one `setLineCodes`. = UX-stuck. |
| DM10 | nit | CONFIRMED (superseded) | `papersSentFor`'s return type could not serve its callers. → replaced by `lotTrucksFor` returning `{ batchId, code, departedAt, createdAt, sentAt, crosses, n }`; every caller filters. |
| DM11 | nit | CONFIRMED | JS length vs `char_length`. → `parseDraft` counts code points; 23514 → `validation` as a belt. |

### Lens 3 — doors and access

| # | Sev. | Verdict | Finding → what changed |
|---|---|---|---|
| A1 | defect | CONFIRMED | Any `'receipt'` file passes — the wizard's carton photos are `'receipt'` attachments (`receive-wizard.tsx:637`), and the upload route checks no record for `'receipt'`. → `isPaperDocument` (kind 'file' or uploaded after confirmation) in the save and the chips; `document_is_photo`; the route asks `mayReadReceipt` for an existing receipt (D11); case 2; R16. **Changes decision 3.** |
| A2 | defect | CONFIRMED | = DM4 (split lot dead end). → the freeze. |
| A3 | defect | CONFIRMED (moot) | `IN ()` on an empty truck list → 42601. → no truck lock any more; `lotTrucksFor` and every `sql.join` IN guard the empty list. |
| A4 | nit | CONFIRMED | = DM7. |
| A5 | nit | CONFIRMED | `saveTnvedAction` asks no truck door (`tnved/actions.ts:98-121` read). → loads the truck, `mayOpenBatchCard`, `departed` derived server-side; case 10. |
| A6 | nit | CONFIRMED | «Prixod hujjatlari» lists file names of unreadable prixods. → `receiptsReadableBy` filter, links drawn only for readable receipts. |
| A7 | nit | CONFIRMED | `not_found` vs `forbidden` is an existence oracle. → a missing lot/receipt answers `forbidden`; `not_found` removed from the codes. |

### Lens 4 — readers and regressions

| # | Sev. | Verdict | Finding → what changed |
|---|---|---|---|
| R1 | blocker | CONFIRMED | Editor state keyed by `lotId` (`tnved-editor.tsx:38-40`); typing the mouse code writes the keyboard line. → `rowKey` for all per-row state; e2e step 5 asserts the other line stays empty; fence item 6; R17. |
| R2 | defect | CONFIRMED | «EXACTLY the taught list» fails on day one. → ALLOWED / MUST split (§9, §11.1 item 1). |
| R3 | defect | CONFIRMED | = DM2. |
| R4 | defect | CONFIRMED | D7's lock on line codes: un-tick/re-tick rewrites the send date; no locked state drawn. → the freeze: line codes never refused; a ticked truck's line rows read-only with `tnved.lineFrozen`; the re-stamp stated (§13.3). |
| R5 | defect | CONFIRMED | Memory checks counted rows; `saveTnved` upserts. → row snapshots `(key, code, updated_at)`; run-suffixed «键盘<SFX>» in both fixtures. |
| R6 | defect | CONFIRMED | Case 12 unreachable: `pricePairs` private, needs a charge. → `pricePairs` exported as a commented seam; the fixture mints a charge and the final test deletes it. |
| R7 | defect | CONFIRMED | Integration cleanup left an in-transit truck and cartons. → case 16, the final cleanup test. |
| R8 | nit | CONFIRMED | `boxCount` would mean two things. → product rows keep `lot.boxCount`; line figures are separate fields labelled «shu mashinada». |
| R9 | nit | CONFIRMED | Composing removes the memory code from the invoice. → stated in §9's consequences; the Bojxona 💡 offers the code. |
| R10 | nit | CONFIRMED | 🤖 count includes line rows. → counts product rows only. = UX-🤖. |
| R11 | nit | CONFIRMED | `members` referenced twice → materialised under a 1.5 s ceiling. → §6 requires the `gsr_card_perf` measurement and names the fallback. |
| R12 | nit | CONFIRMED | Existing fences pin the editor's props, the 🤖 call, `aboardFilter`, `boxCount 7`. → named in §11.1; the design keeps each pinned shape. |
| R13 | nit | CONFIRMED | The new file input skips #759's reset. → `addDocument` + `value = ''`; joins photo-inputs' FILES. |
| R14 | nit | CONFIRMED | `cleanupEarlier` order hits the NO ACTION FK; bytes left. → lots first, then attachments with their bytes. |
| R15 | nit | CONFIRMED | « · » inside an audit line collides with `formatAuditValue`'s separator. → «Name — 50 kar, 500 шт, …». |

### Lens 5 — the person at the screen

| # | Sev. | Verdict | Finding → what changed |
|---|---|---|---|
| U1 | blocker | CONFIRMED | = R1. |
| U2 | defect | CONFIRMED | The 7-track grid overflows 768-1000 px (485 px of card at 768). → stacked blocks below `xl`, flexible `minmax` tracks at `xl`; e2e step 9 measures 768. |
| U3 | defect | CONFIRMED | Exact sums vs the client's paper (450 + 450 vs a scale's 1000). → «Sklad o'lchoviga moslashtirish» (`scaleToLot`), named in the kg/m³ sentences; decision 2 kept. |
| U4 | defect | CONFIRMED | The remainder is off-screen while typing on a phone. → sticky bar with per-measure signs. |
| U5 | defect | CONFIRMED | «dona» ambiguous (per carton vs total). → «Jami dona (hammasi)» + live «= N dona/karobka». |
| U6 | defect | CONFIRMED | `parseTypedMoney` reads «2,125» m³ as 2125. → own measure parser, comma = decimal (§2); risk 9 states «1,200» kg. |
| U7 | defect | CONFIRMED | Chips and «Hujjatlar» never see each other's uploads (`attachments-panel.tsx:44` local state). → `router.refresh()` after an upload, the card's panel keyed on its file ids, merge by id. |
| U8 | defect | CONFIRMED | Save during an upload says «no document». → `uploading` state, local `tarkib.uploading`. |
| U9 | defect | CONFIRMED | Double tap refuses the person's own save. → buttons disabled while pending; `composition_changed_self` when the saver is the same actor. |
| U10 | defect | CONFIRMED | = DM2. |
| U11 | defect | CONFIRMED | «(xotiraga)» / «avtomatik to'ldiriladi» false for line codes (`messages/uz.json` read). → `tnved.lineSaved`, the suffix only for product rows. |
| U12 | defect | CONFIRMED | = R10. |
| U13 | defect | CONFIRMED | `cartonsText` built in Uzbek on the server. → numbers on the row, `t('lineOnTruck' / 'lineMixed')` with pieces. |
| U14 | defect | CONFIRMED | Editor stuck after a partial save; `useState(initial)` never re-seeds. → committed revs returned; `<TnvedEditor key={editorKey}>`; «🔄 Yangilash». |
| U15 | defect | CONFIRMED | The VED retypes the same line code on every truck. → `tnvedHintsFor` also reads the newest stated line code by name (read-only; never the memory). |
| U16 | nit | CONFIRMED | Document last; a phone loses typed lines leaving for the PDF. → document first; per-lot `localStorage` draft in try/catch. |
| U17 | nit | CONFIRMED | The truck's files are not offered. → the sentence says where the file must live; copying stated as not built (§13.14). |
| U18 | nit | CONFIRMED | The VED cannot remove a wrong upload. → ✕ on the actor's own uncited chips. |
| U19 | nit | CONFIRMED | `bad_number` names no field. → `field` on the refusal, one key per field, the input ringed. |
| U20 | nit | CONFIRMED | Locked line inputs drawn editable. → frozen rows read-only. |
| U21 | nit | CONFIRMED (moot) | `lot_changed` for «a truck took cartons». → that check (old step 9) no longer exists. |
| U22 | nit | CONFIRMED | No way back to the truck; the chip does not open the editor. → `?tarkib=&from=` and «← Bojxona · LTT-…». |
| U23 | nit | CONFIRMED | The receipt card's 💡 has no data source. → dropped from the receipt card. |
| U24 | nit | CONFIRMED | Aralash shifts columns; «=» and 💡 have no column. → `invisible` cartons cell; a `col-span-full` second row. |
| U25 | nit | CONFIRMED | «= qoldiq» fills kg AND m³. → one «=» per field. |
| U26 | nit | CONFIRMED | The keyboard photo beside «Мышь». → photo on the lot's first line row only. |
| U27 | nit | CONFIRMED | The editor stays open; `LotEditForm` silent about a composition; no logist e2e. → closes on ✅; the ⚠ line; e2e step 8 as the logist. |
| U28 | nit | CONFIRMED | `in_use` tells a skladchi to do what he cannot. → reworded. |
| U29 | nit | CONFIRMED | «Prixod hujjatlari» unfolded and unfiltered. → collapsed `Panel` with a count badge, `receiptsReadableBy`. = A6. |
| U30 | nit | CONFIRMED | The History line unreadable. → = R15; neutral «шт». |
| U31 | nit | CONFIRMED (moot) | `papers_sent` sentence says how to unlock, not what follows. → the code is gone; `tarkib.frozenInfo` carries the re-send instruction. |

### Changes to the lead's fixed decisions, in one list

1. **Decision 5**: lock → freeze at the tick + the tick's stamp
   (DM1, DM3, DM4, A2).
2. **Decision 6**: per-truck proportional rounding → cumulative per-lot
   allocation; separate-mode figures follow the line's cartons on the truck;
   zero-carton lines left off a truck's paper; pallet places split by cartons
   and flagged; pieces 0 → kg (P1, P2, P4, P5).
3. **Decision 3**: the document must be a paper document (not a
   receive-time carton photo); `'receipt'` uploads ask the read door (A1).
4. **Decision 8**: no TNVED row for a line not on the truck; `boxCount` keeps
   its meaning; frozen line rows read-only (P1, P10, R8, R4).
5. **Decision 11**, scope only: three tables and a sequence, all denied to
   `gsr_ai_reader`; the revision is a sequence token (DM2).

## Review of the build (2026-10-01)

Four lenses over the 12 commits; every finding re-verified in the code
before it was touched. Defects, all fixed and red-proven (§11.3):

- **The freeze held the lines, not the offset** (three lenses). A split
  lot's lines are allocated cumulatively over its trucks, and the offset was
  recomputed live: a sent truck's invoice moved when a sibling departed first
  or was re-counted. Now the tick freezes the POSITIONS (`segments`), the
  other trucks fill around them (`lotSegments`), the stamp hashes them. The
  §2 sentence «it did so before this round too» was false and is corrected.
- **Trucks ticked before 0122 were not frozen** (three lenses): the backfill
  in 0122; the frozen-truck lists read the copy, not `sent_to_agent_at`.
- **The tick could deadlock an unload press**: the truck doors' lock order;
  a wait that runs out is a sentence.
- **A half-applied deploy made the tick an error page**: the plain toggle.

Nits fixed: another lot's pallet flags the places; kinds by name; the save
day in Tashkent; the two silent refusals; forged ids; the un-tick's audit;
the e2e's paths.

Not fixed here, for the lead: DECISIONS (from #1257), the Uzbek CHANGELOG
and CLAUDE.md's row and ledger line (123); and four things that are the
owner's to decide or to be told — «шт» rows beside «кг» rows on one invoice
(D4), the beyond-ask changes (§6's price-history kinds, D3's `not_on_truck`,
D11's upload door), composed rows carrying no Chinese name on the papers the
Chinese side builds from (7a), and that a composition's kg/m³ are fitted to
the warehouse's weighing rather than the client's own figures. `paperMoved`
still names no lots: the stamp is a hash, so naming the changed lots needs
the page to post the pairs.

Stated edges of the positions: a ticked truck whose OWN cartons change after
the tick prints its frozen runs trimmed or extended to its new count
(`fitSegments`; an extension past the lot's end is the old clamp); a ticked
truck later CANCELLED leaves the population, and the trucks after it fill
its positions.
