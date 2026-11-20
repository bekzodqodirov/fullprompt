# To'liq AI sotuvchi — COVERAGE: every answer traced to the stage that builds it, the seams between the seven plans, and the ONE list of questions still to ask him

| | |
|---|---|
| What this is | The conformance pass over the seven build plans of this folder, made 2026-11-20 at HEAD `bf37150c` (docs only; no code, no suite, no build). It answers three things for the session that builds: **(A)** is every answer of design §11 built somewhere, **(B)** does any plan undo a binding correction, **(C)** do the plans fit each other — and it ends with **(E)** the one numbered list of questions for the owner |
| Outranked by | `docs/AI-SOTUVCHI-TOLIQ.md` §11 (his answers) → `docs/AI-SOTUVCHI-TOLIQ-QURISH.md` (the contract) → the stage plan. This file changes no rule; where it and a plan disagree about a NAME, the plan was edited to match and says so under its «## Conformance» |
| Verdicts | **built** = a named step of a named stage builds it · **partly** = built except a part that waits for his answer (the part is named) · **missing** = no plan built it · **contradicted** = a plan built the opposite. «→ fixed» means this pass edited the plan; the plan's «## Conformance» section says what and why |
| Result | 35 rows of §11.1 (the name, 1-32, the SIM, avia): 34 built, 1 partly (avia — waits on his §11.3-2). No row was missing outright. FOUR places contradicted an answer or a binding rule and were fixed (rows 1, 16, 25 and the read-figure rule), and ONE piece was planned a stage too late (the seat's mail, row 31 / §C.6) |

---

## A. Coverage of §11.1 — answer → rule → where it is built → verdict

| Q | His answer | The rule (short) | Built in (file § / package) | Verdict |
|---|---|---|---|---|
| name | «Bekzod» | persona «GSR sotuv menejeri ‹ism›»; never says it is a person; the name is a setting he types | `STAGE-0-1A.md` §3.3 `agent_persona_name`, §4.4 P3, §6.1 (head), §9 (he types it); the `staff_name` exemption for the persona word §4.4; `ai_denial` kept; `STAGE-3B.md` §6.2 #61 (`claimsHumanAs`) | built |
| 1 | b ⚠ | «botmisiz?» → one honest system line, then the rest of the answer | `STAGE-0-1A.md` §4.4 (`withBotAnswer`, `AI_HONEST_LINE`), §4.2 (the bot-question step-down DELETED) | built — `STAGE-3B.md` §4.6 still counted on the deleted step-down: **contradicted → fixed** |
| 2 | a | bare price with kub+kg → table figure, then «rastamojka … hisoblab beraymi?»; «ha» or an invoice → VED job | `STAGE-0-1A.md` §6.1 rules 8 / 11, `CUSTOMS_OFFER_SENTENCE`; the invoice's ROWS: `STAGE-2.md` §4.4 (`use_readings`, after the typed «ha») | built (the invoice half arrives with stage 2; provable only live — 1a §7) |
| 3 | b + note | ≥ 20 kub or «fura» → answers AND signals; who and the line are settings; 100 m³ / 20 t ceiling stays | `STAGE-0-1A.md` §3.3 (`agent_big_cargo_m3`, `_words`), §4.5 (`designated('big_cargo')`); on a VED price: `STAGE-4-6.md` §4.4 P5 | built |
| 4 | a ⚠ | night: answers who writes, never first; colleagues' cards wait | `STAGE-0-1A.md` §6.2 (night by class), §4.5 (the signal — night-silent, **stated → fixed**); `STAGE-1B-1C.md` §4.3 (the clock does not run at night); `STAGE-3A.md` §4.1 (`notify_after`) | built (question 29 below: «silent at night» vs «at the next working minute») |
| 5 | b ⚠ | his; 15 working minutes → deputy too; only the two write from the number | pair as DATA: `STAGE-0-1A.md` §3.2; recipients, pressers, escalation: `STAGE-1B-1C.md` §4.3 P3; writing from the CRM as the seat: `STAGE-3A.md` §4.5 (coded clients; lead chats from the phone — question 35) | built |
| 6 | c | every cargo visitor → the AI; «Sotib olib berish» stays with people; never «nobody» | `STAGE-0-1A.md` §4.7 P5 «Hajm» (`lead_assign_ai`, `seatCandidate`, roster fallback) | built — ships `off`, the flip is his tick; the ⭐ that delays it now carries its ⚠ (**→ fixed**, question 7) |
| 7 | b | seller-less clients: one bot message + the AI number where a manager would be | `STAGE-0-1A.md` §4.7 (`noManager` audience, `managersFor`, `client_ai_contact`) | built |
| 8 | b | colleague's customer: status / addresses / table price alone; money → that seller, answer returns; seller's price outranks | alone-part: today's behaviour, kept (`STAGE-0-1A.md` §5); the rest: `STAGE-3A.md` §4.4 P4 (`colleagueOf`, `sellerPriceStands`); in the bot: `STAGE-7-9.md` §A4 | built (from 3a) |
| 9 | a | ten 👍/👎 every evening for a month, then weekly | `STAGE-0-1A.md` §4.5 (`agent_samples`, smallest form); full screen `STAGE-3A.md` §4.6; mistake signal `STAGE-3B.md` §4.6; bot turns `STAGE-7-9.md` §A4.2 | built |
| 10 | c ⚠ | no dollar limit; meter and 20:00 line stay | `STAGE-0-1A.md` §4.6 (token / run fuses kept, re-worded); count caps only in `STAGE-2.md` §3, `STAGE-3B.md` §3.3 | built (nothing in any plan stops on dollars — §B.7) |
| 11 | a ⚠ | talk at once; a price waits 2 minutes with ⏸ | `STAGE-0-1A.md` §4.2 (`holdSecFor`, `pressNow`); `STAGE-1B-1C.md` §4.4 (`JOB_AGENT_PRESS`); as a limit of the price rights `STAGE-3B.md` §6.3 | built |
| 12 | a | the session only | by absence in every plan; `STAGE-1B-1C.md` §3.2 (no outbox `carrier`); `STAGE-7-9.md` §A2 | built |
| 13 | a | speech trial; until it passes «yozib yuboring» + a card; then read-back + typed «ha» | trial: `STAGE-0-1A.md` §4.0 (c); the line: §4.4; ears: `STAGE-2.md` §4.6 P5 (only if the trial passes) | built |
| 14 | b | topics → VED / logist / accountant / warehouse / him; 15 min then the pair; VED's card has no client price | `STAGE-3A.md` §3.3, §4.1 P1, §4.2 P2 (the money refusal at the answer door), §5 | built |
| 15 | a | «telefon qiling» → number + hour → a task; who is a setting | `STAGE-3A.md` §4.3 P3 (`hand_over`, `designated('callback')`, task origin `agent`) | built |
| 16 | b ⚠ | code alone, ≤ 10 a day, each shown to him for two weeks; one-tap first | one tap: `STAGE-1B-1C.md` §4.6 P6; alone: `STAGE-4-6.md` §5.3-§5.4 P1 («Ha», `limits.perDay`, the watch window, cancel) | built — `STAGE-3B.md` §6.3 said «O'zi at stage 5»: **contradicted → fixed** («Nazoratda») |
| 17 | c | avia address: his, each time | `STAGE-1B-1C.md` §4.6 (no address block on a flight); `STAGE-3B.md` §4.2, §6.3 (`tell_avia_address` fixed «Faqat odam»); `STAGE-4-6.md` §4.2 | built (by keeping `withAviaRule` untouched) |
| 18 | note | Horgos priced by the Kashgar column; Kashgar's address from him | `STAGE-4-6.md` §4.3 (`tariff_zone_follows`, chosen on `/admin/tarif`), §4.4 P1 (`withOriginAddressRule`, `origin_address`) | built; «do we receive in Kashgar» is question 3 |
| 19 | c | another city: his | `foreign_destination` kept (`STAGE-0-1A.md` §6.2); `STAGE-3B.md` §4.3 (refusal inside the price tools), §6.3 | built |
| 20 | a + note | sells three services; pickup and buying: collect, hand over; to whom — on a screen | `STAGE-3A.md` §4.3 P3 (`designated('pickup')`, `designated('buying')`) | built |
| 21 | a | names the ways to pay; the card number from a person (a setting) | `STAGE-3A.md` §4.3 (a Bilimlar fact — his chore), §4.2 (`card_number`, verbatim, always a card) | built |
| 22 | a | told too low: ≤ $50 keeps, above corrected with an apology, he is told | `STAGE-3B.md` §4.6 (nightly), `STAGE-4-6.md` §4.4 P4 (a new VED answer) | built — two setting keys and two releases of the correction: **→ fixed** (one key `agent_low_quote_keep_usd`, one right `correction`) |
| 23 | c ⚠ | discount alone only out of the markup; empty markup or table price → his card | `STAGE-4-6.md` §6.4 P1 (`concede`, the card) | built — right named twice: **→ fixed** (`give_discount`); the markup is question 1 |
| 24 | a ⚠ | two reminders, then stop; daytime; 10 a day; «yozmang» for good; a block stops all | `STAGE-7-9.md` §B4.1 P1, §B4.2 P2 | built |
| 25 | b ⚠ | balance alone when asked in a proven chat; the amount once through the bot | `STAGE-4-6.md` §6.4 P2, P3; in the bot `STAGE-7-9.md` §A4.2 | built — start position «Faqat odam» in one plan and «only at O'zi» in another: **contradicted → fixed** («So'rab» → he sets «Nazoratda»; the bot answers at «Nazoratda» too) |
| 26 | a ⚠ | Friday greeting: seat only to 90-day writers, shared 10, monthly; others via the bot with «🔕»; approved once | `STAGE-7-9.md` §B4.3 P3 | built |
| 27 | a | no road news unasked | `STAGE-7-9.md` §B2 (forbidden), §B7 (fence on `SWEPT_NOTICE_KINDS`) | built (by absence, fenced) |
| 28 | a | company bot: AI answers status, addresses, standard questions; the rest to the seller | `STAGE-7-9.md` §A4.1 P1, §A4.2 P2 | built |
| 29 | b ⚠ | told price on the card with validity; PDF from the AI number | `STAGE-4-6.md` §4.4 P2 «Daftar», P3 «PDF» | built |
| 30 | a | a reserve number (real SIM) | `STAGE-7-9.md` §A4.4 P4 | built |
| 31 | c + note | counted like a seller — and a setting with three modes; the seat STAYS in KPI and rating | key: `STAGE-1B-1C.md` §3.4 (`agent_won_ownership = seller`); modes + screen: `STAGE-4-6.md` §5.4 P5; pay: `STAGE-7-9.md` §C4.3 | built — a second «how the seat is counted» home and a second refusal code in stage 9: **→ fixed** (one home `staff/seat-mode.ts`, one code `not_payable`) |
| 32 | a | the order of §7 | the contract's §3 table; each plan's «Depends on» | built — one reverse dependency (1c needed stage 5's mail fix): **→ fixed** (§C.6) |
| SIM | «bekzod» | the seat's SIM and phone are with him | `STAGE-7-9.md` §A3 (topic `seat_phone` — he designates himself), §A4.3 (the alarm's steps) | built (nothing reads it before stage 7) |
| avia | «saytda $9-17/kg, 3-5 kun» | said as on the website | days: `STAGE-4-6.md` §4.4 P7 (`agent_avia_days`; may ride any earlier deploy — **→ fixed**, §4.8); the rate inside $9-17: not built, two designs stated in §4.10 | **partly** — waits on question 2; until then «avia as today» (design §11.3) |

