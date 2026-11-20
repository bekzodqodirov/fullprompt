# Critic — feasibility against the code, and every owner answer SPEC-TOLIQ-v1 reverses

Read 2026-11-19, tree at ledger 151, read-only. `agent/` = `src/modules/wms/agent/`. Every file:line below was opened;
where a claim rests on a map and not on my own read it says «(map)». Nothing was run.

**Verdict in five lines.**
1. Stage 1 is not «only deletes». Three of its ten deletions remove a hold the project itself classified as
   DANGEROUS with a zero-tolerance corpus (`language`, `owner_figure`) or his explicit ⭐ answer (`streak`), and four of
   its «builds» (several messages, holding line, supervisor cards, sample) need schema and a new authorisation rule.
   True size: **L**, or S-M + L when split.
2. No stage builds the thing every later stage stands on: an engine that ACTS before it speaks, reacts to EVENTS, and
   keeps a conversation record. Today every side effect runs after approval (`decide.ts runDraftActions`) and every run
   needs a fresh inbound anchor (`run.ts:1853`).
3. The question list silently overturns nine of his recorded answers and leaves five more decisions unasked
   (table A, «silent»: 14 rows).
4. Two ⭐ recommendations have no data behind them: Q12 «next planned truck» (no planned-departure column exists) and
   Q6 «as a range» (no range arithmetic exists).
5. One dated fact is missing from the road: the website truck table the AI quotes from ends **2026-12-31**
   (`SITE_TARIFF.validThrough`), six weeks from this spec.

---

## A. REVERSALS — every earlier answer or stated rule the spec reverses, weakens or touches

«Explicit» = a question names it. «Bundled» = a question covers it without saying an earlier answer changes.
«Silent» = no question. Fix column = what to change in the question list.

