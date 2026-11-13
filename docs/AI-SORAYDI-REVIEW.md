# AI so‘raydi — the review of the design before code

docs/AI-SORAYDI.md (design v3) was judged by four independent lenses on 2026-11-12, before any package was
built: **104 objections — 22 blockers, 71 defects, 11 nits**. Every one is recorded here with the judge's own
evidence in short, its fix, and the lead's ruling. **A ruling is BINDING and overrides the item of the design it
names** (the design, v4, carries the same rule in its §3 header). Nothing was refuted: where two judges disagreed
the ruling says which stands.

The headline is that the lenses found the design's worst faults in the KERNEL the lead had already committed —
a carton printed «120*80*60MM» read as centimetres (1 000× the cube), the model's own figure silently multiplied
by its own carton count, a seller's corrected figure reverted by the next pass — and that the round as designed
was seven packages, not four. Hence three releases:

- **Kernel (K)** — the lead, before any package: the arithmetic's safety rules, the per-carton unit, the person's
  figure, the note renderer wired to the landing, the asks interface, the contract frozen.
- **Release 1a** — the readers (typed text, Excel) and the words of the AI's answer: what closes «cbm», the
  welded thousands, per-carton figures, shifted columns, and makes the AI door ask again after «✅».
- **Release 1b** — the table (answers, then the draw), the pictures' plumbing.
- **Release 2** — the writes after the pass (the one-step reply, a file filling an empty cell).

Ids: JN = numbers, JR = rules, JS = seller, JB = build. The ids the objections cite (PG-, DIM-, XLS-, AB-, PA-,
MP-, PR-, CR-) are the diagnosis's.


## Lens «numbers» — every path by which a wrong number could land under ✅

### JN-1 — blocker — §2.3 parseSize / sizeCube (kernel, committed) — feeds T6, T12, X3

**Objection.** A unit the parser does not recognise is silently «no unit», and then centimetres are assumed. The unit match is lower-case only and knows no bracketed or Chinese unit, no inch/ft/dm. So «120*80*60MM» — how a Chinese carton prints it — has every side inside 5…300 and 100 cartons become 57.6 m³ instead of 0.0576 (1000×), labelled «sm deb olindi». Inches read as cm are 16× small. Four joined numbers («20x60x40x50» = 20 cartons of 60×40×50) give the size 20×60×40.

**Evidence.** Ran parseSize/sizeCube/applyPacking: «120*80*60MM», «120х80х60ММ», «60*40*50CM», «60х40х50 СМ», «L60 W40 H50 CM», «60*40*50(cm)», «60*40*50厘米» → unit null, cm assumed; applyPacking(100 cartons, 120*80*60MM, of package) → volumeM3 57.6, assumedCm true. «23.6x15.7x19.7 inch» → 0.0073 m³ (true 0.119); «60x40x50 ft» → 0.12. «20x60x40x50» → sides [20,60,40], cube 0.048. carton-math.ts:130 (LEN lower-case), :137 (flag 'u' only), :241.

**The judge's fix.** parseSize: match the unit case-insensitively; read a unit in brackets and 厘米/公分/毫米/米. Look at the word right after the last side: letters there that are not a known cm/mm/m word (inch, in, ″, дюйм, ft, dm…) give `unit: 'other'` and sizeCube returns null (asked). Centimetres are assumed ONLY when nothing word-like follows the token. A fourth joined number is no size: null, asked. carton-math.test.ts gains each spelling above, each with its red proof.

**Ruling — kernel (the lead, before the packages).** Accepted. parseSize matches the unit case-insensitively, reads a bracketed unit and 厘米/公分/毫米/米; a word after the size that is no cm/mm/m word gives `unit: "other"` and no cube (asked). Centimetres are assumed only when nothing word-like follows. Four joined numbers are no size.

### JN-2 — blocker — §2.3 judgeStated `one_carton` + cartonFigures cubeClash; §2.2 point 3

**Objection.** `one_carton` fires on «stated = the per-carton figure, cartons > 1» and silently multiplies. That equality has two causes: the row holds one carton's figure, or the per-carton key holds the LINE's. The kernel always assumes the first. A model that writes an unmarked «G.W. 300» into both weight_kg and carton_weight_kg (or only the carton key) gets 20 × 300 = 6000 kg with no doubt. The cube too — even when the size proves the opposite: carton_volume_m3 2.4 with 20 cartons of 60×40×50 cm (20 × 0.12 = 2.4) gives 48 m³ and only a note.

**Evidence.** Ran: applyPacking({weightKg:300, cartons:20, kgPerCarton:300}) → weightKg 6000, replaced {weightKg:300}, doubts []. Row weight null → 6000 «20 × 300 kg». ({volumeM3:2.4, m3PerCarton:2.4, cartons:20}) → 48. ({m3PerCarton:2.4, size 60×40×50 cm, cartons:20}) → 48, cubeClash {stated 2.4, fromSize 0.12}, doubts []. carton-math.ts:283-287, :334, :439-442.

**The judge's fix.** (1) cartonFigures: when m3PerCarton ≈ cartons × sizeCube (2 %) and cartons > 1 the stated cube is the LINE's — used once, never multiplied, said on the note. (2) Any other cubeClash is a DOUBT (asked, holds ✅), not a note. (3) `one_carton` replaces without asking only with a second witness: a package size's cube, or `from: 'file'|'typed'` with a per-package mark. With `from: 'ai'` and no witness it is a doubt with two buttons [bitta karobkaniki → ×N] [qatorniki]. A test for each.

**Ruling — kernel (the lead, before the packages).** Accepted, with JR-5. A per-carton cube equal to cartons × the size's cube is the LINE's (used once). Any other clash between a stated per-carton cube and the size is a DOUBT. A `one_carton` replacement happens without a question only for `from: file | typed`; for `from: ai` it is a doubt.

### JN-3 — blocker — M4 `per_or_total`; the prompt's «запиши её в weight_kg / volume_m3»; M3

**Objection.** The prompt tells the model to put a figure it cannot place (an unmarked «CBM», «G.W.») into the ROW's weight_kg / volume_m3 and ask `per_or_total`. M4 says only `what_goods` holds «✅»; an unanswered `per_or_total` goes to the lenta. So a seller who ignores the question confirms one carton's 0.12 m³ / 15 kg as the line's — XLS-1 / dg2-5, the defect §1 lists — and the AI pass prices it. M3's density belt cannot see it when both columns are per carton (kg ÷ m³ is unchanged). And only five questions exist for a 30-row sheet.

**Evidence.** docs/AI-SORAYDI.md M4 («An unanswered what_goods holds «✅»; the other kinds do not»); intake-ai.ts:241-243 (the prompt), :337 (AI_QUESTIONS_MAX 5). With packing {cartons:20} and no per-carton figure cartonFigures returns no product, so judgeStated gives no verdict (carton-math.ts:331) — nothing else checks such a row.

**The judge's fix.** An unanswered `per_or_total`, `size_unit` or `size_of` HOLDS «✅ Ma’lumot to‘liq» exactly as `what_goods` does. The figure is drawn «❓ 0.12 m³ — bitta karobkanikimi?» and is neither summed into a Σ nor landed as a plain figure until answered («👤 VED hisoblasin» lands it with that mark in the note). A question with n = 0 about a column applies its answer to every row of that reading with cartons > 1. «hammasiniki» marks the figure person-stated (JN-15) and clears an equal per-carton copy.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted. An open per_or_total / size_unit / size_of / one_or_all doubt withholds the «Ma’lumot to‘liq» words (the ✅ button stays — JR-4). The doubted figure is drawn «❓», is in no Σ, and at the landing is taken OFF the row and kept in the note, so the pass asks for it instead of pricing it. A column question (n = 0) applies to every row of that reading with cartons > 1.

### JN-4 — defect — §2.3 applyPacking, weight branch — «a row's netto under its packages' brutto is a row, not a question»

**Objection.** Any stated row weight at or below the gross product passes without a word. So one carton's NET weight standing as the row's — «N.W. 14 | G.W. 15 /ctn | 20 ctns», the model copying 14 into weight_kg — lands 14 kg for a 280 kg row: 6.7 % from the carton's gross, so it is neither `one_carton` (2 %) nor a doubt. The reverse is asked needlessly: a GROSS row weight 300 against a NET carton product 280 is a `differs` doubt though both are right.

**Evidence.** Ran: applyPacking({weightKg:14, cartons:20, kgPerCarton:15 gross}) → weightKg 14, doubts []; ({weightKg:3, …}) → 3, doubts []; ({weightKg:14.8, …}) → replaced by 300 (inside 2 %); ({weightKg:300, kgPerCarton:14 net}) → doubt 300 vs 280. carton-math.ts:435 (the ceiling return), :457.

**The judge's fix.** The ceiling passes silently only while stated ≥ 0.5 × the gross product. Below that it is a doubt; with cartons > 1 and stated ≤ one carton's gross × 1.02 the question is worded «14 kg — bitta karobkaniki emasmi? 20 × … = …». applyPacking takes the row's `weightKind`: a gross row weight above a net product by up to 25 % is no doubt. Tests with red proofs for 14 / 15×20, 3 / 300 and 300 gross / 280 net.

**Ruling — kernel (the lead, before the packages).** Accepted. The gross ceiling passes silently only while stated ≥ 0.5 × the gross product; below it is a doubt, worded as one carton's when it is within 2 % of one carton's gross. applyPacking takes the row's weightKind: a GROSS row weight up to 25 % over a NET product is no doubt.

### JN-5 — blocker — T0 (the welded thousands), steps (2)-(3)

**Objection.** The commonest weld is not on T0's list: a unit that ENDS in a digit. «5 m3 200 kg» is read 3 200 kg today, «2 м3 500 кг» 3 500, «Kafel 120 m2 500 kg» 2 500, «Lak 50 sm3 100 kg» 3 100 — the ordinary «cube, then weight» answer, under ✅. T0 as worded fixes it by accident or wrongly: step (2) masks «a number glued to letters» — mask the whole token and the CUBE is lost; mask only the digit and rule (3) turns «5 m3 200 kg» into the question «200 kgmi yoki 3 200 kgmi?».

**Evidence.** Ran parseManualFacts(…, 'podklyuch'): «5 m3 200 kg» → kg 3200, m3 5; «jami 5 m3 200 kg» → 3200; «2 м3 500 кг» → 3500; «Kafel 120 m2 500 kg» → 2500; «Lak 50 sm3 100 kg» → 3100 (parseGoodsLine and parseLineAnswer read all of them right). intake-manual.ts:35, :70 — the look-behind refuses only a digit, «.» and «,». The typed sections of the corpus hold no space-grouped number before kg/kub (searched: 0), so the corpus guards nothing here.

**The judge's fix.** T0 gains step (0), before any masking: figures of units whose word ends in a digit or ²/³ (m2, m3, м2, м3, sm3, cm3, см3) are read and their spans — the unit included — consumed. A group after such a unit is a new number: «5 m3 200 kg» = 5 m³ and 200 kg, never asked. intake-manual's look-behind gains \p{L}, as units.ts:442 has. Corpus: the five lines above with these answers, plus «12 m3 1 200 kg» → 1 200.

**Ruling — release 1a.** Accepted — T0 gains step (0): figures of units whose word ends in a digit or ²/³ are read first and their spans consumed, so «5 m3 200 kg» is 5 m³ and 200 kg, never asked. The look-behind gains \p{L}.

### JN-6 — defect — T0 rule (3) and its corpus answers

**Objection.** Rule (3) cannot be built as worded. «stul 20 300 kg» → ambiguous and «iPhone 15 128 kg» → 128 are ONE shape (word, A, BBB kg): nothing says 15 is a model and 20 a count, and nothing «number-like» stands left of either. «The LAST group alone» is wrong for three groups («stul 20 1 200 kg» would offer 200). Welds the list misses: a phone («Ali aka 90 123 45 67 300 kg» → 67 300 today), «GS 777 300 kg» and «GS-777 300 kg» (777 300), «№15 300 kg» (15 300), «XJ-200 300 kg» in units.ts too (200 300), and COUNTS («Manga Vol 3 200 dona» → 3 200 dona). parseSize returns only the first size.

**Evidence.** Ran both readers on 38 lines. Today: «stul 20 300 kg» 20300, «Stanok 1 500 kg» 1500, «iPhone 15 128 kg» 15128, «Kurtka 300 1 200 kg» 1200 (right), «XJ-200 300 kg» → parseGoodsLine kg 200300, «Ali aka 90 123 45 67 300 kg» → a row «Ali aka 90 123» ×45 with 67300 kg, «Kurtka №15 300 kg» → 15300.

**The judge's fix.** State the rule exactly. Mask first: every size (loop parseSize), a phone, a client code in its three spellings (GS777, GS 777, GS-777), digits joined to a letter or to «№ # - / _» on their left. Then for `g1 g2…gk UNIT`: thousands with no question when it opens the line or segment, follows a totals or measure label, or follows a figure WITH its unit («300 dona 1 200 kg»). After a name word or a bare number → ASK, the candidates being (g2…gk) and (g1…gk): «stul 20 300 kg», «iPhone 15 128 kg», «Stanok 1 500 kg», «Kurtka 300 1 200 kg» alike. Same rule for dona, kub, juft. All into the corpus.

**Ruling — release 1a.** Accepted — T0's rule is the judge's wording: mask every size, a phone, a client code in its three spellings, digits joined to a letter or «№ # - / _»; then thousands with no question only at the opening of a line or segment, after a totals or measure label, or after a figure WITH its unit; after a name word or a bare number → ASK with both candidates. Same for dona, kub, juft.

### JN-7 — blocker — T4, T7, T12 — the «preceded by» marks (har biri, har bir, each, каждый/каждая) and «dan»

**Objection.** These words say «each ONE», not «each carton». T4 files every such figure as PER PACKAGE and multiplies by the carton count. «Stul 100 dona 20 karobka, har biri 2 kg» (each chair 2 kg) becomes 20 × 2 = 40 kg «hisoblangan»; the truth is 200. The kernel has `kgPerPiece` for exactly this and its comment names «har biri 4.5 kg beside a piece count» — T4 never routes to it. «har bir dona 2 kg» is per piece by its own noun.

**Evidence.** docs/AI-SORAYDI.md T4 (the «preceded by» list; «With a carton count on the same line it is a Packing»); carton-math.ts:60-65 (kgPerPiece: «a typed «har biri 4.5 kg» beside a piece count»), :462-482. Ran today: «Stul 20 karobka har biri 15 kg» → kg 15 as the shipment's.

**The judge's fix.** T4 decides whose an «each» figure is by rule. A noun right after the mark decides (dona/ta/шт/pcs → piece; karobka/quti/joy/qop/кор/место/ctn → package). No noun: only a carton count on the line → package; only a piece count → `kgPerPiece`; BOTH counts → nothing is multiplied and the table asks «2 kg — bitta donaniki yoki bitta karobkaniki?» with two buttons. Corpus cases for all four.

**Ruling — release 1a.** Accepted, with JS-1 — an «each» figure binds to the count noun it stands with; only pieces → kgPerPiece; only cartons → per carton; both and no noun → nothing multiplied, asked.

### JN-8 — defect — T4 — «dan», «в коробке», bare «20 x 15 kg»; §2.4 PER_PACKAGE_TAIL

**Objection.** (a) «dan» is also «from/than»: «jami 500 kg dan ortiq» loses its total and is asked «nechta karobka?». (b) «в коробке» describes the product: «Кукла в коробке 500 шт, 20 мест» — 500 becomes pieces per carton and the row 10 000. (c) Bare «20 x 15 kg»: the product is right, but 20 is recorded as CARTONS and later multiplies a size or a cube; it may be pieces. (d) «/件» is in PER_PACKAGE_TAIL though units.ts keeps «件» out as «a piece on one invoice and a package on the next». (e) A slash tail the list lacks («15 kg/kor», «15 кг/коробке») still reads as a TOTAL.

**Evidence.** Ran: «jami 500 kg dan ortiq» → kg 500 today; «Stul 15 kg/kor 20 karobka» → kg 15 as the shipment's; tailAt('15 kg/kor' | '15 кг/коробке' | '15 kg/karobkaga') = 0. units.ts:32-35 (件 absent on purpose) against :140 ('/件'). T4 lists «dan», «в коробке», «20 x 15 kg».

**The judge's fix.** (a) «dan» marks only beside a carton or piece count on the same line, never before ortiq/kam/ko‘p/oshiq/gacha/boshlab. (b) Only «в каждой/одной/1 коробке», «в коробке по N», «har (bir) karobkada». (c) A bare «A x B unit» gives the product for that unit and does NOT set packing.cartons unless a carton word stands beside A. (d) «/件» leaves the tail list: asked. (e) A figure followed by «/» + any word that is no known tail is never a total: «15 kg/kor — bitta karobkanikimi?».

**Ruling — kernel (the lead, before the packages) + release 1a.** Accepted. «/件» leaves PER_PACKAGE_TAIL (kernel). «dan» marks only beside a count and never before ortiq/kam/ko‘p/oshiq/gacha/boshlab; «в коробке» only in its «в каждой/одной/1 коробке», «в коробке по N» forms; a bare «A x B unit» gives the product and sets no carton count without a carton word; a figure followed by «/» + an unknown word is never a total.

### JN-9 — blocker — T14 (tonne and gram through routeAmount)

**Objection.** The single letters «g», «г», «t», «т» are capacities and generations far more often than weights in this trade. Through routeAmount «Fleshka 128G 500 dona» gains a row weight of 0.128 kg, «Router 5G 100 dona» 0.005 kg, «Domkrat 5T 20 dona» 5 000 kg, «Модель 2024 г» 2.024 kg — each a row that then «has its weight», is not asked, and is priced per kg. The name loses the token too, which is what the coder reads. routeAmount is every door's kernel (card form, VED paste, a sheet's unit cells), not only the bot's.

**Evidence.** Ran parseGoodsLine today: «Fleshka 128G 500 dona» → name «Fleshka 128G», q 500, kg null; «Router 5G 100 dona», «Domkrat 5T 20 dona», «Domkrat 5 t 20 dona», «Модель 2024 г 300 кг» likewise keep the token in the name. units.ts:442 captures the letters after a number as its unit word; :186-207 routes it.

**The judge's fix.** T14 admits only spellings that can be nothing else: gr, gramm, грамм, гр, 克; tonna, тонн*, тн, ton(s), 吨. The single letters g/г/t/т and «mt» are read ONLY in a totals context — after a weight label of §2.4, or as the answer to the bot's own weight question — never glued to the digits («128G», «5T») and never before «/» («180 g/m2»). Elsewhere they stay in the name. Corpus: the five lines above, unchanged from today.

**Ruling — release 1a.** Accepted — T14 admits only spellings that can be nothing else (gr, gramm, грамм, гр, 克; tonna, тонн*, тн, ton(s), 吨); the single letters g/г/t/т and «mt» only in a totals context, never glued to digits, never before «/».

### JN-10 — defect — T7 («2: 20 karobka x 12 juft» → 240 juft) against §2.3 Packing

**Objection.** The kernel's packing multiplies pieces, kilos and cubes only: `pcsPerCarton` lands in `quantity` (dona). T7 promises «20 × 12 = 240 juft» — a measure pair. Routed through applyPacking as written the row gets quantity 240 dona and no pairs, and the law's «juft» question stays open (AB-2 unfixed); or the builder multiplies outside the kernel, which §2.3 forbids. The same for «20 karobka x 5 litr» and m².

**Evidence.** carton-math.ts:340 (PackedField = volumeM3 | weightKg | quantity), :300-302 (quantity = cartons × pcsPerCarton), :343-349 (PackedLine carries no measure). Ran cartonFigures({cartons:20, pcsPerCarton:12}) → quantity 240, nothing else.

**The judge's fix.** §2.3 gains the per-carton MEASURE before P-typed is built: `Packing.perCartonUnit: 'dona' | 'juft' | 'm2' | 'litr'` (default dona) and `measureUnit` / `measureQty` on PackedLine. A non-dona product is written to measureQty under that unit with its own derived mark, and is a doubt when the row already holds another pair unit. carton-math.test.ts: «20 × 12 juft» → 240 juft, quantity untouched.

**Ruling — kernel (the lead, before the packages).** Accepted (= JR-1). Packing.perCartonUnit: dona | juft | m2 | litr; a non-dona product is written to measureQty under that unit.

### JN-11 — blocker — X3 (the size column) with X4; T12 («尺寸», «Size:», «Размер:» lines)

**Objection.** X3 makes «Size (cm)» beside a package column, «Dimensions», «L*W*H», «尺寸», «Габариты», «O‘lchami (sm)» a `cartonSize` column — and X4 multiplies. On a quotation those headers are the PRODUCT's size: «Sofa | Size 220×95×85 cm | QTY 10 | CTNS 30» (three cartons a sofa) computes 30 × 1.776 = 53.3 m³ «hisoblangan», nobody asked. §2.3's own rule is that only a size SAID to be the package's is multiplied; a bare «Size» says nothing. T12 has the same gap for a spec block's «尺寸 …» beside «箱数 20».

**Evidence.** docs/AI-SORAYDI.md X3 header list; §2.3 «Where it is safe» (a word — karobka/ctn/…/外箱 — or its column header). units.ts:128-131: FIELD_LABELS.size mixes 'carton size', '外箱尺寸', '箱规' with 'size', '尺寸', 'размер', 'габариты', 'dimensions'. Ran the kernel with size.of null → no product, sizeOwnerUnknown true: it already asks when told the truth.

**The judge's fix.** Two header lists. PACKAGE (of: 'package'): Carton size, CTN SIZE, MEAS (CM), 外箱尺寸, 箱规, Размер коробки, Karobka o‘lchami, and an L|W|H triplet under such a super-header. OWNER UNKNOWN (of: null → the `size_of` buttons, nothing multiplied): Size, Dimensions, L*W*H, 尺寸, Размер, Габариты, O‘lchami. FIELD_LABELS.size is split the same way for T12. A sheet's own line CBM, when present, still decides by `agrees`.

**Ruling — kernel (the lead, before the packages) + release 1a.** Accepted. Two header lists: PACKAGE (Carton size, CTN SIZE, MEAS (CM), 外箱尺寸, 箱规, Размер коробки, Karobka o‘lchami) and OWNER UNKNOWN (Size, Dimensions, L*W*H, 尺寸, Размер, Габариты, O‘lchami → of: null → asked). FIELD_LABELS.size is split the same way (kernel).

### JN-12 — blocker — X5 (an unmarked per-carton column decided by the TOTAL row)

**Objection.** The TOTAL row is no witness in the commonest layout. (a) A supplier's TOTAL is a SUM dragged across every numeric column, the per-carton one included: TOTAL = Σ(column), «no contradiction», and the per-carton column lands as the line's, 15-21× small. Only TOTAL = Σ(value × cartons) ≠ Σ(value) proves anything. (b) No TOTAL row: nothing is checked at all. (c) The belt runs only on a non-null Σ — one row lacking the figure switches it off. (d) «Nothing explains it → the lines are nulled»: a Σ short of the TOTAL is more often rows the reader dropped, and a right sheet loses every line figure.

**Evidence.** goods-import.ts:2103-2117 (`contradicts` compares the column's Σ with the total rows' cell of the SAME column; false when they match); :2515-2524 (`sumOf` is null as soon as one kept row lacks the figure); :2534-2537 (the belt is guarded by `!== null`). Today a contradiction nulls only the sheet's total; the lines stand.

**The judge's fix.** X5 states: TOTAL = Σ(value) proves nothing. A column is per carton when its header says so, when TOTAL ≈ Σ(value × cartons) ≠ Σ(value), or when a size column's cube says so. With cartons > 1 on two or more rows and none of these, the sheet is ASKED once per column («“CBM” ustuni — bitta karobkanikimi yoki qatornikimi?»), holding ✅ on the AI door and noted for the VED on the plain one. The check runs over the rows that have both figures. An unexplained mismatch never nulls the lines: they stand, the sheet's total is not offered, one ⚠️ names both sums.

**Ruling — release 1a.** Accepted — X5 is rewritten: TOTAL = Σ(value) proves nothing; a column is per carton by its header, by TOTAL ≈ Σ(value × cartons) ≠ Σ(value), or by a size column's cube; otherwise with cartons > 1 on two or more rows the COLUMN is asked once; an unexplained mismatch never nulls the lines.

### JN-13 — defect — X5 «the volume column is … the largest Σ», with X6 marked second

**Objection.** «Largest Σ» picks the wrong column whenever a volume-keyed header is in another unit: «Volume (cm3)» / «体积(cm³)» beside «CBM» (a million times larger), «Объем, л», and «Объёмный вес, кг» / «Volume weight» — volumetric KILOS, whose header contains the key «объем» / «volume». Today the leftmost wins, so most such sheets read right by position; after X5 they flip to the foreign-unit column. X6, which converts or refuses a header's own unit, is «second» priority, so the two can ship apart.