### A.2 §8 «decided without a question» — where each is held

| Decision | Held in |
|---|---|
| ordinary talk goes alone | `STAGE-0-1A.md` §6.2 |
| rail unchanged; under the minimum → says it, offers avia | untouched (`withRailRule`, the truck-minimum note — `STAGE-0-1A.md` K5); `STAGE-3B.md` §6.3 (`tell_rail_price` fixed) |
| reads files and reads back | `STAGE-2.md` §4.4 |
| complaints never silent, he decides | tripwire + label `STAGE-0-1A.md` §4.4, §6.2; the sentence, the case, the hold `STAGE-3A.md` §4.5 |
| no language shown → Uzbek Latin; `language` strict on money | `STAGE-0-1A.md` §6.2 |
| ANY figure in his or a colleague's answer → a card | `owner_figure` kept in every plan; `STAGE-3A.md` §4.2 |
| his own typing pauses the AI | `human_active` untouched everywhere; `STAGE-3A.md` §4.5 gives the chat back only by the pair's button |
| two-in-a-row goes, a loop detector replaces it | `STAGE-0-1A.md` §4.3 — one deploy with P1 (**→ fixed**, §8) |
| the AI asks the city, never picks | `STAGE-1B-1C.md` §4.6; `STAGE-3B.md` §4.2 |
| only he approves knowledge | `STAGE-1B-1C.md` §4.3 (`mayApproveKnowledge`); `STAGE-3A.md` §4.2; `STAGE-3B.md` §5 |
| Pashto → one line | `STAGE-0-1A.md` §4.4 |

### A.3 §11.2 — «do not hardcode who»: every hand-over reads ONE table

| Who receives | Topic (key) | Minted in | Fallback |
|---|---|---|---|
| everything nobody else is named for; the deputy | `supervisor` — «Rahbar va o'rinbosar» (rank 1, rank 2) | 1a | the people today's alarms reach, through the EXISTING reader |
| the big-cargo signal | `big_cargo` | 1a | the pair |
| customs / truck / money / pickup questions | `customs`, `logistics`, `money`, `warehouse` | 3a | customs: the existing VED rota pool, then the pair; others: the pair |
| the call-back; factory pickup; «sotib olib berish»; the card number | `callback`, `pickup`, `buying`, `card_number` | 3a | the pair |
| a big customer's seller; whom AI customers are handed to | `big_customer`, `handover_seller` | 5 | the pair / no hand-over |
| cheque claims; «qarzga bering» | `payment_claims`, `debt_request` | 6 | `money`'s people / the pair |
| who holds the SIM; the reserve phone | `seat_phone`, `reserve_phone` | 7 | the pair |
| how AI customers are counted | not a person: the setting `agent_won_ownership` + its screen | 1c key, 5 screen | `seller` (= today) |