| # | His words / the recorded rule | Recorded | What SPEC-TOLIQ-v1 does | Re-asked? | Fix |
|---|---|---|---|---|---|
| 1 | «Telegram businessdagi bot emas mening shaxsiy account seansimdan ishlatsin ai va ban havfini minimum qilsin» | CLAUDE.md (AI sotuvchi phase 1); docs §15 row 2 «offered and not taken» | §5 + stage 7: Business chatbot on the seat as reply carrier | **Explicit** Q26 (⭐ b try) | Quote his sentence in Q26; say Premium is paid, the connect is done by hand on the seat's phone, and the trial is stage 0 (its result changes stage 1b's outbox) |
| 2 | Second half of the same sentence: «ban havfini minimum qilsin»; «4 hozircha qolsin keyinchalik ozgartiirish imkoni kerak boladi» (#1766) | #1766, #1775 | Raises session volume BEFORE hardening: 2-3 messages per turn, night replies, per-chat 12 → more, follow-ups day 1/3/7 from the number (Q23 ⭐), reminders (Q25), ≤ 20 re-activations a day (Q24) | **Silent** as a trade (only §9 lists the risk) | One question: «xabar soni 2-3 barobar oshadi — hozir shu raqamdan, yoki rasmiy kanal tayyor bo'lgandan keyin?» |
| 3 | «gramjs / menejerlarning shaxsiy seanslari orqali AI hech qachon yubormaydi»; «Mijozga birinchi bo'lib yozish» in §13 «Nima qilinmaydi» | docs §1, §13; overridden for shadow (10-23) and auto (11-11, §18.6 last bullet) | Extends the override to PROACTIVE sends from the session | Bundled Q23-Q25 | Say in Q23 that this is the first time the number writes first |
| 4 | «Ommaviy tarqatma — yo'q va bo'lmaydi. Bir xil matnni ko'p odamga yuborish akkauntni bloklatadigan uchinchi sabab» / «Avtomatik javob — hech qanday robot mijozga o'zi yozmaydi» | docs/TELEGRAM-CRM.md:313-316 | Stage 8 campaigns, re-activation, greetings | **Silent** (Q24 does not cite it) | Cite it in Q24; state that each text is written per customer and G10 `fingerprint` stays |
| 5 | «3 jim qolgan mijozni juma kuni toshkent vaqti bilan soat 2 da tabrik yozsin odamga oxshab tabiy chiqsin tabrik» + «jumani sen aytgandek rendom odamga oxshab har hil vaqtlarda yozsin soat 2dan boshlab» | SPEC-P3 §0; #1766 part 3 «next» (task #49 pending) | Stage 8 of 10; «one approval per campaign»; Q24 ⭐ = ONE message a MONTH, through the company bot when linked | **Silent** — Q24 never says «juma» | Weakened three ways (weekly → monthly, «odamga oxshab» → a bot, next → last, plus an approval he did not ask for). Ask it by name: «juma tabrigi: (a) hozir, AI raqamidan, har juma (SPEC-P3) (b) kanal mustahkamlangandan keyin (c) oyiga bir marta bot orqali» |
| 6 | «10 b» — the AI gives the China address, HE opens the GS code; prompt rule 12; §18.5 «opening a GS code» | docs §15 row 10; `prompt.ts:85` | Stage 5 opens codes alone | **Explicit** Q8 (⭐ a) | Add to Q8: for a lead the code IS the win (`winLead` is the only door that may write a won stage), the code is permanent and never reused, the staff group celebrates it, KPI follows it |
| 7 | §18.5 «winning or losing a lead» stays his for ever; SPEC-P2 §0 ⭐ «Yutildi … stay a person's, always» | docs §18.5; SPEC-P2-v2 §0 | Closing row: «lead won, deal opened» alone | **Silent** (hidden inside Q8) | Name it in Q8 or its own question |
| 8 | «6b» — a price he types goes to the customer ONLY; nothing on the card | docs §17.14 row 6 | Stage 4 «quotes with validity on the card»; stage 6 one-tap discount cards; stage 1 deletes `owner_figure` | **Silent** | New question: «AI aytgan jadval narxi va siz bir tugma bilan bergan narx kartaga yozilsinmi?» — and say a deal's quote pre-fills the truck bill (`finance` `prefillFor`) |
| 9 | «8 … Klientdan hamma malumotlarni toliq olib botga jonatsin … menga aytsin javob keldi narx bersang boladi» = the AI never prices a calculation; §17.0 Q5 ⭐ (the estimate «rasmiy emas» is told to HIM); `calc/prefill.ts` «Nothing here can price a customer» | docs §15 row 8; three code fences (map-senses §3.4) | Stage 4 customs ESTIMATE to the customer | **Explicit** Q6 (⭐ b) | Q6 must say: the figure arrives minutes later (it needs a landed VED job), it is one figure today — a «range» has to be invented, and the VED's later price may be higher (Q31) |
| 10 | «9 Saytlarga tegma agar klient yolkira logistikani ozini sorasa saytdagi kalkulyatorni ozi boyicha …» | docs §15 row 9 | Stage 1 ruling «quote freight now, offer podklyuch»; stage 4 Kashgar/Horgos from /admin/tarif | Q11 explicit for the columns; the stage-1 ruling **silent** | #1800 records his complaint of 11-15 that the AI quoted from the table where he expected a VED job, «asked of him … NOT changed». The ruling answers an OPEN question for him. Ask: «mijoz faqat "narxi qancha" desa: (a) darhol jadvaldan + podklyuch taklifi (b) avval "rastamojka bilanmi" deb so'raydi (c) har doim VEDga» |
| 11 | «Temiryol mendan sorasin narxini» | docs §17.14 row 7 | Q10 ⭐ c: AI collects, he prices | **Explicit**, kept | — |
| 12 | «2 yukini infosini menga bersang men adres beraman telegramda sorasin»; SPEC-P1 Q4 ⭐ a «bitta harf xatosi yukni boshqa joyga yuboradi» | docs §17.14 fourth set; SPEC-P1-v2 §8 | Q9 ⭐ a: typed once into Bilimlar | **Explicit** | His sentence says he needs the CARGO's details first — the address may depend on the cargo. Q9 must first ask «avia manzili bitta doimiy manzilmi yoki yukka qarab har xil?»; if it varies, option a is wrong by construction |
| 13 | «9 yoq kelib chiqish sertifikati bor biz ozimiz olamiz» — never asked | docs §17.14 row 9 | Not mentioned | Untouched | State in the spec: the estimate block assumes `has_certificate = true` and the AI still never asks |
| 14 | Original rule: «Siz botmisiz?» — «yolg'on gapirmaydi … Bu sozlama emas, qoida»; as built ⭐: no draft, a notice to him; §18.7 Q6 ⭐ a «his, in his style» | docs §1, §17.0 Q4, §18.7 | Q1 (own name), Q2 (honest line) | **Explicit** | — |
| 15 | Night: first set 6 ⭐; §17.0 Q14 ⭐; §18.7 Q4 ⭐ a «none at night» («sen aytgandek»); SPEC-P2 Q9 ⭐ a «faqat kunduzi» for a VED price | docs §15, §18.7; SPEC-P2-v2 §7 | Stage 1 night replies | **Explicit** Q14; the VED-price half **silent** | Q14 must say whether a price (table or VED) may go at night, and that hand-over clocks do not run at night |
| 16 | «sen aytgandek bolsin faqat 50 talik test bolmasin ozi javob beraversin men bergan tasdiq kop kutib qolmasin» | #1683, docs §18.3 | Honoured (trust measured after). But Q30 ⭐ a = 10 marks every evening for a month (300 presses), an exam set, rollout rings | Bundled Q30 | Say what happens when he does NOT mark the samples: per-action step-down has no signal. And rollout rings NARROW today's audience — «5 a: every client and lead who writes» (docs §15) is live (396 clients on the seat, #1789); rings may apply to NEW powers only |
| 17 | §18.7 Q3 ⭐ a «2 minutes with ⏸» («sen aytgandek») | docs §18.7 | Stage 1 deletes the card-must-ring hold | Q3 offers the hold for ordinary talk only; for prices, VED prices and the VED job **silent** | Give Q4 and Q5 the option «2 daqiqa ⏸ bilan» |
| 18 | SPEC-P2 Q8 ⭐ a «Qoida shunday qoladi» (the 2-in-a-row rule), bound as A3 «the 2-message streak rule unchanged» | #1791; SPEC-P2-v2 §00 | Stage 1 deletes `streak` | **Silent** | Ask it, with its replacement (table B row 2) |
| 19 | SPEC-P1 Q2 ⭐ a «Siz bergan javobda raqam bo'lsa … har doim sizga karta bo'lib keladi» | #1776; `auto-gate.ts:412-415` | Stage 1 deletes `owner_figure` | **Silent** | Ask it; see table B row 8 for the danger |
| 20 | SPEC-P1 Q9 ⭐ a (en/fa/zh go only on a confident read); «mijoz qaysi tilda yozsa usha tilda … kirilchada yozsa kirilchada … lotinchada yozsa lotinchada» | #1766, #1774, #1788 | Stage 1 deletes the `language` hold | **Silent** | Ask it; today a wrong-language send is a DANGEROUS corpus case |
| 21 | §17.0 Q3 ⭐ «Pashto → no draft»; «13 fors va xtoycha ham gaplashaversin afgon eron klientlarim bor» | docs §15, §17.0 | «six languages»; `design-risk.md` lists Pashto as a dial; no question | **Silent** | Add a question, and say what the Pashto writer sees under «never silent» (today: nothing — a notice to him only, `worthy.ts`) |
| 22 | «7 chegara qoyma» | #1766, #1775 (`per_day` NULL) | New daily ceilings per act (codes a day, 20 a day), a daily dollar budget that stops the AI (Q29) | Bundled Q8, Q24, Q29 | Name it: «"chegara qoyma" degansiz — quyidagilar yangi chegaralar» |
| 23 | SPEC-P1 Q1 ⭐ a / SPEC-P2 Q1, Q2 ⭐ a — «Narx», «Hisoblatish», «VED narxi» are ticked by HIM; 0148/0149 deliberately left the stored row | #1770, #1792 | Stage 1 «on by default» | Bundled Q4, Q5 | Not a build item: it is three ticks of stage 0. A migration that flips them overrides his setting — drop it from stage 1 |
| 24 | A1 «agarda bosh tursa usha yer ustama qoymasdan ozi narx beraversin»; A2 the markup on the whole figure | #1791 | Q5 «the markup: how much, % or $?» | Explicit | Keep A1 visible: an empty markup is a valid answer, not a blocker of stage 1 |
| 25 | Answer 15 ⭐ «drafts are for me only»; review leak-5 «a message leaves a personal account only by its holder» (`decide.ts:60-67`, restated #1800); «5 ai sotuvchi faqat meniki boladi alohida hodimdek qaralsin va men shu akkountda qarab turaman» | docs §15 row 15; SPEC-P3 §0; #1766 | Cards to «a supervisor»; cases to VED / logist / accountant / warehouse; Q21 named people write from the AI number | Bundled Q17, Q21 | Quote «faqat meniki» in Q17 and Q21. Today he reads the cards INSIDE the seat's own Telegram — «re-pointing» may be unwanted |
| 26 | «6 … men ham usha akkountni ishlatib otraman»; first set 7 ⭐ «120 min after he writes in that chat himself» | #1766; docs §15 row 7 | §3 adopts `design-risk.md` §3.7, which deletes `human_active` because «nobody types by hand on the seat» | **Silent**, and contradicts his words | Keep the pause, or ask «AI raqamidan o'zingiz ham yozasizmi?» |
| 27 | First set 12 ⭐ a — AI-opened leads are his | docs §15 | The seat owns them; won clients are «the house account» | Bundled Q19, Q22 | — |
| 28 | Round 113, his design: website visitor → the LEAST BUSY manager | docs/SAYT-TAQSIMOT.md | Q19 ⭐ a «the website's Telegram button first» to the AI | Bundled | Separate question: this takes website leads away from the sellers' rotation |
| 29 | His advert flow (Meta form → rota → seller calls; docs/ADS.md, taqsimot) | rounds 83, 96-97 | §5 «Advert forms end with "Telegramda yozing"» | **Silent** | Ask, or strike it from §5 |
| 30 | SPEC-P2 Q7 ⭐ a — a colleague's customer: the machine never sends the VED price, nothing on the seller's card (`machineMayTouch`) | #1794 | Q18 ⭐ b | Explicit, consistent | — |
| 31 | First set 11 ⭐ a (own balance) — as built always his ✅ («the customer's debt is his», `auto-gate.ts:472-474`) | docs §15; #1769 | Payment row: amount due alone | Bundled Q25 | Say in Q25 that the balance going alone is new |
| 32 | Law 4 — the VED never sees a client price, a seller never sees the floor (#790) | CLAUDE.md; `calc/upsale-scope.ts` | (a) concession tool says «lowest you may say is $X» = floor + a fixed margin, so the customer and the transcript learn the floor; (b) a case to the VED carries the conversation, with the client price in it; (c) a VED's answer relayed «as given» sends the FLOOR to the customer; (d) the holder's card line prints the VED figure AND the client price together (`calc-markup.ts:106 cardLineOf`, used at `calc-loop.ts:459`) — routed to «named people» it leaks both ways; (e) the VED already reads every chat of the seat (`seesAllTg` includes the `ved.docs` grant) | **Silent** | Spec §3 needs a law-4 paragraph; (c) is a money loss, not only a leak |
| 33 | Fourth set: «Which warehouse a customer uses is not decided by the AI» (rule 12: «qaysi shahardan jo'natishini so'ra») | docs §17.14 | Closing sends «the China address»; expected arrival needs a warehouse | Silent | State: the AI asks the city, never picks |
| 34 | SPEC-P1 Q6 ⭐ a — the holding line «keyingi bosqichlardan birida, alohida tekshiruv bilan» | SPEC-P1-v2 §8 | Stage 1 builds it | Consistent | The «separate check» is owed: it is not a deletion (table B row 12) |
| 35 | Only the OWNER approves knowledge (`kb_facts.approved_by`; money refused at the write) | docs §17.12; `kb.ts` | «asks "shu savol yana kelsa?" 📌 rule» after a COLLEAGUE's answer | Silent | Say who approves a 📌 made from a VED's or logist's answer |

Count: 35 rows; **14 silent** (2, 4, 5, 7, 8, 18, 19, 20, 21, 26, 29, 32, 33, 35) — nine of them his own recorded
answers or words (2, 4, 5, 7, 8, 18, 19, 20, 26) — and 3 more silent in part (10, 15, 17).

---

## B. STAGE 1 SANITY — item by item

Agent tests today: 44 unit + 28 integration files named `agent-*`, 2 e2e (`m9zzzg-ai-sotuvchi`, `m9zw-ai-xotira`).
«Corpus» = `tests/unit/fixtures/agent-reader-corpus.ts` (+ `-eval.ts`, `-known.ts`, `agent-reader-corpus.test.ts`):
zero tolerance for a dangerous case, and CLAUDE.md orders the whole corpus run before any change to `locale.ts`,
`auto-gate.ts` or the owner-answer readers.

| # | Item | Where it lives | What depends on it / what pins it | Danger if removed while the old money rules stay | Verdict |
|---|---|---|---|---|---|
| 1 | `low_confidence` | `auto-gate.ts:445`; column `agent_auto_config.min_confidence` (CHECK 0.50-1, 0145); `auto-send.ts setAutoMinConfidence` (#1800) | `agent-auto-gate.test.ts`, `agent-auto.integration.test.ts`, the e2e's «owner tunes the boxes»; `calibration.ts` cells at ≥ 0.80 | None new: the model's real «I do not know» is `needs_owner`, which stays | **Safe now.** In fact stage 0 does it with no code: the measured ratings were 0.60-0.75 and the floor goes to 50. Keep the number stored — §2's own sample is «weighted to the least-sure turns» |
| 2 | `streak` | `auto-gate.ts:457` `AUTO_STREAK_MAX`; `auto-send.ts:259 autoStreak` (reset only by a person's decision, ✍️ answer or hand-typed message) | `agent-auto-gate.test.ts`, `agent-auto.integration.test.ts`, `agent-full-p2-price.integration.test.ts` (SPEC-P2 «pinned as his rule»), `agent-owner-answer.integration.test.ts`. His ⭐ answer (A row 18) | The spec deletes `repeat` in the same stage. Robot ↔ robot is then stopped only by the 5-second `echo` window and `auto_sent` (Telegram Business away messages only). Any other auto-responder loops to the per-chat cap, which stage 1 also raises, eating the account's 80 a day. It is also the last rule that makes a person look at a chat once cards disappear | **Needs a replacement in the same stage**: a loop detector (N machine replies in M minutes to inbound lines that are near-identical or arrive within seconds) plus the per-chat hour cap. And a question |
| 3 | Label `category` | `auto-gate.ts:424-434`; `auto-categories.ts` (`LABEL_CATEGORIES`, outcome kinds); CHECKs `agent_auto_config_categories_check` (re-made in 0145, 0148, 0149) and `agent_drafts_category_check`; the arming words promise «shikoyat va savolli javoblar har doim sizga qoladi» | `agent-auto-gate.test.ts`, `agent-auto.integration.test.ts`, the `agent-full-p2-*` integration files; `agentStats` and the calibration are per category; `status_unbacked` (`:437`) is keyed on the label | `complaint` and `other` are held ONLY by the label. Rule 13 makes the model set `needs_owner` — another self-report. With no wall 4 until stage 3, a complaint the model answers itself goes out | **Partial.** Free the four ordinary labels; KEEP `complaint` held (add a short anger / refund / «menejer kerak» tripwire) until wall 4 and Q20 are answered. Keep the label for `status_unbacked` |
| 4 | `questions` (more than one «?») | `policy.ts` warning (#1610) → gate `warnings` (`:371`) → press refusal `auto_warning` (`decide.ts`) | `agent-policy.test.ts`; `agent-policy-first-reply.test.ts` (the 62 ordinary / 303 dangerous corpora) | None | **Safe**, but not a delete: warnings are one lump. Needs a typed split «his eye» / «machine stop» across the policy hit, the gate, `decide.ts`, the card words (S) |
| 5 | Late note | `run.ts` `lateNote` / `LATE_CARD_MS`, `card.ts`; gate `notes` (`:372`) counts `notes: string[]` | `agent-card-flow.integration.test.ts`, `agent-card-words.test.ts` | The note itself: none. But notes are untyped strings — the same list carries «ma'lumot to'liq emas», «ochiq hisoblatish bor», the rail note, the tariff-mismatch note, `CALC_PRICE_UNSAID` (`run.ts:551-568, 1659-1705`). A blanket release frees those | **Safe only with typed notes** (S) |
| 6 | `language` | `auto-gate.ts:438, 531-542 languageAdmits`; `locale.ts` (384 lines); `memory.customerLocale`; `decide.ts approvedLocale` | `agent-auto-gate.test.ts`, `agent-auto.integration.test.ts`, `agent-policy-first-reply.test.ts`, `agent-policy-brain-fix.test.ts`, and the corpus: `LANGUAGE_DANGEROUS` (corpus lines 706-890, about 180 rows) labels «a reply in the wrong language» DANGEROUS | #1786 measured it: «Иудан Тошкентгача неча пул?» was answered in Russian; `parseCompose` defaults the model's label to 'uz'. #1788 lists four more shapes still owed. Nothing replaces the hold until wall 4 | **Not safe in stage 1.** Middle path that needs his answer: let a FIRST message that says no language («GS777», «5 куб 800 кг») go in the model's language; keep the hold for en / fa / zh and for a confident mismatch. The corpus rows must be re-labelled by decision, not deleted |
| 7 | `not_reply` | `auto-gate.ts:367` — kinds `price` (his typed 💵, `price-reply.ts`) and `hand_back` (`calc-loop.ts handleHandBack`) | `agent-auto-gate.test.ts`; auto verdict rows are written only for reply drafts (docs §18.3 «one row per reply draft») | `price` is HIS typed figure: a machine press removes his confirm (a typo goes out; A row 8). `hand_back` relays the VED's reason — words written for a seller, possibly with cost figures (law 4) | **Partial.** Open `hand_back` only (it was §18.4 3(d)), with the policy run and a no-money rule; never `price`. Needs the verdict plumbing for a non-inbound draft |
| 8 | `owner_figure` | `auto-gate.ts:415`; `owner-answer.ts answerHoldsFigure`; `numbers.ts`, `run.ts`, `types.ts` | `agent-auto-gate.test.ts`, `agent-owner-answer.integration.test.ts`, the corpus: `OWNER_DANGEROUS` (lines 1116-1197, about 80 rows) labels «his figure relayed without his ✅» DANGEROUS. His ⭐ (A row 19); the code comment cites law 4 | A figure typed in haste or meant for the AI, not the customer («tannarxi 900, 1100 ayt»); a decimal read two ways — the calc screen had to ask «1.125 dollarmi yoki 1125 dollarmi?» (#1302-#1312). From stage 3 the same rule would relay a VED's floor | **Not safe as a blanket delete.** Replace with an echo he confirms in one tap («Mijozga "… 1 100 $ …" ketadi — ✅»), or free only non-money figures (days, kg). Never extend to a colleague's figure |
| 9 | `repeat` | `eligibility.ts:83` (`anchorRepeats`: the anchor repeats one of the peer's previous three lines word for word) | grep finds `'repeat'` in `agent-send-step.test.ts` only | It is the one detector of a verbatim auto-responder Telegram does not flag. Deleted together with `streak`: an open loop | **Replace, do not delete**: answer the first repeat (the impatient customer), hold from the second identical line inside N minutes |
| 10 | Card-must-ring (the hold) | `auto-send.ts` (`unseen`, `countdownMayRide`, `copyRang`, `cardOnScreen`, `hold_sec`), `auto-card.ts`, `drafts.ts`, `platform/notifications/service.ts` (`shown`, `rang`); the press is `jobs.ts` step 7, a MINUTE sweep, batch 20 | `agent-auto.integration.test.ts`, `agent-auto-card.test.ts`. His ⭐ (A row 17). The hold is also the only ⏸ / ❌-before-read, and the card is where 👎 is pressed — the input of `AUTO_STEP_DOWN` (2 × 👎 in 7 days) | No window to stop a wrong reply; the step-down loses its signal unless the sample and the journal's 👎 exist the same day and feed the same counter | **Safe only together with**: the sample + journal wired into the step-down; an inline press (see D-3 on «< 1 min»); his answer for money acts |
| 11 | Price / calc / VED price «on by default» | The stored row `agent_auto_config.categories` | SPEC-P1 Q1, SPEC-P2 Q1-Q2 ⭐ a; 0148 / 0149 comments «the STORED row is NOT changed» | A migration overrides his own setting; the first truck price still waits (`tariff_confirmed_at` NULL since 0148), the first VED price too (`markup_unconfirmed`) | **Not stage 1 — it is stage 0** (three ticks, «Tarif to'g'ri», the markup stamp, the seat, «Ish raqami») |
| 12 | 2-3 messages per turn + a holding line | See below | See below | — | **Not possible in stage 1 as written** |
| 13 | Night replies | `auto-gate.ts:456` (two halves: the send moment and the card's arrival); the pump already sends at night when the customer wrote < 2 h ago (`send-step.ts:664 releaseAt`, `nightFinishMs`) | `agent-auto-gate.test.ts`, `agent-send-step.test.ts`; A row 15 | Eight to ten hours nobody watches (cards arrive silent, the sample is next evening); a hand-over promised «30 daqiqada» at 03:00; a 24-hour instant responder is the opposite of «odamga oxshab» | **Safe after Q14**, as: replies to a fresh inbound only, no hand-over clock at night, the holding line says «ertalab». Small (S) |
| 14 | Cards «only for exceptions, to a supervisor» | Cards go to `userIds: [managerUserId]` (`drafts.ts:391, 541`); every press is refused `not_account_holder` unless the actor IS the holder (`decide.ts:960, 1421`; ✍️ `:1487`; `bot-door.ts:461`); reminders `jobs.ts remindOwnerQuestions` | Review leak-5 and answer 15 (A row 25); #1800 widened only tuning and arming, never the press | A second person pressing ✅ / ✍️ on the seat's words needs a new authorisation rule; the card line `cardLineOf` shows the VED figure and the client price together (law 4) | **Move to stage 3.** In stage 1 keep the holder — he said he watches in that account |

**Row 12 in full — is «several messages per turn» possible today? No.**
- `agent_outbox.draft_id` is `UNIQUE` and `body` is one text (0138:186-210): one draft = one message. The live draft
  is one per chat (`agent_drafts_live_unique`).
- `send-step.ts:378` `liveHeadVerdict`: any out message newer than the anchor that is not this row's cancels the
  reply as `human_replied`. The `forgiven` set (K1) is passed ONLY for owner-started drafts (`send-step.ts:69-74`),
  and its emptiness for every other draft is pinned as a REQUIRED argument. The stored check `humanReplied`
  («an out row … that is not this outbox row», `:77`) says the same.
- The listener turns an OUT row with no `agent_outbox` row into `agent.human_reply` → the live draft `taken_over`.
- Parts would be 20 s apart (`perChatGapMs`), each with its own read → typing → send, so a customer answers between
  them: parts 2-3 are then cancelled `anchor_superseded` (`:209`) — half an answer delivered. A price and its «boj va
  QQS alohida» sentence must therefore stay in ONE part; G11 (`estimate_unhedged`) checks «its own clause».
- Each part spends the caps: `perChatPerDay` 12 = four turns a day; the hour cap 20; the day cap 80 (CHECK ≤ 200).
- The holding line: K1 already forgives the AI's own sends for an `owner_edit` redraft, so the cheap half exists. What
  does not: a question must stay answerable (✍️ needs a `pending` reply draft) while its holding line is `approved`
  and sent — `agent_drafts.status` has no such state. That is a CASE record, i.e. stage 3's substrate, needed here.
- The answer may come after 24 h: `runOwnerTriggered` then skips `no_fresh_inbound` (`run.ts:1853`) and the send step
  refuses `anchor_too_old` — the customer was promised an answer that can no longer be sent.
- Under the OLD rules, which stage 1 keeps, the holding line's natural wording is refused: «bir daqiqa», «30 daqiqa
  ichida», «tez orada» are a spelled numeral beside its unit or a time promise (G1 / G2, #1610). It must be a fixed
  system sentence in six languages — he cannot read two of them.

**True size of stage 1.** Deletions and typed warnings / notes: S. Loop detector, per-chat dials, night: S. Multi-part
outbox + holding line + case record + anchor rules: M-L. Supervisor authorisation: M. Morning report + sample +
liveness alarm: M (the sample needs storage — `agent_auto_verdicts.feedback` CHECK admits `'bad'` only, and only on a
`pressed` row). Prompt and persona rewrite: unmeasurable here — no corpus holds MODEL outputs, and the «seller with a
goal» prompt will hit G2 more often (it blocks «qulay narx», «yaxshi narx qilamiz» for him too), so blocked drafts
rise, not fall. **Total L.** Split it (table E).

---

## C. HIDDEN BLOCKERS per later stage

**Cross-cutting — lay ONE migration early instead of re-making a CHECK per stage.** Constraints later stages hit:
`agent_runs_trigger_check` (inbound, owner_edit, calc_answer, hand_back, style) and `agent_runs_anchor_check`;
`agent_drafts_kind_check` (reply, price, hand_back), `agent_drafts_category_check`, `agent_drafts.anchor_tg_message_id
NOT NULL`; `agent_outbox.answers_tg_message_id NOT NULL`, `draft_id UNIQUE`, text-only `body`;
`agent_auto_config_categories_check`; `agent_auto_verdicts` state and feedback CHECKs; `telegram_chat_waits_kind_check`
(re-made in 0138 and 0148); `ai_calc_passes` kind CHECK (intake, grouping, pick, invoice, similar, tnved, tarkib — and
`tests/unit/ai-press.test.ts` fences the LAST migration that re-makes it). Each re-make is a deploy-order hazard (0148
was one-way) and each change to `send-step.ts` / `limits.ts` needs tg-listen rebuilt.

**Stage 2 — eyes and ears.**
- The model seam is PLATFORM: `platform/ai/model.ts ModelBlock` has no image or document member and
  `tool_result.content` is a string (map-senses §1.3); the staff assistant shares it.
- `context.ts chatMessages` carries no attachment id; a video is called «fayl».
- The existing readers stream for up to 150 s on the analyst model; a run has `maxTokens` 1 500, 60 s a call, 90 s
  wall. A reading is a JOB, so the turn becomes two-phase (acknowledge → event → answer) — it needs the engine of
  stage 1b, not stage 1.
- Figures from a file or a voice note are not «the customer's own line»: tools admit only figures `stated` in the
  recent window (`tools.ts`), and the policy ledger knows the origins tool / kb / customer. A new origin with lower
  trust and a read-back state are new rule readers — the spec's read-back is not sized.
- Billing: no ledger kind for the agent's readings; `daily_token_cap` counts cache writes; voice duration is computed
  by `tgMediaPlan` and stored nowhere, so «minutes a day» cannot be budgeted without a column.
- No ffmpeg in the image, and the house has refused an apt step in the Dockerfile before (round 104's backup fix;
  #1228 fences an offline build): the provider must take Ogg / Opus as stored. Customers' voice goes to a third party — say it in Q16.
- Other seams: `send-step.ts:340 asksAnew`, `worthy.ts` `media_only` / `voice_only`, `auto-send.ts burstHadMedia`,
  `calc-files.ts` (`calc_file_missing`), `prompt.ts MEDIA_WORD`. File text is a prompt-injection door (rule 7 covers
  chat text only).
- Size: eyes **M-L**, ears M.

**Stage 3 — routing and the new guard. Really two stages.**
- No stage builds the engine (act-in-run, events, conversation record). §4 lists it as a block; §7 never builds it.
- Routing: the press rule (B row 14); `platform/telegram/reply-door.ts` is the precedent for a swipe-reply; every new
  notification type must join `MUTE_GROUPS` (its tripwire reads `buildRecipients`); staff with no linked chat or a
  mute never hear a case; the staff handlers are PLATFORM and reach `wms/agent` only by dynamic import.
- Law 4 (A row 32): the VED's case must be money-free (precedent: the money-free «AI izohi (VED uchun)» of
  docs/IKKI-ESHIK.md), and a colleague's figure is never a source.
- Blocks «in wording he approved once per language»: six languages, he reads two (that is why `gloss_uz` exists).
- «No digit in the model's own sentences» collides with ordinary knowledge: «15-25 kun», «1 kub yoki 100 kg», working
  hours, the phones inside an address fact. Every numeric fact must become a block — the 14 seeded facts and every
  fact he adds in Uzbek.
- The reviewer cannot run in CI (no key in the build environment, CLAUDE.md), so the house ritual — a red proof by
  string edit — cannot prove wall 4. The exam of 898 + 303 cases needs the server's key, money, repeats and a pass
  rule for a judge that is not deterministic; «all stopped» is not provable as written. Say fail-open or fail-closed
  when the provider is down.
- The nightly fact check «vs the database at that minute»: there is no point-in-time state. `agent_runs.tool_calls`
  keeps 500 characters of a tool answer (an address fact is longer), knowledge facts are edited in place, a cargo
  status of a past minute is not reconstructable. Re-word: against the stored block and its source row's version.
- Per-action step-down needs per-action records; today one row disarms everything.
- Size: 3a inbox + routing **M-L**; 3b guard **L**.

**Stage 4 — the price to the end.**
- Customs estimate: `aiPrefill` runs on a job already in the VED's queue, with a 10-minute deadline and a 200-a-day
  budget shared with the sellers (SPEC-P2 Q10 ⭐ a); the agent loop queues a reply only for `done` / `sealed`
  (`calc-loop.ts`), so `estimate` is a new event. Three fences (A row 9). «Taxminiy» is whole or absent. **No range
  exists** — Q6 ⭐ b promises one. «Goods the VED calculated before» must be defined (a `calc/memory.ts` hit on every
  line?).
- Kashgar / Horgos: `origin.ts` refuses `western`; `tariff-watch.ts` confirms the China column only — a stamp per
  column is needed.
- **The dated item:** the website table ends 2026-12-31; from 01.01.2027 every truck price comes from `freightFor`'s
  list with «15-25 kun» (docs §18.8), and the first one waits for «Tarif to'g'ri». It lands inside stages 1-2 whatever
  the order — put it on the road.
- PDF as a file: the agent adapter sends text only; and an offer PDF exists only for a CALC offer
  (`calc/offer-sheet-file.ts`, by offer id). A table-price quote has no offer row, so no PDF.
- «Quote on the card»: a deal's quote pre-fills the truck bill the accountant saves (`prefillFor` /
  `expectedPartFor`, docs/NARX-VA-RAQAM.md) and feeds `priceControlOnReceipt` and `DealDeviation`. An AI quote there
  is billing money, not chat text.
- **Q12 ⭐ a has no source.** `batches` carries `departed_at`, `arrived_at`, `closed_at`, `sent_to_agent_at`,
  `customs_cleared_at` — no planned departure; a schema-wide grep for a planned or expected departure date finds
  nothing. A logist-entered date must exist first, or the ⭐ moves to b.
- Size **M-L**, after stage 2 (the goods must be read) and 3b.

**Stage 5 — closing. L, not M.**
- Act-then-speak: the reply is composed BEFORE the action runs, so it cannot contain a code that does not exist yet.
- For a lead, «GS code» is `winLead` — mint, deal, re-key of the calculations and the chat in one ceremony;
  `tests/unit/won-law.test.ts` pins that no other door writes a won stage.
- `rekeyLeadChats` turns the chat from a lead's into a client's between draft and send: the send step cancels the
  closing message as `identity_changed` (`send-step.ts:218`), and `cargoAllowed` stays false until the phone is on
  the card. A hidden-number lead gives `phones: []` → no cabinet link (`no_phone`).
- The seat as minter and seller: `celebrateNewClient(minter)` / `celebrateLeadWon(owner)` post in the staff group
  (0134), `stampFor` stamps every later prixod to the seat for good, KPI months close on the 8th. The pay and rating
  rule cannot wait for stage 9 — it is already accruing (map-sale-doors j2, j4).
- `client_code_next` burns a number per junk code. The duplicate rule is «warn, never refuse» because one person
  holds several codes (#407) — a machine needs its own rule.
- The bot link at closing: policy `url` (a link only from a knowledge fact — none names the bot) + `url_cap`
  (`policy.ts:2873`: ANY link already sent to this chat in 7 days blocks, and ten a day — shared with the map link).
- The Chinese paragraph: G5 `wrong_script`, `gloss_missing`, `numeral_unread` hold it unless it is a block.
- Expected arrival: `createExpectedArrival` needs a warehouse; its difference alert goes to the author — the seat.
- Prixod → deal: an event from the seat's own staff inbox (`ReceiptConfirmed`), `linkReceipt(…, ftlDoor)` REQUIRED,
  `mayRefileReceipt` (0150), `bornWithVerdict`. Today the admins are NOT told about a seat-owned prixod, because the
  seat «has a chat» (`sellerReach`).
- The passport and the promises ledger are needed from stage 1b (cases) — not here.

**Stage 6 — negotiation and money.**
- Nothing records a table-price quote, so «once per deal» has nothing to count against (needs stage 4's quote).
- The freight discount is the VED's and the admin's (`freight_list_usd`; `discounted_no_upsale`, #878; `calc_price`
  refuses `discounted`). Below the floor needs an approver with `finance.reports` — not the seat.
- Law 4, A row 32 (a).
- Reminders on day 3 and 7 are WRITING FIRST, placed before stages 7-8: carry them by the company bot (a new
  `client_notices` kind and sweep; linked customers only) or move them.
- «To'ladim» + cheque needs stage 2 and a new queue (precedent: `expense_requests`).
- Check the actor gates of `recordPromise` and `requestIssueApproval` against the seat's role before promising them.

**Stage 7 — the channel. L, not M.**
- `bot.ts:168` takes the default updates + `chat_member`; Business updates are new, under the redelivery rules of
  0130 and a sequential poller (#706).
- A message the bot sends appears to the gramjs listener as an OUT row with no `agent_outbox` row: today that is «a
  person answered» — the draft is `taken_over`, the 120-minute pause starts, the streak resets. It must be reconciled
  (carrier column, echo binding; `random_id` is MTProto's).
- The live-head check is gramjs-only (a bot cannot read history), and replies up to 7 days old (a VED price, his 💵)
  are outside the bot's 24-hour window: both carriers stay for ever.
- `agent_config` is a singleton with one holder; `started_at` is never reset on an owner change, so a reserve number
  starts at the full cap on its first day.
- The AI inside the company bot: those conversations are not in `tg_messages` (the bot relays, it keeps no thread),
  while every agent table is keyed (manager, peer). A channel abstraction, reached from PLATFORM
  (`client-cabinet.ts`) by dynamic import only.

**Stage 8 — writes first.** The NOT NULL anchors and CHECKs above; G10 `fingerprint` blocks one text to more than
three peers in 24 h; `never_wrote`, `anchor_too_old`, `approvalMaxAgeMs` 6 h. Journey relay to unlinked customers:
`client_notices` claims exist only for a linked chat (`hasLinkedChat`), so there is no row to relay — a second claim
ledger; a batch code is never named; «why late» has no data. SPEC-P3 exists and was never judged.

**Stage 9.** The replay / dry run and the pay rules come too late (table E).

---

## D. FACTUAL ERRORS in the spec

1. **§0 «release needs 47 conditions true at once».** There are 47 refusal CODES (`AUTO_REFUSALS`); about 30 apply to
   an ordinary reply — the calc, calc-price, estimate and owner-answer codes are asked only of those drafts.
2. **§0 «the prompt forbids … writing first».** No prompt rule says so; it is schema and send step (`never_wrote`,
   NOT NULL anchors).
3. **§1 «answer < 1 min any hour».** Not reachable on today's path: 12 s debounce + up to 60 s more for a greeting-only
   burst + the run (up to 90 s) + the MINUTE sweep that presses + a 10-25 s account gap + 1-3 s read + 3-12 s typing. Say «1-3
   daqiqa», or put an inline press on the road.
4. **§3 «the ~9 000 lines of word readers go».** The six files it names hold 6 635 lines (`policy.ts` 2 931,
   `numbers.ts` 1 602, `digits.ts` 1 331, `locale.ts` 384, `destination.ts` 264, `auto-money.ts` 123), and a large
   part stays under the spec's own rules: the G6 leak fences, the customer-figure reader («the customer's own figures
   echoed»), the digit folding the «no digit» check needs.
5. **§3 «holds that protect nothing».** Two of them guard cases the project labelled dangerous with zero tolerance
   (B rows 6, 8); one is his ⭐ answer (B row 2).
6. **§3 «898 + 303 … all stopped by SOME wall».** The 898 include the `lesson` and `phone` readers — doors for HIS
   input, which no outgoing-message wall covers — and the `language` / `owner_figure` rows stage 1 lets through two
   stages before the walls exist.
7. **§3 staging «stage 1 only DELETES».** §7's stage 1 also builds: several messages, the holding line, dials,
   supervisor cards, the morning report, the sample, the alarm, a new prompt.
8. **§7 stage 1 «pressing ✅ on almost everything he pressed on 11-15».** #1800: all nine replies of that day carried
   `low_confidence`, beside `category` (no «Narx» box), `money`, `warnings`, `notes`, `needs_owner`. The first three
   are stage 0 settings. Which deletions matter is a query — `agent_auto_verdicts` stores every reason of every
   draft; add that histogram to stage 0's census.
9. **§9 «today ≈ $5-7/day».** That is docs §18.1's estimate at the 150-run cap. The one measured day had nine
   replies.
10. **§1 Closing lists «GS code» and «lead won» as two acts** (and §2 as two T3 rights). For a lead they are one door.
11. **Q12 ⭐ a and Q6 ⭐ b** recommend what no data or arithmetic supports (C, stage 4).
12. **§2 / wall 5 «withdraw an unread message».** The adapter has no delete, nothing tracks whether OUR message was
    read, and the customer's phone has already shown the notification. Call it «delete if unread», not a safety wall.
13. **§3 «`design-risk.md` §3.7 adopted» wholesale** includes deleting `human_active` on the ground that nobody types
    on the seat — he said he does (A row 26) — and `calc_recent`, `answer_stale`, `too_long`, which stage 1's own
    list does not name. Either list them in stage 1 or say they wait.
14. **§5 «He refused a Business bot once … on a dedicated seat it is re-asked»** is right, but the claim that the
    reason is gone is the design's inference; his sentence gives no reason. Ask, do not argue.

---

## E. CORRECTED ROAD

| # | Stage | What changes against the spec | Size | Depends on |
|---|---|---|---|---|
| 0 | Today, no code | + the three kind ticks (moved from stage 1); + the refusal histogram from `agent_auto_verdicts`; + the Business trial on a test phone (moved from stage 7's precondition — its result shapes 1b's outbox); + the STT trial; + decide the seat's pay | — | — |
| 1a | **Bo'shatish** | `low_confidence` out; typed warnings and notes (`questions`, the late note); the four ordinary labels free, `complaint` kept; `hand_back` opens; per-chat dials; night after Q14; ONE loop detector replacing `streak` + `repeat`; `language` relaxed for a first message that says no language only; the seat out of KPI pay, rating and celebrations (already accruing). `owner_figure` only as a one-tap echo | S-M | Answers to A rows 15, 17-20; Q14 |
| 1b | **Suhbat dvigateli** (missing from the spec) | The conversation record (state, cases, promises); event triggers and nullable anchors in ONE migration; multi-part outbox; the holding line as a system sentence; an inline press; acts inside the run for T2; the new prompt and persona, measured by a replay of real chats in dry mode on the server (moved from stage 9) | **L** | 1a; Q1, Q2, Q17 |
| — | Tariff cut-over | The website table ends 31.12.2026 — rehearse the `freightFor` path and «Tarif to'g'ri» before that date, wherever the road stands | S | a date, not a stage |
| 2 | Ko'radi va eshitadi | Eyes M-L (two-phase turn, platform seam, a new source origin); ears M after the trial | M-L + M | 1b; Q15, Q16 |
| 3a | Istisnolar qutisi | Routing, clocks, colleagues' answers, the supervisor press rule with a law-4 sight | M-L | 1b; Q17, Q21 |
| 3b | Yangi qo'riqchi | Blocks, reviewer, rights table, limits ledger, fact check against stored blocks; the exam harness on the server; word tables go last | L | 1b, 3a |
| 4 | Narxni oxirigacha | As the spec, minus «next planned truck» until a date exists; plus the quote record | M-L | 2, 3b; Q6, Q9, Q11 |
| 5 | Savdoni yopadi | As the spec; the passport moved to 1b | **L** | 1b, 3b, the seat's pay rule; Q8 |
| 6 | Savdolashadi va pulni eslatadi | Reminders by the company bot only until 7-8 | M-L | 4, 5; Q7, Q25 |
| 7 | Xavfsiz kanal | Two carriers for ever; the bot channel needs a channel abstraction | **L** | the stage-0 trial; Q26-Q28 |
| 8 | O'zi yozadi | The Friday greeting is his standing request (SPEC-P3, small): either build it now on the session with its own fuses, or get his «yes» to the delay (A row 5) | M-L | 7 for volume; Q23, Q24 |
| 9 | Hodim sifatida o'lchanadi | The KPI page and self-report only — the pay rule moved to 1a, the replay to 1b | M | 3b's records |
| 10 | Other channels | unchanged | L each | 7's abstraction |

**Questions to add or split** (numbers refer to table A): 2, 4 + 5 (the Friday greeting by name), 7, 8, 10 (the open
#1800 question), 12 (is the avia address one address?), 17 (the hold for money acts), 18, 19, 20, 21, 26, 28, 29,
32 (who may see the floor on a card), 35. **Required before stage 1a:** Q1-Q3, Q14, and the new ones for rows 17-20.
