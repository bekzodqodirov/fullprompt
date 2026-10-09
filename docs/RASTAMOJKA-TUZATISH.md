# Rastamojka kalkulyatori — tuzatish (2026-10-09)

The owner, verbatim:

1. «hisoblashda agar tnved code va dona m2 juftda otadgan tovarlarni kirgizadgan joyi yoqku shuni korib chiq»
2. «ok kutaman effordni oshir, rastamojka hisoblash calculatordagi hatoliklarni topib togirla. kg hamda donani birga kirgizadgan tovarlar bor shularni ham korib chiq. rastamojka hisoblayotganda kerak boladgan hamma narsani korib chiq hatolik ketmasin hisobda»

Two audits ran before this spec. Their verified findings are in the session scratchpad (`entry-audit.md`, `engine-audit.md`):

- **Entry audit:** 57 agents, every entry surface, each finding sent to a refuter.
- **Engine audit:** 76 agents, seven lenses. It included an independent reference implementation run against the real engine on thousands of random inputs.

Results: 66 confirmed or partial, 2 refuted, 7 critic findings unverified. The unverified ones are verified by the package that owns them before any fix (see §5).

**The kernel is committed** (`f9843cc`), and every package builds on it:

- `calc/units.ts`
  - `unitOf` and `routeAmount`: a number lands in the column its unit NAMES. dona → `quantity`, kg → `weight_kg`, m³ → `volume_m3`, m²/juft/litr/sm³ → the measure pair. A carton count and an unknown word land nowhere a price reads.
  - `readAmountText`: the cell reader, plus a dot thousand counted as ambiguous in free text.
  - `parseGoodsLine`: name, TNVED code in any written shape, every amount with its unit, problems listed and never swallowed.
  - `codeIn`.
- `calc/needs.ts`
  - `rowNeeds(law, basis, item)`: what a row must state — the baza's unit (VALUE) and the law's floor unit (DUTY). It is read off the engine's own `itemMeasure`, so a need and a refusal cannot disagree.
  - `missingNeeds`.
- `pricing.ts` changes:
  - `measure_missing` now carries `unit` and `half: 'baza' | 'duty'`.
  - The legacy per-group fee is never charged.
  - `requestCustomsFor` takes a REQUIRED `ungroupedCount`; a row with no code means no total.
  - The fee tier is chosen on the ROUNDED Σ value.
  - Money rounds half-up on the decimal (`roundTo` via `toPrecision(15)`).
  - A zero baza and a rate outside 0-100 are refused.
- `recalcFromSealed` copies `feeUsd: null`.

## 0. Rules for every package (binding)