A colleague's customer → «that seller» (8 b) is a fact of the card, never a designation. **Fences:** 1a's designation test now refuses a role key, a uuid or a name in its five new files and its migration (added by this pass); 3a's `agent-topics-registry.test.ts` does the same for six files. **Every later stage that adds a file which addresses a person appends it to that list** — the rule is only as wide as the list.

---

## B. The binding corrections — where each is held, and what this pass had to fix

| # | Rule no plan may undo | Held by | Found / fixed |
|---|---|---|---|
| 1 | no word rule deleted before the protocol has run and he has seen the missed list | `STAGE-0-1A.md` K1 (the 303 committed, walls snapshot FIRST); `STAGE-3B.md` §7.1-§7.3 (protocol, the door `retireGuardStep`, his choice per class); every other plan's FORBIDDEN list | clean. 1a removes gate codes (`low_confidence`, `streak`, `category`), not word rules — each sanctioned by design §7 row 1a |
| 2 | in 1a: `language` on money, `owner_figure` (any figure), the `complaint` label, his own-typing pause stay; `streak` + `repeat` leave only with a loop detector | `STAGE-0-1A.md` §6.2, §4.3 | P1 (deletes `streak`) and P2 (builds the loop) were two packages with no rule tying them — **fixed**: one deploy, §8 |
| 3 | from 1b an act happens BEFORE the reply that speaks of it | `STAGE-1B-1C.md` §4.2 (`ask_owner` in the run; `calc_submit` lands before its reply is queued), §4.6 (the code before the closing turn); `STAGE-3A.md` §4.3; `STAGE-4-6.md` §5.4 P1, §6.4 P1 | clean |
| 4 | law 4 on every card; a VED answer relayed as given is the floor | `STAGE-1B-1C.md` §5 (`cardSightFor`); `STAGE-3A.md` §4.2 (refused at the door), §5; `STAGE-3B.md` §5; `STAGE-4-6.md` §4.5, §6.5; `STAGE-7-9.md` §A5, §B5, §C5 | clean |
| 5 | no image or PDF block inside the run loop | `STAGE-2.md` §2 FORBIDDEN, §4.1 (a separate call per attachment), the fence `agent-said-text-fence`; `STAGE-3B.md` §4.4 (the reviewer never sees raw file text) | clean |
| 6 | a read or heard figure satisfies no tool before the typed confirmation | `STAGE-2.md` §4.4 | question 1 of that plan OFFERED the opposite as option b — **fixed** (the option now sends the file alone) |
| 7 | nothing stops on dollars; no dollar ceiling is proposed (10 c) | all seven; the caps that exist are COUNTS (tokens, runs, readings, minutes, reviewer calls) and each says so | clean (grepped: no dollar key, no «byudjet» stop) |
| 8 | no Telegram Business / Chat Automation (12 a) | all seven | clean. The word `carrier` in stages 4, 7, 8 means «the seat» or «the company bot» only |
| 9 | the avia address stays his (17 c) | 1c, 3b, 4 | clean |
| 10 | another city stays his (19 c) | 1a, 3b, 4 | clean |
| 11 | the seat stays in KPI and rating until he flips Q31's setting | 1a (untouched), 1c (`seller`), 5 (default `seller` «byte for byte»), 9 (`agent_seat_pay` ships `pay`) | clean; stage 9's second home was a coherence defect, not a flip |
| 12 | nobody's name, id or role key in code or a migration | §A.3 | 1a wrote its last fallback and one sight rule as «the `super_admin` ROLE» — a literal the builder would have typed into new source: **fixed** (the existing reader is called; a source-shape test) |
| 13 | a migration never flips his stored choices | `STAGE-3B.md` §6.3a; every plan's «he touches» list | 3b said «the stage that builds a power flips it»; stage 6 said both rights «are `odam`» on deploy morning — **fixed** (a stage widens, HE flips; `tell_balance` starts «So'rab») |
| 14 | every stage with a migration has a readiness probe | §C.8 | clean (eleven migrations, eleven probes; 1c, 2b and 3b's PRs i-v have none of either) |
| 15 | migrations numbered «next after the journal's tail» | every plan | clean (grepped: no literal number for a new migration) |

---

## C. Coherence between the stages

### C.1 ONE designation table
`agent_designations (topic, user_id, rank, …)`, reader `designated(topic)`, screen «Kim javob beradi» — born in 1a (`STAGE-0-1A.md` §3.1-§3.2) and never re-made. A later stage adds a KEY to the code registry `AGENT_TOPICS` plus four i18n strings (§A.3 lists all fourteen); 3a alone also gives each registry entry three routing fields (`route`, `mode`, `proof`) — in code, not in the table. **Fixed:** 1a's list of future topics named 3a's only; 1b called the topic «nazoratchi» (the key is `supervisor`).

### C.2 ONE conversation record
`agent_conversation_record` + `agent/record.ts` `loadRecord` — born in 1b (`STAGE-1B-1C.md` §3.1, §4.2). Later writers: 1c («kod ochildi»), 3a («qo'ng'iroq qilindi», «RAHBAR ESLATMASI»), 5 («kod so'raldi / bekor qilindi»); stage 7 copies it to a reserve number. **Fixed:** 3b's `agent_chat_roads` looked like a second per-chat record — it is now stated to be a typed side table on the same key, read through `loadRecord` (`STAGE-3B.md` §3.1). Ledgers on the same key (`agent_takeovers`, `agent_readbacks`, `agent_quotes`) are histories, not records, and stay apart.

### C.3 ONE rights table — and how the earlier settings come into it
`agent_action_rights (action, position, limits)` — born in 1b; the four positions are `ozi` / `nazoratda` / `sorab` / `odam` in every CHECK that names them. How things enter (`STAGE-3B.md` §6.3a, written by this pass):

| Before 3b | Enters by |
|---|---|
| rows stored under an act's key: `open_code` (1c), `hear_voice` (2b), `relay_answer` (3a) | adopted unchanged — key, position, limits |
| his three kind ticks («Narx», «VED narxi», «Hisoblatish») | `derivedDefault` until HE saves the row; then the row decides; the tick stays stored (mode `old` reads it) |
| limits that have a home (holds, night, caps, big-cargo line, read / voice counts, markup, avia rate, the $50 line) | linked, never copied |
| limits with no home (codes a day, share of the markup) | `limits` jsonb |

After 3b a stage adds a row SPEC or widens what a row may be set to: 4 `honour_quote` · 5 widens `open_code` · 6 widens `give_discount`, `tell_balance`, `amount_due`, adds `payment_claim`, `debt_request` · 7 `relay_to_seller` · 8 widens `followup`, `greeting`. No deploy and no migration ever writes a position. **Fixed:** 3b had three invented keys for acts that already exist, lacked two stored rows, and disagreed with stages 5-7 on two positions; 1c's «select» is now a small list so 2b / 3a / 4 add a row, not a screen.

### C.4 The code act, built once
`ACTS.open_code` — born in 1c with position «So'rab» (the tap runs `winLead` under an idempotent token); stage 5 changes NO executor: it adds data prechecks, the customer's typed «Ha» and `agent_code_opens`, and lets him set the SAME row to «Nazoratda». Every fall-back of stage 5 is 1c's card. 3b's address tool (`receiving_address`) is the function 1c's closing turn builds its address through.

### C.5 CHECKs widened once — what 1b reserves and who writes it first

| Constraint (re-made ONCE in 1b's migration) | Value | First writer |
|---|---|---|
| `agent_runs_trigger_check` | `case_answer`, `replay` | 1b |
| | `channel` (**added by this pass**) | 7 |
| | `followup`, `campaign` | 8 |
| | `reading`, `act_result`, `staff_event`, `timer` | none planned — they stay reserved (stage 2 bills readings on its own table; stage 5's closing turn is all-system) |
| `agent_drafts_kind_check` (+ the nullable anchor) | `followup`, `greeting` | 8 (`reminder`: no writer — he chose no reminders) |
| `agent_outbox` `part_kind` / status | `holding`, `block`, `parked` 1b · `file` 4 · `first` 8 | as marked |
| `telegram_chat_waits_kind_check` | `agent_case` | 1b |
| `agent_cases.kind` (born in 1b) | `complaint`, `handover` (**added by this pass**) | 3a |
| `tasks_origin_check` | `agent` (**added by this pass**) | 3a |
| `agent_quotes.carrier` (born in 4) | `bot` (**added by this pass**) | none unless he ever allows a price in the bot |

`agent-engine-reserved.test.ts` (1b) keeps `src/` from writing any of them early. **Still re-made later, accepted:** stage 7 gives four of 3b's tables a second anchor — one named CHECK each (3b now writes them that way). Any constraint another round re-makes in between is derived from the LAST migration that did.

### C.6 No stage needs what a LATER stage builds — pieces moved, stubs stated

| Seam | Was | Now |
|---|---|---|
| the seat's mail (1c ↔ 5) | 1c re-addressed in `queueStaffTelegram` only; the event drain — the writer of «Prixod keldi» — was fixed in stage 5 | **moved to 1c**: `seat-mail.ts` `readdress` in both writers; 5 keeps the buttons (`actsForSeat`) |
| where a right is switched (2b, 3a ↔ 3b) | «⟨1b⟩'s rights screen» — which no stage built | 1c's «Huquqlar» list; 3b replaces it |
| his 22 a (3b ↔ 4) | two keys | 3b mints the one key first; 4 reads it |
| the quote's carrier (4 ↔ 7, 8) | «add a column later» | born with the table |
| who the seat is (5 ↔ 7 ↔ 9) | three homes | `staff/seat-mode.ts` (5); 7 adds `seatUserIds()`, 9 the `pay` answer |
| `write_first_off_until` (7 → 8) | read as if stage 8 existed | stated stub: written in 7, first read in 8 |
| stated stubs already in the plans | — | `agent_won_ownership` honours `seller` only until 5 · `agent_stop_first` has no reader until 8 · `tell_west_price` is «Faqat odam» until 4 · `contradicts_earlier` compares blocks only until 4's quote record · the «Hajm» flip is his tick (recommended after stage 2) |
| free of their stage's kernel | — | «Sana» (before 2026-12-31) and «Avia kunlari» of stage 4 may ride any earlier deploy |

### C.7 One word for one thing

| Thing | The word — in every plan, card and screen | Was also |
|---|---|---|
| the four positions | «O'zi» · «Nazoratda» · «So'rab» · «Faqat odam» (`ozi` / `nazoratda` / `sorab` / `odam`) | «Faqat o'zim» (1c), «o'zi» in quotes (2) |
| a fixed, approved text the system renders | «tayyor matn» (never «blok» on a screen or a card; the model-facing prompt of stage 2 may keep «bloki») | «tayyor jumla» (1a) |
| the supervisor pair (key `supervisor`) | «rahbar va o'rinbosar»; one person: «rahbar», «o'rinbosar» | «Nazoratchi va o'rinbosar», «nazoratchi», «Nazorat» (1a, 1b, 2, 3a, 9) — too close to «Nazoratda» |
| the designation screen | «Kim javob beradi» | — |
| the holding line | «kutish xabari» | — |
| the exception inbox | «Istisnolar»: Savol · Ruxsat · Shikoyat · Tekshiruv · Signal | — |
| the master switch for writing first | the stop button «birinchi bo'lib yozish» (`agent_stop_first`) | «o'zi yozish» switch, `agent_initiative` (8) |
| the right to give a discount | `give_discount` (tool `concede`, permit class `discount`) | `concede` as the right (6) |
| the $50 line of 22 a | `agent_low_quote_keep_usd` | `agent_honour_max_usd` (4) |
| «the seat is not paid» | refusal `not_payable` | `machine_seat` (9) |
| the place of it all | the menu says «AI sotuvchi» today; the design's page says «AI hodim → Huquqlar» | both — question 44 |

Even the one package title that carried the old word (1b's P3) was renamed «Rahbar va o'rinbosar», so a grep for «nazoratchi» in this folder now finds only the sentences that say it is retired.

### C.8 Migrations and probes

| Stage | Tag | Probe | New tables | Existing constraints touched |
|---|---|---|---|---|
| 1a | `agent_toliq_1a` | `agentToliq1aReady` | `agent_designations`, `agent_signals`, `agent_samples` | none |
| 1b | `agent_engine` | `agentEngineReady` | `agent_cases`, `agent_conversation_record`, `agent_acts`, `agent_action_rights`, `agent_replays` | THE one widening (§C.5); three SQL-only outbox columns |
| 1c | — | — | — | — |
| 2a | `agent_senses` | `agentSensesReady` | `agent_readings`, `agent_readbacks` | none (2b: no migration) |
| 3a | `agent_inbox` | `agentInboxReady` | `agent_case_routes`, `agent_takeovers`, `agent_signal_acks` | none if 1b reserved as planned |
| 3b | `agent_guard` (PR-A) | `agentGuardReady` | nine (`agent_block_texts` … `agent_fact_checks`) | none (PRs i-v: no migration) |
| 4 | `agent_quotes` | `agentQuotesReady` | `agent_quotes`, `agent_tariff_confirms` | none |
| 5 | `agent_closing` | `agentClosingReady` | `agent_code_opens` | none |
| 6 | `agent_money` | `agentMoneyReady` | `agent_concessions`, `payment_claims` | none |
| 7 | `agent_channel` | `agentChannelReady` | `agent_channel_messages`, `_turns`, `_chats`, `agent_accounts` | four anchor CHECKs of 3b's tables + four SQL-only columns |
| 8 | `agent_first` | `agentFirstReady` | `agent_first_plans`, `agent_campaigns`, `agent_contact_stops` | none if 1b reserved as planned |
| 9 | `agent_measure` | `agentMeasureReady` | `agent_weekly_reports`, `agent_versions` | none |

Every one is additive, numbered «the next index and `when` after the journal's tail on the day its kernel is cut» (the tail at this HEAD is `0150_batches_view`, ledger 151 — read it again, never carry it), inserts no row that names a person, and flips nothing he stored. The ledger count the owner is given is read off the journal on the deploy day.

---

## D. What this pass changed, file by file (each file's «## Conformance» has the reasons)

| File | Changed |
|---|---|
| `STAGE-0-1A.md` | the pair's word; the registry's full future; the fallback and the sight rule call existing readers (no role key) + a source-shape fence; 4 a stated for the signal; `streak` / loop one deploy; Q31's key named; a ⚠ on the «Hajm» question; «tayyor matn»; Q3 marked answered |
| `STAGE-1B-1C.md` | **1c P7 «Pochta» now covers the event drain** (moved from stage 5) with its test and red proof; reserved values for 3a and 7; `agent_action_rights` stated as THE rights table; the «Huquqlar» list; the pair's word; «Faqat odam» |
| `STAGE-2.md` | Q1's option b no longer undoes the read-figure rule; ears are switched on 1c's list; words |
| `STAGE-3A.md` | no CHECK re-made twice; the pair's word; `relay_answer` has one store; three questions marked answered (5 b, 21 a) or ⚠ (4 a) |
| `STAGE-3B.md` | new §6.3a; rows `relay_answer`, `hear_voice`; act keys; `open_code` and `tell_balance` positions; «widens, he flips»; the deleted bot-question step-down; anchors as one named CHECK; the road as part of the one record; one key for 22 a; the screen's name |
| `STAGE-4-6.md` | the four names made one with 3b; the correction's release; `tell_balance` starts «So'rab»; the mail is 1c's; `agent_quotes.carrier`; «Avia kunlari» may ship early |
| `STAGE-7-9.md` | the bot tells a balance at «Nazoratda» too; one seat home, one refusal code; `channel` from 1b; the anchors; the write-first stub; one master switch; words |

Not changed: the two `_verify-refs-*.md` notes (a record of the reference pass), the design, the contract.

---

## E. Still to ask him — ONE list (Uzbek, numbered; ⭐ = what is built on «sen aytgandek»; ⚠ = the option touches an answer he already gave)

Send them in groups, each group before the stage that needs it — never all at once. Questions 1-3 are design §11.3 and block nothing in 1a. The source of each is in brackets for the builder (plan · its own number).

**Ochiq qolgan uchta (§11.3)**

1. **VED narxi ustiga ustama** qancha? a) foiz yozasiz · b) dollar summasini yozasiz · ⭐ c) hozircha bo'sh — ustamasiz. Bo'sh qolsa AI hech qachon o'zi chegirma bermaydi: har bir so'rov sizga bitta tugma bo'lib keladi (23-javobingiz). [4-6 · 6.11-1]
2. **Avia.** Narx: ⭐ a) bugungidek bitta stavka (kg × sozlamadagi narx), oraliq aytilmaydi · b) mijozga oraliq aytiladi («9-17 $/kg, tovarga qarab») — alohida ish · c) tovar turiga qarab narx jadvali, AI «tovar turi?» deb so'raydi — alohida ish. Muddat: «3-5 kun» ni tasdiqlaysizmi? (⭐ javobingizgacha bugungi «2-5 kun» aytiladi; «ha» desangiz shu kunning o'zida almashtiramiz.) [4-6 · 4.11-7]
3. **Qashqarda hozir yuk qabul qilamizmi, manzili qanday?** ⭐ javobingizgacha: narx Qashqar ustunidan aytiladi, manzilni har safar o'zingiz berasiz. [4-6 · 4.11-1]