**Evidence.** goods-import.ts:377 (VOLUME_KEYS 'объем', 'volume', …), :301 («header keys match as SUBSTRINGS»), :1641 (the first rung has no own-unit test; only the second, :1644, has OWN_UNIT / CUBIC_METRE). The weight's `heaviest` (:1677-1689) is safe only because every candidate is kilos.

**The judge's fix.** X6's header-unit rule is FIRST priority and lands in the same commit as X5: a volume candidate is m³ by its header or carries no unit; cm³/dm³/l columns are converted before any Σ is compared; an unknown unit refuses the column. A header naming a WEIGHT («объёмный вес», «volume weight», «volumetric», «体积重», any volume key beside kg/кг) is never a volume candidate. Sheet tests: CBM + Volume (cm3); CBM + Объёмный вес — the CBM column is chosen.

**Ruling — release 1a.** Accepted — X6's header-unit rule is first priority and lands with X5; a header naming a WEIGHT («объёмный вес», «volume weight») is never a volume candidate.

### JN-14 — defect — X0 (a sheet handed to the model keeps its columns)

**Objection.** The rule keeps an empty slot only «between a row's first and last filled cell», yet pins «every data line has the header's cell count». A row whose FIRST cell is empty — a «No.» left blank on continuation rows, a factory name merged down column A, a TOTAL row labelled in column B — still loses its leading slot, and every figure slides one header to the left: the defect X0 exists to end. Trailing empties are dropped the same way, so the pin fails as worded.

**Evidence.** docs/AI-SORAYDI.md X0 wording («between a row's first and last filled cell»; «pinned: every data line has the header's cell count»). Its own example «Office chair | 120 | 10 |  | 150 | 1.2» has only an interior gap. `rowLine` joins the non-empty cells (CR-1).

**The judge's fix.** X0: every kept column is emitted for every row — leading, interior and trailing empties alike; a cell covered by a vertical merge is emitted empty with no carry-down. The pin is «cells per line = kept header columns» over a fixture with a blank first cell, a first column merged down three rows, and a TOTAL row labelled in column B.

**Ruling — release 1a.** Accepted — X0: every kept column is emitted for every row, leading, interior and trailing empties alike; the pin is cells per line = kept header columns over the judge's fixture.

### JN-15 — blocker — §2.3 applyPacking as the base of T2, T7, T10, M3, M4, M18, A4 — every writer of a row figure

**Objection.** The kernel cannot tell a PERSON's figure from a reading's, and no package is told the rule its comment holds. (a) A typed «1: 3.1 kub» over a computed cube is reverted on the next pass unless the writer cleared `derived` — §3 never says so. (b) A person answering «0.12 is the total» is overruled again: cleared mark, same equality, `one_carton` once more. (c) A `differs` doubt has no «answered» state, so M3's two buttons loop for ever or cannot hold ✅. (d) Packing has ONE `from`: a seller's «1: 25 karobka» over the AI's size attributes one to the other, and a re-reading (🔄, «➕ Yana ma’lumot») may overwrite the typed count.

**Evidence.** Ran: computed 2.4, then {volumeM3: 3.1} with the mark left → 2.4 again, doubts []; mark cleared → 3.1 + a doubt. After `one_carton`, {volumeM3: 0.12, derived: undefined} → 2.4 again. Packing removed → volumeM3 null, the original 0.12 gone. carton-math.ts:400-404 (the rule, in a comment only), :416, :488-492.

**The judge's fix.** Kernel, before the packages: `LineDerived.person?: PackedField[]` (a person stated or chose this figure) — applyPacking never fills, replaces or doubts such a field. `setStated(line, field, value)` is the ONE writer of a person's figure (sets it, clears derived/replaced, marks person); a fence finds any other assignment in the collectors. A replaced original is RESTORED when its product disappears. Packing keeps `from` per field; a typed field outranks ai/file and a re-reading never overwrites it.

**Ruling — kernel (the lead, before the packages).** Accepted, with JB-1. LineDerived keeps the VALUE it computed (a field is «computed earlier» only while it still holds that value) and `person` (fields a person stated or chose — never filled, replaced or doubted); `setStated` is the one writer of a person's figure; a replaced original is restored when its product disappears; Packing keeps its source per factor and a typed factor outranks a read one.

### JN-16 — defect — T5 (typed against read), M5 (AI totals asked), M14

**Objection.** (a) T5 compares figures of different KINDS: typed «netto 280 kg» (it stands on a customs job) against the document's brutto 300 differs by 7 % and is asked «qaysi biri?» — both are right. (b) T5 and M5 can both ask about one field (a typed total present, the AI's withheld by the fold gate). (c) M5's «✅ Ha, butun yuk» lands the AI's photo total beside two folded Excel files unchecked: a photo of ONE factory's list is confirmed as the shipment's although it is lighter than the rows' own Σ. (d) Nothing compares a stated total with the rows after the carton math: a row computed 6000 kg sits under a typed «jami 300 kg».

**Evidence.** intake-manual.ts:254-261 (a netto stands on a customs job), :294-305 (totalWeightFrom knows netto from brutto; T5's wording does not). docs/AI-SORAYDI.md T5, M5; docs/FAYL-OQISH.md §3.7 (one factory's Σ never stands as the shipment's).

**The judge's fix.** T5 compares like with like: a typed netto against a read brutto is a conflict only when netto > brutto. One question per field: with a typed total T5 asks and M5 does not. M5 prints the rows' Σ beside its question and offers no «Ha» when the AI's weight < Σ rows' weight × 0.98 or its cube < Σ rows' cube × 0.98. After applyPacking, Σ rows' weight > the stated brutto × 1.02 (cube: ± 5 %) is a ⚠️ that holds ✅.

**Ruling — release 1b.** Accepted — T5 compares like with like (a typed netto against a read brutto conflicts only when netto > brutto); one question per field; M5 prints the rows' Σ beside its question and offers no «Ha» when the AI's total is under the rows'; Σ rows against the stated total is checked after the carton math (JS-17).

### JN-17 — defect — M7 (customs-only totals from the rows); question 2 of §7

**Objection.** M7 lands the rows' Σ as the shipment's weight. Rows' weights are NETTO (or brutto where only brutto was written). The stored `weight_kg` is what the seller's upsale divides the ARRIVED kilos by — warehouse brutto — and that factor has no cap. On a customs-only job with no cube the share is then paid × brutto ÷ netto, 5-15 % too much; today the weight is asked as brutto or absent (factor 1). The same stored figure becomes a freight brutto if the job is recalculated as podklyuch — «netto never a freight brutto» (SAKKIZ-R2) broken without a word. His question 2 does not tell him.

**Evidence.** src/modules/wms/calc/upsale.ts:173 (quoted_kg = COALESCE(v.weight_kg, r.weight_kg)), :239-245 (cargo.kg / quoted_kg, ELSE 1, no LEAST), :250 (cargo.kg = Σ receipt_lots.total_weight_kg). The cube has a derivation flag (`volumeFromLines`); the weight has none (grep: no weightFromLines).

**The judge's fix.** M7's Σ of rows is DISPLAY only («ℹ️ qatorlardan: 480 kg (netto)»): `calc_requests.weight_kg` stays empty until a person states a brutto, as today. If it must be stored, it carries a derivation mark that the upsale's `quoted_kg`, `totalWeightFrom` and every freight reader refuse — and question 2 tells him what it does to the seller's share. No Σ is shown when one row's weight is marked brutto and another's netto.

**Ruling — release 1b.** Accepted — M7's Σ of rows is DISPLAY only; calc_requests.weight_kg stays empty until a person states a brutto.

### JN-18 — defect — A4 (the one-step reply) and its «second» plain-typed wait; A3

**Objection.** (a) The fence is «a row the answer ASKED», kept on the payload — if by number, a row deleted or added since moves the number to another good. (b) A bare «3: 300» to a row asked «soni (dona) yoki sof og‘irligi (kg)» has no unit; the house convention makes it pieces. (c) A reply with one allowed and one disallowed segment must not half-write. (d) The plain-typed wait takes «nothing but table answers»: a bare «451» or «300» typed within 30 minutes — a client-code or truck lookup in this bot — would be written into a customs row. (e) A3 heads a group «1-2.»; a reply «1-2: 300 kg» is no row address and reads as the SHIPMENT's weight.

**Evidence.** docs/AI-SORAYDI.md A4, A3. intake-manual.ts:150 (MATERIAL_ROW_ADDRESS takes one number); units.ts:189 (no unit word → quantity). Ran parseLineAnswer: «1: 60*40*50 300» → {kind:'bare', value:50300}; «2: 20 300 kg» → weight 20300.

**The judge's fix.** The payload holds per asked cell {itemId, seq, field, rev}; inside amendRequest's lock the write re-reads that seq still names itemId and the cell is still empty — else the add table. A bare number is taken only when the row was asked exactly ONE figure. The reply is all-or-nothing. The plain-typed wait needs a unit word or a row address in the text (a bare number or a code-shaped token falls through to the lookup), and an un-addressed figure only when the answer asked ONE cell. «1-2:» is refused in words.

**Ruling — release 2.** Accepted — A4's payload holds per asked cell {itemId, seq, field, rev}, re-read under amendRequest's lock; a bare number only when the row was asked ONE figure; the reply is all-or-nothing; «1-2:» is refused in words.

### JN-19 — defect — A11 (a file fills an empty cell); M6 (`known_figures`)

**Objection.** (a) A11 does not say how a file's row finds its stored row. By name it is fuzzy: two stored rows of one good in two sizes, or another good with a near name, and the figure fills the wrong row — «empty» is no fence against that. (b) A read figure that carries a doubt (`differs`, `one_carton` replaced, cm assumed, owner unknown, `per_or_total` open) would be written as a clean fill. (c) M6's `{ n, weight_kg, volume_m3, cartons }` gives the model a carton count and NO per-carton home: a photo's «G.W./CTN 15» goes into weight_kg, and with nothing per-carton the kernel has no product to judge it by — DIM-9 through a new door.

**Evidence.** docs/AI-SORAYDI.md A11, M6; carton-math.ts:331 (no product → no verdict). SAKKIZ-R3's amend writes under expect-null, which guards the cell, not the match of the row.

**The judge's fix.** A11 fills only on a ONE-to-one match: exactly one stored row matches the file's row and exactly one file row matches it (the reading's `sameGoodsLine`, no `namesContradict`); anything else is shown in the add table as today. Only a figure with no doubt and no assumption fills; a doubted one is asked first. M6's entry carries the same `packing` object as a good and passes through applyPacking — or M6 stays in §6.

**Ruling — release 2.** Accepted — A11 fills only on a ONE-to-one match and only a figure with no doubt and no assumption. M6 (`known_figures`) leaves this round (§6).

### JN-20 — defect — M3 (the density belt 20…1500 kg/m³)

**Objection.** (a) It is over the whole job only: one row whose cube is one carton's among thirty right rows moves nothing. A row with the line's weight and one carton's cube (300 kg, 0.12 m³ = 2 500 kg/m³) is the dg2-5 shape with no size to catch it. (b) It «holds «Ma’lumot to‘liq» until answered», but no answer is named: tile, bolts, bearings and marble really are above 1 500 kg/m³, and such a job could never be confirmed. (c) Which kilos — the shipment's brutto or the rows' netto — is not said. (d) His own tariff calls cargo light below 10 kg/m³, not 20.

**Evidence.** docs/AI-SORAYDI.md M3. CLAUDE.md, the yo‘lkira tariff round: `light_below` 10 kg/m³, the tariff walked at every whole density 1..1500. Ran applyPacking: with a carton count and no per-carton figure there is no product and no doubt for such a row.

**The judge's fix.** M3: the check runs per ROW that has both figures (outside 10…3 000 kg/m³) and over the job (stated brutto ÷ stated cube, else Σ rows ÷ Σ rows). The question has two answers, stored on the row / collection so it is asked once: [✅ To‘g‘ri] and [bitta karobkaniki → × N] (the second only with a carton count). Unanswered it holds ✅.

**Ruling — release 1b.** Accepted — the density check runs per ROW that has both figures and over the job, band 10…3 000 kg/m³ (the lower bound is the tariff's own), with two answers remembered until a figure changes.

### JN-21 — defect — T1 (label-first totals — «only with a LABEL of §2.4»); T3 NOT_GOODS_WORDS

**Objection.** §2.4's label lists hold words that are money, product nouns or units: «gross», «net» (an invoice's «Gross: 12 500», «Net: 4 500»), «vol» («Manga Vol 3»), «cube» / «kub» / «куб» («Magic cube 3»), «вес», «масса». Read label-first with no unit they become the shipment's kilos or cubes. T3 also makes «net», «total», «cube», «package», «size» NOT_GOODS words: a fishing «Net 300 kg» or TOTAL-brand grease is then a totals line and its row is gone.

**Evidence.** units.ts:109-120 (WEIGHT_LABELS 'gross', 'вес', 'масса'; NET_LABELS 'net'; VOLUME_LABELS 'vol', 'cube', 'kub', 'куб'). Ran today: «Net: 4500» → a row «Net» ×4500; «Gross: 12 500» → «Gross» ×12500; «Manga Vol 3 200 dona» → 3 200 dona — none is a total today.

**The judge's fix.** A label-first figure WITHOUT a unit is read only after an unambiguous measure label — g.w., n.w., 毛重, 净重, 体积, cbm, meas, brutto, netto, hajm(i), og‘irlik, объём, вес брутто/нетто — followed by «:», «=» or the unit, on a line with no currency mark. «gross», «net», «vol», «cube», «kub», «куб», «вес», «масса», «total weight» need the unit written. «net», «total», «cube», «package», «size» stay out of NOT_GOODS_WORDS.

**Ruling — release 1a.** Accepted — a label-first figure WITHOUT a unit is read only after an unambiguous measure label (g.w., n.w., 毛重, 净重, 体积, cbm, meas, brutto, netto, hajm(i), og‘irlik, объём, вес брутто/нетто) followed by «:», «=» or the unit, on a line with no currency mark; «net», «total», «cube», «package», «size» stay out of NOT_GOODS_WORDS.

### JN-22 — defect — §2.4 — the new words in units.ts WORDS (committed)

**Objection.** Two changes against 4b38d33 that the corpus did not see. (a) «Куба» is also Cuba, and a unit word before a colon names the number after it: «Сигары Куба: 5» is now 5 m³ (was 5 pieces of «Сигары Куба»); `unitField` guards only kv and the carton nouns. (b) «N кубов» is how a toy states its cubes: «Набор 4 кубов 20 шт» now carries a volume of 4 m³, «Игра 12 кубов» 12 m³. Also «cubic meter(s)» is in the list and unreachable (two words), and the fence §2.4 describes — every word read by parseManualFacts and parseTableAnswer — is not in the committed test.

**Evidence.** Ran the new parseGoodsLine against a 4b38d33 copy on 66 lines: 30 differ, 26 as intended. «Сигары Куба: 5» → m3 5 (old: q 5); «Куба: 50» → m3 50; «Набор 4 кубов 20 шт» → m3 4, q 20; «Игра 12 кубов» → m3 12; «5.92 cubic meters» → unknown_unit:cubic. Latin «Kuba sigaret 5», «Кубик», «Кубок», «Kilometr», «Cumin», «Vacuum cleaner 5» unchanged. units.ts:468-479; unit-vocabulary.test.ts:15-22.

**The judge's fix.** `unitField` gives an m³ or kg word before a colon the carton nouns' test: a field only when it opens its clause or follows a figure, a unit or a total word — after a name word it is the name. «куба / кубов / kubov» after a number INSIDE a goods line that also states pieces stays in the name and is asked («4 кубов — hajmmi?»); alone or on a totals line it is m³. Both lines into the corpus; «cubic meter(s)» matched as a phrase; the readers' fence written by P-typed.

**Ruling — release 1a.** Accepted — an m³ or kg word before a colon is a field only when it opens its clause or follows a figure, a unit or a total word; «куба / кубов / kubov» inside a goods line that also states pieces stays in the name and is asked; «cubic meter(s)» is matched as a phrase; the readers' fence is P-typed-A's first test.

### JN-23 — defect — T9 («on a ONE-row table an un-addressed count/weight/code goes to that row»)

**Objection.** An un-addressed «300 kg» is today the answer to the table's TOTALS question — the shipment's brutto — and a one-row job then copies it onto the row with its label («umumiydan»). T9 sends the same text to the row instead. The row's weight is netto and the open question is about brutto: the total stays open and is asked again, or one figure is written as two different kinds. The same for a cube.

**Evidence.** docs/AI-SORAYDI.md T9. line-address.ts:170-183 (readTotals reads an un-addressed figure through parseManualFacts as a total). MP-1's trace shows the one-row copy: «1. Стул — 50300 kg (umumiydan)» (intake.ts loneWeightKg).

**The judge's fix.** T9 states the order: an un-addressed weight or cube answers the shipment's OPEN total first (the one-row copy then happens by the existing labelled rule); only when no total is asked — customs-only under M7, or the total already given — does it go to the single row. An un-addressed count, pair or code goes to the row. One figure never fills two cells of different kinds without its label.

**Ruling — release 1b.** Accepted — an un-addressed weight or cube answers the shipment's OPEN total first; only when no total is asked does it go to the single row.

### JN-24 — defect — §2.3 weight kinds — the rows' gross Σ «offered as the shipment's brutto, labelled «(karobkalardan)»»

**Objection.** A per-carton weight whose kind NOBODY stated counts as gross. «14 kg/ctn» typed or read with kind unknown is as often the net weight; its Σ is then «offered» as the brutto a freight section prices on. And «offered» is not defined: written by itself it breaks «the brutto is ASKED» (SAKKIZ-R2, his 2.7 b).

**Evidence.** Ran: applyPacking({cartons:10, kgPerCarton:14, kind null}) → derived.grossKg 140, weightIsGross true; grossFromLines([a gross-300 line, that line]) → 440 «karobkalardan». carton-math.ts:457-461 (`kind !== 'net'` is treated as gross).

**The judge's fix.** `derived.grossKg` is kept only for kind === 'gross'. A line with an unknown kind makes grossFromLines null and the table asks once «14 kg/karobka — brutto yoki netto?». The Σ is a BUTTON under the brutto question («📦 Karobkalardan: 440 kg — shuni olaymi?»), never written without the press, and then worded «karobkalardan, sotuvchi tasdiqladi».

**Ruling — kernel (the lead, before the packages).** Accepted. derived.grossKg is kept only for kind = gross; an unknown kind makes grossFromLines null and is asked once («brutto yoki netto?»). The Σ is an OFFER under the brutto question, never written without the press.

### JN-25 — defect — §2.3 «unit absent → cm assumed when every side is 5…300»; question 1 of §7

**Objection.** The band holds ordinary MILLIMETRE cartons too: «250x180x120» (a shoebox in mm) is read 5.4 m³ a carton; the truth is 0.0054. The line says «sm deb olindi», but it is a computed figure under ✅, and the whole-job density belt sees it only when a weight exists. From the model the same arrives as size_unit «unknown» whenever a header's «(MM)» was missed.

**Evidence.** Ran sizeCube: {120, 80, 60, unit null} → 0.576 m³, assumed; {300, 300, 300} → 27 m³, assumed. carton-math.ts:78 (ASSUMED_CM_SIDE 5…300), :241.

**The judge's fix.** Centimetres are assumed only when the result is plausible. When the packing or the row gives a weight per package, the package's density at cm must fall inside 10…3 000 kg/m³ — otherwise no cube and the `size_unit` question. One package above 3 m³ from an ASSUMED unit is asked too. carton-math.test.ts: 250×180×120 with 0.5 kg a carton → asked; 60×40×50 with 15 kg → 0.12 m³, assumed.

**Ruling — kernel (the lead, before the packages).** Accepted. Centimetres are assumed only when plausible: with a weight per package the package's density at cm must fall inside 10…3 000 kg/m³, and one package above 3 m³ from an assumed unit is asked.

### JN-26 — nit — §2.3 rounding and bounds; aiGoodsLine

**Objection.** (a) A product that rounds to 0 is written as 0 with a «hisoblangan» mark (1 × 0.0004 m³; one 5×5×5 cm carton). (b) Pieces are rounded to three places, so 3 × 12.5 lands 37.5 dona. (c) A stated unit is never doubted: «60x40x50 м» is 120 000 m³ a carton. (d) aiGoodsLine already calls applyPacking and drops its doubts; until P-model draws them the kernel commit must not reach main alone.

**Evidence.** Ran: applyPacking({cartons:1, m3PerCarton:0.0004}) → volumeM3 0 with derived.volumeM3 set; cartonFigures({cartons:3, pcsPerCarton:0.3333}) → quantity 1; parseSize('60x40x50 m') → cube 120000. intake-ai.ts:2013 (`return applyPacking(line).line`).

**The judge's fix.** A product below 0.001 is not written: the factors are shown and the figure asked. A non-whole piece product is a doubt. One package above 70 m³ (a 40-foot container) is no cube: asked. The branch is merged only with P-model's doubt surfaces built.

**Ruling — kernel (the lead, before the packages).** Accepted. A product below 0.001 is not written; a non-whole piece product is a doubt; one package above 70 m³ is no cube. (d) The branch reaches main only with the doubt surfaces drawn — release 1a's table draws them.

#### What this lens found SOUND

- cartons = 1: a stated figure equal to the one carton's is `agrees`, never `one_carton` (ran judgeStated(0.12, 0.12, 0.12, 1) and applyPacking with one carton).
- A size with no unit outside 5…300 computes nothing and is asked: «600×400×500», «0.6×0.4×0.5», «1200×800×1000», «1,2x0,8x1», «301x40x50», «4x40x50» (ran).
- Only a PACKAGE's size is multiplied: of 'product' and of null give no product; sizeOwnerUnknown is true beside a carton count; productCubeOffer only offers and needs pieces and no cube.
- applyPacking is idempotent (re-run gives the same line and note), follows a corrected packing, and takes a computed figure back when the packing no longer multiplies out — pieces → piece-weight chain included.
- A carton count that is not whole or is above 100 000 computes nothing; cartons alone compute nothing.
- Half-up rounding on the decimal: 7 × 1.2345 → 8.642; the 2 % and 5 % tolerances behave as worded (sameFigure(100, 98) true; 49 × 0.12 against a stated 6.0 is a doubt).
- «/» is never a size joiner; «20 x 15 kg» and «20x24 dona» are not sizes; «60x40x50 300kg» leaves « 300kg» for the amount reader.
- tailAt: «/ctn», «/CTN», «/箱», «/ctns», «/шт», «/pcs» are tails; «/m3», «/cm3», «/ctnr», «3000pcs/15ctns» are not.
- T0's untouched examples read right today in both readers and need no change: «1 200 kg», «12 500 kg», «jami 12 500 kg», «2 kub 1 200 kg», «300 dona 1 200 kg», «jami 1 200 kg 5 kub», «…x50 sm 300 kg», «…x50, 300 kg», «…x50 1200 kg», «Jami: 1 136.5 kg».
- New unit words: Latin «Kuba sigaret 5», «Kubik rubik», «Кубик Рубика», «Кубок», «Кубышка», «Kilometr», «Kilovatt», «Curcuma», «Cumin», «Vacuum cleaner», «Magna cum 20» are unchanged against 4b38d33; «5 cbm / кбм / кубометра / kubometr / cu.m / кило / килограммов» now land in the right column.
- The existing TOTAL belt reads sectioned totals and keeps subtotal words out (goods-import.ts:2052-2117) — X5's subtotal case is covered by what stands.
- A4's once-key (the reply's own message id) with an empty-cell re-check stops a replay or a second identical reply; M5 asks instead of landing, which keeps FAYL-OQISH §3.7.
- grossFromLines gives a Σ only when EVERY line has a gross product; a NET per-carton weight lends none.


## Lens «rules» — the design against the binding earlier specs

### JR-1 — blocker — §2.3 kernel (Packing.pcsPerCarton, applyPacking), §2.2 pieces_per_carton, T7, X2

**Objection.** A per-carton count has no unit, and its product is always written into `quantity` (PIECES). «20 karobka × 12 juft» (T7's own example), a shoe invoice's «12 пар/кор», a tile sheet's «1.44 м²/кор» land as 240 dona; the row's pair/m² measure stays empty and the law's juft ask stays open beside a «240 dona» nobody stated. The model's `unit:"juft"` with `measure_qty:null` (the prompt says «итог оставь null: бот умножит сам») is dropped by aiGoodsLine. This is RASTAMOJKA-TUZATISH's root defect — a number in the column nobody's unit named — rebuilt in the committed kernel, and T7 cannot echo «240 juft» without multiplying outside carton-math, which §2.3 forbids.

**Evidence.** Ran (scratch vitest, deleted): applyPacking({measureUnit:'juft', packing:{cartons:20, pcsPerCarton:12}}) → quantity 240, measureQty null, derived.quantity «20 × 12». aiGoodsLine(unit 'juft', measure_qty null, packing 20 × 12) → quantity 240, measureUnit null, note «soni hisoblangan: 20 × 12 = 240 dona». carton-math.ts UNIT_OF.quantity = 'dona'; intake-ai.ts aiGoodsLine `if (g.measure_qty !== null && g.unit !== null)`; docs/RASTAMOJKA-TUZATISH.md:18 («a number lands in the column its unit NAMES … m²/juft/litr → the measure pair»).

**The judge's fix.** Give the per-carton count its unit: `Packing.perCartonUnit: 'dona'|'juft'|'m2'|'litr'` (absent = dona). applyPacking writes cartons × pcsPerCarton into `quantity` only for dona; otherwise into `measureQty` with `measureUnit` (routeAmount's rule), marked `derived.measureQty`, worded with the unit's own word. aiGoodsLine: a row whose `unit` is juft/m2/litr and whose measure_qty is null takes pieces_per_carton as that unit's per-carton figure; one prompt line says so. X2 reads the header's unit («пар/кор», «м²/кор»). Tests: «20 × 12 juft» → measureQty 240 juft and quantity null, for the kernel, the model mapping, T7 and X2.

**Ruling — kernel (the lead, before the packages).** Accepted (= JN-10). The per-carton count has its unit; aiGoodsLine gives a row whose `unit` is juft/m2/litr and whose measure_qty is null its pieces_per_carton as that unit's per-carton figure; one prompt line says so; X2 reads the header's unit.

### JR-2 — blocker — M4 (§2.2 questions[].n → AiQuestion.row), with T10/A5 and the per_or_total / size_of buttons

**Objection.** `n` indexes the MODEL's own goods list. The table numbers rows after the merge: Excel rows first, then the model's, duplicates dropped, M1's photo goods only offered. M4 draws «🤖 AI so‘raydi» «with addresses» and gives each kind a consumer that WRITES, but nothing maps `row` to the table's row or keeps it across a re-read. Excel with 10 rows + one photo good asked {n:1, kind:per_or_total}: the block says row 1; [bitta karobkaniki] moves row 1's figure (an Excel jacket's) into a packing and multiplies it; a `material` answer «1: charm» goes onto the jacket's note and re-codes it. PA-3's two numberings in one message, now inside the table, with buttons.