- **Read `CLAUDE.md`.** Footguns 1-6 apply.
- **Red proofs are made by string edit and restored by string edit.** Never `git checkout` or `git stash` (#430, broken four times).
- **Each gate runs with its own exit code.** Never `| tail` a gate (#803, #738).
- **`pnpm typecheck` before every commit** (footgun 6).
- **i18n:** every new key goes into all four bundles (`ru` default, `uz`, `zh-CN`, `en`). `i18n-keys.test.ts` must stay green. Uzbek text is Latin, in the house style (apostrophe `‘` or `'`, whichever the surrounding keys use).
- **One home per rule (#513).** Reuse the kernel; never restate a unit list, a number reader or a need rule.
- **Tests:** a test for a fix must be shown to FAIL without the fix, and must be anchored on something the fix did not write (#1116).
- **Unexpected behaviour:** if you change one of `CLAUDE.md`'s pinned behaviours, an existing test will say so. Change the test only when its SUBJECT changed deliberately, and say so in a comment, as the kernel did for `calc-pricing.test.ts` «a lgota is a real zero».
- **The live system holds real requests.** Prefer additive changes. Old OPEN requests are healed on the VED's next Saqlash, never by a data rewrite. Sealed versions are never touched.
- **Branch / commit:**
  - Each package works in its own git worktree off `f9843cc`, commits there, and reports its branch.
  - Commit trailers, exactly:
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
    `Claude-Session: https://claude.ai/code/session_01GKDEroAfbcbPjTyydp62pL`
  - Never write the model identifier anywhere.
- **Gates each package runs before reporting:**
  - `pnpm typecheck`
  - `pnpm lint`
  - the unit tests it touched or added, plus `npx vitest run tests/unit/calc-*.test.ts tests/unit/intake*.test.ts tests/unit/line-answer*.test.ts tests/unit/i18n*.test.ts`
  - the integration tests in its area, against its own throwaway database (`createdb gsr_<pkg>`, migrate, seed, seed:demo; postgres is at `127.0.0.1:5432`, user `postgres`, no password)
- **Do NOT run the full e2e suite.** The lead runs it on the merge. If you change a testid or a header that an e2e spec reads, grep `tests/e2e` and update the spec in the same commit.

## 1. Package P1 — «Kiritish» (the doors goods enter through)

Owner of: `src/components/calc-send-form.tsx`, `src/app/(protected)/hisoblash/actions.ts` (`submitCalcAction` only), `src/modules/wms/calc/service.ts` (`openCalcRequest`, `goodsByRequest`, `calcRequestDetail`, and the checklist projections), `intake.ts`, `intake-manual.ts`, `intake-ai.ts`, `intake-land.ts`, `src/modules/platform/telegram/calc-intake.ts`, `staff-handlers.ts` (calc collection paths only), `src/modules/wms/deals/goods-import.ts`, `goods-file.ts`, `calc/from-thread.ts`, `calc/offer-pdf.ts` and both offer PDF routes, and in `items-table.tsx` ONLY the paste parser (`parsedPaste` and its helpers).

**P1.1 The seller's form becomes a goods TABLE** (`calc-send-form.tsx`). One row per product, with these columns:

| Column | Notes |
|---|---|
| Tovar nomi | |
| TNVED kod (bilsangiz) | |
| Soni (dona) | |
| Sof og‘irlik (netto), kg | |
| O‘lchov | a number plus a select: m² / juft / litr |
| Hajm, m³ | optional |

- «+ qator» adds a row and a ✕ removes one. It opens with 3 empty rows.
- **«📋 Excel'dan qo'yish»** opens a textarea. Every pasted line goes through `parseGoodsLine` (kernel) and fills a table row. A tab-separated paste with a header row goes through the shared header detector (`detectColumns`, extended in P1.6). Lines with `problems` are shown with the problem in words (ambiguous number → «1,200 — 1.2 mi yoki 1200 mi?» with two buttons; unknown unit → «“рулон” — qaysi birlik?»; cartons only → «20 karobka — nechta dona?») and are NOT added until resolved.
- The single «Tovarlar» textarea is gone.
- **Totals.** The old shipment boxes «og‘irlik / hajm» stay as the SHIPMENT totals: brutto, for the truck. Their labels say «Umumiy og‘irlik (brutto), kg» and «Umumiy hajm, m³».
- **No silent drops.** A typed number that does not read is refused on the row with words, never dropped. The submit refuses while any row has an unresolved problem.
- **Inputs are controlled** (#377, #463): a refused submit keeps every typed cell.
- **Prefill on a DEAL card** (closes the gap «Deal lines never feed a calculation»). When the deal has `deal_lines`, a button «Bitim pozitsiyalaridan to‘ldirish» fills the table from them: name, TNVED, quantity and unit through `routeAmount`, weight, volume. It is a prefill, not a link: nothing later syncs.
- **Layout.** The form stays desktop/tablet only (`hidden sm:block`, the phone path is the bot, a recorded decision). It must be usable at 640 px: the table scrolls horizontally inside its card; the page never does.

**P1.2 One normalisation at the door** (`openCalcRequest`, service.ts).

- `CalcItemInput` gains `measureUnit` / `measureQty` / `cartons` (all optional).
- Any item arriving with a free-text `unit` and a `quantity` but NO structured pair is routed through `routeAmount(quantity, unit)` here, ONCE, for every door: card form, bot, thread, file.
  - kg → `weight_kg` (if empty).
  - m²/juft/litr/sm³ → `measure_unit` / `measure_qty`.
  - m³ → `volume_m3`.
  - karobka → quantity cleared, and a row note «sotuvchi: 20 karobka» (the line now owes its count).
  - unknown → quantity cleared, and a row note «sotuvchi: 300 рулон».
- The original word stays in `unit` (display, his 20a).
- A row whose number was moved must NEVER keep the same number in `quantity` (one fact, one home, #868).
- **TNVED shape-check at the door.** A code is kept only if it is 4-10 digits once dots and spaces are removed. Anything else goes into the row note, never into `tnved_code`.

**P1.3 The bot reads numbers and units correctly** (intake-manual.ts, calc-intake.ts, staff-handlers.ts).

- `parseManualFacts` and `parseLineAnswer` read amounts through `readAmountText` and `parseGoodsLine`'s amount grammar:
  - «1 200 kg» → 1200;
  - «1,200 kg» / «1.200 kg» → re-ask with both readings;
  - «120 m2», «40 juft», «50 litr» → the measure pair;
  - «300 dona 150 kg» → BOTH (this was refused; it is the clothing answer);
  - «120 ta juft» → 120 juft, never 120 dona.
- **A bare number with no unit:**
  - If the line's needs are KNOWN (the line has a code and the book has its law, §P1.4) and exactly one figure is missing, the bare number is that figure.
  - Otherwise it is re-asked: «50 — dona, kg yoki m²? Masalan: 50 dona». A bare number is never silently kg (finding: «a bare number becomes KILOGRAMS on practically every line»).
- **A line answer that is a TNVED code** (`codeIn` matches, or 10 bare digits) sets that line's `tnvedCode` and asks again for the amount. It is never a weight, and never «server yangilanmoqda» (finding: «a TNVED code typed as the answer becomes a 6.4-billion-kg weight»). An amount above the column's capacity (`numeric(12,3)`, i.e. ≥ 1e9) is refused with words at parse time.
- **«➕ Yana ma'lumot» keeps the per-line answers already given.** The re-analysis merges them back onto their lines by index, and answered lines are not asked again.
- **The plain «🧮 Hisoblatish» door asks the per-line question too**, under the same cap as the AI door. The summary names EVERY still-missing line by number and name, not «tovarning soni yoki og‘irligi».

**P1.4 The checklist and the line questions follow the LAW** (intake.ts `missingFields`, `nextLineToAsk`, `lineQuestionText`, the server projections).

- `CalcItemFact` gains `volumeM3` and the measure pair.
- **When a line has a code** and the rates book answers it (`ratesForCodes` — pooled, BEFORE any transaction, #714), its needs are `missingNeeds(rowNeeds(law, defaultBasisFor(law, line), line))`:
  - a 6110 sweater line with only kg asks «nechta dona? (boj kamida $X/dona)»;
  - a 9403 table with only dona asks «sof og‘irligi necha kg? (boj kamida $0.4/kg)».
- **A line with no code** keeps the one-measure rule (#910), now counting the measure pair AND volume as a measure (finding: «misses the per-m³ row»).
- **A new `CalcField` `lineNeed`** renders «N-qator «name»: dona» on the VED header chips. The old `itemMeasure` chip stays for uncoded lines.
- **For `rastamojka`, the shipment totals (`weightKg`, `volumeM3`) leave `REQUIRED_FIELDS`.** Customs never reads them (finding: «nags for data customs never reads»), so they become information only. `podklyuch` and `yolkira` keep them.
- **The question text** names the unit(s) asked, and «kg» is always «sof og‘irlik (netto), kg».
- **Fences that will move:** tests pinning #910 (`intake-facts.test.ts:114`) and the m9zo e2e chip assertions. Update them deliberately, with the reason in a comment.

**P1.5 The AI extraction knows units** (intake-ai.ts).

- The schema's goods row gains:
  - `unit` (enum `dona | kg | m2 | juft | litr | m3 | karobka | null`);
  - `measure_qty` (number|null);
  - `volume_m3` (number|null);
  - and keeps `quantity`, `weight_kg` and `tnved_code`.
- **The prompt** says in words:
  - pieces vs cartons vs pairs vs m² vs litres;
  - «a carton count is not a quantity»;
  - «weight is NET per line when the document says net».
- **The landing passes** quantity/weight/measure/volume through P1.2, so the AI's unit lands where it means.
- **`tnved_code`:** accept 4-10 digits after removing dots/spaces (was: exactly 10 bare digits).

**P1.6 Invoices and pastes keep their TNVED, unit, weight, volume and amount** (goods-import.ts, goods-file.ts, items-table paste).

- **`detectColumns` gains a TNVED column** (keys: `тн вэд`, `тнвэд`, `код тн`, `hs code`, `hs`, `tnved`, `kod`, `海关编码`, `商品编码`).
  - The TNVED header is claimed BEFORE the name keys run, so «Код ТН ВЭД товара» is never the NAME (it contains «товар»).
  - The name column must not be a column whose data cells are all codes.
- **The unit column routes each row** through `routeAmount`. A «Кол-во, кг» header is a WEIGHT column, never quantity (the header's own unit word decides: run `unitOf` on the header's trailing word).
- **The bot uses an attached invoice's structured lines** whenever the file yields ≥1 line, and the model's goods are used only when there is no file. A structured file beats a model reading (finding: «used only when the AI found no lines at all»).
- **The workspace paste** («Ro'yxatdan qo'shish», `parsedPaste`) uses `parseGoodsLine` for free lines and the extended `detectColumns` for TSV. The code, unit, kg and measure columns land on the new row.

**P1.7 The offer PDF prints the measure the job was priced on** (offer-pdf.ts + both routes).

- `OfferSheetItem` gains `measure: { qty, unit } | null`.
- The quantity cell prints «120 m²» / «40 juft» when a pair exists, else the count with the seller's word. Units are words, not storage spellings.
- `offer-sheet.test.ts` pins the no-money shape. Keep it green.

**P1 tests (minimum; each red-proven):**

- **Unit:**
  - `calc-send-form` parse helpers;
  - `parseLineAnswer` cases («1 200 kg», «300 dona 150 kg», «120 ta juft», a 10-digit code, «50» with known needs and with unknown needs, an over-capacity number);
  - `parseManualFacts` thousands;
  - `missingFields` with a coded 6110 line (needs dona) and a coded 9403 line (needs kg);
  - `detectColumns` with a «Код ТН ВЭД товара» + «Наименование» + «Кол-во» + «Ед. изм.» sheet and a «Кол-во, кг» header.
- **Integration:**
  - `openCalcRequest` with «Kafel, 120, m2», «Kurtka, 500, kg», «Futbolka, 20, karobka» → the stored columns, asserted by reading the row back;
  - the bot `landIntake` path with an invoice that has a TNVED column;
  - «➕ Yana» keeping answers.
- **E2E:** update `m9zo-hisoblash` / `m9zr` for the new form. Add ONE spec (`m9zzza-sotuvchi-jadval.desktop.spec.ts`) in which a seller fills the table — «Kafel plitka | 6907 | | | 120 m² |» and «Kurtka | 6201 | 300 | 150 |» — and sends. As the VED, the measure box then holds 120 m² and row 2 has both 300 dona and 150 kg. The spec cleans its lead up as a final TEST (#183, #508).

## 2. Package P2 — «Hisob» (the law, the book, the totals, the seal)

Owner of:
- `src/modules/wms/calc/workspace.ts`: everything EXCEPT the measure pass and the basis stamp, which are P3's.
- `warnings.ts`, `dictionaries.ts`, `review.ts`, `sheet.ts`, `ai-reply.ts`, `prefill-reply.ts`, `prefill.ts`, `grouping.ts`.
- `src/components/calc-sheet.tsx`, `calc-workspace.tsx` (TotalsPanel, SealPanel, FeeOverride).
- In `items-table.tsx`: `GroupFold` and `BlockFooter` only.
- `src/app/(protected)/hisoblash/lugatlar/*`, `src/app/(protected)/hisoblash/actions.ts` (rates/teach/seal actions).
- `src/modules/wms/customs/import-parse.ts`.
- `pricing.ts`, for the excise half only.
- Migration **0131**, `when` 1785190000110. The ledger must reach **132**.

**P2.1 The law's SHAPE survives every writer** (the audit's blockers):

- **`saveRates`.** When `dutyMode` is absent, carry the shape from the in-force row that ANSWERS the code, whatever its prefix length (`ratesFor(code).dutyMode/dutySpecific/dutyUnit`), not only from an exact-code row. Passing `'advalor'` explicitly is still how a floor is removed. This reverses part of #856, which is recorded.
- **The teach button** (`calc-teach-rates`) posts the group's own `dutyMode` / `dutySpecific` / `dutyUnit`. `saveRatesAction` and the lugatlar `RatesForm` accept and post them.
- **`GroupFold` (⚙) and the lugatlar `RatesForm`** gain the shape fields:
  - mode select: «foiz» (advalor) / «foiz, lekin kamida» (max) / «foiz + har birlikka» (plus);
  - specific $ amount;
  - unit select (kg / dona / 1000 dona / juft / m² / litr / sm³).
  - A mode other than advalor requires amount + unit, refused with words otherwise.
  - The fields post through `setGroupRates` / `saveRates`, which already accept them.
- **Red proof:** integration — heading 6403 max/juft + a teach of 15 % on 6403990000 → the stored 10-digit row is `max`, 3, juft; a new request coded 6403990000 prices the floor.

**P2.2 A group says when the book moved** (warnings.ts, workspace.ts, items-table BlockFooter):

- **A new warning `dictionary_moved`.** It fires whenever the group's stored duty %, VAT %, mode, specific or unit differs from today's book row (`dictionaryRates`), whatever the `rateSource`.
  - `WarningGroupFacts.dictionaryRates` carries mode/specific/unit.
  - Recorded by ✅ like every warning.
  - The pull button renders whenever the values differ, not only for `typed` groups.
- **`recalcFromSealed` re-pulls every `rateSource='dictionary'` group from today's book** (inside its transaction, with the book read BEFORE it — #714). It names the groups whose law changed in the result («qayta hisoblashda lug‘atdan yangilandi: 6403, 8516»), and the workspace shows it once.
- **`setGroupRates` keeps `rateSource='dictionary'`** when the posted duty/VAT/shape equal the stored ones and the source was dictionary (unverified critic finding: verify first, then fix).

**P2.3 A short code says it priced from a heading** (`code_heading` warning).

- **Fires when:**
  - a group's typed code is shorter than 10 digits;
  - the book answered it from a SHORTER row (`matchedCode` ≠ typed); or
  - the book holds deeper rows under the typed code with a different law.
- **Words:** «8528 — lug‘atda bu kod ostida boshqa stavkali kodlar bor (852872…: 15 %). To‘liq 10 xonali kodni yozing.» The footer prints «lug‘at: 8528 sarlavhasi» beside the duty text.
- The warning is recorded by ✅. It does not block.

**P2.4 Excise can be entered** (migration 0131 + pricing.ts + GroupFold):

- **Migration `0131_calc_excise`**, additive:
  - `calc_groups.excise_specific numeric(14,4) NULL` (≥ 0, `<> 'NaN'`);
  - `calc_groups.excise_unit text NULL` (CHECK in the DutyUnit list);
  - pair CHECK `(excise_specific IS NULL) = (excise_unit IS NULL)`;
  - CHECK NOT (`excise_pct > 0` AND `excise_specific IS NOT NULL`).
  - Nothing is rewritten.
- **`PricedGroup` gains `exciseSpecific` and `exciseUnit`** (required-nullable, #790). `pricedGroupOf` and every mapper fill them.
- **Engine:**
  - `excisePct > 0` → value × %;
  - else a specific → Σ `itemMeasure(item, exciseUnit)` × amount (`1000_dona` ÷ 1000). A missing measure refuses `measure_missing` with `half: 'excise'` (widen the union).
  - Excise stays in the VAT base.
- **States:** `excise_pct = 0` means «aksiz yo‘q» (answered); all three NULL means unanswered.
- **A new warning `excise_unanswered`.** It fires when the group's code starts with an excisable prefix and excise is unanswered. One list in `calc/excise.ts`: 2202, 2203-2208, 2402, 2403, 2404, 2710, 8703, 8711; the comment says it is a «may be excisable» list, not law. It is recorded by ✅ and does not block.
- **GroupFold:** «Aksiz: yo‘q / foiz / $ har birlikka» + amount + unit, through `setGroupRates` (already accepts `excisePct`; add the two).
- **Seed/dictionary:** none (excise is per job).

**P2.5 The per-group certificate has a control.** GroupFold gets a three-way select: «so‘rovdagidek / bor / yo‘q», posting `hasCertificate` null/true/false through `setGroupRates`. It prints on the footer when it differs from the request's answer.

**P2.6 The fee, visible and repairable** (calc-workspace.tsx, workspace.ts, pricing.ts `customsFeeFor`):

- **`FeeOverride` renders whenever the section has a customs half.** That includes the blocked state, beside the fee blocker; it no longer hides exactly when it is needed.
- **`customsFeeFor` returns `fee_bhm_bad`** (a new FeeRefusal) when `bhmUzs` is not > 0, and keeps `not_a_number` for an unreadable override.
- **Words:**
  - `fee_fx_missing` → «So‘m kursi yo‘q — buxgalter /admin/fx da kiritsin yoki yig‘imni qo‘lda yozing»;
  - `fee_bhm_bad` → «BHM sozlamasi noto‘g‘ri — admin /admin/settings».
  - The blocker line is prefixed with the fee's own label.
- **The workspace prints the fee's inputs:** «2,5 BHM × 412 000 so‘m ÷ 12 650 (kurs 09.10.2026) ≈ $81.42». The rate's DATE comes from the fx row (`uzsPerUsd` returns `{rate, effectiveDate}`).
- **The seal's `breakdown.fee`** stores `{…fee, bhmUzs, fxUzsPerUsd, fxDate}`. Readers tolerate absence (old seals).
- **The seal posts the fee the screen showed** (`sawFeeUsd`, or null when blocked). `sealCalc` refuses `conflict` when the recomputed fee differs (the rate moved between render and press).

**P2.7 The sealed sheet tells the whole story** (sheet.ts, calc-sheet.tsx). Per group it prints:

- «boj yo‘q (lgota)» / «QQS yo‘q (lgota)» when they applied;
- «+N % qo‘shimcha boj (sertifikat yo‘q)» with its $;
- the excise line;
- the shape («20 %, kamida $3/juft»);
- the fee's inputs.

The printed rates and value must ADD UP to the printed group total. A unit test asserts that on a lgota group and a no-certificate group.

**P2.8 Seal panel:**

- **The band override is reachable.** The seal button is not disabled by a freight `band_missing` / `band_ambiguous` blocker while an override is typed. `sealCalc` already prices the override before checking blockers (#774).
- **The band box renders only when `parts.freight`.** `sealCalc` refuses `bandOverrideMin` on a section with no freight.
- **The discount previews.** The panel shows the total after discount live (`totalsFor` on the workspace's gross and the typed discount), and «chegirma jamidan katta» in its own words instead of «Hisob to‘liq emas».

**P2.9 The bot and the lenta tell the truth about a partial job** (ai-reply.ts, prefill-reply.ts).

- JAMI prints only when nothing is blocked AND no line is uncoded (the kernel's `ungroupedCount` makes `customsUsd` null; check the reply reads it).
- When only the fee refuses, the reason line prints (`feeRefusal` required-nullable in `AiVedReplyInput`).
- The refusal map words `measure_missing` per unit/half (kernel): «Kurtka: dona soni yo‘q (boj kamida $3/dona)».

**P2.10 Data and memory hygiene:**

- **(a) Import leading zero.** `import-parse.ts`: a numeric «ТИФ ТН КОДИ» cell of 9 digits is left-padded to 10. A unit test uses a numeric cell.
- **(b) `lgotaLast`** (unverified; verify first). Offer the code's LAST sealed decision (exempt or not), from `DISTINCT ON (code)` over all sealed groups first, then kept only if it was exempt. The chip prints the seal date.
- **(c) `baza_stale`** (unverified; verify first). An import-filled baza older than `BAZA_STALE_DAYS` by its batch's period end, and a memory baza older than that by its `sealed_at`, warn like a dictionary baza.
- **(d) AI regroup** (unverified; verify first, it is the most expensive if real):
  - `proposeGroups` sends only rows without a code.
  - Loose/orphan proposal groups take their item's own code or leave the item ungrouped.
  - The `saveTable` sweep re-homes a row whose trimmed code differs from its group's code.
  - Integration test: `aiPrefill` with a real memory fill and a proposal that recodes one line.

**P2 tests:**

- **Unit:**
  - warnings (`dictionary_moved` on a dictionary group whose book moved; `code_heading`; `excise_unanswered`);
  - excise engine (pct; specific per litr; 1000_dona; VAT base includes it);
  - `customsFeeFor` `fee_bhm_bad`;
  - the sheet adds up.
- **Integration:**
  - teach-under-heading keeps the floor;
  - recalc re-pulls a moved dictionary rate and names it;
  - FeeOverride with no UZS rate → `canSeal` true;
  - the seal refuses `conflict` when the fee moved;
  - band override seals on `band_missing`.
- **Migration:** `migration-journal.test.ts` stays green, and the ledger reaches 132.

## 3. Package P3 — «Ekran» (the VED's table and phone, the units logic)

Owner of:
- `src/app/(protected)/hisoblash/[id]/items-table.tsx`: everything except `parsedPaste` (P1) and `GroupFold`/`BlockFooter` (P2).
- `row-sheet.tsx`, `phone-blocks.tsx`, `basis-select.tsx`, `field-words.ts`, `words.ts`.
- `src/modules/wms/calc/basis.ts`, `screen-row.ts`, `row-draft.ts`.
- `workspace.ts`: the MEASURE PASS and the basis stamp inside `saveTable` only.
- `src/modules/wms/customs/import-baza.ts` (`unitsForRow`).

**P3.1 The columns say what they are.** The grid header is translated through the bundles:

| Column | Header |
|---|---|
| quantity | «Soni (dona)» — never «📦», which means karobka everywhere else |
| kg | «Sof og‘irlik, kg (netto)» |
| m³ | «m³» |
| TNVED | «TNVED» / ru «ТН ВЭД» |
| baza | «Baza $ / birligi» |

- **`basisLabel` translates** `juft` / `litr` / `sm3` («juft», «litr», «sm³» in uz; «пара», «литр», «см³» in ru; …). The test pinning the raw spelling (`calc-basis.test.ts:87`) changes deliberately.
- **The phone sheet** uses the same words and draws the measure suffix it already computes.

**P3.2 A row shows what it still needs** (`rowNeeds` from the kernel). On desktop and phone, every cell a need points at that is empty or not positive gets the warn border and a placeholder «kerak». Its `title` gives the reason: «boj kamida $3/dona» for `why: 'duty'`, and «baza dona bo‘yicha» for `why: 'baza'`.

- **When the missing need is a pair unit** (m²/juft/litr/sm³), the O‘lchov line is drawn even if `pairUnitFor` would not draw it today.
- **The law comes from `screenRowOf`** (the drafted code's block), so the hint follows a drafted code.
- **A unit test** covers the cell-marking decision as a pure function (`neededCells(screenRow, item)` in screen-row.ts).

**P3.3 The basis «avto» follows what the row states** (`defaultBasisFor(group, item)`, basis.ts — signature widened, all call sites updated):

1. The law's pair unit (m²/juft/litr) wins, as today.
2. Else a pair the row STATES (the measure pair, e.g. a seller's 120 m² routed by P1.2) → that unit.
3. Else a kg law → kg.
4. Else a dona/1000_dona/sm³ law → per dona.
5. Else, on an advalor or unknown law, a row that states ONLY a weight → kg, and anything else → per dona.

- **The ONE chain** (select, save, live figure, self-clean, measure pass) asks it. `calc-basis.test.ts` and `calc-screen-row.test.ts` gain cases for steps 2 and 5.
- **`unitsForRow`** (import-baza.ts) offers the pair unit when the row states a pair and the law pins none (`hasMeasure`). The import auto-fill never offers per-dona prices for a row whose stated figure is m², kg or litres (finding: «the import auto-fill picks per-piece prices»).

**P3.4 Old open requests heal on Saqlash.** In the measure pass, a row whose `unit` text routes (kernel `routeAmount`) to a pair, to kg or to m³, whose `quantity` holds the number and whose target column is empty, MOVES the number:

- quantity → measure pair / weight / volume, and quantity is cleared;
- the save result names the moved rows: «sotuvchi birligi o‘tkazildi: 1-qator 120 → m²»;
- karobka / unknown words are NOT moved. They get a row warning «sotuvchi “karobka” yozgan — dona sonini yozing», and the quantity is cleared only when the VED confirms that note. Do not auto-clear.
- **Integration test:** a request stored the OLD way (raw SQL insert: quantity 120, unit 'm2') heals on the next `saveTable`.

**P3.5 The new-row O‘lchov box says its unit.** While the law is unknown, the ghost row's O‘lchov box gets a small unit select (m² / juft / litr), so a number typed there is not thrown away when the code's law turns out to be advalor (finding: «a number typed there for an advalor code is thrown away»). The chosen unit posts as the row's basis when the basis is still «avto».

**P3.6 The basis stamp is announced** (finding: «$30/dona becomes $30/kg»).

- A row saved with a price and an «avto» basis, on which the measure pass stamps a unit, is named in the result: `basisStamped: [{seq, unit}]` → «3-qator: baza birligi kodga ko‘ra kg bo‘ldi — tekshiring».
- **And when the screen showed «avto» as dona and the stamp is a DIFFERENT unit,** the save refuses that row with words, asking for the unit to be picked. A price typed against one unit must never silently become another.

**P3.7 Refusals in words, at the row** (field-words.ts, items-table, row-sheet, phone-blocks, the seal panel blockers).

- `measure_missing` uses the kernel's `unit`/`half`: «Stol: sof og‘irligi (kg) yo‘q — boj kamida $0.4/kg» or «Kafel: m² yo‘q — baza m² bo‘yicha».
- **A basis/law conflict** (`basisConflicts`) shows «birlikni tanlang — kod juft bo‘yicha o‘lchaydi» and a warn border on the select, instead of «o‘lchov yo‘q» beside a filled box.
- **The phone sheet** shows the refusal of ITS row, and names another row's refusal as that row.
- **The bar chip** links `#calc-i-<seq>` of the refusing row.

**P3.8 The live figure re-homes drafts** (finding: the live bar priced a re-coded row in its OLD block and ignored ghosts).

- `liveCustomsByGroup` builds blocks from the DRAFTED state. A row with a drafted code joins that code's block if one exists.
- A drafted code with no block, or any dirty ghost row, makes the bar show «saqlang — kod yangi» instead of a figure.
- **A unit test** compares the live total with what `saveTable` + `loadWorkspace` produce for the same drafts (the invariant #886 promised).

**P3.9 Small:**

- A row under a `1000_dona` law labels its count «sigareta soni (dona)».
- An sm³ row keeps «jami sm³ = dona × motor hajmi».
- The phone card shows «120 m²» from the pair, never the seller's word glued to the dona count.

**P3 tests:**

- **Unit:** `screen-row` (needs, labels), `basis` (steps 2 and 5), the live-equals-saved invariant, `field-words` (refusal words).
- **Integration:** the old-row heal; the stamp announcement or refusal; `unitsForRow` with a pair.
- **E2E:** update `m9zr-hisoblash-olchov` (headers, basis options) and add to it:
  - a row typed «Kafel» + 120 in O‘lchov m² on an UNCODED new row, then 6907, then Saqlash → 120 m² kept;
  - a 9403 row with only dona shows the kg cell marked «kerak».
  - The geometry still fits 1280 and 360.

## 4. What is deliberately NOT changed (stated to the owner)

- **The `max` floor is taken per BLOCK (one TNVED code = one declaration line),** not per row (verified correct for one declaration line).
- **The additional-duty band follows the code's NOMINAL advalor %,** and a duty lgota also cancels the no-certificate duty (#857). These are questions for the post; the current reading is pinned by tests.
- **VAT is 12 % on every code by default.** An exemption is the per-group lgota tick, as now.
- **Heading 2515 is absent from the seed;** the law file is his.
- **A sborniy truck's senders sharing one block per code** stays (the per-group certificate control P2.5 is the lever).

## 5. Unverified critic findings

These were not refuted, but no refuter ran on them. The owning package must REPRODUCE each before fixing it, and report «not reproduced» honestly if it does not reproduce:

- AI regroup (P2.10d);
- lgota-last (P2.10b);
- sborniy (stated, not fixed);
- discount/band preview (P2.8);
- import/memory baza age (P2.10c);
- rateSource re-stamp (P2.2);
- invoice XLSX drops unit/volume/amount (P1.6).

## 6. Egasiga savollar (javob kelguncha ⭐ qurilgan)

1. **Og‘irlik: netto yoki brutto.** Bojxona bazasi (import fayli) sof og‘irlik (netto) bo‘yicha, ombordagi og‘irlik esa karobka bilan (brutto).
   - **a ⭐** Qatordagi og‘irlik «sof og‘irlik (netto)» deb nomlanadi va kg bo‘yicha baza hamda «kamida $X/kg» boj shunga hisoblanadi. Umumiy og‘irlik brutto bo‘lib qoladi (yo‘lkira uchun).
   - b) Har qatorda ikkita og‘irlik: brutto va netto.
2. **Aksiz.**
   - **a ⭐** Har bir TNVED guruhida «Aksiz: yo‘q / foiz / $ har birlikka». Pivo, vino, sigaret, yoqilg‘i, avtomobil kodlarida «aksiz bo‘lishi mumkin» ogohlantirishi chiqadi.
   - b) Faqat ogohlantirish.
3. **Bitta kod ostida bir necha tovar bo‘lsa, «kamida $X» boj qanday olinadi?**
   - **a ⭐** Kod bo‘yicha jami: deklaratsiyada bitta qator. Hozir shunday.
   - b) Har bir tovar alohida.
4. **Qo‘shimcha boj (sertifikat yo‘q)** «20 %, kamida $3/juft» kodlarda nominal 20 % bo‘yicha olinadi. Bojxonadan aniqlab bering — hozircha shunday qoldi.