**1a dan oldin**

4. **Tunda narx.** Mijoz tunda narx so'rasa: ⭐ a) jadval narxi 2 daqiqadan keyin o'zi ketadi, VED narxi ertalabni kutadi · b) hech qanday narx tunda ketmaydi · c) VED narxi ham ketadi (⚠ avval VED narxi uchun «faqat kunduzi» degansiz). [0-1A · 1]
5. **«Hisoblatishga yubordim» javobi** (VEDga ish tushadi): ⭐ a) narx kabi 2 daqiqa kutadi · b) darhol ketadi. [0-1A · 2]
6. **Kunlik tekshiruv qayerda.** ⭐ a) sahifada, Telegramga bitta eslatma · b) Telegramda o'nta alohida xabar, tugmalari bilan. [0-1A · 4]
7. **Saytdan kelganlar.** «Umumiy» so'rovlar: ⭐ a) ular ham AIga · b) odamlarda qoladi. Qachon yoqamiz: ⭐ a) 2-bosqichdan keyin (AI rasm va faylni o'qiy boshlaganda) · b) 1a dan bir hafta keyin · c) darhol. ⚠ 6-javobingiz «saytdan kelganlar hammasi AIga» edi — bu faqat QACHON haqida; tugmani xohlagan kuni o'zingiz yoqasiz. [0-1A · 5]
8. **Sotuvchisi yo'q mijozlarga xabar matni** — tayyor matn ketadimi, va unda «AI yordamchi» deb yozilsinmi: ⭐ a) faqat ism bilan (so'rasa, o'zi aytadi) · b) ochiq yoziladi. [0-1A · 6]
9. **Kirillcha, tili ko'rinmagan birinchi xabar** («5 куб 800 кг»): ⭐ a) bugungidek bitta ✅ingizni kutadi · b) ruscha javob o'zi ketadi. [0-1A · 7]
10. **Fors va xitoy tilidagi tayyor matnlar** (o'qiy olmaysiz — bu qoida hamma bosqichdagi tayyor matnlarga tegishli): ⭐ a) o'zbekcha tarjimasini ko'rib bir marta tasdiqlaysiz · b) bu ikki tilda tayyor matn ketmaydi, sizga karta keladi. [0-1A · 8; 1B §6.3; 2 §6.3; 3A §6.3; 3B §6.5]

**1b va 1c dan oldin**

11. **Ish kunlari** — bitta sozlama: 15 daqiqalik soat, hamkasblarga kartalar va «ertasi ish kuni» shu bo'yicha yuradi. ⭐ a) dushanba-shanba 09:00-19:00, yakshanba yurmaydi · b) har kuni 09:00-19:00. [1B-1C · 1; 3A · 4 (dam olish kuni); 7-9 · B11-7]
12. **Mijozga ketadigan kutish xabari** («Savolingizni aniqlashtiryapman — javobini shu yerga yozaman») ma'qulmi? ⭐ a) ha · b) o'zim yozib beraman. (Vaqt aytilmaydi: «bir daqiqa», «tez orada» — va'da.) [1B-1C · 2]
13. **Bir javobda eng ko'pi nechta xabar?** ⭐ a) 3 ta · b) 2 ta · c) hozircha 1 ta. ⚠ Xabar soni oshsa, akkaunt xavfi ham oshadi. [1B-1C · 3]
14. **Sinov (eski suhbatlarni qayta o'ynatish).** ⭐ a) oxirgi 14 kun, 150 tagacha javob (pullik: taxminan 150 ta AI so'rovi) · b) 7 kun, 60 ta · c) kerak emas. [1B-1C · 4]
15. **Kod xabarida kompaniya boti havolasi ham bo'lsinmi?** ⭐ a) ha, mijoz kartasida telefon bo'lsa · b) yo'q, faqat kod va manzil. [1B-1C · 5]
16. **Raqami yashirin mijoz va kod.** 1c da (siz tugma bosasiz): ⭐ a) ochiladi, kartada «📵» ko'rinadi · b) yo'q — avval telefonini so'rasin. 5-bosqichda («Ha» desa): ⭐ a) kod bir tugma bilan sizdan o'tadi · b) AI kontaktini ulashishni so'raydi, shunda o'zi ochadi · c) telefonsiz ham o'zi ochadi. [1B-1C · 6; 4-6 · 5.11-1]
17. **O'rinbosar narx yozilgan javobni ham tasdiqlay oladimi?** ⭐ a) ha, lekin kartada faqat o'z huquqi ko'rsatadigan narxni ko'radi (VED narxi va mijoz narxi birga — faqat sizda) · b) narxli javoblar faqat sizga. [1B-1C · 7]