**Evidence.** intake-ai.ts AiQuestion («`row` is the INDEX into the reading's own goods»), questionsOf; corpus c0013 (pickGoods: «invoice first, then the model's lines»); IKKI-ESHIK §3.1 («the goods list itself stays only new goods»); SAKKIZ-R3 §1 one-home table («A row's number — TableRow.no», «where an answer lands after a re-read — placeByName»); design §2.2 («n the row in THIS answer's goods») and M4, which name no mapping.

**The judge's fix.** At the settle re-key every question from the model's index to the table row through pickGoods' own placement: kept → its table index + name key; dropped as an Excel row's duplicate → that Excel row; offered (M1) → the offer; unplaceable → a shipment question with no writing button. Store {nameKey, index} like lineAnswers and re-place with placeByName on every re-read; a question whose row is gone is dropped. The block prints TableRow.no; the prompt forbids row numbers inside `text` and the bot strips a leading «N-qator»/«N:». Pin: 10 Excel rows + 1 photo good, per_or_total pressed → row 11 changes, row 1 does not.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted, with JS-3. Every question is re-keyed at the settle from the model's index to the table row through pickGoods' own placement and stored by name key; the contract gains `list: goods | known`; the prompt forbids row numbers inside `text`. Release 1a draws the questions by the good's NAME and with no writing control.

### JR-3 — blocker — X8

