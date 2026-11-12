# AI so‘raydi va to‘ldiradi — the AI door names goods from a picture, reads «cbm», derives the cube from carton sizes, and asks for what is missing

**Status: DESIGN v4 — JUDGED** (2026-11-12). v3 was judged by four lenses before any package was built: 104
objections (22 blockers), none refuted. **docs/AI-SORAYDI-REVIEW.md holds every one with the lead's ruling, and a
ruling there is BINDING: it overrides the item of this document it names.** Read the two together — an item
below is what was designed, its rulings are what is built. Numbering starts at DECISIONS #1697. **No migration**
(ledger stays 146): what would have needed one (a plain-text wait after the AI's answer) left the round.

The round is THREE RELEASES, each shippable alone (§3): **1a** the readers and the words of the AI's answer,
**1b** the table and the pictures, **2** the writes after the pass. The kernel of §2 is the lead's and is
committed before any package.

## 0. His report and his answers

His report, 2026-11-11, the evening he deployed «Fayl o‘qish» (docs/FAYL-OQISH.md):

> «Yana o‘xshamadi. Ya’ni ma’lumotlarni tashlayapman, rasm misol uchun — unda nima tovar borligini bila
> olmayapti, va "cbm" degan yozuvni o‘qiy olmayapti, razmerlari berilgan bo‘lsa hajmni o‘zi chiqara olmayapti.
> AI barcha ma’lumotlarni olib rastamojkani hisoblab berishi kerak; buning uchun sistemada barcha kerakli
> narsalar bor, yoki yetishmayotgan narsa bo‘lsa, AI rastamojka bilan hisoblatayotgan bo‘lsa, so‘rasin va
> to‘ldirsin ma’lumotni.»

Four questions were put to him with ⭐ defaults; he answered **«1 d / Qolgani sen aytganingdek»**:

1. **d** — the picture may be anything: the goods themselves, a photographed document, a screenshot.
2. **a** — goods on a picture: the AI names them from the picture, the row is marked «📷 rasmdan taxmin», and the
   count and weight are asked of the seller.
3. **a** — a carton's size and the carton count: the bot computes the cube itself and writes «hisoblangan».
4. **a** — something missing for the calculation: the AI asks every question in ONE message, the seller writes,
   the table is filled, and when all is there it calculates.

Answer 4 REVERSES docs/IKKI-ESHIK.md §3.5 (his 4a/5a of 2026-11-08, «Tasdiqlash is the last question») **for the AI
door only**; the plain door («🧮 Hisoblatish») keeps it, and a NULL-door request (the card form, the thread, the
AI sotuvchi, anything from before 0141) keeps today's words exactly (JR-13).

**Two more earlier answers are touched, and both are said to him rather than built in silence** (JS-5, JS-20):
- docs/SAKKIZ-R3.md §0.1(2), his ⭐ of its Question 3 — «the add door never writes a price, a rate, a zone or a
  certificate». Letting the seller change the CERTIFICATE after the calculation (A7) moves the additional duty;
  it is question 9 of §7 and is **not built before his answer**. A seller's words appended to a stored row's
  note (A5) is question 10.
- docs/IKKI-ESHIK.md 1a of 2026-11-08 — «no question per file». A photo's good that an Excel does not list is
  offered with ONE question for the whole reading (M1), the single exception, said in question 3.

## 1. What the diagnosis found

Nine scenarios traced through the real handler chain with a scripted model (no API key here), files under the
session scratchpad `dg2/trace-*.json`: photo-goods (PG-1…10), photo-doc (dg2-1…12), typed-cbm (dg3-01…11),
dims (DIM-1…11), excel-cbm (XLS-1…11), asks-before (AB-1…14), pass-after, mixed-pile, prompt-audit, and a critic.
The ids below are theirs.

The four sentences of his report, and what stands behind each:

| His words | What happens | Ids |
|---|---|---|
| «rasm … nima tovar borligini bila olmayapti» | The model is told every picture is paperwork and «лучше пустой список, чем придуманный»: a product photo gives `goods: []` → «Tovarlar (0)», and the seller's typed answer naming the goods is refused («jadvalda bunday qator yo‘q») | PG-1, PG-2, PG-3, AB-5 |
| «"cbm" degan yozuvni o‘qiy olmayapti» | THREE unit vocabularies: the row kernel (`units.ts`) knows cbm/kgs, the shipment-totals reader (`parseManualFacts`) knows only kub/куб/m3 and kg/кг, so «5.9 cbm» as the answer to the bot's own cube question is refused, a typed totals line is not read, and with the model silent it becomes a PRODUCT «MEAS — 5.92 m³» | dg2-1, dg3-02…06, DIM-5, AB-3, dg2-10 |
| «razmerlari berilgan bo‘lsa hajmni o‘zi chiqara olmayapti» | No carton arithmetic exists in `wms/calc` or `wms/deals` (the AI sotuvchi's `cargo_volume` tool has had its own since 0138 — CR-4); the prompt forbids it («null, не умножай»); the schema has no place for cartons, a size, a per-carton cube or weight; a size typed as an answer is refused — or WRITTEN INTO THE PIECE COLUMN («1: 60*40*50 15 kg» → 50 dona) | DIM-1…3, dg2-2, dg3-10, AB-4, XLS-4, XLS-5 |
| «so‘rasin va to‘ldirsin» | After «✅ Tasdiqlash» the AI door asks nothing by design (`noAsk`): «… kiritilmagan — VED xodimi sizdan so‘raydi», «hozircha hisoblab bo‘lmadi». Before it, the unit the law wants is unknown until the row is coded, the model has no channel for its own questions, and a wrong row cannot be renamed or removed | PG-4, PG-5, PG-7, AB-6…9 |

And beside them, WRONG NUMBERS landing under «✅ Ma’lumot to‘liq» today (none of them reported by him, all of them
on this path):

- a per-carton weight or cube typed in a caption («har biri 15 kg», «15 kg/ctn», «1 karobka 0.12 kub») becomes the
  SHIPMENT's total and outranks the model's correct reading — dg2-4, dg3-01, DIM-4, AB-1;
- «2: 20 karobka x 12 juft» writes 12 juft — AB-2;
- Excel: «PKGS» is read as the line's WEIGHT (the `kg` inside the word) — XLS-3; an unmarked per-carton «CBM» /
  «G.W.» column lands as the line's and Σ comes out 15-21× small — XLS-1, XLS-2, DIM-8; «Volume (cm3)» is read as
  m³ — XLS-10; «Karobka soni» lands as pieces — XLS-9;
- the model writing ONE carton's cube into the row's volume lands unchecked — dg2-5, DIM-9;
- totals the AI read off a photo are dropped beside two Excel files while its own note states them — dg2-3, dg3-07;
- **a number standing before a three-digit weight is welded into its thousands** — «…60x40x50 300kg» is read
  50 300 kg, «GS777 300 kg» 777 300 kg, «stul 20 300 kg» 20 300 kg — under ✅, over the model's correct 300, and
  the pass prices it (≈ $34 936 for a ≈ $239 job) — MP-1;
- a forwarded supplier line «毛重 15kg/箱» lands ONE carton's 15 kg as the shipment's and the row's weight — MP-2;
  read without the model, the weight LINE becomes a product «毛重 /箱 — 15 kg» — MP-3;
- after the pass, the AI's answer numbers its lines by GROUP while an answer is addressed by the row's number: the
  seller answers «2: 300 dona» to what he sees as line 2 and ANOTHER row's count is overwritten (10 → 300) — PA-3.

## 2. The kernel (written by the lead first; BINDING for every package)

### 2.1 The structured-output budget — why the new fields carry no `null`

The reading's answer is a strict JSON schema (`output_config.format`). The API allows **at most 16 parameters
with a union type** across a request's strict schemas (a `["number","null"]` type array counts) and **24 optional
parameters**; past either it answers **HTTP 400 «Schema is too complex for compilation»** — for EVERY reading.
`FACTS_JSON_SCHEMA` already spends **12** unions (5 top-level, 7 on a good). So:

- **every new field is non-nullable and required**: a number says «not stated» as `0`, a word as an enum member
  (`'unknown'`), a list as `[]`. No new union, no optional parameter.
- `tests/unit/intake-schema-budget.test.ts` walks the schema the request SENDS and asserts unions ≤ 16 and
  optional = 0, so the next field somebody adds as `['number','null']` is red before it reaches production.
- **A fallback, because no key exists here and the first real call is in production**: a 400 whose message
  names the schema (`/schema/i` with `/complex|compil|invalid/i`) makes `streamAttempt` retry ONCE with the
  LEGACY contract (today's schema and prompt, kept as `FACTS_JSON_SCHEMA_V1` / `SYSTEM_V1`) and latch it for the
  process, logging `[calc intake] schema refused — legacy contract`. Production then degrades to today's
  reading instead of failing every one. The zod reader accepts both answers (new keys `.optional()`).

### 2.2 The model's contract (`wms/calc/intake-ai.ts`) — as built, after the prompt audit (PR-1…PR-15)

**Every figure has ONE home.** On a good, in the answer's order (all required; the twelve nullable keys are
today's, every new key is non-nullable):

| Key | Type | «not stated» | Meaning |
|---|---|---|---|
| `name` | string | — | Russian, the original in brackets |
| `name_source` | enum `document` \| `picture` | — | `picture`: the name is what the model SEES on a photo of the goods |
| `photo` | integer | 0 | the picture («Фото N») the good is seen or written on |
| `quantity`, `weight_kg`, `volume_m3` | number \| null | null | the LINE's totals, only when written |
| `weight_kind` | enum `net` \| `gross` \| `unknown` | `unknown` | which weight the line's is — «brutto» is then said by CODE |
| `unit` + `measure_qty` | enum `m2` \| `juft` \| `litr` \| null | null | the second measure and nothing else — pieces, kilos, cubes and cartons have their own keys (PR-3) |
| `packing` | array of 0 or 1 objects | `[]` | what is written PER PACKAGE / PER PIECE — below |
| `tnved_code`, `code_sure` | string \| null, boolean | — | the best code always; false = a guess |
| `note` | string \| null | null | LAST on purpose: a cut answer keeps a good only once its «}» closed |

A packing object: `cartons`, `pieces_per_carton`, `carton_weight_kg`, `carton_weight_kind` (`gross` \| `net` \|
`unknown`), `carton_volume_m3`, `l`, `w`, `h`, `size_unit` (`cm` \| `mm` \| `m` \| `unknown`), **`size_of`**
(`package` \| `product` \| `unknown` — WHOSE size it is, PR-12), `piece_weight_kg` (MP-11); numbers 0 and words
`unknown` when not stated. An ARRAY so that a good with no packing costs «"packing":[]» to write, not eleven
zeros: under flat keys a 300-row document was cut at ~40 % of the rows it completes today (PR-10). More than one
object (cartons of several sizes): the bot multiplies NOTHING and says so on the row.

Top level, in order: `from_city`, `to_city`, `weight_kg`, `weight_netto`, `volume_m3`, `goods`, **`questions`**,
`steps`, `known_codes`. `questions` (≤ 5, the most important first) are `{ n, kind, text }` — `n` the row in THIS
answer's `goods` (1-based; 0 = the shipment), `text` one short question in Uzbek (Latin) with the figure it is
about, **`kind`** one of `what_goods` · `material` · `size_unit` · `size_of` · `per_or_total` · `which_row` ·
`other`, each with ONE consumer (§3.3 M4). They stand right after the goods so a cut in the long tail keeps them
(`salvageCut`).

The prompt (`SYSTEM`, Russian) is the audit's text. What it removes — the suppressors the audit counted in
production: «фото накладных» as the only kind of photo, «читай фото» as the last word of the request, «лучше
пустой список, чем придуманный», «коды только там, где уверен; иначе null» three times, «null, не умножай» with
the factor thrown away, a second home for a cube («или measure_qty + unit "m3"»), not one word about a size, a
question or a per-package figure. What it says instead:

1. **Pictures are numbered and of two kinds** («Фото 1», «Фото 2»… — a text block before each image). A document
   is READ; the goods themselves are LOOKED AT and named concretely, what they are made of and for into `note`
   (≤ 100 characters — the pass's coder reads the note), `name_source: "picture"`, no figure guessed; closed
   unlabelled cartons are a `what_goods` question.
2. **The model copies, the bot multiplies** — and adds nothing up: a shipment total only when the total is
   WRITTEN («строки сам не складывай»).
3. **Whose size**: `package` (CTN SIZE, 外箱尺寸, a size beside a carton count, a load that ships unpacked) or
   `product` (a size in the name or on a marketplace card); unclear → `unknown` and a `size_of` question. A column
   headed just «CBM» / «G.W.» whose figure may be one carton's or the line's → written and asked,
   `per_or_total`.
4. **A marketplace card describes ONE piece**: its weight is `piece_weight_kg`, its size the product's; **MOQ,
   起批量 and price tiers are not the ordered count** (`quantity` null).
5. **A code always, with its doubt**: `code_sure` true only when the code does not hang on something unseen
   (material, sex, purpose) — else false and a `material` question.
6. **Ask** — but not for what the bot asks by itself (a missing count, weight, cube, the shipment's brutto), nor
   for a better file.
7. **Typed against the document**: the DOCUMENT's figure goes in the field, both are named in `steps`, the bot
   compares (T5) — the old «бери из документа» silently overruled the seller.

The user turn: «Фото N:» labels; the files-only closing is «Посмотри фото и документы: документ прочитай, товар
на фото назови.» The two NETTO lines are unchanged.

`aiGoodsLine` maps `packing[0]` into `CalcGoodsFact.packing` (§2.3, `from: 'ai'`, the size with its owner),
`name_source` / `photo` into `nameFrom: 'photo'` / `photoNo`, `code_sure: false` into `tnvedSure: false`,
`weight_kind` into `weightKind`; enum words are folded on read. `questions` rides `AiIntakeResult.questions`
(whole and cut readings alike). A legacy-shaped `unit: "karobka"` + `measure_qty` is still folded into
`packing.cartons` — never again the note «sotuvchi: N karobka» (dg2-12). `provenanceNote` (intake.ts) renders,
from the row each time: the source's note · «nomi rasmdan (AI taxmini), 2-rasm» · «TNVED kodi AI taxmini — aniq
emas, tekshiring» · «og‘irlik brutto (netto yozilmagan)» · the packing as stated · every computed figure with its
arithmetic.

**The legacy latch** fires only on a 400 whose message names the schema («Schema is too complex», an unsupported
keyword under `output_config.format`) — a 400 about another field (`output_config.effort`) no longer loses the
packing for the life of the process (PR-14).

### 2.3 Carton arithmetic — ONE pure module, `wms/calc/carton-math.ts`

No reader multiplies by itself. Every reader fills a `Packing` and calls the same function.

```ts
export type SizeUnit = 'cm' | 'mm' | 'm';
export interface BareSize { l: number; w: number; h: number; unit: SizeUnit | null }
export interface CartonSize extends BareSize { of: 'package' | 'product' | null }   // WHOSE size — required
export interface Packing {
  cartons: number | null;            // packages of THIS line — whole, 1…100 000
  pcsPerCarton: number | null;
  kgPerCarton: number | null;
  kgPerCartonKind: 'gross' | 'net' | null;
  m3PerCarton: number | null;
  size: CartonSize | null;           // ONE package's outer size
  kgPerPiece?: number | null;        // ONE PIECE's weight (MP-11) — × the row's pieces
  from: 'ai' | 'file' | 'typed';     // who stated it — worded on the note
}
export interface Derived { value: number; how: string }   // how: «20 × 0.12 m³», «20 × 60×40×50 sm»
```

- `parseSize(text)` — a size token: 3 numbers (or 2, never used for a cube) joined by `x х × *` (Latin and
  Cyrillic, either case), spaces allowed around the joiner, an optional unit after the last number or after each
  («60x40x50 sm», «60*40*50см», «600×400×500 mm», «0.6 x 0.4 x 0.5 m», «L60 W40 H50 cm»). Returns the size and
  the span it occupies. `/` is NOT a joiner (dates, fractions, «3000pcs/15ctns»).
- `sizeCube(size)` — m³ of one package. Unit stated → exact. **Unit absent → `cm` is assumed only when every
  side is within 5…300** (a carton written 60×40×50 is centimetres in this trade), and the result says
  `assumed: true` so every surface prints «sm deb olindi»; otherwise `null` (the unit is asked).
- `cartonFigures(p)` — `volumeM3 = cartons × (m3PerCarton ?? sizeCube)`, `weightKg = cartons × kgPerCarton`
  (kind carried), `quantity = cartons × pcsPerCarton`; each a `Derived` or null. A per-carton cube that disagrees
  with the size's by more than 5 % keeps the STATED cube and the note says both.
- `judgeStated(stated, derived, perCarton, cartons)` → `'fill'` (nothing stated) · `'agrees'` (within 2 %) ·
  `'one_carton'` (cartons > 1 and the stated figure equals ONE carton's within 2 %) · `'differs'`.
- `applyPacking(good)` — the one door. For volume, weight and pieces in turn: `fill` → the derived figure is
  written and `good.derived[field] = how`; `agrees` → nothing; `one_carton` → the stated figure is REPLACED by
  the product and the note says so («hajm bitta karobkaniki edi: 0.12 × 20 = 2.4 m³»); `differs` → the stated
  figure stays and a `doubt` is returned for the table to ask. Rounding: m³ and kg to 3 places, half-up, after the
  multiplication.
- **Whose size it is** (PR-12). `CartonSize.of` is REQUIRED so every reader says how it knows: a carton word or
  a «CTN SIZE» header, the model's `size_of`, the bot's own cube question being answered. **Only a PACKAGE's size
  is multiplied by the packages.** A product's own size («Стол 120×80×75, 10 коробок») computes nothing;
  `productCubeOffer(line)` gives pieces × the product's cube as an OFFER («200×150×180 sm × 1 dona = 5.4 m³ — yuk
  shu o‘lchamda ketadimi?») that the table asks and never writes by itself; an owner nobody stated beside a carton
  count is asked (`sizeOwnerUnknown`), never multiplied.
- **One piece's weight** (MP-11): `kgPerPiece × the row's pieces` (stated, or just computed from the cartons)
  fills an EMPTY row weight, said «hisoblangan: 200 × 4.5 kg»; a carton's own weight outranks it; ONE piece's
  weight standing as the row's (pieces > 1) is replaced like a carton's; a stated weight the pieces do not explain
  is a doubt. No pieces yet → no weight: the count is asked and its answer computes it (`applyPacking` re-runs).
- **Weight kinds.** The ROW's weight is netto (customs). `kgPerCartonKind: 'net'` → the row's weight.
  `'gross'` or unknown → the row's weight when it has none (noted «brutto», the reading's existing rule), and the
  row's gross product is kept in `derived.grossKg` for the shipment's brutto: when EVERY row has one, their Σ is
  offered as the shipment's brutto, labelled «(karobkalardan)».
- **Where it is safe, and where it asks** (DIM-11): ONE size + ONE whole carton count on the same row/segment,
  the size being the PACKAGE's (said so by a word — karobka/ctn/carton/quti/коробка/место/箱/外箱/упаковка — by
  its column header, by a model's packing key, or because the text is an answer to the bot's cube question).
  NOT safe → no figure, a question: a size with no unit outside 5…300; a carton range («C/NO 1-20»); two sizes or
  two counts on one row; a size inside a product NAME with no carton count («Stol 120x80x100 sm 5 dona», «Kafel
  600x600») — that stays in the name, as today.

`CalcGoodsFact` gains `packing?: Packing | null`, `derived?: { volumeM3?: string; weightKg?: string; quantity?:
string; grossKg?: Derived } | null`, `nameFrom?: 'photo' | null`, `tnvedSure?: boolean`. They live in the
collection's JSON state and on the model's facts; **the landing writes figures into the columns that exist and
the arithmetic into the row's `note`** («📦 20 karobka × 60×40×50 sm = 2.4 m³ (hisoblangan)», «📷 nomi rasmdan
(AI taxmini)») — no column, no migration, and the VED reads on the row how each figure came to be.

### 2.4 ONE unit vocabulary

`units.ts` `WORDS` is the list. It gains the forms people answered with and no reader knew: m³ — «кбм», «куба»,
«кубов», «кубометр», «кубометра», «кубометров», «kubometr», «kubov», «cum», «cu.m», «cubic meter(s)»; kg —
«кило», «килограмма», «килограммов», «kilogramm» (already), «kgs» (already), «公斤» (already). It exports
`unitPattern(unit)` (a regex alternation, longest first, dots and spaces tolerated) and the label words of a
totals line: `WEIGHT_LABELS` («g.w.», «gw», «g/w», «gross», «gross weight», «brutto», «брутто», «вес брутто»,
«og‘irlik», «вес», «毛重», «总毛重»), `NET_LABELS` («n.w.», «nw», «n/w», «net», «netto», «нетто», «净重»),
`VOLUME_LABELS` («cbm», «meas», «meas.», «measurement», «volume», «vol», «cube», «hajm», «hajmi», «kub», «объём»,
«объем», «体积», «总体积», «方数»). `parseManualFacts`, `readTotals` (line-address.ts) and `TOTALS_UNIT`
(totals-shape.ts) read through them — their own lists are DELETED. It also holds the FIELD LABELS of a supplier's
spec block, in the scripts they arrive in (MP-3): name — «品名», «货名», «名称», «product», «item», «description»,
«наименование», «товар», «nomi»; count — «数量», «qty», «quantity», «кол-во», «количество», «soni»; cartons —
«箱数», «件数», «ctns», «cartons», «мест», «коробок», «karobka»; size — «尺寸», «外箱尺寸», «箱规», «size», «carton
size», «размер», «габариты», «o‘lchami»; and the per-package tails «/箱», «/件», «/ctn», «/carton», «/кор»,
«/место», «/karobka», «/pc», «/шт», «/dona» (`PER_PACKAGE_TAIL`, `PER_PIECE_TAIL`). Fence: `tests/unit/unit-vocabulary.test.ts`
asserts every kg and m³ word of `WORDS` is read as a shipment total by `parseManualFacts` and as an answer by
`parseTableAnswer`.

## 3. The packages

**The rulings of docs/AI-SORAYDI-REVIEW.md override the items below.** A builder reads its package's items
here AND every ruling that names them (the review's ids are cited per release beneath); where the two differ,
the ruling is what is built.

### 3.0 Three releases, seven packages (JB-15)

| Release | Packages (two at a time, each in its own worktree on the previous merge) | What it closes |
|---|---|---|
| **K** | the lead: `carton-math.ts`, `units.ts`, the contract and its freeze, the note renderer at the landing, the asks interface and its minimal draw, the state fields | every «K» ruling |
| **1a** | **P-typed-A** «readers» (T0-T4 reader halves, T6's masking and owner rule, T8, T12, T14, T16) ∥ **P-excel** (X0-X8, X10's data flag); then **P-ask-A** «words» (A1-A3, A6, A9, A10, A12) | «cbm»; the welded thousands; per-package figures as totals; «PKGS» as kilos; shifted columns; per-carton columns; the AI door asks again after «✅», by the row's own number |
| **1b** | **P-typed-B** «table answers» (T5-T7 applied, T9-T11, T13, T15) ∥ **P-pictures** (M8-M15, M17); then **P-model-A** «table» (M1-M5, M7, M16, M18, X9-X11's asks, the buttons) | a product photo's rows corrected and answered at the table; the model's questions with buttons; the pictures' plumbing |
| **2** | **P-ask-B** «writes» (A4, A5, A8, A11; A7 only on his answer) | the one-step reply; a file filling an empty cell |

Release 1a's table is the KERNEL's minimal draw: a computed figure carries its mark and a legend line, a doubt
of the arithmetic is a ⚠️ line that withholds «Ma’lumot to‘liq» and is answered by typing the figure, a
picture-named row is marked 📷, the model's questions are listed by the good's NAME with no writing control.
Buttons, offers and the row grammar are 1b's.

**The corpus, up front** (JR-20). Cases that MOVE, each with its reason in `intake-corpus-known.ts`'s style:
c1935 (L|W|H under «MEAS (CM)» + CTNS — the cube is computed), c3101 / c2469 / c2470 (a carton column pinned
as quantity + unit → `packing.cartons`), c1357 (a code beside goods at the customer question — 1b). **Decided
by the lead: c0649 («Kurtka 45 karobka») stays no row** — a carton count with no other figure and no size
names nothing a table can price, and #24's rule stands. Guards that MUST stay green through T0 / T3 / T4 / T7
/ X5: c0298, c0302, c0731, c0732, c0958, c0962, c0986, c1548-c1551, c1556, c0715, c0718, c0957, c0961, c0982,
c1557 (spaced TNVED and phone digits); c0690-c0693, c0695, c0696, c0872, c0926, c0927, c1529, c2071, c2073,
c2804, c2806 (box words as products); c0873, c0874 («Total» the brand); c3072 (the belt). New case ids:
c3000+ typed, c3400+ sheets, c3700+ model, c4000+ ask.

**Gates every package runs before it reports** (JB-19): `pnpm typecheck` (exit code read, never through a
pipe) and lint on its files; the whole intake corpus; the kernel's tests (carton-math, unit-vocabulary,
intake-schema-budget, intake-contract-fallback, intake-contract-frozen); intake-holds-wire, press-fence,
tx-pool, ai-advisory, intake-items-wire; plus its own list in its task. **The plain door's guard files are
FROZEN** (JB-17): `git diff <base>..HEAD -- tests/unit/calc-plain-door.test.ts
tests/integration/calc-plain-door.integration.test.ts` is empty at every merge. Each report lists every pin it
re-anchored and why. Only the merged tree proves: CI's order on a fresh database, the diagnosis's traces end to
end, the ledger.

### 3.1 P-typed — typed text and table answers (`intake-manual.ts`, `units.ts`, `line-address.ts`, `totals-shape.ts`, the refusal words in `calc-dialog.ts`)

**T0. A number is not welded onto its neighbour** (MP-1 — the first thing built). `parseManualFacts`' number is
«1-3 digits, then groups of three after ONE space» so that «1 200 kg» is 1200; its look-behind lets the first
group begin right after `x` / `х` / `×` / `*` / a letter. So before the totals are read, in this order: (1) size
tokens are taken out (`parseSize`, §2.3 — kept for T6); (2) a client code (the company prefix + digits, as
`parseClientHint` reads it) and a model number glued to letters («XJ-200», «iPhone 15») are masked; (3) **a
space-grouped number is thousands only when nothing number-like stands glued or one space to its left** — after a
digit group that is not part of it, after `x х × *`, after a code, the LAST group alone is read and the existing
`AmbiguousTotal` is raised («50 300 kg — 300 kgmi yoki 50 300 kgmi?»). The same guard in `units.ts` `AMOUNT`
(«1: 60*40*50 300» is never 50 300). The thirty spellings of the trace go into the corpus with the answers:
welded — «…60x40x50 300kg» → 300 (asked when «50 300» is possible), «GS777 300 kg» → 300, «stul 20 300 kg» →
ambiguous, «iPhone 15 128 kg» → 128; untouched — «1 200 kg», «12 500 kg», «jami 1 200 kg 5 kub»,
«…x50 sm 300 kg», «…x50, 300 kg», «…x50 1200 kg». The thread door and the AI sotuvchi call the same function —
their existing tests run in the package's gate.

**T1. Totals in the trade's words.** `parseManualFacts` reads, as the shipment's: «5 cbm», «5.92 CBM», «5,9
cbm», «5.9cbm», «CBM: 5.92», «MEAS: 5.92 CBM», «hajmi 5 cbm», «5 кбм», «5 куба», «12 кубов», «507 kgs»,
«507kgs», «G.W. 507 KGS», «G.W.: 507», «gross 507 kg», «N.W. 480 KGS» (netto, by its label), «毛重 507kg 体积
5.92立方», and both figures of «TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM». Label-first forms («CBM: 5.92»,
«G.W.: 507») are read only with a LABEL of §2.4 — a bare «5.92» is no cube. The existing rules stand: one
distinct figure per field or it is ambiguous; a goods line's own figure is not the shipment's; netto never stands
for a freight brutto.

**T2. Both figures of one answer.** `readTotals` returns every field the segment states: «507 kg 5.9 cbm» writes
both; a figure it could read and did not place is a refusal naming it, never a silent drop (dg3-03).

**T3. A unit word is never a product.** A segment that is «number + a word» where the word is no unit and names
no row is asked as a unit («“kubov” — kubmi? «5.9 kub» deb yozing») — never «jadvalda bunday qator yo‘q», never
filed as material (dg3-04). `NOT_GOODS_WORDS` gains: meas, meas., measurement, vol, vol., volume, cube, cubic,
cbm, kgs, pkgs, pkg, packages, package, ctns, g.w., n.w., gw, nw, gross, net, total, dim, dims, size — so with the
model silent «MEAS: 5.92 CBM» and «G.W. 1136.5 kg CBM 7.19» are totals lines, not rows (dg3-05, dg2-10, DIM-10).

**T4. Per-package figures are not totals** (DIM-4, AB-1, dg2-4, dg3-01). A weight, cube or count is PER PACKAGE
when it is marked so: followed by «/ctn», «/karobka», «/кор», «/箱», «per ctn», «per carton», «dan» («15 kg
dan»); preceded by «har biri», «har bir», «har birida», «har karobkada», «bitta karobka», «1 karobka», «one
carton», «each», «каждая», «каждый», «в коробке», «1 место»; or written «N karobka × 15 kg» / «20 x 15 kg» /
«20 * 24 dona». Such a figure never reaches `totalWeightFrom`, `loneWeightKg` or a row's own column. With a
carton count on the same line it is a `Packing` (`from: 'typed'`) and `applyPacking` computes the product,
labelled; without one the bot asks «nechta karobka?».

**T5. Typed against read.** When the typed total and the model's (or a file's) total for the same field both
exist and differ by more than 2 %, neither lands: the table asks «⚠️ Og‘irlik: siz 15 kg yozdingiz, AI hujjatdan
300 kg o‘qidi — qaysi biri?» with one button per figure (the existing totals-doubt machinery, `asked(field)`).
«Typed wins» stays only when the two agree or one is absent.

**T6. Sizes.** `parseGoodsLine` and `readSegment` take a size token (§2.3 `parseSize`) OUT before the amount
reader runs — a dimension is never a count (DIM-3: «1: 60*40*50 15 kg» wrote 50 dona; «1: 600*600 120 m2» wrote
600 dona · 600120 m²). Then:
- a size + a carton count in a typed GOODS line → that row's `Packing`;
- as the answer to the open cube question, un-addressed: «60x40x50 sm 20 karobka» → the shipment's cube through
  the carton math, echoed with its arithmetic («✍️ umumiy hajm — 2.4 m³ (20 × 60×40×50 sm)»), ↩️ as any answer;
- addressed, «1: 60x40x50 sm 20 karobka» → row 1's packing, its cube computed;
- a size with no carton count → «⚠️ 60×40×50 sm — nechta karobka? «60x40x50 sm 20 karobka» deb yozing»;
- the ✍️ hint under an open cube gains «yoki karobka o‘lchami: «60x40x50 sm 20 karobka»».

**T7. Cartons × per-carton in an answer** (AB-2, AB-9): «2: 20 karobka x 12 juft», «2: 20 karobka har birida 12
juft», «1: 20x24 dona», «1: 20 karobka 24 dona dan» → the product, echoed «20 × 12 = 240 juft». The per-carton
number is never written as the row's. «1: 20 karobka» alone on a row with no pieces: the carton count is kept on
the row's packing and the bot asks «1-qator: bir karobkada nechta dona?».

**T8. The typed goods reader keeps a line it half-understands** (dg3-09, second): `unitFigures` skips separators (` - `,
`–`, `/` between figure groups) and field labels; a figure with «/ctn» goes to the packing, never to the line's
own column; a line whose tail holds an unknown unit stays a NAMED row with a note, instead of vanishing and
leaving its lone «kg» to be taken as the shipment's.

**T9. A table with no row takes the goods** (PG-2, AB-5). On the AI door, while the table has zero rows, a typed
text that is not a totals answer is read by the typed goods reader: rows found → written to the table at once
(no model call), echoed with ↩️; nothing readable → filed as material and the reading re-queued, saying so. The
«3: 50 dona» example is never printed on a table with no row; every example is built from the first open row
(AB-13), and on a ONE-row table an un-addressed count/weight/code goes to that row.

**T10. Correcting a row** (PG-7, AB-7): «N: nomi <name>» renames row N (on a `nameFrom: 'photo'` row any
«N: <name> <figures>» does — the photo's guess is the seller's to overrule); «N: o‘chir» / «N: yo‘q» / «N: удали»
removes it; «N: <words>» with no figure and no rename word appends the words to the row's note (material,
purpose — what decides a code) and marks the row for re-coding at the pass. Words beside a figure never cost the
figure. All three ride the echo and ↩️ the table has.

**T11. Small (second).** «sertifikat bor / yo‘q» typed at the table flips the toggle (AB-12). A number with a currency
word («2500 $», «5 usd», «so‘m», «¥») is never offered as pieces or kilos: «💵 narxni VED xodimi qo‘yadi —
bojxona bazasi bo‘yicha hisoblanadi» (AB-10).

**T12. A supplier's spec block is ONE good** (MP-3, MP-2). With the model silent, `typedGoods` reads a
field-per-line block — a NAME label of §2.4 opens it («品名 折叠椅», «Product: folding chair», «Наименование:
…»); the count / cartons / weight / size lines under it, until the next name label or a blank line, are ITS
figures and packing — never rows of their own. A line that is a label of §2.4 plus a figure («毛重 15kg/箱»,
«G.W.: 15 kg/ctn», «Вес брутто 15 кг/место», «Carton size: 60*40*50cm», «20箱») is never a goods line, with or
without a colon; the same block on ONE line reads the same way. The figure with a per-package tail goes to the
packing (T4) and the product is the kernel's.

**T13. The client's code inside a caption** (MP-10, second). At the customer question a goods-shaped text or
caption that opens or closes with a client code found in the book («GS777 stul 20 karobka …») gives BOTH: the
customer = the code, the material = the rest. The reading's request names it («Клиент: GS777 — код клиента, не
часть названия товара») so no row is called «Стул GS777».

**T14. The cube's siblings** (CR-7). A TONNE and a gram are units: «t», «т», «тн», «тонн*», «tonna», «ton(s)»,
«mt», «吨» → kilos × 1000; «g», «gr», «г», «гр», «克» → ÷ 1000 — through `routeAmount`, echoed with the conversion
(«2 t = 2000 kg»), under the vocabulary fence of §2.4 (a scaled unit is a word of `kg` with a factor, never a
unit of its own). A weight written the packing-list way — «1,136.5 kg», «12,500.00» (comma groups AND a decimal
point) — is ONE number and never asked «1.136 mi yoki 1136 mi?»; an apostrophe between digit groups («1'200») is
a separator.

**T15. A link is not material** (CR-6). A line that is only a URL is answered at arrival «🔗 Havolani ocha
olmayman — sahifa skrinshotini (FAYL qilib) yoki tovar nomi, soni, og‘irligini yozing», kept on the card for the
VED, not counted as material and never sent to the model alone; inside a longer line the address is masked
before the typed readers and the name echo run (the page id was read as the count: 712 345 678 901 pieces), and
the table's refusal stops repeating an address four times.

**T16. The other doors read with the same readers** (CR-4). `parseManualFacts` is also the AI sotuvchi's
(`agent/context.ts`) and the thread door's: the customer's «…60x40x50 300kg» is 50 300 kg to the agent today, and
since «o‘zi yuborish» a tool-priced reply may go with no press. So this package's gate runs the agent's two
policy corpora (62 + 303, DECISIONS #1619) and its tool tests, and the agent's `cargo_volume` tool computes
through `carton-math.ts` — a fence refuses any other «÷ 1 000 000» / «× 1e-6» of sides in `src/modules/wms`.

### 3.2 P-excel — the column reader (`deals/goods-import.ts`, `goods-file.ts`, `telegram/file-goods.ts`)

**X0. A sheet handed to the model keeps its columns** (CR-1 — the first thing built). `rowLine` joins only the
NON-empty cells, so an empty cell gives up its position and every later figure slides left under the header: a
TOTAL row whose N.W. is empty is sent «TOTAL | 660 | 35 | 530 | 3.6» — the cube under «G.W.», the CBM column
empty; a quotation with pictures in column A is shifted in EVERY row. An empty or merge-covered cell between a
row's first and last filled cell stays an empty slot («Office chair | 120 | 10 |  | 150 | 1.2»); a column empty
in EVERY row (the picture column) is dropped from the header line too; pinned: every data line has the header's
cell count. Lands before X8, which hands more sheets to the model as text.

**X1. «PKGS» is not kilos** (XLS-3): `kg`/`кг` match as a unit WORD (`(?<![\p{L}])kgs?(?![\p{L}])`), never as a
substring; a package-count header is never a weight candidate.

**X2. The row keeps its packages.** `GoodsRow` gains `packing` (§2.3, `from: 'file'`): the carton count from a
package column («CTNS», «CTN», «Cartons», «PKGS», «箱数», «件数» only beside a piece column, «Мест», «Mesta»,
«Karobka soni», «Joy soni», «Korobka»), one vocabulary for the rank and the lone-column rule — a package header
is never the PIECE column (XLS-9); per-carton cube and weight from the PER_PACKAGE columns that are today passed
over («CBM/CTN», «单箱体积», «Объем 1 места», «G.W./CTN», «N.W./CTN», «毛重/箱», …), and per-carton pieces
(«PCS/CTN», «装箱数», «шт/кор»).

**X3. The size column** (XLS-5, DIM-6): a `cartonSize` column kind — headers «Carton size», «CTN SIZE», «Size
(cm)» beside a package column, «MEAS (CM)», «Dimensions», «L*W*H», «外箱尺寸», «箱规», «尺寸», «Размер коробки»,
«Габариты», «O‘lchami (sm)»; or an L | W | H triplet (Длина/Ширина/Высота, 长/宽/高); unit from the header or the
cell. «MEAS.» whose cells are sizes is a size column, not a cube.

**X4. The arithmetic is the kernel's**: every row with a packing goes through `applyPacking`. The line's own
figure, when the sheet states it, stands; a per-carton figure fills only what is empty (XLS-4, DIM-7).

**X5. An unmarked per-carton column** (XLS-1, XLS-2, DIM-8). The volume column is chosen as the weight is: among
volume-keyed, non-per-package columns, the largest Σ (never the leftmost); the volume gets its own per-package
words (ctn/carton before cbm, 外箱/箱 before 体积, коробк/кор./мест, quti/karobka + hajm/kub). The TOTAL-row belt
runs over every volume- and weight-keyed column. When a column's Σ contradicts the sheet's own TOTAL row: if
Σ(value × cartons) agrees with it (2 %), the column IS per carton — line = value × cartons through the kernel,
said on the file's note; if nothing explains it, the LINE figures are nulled too (kept on the note), so no later
Σ resurrects a refused number. `judgeStated`'s `one_carton` catches the same on a sheet with a size column.

**X6. A header's own unit** (XLS-10, second): «Volume (cm3)», «体积(cm³)», «Объем, л», «Hajmi (litr)», «дм3» convert
(cm³ ÷ 1e6, dm³/l ÷ 1000) on BOTH rungs; a unit the reader cannot convert refuses the column.

**X7. Headers nobody mapped** (XLS-7, XLS-8): cube «方数», «总方数», «CUBE», «Cubic meter», «Cubage», «CU.M»,
«CMB», «CUBM» (and a cube header is never money); weight «GW», «NW», «G/W», «N/W», «T.W», «Масса», «Massa»,
«总重», «公斤» — GW/NW as whole words in the gross and net key lists.

**X8. The TOTAL row as the total** (XLS-6): when a figure's Σ is null (a line lacks it) the grand-total row's
cell in the mapped gross / volume column is the sheet's total; a summary line «TOTAL: 60 CTNS / G.W. 710 KGS /
3.8 CBM» is read by the kernel's totals reader (§3.1 T1). An invoice-shaped lone sheet's text (with its total
rows) is handed to the model under the totals heading, as a packing sheet's already is.

**X9. The table says what the file gave** (XLS-11, second): computed figures are marked «(hisoblangan)»; when ONE factor
is missing the question names it («1-qator: karobka o‘lchami 60×40×50 sm bor — nechta karobka?»).

**X10. Goods that are PICTURES beside an article number** (CR-3 — the commonest Chinese quotation: «Picture |
Item No. | QTY | CTNS | G.W. | CBM»). Today the rows are named «XJ-200», the pictures are never looked at, and
the table says «✅ Ma’lumot to‘liq». *First:* a mapped sheet keeps its picture count; when its name cells are
article-shaped (the reader's own `isCodeCell` / not a word cell) the rows are marked `nameIsArticle`, the table
asks each («1-qator «XJ-200» — bu nima?», answered by T10's rename) and holds «Ma’lumot to‘liq»; with pictures in
the book it says so («Excel ichidagi rasmlar o‘qilmaydi — tovar nomini yozing yoki rasmni alohida yuboring»).
*Second:* the row-anchored pictures (`worksheet.getImages()` → the row, `workbook.media` → the bytes) are sent to
the model labelled «Строка N», counted against the twelve, and the model names those rows through
`known_codes[].name`; such a row is drawn 📷.

**X11. A price list is not an order** (CR-8, second). A sheet with a price or MOQ column and NO quantity column is
a `catalogue`: its rows are candidates, the table asks «Narxnoma: qaysi tovarlar, nechtadan? «XJ-200 300 dona»»
and only the rows named are kept. The article stays on the row («1. Folding chair (XJ-200)»), is sent to the model
and accepted as an address by `parseTableAnswer` and `pickGoods`.

### 3.3 P-model — the reading's consumers (`intake-ai.ts` mapping, `calc-intake.ts` merge, the table in `intake.ts` / `calc-dialog.ts`, `calc-files.ts` images, `reading-whole.ts`)

**M1. 📷 rows** (PG-1, PG-6). A `nameFrom: 'photo'` row is drawn «📷 1. Стул офисный — rasmdan (AI taxmini)» and
owes its figures like any row (the law's unit when coded, else «soni (dona) yoki sof og‘irligi (kg)»). Its note
on landing says «nomi rasmdan (AI taxmini)». Beside an Excel a photo's good the sheet does not carry is OFFERED
as a row («➕ Rasmdagi «Обувь детская» ni qo‘shish» / «✖️ Kerak emas») instead of a note under «Ma’lumot to‘liq»
(dg2-7); while the offer stands the closing is not «to‘liq».

**M2. Zero rows from pictures** (PG-3): when only photos were accepted and no row came back, the table closes
with the bot's own question — «❓ Rasmda nima tovar? Nomi, soni va og‘irligini yozing — masalan: «Stul 20 dona
300 kg»» — and the model's `questions` under it; the keyboard keeps «➕ Yana ma’lumot» and «👤 VED hisoblasin».
The answer is P-typed's T9.

**M3. The packing reaches the rows.** `aiGoodsLine` → `packing` → `applyPacking` (§2.3). The table prints a
derived figure with its arithmetic: «2.4 m³ (hisoblangan: 20 × 60×40×50 sm)», «300 kg (20 × 15 kg, brutto)»,
«480 dona (20 × 24)», and the carton count itself («📦 20 karobka») — which is the model's, never «sotuvchi:»
(dg2-12, AB-9). A `one_carton` replacement is said; a `differs` doubt is a ⚠️ question with two buttons. A
density outside 20…1500 kg/m³ over the whole job (Σ kg ÷ Σ m³, both present) draws «⚠️ hajm yoki og‘irlik
shubhali: 4 920 kg/m³ — bitta karobkaniki emasmi?» and holds «Ma’lumot to‘liq» until answered (dg2-5).

**M4. The model's questions, each by its kind** (AB-6, PR-11): kept in the collection's state
(`IntakeState.aiQuestions`, durable like `steps`; an answered one is struck) and drawn as a block «🤖 AI
so‘raydi:» with addresses, uncut, at most five. `what_goods` → the bot's own M2 question, answered by the typed
goods reader (T9); `material` → «N: <words>» appended to the row's note and the row re-coded (T10, A5);
`size_unit` → «sm / mm / m» sets the size's unit and the arithmetic re-runs; `size_of` → two buttons [📦 karobka
o‘lchami] [🪑 tovarning o‘zi]; `per_or_total` → two buttons [bitta karobkaniki] [hammasiniki] — «bitta» moves the
figure into the packing and recomputes; `which_row` → an ordinary addressed answer; `other` → shown as written,
the answer appended to the note. An unanswered `what_goods` holds «✅»; the other kinds do not — unanswered they
land on the lenta for the VED («AI so‘ragan, javob berilmagan: …») and in the pass's ❓ block (A2). `steps` stays
what the model DID.

**M5. Totals the AI read are asked, not dropped** (dg2-3, dg3-07). Where the fold gate (`foldNoTotals`) withholds
the model's totals, and the model was shown something other than sheets (a photo, a PDF, typed text), the table
shows them as a question: «🤖 AI o‘qidi: 1 136.5 kg · 7.19 m³ — butun yuk uchunmi?» [✅ Ha, butun yuk] [✍️ Yo‘q,
o‘zim yozaman]. «Ha» writes them as the totals answer (the seller's statement, worded «AI o‘qidi, sotuvchi
tasdiqladi»). Never the AI's own total as a note beside «yozilmagan».

**M6. Figures for rows an Excel already holds** (dg2-6) — `known_figures` beside `known_codes`: `{ n, weight_kg,
volume_m3, cartons }` with 0 = not stated, applied like `packingFills`: only into EMPTY cells of the numbered
row, each marked «rasmdan». *(Second priority: built if the first five land clean; else stated in §6.)*

**M7. Customs-only totals** (dg2-8, AB-14, dg3-11, second): on «Faqat rastamojka» the shipment's weight is the rows' Σ
when every row has one, labelled «(qatorlardan)», as the cube already is; the two totals are drawn ℹ️ («upsale
hisobi uchun») and no longer hold «✅ Ma’lumot to‘liq» — they are still asked, still landed when given.
*(His call — question 2 of §7; ⭐ = as written here.)*

**M8. The picture the model gets** (PG-9, dg2-9): `MODEL_IMAGE_PX` 1568 → **2576** (claude-opus-5's limit; a
3.75 MP cap; JPEG quality 88; a JPEG that already fits passes untouched). One line in the «Qabul qilindi» prompt
when a photo arrived as a Telegram photo (≤ 1280 px): «🔎 Mayda yozuvli hujjat bo‘lsa — FAYL qilib yuboring (📎 →
Fayl), shunda AI aniqroq o‘qiydi». The 15 MB refusal stops advising the opposite.

**M9. Small (second).** The settled prompt's «✅ Bo‘ldi» is taken off when the table is delivered, and a press with
nothing new redraws the table instead of paying for the same reading (PG-10). The model-sized copy of a photo is
accepted only when non-empty and ending in the JPEG end marker; the local storage driver writes through a temp
name (dg2-11). `[calc intake]` logs the goods count, the picture-named count and the question count of every
reading — the line his server's log could not answer this week.

**M10. A caption stays with its picture** (MP-5). Today the model gets every image, then every caption and typed
line as one block — «bunisi 12 kg» points at nothing. The collection keeps, beside `material[]`, a parallel
`materialFrom[]` (`{ photo: n } | { after: n } | { forwarded: true } | null`, optional — an old state has none
and reads as today), written by ONE helper (`pushMaterial(state, text, from)`; a fence finds every writer of
`material`). The request then says which is which: a text block «Фото 1:» before each image, and the material
rendered «Подпись к фото 2: …», «Текст после фото 3: …», «Переслано: …» — for the MODEL only; the typed readers
keep reading the stored strings. A row the model names from a picture carries the picture's number, and the table
says «📷 2-rasm».

**M11. A long screenshot is cut into tiles** (MP-6, second). A picture taller than 2.2 × its width (a 1688 /
Taobao / WeChat scroll capture — 1080×9000 reaches the model as a 188-pixel strip today) is cut into full-width
tiles (each ≤ `MODEL_IMAGE_PX` tall, 5 % overlap), sent as consecutive image blocks under one «Фото N (части
1-k):» label and counted against the twelve; a Telegram PHOTO narrower than 500 px after the client's own cut is
told «Skrinshotni FAYL qilib yuboring (📎 → Fayl)».

**M12. A scanned PDF's caps** (MP-7, second). Per file 10 MB → **20 MB** (Telegram's own bot limit), together
12 MB → **22 MB** with the photos in the same budget (the API takes 32 MB a request and 600 pages); over it the
refusal names the cure («sahifalarni rasm qilib yuboring yoki PDF ni siqing») and an all-refused answer draws
«👤 VED hisoblasin». `[calc intake]` logs the bytes and the seconds of every reading with a PDF in it.

**M13. A video's or a voice note's caption is material** (MP-8). Native video / voice / video_note / audio go
through the file door's refusal: the caption is taken as material, the file is named in `refusedFiles` by what it
is («video», «ovozli xabar», «dumaloq video», «audio»), the prompt is redrawn — never «Hali hech narsa
yuborilmadi» after a caption that named the goods.

**M14. Typed against the document, said by the bot** (MP-4). The prompt's «Если числа в разных местах расходятся,
бери из документа» goes: the model gives the DOCUMENT's figure in its field and the typed one is the sender's —
the merge decides (T5), and when the typed figure stands the table prints the bot's own line («matndagi 5.9 kub
olindi — hujjatda 5.92») instead of the model's sentence claiming the opposite.

**M15. The schema is compiled before a seller waits on it** (PR-14). There is no key where this is written: the
contract's first real request — and its grammar's first compilation — would otherwise run inside a seller's
150 s. When the reading worker registers, and once a day, ONE text-only request is made under the packing
contract (60 s, best-effort, billed to nobody's request): it compiles the grammar, and a schema refusal latches
the legacy contract THEN and raises the system alert (`system_errors`), with `[calc intake] contract warm:
ok | legacy | failed` in the log.

**M16. An unsure code has readers** (PR-13). `tnvedSure: false` is drawn «(AI taxmini — aniq emas)», the row is
asked BOTH its count and its weight (the guessed law's one unit may be the wrong law's), and the landed row's
note says so (`UNSURE_CODE_NOTE`). The pass does not re-code it — the reading saw the picture, the pass's coder
sees words — but lists it among the rows whose code the seller's description may still change (A5). Fence: every
writer of `tnvedSure` has a reader.

**M17. An edited message is said, not swallowed** (CR-5). Telegram delivers an edit as `edited_message`; the bot
subscribes to it and has no handler, so «30 kg» corrected to «300 kg» is calculated as 30 with a 👍 standing on
the corrected text. *First:* in a chat with a live collection an edit is answered once per message «✏️
Tahrirlangan xabar o‘qilmaydi — to‘g‘risini yangi xabar qilib yozing». *Second:* with M10's `materialFrom`
keeping the message id, the line is replaced / the table answer re-applied through the echo and ↩️.

**M18. A product's own size is offered, a size nobody owns is asked** (PR-12). `productCubeOffer` → «📐 200×150×180
sm × 1 dona = 5.4 m³ — yuk shu o‘lchamda ketadimi?» [✅ Ha] [📦 Yo‘q, qadoqlangan]; «Ha» writes the cube as the
seller's statement, with its arithmetic on the note. `sizeOwnerUnknown` → the `size_of` buttons of M4 even when
the model asked nothing.

### 3.4 P-ask — after «✅ Tasdiqlash» (`prefill.ts`, `ai-reply.ts`, `prefill-reply.ts`, `tail-words.ts`, `law-asks.ts`, the reply door `reply-door.ts` / `calc-amend.ts`, `wms/calc/amend.ts`)

What works today, end to end and door-blind (PA-1's trace): the AI's answer draws «➕ Shu so‘rovga qo‘shish»; a
swipe-reply to it opens the add table; «✅ Qo‘shish» → `amendRequest` → `saveTable` → the `amend:<id>` pass
re-runs past the mute and answers again. What is missing is the QUESTION, the right ADDRESS, and one step.

**A1. The AI door asks again** (PA-1). `noAsk` becomes `door === 'plain'`. On door `'ai'` the answer carries the
❓ block and the NULL door's seller tails («✍️ Shu xabarga reply qilib yozing: «3: 300 dona»») — never «VED xodimi
sizdan so‘raydi» about a figure only the seller has. `lentaUnasked` keeps saying it on the lenta when his copy
reached nobody.

**A2. The block asks everything the seller can give** (PA-2, PA-5, PA-8) — ONE list, `sellerAsksOf` (law-asks.ts,
pure), in row order:
- the law's pinned unit (`lawAsksOf`, as today): «3-qator «Куртка…»: soni (dona) — boj kamida $4/dona»;
- a row with **neither a count nor a weight** (`lineNeeds().anyMeasure`; the 📊 misses `no_measure` and
  `no_piece_weight`): «1-qator «Рюкзак школьный»: soni (dona) yoki sof og‘irligi (kg)» — today the refusal is
  `baza_missing` and the tail blames the VED, because the engine asks for the baza first and no baza can be
  chosen for a row with no figure;
- an **uncoded row**: «2-qator «Zapchast XJ-200»: bu nima — nimadan qilingan, nima uchun ishlatiladi?»;
- the shipment's brutto / cube when freight needs it (podklyuch), as the table asked it;
- the certificate, when nobody touched the toggle: «📄 Sertifikat bormi? («sertifikat yo‘q» deb yozing — hozir
  «bor» deb hisoblandi)».
What only the VED can give stays his, in its own block: a baza nobody found, a rate, a code the model could not
find AFTER the seller described the good.

**A3. The number in front of a line is the number an answer is addressed by** (PA-3 — built before A4). The
answer's lines are headed by their rows' `seq` — «3. Куртка…», «1-2. Посуда, Чашки» for a group of two rows —
never by the group's index; an uncoded row is listed in its place («2. Zapchast XJ-200 — kod yo‘q»), not under
the list. One numbering in the whole message: the ❓ block, the refusal lines («3-qator» is dropped where the
line already opens with 3) and the examples all use the row's number.

**A4. A reply fills and recalculates in ONE step** (PA-7, his 4a). A swipe-reply to the AI's answer that is
nothing but table answers (`parseTableAnswer` + T7/T10's forms + «sertifikat bor/yo‘q») is written through the
ONE writer (`amendRequest` → `saveTable`) and the pass re-runs past the mute, with one echo: «✍️ 3-qator — 300
dona yozildi. 🤖 AI qayta hisoblayapti…» and «↩️ Bekor qilish» on it. **The fence that makes one step safe**: it
writes at once only into an EMPTY cell of a row the answer ASKED about (`sellerAsksOf` of that answer, kept on
the notification's payload) — a replacement of a stated figure («10 → 300»), an unasked row, a new good or a
file opens the add table with its echo, exactly as today. The once-key is the reply message's own id; the
outcomes `waiting` / `to_ved` / `refused` are said in today's words.
*Second:* the same answer typed PLAINLY (no swipe) within 30 minutes of an asking answer is taken by a durable
one-text wait (`telegram_chat_waits`, kind `ai_answer`, armed by the drain when it delivers an answer that asks;
below every live collector, cleared by any door) — today «300 dona» is a failed search («Topilmadi. Mijoz
kodi…»).

**A5. Words on a row** (PA-5). «2: avtomobil tormoz kolodkasi, metall» on an uncoded (or `📷`) row is appended to
the row's note through `saveTable` and the row is re-coded by the pass — the coding model reads the note; a
seller does not know TN VED codes. *Second:* a re-run skips the coding call when no uncoded row changed since the
last one (the same words, the same answer, billed again today).

**A6. A coding call that failed says so** (PA-4). `aiPrefill` carries `proposeFailed` into the reply: «⚠️ AI kod
qo‘yishda javob bermadi — 🔄 bir ozdan keyin qayta urinib ko‘ring» — never «Kod topilmadi: Куртка мужская
зимняя — VED xodimi qo‘yadi» about a jacket; the grouping call is retried ONCE inside the pass when its clock
allows. The ➕ table promises «AI qayta hisoblaydi» only when something was added.

**A7. The certificate is the seller's fact** (PA-8, second). «sertifikat yo‘q» / «sertifikat bor» as a reply
writes `has_certificate` while the request is hands-off and re-runs — it changes no rate and no code. A code the
seller disputes on a row that HAS one stays the VED's, said so: «kod noto‘g‘ri deb o‘ylasangiz yozing — VED
ko‘radi» (as today, in clearer words).

**A8. A model's code with no law** (PA-10, second). A code the model proposed that finds no row in the book is
dropped back to «uncoded» (and so asked, A2) instead of minting a group nobody can price («bu kodga stavka
topilmadi — VED xodimi qo‘yadi»).

**A9. The words** (PA-11). The «Taxminiy» block names the missing figure from the refusing rows' own needs
(«3-qator: soni (dona)»), never one fixed «qatorda soni yoki og‘irligi yo‘q» about a row that has its weight; a
group label equal to its line's head is not printed twice.

**A10. What only the VED can give is said as his**, unchanged: a baza, a rate — «VED xodimi qo‘yadi».

**A11. The missing figure answered with a FILE fills the empty cell** (CR-2). Today a photo, PDF or Excel of the
packing list sent through «➕» after the pass fills nothing — «faylda 480 dona, so‘rovda son yo‘q — VED hal
qiladi … AI qayta hisoblamaydi»: his 1a of 2026-11-08 («the stored figure stands, the file's goes to the VED»)
is applied to a cell that holds NOTHING exactly as to one that differs. On an open request a read figure for a
stored row whose cell is EMPTY is a FILL — written by `amendRequest` → `saveTable` under the expect-null
compare-and-set it already has, echoed «✍️ 1-qator — 480 dona · 280 kg (fayldan)» with ↩️, and the pass re-runs.
Only a DIFFERING figure stays the VED's. An empty stored total the file states is asked with M5's two buttons.

**A12. The pass's two model calls** (PR-9). The pick still has the 4096-token trap — a cut answer is «baza yo‘q»,
silently — and neither call sets its effort: both get `max_tokens` 16 000, an explicit effort, a `max_tokens`
branch that NAMES the cut (A6's words) and `stop_details` in the log; the pick's listing gains the row's note
(«прим.: …» — what the reading saw on the picture), as the grouping's already has.

## 4. What stays as it is

- The plain door asks nothing and its pass is silent (IKKI-ESHIK §2).
- «The model proposes words and can never reach a number»: a figure the model READ is a fact with its source; a
  figure that is a PRODUCT is computed by `carton-math.ts` from fields the model read, and says so; no model
  output becomes a rate or a baza. `tests/unit/ai-advisory.test.ts` stands.
- One factory's Σ never stands as the shipment's (FAYL-OQISH §3.7) — M5 asks instead of landing.
- A carton count is never pieces; a per-carton figure is never the line's — both rules stay, and gain the
  multiplication that makes them useful.

## 5. Fences and proofs

- `intake-schema-budget.test.ts` (§2.1); `unit-vocabulary.test.ts` (§2.4); `carton-math.test.ts` (the safety
  rules of §2.3, each with its refusal); the corpus gains every input of the nine traces with the answer this
  document gives.
- Each finding is reproduced as a failing test BEFORE its fix (the skeptics' stage of the diagnosis was cut by
  the usage limit — the red proof is the verification), by string edit, restored by hash.
- The real model cannot be called here. The contract is proven against the SSE stand-in
  (`tests/fixtures/sse-anthropic.ts`) and the schema budget by a walk; the first real reading after the deploy is
  the proof, and §2.1's fallback is what happens if the API refuses the schema.

## 6. Stated, not built (v1)

- An invoice VALUE is not asked and prices nothing (customs here is baza × measure) — T11 only stops a «$»
  figure being offered as pieces.
- The model's names stay Russian; an Uzbek name answer finds a row only by a cognate (AB-11) — the row NUMBER is
  the address.
- A voice message and a video are refused in words (M13 keeps their captions); a link is answered at once that it
  cannot be opened (T15) — it used to be accepted in silence and paid for as a reading of an address.
- The thread door («Hisoblatishga yuborish» from a CRM chat) sends the model words and a file COUNT, never the
  customer's photo; the card form's attached files are read by nobody (CR-4) — said to him, not built.
- An iPhone's HEIC photo sent as a FILE is refused today («HEIC rasm, o‘qib bo‘lmaydi») — so M8's advice is
  worded «skrinshot yoki JPG qilib FAYL sifatida yuboring», and decoding HEIC on the server stays unbuilt.
- Photos past the twelfth are named, not read.
- The web card's «Hisoblatish» form and the thread door gain the typed readers' fixes (they share the kernel) but
  no questions loop.
- **`known_figures`** (M6 — figures a photo states for rows an Excel already holds) left the round (JN-19,
  JR-18): its entry had no per-carton home and no weight kind, so one carton's G.W. would have landed as a row's
  customs weight. The contract is frozen without it.
- **A plain text typed after the AI's answer** (A4's second half) needs a new kind of durable wait, which is a
  migration (JR-14, JB-5): it left the round. A swipe-reply is the door.
- **The seller changing the certificate after the calculation** (A7) waits on his answer to question 9.
- **Material dropped into the bot BEFORE a door is pressed** (MP-9): a photo or a PDF outside a collection gets
  no answer, a typed goods line goes to the question-answering assistant. An offer «[🤖 AI rastamojka]
  [🧮 Hisoblatish]» on such a burst is his question 5.
- **A code that came with the file is never second-guessed** (PA-6): a Chinese invoice's own 8-10 digit «HS CODE»
  that is not an Uzbek line ends in «baza yo‘q — VED xodimi qo‘yadi». Letting the AI complete it at the 6-digit
  heading is his question 6.
- **A per-piece declaration under a per-kg floor law** (PA-9) is not used for the 📊 estimate («deklaratsiyalar
  boshqa o‘lchovda») — a rule of 0094; his question 7.
- No frame is taken from a video and no voice note is transcribed (M13 keeps their captions).

## 7. Questions for him (sent in Uzbek, as below — JS-26, JS-27, JS-28)

The ⭐ is what is built until he answers; «hali yo‘q» marks an option that is not built and will be only on
his «ha».

1. Karobka o‘lchami birliksiz yozilsa («60x40x50»): a) ⭐ santimetr deb olaman va yoniga «sm deb olindi» deb
   yozaman (faqat ishonchli bo‘lsa — aks holda so‘rayman); b) har safar «sm mi, mm mi?» deb so‘rayman.
2. «Faqat rastamojka»da umumiy brutto va kub: a) ⭐ majburiy emas — yozilmasa ham «Ma’lumot to‘liq» chiqadi;
   b) hozirgidek ⚠️.
   2-b. Brutto yozilmasa, qatorlardagi NETTO yig‘indisini uning o‘rniga qo‘yaymi: a) ⭐ yo‘q, bo‘sh qolsin
   (sotuvchi ulushi shu raqamga bog‘liq); b) ha.
3. Rasmda Excel’da yo‘q tovar ko‘rinsa: a) ⭐ bitta savol — «qo‘shaymi?»; b) so‘ramay qo‘shaman
   (8-noyabrda «fayl uchun so‘ramasin» degansiz — bu yagona istisno).
4. AI javobiga «1: 150 kg» deb reply qilinsa: a) ⭐ darhol yozaman va qayta hisoblayman (faqat AI so‘ragan
   bo‘sh joyga); b) avval jadval, «✅ Qo‘shish»dan keyin.
5. Eshik bosilmasdan botga rasm yoki fayl tashlansa: a) ⭐ bot «🤖 AI rastamojka / 🧮 Hisoblatish» deb so‘raydi
   va yuborilganini oladi (hali yo‘q); b) hozirgidek javob bermaydi.
6. Xitoy invoysidagi «HS CODE» bizning TN VED’da bo‘lmasa (faqat birinchi 6 raqami mos): a) ⭐ AI bizdagi eng
   yaqin kodga to‘g‘rilaydi va «fayldagi kod … → … (AI taklifi)» deb yozadi (hali yo‘q); b) kod o‘zgarmaydi,
   VED to‘g‘rilaydi.
7. Boj kg bo‘yicha («kamida $0.4/kg»), bojxona bazasida esa shu tovar faqat DONA narxida bo‘lsa: a) AI taxminni
   dona narxidan chiqaradi va shuni yozadi (hali yo‘q); b) ⭐ hozirgidek — taxmin yo‘q, «VED xodimi qo‘yadi».
8. Sotuvchi savolga 30 daqiqadan KEYIN javob yozsa (zavod bir necha soatda javob beradi): a) ⭐ javob darhol
   olinadi (hali yo‘q); b) hozirgidek — ▶️ bosib, qayta yozadi.
9. Hisobdan keyin sotuvchi «sertifikat yo‘q» deb yozsa: a) o‘zi o‘zgartiradi, AI qayta hisoblaydi (qo‘shimcha
   boj qo‘shiladi) (hali yo‘q); b) ⭐ faqat VED o‘zgartiradi (oktyabrdagi javobingiz).
10. Hisobdan keyin sotuvchi qatorga izoh yozsa («2: metall, tormoz kolodkasi»): a) ⭐ izoh qatorga yoziladi, AI
    kodni qayta qo‘yadi; b) faqat VED ga xabar.
11. AI rasmdan qo‘ygan nomni sotuvchi tasdiqlashdan OLDIN o‘zgartirishi yoki qatorni o‘chirishi: a) ⭐ ha;
    b) faqat VED.

Said to him without a question: a photo sent as a FILE is read at about twice the cost and more exactly; the
AI sotuvchi now reads a customer's «…60x40x50 300kg» as 300 kg and hears «cbm / kgs».