**2 dan oldin**

18. **Invoysdan VEDga.** 2-javobingiz: «"ha" yoki invoys — ish VEDga ketadi». Invoys kelsa AI o'qiganini qaytarib «to'g'rimi?» deydi. Ish qachon ketsin: ⭐ a) mijoz «ha» deb yozgandan keyin, o'qilgan qatorlar bilan · b) darhol, lekin faqat faylning o'zi bilan — qatorlarni VED qog'ozdan kiritadi (alohida ish). Tasdiqlanmagan sonlar bilan ish yuborilmaydi. [2 · 1]
19. **Ovoz qayerga yuboriladi (sinov o'tsa).** Ovozli xabar tanlangan kompaniya serveriga boradi. ⭐ a) tartib — avval O'zbekistondagi, keyin Yevropa, keyin AQSH xizmati · b) faqat O'zbekistondagi; o'tmasa — AI eshitmaydi. [2 · 2]
20. **«O'qiganim» xabari.** ⭐ a) 6 tagacha qator + jami (kg, kub, karobka) · b) faqat jami. [2 · 3]
21. **Tovar rasmi (hujjat emas).** ⭐ a) AI nimaligini aytadi va kub/kg so'raydi · b) sizga karta keladi. [2 · 4]
22. **To'lov cheki rasmi** (6-bosqichgacha): ⭐ a) mijozga «faylni oldim» deyiladi, chek sizga karta bo'lib keladi — «to'lov qabul qilindi» deyilmaydi · b) hech narsa deyilmaydi, faqat karta. [2 · 5]
23. **Kunlik chegaralar (dollar emas, son).** ⭐ a) kuniga 100 ta fayl, shundan 20 tasi kuchli o'quvchi, bitta mijozga 10 ta; ovoz — kuniga 120 daqiqa, xabar 2 daqiqagacha · b) o'zim yozaman. (Pul bo'yicha chegara yo'q — 10-javobingiz.) [2 · 6]
24. **Qog'ozlar sinovi.** 20 ta haqiqiy fayl ikkala o'quvchiga beriladi, bitta sotuvchi 1 soatda to'g'risini belgilaydi (taxminan 40 ta AI so'rovi): ⭐ a) ha · b) kerak emas — hammasini kuchli o'quvchi o'qisin (qimmatroq). [2 · 7]
25. **Ovozning birinchi 100 tasi** «Nazoratda» turadi, keyin o'zingiz «O'zi»ga o'tkazasiz; mijozlar 100 tadan 15 tadan ko'pida «noto'g'ri» desa, AI o'zi «yozib yuboring»ga qaytadi: ⭐ a) shunday · b) ovozdan kelgan har javobni doim o'zim tasdiqlayman. [2 · 8]

**3a dan oldin**

26. **Hamkasbning raqamsiz javobi.** ⭐ a) AI mijozga o'zi yozadi, kechqurungi tekshiruvda albatta ko'rasiz («Nazoratda») · b) birinchi oy har biri ✅ingizni kutadi («So'rab»). (Raqam bo'lsa — har doim sizga karta.) [3A · 1]
27. **VED va AI raqamidagi suhbatlar.** Bugun VED hamma akkaunt suhbatini o'qiy oladi — AI aytgan mijoz narxi ham ko'rinadi: ⭐ a) bugungidek qolsin · b) AI raqami suhbatlarida VED uchun narx satrlari yopilsin (⚠ 2026-07-31 dagi qaroringizni toraytiradi). [3A · 2]
28. **Hamkasbning mijozi.** Sotuvchisi 15 daqiqada javob bermasa: ⭐ a) savol sizga va o'rinbosarga chiqadi · b) faqat sotuvchini kutadi. [3A · 3]
29. **Tungi kartalar hamkasblarga.** ⭐ a) ish vaqti boshlanganda boradi · b) darhol, ovozsiz boradi. ⚠ 4-javobingiz «hamkasblarga kartalar ertalabni kutadi» edi — a) aynan shu. (1a dagi «katta yuk» signali 3a gacha b) kabi ishlaydi — tizimda «kutadi» bugun shunday qurilgan.) [3A · 4; 0-1A §4.5]
30. **Shikoyat kimga.** ⭐ a) faqat sizga va o'rinbosarga · b) mijozning o'z sotuvchisi bo'lsa, unga ham nusxa. [3A · 5]
31. **🙋 dan keyin** (suhbatni olganingizga 24 soat bo'lganda): ⭐ a) AI «davom ettiraymi?» deb so'raydi, 10 daqiqa javob bo'lmasa davom etadi · b) so'ramasdan davom etadi (bugungidek) · c) «AI davom etsin» demaguningizcha jim turadi. [3A · 6]
32. **Bir hamkasbda nechta ochiq savol.** ⭐ 5 tadan oshsa keyingi odamga yoki sizga o'tadi — boshqa son aytasizmi? [3A · 9]
33. **Zavoddan olib kelish va «sotib olib berish» uchun AI nimalarni yig'sin:** ⭐ a) rejadagi ro'yxat (zavod nomi va manzili, u yerdagi odam va telefoni, tovar, tayyor bo'lish vaqti; nima sotib olinadi, nechta, budjet) · b) o'zingiz qo'shasiz / qisqartirasiz. [3A · 10]
34. **«Kim javob beradi» sahifasi.** Quyidagilar kimga borishini shu sahifada o'zingiz belgilaysiz; bo'sh qolgani ⭐ sizga va o'rinbosarga boradi (kodda hech kim yozilmaydi): qo'ng'iroq qiladigan odam · zavoddan olib kelish · sotib olib berish · karta raqami · o'qilmagan fayl kartasi · to'lov cheklari (bo'sh bo'lsa — «Pul tushdimi» odamlari) · «qarzga bering» so'rovi · katta mijoz kimga o'tadi · AI mijozlari kimga beriladi. Qaysi biriga alohida odam qo'yasiz? [2 · 9; 4-6 · 5.11-8, 6.11-6, 6.11-7]
35. **Lid suhbatiga CRMdan yozish.** Kod ochilmaguncha AI raqamidagi suhbat — lid suhbati; bugun CRMda unga yozish oynasi yo'q. ⭐ a) hozircha siz va o'rinbosar AI raqami telefonidan (yoki kartadagi ✏️ bilan) yozasiz · b) lid suhbatiga CRMdan yozish oynasi qurilsin — alohida ish. [3A §4.5]