**Objection.** «When a figure's Σ is null (a line lacks it) the grand-total row's cell … is the sheet's total» reads ONE row. A sectioned packing list closes each section with its own «TOTAL» and has no grand total (as built, FR-SELL-3). With one line's weight blank, the last TOTAL row is the last SECTION's: 166 kg stands as the shipment's brutto where the sheet says 266, handed on by loneFileTotals as «✅ Brutto» and priced by the road. Unstated as well: whether X8 also resurrects a Σ the belt refused (a pallet, one carton's column), the brutto-under-netto check refused, or a capped list left — today all three are null on purpose.

**Evidence.** Ran today: parseGoods([H, Kurtka 10/100/1.0, TOTAL 10/100/1.0, Shim 5/blank/1.1, TOTAL 5/166/1.1]) → grossKg null, both TOTAL rows dropped as totals. goods-import.ts: totalRows() returns every total row, `stated.at(-1)` is read as «grand», contradicts() also tries their SUM; comment «Refused, never corrected: the VED reads the file, the model reads the row». tests/unit/ikki-eshik-fix-review.test.ts «a TOTAL under each section and no grand total: the sections add up to the Σ».

**The judge's fix.** X8 states a total ONLY when the Σ is null because a kept line lacks the figure — never after `contradicts`, the brutto<netto check or stoppedShort — and through the belt's own reader: exactly one total row → its cell; several → the last one only when it equals the sum of the earlier ones within the belt's rounding (a grand total over sections); else the SUM when every section row states the figure; else null. A text total that reads two ways («1,650») states nothing. The figure flows only through loneFileTotals / fileTotals (FAYL-OQISH §3.7). Corpus: the sectioned sheet with one blank weight → 266, never 166.

**Ruling — release 1a.** Accepted — X8 states a total only when the Σ is null because a kept line lacks the figure, through the belt's own reader: one total row → its cell; several → the last only when it equals the sum of the earlier ones; else their sum when every section states it; else null.

### JR-4 — blocker — M4 «An unanswered what_goods holds «✅»»

**Objection.** A new reason to take «✅ Tasdiqlash» off, decided by the model's free output, with no exit once rows exist. FAYL-OQISH §1.1 blocks only on what was ACCEPTED and not READ and says why nothing else may: it «would leave the seller no way to an AI figure except ✖️». With rows > 0, T9 does not apply (zero rows only); a typed «karobkada stul» is «jadvalda bunday qator yo‘q»; «➕ Yana ma’lumot» → a paid re-read of the same photo of closed cartons → the model asks what_goods again → held again. Nothing says what «answered» means for n = 0, and the reason is not added to aiReadingWhole / landingPress / notWholeClosing, the one predicate six places ask.

**Evidence.** platform/telegram/reading-whole.ts (UnreadReason has 7 members, state fields only; header comment on the named tier); calc-dialog.ts readingOf / landingPress; docs/FAYL-OQISH.md §1.1-§1.2; design T9 («while the table has zero rows»); SYSTEM prompt: «Закрытые коробки без надписей — не товар: вопрос kind "what_goods"» — any photo of closed cartons beside an invoice raises it.

**The judge's fix.** what_goods never removes «✅». Zero rows stays `no_goods` (already blocking; its exit is T9). With rows > 0 it is a ⚠️ line of the table that withholds only the «Ma’lumot to‘liq» words, like every other ask, and goes to the lenta when unanswered. «Answered» = the seller wrote a row or words after it was drawn; an answered or dismissed what_goods is remembered by {photo number, kind} and a re-read does not raise it again. aiReadingWhole gains no model-decided reason. Pin: a photo of closed cartons + 3 Excel rows → «✅ Tasdiqlash» is drawn.

**Ruling — release 1b.** Accepted — what_goods never removes «✅». Zero rows stays `no_goods`; with rows it is a ⚠️ line that withholds only the «to‘liq» words. aiReadingWhole gains no model-decided reason.

### JR-5 — blocker — §2.3 one_carton and the one-piece replacement; M3 («A one_carton replacement is said»)

**Objection.** For a packing the MODEL stated, the check compares the model with itself. A row whose stated total equals the per-carton (or per-piece) figure of the same answer is REPLACED by × cartons (× pieces), with no question. A line total the model also copied into carton_volume_m3, or a column the prompt itself calls undecidable («CBM», «G.W.») written into both homes, lands ×20 under ✅; the note says so, the table asks nothing. Elsewhere the design's rule is the opposite: T5 asks when two sources differ, the belt never corrects. No real model was called in the diagnosis, so which mistake is commoner is not known.

**Evidence.** Ran aiGoodsLine: volume_m3 0.12, weight_kg 36, packing {cartons 20, carton_volume_m3 0.12, carton_weight_kg 36 net} → volumeM3 2.4, weightKg 720, applyPacking(...).doubts = []. quantity 200, weight_kg 4.5, piece_weight_kg 4.5 → weightKg 900, note «og‘irlik bitta donaniki edi (4.5): 200 × 4.5 kg = 900 kg». carton-math.ts applyPacking: the `one_carton` branch and `pieces > 1 && sameFigure(stated, p.kgPerPiece)`.

**The judge's fix.** Split by who stated it. `from: 'file'` and `from: 'typed'` — two independent statements — keep the replacement. `from: 'ai'`: applyPacking never replaces — it returns a doubt (`one_or_all`); the table asks it with the per_or_total buttons and withholds «Ma’lumot to‘liq»; unanswered at «✅» the STATED figure lands with the note «AI: bitta karobkaniki bo‘lishi mumkin — tekshiring». carton-math.test: the two inputs above give a doubt for 'ai' and a replacement for 'file'.

**Ruling — kernel (the lead, before the packages).** Accepted — see JN-2: for `from: ai` applyPacking never replaces; it returns a doubt, and unanswered at «✅» the figure is kept off the row (JN-3).

### JR-6 — defect — A4 (first step) with «T7/T10's forms»; T10 on a landed request

**Objection.** A4 counts T10's forms as table answers a reply may carry. T10 is rename («N: nomi …»), remove («N: o‘chir») and words-to-note. On a LANDED request the add door can write six fields of a stored row and nothing else. A rename or removal is not «an empty cell», so by A4's own fence it opens the add table — where the row is drawn renamed or removed and «✅ Qo‘shish» writes nothing of it, with no word («qatorlar o‘zgarmadi»). And were they wired: a seller deleting or renaming a row of a job in the VED's queue by one reply is outside SAKKIZ-R3 §0.1(2) and changes the name the sealed memory keys on.

**Evidence.** wms/calc/amend-types.ts AmendSubmission.rowAnswers.patch = quantity | weightKg | volumeM3 | measureUnit | measureQty | tnvedCode; platform/telegram/calc-amend.ts amendSubmissionOf `fields` (the same six); amend.ts AmendChange.edits.set; docs/SAKKIZ-R3.md §0.1(2) («It writes the seller's figures …, an empty code, new goods lines, and the totals or cities…»).

**The judge's fix.** Say it in A4 and T10: on a stored request — the reply door AND the ➕ add table — the only T10 form is words appended to the row's note (A5). «N: o‘chir» / «N: nomi …» addressed to a stored row are answered «Bu qator so‘rovda turibdi — o‘chirish / nomini o‘zgartirishni VED qiladi; yozganingiz VED ga yuborildi» and go to the job's thread as text. Rename and remove work on a first collection's table and on rows the add collection itself added (🆕). Test: reply «2: o‘chir» to an AI answer → row 2 still stored, one thread line.

**Ruling — release 2.** Accepted — on a stored request the only T10 form is words appended to the row's note (A5); a rename or removal of a stored row is answered in words and goes to the job's thread.

### JR-7 — defect — A4 — «↩️ Bekor qilish» on the one-step echo, and how the write runs

**Objection.** The echo carries «↩️ Bekor qilish» after amendRequest has written and the pass is queued. SAKKIZ-R3 §0.1(4): «Bekor undoes what ONE message wrote, while the collection is open. After ✅ Qo‘shish the change is on the job … the button answers «Bu tugma eskirgan»». A4 has no collection, so this undo is a second database write nobody designed: which cell returns to null under which compare-and-set, what happens when the pass or the VED has moved the row, a third billed pass, a second thread line for the VED. Also unsaid: that the write is not awaited on the poller (#706), and what a reply does when an add collection for that request is already open with unsaved answers.

**Evidence.** docs/SAKKIZ-R3.md §0.1(4); §1 «#706 … so is the add door's save (calc.amend-save)»; calc-amend.ts openAmendFromReply (today the reply opens the collection and routes the text; nothing is written before the job); amend.ts has no reverse write; R3 §20.3: amendRequest 152-387 ms.

**The judge's fix.** Either drop «↩️» from A4's echo (words: «xato bo‘lsa — shu xabarga to‘g‘risini reply qiling, jadval ochiladi») or design it and restate §0.1(4): an `undo` amendment through amendRequest whose expect is the value this reply wrote; row moved or VED started → to_ved in words; one re-pass; its own once-key. The write itself: enqueue calc.amend-save with a job id and note id derived from the reply's chat + message id (uuidv5), never run in the handler. When an add collection for the same request is live, the reply goes INTO it (today's path), never beside it.

**Ruling — release 2.** Accepted — no «↩️» on A4's echo; the write is the calc.amend-save job with ids derived from the reply's chat + message id; a reply while an add collection for that request is live goes INTO it.

### JR-8 — defect — A2 (the certificate ask), A7

**Objection.** (1) «When nobody touched the toggle» has no home: the collection's `hasCertificate` is a boolean defaulting to true and the request column defaults to TRUE; after the landing «untouched» and «answered: bor» are the same row. The ask is then never drawn, or drawn on EVERY answer — and «sertifikat bor» writes nothing (equal value), so it is asked again: a question that cannot be satisfied. (2) A7 reverses SAKKIZ-R3 §0.1(2) («never … a certificate») without saying so, and «it changes no rate» is not so: it switches the additional duty. (3) Written through the screen's setRequestCertificate, `rev` moves and `handsoff_rev` does not: the request reads «started» for good, the re-run stands down, every later answer goes to the VED as text.

**Evidence.** calc-intake.ts `hasCertificate: boolean` («TRUE by default»); service.ts `hasCertificate: input.hasCertificate ?? true`; workspace.ts setRequestCertificate (`if (request.hasCertificate === hasCertificate) return;` then mutateRequest with no handsOff); amend.ts header «The add door never writes a price, a rate, a zone or a certificate (law 1)»; ai-reply.ts lawParts «qo‘shimcha boj N% (sertifikat yo‘q)»; prefill.ts prefillStanding → 'touched'; tests/unit/handsoff-writers.test.ts.

**The judge's fix.** Take the certificate OUT of sellerAsksOf: the answer's fixed line reads «📄 Sertifikat: bor (deb hisoblandi) — yo‘q bo‘lsa shu xabarga «sertifikat yo‘q» deb reply qiling»; it is a statement, never an ask, never part of A4's payload. A7 stays as an ANSWER: AmendChange gains `certificate`, written in amendRequest's open branch through mutateRequest(…, { expectRev, handsOff: true }) — never setRequestCertificate — as an `applied` amendment (so amended_since and the VED's thread see it); started/closed → to_ved in words. Restate §0.1(2) and amend.ts's header; tell the owner it moves the duty.

**Ruling — waits on the owner's answer.** Accepted — the certificate leaves sellerAsksOf: the answer STATES «📄 Sertifikat: bor deb hisoblandi». A7 (the seller changing it after the pass) reverses SAKKIZ-R3 §0.1(2) and moves the duty: it is put to the owner (question 9) and not built before his answer.

### JR-9 — defect — A5, A11, T6/T7 answered in the add table, §2.3 «the arithmetic into the row's note»

**Objection.** Three items put words on a STORED row's note (A5's material words, A11's «fayldan», the arithmetic of a carton answer), but the add door has no note append: it posts a note only to strip the lone-weight sentence, because «any other edit's note would REPLACE the stored one» — and that note carries sentences code reads by `includes`. Second: a T6/T7 answer in the add table gets its figure from applyPacking in `facts`, while the submission is built from lineAnswers' six patch fields: the table shows «2.4 m³ (hisoblangan)» and «✅ Qo‘shish» writes nothing. Third: door-row cuts the landed note at 500 characters with `slice`; provenance comes first, the machine-read lone-weight sentence last.

**Evidence.** amend.ts tableEditsOf comment («A `note` only where … any other edit's note would REPLACE the stored one», re-check p4-17) and amendDiff (`note` only when `copied`); calc-amend.ts amendSubmissionOf; note-facts.ts carriesAiCode (`includes(AI_CODE_NOTE)`); intake.ts weightFromTotalNote (`includes`), itemFacts (note = the line's note, then LONE_WEIGHT_NOTE); door-row.ts:116 `.join(' · ').slice(0, 500)`.

**The judge's fix.** One mechanism, named in the design: `AmendChange.edits[].noteAppend` → the writer posts stored + « · » + append under `expect.note = stored`; a miss is to_ved. A5's words, A11's source and a computed answer's arithmetic all use it. amendSubmissionOf submits, for a stored row, the figures applyPacking computed together with their `how`. Note order at every door: machine-read sentences first (lone-weight, AI_CODE_NOTE, the unsure-code note), then provenance; cut by code points at a « · » boundary with «…». Unit test: a lone row with 600 characters of provenance still answers weightFromTotalNote.

**Ruling — kernel (the lead, before the packages) + release 2.** Accepted — ONE note renderer (kernel): machine-read sentences first, then the seller's words, the source's note, the marks, the packing, the arithmetic; cut by code points at a « · » boundary. `noteAppend` on the add door is release 2.

### JR-10 — defect — A11

**Objection.** A11 fills a stored row's empty cell from a file sent after the pass. Three earlier rules collide and none is named. (1) IKKI-ESHIK §1.2.3 (PF-SPEC-2, FILES-2): on an add collection a packing-shaped Excel is a «noted» file — «its rows change no row» — and CR-2's own case is the packing list. (2) §1.2.2 INT-10: a row with no weight takes a second source's weight «only from a NET column, never from gross». (3) SAKKIZ-R3 §0.1(2): totals in top-up material are not written. Also: the stored row has no figure to agree on, so the match is by name alone, and amendDiff takes the FIRST same-named row; and «echoed … with ↩️, and the pass re-runs» reads as an immediate write, though a file needs a reading and A4 sends files to the add table.

**Evidence.** docs/IKKI-ESHIK.md §1.2.3 and its «As built … (FILES-2)», §1.2.2 («A held row with NO weight takes the packing list's matching line weight, but only from a NET column»); amend.ts amendDiff `fresh.items.find((i) => nameKey(i.name) === nameKey(line.name))`, conflictOf (a null stored figure is a conflict today); calc-intake.ts addReading; dg2/critic.json CR-2.

**The judge's fix.** Word A11 as an amendment of those rules, door 'ai' only, request open: a figure read for a stored row whose cell is NULL is drawn in the add TABLE as that row's answer marked «fayldan» and written at «✅ Qo‘shish» (never at once) under expect-null. It applies to model-read documents AND to a packing-shaped Excel — superseding «rows change no row» for empty cells only. Weight: a netto figure only; a gross one goes to the note and to the brutto question; a carton count is packing, never pieces. The row must be the ONE stored row the name meets — two candidates → today's «VED hal qiladi» line. Totals: M5's buttons, never unasked.

**Ruling — release 2.** Accepted — A11 is worded as an amendment of IKKI-ESHIK §1.2.3 / §1.2.2 and SAKKIZ-R3 §0.1(2), door ai only, request open: drawn in the add TABLE as that row's answer marked «fayldan» and written at «✅ Qo‘shish» under expect-null; weight only from a NET figure.

### JR-11 — defect — X5

**Objection.** X5 changes the belt (IKKI-ESHIK §1.2.1, CRITIC-1: «refused (null), never corrected») twice without naming it. (a) The column is corrected when Σ(value × cartons) meets the TOTAL — at 2 %, while the belt's own agreement is the figure's printed place or 0.5 %: two tolerances in one function. (b) «If nothing explains it, the LINE figures are nulled too.» The belt's documented, tested case is a PALLET in the total: the lines are right and only the Σ is refused. X5 would wipe every row's weight on such a sheet (there the gross column IS the rows' weight), and on one whose TOTAL is 1 % heavier than its lines — a table of rows all asking for a weight the file states.

**Evidence.** Ran today: [H(Description, CTN, G.W.(kg), CBM), Kurtka 10/100/1.0, Shim 5/166/1.1, TOTAL 15/300/2.1] → grossKg null, weightKind 'gross', rows keep 100 and 166; with TOTAL 269 (1.1 % over) → grossKg null, rows kept. goods-import.ts comment at the belt; tests/unit/ikki-eshik-fix-review.test.ts «kept: a TOTAL heavier than the lines (a pallet, one carton’s column) is refused»; ikki-eshik-as-built-a.test.ts «the belt: …»; corpus c3072.

**The judge's fix.** State X5 as superseding «never corrected» for ONE case and keep the rest. Per carton is concluded only when the sheet has a carton column and Σ(value × cartons) meets the TOTAL by `contradicts`' own rounding (no second tolerance). Otherwise the line figures STAY, the Σ stays null, and the column is asked once per file with the per_or_total buttons: «G.W. ustuni: jami qatorida 300, qatorlar yig‘indisi 266 — qatordagi og‘irlik bitta karobkanikimi?» — «bitta» → per carton (no carton column → cleared and asked), «hammasiniki» → kept. Re-anchor the two belt tests by name; add the pallet sheet to the corpus with its row weights.

**Ruling — release 1a.** Accepted — X5 supersedes «never corrected» for ONE case (a carton column and Σ(value × cartons) meeting the TOTAL by the belt's own rounding); otherwise the line figures STAY and the column is asked once per file. The pallet sheet joins the corpus.

### JR-12 — defect — M7; §2.3 «Σ … offered as the shipment's brutto (karobkalardan)»; owner question 2

**Objection.** M7 makes the shipment's weight «the rows' Σ … labelled (qatorlardan)» on rastamojka. Row weights are NETTO; SAKKIZ-R2 2.7 b is «brutto is ASKED, never summed — a Σ would be a different, smaller number», restated in code. The request has no column saying a weight was derived (the cube has volumeFromLines), so after the landing the netto Σ is the job's brutto: a VED who moves the section to podklyuch prices the road on it. And «no longer hold Ma’lumot to‘liq» is not a table-only change if done in REQUIRED_FIELDS: that list is the web checklist's, the queue chips', the card form's and the plain summary's — the plain door must not change. Question 2 tells the owner none of this.

**Evidence.** intake.ts missingFields comment («The weight is ASKED, never summed: line kilos are netto and the truck's are brutto (his 2.7 b)»); REQUIRED_FIELDS.rastamojka = weightKg, volumeM3, goods, itemMeasure, lineNeed; consumers: src/app/(protected)/hisoblash/page.tsx:157 and [id]/page.tsx:304-312; prefill.ts («the section moved since the job was queued»).

**The judge's fix.** M7 touches the AI table only: on section rastamojka, door 'ai', the two totals rows are drawn ℹ️ and left out of `complete`; REQUIRED_FIELDS, missingFields, the plain summary and the web chips are untouched. No Σ of row weights is written into `weightKg`: the row may print «qatorlar yig‘indisi (netto): 480 kg» as information, the brutto stays asked. §2.3's carton brutto is a real brutto: draw it as M5's question [✅ Ha, butun yuk] and write it as the totals answer on the press, labelled on the card note. Reword question 2: «brutto so‘ralmaydi — kerak bo‘lsa VED so‘raydi».

**Ruling — release 1b.** Accepted — M7 touches the AI table only (door ai, section rastamojka): the two totals rows are ℹ️ and out of `complete`; REQUIRED_FIELDS, missingFields, the plain summary and the web chips are untouched.

### JR-13 — defect — A1, A2, A4 — which door, which list, which tests

**Objection.** A1 flips one flag; the doors and readers are not named. (1) IKKI-ESHIK §0.2: NULL (card form, thread, agent, pre-0141) keeps today's words — A2's wider list and A4's one-step would reach NULL requests unless bound to 'ai'. (2) The add door computes `askedSeqs` with lawAsksOf by itself: the reply asks rows 1-3, the add table routes a bare «300 dona» to the law's row only. (3) The plain door's note takes the same `asks`. (4) Twelve test files pin «no ❓ / VED xodimi sizdan so‘raydi» for door 'ai'; §5 lists none. (5) Words that still promise the old rule: «kod yo‘q — AI hisoblashda topadi (topolmasa VED qo‘yadi)», IKKI-ESHIK §3.1 last bullet, §3.7 «no ❓ after».

**Evidence.** prefill.ts:329 `noAsk = door !== null`, :634 lawAsksOf, :673 the note's asks; calc-amend.ts:556 `lawAsksOf(lawAsksInputOfStored(stored))`; ai-reply.ts:586/609/675, estimate.ts:283, prefill-reply.ts:193, tail-words.ts. Tests naming noAsk or the words: unit ai-reply, law-asks, estimate, freight-answer, prefill-reply, calc-add-buttons, ai-note, calc-plain-door; integration calc-prefill, calc-pass-settle, customs-estimate, feed.

**The judge's fix.** Write into A1-A4, the door read from the ROW (§0.3): 'ai' → ❓ from sellerAsksOf, NULL's seller tails, one-step replies. NULL → today exactly (lawAsksOf, today's tails, a reply opens the table). 'plain' → unchanged; its note keeps lawAsksOf; a reply's words go through amendWords(door). ONE list per door, read by the reply, by the add door's askedSeqs and by A4's payload; an answer with no asks payload (sent before the deploy) always opens the table. Add an IKKI-ESHIK §6-style table of the twelve files; add to «superseded»: 5a for 'ai', §3.1's last bullet, §3.5's noAsk, §3.7; reword the code-gap line.

**Ruling — release 1a.** Accepted — the door is read from the ROW: ai → ❓ from sellerAsksOf and the NULL door's seller tails; NULL → today exactly; plain → unchanged. ONE list per door. The twelve test files are P-ask-A's re-anchors; IKKI-ESHIK gains its «superseded» lines.

### JR-14 — defect — Status «No migration (ledger stays 146)»; A4 second (wait kind `ai_answer`); M15

**Objection.** A4's plain-text wait is a telegram_chat_waits row of a NEW kind. That column has a CHECK listing eight kinds, widened by a migration each time (0138, 0141). Without one the INSERT fails 23514, is logged once per process and swallowed: the wait lives in memory and is lost at the next deploy — the opposite of «durable». So the round has a migration (ledger 147) or this item is not built. Its key is (chat, kind): with two asking answers in one chat a bare «300 dona» goes to the newest — a figure meant for another job, written at once. M15's warm call cannot be billed either: the ai_calc_passes kind and anchor CHECKs refuse an intake row with no request and no note.

**Evidence.** migrations/0141_intake_door.sql:23-27 (CHECK: task, staff_entry, ad_visit, cabinet_link, agent_edit, agent_price, agent_code, burst); platform/telegram/waits.ts WaitKind, armWait → queueWrite (catch: «[bot] wait not written to the table», once); reply-door.ts header («The bot NEVER trusts an id from the chat. A reply names the message it answers»); 0144_tarkib_takliflar.sql:70-83; ai-cost.ts aiCalcBudgetLeft counts intake rows.

**The judge's fix.** Decide in the Status line: (a) migration 0146 widening telegram_chat_waits_kind_check with 'ai_answer' (every kind kept), ledger 147, and a probe so code ahead of it falls back to «reply qilib yozing»; or (b) A4-second leaves this round. If built: the wait names ONE request; a second asking answer inside the window drops it and a bare text is told «Qaysi so‘rovga? AI xabariga reply qilib yozing». M15: the warm call writes NO ledger row (logged with its token counts), is outside the day's budget, is skipped with no key, and runs after worker registration in its own try/catch — never awaited by startBoss.

**Ruling — stated, not built.** Accepted as (b): A4's plain-text wait (a new telegram_chat_waits kind) needs a migration and leaves this round. M15's warm call writes no ledger row.

### JR-15 — defect — M3 (density doubt), X10 first, M1, M18 — each new «holds Ma’lumot to‘liq»

**Objection.** Each hold checked for a way out on a phone. (a) M3: density outside 20…1500 kg/m³ «holds until answered» — no button and no accepted words; tiles (the design's own «Kafel»), metal parts, stone and drums of liquid are past 1500 as a matter of course, so their table can never read complete. (b) X10 asks «1-qator «XJ-200» — bu nima?», but by T10 a plain «1: ofis stuli» is appended to the NOTE; only the unprompted word «nomi» renames, so the natural answer leaves the hold standing. (c) M1's «✖️ Kerak emas» and M18's «Yo‘q» are not said to survive a re-read: «➕ Yana ma’lumot» → «Bo‘ldi» raises the same offer again. (d) Nothing says what LANDS when «✅» is pressed over a standing offer or doubt.

**Evidence.** Design M3, X10, T10, M1, M18. intake.ts table closing: `complete = warnRows.length === 0 && !totalsWarn`, and a whole-but-incomplete table keeps «✅» with vedLine — so these are holds of the words, not of the press. SAKKIZ-R3: lineAnswers / placeByName exist because a re-read rebuilds the facts. His freight tariff has bands up to 999 kg/m³ and a 1000 step (CLAUDE.md, phase B).

**The judge's fix.** (a) Density is a doubt with two buttons [✅ To‘g‘ri] [✍️ Tuzataman], remembered with the two figures it judged, re-asked only when one changes, never raised over figures the seller typed himself. (b) On a nameIsArticle row «N: <words>» with no figure IS the rename («Ofis stuli (XJ-200)») and clears the flag; the question's example shows it. (c) Every acceptance or dismissal (M1, M18, M5, density, per_or_total) is stored like lineAnswers, keyed by the row's name key or photo number, and re-applied after a re-read. (d) One sentence per hold: «✅» pressed lands the stated figures and the card note says «javob berilmagan: …».

**Ruling — release 1b.** Accepted — every hold has an exit a phone can take; every acceptance or dismissal is stored like lineAnswers and re-applied after a re-read; «✅» pressed over a standing ask lands the stated figures and the card note says «javob berilmagan: …».

### JR-16 — defect — M1, M3, M4, M5, M18, T5 — their buttons; IKKI-ESHIK §3.4; SAKKIZ-R3 §1 (callbacks)

**Objection.** Six items add inline buttons — add/skip per photo good, two per `differs` doubt, two per size_of / per_or_total question (up to five), M5's two, M18's two, T5's one per figure — and none names its callback, where it is drawn or its redelivery class. The AI door has ONE table and no echo message; its keyboard already carries ✅, 📄, ↩️, ➕, ✖️ (and 🔄 / 👤). A dozen more rows on a phone bury «✅». A press on a table redrawn since — the question struck, the rows renumbered by a re-read — must not act on another question, and an unparsed callback spins about 15 s (#939). CALC_STEP_REPEAT is a Record over every step, and two derived fences read every callback_data.

**Evidence.** docs/IKKI-ESHIK.md §3.4 («ONE short reply carries only the refused or asked parts … c:pick_N buttons (offersMessageId = that reply)»; the undo `cu:<tag>` re-rendered with each edit), §1.3 (retired callbacks stay parsed); docs/SAKKIZ-R3.md §1 «Telegram's 64-byte callback_data parses … CALC_STEP_REPEAT», K7/K11/K12; IntakeState.offers (pick_N only from the message that drew them, regression-23).

**The judge's fix.** Name them in §3.3: one family `c:q_<tag>_<a|b>`, <tag> a stable id minted when the question, offer or doubt is created (never its position), each with a class in CALC_STEP_REPEAT and parsed by both derived fences; a press whose tag is gone answers «Bu savol yopilgan». The table keyboard draws the buttons of ONE open question at a time — the first unanswered, «1/4» on its line — the next as each is answered; a typed answer stays possible for all. T5 reuses the existing totals-doubt buttons. Pin: answer q1, re-read renumbers the rows, press the old q2 button → nothing is written.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted, with JS-6 and JB-7 — ONE callback family resolved by a TAG minted when the ask is created, parsed by both derived fences, «Bu savol yopilgan» for a tag that is gone; the keyboard draws the buttons of ONE open ask at a time.

### JR-17 — defect — T9, T10 (first collection), T6 — «echoed … ↩️»

**Objection.** (1) T10's rename / remove / words are «answers», but are not said to be STORED as answers. SAKKIZ-R3 keeps lineAnswers, totalsAnswer and routeAnswer because a re-read rebuilds `facts` from the material: after «➕ Yana ma’lumot» → «Bo‘ldi» a removed row returns and a renamed one gets its old name back. (2) T9 «nothing readable → filed as material and the reading re-queued»: a paid reading (up to 12 photos) started by any text — «ok», «bilmayman» — where every reading is the seller's «Bo‘ldi» press and a courtesy word is never material. (3) T6/T9/T10 say «echoed with ↩️»; the AI door has no echo message. (4) T9 and T10's 📷 rename narrow SAKKIZ-R3 §0.1(3) without citing it.

**Evidence.** calc-intake.ts lineAnswers comment («the re-read rebuilt the goods from the material and threw every typed count and weight away»), placeByName; docs/IKKI-ESHIK.md §3.4 («The echo MESSAGE goes; its record stays»; CHAT-4: a courtesy word is «never material (its re-read was billed and held the ✅)»), §1.4 (readMark; the prompt carries «Bo‘ldi»); docs/SAKKIZ-R3.md §0.1(3) («A table answer is never material … a number whose words name a different row is asked»).

**The judge's fix.** T10's three verbs are lineAnswers entries — `patch.name` (the ORIGINAL name kept as the key), `patch.removed`, `patch.noteAdd` — re-applied by placeByName on every re-read and undone by their echo tag; a removed row is listed «✖️ 1 ta qator olib tashlandi». T9: rows the typed reader finds are kept as material AND the readMark moves (no «⬇️ … qayta o‘qiladi»); unreadable text is filed as material and the ONE prompt with «✅ Bo‘ldi» is drawn below — no reading without the press; a plainAck word gets §2.2(b)'s line. Replace «echo» by «the table's last block and its ↩️ (NULL door: today's echo)». Cite §0.1(3) as amended for a zero-row table and 📷 rows.

**Ruling — release 1b.** Accepted — T10's three verbs are lineAnswers entries re-applied on every re-read; T9 never starts a reading (JS-21); «echo» is «the table's last block and its ↩️».

### JR-18 — defect — M6 (known_figures) — second priority

**Objection.** `{ n, weight_kg, volume_m3, cartons }` fills an Excel row's EMPTY cells from a photo. The weight has no kind. A photographed packing list states G.W.; the row's weight column is netto (customs). IKKI-ESHIK §1.2.2 (INT-10): a held row with no weight takes a second source's line weight «only from a NET column. Never from gross» — and packingFills, which M6 says it follows, takes the file's weightKind for exactly that. M6 has none to give it: a brutto would land as the row's customs weight and a per-kg baza multiplies it. `n` is the model's index answer and needs known_codes' re-check against the row it was shown.

**Evidence.** docs/IKKI-ESHIK.md §1.2.2 («A held row with NO weight…»); platform/telegram/calc-files.ts:676 `packingFills(held, kinds, goods, meta.weightKind)`; intake.ts CalcGoodsFact.weightKg («What THIS line weighs NET»); intake-ai.ts knownCodesOf (the index re-check); design M6.

**The judge's fix.** known_figures carries `weight_kind` (enum net | gross | unknown — not a union, the schema budget holds) and goes through the kernel: `cartons` → the row's packing (from 'ai'); volume → the empty cell; weight → the row only when `net`; gross or unknown → derived.grossKg, the note «rasmda brutto 165 kg» and the brutto question, never the row's weight. Each index is re-checked against the row shown (knownCodesOf's rule); a cell the seller answered is never filled. Corpus scenario: an Excel row without weight + a photo with G.W. 165 → the row's weight stays empty.

**Ruling — stated, not built.** M6 leaves this round (see JN-19).

### JR-19 — defect — M4 `aiQuestions`, M10 `materialFrom`, the new goods fields — collections open at deploy, and a rollback

**Objection.** Size is SOUND; two gaps in shape. (1) A collection open at deploy has no `aiQuestions`; M4 calls it «durable like steps», a required array. Every earlier round defaulted its new fields in migrateIntakeState and pinned a hydrate test; this design names neither. Read as `.length` on an old row it throws in every table draw of every collection open at deploy. (2) Rollback: old code keeps the unknown keys but reads `derived`, doubts, offers and questions as nothing — a figure the bot computed stands as stated and unlabelled, «✅ Ma’lumot to‘liq» is drawn over an open doubt, and the new buttons are unparsed callbacks.

**Evidence.** Ran migrateIntakeState on a state without the new fields: `aiQuestions` and `materialFrom` stay absent (it defaults fileTotals, fileNotes, goodsFiles, aiCut…, landAs only). Measured: packing + derived + marks add 433 bytes a row; 500 rows × 2 copies (invoiceGoods, facts.goods) = +0.41 MiB → about 1.13 MiB against the R3 drill's 0.72 MiB (2.58 MiB wrote in 98 ms max, SAKKIZ-R3 §20.3) — well inside the 2 s confirm.

**The judge's fix.** Add to M4/M10: every new state field gets its empty value in migrateIntakeState (the ONE place) and in the new-collection factory; a unit test hydrates a pre-round row in 'review' and in 'material', draws the table and presses «✅» and «➕» (IKKI-ESHIK §1.3's pin). Deploy notes: after a rollback, open AI collections are re-read («➕ Yana ma’lumot» → «Bo‘ldi») — computed figures otherwise land unlabelled. Re-run R3 §17.6's drill with 500 packed rows and record the number in §5.

**Ruling — kernel (the lead, before the packages).** Accepted — every new state field gets its empty value in migrateIntakeState and in the new-collection factory, with a hydrate test of a pre-round row; the R3 drill is re-run with 500 packed rows.

### JR-20 — nit — §3 «a case that must change is changed with its reason» — the corpus count is not given

**Objection.** Builders are told to run the whole corpus, not which pins the design itself moves or must not move. Found by searching the fixture. MOVE (5): c1935 (L|W|H under «MEAS (CM)» + CTNS: cube pinned null → 1.08 / 0.432, X3-X4); c3101, c2469, c2470 (a lone / «IN CTNS» / «/мест» carton column pinned as quantity + unit → packing.cartons, X2); c1357 (code + goods in one text at the customer question, T13). DECIDE (1): c0649 («Kurtka 45 karobka» pinned as no row, #24; T6-T8 want a row with a packing). MUST STAY (35): T0 against spaced TNVED and phone digits — c0298, c0302, c0731, c0732, c0958, c0962, c0986, c1548-c1551, c1556, c0715, c0718, c0957, c0961, c0982, c1557; T4/T7 against box words as products — c0690-c0693, c0695, c0696, c0872, c0926, c0927, c1529, c2071, c2073, and as sheet rows c2804, c2806; «Total» the brand — c0873, c0874; the belt — c3072.

**Evidence.** tests/unit/fixtures/intake-corpus.json searched by spelling (karobka / ctn / мест, har biri, N×N×N, cbm / kgs, G.W., TOTAL, currency, URL, space-grouped digits); each listed case read with its expected value and «why». No typed-reader case holds «cbm»/«kgs» as a refused total, a size token, a URL or a tonne whose answer the design reverses; the currency cases (c0357, c0364, c0365, c0660, c0664, c0665, c1535-c1537) keep theirs.

**The judge's fix.** Put the list in §3 as the up-front count: 5 cases move (each with its reason, in intake-corpus-known.ts's style), 1 is decided by the lead before P-typed starts, 35 are named guards that must stay green through T0 / T3 / T4 / T7 / X5. Name the two belt unit tests beside them (ikki-eshik-as-built-a «the belt…», ikki-eshik-fix-review «kept: a TOTAL heavier than the lines…»). T13's pure function takes «is this code in the book» as an input, so c1357 can state both answers.

**Ruling — release 1a.** Accepted — §3 names the corpus cases that move (5), the one the lead decides (c0649) and the 35 guards that must stay green.

### JR-21 — nit — M13, X10 second, M11 — the named tier's words and the wholeness predicate

**Objection.** M13 names a refused voice note or video in refusedFiles as «video», «ovozli xabar», «dumaloq video», «audio». The named tier quotes every name as a FILE unless it is one of three made-up names, and ends «undagi tovarlar hisobga kirmaydi». X10-second and M11 count row pictures and tiles «against the twelve»: a workbook with 40 row pictures, or three long screenshots, is told «N ta rasm o‘qilmadi (12 tadan ortiq rasm) — ulardagi tovarlar hisobga kirmaydi» though its rows are all in the table, or five pictures were sent. And row pictures placed in `state.images` make a mapped Excel «model-only material»: no key or a spent budget takes «✅» off a file whose rows read fine (FAYL-OQISH §1.1).

**Evidence.** Ran refusedFileLines([{name:'video'…},{name:'ovozli xabar'…}]) → «video» o‘qilmadi (…) — undagi tovarlar hisobga kirmaydi.; «ovozli xabar» o‘qilmadi …. intake.ts:1348 madeUpName = 'rasm' | 'fayl' | /^\d+ ta /. reading-whole.ts modelOnlyMaterial (`state.images.length > 0`, then model_failed when !aiUsed). docs/FAYL-OQISH.md §1.1 («mapped Excel rows alone … read without the model»).

**The judge's fix.** madeUpName learns M13's four names (one exported list) and their line ends «— yozib yuboring», not «undagi tovarlar…». A workbook's row pictures live in their own state field — never `images`, never the 12-photo refusal: an unread one only leaves its row's «bu nima?» ask. M11's tiles count as ONE picture toward the twelve (the cap is on what the seller sent); the request's byte budget limits tiles on its own, said as «skrinshot juda uzun — bo‘lib yuboring».

**Ruling — release 1b.** Accepted — M13's four names join madeUpName and end «— yozib yuboring»; a workbook's row pictures live in their own state field; M11's tiles count as ONE picture.

### JR-22 — nit — Lens point 7 — the web screens (/hisoblash queue and card, four locales)

**Objection.** No item names a web screen; three can reach one through shared homes. `missingFields` feeds `t(FIELD_LABELS[field])` on /hisoblash and /hisoblash/[id]: a new CalcField for «what goods», an article name, a doubt or the certificate would be a chip no web control can clear (#649, #910) and a runtime key that throws at render where a bundle lacks it. A new CalcError from the certificate or note write needs `calc.errors.<code>` in four bundles. T14's tonne and gram words enter units.ts, which the web paste and the VED's unit handling read too. M16's «asked BOTH its count and its weight» must not enter lineNeeds, whose one-measure rule is #910's.

**Evidence.** src/app/(protected)/hisoblash/page.tsx:157-160 and [id]/page.tsx:304-312; wms/calc/labels.ts FIELD_LABELS: Record<CalcField, string> (anchored by tests/unit/calc-queue.test.ts:93 and locales.test.ts); intake.ts CalcField comment («ONE field, not two, and the first version got that wrong»); docs/SAKKIZ-R3.md §1 «A refusal is words» (calc-error-words.test.ts).

**The judge's fix.** One sentence in §3.3: no item adds a CalcField or changes REQUIRED_FIELDS / lineNeeds; every new hold (📷, an article name, doubts, offers, the AI's questions, M16's second measure) lives in the bot's TableInput only. A new CalcError code ships with `calc.errors.<code>` ×4. T14: say whether the web paste gains «t → kg» as well (then with its test) or the scaled words are read by the bot's typed readers only.

**Ruling — release 1a.** Accepted — no item adds a CalcField or changes REQUIRED_FIELDS / lineNeeds; every new hold lives in the bot's TableInput. T14's scaled words are read by the bot's typed readers only.

### JR-23 — nit — T15, M17, M13 — messages of their own beside the ONE prompt; M17's scope

**Objection.** Three items answer at arrival with a message of their own: the link refusal, «✏️ Tahrirlangan xabar o‘qilmaydi», a voice or video refusal whose caption is taken. IKKI-ESHIK §1.4: a refusal is the collection's own message and the ONE prompt is drawn BELOW it, or «Bo‘ldi» sits above a later message. T15's link is «kept on the card for the VED, not counted as material» with no field named, while the prompt's counts and the card note are pure functions of state. M17 speaks «in a chat with a live collection»: that includes the plain door, which must not change, and a parked collection, which takes nothing and says one pause line.

**Evidence.** docs/IKKI-ESHIK.md §1.4 («A file gets its own message only for a REFUSAL»; as built CHAT-7: a refusal joins the collection's messages and the prompt is drawn below it), §4.2 (parked: one pause line); platform/telegram/kept-last.ts; calc-intake.ts `answers`, `fileNotes`, `refusedFiles` — the fields the card note is built from.

**The judge's fix.** Say for each: the refusal is recorded with noteOwnMessage and the prompt is redrawn below it through kept-last; in the table stage it is one line under the table and nothing else moves. T15's link is stored in `fileNotes` («🔗 havola: … — ochilmaydi»): on the card and in the prompt, not in `material`. M17: either state it as shared by both doors, like IKKI-ESHIK §1, or limit it to 'ai'; a parked collection says nothing; once per edited message id, kept in the collection.

**Ruling — release 1b.** Accepted — each refusal is recorded with noteOwnMessage and the prompt redrawn below it; T15's link is kept in `fileNotes`; M17 is the AI door's and a parked collection says nothing.

#### What this lens found SOUND

- Size of the durable state: packing + derived + marks add 433 bytes a row (measured); the R3 worst collection grows from 0.72 to about 1.13 MiB, far under the 2.58 MiB / 98 ms the drill wrote — the 2 s confirm and the 1 s stop flush hold.
- «The model never reaches a number» (ai-advisory.test.ts): no item writes a model output into a rate, a baza or a price; prefill writes no provenance; M5 and M18 write only on a person's press; a weight the model READ landing on a row is today's aiGoodsLine behaviour.
- SAKKIZ-R2 «estimates are written onto no row»: nothing in the design writes the 📊 median or a guessed zone onto a row.
- A1's one flag: every renderer (customs and road tails, the JAMI line, the 📊 block's refused_measure, the lenta head, lentaUnasked) follows prefill.ts:329 — no second place decides who a tail is addressed to.
- The question block cannot break the 4096 fit: questionsOf keeps five at most and clips each to 200 characters.
- M2's keyboard (➕ and 👤 on a zero-row table) is FAYL-OQISH §1.2's; M5 asks instead of landing a model total beside a fold (§3.7); M9 agrees with IKKI-ESHIK §1.4 (readMark / nothing new to read).
- A3 (one numbering by seq) is SAKKIZ-R3's own rule («a stored row's number is its seq»); A4's once-key by the reply's message id fits Q5 a (calc_amendments.note_id UNIQUE), and its waiting / to_ved / refused outcomes are amendRequest's; an applied one-step reply still trips amended_since on the VED's four doors.
- The plain door: no item as written changes its summary, its silent pass or its money-free note — given the door scoping asked for in JR-12 and JR-13.
- takenUpTo / HOLD_MS / flushBeforeConfirm: the new fields ride the same state object and the same write chain; A4's one-step reply opens no collection, so nothing new holds the chat.
- What the VED sees after a one-step reply is what «✅ Qo‘shish» shows him today — a thread line, the card note, his four doors refusing over a stale screen — once per reply instead of once per table.
- §6 item 5 (an offer on material sent with no door pressed) is stated, not built; «one question per burst» is untouched.
- T3's word list: volume, gross, net, total, ctns, gw, nw are already in NOT_GOODS_WORDS and the rule is «every word of the name», so «Rubik cube» or a labelled «Tovar: Total» keeps its row (corpus c0873, c0874).
- The legacy contract latch: the zod reader takes both answers, and a collection read under either contract draws a table.
- i18n: the bot's new words are Uzbek literals in code; no item as written needs a bundle key.


## Lens «seller» — five conversations walked as the seller, then the words, then his four sentences

### JS-1 — blocker — T4 (and §2.3 kgPerPiece)

**Objection.** T4 lists «har biri», «har bir», «each», «каждая/каждый», «dan» as PER PACKAGE marks, always, and with no carton count on the line asks «nechta karobka?». The commonest typed line has only pieces: «Telefon 300 dona, har biri 0.2 kg» — each PIECE. The bot asks «nechta karobka?», he says 20, and the row lands 20 × 0.2 = 4 kg instead of 60 kg, marked «hisoblangan», under ✅ (customs is kg × baza). In C («Kurtka 300 dona, 20 karobka, har biri 15 kg») the same words are per carton (300 kg; per piece it would be 4500 kg). The design has no rule to tell the two apart, and the kernel says the opposite of T4.

**Evidence.** AI-SORAYDI.md:286-292 (T4). carton-math.ts:60-64: «a typed «har biri 4.5 kg» beside a piece count» is kgPerPiece. Ran applyPacking in a scratch test: telefon by T4's path (cartons 20, kgPerCarton 0.2) = 4 kg, by kgPerPiece = 60 kg; C per carton = 300 kg, per piece = 4500 kg. Today parseManualFacts('Telefon 300 dona, har biri 0.2 kg') gives the shipment 0.2 kg.

**The judge's fix.** T4, binding: an each-word binds to the count noun it stands with. Only pieces on the line → kgPerPiece (pieces × X, «hisoblangan: 300 × 0.2 kg»), never «nechta karobka?». Only cartons → per carton. Both counts → the nearest PRECEDING count noun («20 karobka, har biri 15 kg» → carton); when neither is nearest, a doubt with two buttons: «15 kg — [📦 1 ta karobka] [1 dona]». A tail «/dona», «/шт», «/pc» = piece; «/karobka», «/ctn», «/箱» = package. Corpus: both lines above and «300 dona har biri 0.2 kg 20 karobka», each with its answer.

**Ruling — release 1a.** Accepted (= JN-7).

### JS-2 — blocker — §2.3 (PR-12 against DIM-11) and T6

**Objection.** §2.3 says a product's own size «Стол 120×80×75, 10 коробок» computes nothing — and, a few lines down, that a size is the PACKAGE's when a carton word (karobka, коробка, 箱…) stands on the same row or segment, which that very line has. For TYPED text nothing else sets CartonSize.of. Built by the second rule, «Stol 120x80x75 sm, 10 karobka» lands 10 × 0.72 = 7.2 m³ «hisoblangan» under ✅ (the design's own «cube nobody shipped»; on podklyuch it prices the road). Built by the first, B's caption «stul 20 karobka 60x40x50» and C's line compute nothing and his sentence 3 stays true.

**Evidence.** AI-SORAYDI.md:196-201 against :210-215; T6 (:299-307) shows only package examples. carton-math.ts parseSize returns a BARE size («the CALLER says whose it is»); ran it on B's caption, C's line, E's line and «Stol 120x80x75 sm, 10 karobka» — a size each time, no owner. tests/unit/carton-math.test.ts:306-323 pins that of:'product' and of:null multiply nothing.

**The judge's fix.** ONE owner rule for typed text, written into T6 with corpus cases. package = a package word next to the size («karobka o‘lchami 60x40x50», «60x40x50 karobka»), OR the size directly follows or precedes the carton count with only spaces / «ta» / a length unit between («20 karobka 60x40x50», «60x40x50 sm 20 karobka»), OR it continues an each-clause bound to the cartons, OR it answers the bot's own cube question. A size right after the NAME and before any count («Stol 120x80x75, 10 karobka») = of:null → asked with the two buttons, each showing its result. Never «a carton word somewhere on the line».

**Ruling — release 1a.** Accepted — ONE owner rule for typed text: package = a package word next to the size, or the size directly beside the carton count, or it continues an each-clause bound to the cartons, or it answers the bot's own cube question; a size right after the NAME and before any count is of: null → asked. Never «a carton word somewhere on the line».

### JS-3 — blocker — M4 and §2.2 (the questions key of the committed contract)

**Objection.** A model question's n is an index into the model's OWN goods. The table numbers rows after the merge: Excel rows first, typed rows merged in, a photo's good appended or only offered. M4 draws the block «with addresses» and its buttons act on a row («bitta» moves the figure into the packing and recomputes); no item maps n to the table's row. D plus a carton-label photo: Excel rows 1-2, model goods[0] «Обувь детская» 0.083 m³, question {n:1, per_or_total}. Drawn «1-qator», the press multiplies XJ-200's stated 2.4 m³ by its 20 cartons = 48 m³, under ✅. And a question about an Excel row cannot be asked at all: its n is not in goods, so it is filed under the shipment.

**Evidence.** intake-ai.ts:320-331 («row is the INDEX into the reading's own goods»); the schema's n: «номер товара в goods (с 1); 0 — про всю отправку». Ran questionsOf([{n:2,kind:'per_or_total'}],1) → row null; with goods = 0 (an Excel-only reading) every question → row null plus the log line «a question names a row the answer does not have». calc-intake.ts:1215-1245 (pickGoods: invoice rows first, a model line beside an Excel named or added after).

**The judge's fix.** Kernel: a question gains a required, non-null enum `list: 'goods' | 'known'` (no union — inside the budget); prompt: «n — номер в goods или в списке уже взятых». The merge keeps, for every model good and known row, the table index it ended at (the map known_codes already needs); M4 stores that index or null. A question whose row the merge dropped or cannot place is drawn with NO address and NO buttons (text only; its answer goes to the note). Test: Excel of 2 rows + a photo good + per_or_total → the button acts on row 3 or is not drawn.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted (= JR-2): `list: goods | known` in the contract; a question whose row cannot be placed is drawn with no address and no buttons.

### JS-4 — blocker — T10 (with M4)

**Objection.** T10 makes «N: yo‘q» DELETE row N, and on a 📷 row makes any «N: <words> <figures>» a RENAME. M4 at the same time asks the seller questions addressed «N-qator: …?». In A the table asks row 1 its count and the AI asks «nimadan qilingan?»; he answers both in one line, «1: plastik, g‘ildirakli 20 dona 300 kg» — row 1 is renamed «plastik, g‘ildirakli» and the chair is gone. An `other` question «1-qator: batareyasi bormi?» answered «1: yo‘q» deletes the row; after ✅ the good is in no calculation. Whether words rename or annotate hangs on whether a figure stands beside them — nothing a seller can know.

**Evidence.** AI-SORAYDI.md:325-329 (T10) and :453-462 (M4). Ran today's parseTableAnswer over a one-row table: «1: yo‘q» and «1: plastik, g‘ildirakli 20 dona 300 kg» are name_mismatch refusals — nothing is lost today; the design turns both into writes.

**The judge's fix.** T10: delete only by «N: o‘chir» / «N: olib tashla» / «N: удали» — never «yo‘q» / «нет». Rename only by «N: nomi …», or by plain words on a row whose OPEN ask is what_goods / «bu nima?». Everywhere else words beside figures go to the NOTE and the figures are written. «ha» / «yo‘q» addressed to a row with an open AI question answer that question (struck; note «AI: …? — yo‘q»). Every rename and delete is echoed with the old name and ↩️: «✏️ 1-qator: «Стул офисный» → «…»», «🗑 2-qator o‘chirildi: «…»».

**Ruling — release 1b.** Accepted — delete only by «N: o‘chir» / «olib tashla» / «удали»; rename only by «N: nomi …» or by plain words on a row whose OPEN ask is «bu nima?»; elsewhere words beside figures go to the NOTE and the figures are written; «ha» / «yo‘q» to a row with an open AI question answer that question.

### JS-5 — blocker — A7, A5, A4 (T10 forms in a reply) against docs/SAKKIZ-R3.md §0.1(2)

**Objection.** SAKKIZ-R3 §0.1(2) — his ⭐ answer to its Question 3 — binds: «The add door never writes a price, a rate, a zone or a certificate. It writes the seller's figures, an empty code, new goods lines, and the totals or cities.» A7 writes has_certificate from a reply (it moves the additional duty — the figure he tells the customer); A5 appends to a stored row's NOTE; A4 lists T10's forms (rename, delete) among the reply answers — all through that door's one writer. The design nowhere says it reverses R3, and §7 does not ask him: §0 names only the IKKI-ESHIK §3.5 reversal.

**Evidence.** docs/SAKKIZ-R3.md:140-142, and :5113 under «stated, not built»: «The add door changing a price, a rate, a zone, the certificate or a code that exists (§0.1(2), ⭐ of Question 3)». amend.ts:60; amend.ts:522-526 — a note is written only for the lone-weight copy, under its own compare-and-set, «any other edit's note would REPLACE the stored one». AI-SORAYDI.md:29-30, :575-577, :588-591, :598-601.

**The judge's fix.** §0 states the second reversal in words; §7 asks him (text in JS-28). Until he answers, A7 is NOT built: the answer keeps «📄 Sertifikat: bor (deb hisoblandi)» and a disputed certificate goes to the VED as words. A5's note write: append-only, under the note's own compare-and-set, with its own echo. T10's rename and delete apply only to rows not yet stored (seq null); on a stored row they go to the VED: «📝 VED ga yuboriladi: 2-qatorni o‘chirish so‘raldi».

**Ruling — waits on the owner's answer.** Accepted (= JR-8, JB-4) — the second reversal is named in §0 and put to him; A7 waits.

### JS-6 — blocker — T5, M1, M3 (differs), M4 (size_of, per_or_total), M5, M18 — every new button

**Objection.** Seven kinds of two-button questions are drawn on the ONE table, several at once (five AI questions alone), and the design names no callback, no state and no redelivery class. T5 cites «the existing totals-doubt machinery, asked(field)» for its buttons: that machinery has none. The only button machinery is offers + c:pick_N: six positions, a {unit, value, target} shape none of size_of / per_or_total / Ha-Yo‘q / ➕ fits, valid only from offersMessageId, and REPLACED by the next typed answer — so each such button says «Bu tugma eskirgan» after his first typed answer. Addressed by position on a table edited in place, a redelivered press answers the NEXT question: «bitta karobkaniki» lands on another row.

**Evidence.** intake.ts:799-806 (a totals doubt is the text «Aniq yozing: …»); calc-intake.ts:1748 (asked is a local lambda), :393 (offers shape), :734 (MAX_OFFERS 6); calc-dialog.ts:1347 (a typed answer replaces offers), :2336 (a pick only from offersMessageId); staff-bot.ts:506-580 and :716 (c:(\w+) over a closed CALC_STEPS). Ran parseCallback('c:ask_0_a'), ('c:size_pkg'), ('cq:a1b2c3d4:1') → null: an unparsed press is answered by nobody.

**The judge's fix.** A new §3.3 item, built FIRST in P-model: IntakeState.asks[] = {tag (4 hex, minted once), kind, row index or field, options[], done}. Callback cq:<tag>:<0|1|2> — its own BotCallback kind with a PRESS_REPEAT class, taken only from tableMessageId, resolved by TAG never by position (≤ 9 bytes; a name or a figure never goes into callback_data). Typed answers do not retire asks; an ask ends when answered, when its row changes, or when a re-reading replaces it. At most 4 button-asks drawn at once, the row number in the label when several («3: 📦 Karobkaniki»). The DERIVED fence in calc-intake-lines.test.ts learns cq:; a test presses a struck tag → «eskirgan», nothing written.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted — IntakeState.asks[] with a tag, callback cq:<tag>:<n>, its own BotCallback kind and PRESS_REPEAT class, taken only from the table's message; at most one ask's buttons drawn at a time (JR-16).

### JS-7 — defect — M3, M4, M16, M18, X10 against Telegram’s 4096

**Objection.** M3 prints each computed figure with its arithmetic on the row and M4 adds an uncut five-question block; nobody re-budgeted the 4096. A model-coded row is ℹ️ and is never folded into «✅ yana N ta qator», so it is CUT. On a 40-row packing list the seller would see about 12 rows; the other 28 — rows whose cube the bot computed «sm deb olindi» or REPLACED (one_carton) — are «… va yana 28 ta qator» above «✅ Ma’lumot to‘liq». M18 offers, M3 doubts, M1 offers and X10's «bu nima?» lines have no cap at all; past the cap fitTelegram slices the END of the message — the ✍️ instructions.

**Evidence.** Ran today's intakeTableText with 40 model-coded rows («name — 480 dona · 300 kg · 2.4 m³ · code (AI taklifi)»): 4082 characters, 35 of 40 rows shown already. M3's three «(hisoblangan: …)» plus «📦 20 karobka» add 120 characters a row and a five-question block 825: (4096 − 486 − 825) / (101 + 120) ≈ 12 rows. fit-telegram.ts:33-50 (the lines go first, then the tail is sliced).

**The judge's fix.** M3: a computed figure carries ONE mark on the row («2.4 m³*») and one legend line («* karobkadan hisoblangan — tafsiloti VED kartasida»); the full arithmetic is printed only while the whole table fits, and always on a row with a doubt. A REPLACED figure and an assumed unit are never hidden — one fixed line each: «🔁 3, 7, 12-qator: hajm bitta karobkaniki edi — ko‘paytirildi», «📏 sm deb olindi: 1-5, 9-qator». Every per-row list (M18, M3 doubts, M1, X10) is that row's ↳ or is capped at LINES_NAMED with «… yana N ta». Test: 40 packed rows → ≤ 4096, the legend and both fixed lines present.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted — a computed figure carries ONE mark on the row («2.4 m³*») and one legend line; a REPLACED figure and an assumed unit each get one fixed line and are never hidden; every per-row list is capped.

### JS-8 — defect — X11, T5, D as a whole

**Objection.** D reaches no item. The sheet has a QTY column, so X11 (a price or MOQ column and NO quantity) does not apply; «shundan XJ-200 300 dona» is then, at the material stage, a goods line the Excel row swallows — XJ-200 stays 480 dona and XJ-350 stays in — and at the table «jadvalda bunday qator yo‘q». T5 compares typed and read TOTALS only, never a row's count. When he then writes «1: 300 dona», the file's 300 kg · 2.4 m³ (stated for 480 pieces) stay on the row under ✅ — customs on 300 kg where 187 is true. X11's own catalogue rows carry ONE carton's G.W. as the row's weight, with no carton count to multiply by.

**Evidence.** Ran today: readGoodsLines('shundan XJ-200 300 dona') → name «shundan XJ», quantity 200300; parseTableAnswer over rows XJ-200 / XJ-350: «XJ-200 300 dona» → no_address (200300), «shundan XJ-200 300 dona» → name_none «shundan»; nameWordFor(XJ-200) → null (an article is no address today). AI-SORAYDI.md:428-431 (X11), :294-297 (T5). CR-8 (the catalogue row «Folding chair — 15 kg»).

**The judge's fix.** (1) T5 covers a ROW: a typed count for a row a file counts differently is a doubt — «XJ-200: faylda 480 dona, siz 300 yozdingiz — qaysi biri?» — never silent either way. (2) A count that REPLACES a file's count on a row whose weight or cube the file stated marks them stale: «⚠️ og‘irlik (300 kg) va hajm 480 dona uchun yozilgan — yangisini yozing», no ✅ until answered or confirmed. (3) The article is an address on EVERY sheet (first priority, not X11-second); «shundan / faqat …» plus articles keeps only the rows named, after one confirm button. (4) A catalogue row's G.W. goes to packing.kgPerCarton and the row asks «nechta karobka yoki jami kg?».

**Ruling — release 1b.** Accepted — T5 covers a ROW (a typed count against a file's count is a doubt); a count that replaces a file's count marks the file's weight and cube stale; the article is an address on every sheet; a catalogue row's G.W. goes to the packing.

### JS-9 — defect — X10 (with T10, M1 and the committed known_codes)

**Objection.** X10 asks «1-qator «XJ-200» — bu nima?» and says it is «answered by T10's rename». The natural answer «1: ofis stuli» is, by T10, words with no figure and no rename word — appended to the NOTE: the row stays «XJ-200», nameIsArticle stays, the question stays. The same block tells him «rasmni alohida yuboring»; when he does, the model's name is a NEW 📷 good that M1 offers as «➕ Rasmdagi … ni qo‘shish» — a duplicate row with no figures — because the committed contract cannot hand a NAME to a known row. In D his first sentence («rasm … nima tovar borligini bila olmayapti») is still true after every first-priority item.

**Evidence.** AI-SORAYDI.md:418-426, :325-329. intake-ai.ts (FACTS_JSON_SCHEMA, known_codes): items are {n, tnved_code} only — X10-second's known_codes[].name and M6's known_figures need kernel keys the «binding» kernel does not have. Ran parseTableAnswer('1: ofis stuli') and ('1: nomi ofis stuli') over rows XJ-200 / XJ-350: both name_mismatch today.

**The judge's fix.** On a nameIsArticle row any «N: <words>» IS the name: the row becomes «ofis stuli (XJ-200)», the ask is struck, echo «✏️ 1-qator: XJ-200 → ofis stuli (XJ-200)» with ↩️; the ✍️ example of such a table is «1: ofis stuli». The ↳ text is one constant («nomi yo‘q — bu nima?») so thirty rows fold into one line. The kernel schema gains known_codes[].name NOW (a string, "" = none — no union), so a photo captioned «XJ-200» names row 1 instead of being offered as a new good; M1 offers a photo good only when its caption names no known row.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted — known_codes[].name joins the contract NOW (kernel); on a nameIsArticle row any «N: <words>» IS the name.

### JS-10 — defect — M16 against M4 / T10 / A5; M4’s «in the pass’s ❓ block (A2)»

**Objection.** In A the AI asks «stul nimadan qilingan?» (material; the reading's code is unsure). M4, T10 and A5 say the answer goes to the note and the row is «re-coded at the pass»; M16 says the pass does NOT re-code an unsure-coded row; and the pass codes only rows with NO code — a 📷 row always has one («a code always»). So «1: plastik» changes nothing: the answer comes back with the same code «(AI taxmini — aniq emas)». He was asked for something nobody uses. And M4 sends unanswered questions to «the pass's ❓ block (A2)», but A2's list has no such entry and nothing carries them past the landing (no migration; the collection's state ends there).

**Evidence.** prefill-steps.ts:105-120: `uncoded = rows.filter(r => !tnvedCode)` — only those rows reach the coder. AI-SORAYDI.md:453-462 (M4), :527-531 (M16), :588-591 (A5), :555-567 (A2's list: law unit, no measure, uncoded, totals, certificate).

**The judge's fix.** One rule: a words-answer on a row whose code is the model's AND unsure CLEARS that code at the table (kept on the note: «AI taxmini edi: 9401…»), so the pass codes it from the name and the note; a sure code stays and the words go to the VED. M16's «does not re-code» then covers only rows nobody described. After the landing the same through A5 (the unsure mark is read back from UNSURE_CODE_NOTE on the stored note). Unanswered AI questions travel as one fixed-prefix note line per row («❓ AI: …») that sellerAsksOf reads — or M4 drops the A2 claim.

**Ruling — release 1b + release 2.** Accepted — a words-answer on a row whose code is the model's AND unsure CLEARS that code at the table (kept on the note), so the pass codes it from the name and the note; unanswered AI questions travel as one fixed-prefix note line per row.

### JS-11 — defect — §2.3 «the landing writes … the arithmetic into the row’s note»; A5, T10

**Objection.** Everything the design adds lives in the landed row's NOTE, and the door cuts a note at 500 characters from the END. provenanceNote puts the source's note first and the arithmetic after; the landing appends the AI-code note; A5 and T10 append the seller's words LAST. For one fully packed 📷 row the note is 442 characters before those; with the seller's «plastik g‘ildirakli, ofis uchun…» it is 567 and lands ending «· sotuvchi: p». The words the coding model was to read are the first thing cut — and a slice can halve an emoji.

**Evidence.** Ran provenanceNote on a row with 20 cartons, 2 pcs, 15 kg gross, 60×40×50, a 90-character model note, nameFrom photo, an unsure code: 442 characters; plus AI_CODE_NOTE and the seller's words = 567; doorRow(...).note = the first 500, ending «…tekshiring · sotuvchi: p». door-row.ts:116 `.slice(0, 500)`; workspace.ts:4327 and :4980 carry the same cap.

**The judge's fix.** One budgeted renderer in intake.ts. Order: the seller's words → the source's note (≤ 100) → marks («📷 2-rasm», «kod: AI, aniq emas») → the packing line → the arithmetic. Shortened in that order from the back: the arithmetic first («hisoblangan: hajm, og‘irlik, soni — 20 karobkadan»), then the source's note; the seller's words and the packing line are never cut; cut by code points (clipText), never slice. A5's append writes the seller's words at the FRONT. Test: the row above plus 120 characters of seller words → ≤ 500, the words whole.

**Ruling — kernel (the lead, before the packages).** Accepted — the budgeted note renderer (see JR-9); the seller's words and the packing line are never cut.

### JS-12 — defect — A2 (the certificate line) with A7, A4-second, T11

**Objection.** A2 asks «📄 Sertifikat bormi? («sertifikat yo‘q» deb yozing — hozir «bor» deb hisoblandi)» «when nobody touched the toggle». (1) «Touched» is stored nowhere after the landing — has_certificate is one boolean, default true, and the design adds no column — so it is asked in EVERY answer, also in each «qayta hisob» after he answered something else. (2) A2 is first priority; what makes the instruction work is A7 (second) for a reply and A4-second for a plain text: shipped without them, the bot tells him to type «sertifikat yo‘q» and answers «jadvalda bunday qator yo‘q» or «Topilmadi». (3) The instruction does not say «reply». (4) The first figure rests on an assumption the table could have asked before ✅.

**Evidence.** PA-8 (today's refusal of «sertifikat yo‘q» as a reply); PA-7 (a plain text after the answer → «Topilmadi. Mijoz kodi…»). calc-dialog.ts:416: the table already carries «📄 Sertifikat: bor (o‘zgartirish uchun tugmani bosing)» and a toggle; ai-reply.ts:685 «📄 Sertifikat: bor (deb hisoblandi)».

**The judge's fix.** Ask it ONCE, in the table, before ✅: while the toggle is untouched (a state flag) the line reads «📄 Kelib chiqish sertifikati bormi? Hozir «bor» deb olinadi — yo‘q bo‘lsa tugmani bosing yoki «sertifikat yo‘q» deb yozing» (T11 becomes first priority). After the pass the answer only STATES it: «📄 Sertifikat: bor deb hisoblandi (yo‘q bo‘lsa qo‘shimcha boj qo‘shiladi)», and adds «— shu xabarga reply: «sertifikat yo‘q»» only in the release that carries A7. No «untouched» test after the landing.

**Ruling — release 1b.** Accepted — the certificate is asked ONCE, in the table, before ✅ (T11 first priority); after the pass the answer only states it.

### JS-13 — defect — A4 (what is not a one-step answer), T11, A7 — conversation E

**Objection.** E as designed. The reply «2: 300 dona» names a row the request does not have. A4 sends everything that is not an empty asked cell to «the add table, exactly as today» — so a NEW 24-hour add collection opens (it holds the chat for 30 minutes) only to say «2-qator yo‘q». His next plain «sertifikat yo‘q» then lands INSIDE that collection, which has no certificate toggle (T11's «flips the toggle» has nothing to flip, and the add door never writes it): it is refused as a row name, or filed as material and waits for «Bo‘ldi» — a paid re-reading of two words.

**Evidence.** Ran parseTableAnswer('2: 300 dona') over one row → no_line; calc-dialog.ts:832 «2-qator yo‘q (jami 1 ta qator)». PA-7: a reply opens the add collection before the text is judged («unpressed, the collection holds the chat 30 min and waits 24 h»). calc-dialog.ts:1187 `if (state.amend) return [confirm]` — no certificate on an add table.

**The judge's fix.** A4 judges the reply BEFORE any collection opens: a reply whose every segment is refused (no such row, no unit) is answered in ONE line and opens nothing — «⚠️ 2-qator yo‘q — so‘rovda 1 ta qator. Yozing: «1: 300 dona»». «sertifikat bor / yo‘q» has ONE handler reached from all three places — a reply to the answer, a plain text inside the ai_answer wait, a line typed in a live add collection of an AI request — each ending in the same echo «📄 Sertifikat: yo‘q deb yozildi — 🤖 AI qayta hisoblayapti…» (or, until JS-5 is answered, the same one sentence that it is the VED's).

**Ruling — release 2.** Accepted — A4 judges the reply BEFORE any collection opens; «sertifikat bor / yo‘q» has ONE handler (until question 9 is answered: one sentence that it is the VED's).

### JS-14 — defect — A4 («↩️ Bekor qilish» on the one-step echo)

**Objection.** A4 puts «↩️ Bekor qilish» on the echo of a figure already written to the JOB and re-priced. SAKKIZ-R3 stated the opposite and did not build it: «Undo after «Tasdiqlash» or «✅ Qo‘shish» … A machine-side undo would need a person-safe inverse write the VED may already have overtaken.» The design gives the button one clause: nothing says what it does once the new answer has arrived, while the pass runs (the addition is `waiting`), or after the VED saved — nor what the seller then reads. A button that sometimes cannot work, on the message he has just been told to trust.

**Evidence.** docs/SAKKIZ-R3.md:5108-5110. AI-SORAYDI.md:577-578. amend.ts:42-52: the write is a compare-and-set on the hands-off stamp, and a pass still running makes an addition WAIT.

**The judge's fix.** Drop ↩️ from A4's echo; it ends «Xato bo‘lsa — to‘g‘risini reply qilib yozing: «3: 300 dona»» (a correction of a stated figure already goes through the add table with its «3000 → 300» line). If the lead keeps the button: specify it as an amendment keyed undo:<reply message id>, a compare-and-set on the cell still holding exactly the written value and on hands-off, valid until the next answer is delivered, each of its three refusals in words — and say in §4 that R3's «no undo after a save» is reversed.

**Ruling — release 2.** Accepted (= JR-7): no ↩️.

### JS-15 — defect — A6

**Objection.** A6 tells the seller «⚠️ AI kod qo‘yishda javob bermadi — 🔄 bir ozdan keyin qayta urinib ko‘ring». There is nothing to retry WITH: the answer's only button is «➕ Shu so‘rovga qo‘shish», and A6 itself keeps the rule that a ➕ with nothing added re-runs nothing. The 🔄 in the sentence reads as a button that is not there. He is told to do something no press does.

**Evidence.** PA-4 (ran in the diagnosis): after a failed coding call ➕ → «✅ Qo‘shish» answers «Hech narsa o‘zgarmadi — qatorga javob yozing («3: 50 dona») yoki «➕ Yana ma’lumot» bilan fayl yoki tovar yuboring.» and queues nothing. AI-SORAYDI.md:593-596.

**The judge's fix.** Either give the door — a «🔄 Qayta hisoblash» button on THAT answer only (cr:<request uuid>, parsed, a PRESS_REPEAT class keyed by the message, pass key retry:<n>, allowed while hands-off holds, twice at most) — or say what is true: «⚠️ AI kod qo‘ya olmadi (javob bermadi) — so‘rov VED navbatida, kodni VED xodimi qo‘yadi», with no «qayta urinib ko‘ring». Never the emoji without the button.

**Ruling — release 1a.** Accepted — A6 says what is true: «⚠️ AI kod qo‘ya olmadi (javob bermadi) — so‘rov VED navbatida, kodni VED xodimi qo‘yadi»; never an emoji that reads as a button.

### JS-16 — defect — T4, T6, T7 — answers given in pieces

**Objection.** Sellers answer in fragments. T4 computes a per-carton figure only «with a carton count on the SAME line» and otherwise asks «nechta karobka?»; T6 sends an un-addressed «60x40x50 sm 20 karobka» to the SHIPMENT's cube and keeps its 20 cartons nowhere. So in A, after «20 karobka 60x40x50» (cube computed), «har biri 15 kg» is answered «nechta karobka?» — he said it one message ago. Only T7's «1: 20 karobka» keeps the count on the row.

**Evidence.** AI-SORAYDI.md:290-292 (T4), :303-305 (T6), :309-312 (T7). Ran today: «har biri 15 kg» at a one-row table → name_none «har biri» (with its 15 kg read).

**The judge's fix.** A packing factor is always kept on a ROW. On a one-row table an un-addressed size, carton count or per-carton figure goes to that row's packing (the shipment's cube follows as the Σ); on a many-row table an un-addressed size answers the shipment's cube AND its carton count is remembered in state. A later per-package figure — addressed, or un-addressed with one candidate — JOINS the stored packing and applyPacking re-runs: «✍️ 1-qator: 20 × 15 kg = 300 kg». «nechta karobka?» is asked only when no packing holds a count.

**Ruling — release 1b.** Accepted — a packing factor is always kept on a ROW; a later per-package figure JOINS the stored packing and the arithmetic re-runs.

### JS-17 — defect — M3 (the checks), §2.3 grossFromLines, the Umumiy block — conversation C

**Objection.** C ends in a table that contradicts itself and says nothing: its one row is «300 kg (20 × 15 kg) · 2.4 m³ (hisoblangan)» and Umumiy is «✅ 507 kg · ✅ 5.9 kub» (from «jami 5.9 cbm 507 kgs») under «✅ Ma’lumot to‘liq». judgeStated compares per row only; M3's density check passes (125 and 86 kg/m³). Either the size was not the carton's (centimetres were ASSUMED) or there is more cargo — the one signal that the bot's own arithmetic is off is unused. Separately, grossFromLines («offered as the shipment's brutto (karobkalardan)») has no consumer in §3, and a Σ of computed cubes becomes «✅ Hajm: 2.4 m³ (qatorlardan)» with no word that it rests on an assumed unit — on podklyuch it prices the road.

**Evidence.** Ran applyPacking for C: weight 300 (weightIsGross), cube 2.4 (assumedCm). intake.ts:579-603: the shipment's cube IS the rows' Σ when every row has one, printed «(qatorlardan)»; intake.ts:560 already calls applyPacking inside landingItems. «karobkalardan» appears only in §2.3 (:206-209).

**The judge's fix.** New item: when every row has a cube (or a gross) and the Σ differs from the STATED total by more than 5 %, Umumiy says so and holds «to‘liq» until one press: «⚠️ Qatorlardan 2.4 m³ chiqadi, siz jami 5.9 m³ yozdingiz» [✅ Jami to‘g‘ri — boshqa yuk ham bor] [✍️ Tuzataman]. A Σ made of COMPUTED cubes prints «Hajm: 2.4 m³ (karobka o‘lchamidan hisoblangan, sm deb olindi)»; on podklyuch it is confirmed with M5's two buttons before it prices the road. grossFromLines gets a consumer: rastamojka — shown ℹ️; podklyuch — «Karobkalardan 300 kg chiqadi — bruttomi?» [✅ Ha] [✍️ O‘zim yozaman].

**Ruling — release 1b.** Accepted — Σ rows against the STATED total past 5 % is said and withholds «to‘liq» until one press; a Σ of COMPUTED cubes says so; grossFromLines gets its consumer (an offer).

### JS-18 — defect — M3 (the density line)

**Objection.** M3 holds «Ma’lumot to‘liq» on «⚠️ hajm yoki og‘irlik shubhali: 4 920 kg/m³ — bitta karobkaniki emasmi?» «until answered» — and defines no answer: no button, no typed form, no «it is right». A seller with bolts or tiles (2000-4000 kg/m³) can never reach «to‘liq». The band 20…1500 is not his either: his own «impossibly light» line is 10 kg/m³ (answer 6 of the yo‘lkira round), so pillows, foam and lampshades at 12-19 kg/m³ are stopped here and accepted by his tariff. The question names neither the figure nor the row it doubts, and speaks in kg/m³ to a seller.

**Evidence.** AI-SORAYDI.md:450-451. costing/freight-split.ts:45 `FREIGHT_LIGHT_BELOW = 10`; docs/YOLKIRA-TAQSIMOT.md:26 (his rule 6: under 10 kg/m³ warns). No button or callback for the line anywhere in §3.3.

**The judge's fix.** Band = [10, 3000], the lower bound IMPORTED from FREIGHT_LIGHT_BELOW (one home). The words name the figures: «⚠️ Shubhali: 590 kg va 0.12 kub — 1 kubga 4920 kg chiqyapti. Hajm bitta karobkaniki emasmi?» with two buttons [✅ Hammasi to‘g‘ri] [✍️ Tuzataman] (JS-6's cq:). «To‘g‘ri» is remembered until a weight or a cube changes; «Tuzataman» prints the form («jami … kub», «N: … kg»). When ONE row explains it (its own kg ÷ m³ outside the band) the line names that row.

**Ruling — release 1b.** Accepted (= JN-20), with the words that name the figures.

### JS-19 — defect — M4 (what_goods «holds ✅», size_unit, typed answers), T9

**Objection.** M4: «An unanswered what_goods holds ✅» and is «answered by the typed goods reader (T9)». T9 runs only while the table has ZERO rows. With rows present (three goods read, closed cartons on photo 2) the answer «Stul 20 dona 300 kg» is a table answer by NAME: it overwrites the existing «Стул офисный» row (40 → 20 dona) or is refused. No answer means «the same goods / nothing more / I do not know», so ✅ is held with no way out — and a hold outside aiReadingWhole breaks FAYL-OQISH's one predicate for the confirm. The button kinds have no typed form either («1: sm», «ha», «bitta karobkaniki» are refused today), and size_unit is given neither buttons nor an address.

**Evidence.** AI-SORAYDI.md:319-323 (T9 «while the table has zero rows»), :457-461 (M4). reading-whole.ts:76-86 (no_goods is the only goods hold; FAYL-OQISH §1.1: one predicate for the closing, the keyboard and the landing). Ran parseTableAnswer over a one-row table: «ha» → no_address, «bitta karobkaniki» → name_none, «1: sm» → nothing written.

**The judge's fix.** what_goods holds nothing by itself: zero rows is already no_goods. With rows present it is an ask like the others, and while it is open an un-addressed «name + figures» matching no row ADDS a row (echo «➕ 4-qator: Stul — 20 dona · 300 kg», ↩️); a name that matches an existing row asks [➕ Yangi qator] [✍️ N-qatorni o‘zgartirish]. Every AI ask can be dismissed by one button «⏭ AI savollarini o‘tkazish» (they go on the VED's note). size_unit = three buttons [sm] [mm] [m]. Each button ask also takes its typed twin when addressed: «1: sm», «1: karobkaniki», «1: hammasiniki».

**Ruling — release 1b.** Accepted (= JR-4) — and every AI ask can be dismissed by one button; size_unit is three buttons; each button ask takes its typed twin.

### JS-20 — defect — M1 (the offer per photo good) against IKKI-ESHIK 1a

**Objection.** M1 turns each photo good an Excel lacks into its own two-button question, «➕ Rasmdagi «…» ni qo‘shish» / «✖️ Kerak emas», and the closing is not «to‘liq» while one stands. Twelve photos beside a quotation is a normal pile: up to twelve questions about files — the thing his report of 2026-11-08 was about («har bir fayl uchun so‘rayapti va tushunarsiz holatga olib kelyapti»; his 1a: «the bot does not ask … new goods are added»). Q3 presents it as a small choice and the per-good question is built by default. The label carries the model's name: «➕ Rasmdagi «Кроссовки мужские демисезонные (男士运动鞋)» ni qo‘shish» is 63 characters — Telegram cuts it mid-name, so he cannot see WHICH good the button adds.

**Evidence.** docs/IKKI-ESHIK.md:3-8, :14-16, §1.1 (:92-112: no file asks anything; «Bo‘ldi» is never refused because of a file). AI-SORAYDI.md:435-439. Measured the label in a scratch test: 63 characters, 107 bytes.

**The judge's fix.** ONE offer for the whole reading, the goods listed in the text and one press: «📷 Rasmlarda Excel’da yo‘q 3 ta tovar: Обувь детская (2-rasm), … — qo‘shaymi?» [➕ Hammasini qo‘shish] [✖️ Kerak emas]; an unwanted one is removed afterwards with «N: o‘chir». It does NOT hold «to‘liq» (unanswered = not added, and said on the VED's note). §0 names it as the one exception to IKKI-ESHIK 1a, and Q3 says so to him (JS-26).

**Ruling — release 1b.** Accepted — ONE offer for the whole reading («qo‘shaymi?»), not holding «to‘liq»; §0 names it as the one exception to IKKI-ESHIK 1a.

### JS-21 — defect — T9 («filed as material and the reading re-queued») against IKKI-ESHIK §1.4

**Objection.** T9: at a zero-row table a text the typed reader cannot read is «filed as material and the reading re-queued, saying so». IKKI-ESHIK §1.4 (binding, as built): material after a table edits it to «⬇️ Yangi ma’lumot qo‘shildi — pastdagi «✅ Bo‘ldi» ni bosing, qayta o‘qiladi» and draws the ONE prompt; a re-read is paid and happens on «Bo‘ldi». With an automatic re-queue the first text («bu ofis stullari») starts a paid reading by itself, the second text sent during it gets «Tahlil paytida yana 1 ta … «Bo‘ldi»» — one answer automatic, the next needs a press — and the marker points at a «Bo‘ldi» nobody drew. The design gives words for neither.

**Evidence.** docs/IKKI-ESHIK.md:345-360 (§1.4: readMark, the marker, «Tahlil paytida yana N ta …» carries «Bo‘ldi»). calc-dialog.ts:248 TABLE_SUPERSEDED. AI-SORAYDI.md:319-323.

**The judge's fix.** Keep ONE rule: T9 never starts a reading. Rows the typed reader finds are written at once (no model). Anything else is material under §1.4 as built, and the prompt drawn below it says what the press does: «✍️ Qabul qilindi: 1 ta xabar. «✅ Bo‘ldi» ni bosing — AI rasmni shu ma’lumot bilan qayta o‘qiydi.» M2's question keeps teaching the form that needs no press («Stul 20 dona 300 kg»). If the lead wants the automatic re-read: debounce it through kept-last (one reading per burst), give the marker its own words, and state in §4 that §1.4's press is reversed for this one case.

**Ruling — release 1b.** Accepted — T9 never starts a reading.

### JS-22 — defect — M8, M11, T15 («FAYL qilib yuboring») and §6

**Objection.** M8 writes «🔎 Mayda yozuvli hujjat bo‘lsa — FAYL qilib yuboring (📎 → Fayl)» into the prompt of every collection with a Telegram photo; M11 and T15 say the same. An iPhone sends a photo «as a file» as HEIC, and the bot answers «HEIC rasm, o‘qib bo‘lmaydi. JPG yoki skrinshot qilib yuboring» — told to do a thing the bot then refuses, and the cure it names gains nothing (a screenshot is about 1170 px wide; the Telegram photo he started with is 1280). §6 admits it and words the hint differently («skrinshot yoki JPG qilib FAYL sifatida») — two texts for one hint. On a photo of GOODS (A) the line is noise.

**Evidence.** calc-files.ts:1064 (the HEIC refusal's words). AI-SORAYDI.md:479-482 (M8) against :657-658 (§6). dg2/image-report.json: a Telegram photo arrives 960×1280; the file road's model copy is 1176×1568 today.

**The judge's fix.** One wording, true on every phone, and only where it helps — not in the prompt. After a reading in which a ≤ 1280-px photo was read as a DOCUMENT (name_source document) and the table still has a ⚠️ or an AI question, one line: «🔎 Hujjat yozuvi mayda bo‘lsa — yaqinroqdan, bo‘lib-bo‘lib suratga oling (har qismi alohida rasm). Android’da FAYL qilib yuborsa ham bo‘ladi.» The HEIC refusal keeps its own words; M11 and T15 use this sentence. Never shown for a goods photo.

**Ruling — release 1b.** Accepted — one wording for the photo hint, true on every phone, shown only after a reading in which a small photo was read as a document and something is still open.

### JS-23 — defect — M7 and question 2 of §7

**Objection.** M7 writes the rows' Σ as the shipment's weight on «Faqat rastamojka», labelled «(qatorlardan)», and builds it by default (the ⭐ of Q2). The rows' kilos are NETTO; the shipment's field is BRUTTO — his own answer 2.7 b, pinned in the code: «the weight is ASKED, never summed … a Σ would be a different, smaller number». The design calls it «his call», but Q2 as worded («taken from the rows when they add up») does not tell him a netto sum will stand in the request's brutto field — the field the design itself keeps «upsale hisobi uchun», i.e. it feeds what a seller is paid on. A reversal of an earlier answer with a money edge, shipped unless he objects.

**Evidence.** intake.ts:131-135 (FIELD_LABEL.weightKg: brutto, «said where it is asked (his 2.7 b)»), :702-704 («The weight is ASKED, never summed»). AI-SORAYDI.md:474-477, :676-677. docs/RASTAMOJKA-TUZATISH.md's rule: a number never lives in a column its unit does not name.

**The judge's fix.** Split M7. Built by default: on «Faqat rastamojka» the two totals are ℹ️ and do not hold «to‘liq» (still asked, still landed when given). NOT built until he answers: any Σ written into the brutto. The only automatic brutto is grossFromLines (cartons × a GROSS carton weight, every row) — and that is shown as an offer, never as the Σ of netto. Q2 is re-worded so the choice is visible (JS-26).

**Ruling — release 1b.** Accepted (= JN-17, JR-12).

### JS-24 — defect — T0 (rule 3 and its corpus list)

**Objection.** T0 says sizes are taken out (1) and client codes masked (2) BEFORE the thousands rule (3) — and rule (3) still lists «after x х × *, after a code» as cases where «the LAST group alone is read and the existing AmbiguousTotal is raised», with the example «50 300 kg — 300 kgmi yoki 50 300 kgmi?» and the corpus note «…60x40x50 300kg → 300 (asked when «50 300» is possible)». Built as written, B's caption makes the bot ask about a number he never wrote (50 is his carton's height), and «GS777 1 200 kg 5 kub» — the commonest caption form — is read 200 kg with a question. A totals doubt is also answered only by typing, so he re-types what he wrote.

**Evidence.** AI-SORAYDI.md:255-266. intake.ts:799-806 (ambiguousTotalText: «… mi yoki … mi? Aniq yozing: «…» yoki «…»» — no button). Ran today: parseManualFacts(B's caption) → 50300 kg, no doubt; parseGoodsLine('stul 20 karobka 60x40x50 300kg') already reads 300 kg and 20 cartons.

**The judge's fix.** T0: rule (3) applies only to what REMAINS after (1) and (2). After a size or a masked code the number is read plainly — 300, and «GS777 1 200 kg» is 1200 — with NO AmbiguousTotal. A doubt is raised only for a bare digit group with no unit and no joiner before a three-digit weight («stul 20 300 kg»), worded «⚠️ «20 300 kg» — 300 kg mi yoki 20300 kg mi?» with two buttons (JS-6). Corpus: B's caption and «GS777 1 200 kg 5 kub» expect ZERO questions.

**Ruling — release 1a.** Accepted — after a size or a masked code the number is read plainly with NO question; a doubt only for a bare digit group before a three-digit figure.

### JS-25 — defect — A2 (sellerAsksOf in the answer’s uncut part)

**Objection.** A2 adds uncoded rows («2-qator «…»: bu nima — nimadan qilingan, nima uchun ishlatiladi?»), no-measure rows, the totals and the certificate to a block that sits in the answer's `fixed` part, which the fit never cuts; no cap is stated for the union. D after ✅: forty article-named rows the coder cannot code → forty 80-character asks = 3 200 characters of `fixed`; the last resort then slices the END of the message — «Rastamojka jami», the caveat, the ➕ hint. The block's present head, «❓ Hisob to‘liq bo‘lishi uchun o‘lchov kerak — qonun shuni so‘raydi:», is false for four of the five new kinds.

**Evidence.** ai-reply.ts:605-609 (the block is in `fixed`, «which the fit never cuts»), :705 LAW_ASKS_NAMED = 8 (law asks only), :726-743. fit-telegram.ts:39-49 (head + fixed + tail over the cap → sliced from the end).

**The judge's fix.** A2: the cap of 8 is on the UNION, in this order — a row with no figure, the law's unit, uncoded rows, the totals, the certificate — then «… yana N ta — «➕» jadvalida». More than three uncoded rows fold into one line: «2, 5-9, 12-qator: nima tovar ekanini yozing (nimadan, nima uchun)». Head: «❓ AI so‘raydi — javob yozsangiz qayta hisoblaydi:». A test renders 40 uncoded rows and asserts the JAMI line, the caveat and the ➕ line are present and the text is ≤ 4096.

**Ruling — release 1a.** Accepted — the cap of 8 is on the UNION of the block, more than three uncoded rows fold into one line, the head is «❓ AI so‘raydi — javob yozsangiz qayta hisoblaydi:», and a 40-row render keeps JAMI, the caveat and the ➕ line.

### JS-26 — defect — §7 questions 1-4 (and the heading «the ⭐ is built until he answers»)

**Objection.** Q2 hides its own consequence (JS-23); Q3 does not say it re-opens what he closed on 8 November (JS-20); Q1 and Q4 are answerable but written for a developer («every side is 5…300», «an empty cell of a row the AI asked about»). The heading says the ⭐ is built until he answers, while the ⭐ of Q5, Q6 and Q8 is marked «not built yet» — for those he gets option (b) until he speaks, the opposite of what the heading tells him.

**Evidence.** AI-SORAYDI.md:672-691. CLAUDE.md: he is not a developer — numbered questions, options, his own business words, in Uzbek.

**The judge's fix.** Send as: «1. Karobka o‘lchami birliksiz yozilsa («60x40x50»): a) ⭐ santimetr deb olaman, yoniga «sm deb olindi» deb yozaman; b) har safar «sm mi, mm mi?» deb so‘rayman. 2. «Faqat rastamojka»da umumiy brutto va kub: a) ⭐ majburiy emas — yozilmasa ham «Ma’lumot to‘liq» chiqadi; b) hozirgidek ⚠️. 2-b. Brutto yozilmasa, qatorlardagi NETTO yig‘indisini uning o‘rniga qo‘yaymi: a) ⭐ yo‘q, bo‘sh qolsin; b) ha. 3. Rasmda Excel’da yo‘q tovar ko‘rinsa: a) ⭐ bitta savol — «qo‘shaymi?»; b) so‘ramay qo‘shaman (8-noyabrda «fayl uchun so‘ramasin» degansiz — bu yagona istisno). 4. AI javobiga «1: 150 kg» deb reply qilinsa: a) ⭐ darhol yozaman va qayta hisoblayman (faqat AI so‘ragan bo‘sh joyga); b) avval jadval, «✅ Qo‘shish»dan keyin.»

**Ruling — release 1a.** Accepted — §7's questions are sent in the judge's Uzbek.

### JS-27 — nit — §7 questions 5-8

**Objection.** Q7 is not answerable by him as worded: «the law prices per kg», «per-piece declarations», «the row stating both figures», «median» are the engine's words. Q6 assumes he knows a Chinese HS code shares only six digits with ours. Q5, Q6 and Q8 carry a ⭐ on an option that is «not built yet» without saying what he gets meanwhile.

**Evidence.** AI-SORAYDI.md:682-691.

**The judge's fix.** «5. Eshik bosilmasdan botga rasm yoki fayl tashlansa: a) ⭐ bot «🤖 AI rastamojka / 🧮 Hisoblatish» deb so‘raydi va yuborilganini oladi (hali yo‘q — «ha» desangiz quraman); b) hozirgidek javob bermaydi. 6. Xitoy invoysidagi «HS CODE» bizning TN VED’da bo‘lmasa (faqat birinchi 6 raqami mos): a) ⭐ AI bizdagi eng yaqin kodga to‘g‘rilaydi va «fayldagi kod … → … (AI taklifi)» deb yozadi (hali yo‘q); b) kod o‘zgarmaydi, VED to‘g‘rilaydi. 7. Boj kg bo‘yicha («kamida $0.4/kg»), bojxona bazasida esa shu tovar faqat DONA narxida bo‘lsa: a) AI taxminni dona narxidan chiqaradi va shuni yozadi; b) ⭐ hozirgidek — taxmin yo‘q, «VED xodimi qo‘yadi». 8. Sotuvchi savolga 30 daqiqadan KEYIN javob yozsa: a) ⭐ javob darhol olinadi (hali yo‘q); b) hozirgidek — ▶️ bosib, qayta yozadi.»

**Ruling — release 1a.** Accepted — likewise questions 5-8.

### JS-28 — defect — §7 — what is built by default and was never asked

**Objection.** Four things ship without a question though each is a reversal or touches what leaves the company. (1) A7: the seller changes the certificate after the calculation (R3's ⭐ said the add door never does). (2) A5/T10: the seller's words go onto a stored row and re-code it; he may rename or delete a 📷 row. (3) T16: the AI sotuvchi reads customers' messages through the changed readers and since «o‘zi yuborish» may answer with no press — what CUSTOMERS are told changes. (4) M8/M12/M15: a photo sent as a file is read at about twice the tokens (2 352 → 4 783 an image), PDFs up to 20 MB, one paid warm-up call a day.

**Evidence.** docs/SAKKIZ-R3.md:140-142. AI-SORAYDI.md:361-365 (T16), :479-482, :505-508, :520-525. dg2/image-report.json (tokens 2352 at 1568 px, 4783 at the model's 3.75 MP).

**The judge's fix.** Add to §7: «9. Hisobdan keyin sotuvchi «sertifikat yo‘q» deb yozsa: a) ⭐ o‘zi o‘zgartiradi, AI qayta hisoblaydi (qo‘shimcha boj qo‘shiladi); b) faqat VED o‘zgartiradi (oktyabrdagi javobingiz). 10. Sotuvchi qatorga izoh yozsa («2: metall, tormoz kolodkasi»): a) ⭐ izoh qatorga yoziladi, AI kodni qayta qo‘yadi; b) faqat VED ga xabar. 11. AI rasmdan qo‘ygan nomni sotuvchi tasdiqlashdan oldin o‘zgartirishi yoki qatorni o‘chirishi: a) ⭐ ha; b) faqat VED.» And say, without asking: «FAYL qilib yuborilgan rasm ~2 barobar qimmat, lekin aniqroq o‘qiladi. AI sotuvchi ham mijozning «…60x40x50 300kg» ini endi 300 kg deb o‘qiydi.»

**Ruling — release 1a.** Accepted — questions 9-11 are added, and the two facts he is told without being asked.

### JS-29 — defect — M1, M3, M10, M16 — the words of one row; the two «🤖 AI» blocks

**Objection.** One row can carry three «AI ta…» brackets, and the 📷 mark is drawn three ways: §0 «📷 rasmdan taxmin», M1 «📷 1. Стул офисный — rasmdan (AI taxmini)», M10 «📷 2-rasm»; plus «(AI taklifi)» on the code (IKKI-ESHIK) and «(AI taxmini — aniq emas)» (M16): «⚠️ 📷 1. Стул офисный — rasmdan (AI taxmini) · 9401310000 (AI taklifi) (AI taxmini — aniq emas)». M3 marks a computed figure three ways in its own three examples — «(hisoblangan: 20 × …)», «(20 × 15 kg, brutto)», «(20 × 24)» — though his 3a asked for the word «hisoblangan» and the kernel's derivedText always says it. «🤖 AI:» (what it did) and «🤖 AI so‘raydi:» stand next to each other; questions sit in four places of one table (row ↳, Umumiy, the AI block, offers).

**Evidence.** AI-SORAYDI.md:23, :435, :446-448, :496-497, :527. carton-math.ts:599-602 (derivedText). intake.ts:1630 (today's row line), code-source.ts AI_CODE_MARK.

**The judge's fix.** ONE row grammar, written once in M1: «<belgi> [📷N] <№>. <nom> — <sonlar> · <kod>» → «⚠️ 📷2 1. Стул офисный — 40 dona* · 300 kg* · 9401310000 (AI, aniq emas)». 📷N = the name is from photo N; a legend line each, only when used: «📷 — nomi rasmdan (AI taxmini)», «* — karobkadan hisoblangan». A model's code: «(AI taklifi)»; an unsure one: «(AI, aniq emas)» — never both. The steps' head becomes «🤖 AI nima qildi:». Every question is drawn under what it asks about — «   ❓ …» under its row, the shipment's under Umumiy — so «ask everything in ONE message» is also one reading order.

**Ruling — release 1b.** Accepted — ONE row grammar and one legend; «(AI taklifi)» or «(AI, aniq emas)», never both; the steps' head becomes «🤖 AI nima qildi:»; every question is drawn under what it asks about.

### JS-30 — nit — The other Uzbek sentences (T6, T11, M3, M4, M5, M12, M17, M18, A2)

**Objection.** Small wording faults. T6's echo says «2.4 m³» where the table and the last block say «kub» for a stated cube (the CHAT-8 mismatch IKKI-ESHIK already fixed once). The design's own examples print space-grouped numbers («1 136.5 kg», «4 920 kg/m³») — the very form T0 must then untangle when he copies it back. «sof og‘irligi» is asked on the line under a row that prints «brutto» / «netto». [🪑 tovarning o‘zi] puts a chair on a phone or a roll of cloth. M18's «📦 Yo‘q, qadoqlangan» and M5's «✍️ Yo‘q, o‘zim yozaman» (22 characters — cut in a two-button row) lead to no next sentence. M12's «PDF ni siqing» is nothing a seller can do. M17 does not say which figure still stands.

**Evidence.** AI-SORAYDI.md:304, :450, :458, :466, :507, :535, :540. docs/IKKI-ESHIK.md §3.4 as built (CHAT-8). Measured «✍️ Yo‘q, o‘zim yozaman»: 22 characters.

**The judge's fix.** One cube word per kind: stated → «kub», computed → «m³ (hisoblangan)». The bot never prints a grouped number (fmt as today: «1136.5 kg»). Asks say «sof (netto) og‘irligi (kg)». Buttons: [📦 Karobkaniki] [📐 Tovarniki]; [1 ta karobkaniki] [Hammasiniki]; [✅ Ha, butun yuk] [✍️ O‘zim yozaman]. After «📦 Yo‘q, qadoqlangan»: «📦 Qadoq o‘lchami va soni? Masalan: «60x40x50 sm 20 karobka»». M12: «har sahifani alohida rasmga olib yuboring». M17: «✏️ Tahrir o‘qilmadi — hisobda hali «30 kg». To‘g‘risini yangi xabar qilib yozing.» Questions about unpacked loads say «nechta joy (karobka)?».

**Ruling — release 1b.** Accepted — the wording list as given.

### JS-31 — defect — §2.3 Packing.from, T5, M3 — two packings on one row (conversation B)

**Objection.** B gives ONE row two packings: the typed one («20 karobka 60x40x50», no unit) and the model's off the photo (20 CTNS, 2 PCS/CTN, 15 kg G.W./CTN, 60*40*50 CM). Packing.from holds one value and no item says how the packings of a merged row combine. «Typed wins» as a whole loses PCS/CTN — the row is then asked «soni (dona)» though the photo states it — and prints «sm deb olindi» beside a document that says CM; «the model's wins» drops what he typed. A DIFFERING factor (typed 20, document 25 cartons) is covered by nothing: T5 compares totals.

**Evidence.** AI-SORAYDI.md:166-175 (one `from`), :294-297 (T5), :446-449 (M3). Ran applyPacking on the merged row: 40 dona, 300 kg, 2.4 m³ come out only when both sources' factors are present; the typed packing alone gives «sm deb olindi» and no pieces.

**The judge's fix.** mergePacking(typed, read) in carton-math.ts, one rule per factor: equal within 2 % or one side empty → the stated one stays; a size with no unit takes the other's unit when the sides are equal; a DIFFERENT factor is a doubt («karobka: siz 20, hujjatda 25 — qaysi biri?», JS-6's buttons), never silently either. `from` becomes per factor, or the note says «sotuvchi + AI o‘qidi». Corpus: B's pile → 40 dona · 300 kg · 2.4 m³, no «sm deb olindi», no question.

**Ruling — kernel (the lead, before the packages).** Accepted — mergePacking(typed, read): one rule per factor; a DIFFERENT factor is a doubt.

### JS-32 — nit — §2.3 applyPacking — a stated weight that IS the cartons’ gross

**Objection.** In B the caption's «300kg» is the row's stated weight and equals cartons × G.W./CTN. applyPacking answers 'agrees' and writes no mark, so the row prints a bare «300 kg» and lands as the row's NETTO although its only source is a gross column; «brutto» is said only when the weight was FILLED by the arithmetic.

**Evidence.** Ran applyPacking({weightKg: 300, packing: 20 × 15 kg gross …}): derived has grossKg and no weightIsGross; derivedNotes carries no «brutto» line. carton-math.ts:460-466.

**The judge's fix.** When a stated weight agrees (2 %) with a GROSS product and the line states no weightKind, set the gross mark so the table and the note say «brutto» — the same words as for a filled one.

**Ruling — kernel (the lead, before the packages).** Accepted — a stated weight that agrees with a GROSS product and states no kind takes the gross mark.

### JS-33 — defect — X5 with X8 — D’s «empty cell and a TOTAL row» (for the Excel lens to confirm)

**Objection.** X5's belt compares a column's Σ with the TOTAL row. With one cell empty the Σ is null, so nothing is compared, and X8 then takes the TOTAL as the shipment's. An unmarked per-carton «G.W.» (15, 18, —) therefore lands as each LINE's weight — 15 kg for a 300 kg row — beside «✅ Og‘irlik: 530 kg», and customs is priced on the row. M3's density check needs both Σ and is silent too.

**Evidence.** AI-SORAYDI.md:395-401 (X5: «When a column's Σ contradicts the sheet's own TOTAL row»), :410-413 (X8: «when a figure's Σ is null (a line lacks it) the grand-total row's cell … is the sheet's total»). XLS-1 / XLS-2 are this column without the empty cell. Read, not run.

**The judge's fix.** X5's belt also runs over the rows that HAVE the figure: when Σ(present) is under half the TOTAL while Σ(present × cartons) ≤ TOTAL × 1.02, the column is not taken as the lines' — the line figures are nulled and kept on the note, and the table asks per_or_total for the COLUMN (one question, not one per row). Corpus: D's sheet with row 2's G.W. cell empty.

**Ruling — release 1a.** Accepted (with JN-12): the belt also runs over the rows that HAVE the figure; the question is about the COLUMN.

### JS-34 — nit — M1 / T10 — a 📷 table does not teach how to correct it

**Objection.** The prompt tells the model to name «каждый РАЗНЫЙ товар, который видно»: a showroom photo gives the chairs, the desk under them, a lamp — each a 📷 row that owes figures and keeps the table incomplete. T10's forms are the only cure and no drawn line teaches them: the ✍️ block prints figure examples only.

**Evidence.** intake-ai.ts SYSTEM («назови каждый РАЗНЫЙ товар, который видно»). intake.ts:1892-1959 (answerHow builds «N: 50 dona» examples). AI-SORAYDI.md:325-329.

**The judge's fix.** A table with a 📷 row ends its ✍️ block with one more line: «Noto‘g‘ri bo‘lsa: «1: nomi ofis stuli» · keraksiz bo‘lsa: «2: o‘chir»». The prompt asks for the goods the photo is OF, not the room around them («фон, мебель и люди вокруг — не товар»).

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted — the prompt asks for the goods the photo is OF («фон, мебель и люди вокруг — не товар»); a 📷 table teaches how to correct it.

### JS-35 — nit — §0 — his four sentences, where each is STILL true after the design

**Objection.** «rasm … nima tovar borligini bila olmayapti»: still true in D — the pictures inside his Excel are not looked at by any first-priority item, and the photo he then sends separately becomes a duplicate offer (JS-9). «cbm»: I found no conversation where it stays unread once T1/T2 land; in D an unmarked CBM column with an empty cell is read WRONG rather than not read (JS-33). «hajmni o‘zi chiqara olmayapti»: B and C hang on JS-2's owner rule; a size with no carton count is asked, which is right. «so‘rasin va to‘ldirsin»: still false for a plain «sertifikat yo‘q» in E (JS-12, JS-13), for an answer typed after the 30-minute pause (Q8, not built), for «1: ofis stuli» (JS-9) and for the material answer (JS-10); and A6 asks him to retry with no door (JS-15).

**Evidence.** The five walks above; AI-SORAYDI.md §0, §6, §7.

**The judge's fix.** The lead reads this as the order of work: JS-9 and JS-12/13 decide whether sentences 1 and 4 are closed in the first release; Q8 should be built with the first priority, not after his answer — «zavod bir necha soatda javob beradi» is the ordinary case of «so‘rasin va to‘ldirsin».

**Ruling — release 1b.** Accepted as the order of work; question 8 (an answer after the 30-minute pause) reverses a SAKKIZ-R3 rule and stays a question.

#### What this lens found SOUND

- A1 (noAsk = door === 'plain'): the plain door and a NULL-door request keep today's words — IKKI-ESHIK §0.2 and §2 are not touched by it.
- A3: one numbering by the row's seq in the whole answer is the right cure for PA-3; A4's fence (only an EMPTY cell of an ASKED row is written at once) is a sound net, and the once-key by the reply's own message id fits amendRequest.
- A11: a file's figure filling an EMPTY cell while only a DIFFERING figure stays the VED's is consistent with his 1a of 2026-11-08 as he meant it.
- §2.4 / T1 / T2: ran tests/unit/unit-vocabulary.test.ts — 9 passed; parseSize reads the size in B's caption, C's line, E's «60*40*50cm» and «1: 60x40x50 sm 20 karobka» (ran).
- T9 + FAYL-OQISH: once typed rows are written into a zero-row table, aiReadingWhole (reading-whole.ts:76-86) is whole again (rowCount > 0, aiUsed) and «✅ Tasdiqlash» returns — no new predicate is needed for it.
- M2's question («❓ Rasmda nima tovar? Nomi, soni va og‘irligini yozing — masalan: «Stul 20 dona 300 kg»») is short and teaches a form the typed reader takes; T3, T11's 💵 line, T15's link line, M13 and M14 read well.
- callback_data: every existing calc callback is c:<step> from a closed list, ca/cg/cf:<uuid> (39 bytes) or cu:<8 hex> — all far under 64 bytes; the limit is at risk only if a name or figure is put into the data (JS-6).
- §2.1's legacy latch degrades to today's reading; with M2 and the typed readers the seller still gets a question and a computed cube without the model's new keys.
- Q1 (centimetres assumed inside 5…300, said «sm deb olindi») matches his 3a and is answerable as it stands.
- Counts, as designed and with first-priority items only — A: 4 taps (door, section, Bo‘ldi, Tasdiqlash), 1 photo, 3 typed lines, 1 reply; 8 bot messages (section, customer, prompt, table edited in place, landing line, answer, echo, re-answer). B: 4 taps, 1 photo with caption, 1 typed (0 with T13); 6 bot messages — plus one needless question if T0 is built as worded (JS-24). C: 4 taps, 3 typed; 6 bot messages. D: 4 taps, 1 file, 2 typed; 6 bot messages, and one typed line per row to reach «to‘liq» (JS-9). E: 4 taps, 1 forward, 1 typed; 6 bot messages, then the reply opens an add table (JS-13).


## Lens «build» — can four agents in worktrees build it

### JB-1 — blocker — §2.3 applyPacking × every writer of a row figure (T6, T7, T10, M3, M4, the undo, the picks)

**Objection.** The kernel marks a computed figure in `derived[field]`, and on its next call NULLS every field so marked and recomputes it. Its own comment puts the duty on the writers: «a WRITER that takes a figure from a person must clear that field's derived mark first». No existing writer does (placeByName → rowPatchOf, pressPick, undoEcho, the conflict choice) and three packages add more. So a seller who corrects a computed cube («1: 2.6 kub» over «2.4 m³ hisoblangan») keeps 2.6 only until the row passes applyPacking again — a draw that asks for doubts, a re-read, the landing — then 2.4 is back with no doubt raised, or 2.6 lands worded «hisoblangan: 20 × 60×40×50 sm». A wrong number under ✅, with nothing on the screen saying so.

**Evidence.** carton-math.ts:405-409, 418-421; calc-intake.ts:775, 788-797. Scratch test run and deleted: the read row = {volumeM3: 2.4, derived.volumeM3: «20 × 60×40×50 sm»}; placeByName with the answer {volumeM3: 2.6} → {2.6, the same derived mark}; applyPacking again → {volumeM3: 2.4, doubts: []}.

**The judge's fix.** Make it structural in the kernel before any package starts: `LineDerived` also keeps the VALUE it computed (`computed?: Partial<Record<PackedField, number>>`); applyPacking treats a field as «computed earlier» only while `line[field] === computed[field]` — otherwise the figure is STATED and its mark is dropped. A figure a seller sets is recorded by rowPatchOf alone (`sellerSet?: PackedField[]`) and raises no `differs` doubt (he has just overruled the arithmetic). Kernel test with exactly these literals. No writer is left with an obligation to remember.

**Ruling — kernel (the lead, before the packages).** Accepted (= JN-15).

### JB-2 — defect — §2.3 «the landing writes … the arithmetic into the row's note»; M1, M3, M16, X4, X5, T4, T6

**Objection.** `provenanceNote` is written and called by nobody: `itemFacts` still lands `g.note` alone, and `CalcItemFact` carries no packing, derived or nameFrom. No item of §3 says who wires it. P-typed and P-excel (pair 1) produce packings and cannot prove one landed note; if pair 2 forgets, every product lands as a stated figure and a photo's guess as a written name — his answer 3a («hisoblangan» is written) unmet on the VED's screen.

**Evidence.** grep: no caller of provenanceNote outside intake.ts:356. Scratch test: provenanceNote(row) = «metall karkas · nomi rasmdan (AI taxmini), 2-rasm · 📦 20 karobka · 60×40×50 sm — AI o‘qidi · hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³», while itemFacts({goods:[row]})[0].note = «metall karkas». door-row.ts:116 cuts the note at 500 characters, from the tail.

**The judge's fix.** Kernel, before pair 1: `itemFacts`' note is `provenanceNote(g)` plus the lone-weight sentence, pinned in tests/unit/intake-items-wire.test.ts for every door's `landingItems`. Order inside the note: the seller's own words (T10/A5) → the source's note → the marks → the arithmetic; the 500-character cut is made at a « · » boundary with «…», never through a figure — one test at the cap.

**Ruling — kernel (the lead, before the packages).** Accepted — itemFacts' note is the budgeted provenance renderer plus the lone-weight sentence, pinned for every door's landingItems.

### JB-3 — defect — T6, T7, T10 on an ADD collection (stored rows); A5; A11

**Objection.** Every table answer on an add collection reaches the request through `amendSubmissionOf`, which copies exactly six keys of a row's patch: quantity, weightKg, volumeM3, measureUnit, measureQty, tnvedCode. T10's rename, «N: o‘chir», «N: <words>», T7's kept carton count and T6's packing are echoed by the table as written and then dropped at «✅ Qo‘shish» without a word; a cube computed from a typed size lands on the stored row as a stated figure. P-typed builds these forms in pair 1; the mapper is P-ask's file in pair 2, and A5 covers only the words.

**Evidence.** calc-amend.ts:227, 244-250; `AmendChange.edits.set` (amend.ts:274-286) has no name and no delete, and `note` only for the lone-weight sentence. Scratch test: a stored row's answer {note, name, packing, volumeM3: 2.4, derived} → rowAnswers = [{"itemId":"i1","patch":{"volumeM3":2.4}}].

**The judge's fix.** Say in §3.1, per form, what an ADD table does, and give the mapping to ONE package (the P-ask half that owns A5): words → appended to the stored note; a packing → its product in the column AND its arithmetic appended to the stored note; a rename or a removal of a row that has an `itemId` → refused in words at the answer («saqlangan qatorni bu yerdan o‘zgartirib bo‘lmaydi — VED ga yozing»), never echoed as done. planWrites asks `row.itemId` for those two. Test: each form on an add table, read back from calc_request_items.

**Ruling — release 2.** Accepted — per form, what an ADD table does; the mapping is P-ask-B's.

### JB-4 — blocker — A7, A2 (the certificate line), A4 («sertifikat bor/yo‘q»), T11; A5 and T10 on stored rows

**Objection.** docs/SAKKIZ-R3.md §0.1(2), stated to the owner: «The add door never writes a price, a rate, a zone or a certificate»; §9.5: «Allowed fields are only edits[].set's keys … never hasCertificate». A7 writes has_certificate from a reply, A2 asks for it in every answer, A4 takes it in one step; A5 and T10 add `note` and `name` to the allowed set. The design reverses a binding rule without saying so — and the certificate moves the additional duty, so the customs figure. It also has no writer: `saveTable`'s cargo holds no certificate, the only setter is a person's door (it moves `rev`, which reads as «VED started»), and the hands-off stamp may have two writers by fence.

**Evidence.** SAKKIZ-R3.md:140 and 3878-3879; amend.ts:60; workspace.ts:4281 (cargo keys) and 1392-1412 (the setter); tests/unit/handsoff-writers.test.ts; R3 §9.2 «`ai: true`: the certificate toggle is NOT offered».

**The judge's fix.** §0 names the reversal (AI door only, a request nobody has started; the plain door and a started request keep R3) and it goes to him — a question, or a line of the Uzbek report. The writer is `saveTable(…, { cargo: { hasCertificate } })` under the same expectRev / handsOff compare-and-set, so workspace.ts joins P-ask's files and handsoff-writers stays at two. A2's certificate line and A4's certificate branch ship in the SAME package as A7, never a wave before it.

**Ruling — waits on the owner's answer.** Accepted (= JR-8).

### JB-5 — defect — A4 second (the durable `ai_answer` wait) against the header «No migration (ledger stays 146)»

**Objection.** `telegram_chat_waits.kind` sits under a CHECK that lists eight kinds; 'ai_answer' is not one. The INSERT is refused (23514) — and armed where the design says, by the drain as it delivers, the throw lands between the send and the settle, so the answer is sent again on the reclaim. The header's «no migration» and this item cannot both stand. `WaitKind` (waits.ts) is a closed union as well, and if the new kind is counted by `waitingAnswerWords` → `otherCollectorLive`, every asking answer blocks «▶️ Davom etamiz» and the reply-opened add door for thirty minutes.

**Evidence.** db/schema/platform.ts:506 (the CHECK; 0138 and 0141 each widened it by a migration); waits.ts:24-37; agent-bot.ts:64-73; calc-amend.ts:465-470; calc-intake-sweep.ts:506-509.

**The judge's fix.** Either move A4-second to §6, or add migration 0146 (the CHECK with 'ai_answer'; ledger 147 in the design, UPDATE.md and CLAUDE.md). Then: arm the wait AFTER the notification row is settled, in its own try/catch (a refused insert is logged, never thrown into the drain); keep it out of `waitingAnswerWords`; clear it in `startIntake` and `openDoor`; read it in the text ladder below every collector and above `orphanAnswerSentence`. Test one migration behind: the answer is delivered exactly once.

**Ruling — stated, not built.** Accepted (= JR-14): A4-second leaves this round.

### JB-6 — defect — file ownership — wms/calc/intake.ts (T3, T4, T6, T9 · X9, X10, X11 · M1-M5, M7, M16, M18 · A2 reads it)

**Objection.** `intakeTableText` (intake.ts:1585-1884, ONE function) is edited by P-typed (T6's hint, T9's examples in answerHow, T4/T5's doubt words), by P-excel in the same pair (X9 «hisoblangan», X10's article question, X11's catalogue question) and then by P-model (eight items). «Holds Ma’lumot to‘liq» is asked for five times (M1's offer, M2's zero rows, M3's density, M4's what_goods, X10) with no single predicate, and «holds ✅» never says whether the line or the button. A hold that is no ⚠️ row prints wrong words today: the closing falls to «⚠️ Umumiyda ma’lumot yetishmayapti» and answerHow teaches «Yiwu → Toshkent» on a customs-only job.

**Evidence.** intake.ts:1699-1709 (`complete`, `shortage`), 1737-1740 (`openLine`), 1944-1955 (the last-resort example); `TableTarget` is line | totals | route (line-address.ts:24); completeness is recomputed apart in `tableOpenOf` (intake.ts:1018) and in calc-dialog's `landingPress` / `missingLines`.

**The judge's fix.** Kernel first: `TableInput.asks?: TableAsk[]`, `interface TableAsk { id: string; row: number | null; text: string; holds: boolean; buttons?: [string, string] }`, drawn by intakeTableText in ONE place (under its row, or above the closing), `complete &&= !asks.some(a => a.holds)`, and `tableOpenOf` returns them as `{ ask: id }` targets with their own word. Packages only BUILD asks in pure files of their own (`packingAsks`, `articleAsks`, `aiQuestionAsks`); the function itself is P-model's alone; NOT_GOODS_WORDS (2198) stays P-typed's. State once: a hold removes the «to‘liq» line and keeps the ✅ button — only `no_goods` changes the button.

**Ruling — kernel (the lead, before the packages).** Accepted — TableInput.asks and ONE place that draws them; packages only BUILD asks in pure files of their own; a hold removes the «to‘liq» line and keeps the ✅ button.

### JB-7 — defect — file ownership — calc-dialog.ts, staff-bot.ts `CALC_STEPS`, staff-handlers.ts `handleCalcCallback`, tests/unit/intake-holds-wire.test.ts

**Objection.** The header gives P-typed «the refusal words in calc-dialog.ts», but T5-T11, T13 and T15 live in its core: planWrites (918), commitWrites (1308), echoWords (1232), undoEcho (2509), applyTableAnswer (1632), clientAnswer (1851), routeCollectorText (2171), pressCertificate (2767). P-model needs tableInputOf (551), landingKeyboard (638), intakePromptText (1957), fileAsMaterial (1448) and five new press handlers. Every new button (M1, M3, M4, M5, M18, T5, A4's ↩️) must be a member of `CALC_STEPS` — staff-bot.ts, a file no package owns — and a branch of handleCalcCallback: a callback the parser does not know is answered by nobody. Each new function that calls `activeIntake(` must be listed in intake-holds-wire: four packages, one table.

**Evidence.** staff-bot.ts:506-581 and 716-719 (`/^c:(\w+)$/` then `CALC_STEPS.includes`); staff-handlers.ts:1524-1833; tests/unit/intake-holds-wire.test.ts:33-80 (keyed `file:function`, an unlisted call fails).

**The judge's fix.** The kernel reserves the steps and stubs them with «Bu tugma eskirgan»: `ask_0_a … ask_9_b` (one generic pair per TableAsk, by POSITION, read back from the state like pick_N and only from the message that drew them), plus the prefix `cz:<8 hex>` if the one-step undo stays. calc-dialog by function: P-typed owns the answer path (planWrites … undoEcho, applyTableAnswer, clientAnswer, routeCollectorText); P-model owns draw / keyboard / prompt and puts its presses in a NEW file (calc-asks.ts). Each package appends its intake-holds-wire rows under its own comment header.

**Ruling — kernel (the lead, before the packages).** Accepted — the callback family is reserved and stubbed in the kernel; calc-dialog is split by function; each package appends its intake-holds-wire rows under its own header.

### JB-8 — defect — order — T6, T7, T10, T11 (pair 1) → M4's size_unit / material answers, A4, A5, A7 (pair 2); X8 and X11 inside pair 1

**Objection.** `LineAnswer` (figures | bare | ambiguous | refused) and `TableSegment` are closed unions: they cannot say a rename, a removal, words, cartons × per-carton, a size, a bare unit word («sm»), a certificate word or a currency. P-typed will invent a shape in pair 1; M4 and A4 («nothing but table answers», «only an EMPTY cell of an asked row») consume it in pair 2 and must switch on it exhaustively. A caption's per-package figure with no goods line («har biri 15 kg») has no slot in what parseManualFacts returns. Inside pair 1, X8 needs T1's totals reader for a summary line and X11 needs parseTableAnswer to accept an article — both built in parallel.

**Evidence.** intake-manual.ts:1010-1024, 221-232 (opts has no prefix, and T0 masks «the company prefix + digits»); line-address.ts:53-74; intake.ts:777-797 (`TotalDoubt`); 12 callers of parseManualFacts (calc-intake ×5, line-address ×3, agent ×2, from-thread ×2).

**The judge's fix.** Commit before pair 1: `type LineAnswer = … | { kind:'rename'; name: string } | { kind:'remove' } | { kind:'words'; text: string } | { kind:'packing'; packing: Partial<Packing>; figures: LineFigures } | { kind:'size_unit'; unit: SizeUnit }`; `TableSegment.certificate?: boolean`; `TableRefusal |= 'unit_unclear' | 'needs_cartons' | 'money' | 'stored_row'`; `TotalDoubt |= { field: 'weightKg' | 'volumeM3'; perPackage: number; cartons: number | null }`; `parseManualFacts(text, section?, opts?: { from?: number; goodsBeside?: boolean; prefix?: string | null })`; `TableRow.article?: string`. X8's summary line and X11's address are finished at the pair-1 merge, by the lead.

**Ruling — release 1b.** Accepted in substance, by ORDER rather than by an up-front union: P-typed-B (the table's answers) is built and merged before P-model-A (the table's draw), so the answer shapes exist when their consumer is written.

### JB-9 — defect — T9, T10 (rename, remove), M1's 📷 names × `placeByName` and the re-read

**Objection.** A re-read («➕ Yana ma’lumot» → «Bo‘ldi») rebuilds the goods from the material and puts the answers back by the row's exact NAME. (1) T9's rows, typed onto an empty table, have no stated home: kept only in `facts.goods` they vanish at the next reading; pushed into `material` the table is «superseded» and ✅ is refused until a paid re-read — and R3 §0.1(3) («a table answer is never material») is reversed unsaid. (2) «N: o‘chir» leaves no durable record: the model lists the row again and every later number moves. (3) A rename must keep the READ name as its placement key, or the row's later answers are orphaned. (4) A photo-named row is named afresh by each reading («Стул офисный» / «Кресло офисное»): its answers fall to index −1.

**Evidence.** calc-intake.ts:754-780 (`sameName`, one claim per line), 365-383 (the rule in words); calc-store.ts:415-420 (`nothingNewToRead`); calc-dialog.ts:1448-1457 (`fileAsMaterial` puts the stage back to 'material').

**The judge's fix.** Kernel state, optional for a row written before it: `typedRows?: CalcGoodsFact[]` (merged by every reading as `seed` rows are, deduped against the model's by pickGoods' typed rule), `removedRows?: { name: string; photoNo?: number }[]` (applied after the merge); a rename is `lineAnswers[].patch.name` with `entry.name` unchanged. placeByName gains one fallback for `nameFrom: 'photo'`: the same `photoNo`, when it is that picture's only photo-named row. T9 writes neither material nor a read mark. One integration test per rule: answer → ➕ → «Bo‘ldi» → the table still shows it.

**Ruling — release 1b.** Accepted — typedRows / removedRows in the state, a rename as a lineAnswers patch with the read name kept as the key, a photo-named row placed by its photoNo.

### JB-10 — defect — M10 (`materialFrom`, `pushMaterial`), M17 second, M11

**Objection.** `material` has seven writers in four files — two of them in calc-amend.ts, P-ask's file in the same pair — and one REMOVAL (clientAnswer takes a filed line back as the customer), while `TotalsMark.material`, `routeAnswer.at` and `totalsAnswer.at` index into it. A parallel array maintained by one package breaks at the first writer or splice it missed, and its fence turns red on the other package's cherry-pick. `{ photo: n }` is an index into what the REQUEST sends: a stored photo that fails to load, a picture past the twelve, M11's tiles and X10's sheet pictures all shift «Фото N», so «Подпись к фото 3» names another picture.

**Evidence.** Writers: staff-handlers.ts:814, 827; calc-dialog.ts:1454, 1885; removal 1890-1893; calc-amend.ts:958, 1248. Index readers: calc-intake.ts:1857, 1914, 1923, 2298, 2328, 2334; calc-read.ts:488; calc-files.ts:580; calc-dialog.ts:934. Labels by index of the images SENT: intake-ai.ts:1842-1848.

**The judge's fix.** Kernel: `pushMaterial(state, text, from): Pick<IntakeState, 'material' | 'materialFrom'>` and `dropMaterial(state, index)` in calc-store.ts, all seven sites converted there and then, a fence over every `material:` object key in src/modules/platform/telegram. `type MaterialFrom = { image: string /* attachment id */ } | { after: string } | { forwarded: true } | null`, plus `message?: number` for M17. `intakeContent` maps an attachment id to the N it assigned in THIS request and drops the tie when that image was not sent.

**Ruling — release 1b.** Accepted — pushMaterial / dropMaterial in calc-store.ts with all seven writers converted in one commit and a fence; the photo tie is the attachment id.

### JB-11 — defect — A4 (first) and A11 — the one-step write

**Objection.** A4 says «written through amendRequest → saveTable … with ↩️ on it» and leaves open what a builder must decide. (1) WHERE: today the save is a pg-boss job bound to a frozen collection (`savingToken`, the sweep, the hydrate); run inline it holds the one poller on a row lock, and a crash between the claim and the write loses the reply. (2) The once-key is `calc_amendments.note_id` — a uuid that is also the card note's id; «the reply message's id» has to be mapped onto it. (3) ↩️ has no writer: no amendment can be undone, clearing a cell is a «conflict» to amendDiff, and by then the pass has re-run on the figure. (4) The asked set on the payload must survive a VED's delete (seqs are re-minted). (5) A reply sent while another collection holds the chat goes to `foreignAddReply` today.

**Evidence.** calc-amend.ts:1431-1469, 1581-1590; amend.ts:1035-1052 (duplicate by note), 1138-1151 (busy → waiting, started → to_ved), 151-183 (an empty cell is a conflict); no «undo» in amend.ts; workspace.ts:3377-3378; staff-handlers.ts:985-988; reply-door.ts:288-300.

**The judge's fix.** Bind in §3.4: the reply claims `onceKey.message(chat, id, 'amend')`, then enqueues `calc.amend-save` with `savingToken: null` and `noteId = uuidv5(`${chatId}:${messageId}`, AMEND_REPLY_NS)` — `AmendSaveJob.savingToken: string | null`; the JOB says every outcome in today's words. The payload carries `asks: { itemId: string; seq: number; needs: NeedUnit[] }[]`, matched by itemId. ↩️ is cut from v1 (the echo ends «xato bo‘lsa — to‘g‘risini yozing»), or becomes an item of its own with a writer and a compare-and-set. Test with a held pass ticket: two replies = one applied, one waiting, two answers.

**Ruling — release 2.** Accepted (= JR-7, JN-18).

### JB-12 — defect — M6 (`known_figures`), X10 second (`known_codes[].name`, «Строка N» pictures), M15, §2.1

**Objection.** The contract is «binding» and fenced, yet two packages in two different pairs change the request schema after it: X10-second adds a key to `known_codes`, M6 a top-level array — each touches FACTS_JSON_SCHEMA, the zod reader, `salvageCut`'s order (what a cut answer keeps), the SSE stand-in and the legacy pair. There is no key here, so the schema's first compilation happens in production, and M15's warm-up proves whichever schema shipped last, not the one that was reviewed. X10-second also needs a home for pictures that are no attachments (K4: no Buffer in the durable state) and a third label scheme in one image list.

**Evidence.** intake-ai.ts:1599-1700 (schema), 865-931 (`salvageCut` by key), 1712-1715 (the pair); calc-files.ts:1492 (`modelCopyKey`, one per attachment); tests/unit/intake-schema-budget.test.ts walks whatever is sent, so it blesses any later edit that stays under the counts.

**The judge's fix.** Decide now. Either the kernel adds `known_codes[].name` (string, "" = not stated) and `known_figures` (after `questions`, before `steps`; numbers, 0 = not stated) today, with their zod readers and the budget test, leaving only the consumers to the packages — or M6 and X10-second move to §6. After that commit no package edits FACTS_JSON_SCHEMA or SYSTEM: a fence pins a hash of both (tests/unit/intake-contract-frozen.test.ts), changed only by the lead.

**Ruling — kernel (the lead, before the packages).** Accepted — the kernel adds known_codes[].name and questions[].list now, M6 leaves the round, and after that commit FACTS_JSON_SCHEMA and SYSTEM are frozen by a hash fence only the lead changes.

### JB-13 — defect — M8, M11, M12 — bytes, slots, tokens and the 150 s leash

**Objection.** (1) M12 puts the photos «in the same 22 MB budget», but `images[]` keeps no size; the only guard is 4.5 MB per image, so twelve pictures alone may reach 54 MB raw against a 32 MB request (base64 adds a third). (2) «A JPEG that already fits passes untouched» skips `.rotate()`: a JPEG file carrying an EXIF orientation reaches the model sideways — and skips the 4.5 MB guard with it. (3) M11's tiles and X10's pictures are «counted against the twelve», but the cap, its words and the stored copy are per ATTACHMENT. (4) A scanned 20 MB PDF has no page guard: past the context it is a 400 that «🔄» repeats. (5) Twelve pictures at 3.75 MP are about 57k image tokens against 19-28k today, inside the same 150 s.

**Evidence.** calc-files.ts:1471-1482 (`reduceForModel`), 1047 and 85 (cap and words by `images.length`), 1492; calc-intake.ts:286, 1506-1510. Measured with sharp here: a noisy 3.75 MP JPEG at q88 = 1.10 MB. dg2/image-report.json: 3.75 MP = 473 KB / 4,783 tokens; today's 1568 px copy = 190 KB / 2,352.

**The judge's fix.** Kernel type: `images: { attachmentId: string; mediaType: 'image/jpeg'; bytes?: number; parts?: number }[]`, and ONE `modelBudget(state)` (raw bytes ≤ 22 MiB; slots = Σ parts ≤ 12) asked at a photo's arrival, a PDF's arrival and in `loadIntakeFiles`. «Untouched» only when sharp's metadata says orientation ≤ 1, sRGB and ≤ 4.5 MB. `[calc intake]` logs image count, bytes and ms for EVERY reading. A `clock` cut with more than six pictures re-reads them at 1568 on «🔄». PDF: count `/Type /Page` and refuse past 100 in words.

**Ruling — release 1b.** Accepted — one modelBudget; «untouched» only when orientation ≤ 1; the reading logs image count, bytes and ms; a PDF past 100 pages is refused in words.

### JB-14 — defect — M15 — the warm-up call

**Objection.** «When the reading worker registers» is inside `registerAllWorkers`, which awaits each registration in order: an awaited 60-second request delays every worker registered after it (the collection sweep, the amend save, the customs import, the AI sotuvchi) on every boot, and a throw there fails the boot loop. Only the APP process registers workers (tg-listen only sends), so it is one call per container start plus the daily one — and the daily one needs its own queue and schedule, i.e. an edit of boss.ts's list. The latch is module state: Next bundles the instrumentation entry apart from the routes, so the worker's latch does not cover the thread door's copy of intake-ai.

**Evidence.** boss.ts:65-99 and 132-141 (sequential `await register(boss)`), 9-18 (`globalForBoss`, kept on globalThis for this very reason); instrumentation-node.ts:7-8; intake-ai.ts:1723 (`let legacyContract`); from-thread.ts:199-230 calls the same reader from a server action.

**The judge's fix.** The warm-up is `void`-dispatched from the registration with its own catch; skipped when `aiConfigured()` is false and under vitest / the Playwright server; it writes no `ai_calc_passes` row unless that table's kind CHECK already admits one (else the log line is its record). The latch moves to `globalThis`. The daily run is a named entry `['calc-intake-warm', …]` that the KERNEL adds to WORKER_REGISTRATIONS, so no package edits that list. One `system_errors` row per latch, not one per day.

**Ruling — kernel (the lead, before the packages) + release 1b.** Accepted — the latch moves to globalThis (kernel); the warm-up is void-dispatched, skipped without a key and under tests, and writes no ledger row.

### JB-15 — defect — §3 «two at a time» — sizes, and the order of the «first» items

**Objection.** Two packages are too large for one agent with red proofs. P-typed: 17 items over 10 files (three readers of 3,000 lines, the table's answer path, the merge, the agent) plus the 2,819-case corpus — earlier rounds on these readers produced 65-134 regressions each. P-model: 18 items over 11 files. And the «first» sets are not shippable alone: A2 asks «bu nima?» and «sertifikat bormi?» while their answers are A5 and A7 («second»); T4's «nechta karobka?» and T5's question need the table; M2's question is answered by T9; M4's kinds by T10 and T6; A11 by M5's buttons, built in parallel.

**Evidence.** Lines: intake-manual 1,256 · units 898 · line-address 814 · calc-dialog 3,015 · calc-intake 2,388 · intake.ts 2,809 · calc-amend 1,898 · amend 1,516 · prefill 1,081. tests/unit/ai-reply.test.ts: 970 lines, 25 numbering pins.

**The judge's fix.** Seven packages in four waves, each cut from the merged previous one. W1: P-typed-A «readers» (T0-T4, T6's masking, T8, T12, T14, T16 — pure files) ∥ P-excel (X0-X8; X9-X11 hand DATA to the table's owner). W2: P-typed-B «table answers» (T5-T7 applied, T9-T11, T13, T15) ∥ P-model-B «pictures» (M8-M15, M17). W3: P-model-A «table» (M1-M5, M7, M16, M18, the asks of X9-X11) ∥ P-ask-A «words» (A1-A3, A6, A9, A10, A12; A2 without its uncoded and certificate lines). W4: P-ask-B «writes» (A4, A5, A7, A8, A11 and those two lines).

**Ruling — kernel (the lead, before the packages).** Accepted — seven packages, re-ordered into three releases (§3): 1a = P-typed-A ∥ P-excel, then P-ask-A; 1b = P-typed-B ∥ P-pictures, then P-model-A; 2 = P-ask-B.

### JB-16 — defect — T16 (the AI sotuvchi) with T0, T1, T4

**Objection.** The gate named for the agent — the 62 + 303 policy corpora and the tool tests — cannot see this change: the corpora run `checkAgentReply` over hand-built contexts, and no test calls `measureCandidates` or the truck tool's facts loop with a typed body. So the customer's «…60x40x50 300kg» stays unproven on the one path that may send a price with no press. T1 also WIDENS the agent («5 cbm», «507 kgs» become measures it may price by tool) while T4 narrows it; §6 tells the owner about the card form and the thread door, not about the agent. The proposed fence («÷ 1 000 000 of sides») also hits site-estimate.ts, which multiplies m³ for the volumetric weight.

**Evidence.** grep over tests/: `measureCandidates(` is called nowhere, and no agent test names parseManualFacts; agent/context.ts:499-510; agent/tools.ts:575-590 and 364; agent/site-estimate.ts:183.

**The judge's fix.** P-typed-A adds tests/unit/agent-measures.test.ts: the thirty T0 spellings, T1's forms and T4's per-package forms through `measureCandidates` and through the tool's loop, with literal expected references — an ambiguous or a per-package figure yields NO candidate. `cargo_volume` computes through `sizeCube` / `roundM3` and keeps its `stated()` check. The fence allowlists site-estimate.ts by name. §6 and the Uzbek report say the AI sotuvchi now reads «cbm / kgs».

**Ruling — release 1a.** Accepted — tests/unit/agent-measures.test.ts through measureCandidates and the tool's loop; cargo_volume through sizeCube; the fence allowlists site-estimate.ts.

### JB-17 — defect — §5 — the pins the packages break by design; the plain door

**Objection.** The design lists no test it turns red. By design: A1 — tests/unit/ai-reply.test.ts:864-926, tests/integration/calc-prefill.integration.test.ts:1127-1133 (its title says «nothing is asked … his 5a»), customs-estimate.integration:656, estimate.test.ts:487-488, prefill-reply.test.ts:275-288, freight-answer.test.ts:252-287, law-asks.test.ts:268. A3 — the «1.» headings: ai-reply.test.ts (25 pins), ai-note.test.ts (16), calc-pass-settle.integration (8), amend.integration (10). A6 — «Kod topilmadi»: ai-reply.test.ts:222, ai-note.test.ts:100, calc-prefill.integration:631. M12 — fayl-asb-b.test.ts:339-345, fayl-oqish-model.test.ts:341-345, fayl-rf.test.ts:176-181. A11 — fayl-oqish-door.test.ts:745 and 795, its integration :441 («AI qayta hisoblamaydi», FAYL-OQISH §1.6).

**Evidence.** grep over tests/ at cd72591. `noAsk = door !== null` (prefill.ts:329); estimate.ts:283 and ai-note.ts carry the same tail and are not in P-ask's file list, nor are jobs.ts (the payload) and prefill-ai.ts (A12). MODEL_IMAGE_PX is pinned by no test.

**The judge's fix.** Each package's report lists every pin it re-anchored and why; a pin is re-anchored only by its owner (the A-pins P-ask, M12's P-model, «sotuvchi: N karobka» in intake-collector-files / ikki-eshik-fix-review P-excel). The plain door's guard files are FROZEN: `git diff <kernel>..HEAD -- tests/unit/calc-plain-door.test.ts tests/integration/calc-plain-door.integration.test.ts` is empty at every merge (T9's examples are for the AI door; `NO_ADDRESS` at calc-plain-door.test.ts:351 and 375 stays). A11 keeps §1.6: an add reading that was not whole fills nothing and re-runs nothing.

**Ruling — release 1a.** Accepted — each package reports every pin it re-anchored; the plain door's guard files are FROZEN (an empty diff at every merge).

### JB-18 — defect — order inside pair 2 — M4 → A2 («in the pass's ❓ block»), M16 → A5, M5 → A11

**Objection.** P-model and P-ask run in parallel, yet three hand-offs cross between them through a LANDED request, which has no column for any of it. An unanswered AI question has to reach the pass (prefill.ts, a job over stored rows, the collection long ended); an unsure code has to be recognised by the pass so that A5 lists the row; A11 asks «with M5's two buttons». Nothing says where a question lives after the landing: the card note is free text, a row's note is cut at 500 characters, and a shipment-level question (n = 0) has no row at all.

**Evidence.** The pass reads the workspace only (law-asks.ts:78 `lawAsksInputOf`); the marker idiom exists: `weightFromTotalNote` (intake.ts:436), `carriesAiCode(i.note)` (prefill.ts:950). UNSURE_CODE_NOTE and PHOTO_NAME_NOTE are constants with no reader yet (intake.ts:342-344).

**The judge's fix.** Kernel pairs in intake.ts, pure, each with its reader: `aiAskedNote(text: string): string` and `aiAskedOf(note: string | null): string | null` (prefix «🤖 AI so‘radi: », at most 120 characters, on the ROW's note; n = 0 questions go to the card note only and are NOT in A2's block — say so), `unsureCodeIn(note): boolean`, `photoNameIn(note): boolean`. Commit A2's shape with them: `type SellerAsk = { itemId: string | null; seq: number | null; kind: 'law' | 'measure' | 'what' | 'ai' | 'total' | 'certificate'; text: string; needs: NeedUnit[] }` and `sellerAsksOf(input: LawAsksInput & { certificateTouched: boolean }): SellerAsk[]`.

**Ruling — kernel (the lead, before the packages).** Accepted — aiAskedNote / aiAskedOf, unsureCodeIn, photoNameIn in intake.ts; the SellerAsk shape is committed with them.

### JB-19 — defect — §3 — what each package runs before it reports, and what only the merged tree proves

**Objection.** The design names one gate for all (the whole corpus) and one extra for P-typed. It names no integration file, so a package can report green having run none, and nothing says what waits for the merge. Five finished worktrees stand under .claude/worktrees (ek-k, fo-door, fo-model, fo-reader, fo-sheets): `eslint .` lints them and has run out of memory on exactly that. Two packages minting corpus ids in parallel mint the same ids, and the ratchet is keyed by id. X0 lengthens every sheet's text (empty slots are kept), so a sheet that fits SHEET_TEXT_BUDGET today may be cut — and an input cut blocks «✅».

**Evidence.** `git worktree list` at cd72591; package.json «lint»: «eslint .»; intake-corpus-known.ts is keyed by case id; reading-whole.ts:83 (`input_cut` is blocking); parseGoods is also read by the deal card's import route, calc/send-rows.ts and receipts/tarkib-file.ts.

**The judge's fix.** All: typecheck && lint, the corpus, the four kernel tests, intake-holds-wire, press-fence, tx-pool, ai-advisory, intake-items-wire. P-typed: line-address, calc-dialog, calc-undo, totals-question + calc-intake / calc-r3-review / from-thread integration + the eight agent-policy files. P-excel: goods-import, goods-file, fayl-oqish-*, tarkib-file, the deal import, e2e m9u; X0 pins the widest corpus sheet's length. P-model: fayl-*, calc-read-press, kept-last, burst, contract-fallback. P-ask: ai-reply, ai-note, law-asks, amend-wire, handsoff-writers + calc-prefill, customs-estimate, amend, calc-pass-settle. Ids: c3000 typed, c3400 sheets, c3700 model, c4000 ask. Merged only: CI order on a fresh gsr_ci, the nine dg2 traces end to end, the plain-door diff, the ledger.

**Ruling — release 1a.** Accepted — the gate list per package, corpus id ranges per package, and the old worktrees removed before the cut.

### JB-20 — nit — §2.4, §5 and the kernel commit — small things a builder will trip on

**Objection.** (1) Two exported functions are both called `packingNote` — file-goods.ts:1070 (a packing LIST's note, imported by calc-files.ts) and carton-math.ts:558 (a row's packing, imported by intake.ts); P-excel edits the first file and P-model the second's caller. (2) §2.4 and §5 say unit-vocabulary.test.ts «asserts every kg and m³ word is read as a shipment total by parseManualFacts and as an answer by parseTableAnswer»; the committed test pins the list only, and the readers still keep their own lists. (3) The task names HEAD 3df0584; the branch head is cd72591, one kernel commit later. (4) M9's log line is already in the kernel.

**Evidence.** file-goods.ts:1070; carton-math.ts:558; calc-files.ts:24; tests/unit/unit-vocabulary.test.ts:15-22 («the readers' halves … stand beside their readers' own tests»); line-address.ts:88-89 and totals-shape.ts:20 still hold WEIGHT_WORDS / VOLUME_WORDS / TOTALS_UNIT; `git log -1` = cd72591; the kernel tests print «[calc intake] reading … pictureNamed … questions».

**The judge's fix.** Rename the row's one `packingWords` (kernel, before the packages). §2.4/§5: «the readers' halves are P-typed's first test: every word of `unitWords('kg' | 'm3')` through parseManualFacts and parseTableAnswer» — an item of T1/T2, red before the lists are deleted. Cut the worktrees from cd72591 after removing the five old ones. Strike the log line from M9.

**Ruling — kernel (the lead, before the packages).** Accepted — the row's packing words are `packingWords`; the readers' halves of the vocabulary fence are P-typed-A's first test.

#### What this lens found SOUND

- The kernel is green at cd72591: carton-math, unit-vocabulary, intake-schema-budget and intake-contract-fallback — 4 files, 90 tests; the budget test counts unions and optionals on BOTH contracts.
- `GoodsRow.packing` and `invoiceFacts → applyPacking` are already in the kernel (goods-import.ts:102-107, intake.ts:560): pair 2 needs nothing more from P-excel than packings that are filled.
- applyPacking is re-entrant for a CHANGED packing (a corrected carton count moves the cube, a dropped factor drops the product); only «a figure stated after it was computed» fails (JB-1).
- The reading worker is registered by the app process alone (instrumentation-node.ts → startBoss → WORKER_REGISTRATIONS 'calc-intake-read'); tg-listen only sends. M15 is one call per container start, not two.
- A4's concurrency is mostly inherited and sound: amendStanding 'busy' (the pass's live ticket) → 'waiting', written at the settle; 'started' (handsoff_rev ≠ rev) → the VED's branch; the cell's own expect compare-and-set; a duplicate by note id. Two replies in a row, a reply during the pass and a reply after the VED opened the job all end in today's outcomes without new machinery.
- A3 is buildable from data in hand: a group's items carry their seq, `lawAsksOf` already sorts by seq, and `blockerText` is handed `itemSeq`.
- The readers' files (intake-manual, units, line-address' readTotals, totals-shape) and P-excel's (goods-import, goods-file, xls, file-goods) do not overlap; NOT_GOODS_WORDS (intake.ts:2198) is 300 lines away from the table function.
- No test pins MODEL_IMAGE_PX; a collection hydrated across the deploy keeps its 1568 px copies harmlessly (the copy is stored at arrival).
- Every reader that indexes `material` was found (calc-intake 1857/1914/1923/2298/2328/2334, calc-read 488, calc-files 580, calc-dialog 934) — the list in JB-10 is complete for src/modules/platform/telegram.
- intake-corpus.json keeps one array per reader, so typed and sheet cases land in different hunks; only the ids collide (JB-19).
- tx-pool: amendRequest reads on the pool before its one transaction (amend.ts:1031-1047) and A4 through the save job adds no pooled call inside a transaction.
- The amend-wire fence (no baza, rate, zone posted by the add door; every row answer through doorRow; the save is a pg-boss job) stays true under A4/A5/A11 as bound in JB-11 — the certificate is not on its list, which is why JB-4 needs its own statement.