**3b dan oldin**

36. **Xitoy manzilidan oldin savol.** AI manzil yuborishdan oldin «avto yoki avia?» deb so'rasinmi? ⭐ a) ha — har yangi yuk so'rovida bir marta · b) faqat suhbatda avia tilga olingan bo'lsa (tezroq, lekin so'z ro'yxatiga tayanadi). [3B · 1]
37. **O'lchovda nechta «o'tib ketgan» gapga rozisiz?** ⭐ a) muhrlangan to'plamda bitta ham o'tmasa qabul — baribir har bir o'tgan gapni o'zingiz ko'rasiz · b) sinf bo'yicha o'zingiz son aytasiz. (Va'da sinflari — chegirma, qarz, kafolat, «bojsiz», bepul xizmat, pul qaytarish, sana — bunga kirmaydi: ularda so'z ro'yxati qoladi.) [3B · 2]
38. **Xitoy manzili boshida qaysi holatda tursin?** ⭐ a) «Nazoratda» — o'zi yuboradi, ikki hafta har bir manzil ro'yxatingizga tushadi · b) «O'zi». [3B · 3]
39. **Fakt tarjimasi tasdiqlanmagan bo'lsa** (masalan, rus mijoz to'lov tartibini so'radi): ⭐ a) javob sizga kartaga tushadi · b) o'zbekcha asl matn ketadi. [3B · 4]
40. **Xato topilsa amal qayerga tushsin?** ⭐ a) «So'rab»ga, qaytarish — sizning tugmangiz · b) «Nazoratda»ga. [3B · 5]
41. **«Yozmang» degan mijoz.** O'chirish: ⭐ a) AI o'zi darhol belgilaydi, sizga xabar keladi · b) bugungidek — bir tugma bilan siz tasdiqlaysiz. Qamrov (8-bosqich): ⭐ a) «yozmang» / mijoz bloklashi — so'ralmagan hech narsa yozilmaydi (AI raqamidan ham, botdan ham; o'z savoliga javob va o'z yuki haqidagi xabarlar qoladi), «🔕» — faqat tabriklar to'xtaydi · b) ikkalasi ham hammasini to'xtatadi. [3B · 6; 7-9 · B11-1]
42. **Ikkinchi tekshiruvchi ishlamay qolsa.** ⭐ a) matnli javoblar sizga kartaga tushadi, tayyor matnlar (narx, manzil, holat) ketaveradi · b) hamma javob to'xtaydi. [3B · 7]
43. **Yangi qo'riqchining sinov muddati.** ⭐ a) 14 kun va kamida 200 javob · b) 7 kun. [3B · 8]
44. **Menyu nomi.** Bo'lim bugun «AI sotuvchi» deb ataladi; sizga ko'rsatilgan sahifada huquqlar ekrani «AI hodim → Huquqlar» edi. ⭐ a) menyu «AI sotuvchi» bo'lib qoladi, ichida «Huquqlar» bo'limi · b) menyu «AI hodim» deb o'zgartiriladi. [3B §4.5]

**4 dan oldin**

45. **«Xorgos = Qashqar narxi» qanday saqlansin?** ⭐ a) «Tarif» sahifasida bitta tanlov: Xorgos doim Qashqar ustunidan o'qiydi · b) Qashqar qatorlari Xorgosga bir marta nusxalanadi, keyin alohida yuradi. [4-6 · 4.11-2]
46. **Qashqar / Xorgosdan yetkazish muddati.** ⭐ a) siz yozmaguncha muddat aytilmaydi · b) 15-25 kun (Xitoy bilan bir xil). [4-6 · 4.11-3]
47. **Jadval narxi kartadagi «Narx» katagiga yozilsinmi?** ⚠ bu narx keyin fura hisobini oldindan to'ldiradi. ⭐ a) ha — mashina narxi yoziladi, avia narxi faqat «AI aytgan narx» qismida turadi · b) hech biri katakka yozilmaydi. Amal muddati: ⭐ 7 kun. [4-6 · 4.11-4]
48. **PDF qaysi narxga?** ⭐ a) faqat VED narxiga · b) jadval narxiga ham — «taxminiy» degan yangi varaq kerak, alohida ish. [4-6 · 4.11-5]
49. **Siz 💵 bilan yozgan narx ham kartaga yozilsinmi?** ⭐ a) ha (29-savolga «b» degansiz; ⚠ avvalgi 6 b bekor bo'ladi) · b) faqat AI aytgan narx. [4-6 · 4.11-6]
50. **50 $ gacha farq saqlanganda** narx VED narxidan past bo'lib qolsa: ⭐ a) o'zi yoziladi, sizga xabar keladi (22-javobingiz) · b) har biri bitta tugma bilan sizdan. [4-6 · 4.11-8]
51. **01.01.2027 tarif qatorlarini oldindan tasdiqlash tugmasi.** ⭐ a) ha · b) yo'q, 1-yanvarda o'zim bosaman. [4-6 · 4.11-9]

**5 dan oldin**

52. **Kod bekor qilinganda mijozga nima deyiladi?** ⭐ a) ikki tugma: «mijozga aytilsin» / «o'zim yozaman» · b) doim tizim aytadi. [4-6 · 5.11-2]
53. **Qachongacha bekor qilish mumkin?** ⭐ a) kodga yuk yoki to'lov yozilmaguncha · b) faqat 48 soat. [4-6 · 5.11-3]
54. **Yuk kelmagan kod** necha kundan keyin so'ralsin? ⭐ a) 60 kun, bitta tugma bilan (o'zi yopmaydi) · b) 30 kun · c) so'ralmasin. [4-6 · 5.11-4]
55. **AI «kutilayotgan yuk» yozsinmi** (logist ko'radi; o'lchamlar — mijoz aytgani)? ⭐ a) ha · b) yo'q. [4-6 · 5.11-5]
56. **Egalik sozlamasi oy o'rtasida o'zgarsa?** ⭐ a) hali to'lanmagan oylarga taalluqli · b) keyingi oydan. [4-6 · 5.11-6]
57. **«Kompaniyaniki» rejimida AI yutgan mijoz guruhda tabriklansinmi?** ⭐ a) ha, «🤖 AI sotuvchi» nomi bilan, GIFsiz · b) yo'q. [4-6 · 5.11-7]
58. **Katta mijoz:** oyiga necha kubdan sotuvchiga taklif qilinsin? ⭐ a) 30 kub yoki to'liq mashina; o'tkazish — bitta tugma bilan · b) boshqa son · c) kerak emas. [4-6 · 5.11-8]
59. **Ikki haftalik «har kod shu daqiqada ko'rsatiladi» qachondan sanalsin?** ⭐ a) siz «Nazoratda»ni yoqgan kundan · b) birinchi koddan. [4-6 · 5.11-9]

**6 dan oldin**

60. **AI ustamaning qanchasini o'zi bera oladi?** ⭐ a) yarmigacha, bitimga bir marta · b) hammasini · c) ikki bosqichda. ⚠ Qancha ko'p bersa, mijoz VED narxini shuncha aniq taxmin qiladi. [4-6 · 6.11-2]
61. **Chegirma tugmalaridagi foiz** (aytilgan narxdan): ⭐ 3 % va 5 % — boshqa sonlar bo'lsa yozing. [4-6 · 6.11-3]
62. **Yuk tayyor bo'lganda qaysi summa aytilsin?** ⭐ a) shu kodning jami qarzi · b) faqat shu mashinadagi yuk narxi (narx qo'yilmagan bo'lsa — aytilmaydi). [4-6 · 6.11-4]
63. **Botga ulanmagan mijozga summa:** ⭐ a) mijoz AI raqamiga yozganda, javob ichida bir marta · b) aytilmaydi. [4-6 · 6.11-5]
64. **Summani botda aytishni qaysi kundan yoqamiz?** ⚠ yoqilgach, keyingi kelgan mashinadan boshlab mijozlar ko'radi. ⭐ a) deploydan keyin o'zingiz yoqasiz · b) deploy bilan birga. [4-6 · 6.11-8]

**7 dan oldin**

65. **Botdagi AI o'zini kim deb tanishtiradi?** ⭐ a) ismsiz — «GSR AI yordamchisi» · b) AI raqamidagi ism bilan. [7-9 · A11-1]
66. **Zaxira raqamni tizimga ulash.** ⭐ a) hozir ulab qo'yamiz, AI unda o'chiq turadi · b) faqat telefonda turadi, kerak bo'lganda ulaymiz. ⚠ a) da raqam Telegramga hozirdan «norasmiy dastur orqali kirgan» bo'lib ko'rinadi. [7-9 · A11-3]
67. **Zaxiraga o'tilganda birinchi 14 kun kuniga nechta javob?** ⭐ a) 20 · b) 40 · c) o'zingiz yozasiz. [7-9 · A11-4]
68. **Zaxiraga o'tilganda eski AI raqamiga yozgan mijozlarga botdan bitta xabar.** ⭐ a) ha, matnini siz tasdiqlaysiz · b) yo'q. [7-9 · A11-5]
69. **AI javob bermay sotuvchiga o'tkazganda sababi yozilsinmi?** ⭐ a) ha, qisqa («narx so'radi») · b) yo'q, bugungidek. [7-9 · A11-6]
70. **«Hammasini to'xtatish» tugmasi botdagi AIni ham o'chirsinmi?** ⭐ a) ha · b) yo'q, bot alohida. [7-9 · A11-7]

**8 dan oldin**

71. **Hamkasbingiz mijozi** (AI raqamiga yozgan) — AI unga birinchi yozishi: ⭐ a) eslatma — faqat narxni AI aytgan bo'lsa; tabrik — AI raqamidan emas, botdan · b) ularga AI umuman birinchi yozmaydi. [7-9 · B11-2]
72. **Tabrik tillari.** ⭐ a) o'zbek, rus, fors · b) + ingliz. (Xitoycha — hech qachon.) [7-9 · B11-3]
73. **O'zi yozishning boshlanishi.** ⭐ a) birinchi hafta har bir xabar sizga karta bo'lib keladi (faqat sinov chatlari, «So'rab»), keyin «Nazoratda» · b) darhol o'zi. [7-9 · B11-5]
74. **Juma kuni 10 tadan oshsa.** ⭐ a) avval eslatmalar, qolgan joyga tabriklar, sig'maganlar keyingi jumaga · b) avval tabriklar. [7-9 · B11-6]
75. **Boshqa kampaniyalar** (Navro'z, hayit). ⭐ a) faqat botdan, har birini alohida tasdiqlaysiz · b) AI raqamidan ham, juma qoidasi bilan. [7-9 · B11-8]

**9 dan oldin**

76. **AI o'rnining KPI puli.** ⭐ a) hisoblanadi va ko'rinadi, lekin to'lanmaydi («To'lash» tugmasi bo'lmaydi) · b) bugungidek tugma turadi · c) rahbarga (siz belgilagan odamga) to'lanadi. (31-javobingiz «sotuvchidek hisoblansin» edi — bu savol faqat PUL haqida; javobingizgacha b) turadi.) [7-9 · C11-1]
77. **Haftalik hisobot.** ⭐ a) dushanba 09:10, faqat sizga va o'rinbosaringizga · b) jamoa guruhiga ham (pulsiz) · c) kerak emas. [7-9 · C11-2]
78. **Kam ma'lumotli foizlar.** ⭐ a) 20 tadan kam bo'lsa foiz ko'rsatilmaydi, faqat son · b) baribir ko'rsatilsin. [7-9 · C11-3]
79. **Versiya belgisi** («qaysi sozlamalar bilan yozilgan»). ⭐ a) faqat belgi · b) kerak emas. [7-9 · C11-4]

**Keyin, o'z ma'lumotingiz bilan (dizayn §8 — hozir qurilmaydi)**

80. **Mijozga bojxona TAXMININI aytish.** Avval sizga jadval ko'rsatiladi: «AI-VED taxmini — VED javobi» o'z ishlaringizda qanchalik farq qilgan. ⭐ a) jadvalni ko'rmaguncha aytilmaydi · b) hozirdan aytilsin (⚠ o'lchanmagan).
81. **«Qachon jo'naydi?»** savoliga rejadan javob. Avval sanaladi: nechta reja sanasi bilan yozilgan. ⭐ a) sanoqni ko'rmaguncha — logistdan so'raladi · b) hozirdan rejadan aytilsin.

**So'ralmaydi — 32 ta javobingiz allaqachon hal qilgan** (rejalarda turibdi, ⭐ = siz tanlagan narsa, shu quriladi):

| Rejadagi savol | Javobingiz | Quriladi |
|---|---|---|
| «Fura» so'zining o'zi signal beradimi [0-1A · 3] | 3 b: «20 kubdan YOKI fura desa» | ha; `agent_big_cargo_words` yoqilgan holda chiqadi |
| O'rinbosar AI raqamidan yoza oladimi [3A · 7] | 5 b: «faqat ikkovingiz yozasiz» | ha |
| Karta raqamini AI saqlab, o'zi yuborsinmi [3A · 8] | 21 a: «karta raqami odamdan keladi» | yo'q — har safar belgilangan odam yozadi, siz ✅ bosasiz |
| Botda jadval narxi aytilsinmi [7-9 · A11-2] | 28 a: «holat, manzil, oddiy savollar; qolgani sotuvchiga» | yo'q |
| Botdan tabrik kimga [7-9 · B11-4] | 26 a: «qolgan hammaga botdan, 🔕 tugmasi bilan» | botga ulangan hamma mijozga, oyiga bir marta |
| Bot balansni «Nazoratda» holatida ham aytadimi [7-9, sarlavha] | 25 b + 28 a | ha — bog'langan bot suhbati telefon bilan tasdiqlangan |
