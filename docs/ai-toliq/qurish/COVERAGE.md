# To'liq AI sotuvchi — COVERAGE: every answer traced to the stage that builds it, the seams between the seven plans, and the ONE list of questions still to ask him

| | |
|---|---|
| What this is | The conformance pass over the seven build plans of this folder, made 2026-11-20 at HEAD `bf37150c` (docs only; no code, no suite, no build). It answers three things for the session that builds: **(A)** is every answer of design §11 built somewhere, **(B)** does any plan undo a binding correction, **(C)** do the plans fit each other — and it ends with **(E)** the one numbered list of questions for the owner |
| Outranked by | `docs/AI-SOTUVCHI-TOLIQ.md` §11 (his answers) → `docs/AI-SOTUVCHI-TOLIQ-QURISH.md` (the contract) → the stage plan. This file changes no rule; where it and a plan disagree about a NAME, the plan was edited to match and says so under its «## Conformance» |
| Verdicts | **built** = a named step of a named stage builds it · **partly** = built except a part that waits for his answer (the part is named) · **missing** = no plan built it · **contradicted** = a plan built the opposite. «→ fixed» means this pass edited the plan; the plan's «## Conformance» section says what and why |
| Result | 35 rows of §11.1 (the name, 1-32, the SIM, avia): 34 built, 1 partly (avia — waits on his §11.3-2). No row was missing outright. FOUR places contradicted an answer or a binding rule and were fixed (rows 1, 16, 25 and the read-figure rule), and ONE piece was planned a stage too late (the seat's mail, row 31 / §C.6). **Second pass (2026-11-20, §G):** the lead's rulings R1-R9 carried into every plan; one measured finding for HIM before 1a's P1 merges — the 55 (§B row 1, question 82); questions now 81 open, numbered 1-82 (29 decided by his 4 a); §F is the first message |

---

## A. Coverage of §11.1 — answer → rule → where it is built → verdict

| Q | His answer | The rule (short) | Built in (file § / package) | Verdict |
|---|---|---|---|---|
| name | «Bekzod» | persona «GSR sotuv menejeri ‹ism›»; never says it is a person; the name is a setting he types | `STAGE-0-1A.md` §3.3 `agent_persona_name`, §4.4 P3, §6.1 (head), §9 (he types it); the `staff_name` exemption for the persona word §4.4; `ai_denial` kept; `STAGE-3B.md` §6.2 #61 (`claimsHumanAs`) | built |
| 1 | b ⚠ | «botmisiz?» → one honest system line, then the rest of the answer | `STAGE-0-1A.md` §4.4 (`withBotAnswer`, `AI_HONEST_LINE`), §4.2 (the bot-question step-down DELETED) | built — `STAGE-3B.md` §4.6 still counted on the deleted step-down: **contradicted → fixed** |
| 2 | a | bare price with kub+kg → table figure, then «rastamojka … hisoblab beraymi?»; «ha» or an invoice → VED job | `STAGE-0-1A.md` §6.1 rules 8 / 11, `CUSTOMS_OFFER_SENTENCE`; the invoice's ROWS: `STAGE-2.md` §4.4 (`use_readings`, after the typed «ha») | built (the invoice half arrives with stage 2; provable only live — 1a §7) |
| 3 | b + note | ≥ 20 kub or «fura» → answers AND signals; who and the line are settings; 100 m³ / 20 t ceiling stays | `STAGE-0-1A.md` §3.3 (`agent_big_cargo_m3`, `_words`), §4.5 (`designated('big_cargo')`); on a VED price: `STAGE-4-6.md` §4.4 P5 | built |
| 4 | a ⚠ | night: answers who writes, never first; colleagues' cards wait | `STAGE-0-1A.md` §6.2 (night by class), §4.5 (the signal — night-silent, **stated → fixed**); `STAGE-1B-1C.md` §4.3 (the clock does not run at night); `STAGE-3A.md` §4.1 (`notify_after`) | built. «Silent at night» vs «at the next working minute» is NOT asked: 4 a decides it (§E «So'ralmaydi», number 29 unused) — 3a's `notify_after` holds a colleague's card to the next working minute; until 3a the 1a signal is delivered at night without a sound (the existing night-silent list) |
| 5 | b ⚠ | his; 15 working minutes → deputy too; only the two write from the number | pair as DATA: `STAGE-0-1A.md` §3.2; recipients, pressers, escalation: `STAGE-1B-1C.md` §4.3 P3 (the pair read as ROWS with their rank — `designatedRows`, §C.1); writing from the CRM as the seat: `STAGE-3A.md` §4.5 (coded clients; lead chats from the phone — question 35) | built |
| 6 | c | every cargo visitor → the AI; «Sotib olib berish» stays with people; never «nobody» | `STAGE-0-1A.md` §4.7 P5 «Hajm» (`lead_assign_ai`, `seatCandidate`, roster fallback) | built — ships `off`, the flip is his tick; the ⭐ that delays it now carries its ⚠ (**→ fixed**, question 7) |
| 7 | b | seller-less clients: one bot message + the AI number where a manager would be | `STAGE-0-1A.md` §4.7 (`noManager` audience, `managersFor`, `client_ai_contact`) | built |
| 8 | b | colleague's customer: status / addresses / table price alone; money → that seller, answer returns; seller's price outranks | alone-part: today's behaviour, kept (`STAGE-0-1A.md` §5); the rest: `STAGE-3A.md` §4.4 P4 (`colleagueOf`, `sellerPriceStands`); in the bot: `STAGE-7-9.md` §A4 | built (from 3a) |
| 9 | a | ten 👍/👎 every evening for a month, then weekly | `STAGE-0-1A.md` §4.5 (`agent_samples`, smallest form); full screen `STAGE-3A.md` §4.6; mistake signal `STAGE-3B.md` §4.6; bot turns `STAGE-7-9.md` §A4.2 | built |
| 10 | c ⚠ | no dollar limit; meter and 20:00 line stay | `STAGE-0-1A.md` §4.6 (token / run fuses kept, re-worded); count caps only in `STAGE-2.md` §3, `STAGE-3B.md` §3.3 | built (nothing in any plan stops on dollars — §B.7) |
| 11 | a ⚠ | talk at once; a price waits 2 minutes with ⏸ | `STAGE-0-1A.md` §4.2 (`holdSecFor`, `pressNow`); `STAGE-1B-1C.md` §4.4 (`JOB_AGENT_PRESS`); as a limit of the price rights `STAGE-3B.md` §6.3 | built — **and one thing he must see before P1 merges: the 55** (§B row 1, question 82) |
| 12 | a | the session only | by absence in every plan; `STAGE-1B-1C.md` §3.2 (no outbox `carrier`); `STAGE-7-9.md` §A2 | built |
| 13 | a | speech trial; until it passes «yozib yuboring» + a card; then read-back + typed «ha» | trial: `STAGE-0-1A.md` §4.0 (c); the line: §4.4; ears: `STAGE-2.md` §4.6 P5 (only if the trial passes) | built |
| 14 | b | topics → VED / logist / accountant / warehouse / him; 15 min then the pair; VED's card has no client price | `STAGE-3A.md` §3.3, §4.1 P1, §4.2 P2 (the money refusal at the answer door), §5 | built |
| 15 | a | «telefon qiling» → number + hour → a task; who is a setting | `STAGE-3A.md` §4.3 P3 (`hand_over`, `designated('callback')`, task origin `agent`) | built |
| 16 | b ⚠ | code alone, ≤ 10 a day, each shown to him for two weeks; one-tap first | one tap: `STAGE-1B-1C.md` §4.6 P6; alone: `STAGE-4-6.md` §5.3-§5.4 P1 («Ha», `limits.perDay`, the watch window, cancel) | built — `STAGE-3B.md` §6.3 said «O'zi at stage 5»: **contradicted → fixed** («Nazoratda»; stage 5 allows `odam` / `sorab` / `nazoratda` and no plan builds `ozi` for this act) |
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
| ordinary talk goes alone | `STAGE-0-1A.md` §6.2 — with the liveness alarm of the same stage (§4.5; §B row 16) and the question about the 55 before P1 (§B row 1) |
| rail unchanged; under the minimum → says it, offers avia | untouched (`withRailRule`, the truck-minimum note — `STAGE-0-1A.md` K5); `STAGE-3B.md` §6.3 (`tell_rail_price` fixed) |
| reads files and reads back | `STAGE-2.md` §4.4 |
| complaints never silent, he decides | tripwire + label `STAGE-0-1A.md` §4.4, §6.2; the sentence, the case, the hold `STAGE-3A.md` §4.5 |
| no language shown → Uzbek Latin; `language` strict on money | `STAGE-0-1A.md` §6.2 |
| ANY figure in his or a colleague's answer → a card | `owner_figure` kept in every plan; `STAGE-3A.md` §4.2 |
| his own typing pauses the AI | `human_active` untouched everywhere; `STAGE-3A.md` §4.5 gives the chat back only by the pair's button |
| two-in-a-row goes, a loop detector replaces it | `STAGE-0-1A.md` §4.3 — one deploy with P1 (**→ fixed**, §8). `same_inbound` keeps today's guard: a text-less line (a photo-only burst) is never «the same line again», and lines are compared with their digits kept; unit test `agent-loop-detector.test.ts` (the stem `agent-loop` is the run-loop integration test's) |
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
| a big customer's seller; whom AI customers are handed to | `big_customer`, `handover_seller` | 5 | read as ROWS, no fallback (who becomes a client's seller is a door): empty `big_customer` → the card names nobody (the pair still get the card); empty `handover_seller` → no hand-over |
| cheque claims; «qarzga bering» | `payment_claims`, `debt_request` | 6 | `money`'s people / the pair |
| who holds the SIM; the reserve phone | `seat_phone`, `reserve_phone` | 7 | the pair (both). `reserve_phone` is read by stage 7's account alarm when it offers the reserve door — the reserve SIM's holder is told (lead ruling 2026-11-20, `STAGE-7-9.md` §A3) |
| how AI customers are counted | not a person: the setting `agent_won_ownership` + its screen | 1c key, 5 screen | `seller` (= today) |

**Two readers, minted together in 1a (`STAGE-0-1A.md` §3.2) — which one a caller uses is decided by what it does with the answer:**

| Reader | Answers | Callers |
|---|---|---|
| `designated(topic)` | people, by rank, WITH the fallback chain (topic → the pair → the people today's alarm reaches) — never «nobody». Takes no handle; never called inside a transaction | everything that TELLS somebody: signals, alarms, cards and reports — 1a (`big_cargo`, the morning line, the sample, the liveness alarm), 3a's `routePlan` (the eight topics), 3b's alarms, 4 P5, 6 (`payment_claims`, `debt_request`), 7 (`seat_phone`) |
| `designatedRows(topic, handle)` | the topic's OWN stored rows with their rank, no fallback, `[]` when empty; read on the handle it is given — inside a transaction, that transaction's (#714) | everything that LETS somebody in or makes somebody an owner: who may press ✅, write from the AI number, approve knowledge (1b's pair predicates, 3a, 3b's three supervisor-only doors and the stop buttons); the seat's mail (1c `readdress`, both ranks) and its buttons (5 `actsForSeat`); `big_customer` / `handover_seller` (5); the «Kim javob beradi» screen and `setDesignations` (1a) |

**An empty table never widens a door beyond today's rule:** a door that reads `[]` keeps the predicate it has today (the account holder alone), never the alarm audience.

A colleague's customer → «that seller» (8 b) is a fact of the card, never a designation. **Fences:** 1a's designation test now refuses a role key, a uuid or a name in its five new files and its migration (added by this pass; R9's `liveness.ts` addresses the pair too and is not on that plan's list yet — §G); 3a's `agent-topics-registry.test.ts` does the same for six files. **Every later stage that adds a file which addresses a person appends it to that list** — the rule is only as wide as the list.

---

## B. The binding corrections — where each is held, and what this pass had to fix

| # | Rule no plan may undo | Held by | Found / fixed |
|---|---|---|---|
| 1 | no word rule deleted before the protocol has run and he has seen the missed list | `STAGE-0-1A.md` K1 (the 303 committed, walls snapshot FIRST); `STAGE-3B.md` §7.1-§7.3 (protocol, the door `retireGuardStep`, his choice per class); every other plan's FORBIDDEN list | no word rule is deleted — 1a removes gate codes (`low_confidence`, `streak`, `category`), each sanctioned by design §7 row 1a. **But the gate codes were a wall the word rules never were (R8):** measured in 1a's dry run, of the 303 dangerous first replies 244 are held by a policy block at HEAD and **55 meet NO wall** (`STAGE-0-1A.md` §4.1 «K1, as measured», §6.3). Today such a reply, if the model ever wrote it, waits behind the model's own rating and his 2-minute ⏸; under 1a it is «talk» and goes at once. **This is HIS decision before 1a's package P1 merges**, with the list shown to him — three choices (go as designed with the evening sample as the net ⭐ · keep a short hold on talk until stage 3b ⚠ 11 a · put the listed phrasings into the word rules first): §E question 82 in the group «1a dan oldin», and §F's first message. K and S0 may go; P1 is not cherry-picked until he has answered |
| 2 | in 1a: `language` on money, `owner_figure` (any figure), the `complaint` label, his own-typing pause stay; `streak` + `repeat` leave only with a loop detector | `STAGE-0-1A.md` §6.2, §4.3 | P1 (deletes `streak`) and P2 (builds the loop) were two packages with no rule tying them — **fixed**: one deploy, §8. R3: the detector's `same_inbound` keeps today's text-less guard (§A.2) |
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
| 16 | the card and the hold come off ordinary talk only together with a liveness alarm (`critic-guard.md` §D.1) | `STAGE-0-1A.md` §4.5 «Liveness alarm» (a customer wrote in working hours, the AI is on, nothing drafted or sent within `agent_liveness_minutes` → one line to the pair and a row on the system-watch screen; no migration — the existing signals table) | the plan had none and said «promise him no alarm» — **fixed by ruling R9** (written in by 1a's second dry run). Open, for the lead: the line rides the staff bot, so a dead staff bot is covered by the screen row only |

---

## C. Coherence between the stages

### C.1 ONE designation table
`agent_designations (topic, user_id, rank, …)`, TWO readers — `designated(topic)` (fallback chain; signals, alarms, cards, reports) and `designatedRows(topic, handle)` (the topic's own rows with rank, no fallback; doors and the seat's mail — the table of callers is in §A.3) — and the screen «Kim javob beradi»: all born in 1a (`STAGE-0-1A.md` §3.1-§3.2) and never re-made; no later stage mints a third reader. A later stage adds a KEY to the code registry `AGENT_TOPICS` plus four i18n strings (§A.3 lists all sixteen: 2 + 8 + 2 + 2 + 2); 3a alone also gives each registry entry three routing fields (`route`, `mode`, `proof`) — in code, not in the table. **Fixed:** 1a's list of future topics named 3a's only; 1b called the topic «nazoratchi» (the key is `supervisor`).

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

After 3b a stage adds a row SPEC or widens what a row may be set to: 4 `honour_quote`, widens `tell_west_price` («Faqat odam» until then) · 5 widens `open_code` (to «Nazoratda» — never «O'zi») · 6 widens `give_discount`, `tell_balance`, `amount_due`, adds `payment_claim`, `debt_request` · 7 `relay_to_seller` · 8 widens `followup`, `greeting` (to «So'rab» / «Nazoratda» — no «O'zi» branch is built). No deploy and no migration ever writes a position. **ONE writer (R7):** `setActionRight` in `agent/acts.ts`, minted with the table in 1b and first used by 1c's «Huquqlar» list; 3b's rights page, its step-down and its restore call it, and so does every later stage's «he sets it». The door of 1b's own tuning keys is `mayTuneAuto`. The whole key-by-key table (who mints, where it starts, who widens it) is `STAGE-3B.md` «Seam check» 4. **Fixed:** 3b had three invented keys for acts that already exist, lacked two stored rows, and disagreed with stages 5-7 on two positions; 1c's «select» is now a small list so 2b / 3a / 4 add a row, not a screen.

### C.4 The code act, built once
`ACTS.open_code` — born in 1c with position «So'rab» (the tap runs `winLead` under an idempotent token); stage 5 changes NO executor: it adds data prechecks, the customer's typed «Ha» and `agent_code_opens`, and lets him set the SAME row to «Nazoratda». Every fall-back of stage 5 is 1c's card. 3b's address tool (`receiving_address`) is the function 1c's closing turn builds its address through.

### C.5 CHECKs widened once — what 1b reserves and who writes it first

| Constraint (re-made ONCE in 1b's migration) | Value | First writer |
|---|---|---|
| `agent_runs_trigger_check` | `case_answer`, `replay` | 1b |
| | `channel` (**added by this pass**) | 7 |
| | `followup`, `campaign` | 8 |
| | `reading`, `act_result`, `staff_event`, `timer` | none planned — they stay reserved (stage 2 bills readings on its own table; stage 5's closing turn is all-system) |
| `agent_drafts_kind_check` (+ the nullable anchor) | `followup`, `greeting` | 8 (`reminder`: reserved, no writer — a reminder on a silent quote is a `followup` draft, and stage 6's amount goes through the company bot's notice, not a draft) |
| `agent_outbox` `part_kind` / status | `holding`, `block`, `parked` 1b · `file` 4 · `first` 8 | as marked |
| `telegram_chat_waits_kind_check` | `agent_case` | 1b |
| `agent_cases.kind` (born in 1b) | `complaint`, `handover` (**added by this pass**) | 3a |
| `tasks_origin_check` | `agent` (**added by this pass**) | 3a |
| `agent_quotes.carrier` (born in 4) | `bot` (**added by this pass**) | none unless he ever allows a price in the bot |

`agent-engine-reserved.test.ts` (1b) keeps `src/` from writing any of them early. **Still re-made later, accepted:** stage 7 gives four of 3b's tables a second anchor — one named CHECK each (3b now writes them that way). Any constraint another round re-makes in between is derived from the LAST migration that did.

### C.6 No stage needs what a LATER stage builds — pieces moved, stubs stated

| Seam | Was | Now |
|---|---|---|
| the seat's mail (1c ↔ 5) | 1c re-addressed in `queueStaffTelegram` only; the event drain — the writer of «Prixod keldi» — was fixed in stage 5 | **moved to 1c** (package «Pochta», ruling R1): ONE function `readdress(handle, userIds, type)` in `platform/notifications/seat-mail.ts`, called by EVERY writer of a `notifications` row that addresses a PERSON (the staff queue, the event drain's inserts, the two per-person digests); writers that address a ROLE or an alarm audience sit on a counted allow-list; one source-shape fence over `src/` lists every `insert(notifications)` site. An EXEMPT set of types is never re-addressed (1c names them — there is no «covered-types list»). Recipients: BOTH ranks of the pair (`designatedRows`), each copy rendered for its own recipient's sight (law 4). Tests `agent-seat-mail` + `seat-mail-wire`. 5 builds only the buttons (`actsForSeat`); 7 teaches `readdress` the SET of seats after the reserve door |
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
| 1a | `agent_toliq_1a` | `agentToliq1aReady` | `agent_designations`, `agent_signals`, `agent_samples` (the liveness alarm adds none — it claims on the existing system-watch signals table) | none |
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

### C.9 Four rules every plan now says the same way (lead rulings of 2026-11-20)

| Rule | What every plan holds | Where |
|---|---|---|
| e2e spec names (R4) | the AI specs run in STAGE order after the directory's last file (`tests/e2e` ends at `m9zzzj-sotuvchi-yuk` today): 1b+1c `m9zzzk-ai-suhbat` · 2 `m9zzzl-ai-koradi` · 3a `m9zzzm-ai-quti` · 3b `m9zzzn-ai-huquqlar` · 4 `m9zzzo-ai-narx` · 5 `m9zzzp-ai-yopish` · 6 `m9zzzq-ai-pul` · 7 `m9zzzr-ai-kanal` · 8 `m9zzzs-ai-birinchi` · 9 `m9zzzt-ai-olchov`; 1a adds no spec file (it extends existing ones). **The names are proposals** — on the day take the next free prefix after the directory's last file and keep stage order | each plan's test section, said once |
| `wrong_script` and code-rendered parts (R5) | not asked of a «tayyor matn» part: its frame is approved per language and what it quotes is the customer's own text (a Chinese invoice's goods names read back to an Uzbek chat). Prose parts are checked as today | 1b `checkTurn`; 2 §6.2; 3a §4.2; 3b §6.2 #55; 4-6 §5.6 |
| messages per turn (R6) | `agent_turn_max_parts` counts EVERY message of one turn — prose, tayyor matn and the holding line — so the number he picks (question 13, ⭐ 3) is the number of messages a customer gets at once; the model is given (max − code-appended) prose parts, never fewer than one. A bot turn is min(2, max); a write-first turn is exactly one message | 1b §3.4, §4.1; 2 §4.4; 3b §4.1; 4-6 §4.4 P3, §5.4 P1; 7-9 §A4.0, §B4.2 |
| one writer of a right (R7) | `setActionRight` (`agent/acts.ts`), minted in 1b with the table, first used by 1c; no second writer in any stage, no migration or deploy writes a position (§C.3) | 1b §3.1, §5; 3b §4.0 K3, §4.6, §6.3a |

---

## D. What this pass changed, file by file (each file's «## Conformance» has the reasons)

| File | Changed |
|---|---|
| `STAGE-0-1A.md` | the pair's word; the registry's full future; the fallback and the sight rule call existing readers (no role key) + a source-shape fence; 4 a stated for the signal; `streak` / loop one deploy; Q31's key named; a ⚠ on the «Hajm» question; «tayyor matn»; Q3 marked answered |
| `STAGE-1B-1C.md` | **1c P7 «Pochta» is the whole of the seat's mail** (moved from stage 5): one `readdress` called by every person-addressed writer of a notification row, not by «both writers» as this pass first wrote it — §C.6 has the rule as ruled — with its tests and red proofs; reserved values for 3a and 7; `agent_action_rights` stated as THE rights table; the «Huquqlar» list; the pair's word; «Faqat odam» |
| `STAGE-2.md` | Q1's option b no longer undoes the read-figure rule; ears are switched on 1c's list; words |
| `STAGE-3A.md` | no CHECK re-made twice; the pair's word; `relay_answer` has one store; three questions marked answered (5 b, 21 a) or ⚠ (4 a) |
| `STAGE-3B.md` | new §6.3a; rows `relay_answer`, `hear_voice`; act keys; `open_code` and `tell_balance` positions; «widens, he flips»; the deleted bot-question step-down; anchors as one named CHECK; the road as part of the one record; one key for 22 a; the screen's name |
| `STAGE-4-6.md` | the four names made one with 3b; the correction's release; `tell_balance` starts «So'rab»; the mail is 1c's; `agent_quotes.carrier`; «Avia kunlari» may ship early |
| `STAGE-7-9.md` | the bot tells a balance at «Nazoratda» too; one seat home, one refusal code; `channel` from 1b; the anchors; the write-first stub; one master switch; words |

Not changed: the two `_verify-refs-*.md` notes (a record of the reference pass), the design, the contract.

**After this pass** the lead's rulings R1-R9 of 2026-11-20 were written into the plans by a second round of readers — `STAGE-0-1A.md` «Dry run — second pass», and the «## Seam check» of every other plan; what those rulings changed in THIS file is logged in §G.

---

## E. Still to ask him — ONE list (Uzbek, numbered; ⭐ = what is built on «sen aytgandek»; ⚠ = the option changes an answer he already gave, and says which)

Send them in groups, each group before the stage that needs it — never all at once. Questions 1-3 are design §11.3 and block nothing in 1a. The source of each is in square brackets for the builder (plan · its own number) and is NOT sent to him.

**How the list is numbered (do not renumber).** 81 open questions, numbered 1-82: number **29 is unused** (his 4 a decides it — the table «So'ralmaydi» at the end), and number **82** (the 55, lead ruling R8) is new and stands in the group of the stage that needs it, «1a dan oldin». Questions 16 and 41 each have a second part that belongs to a later stage; it stands in THAT stage's group under the same number (16b in «5 dan oldin», 41b in «8 dan oldin»). Every question starts with its number in bold, never as a Markdown list item — a list would renumber 82 to 11 when rendered.

**How a question is written.** One question = one decision. A question with two decisions has parts under ONE number (7a, 7b), and inside a part the choices are numbered 1) 2) 3) — so «7a — 1, 7b — 2» is an answer and a bare «7a» is not. ⚠ is used ONLY where an option changes an answer he already gave (design §11.1, or one of the 35 earlier answers of `critic-feasibility.md` §A) and says which one in plain words; what a ⭐ costs him — money, a wait, a risk to the account — is said beside it in words («Shuni biling: …»), without the sign. No table, column, function, setting-key or file name stands in an Uzbek sentence.

**Two lines the builder adds to a group's message when they first apply:**
- with the first group that has a two-part question (the first message, §F): «Ikki qismli savolda qism harf bilan (2a, 2b), variant raqam bilan belgilangan — "2a — 1, 2b — 2" deb javob bersangiz bo'ladi.»
- with the first group that names the four positions («2 dan oldin»): «To'rt holat: «O'zi» — AI o'zi qiladi · «Nazoratda» — AI o'zi qiladi, siz keyin ro'yxatda ko'rasiz · «So'rab» — sizning tugmangizni kutadi · «Faqat odam» — AI qilmaydi, odam qiladi.»

### Ochiq qolgan uchta (§11.3)

**1.** **VED narxi ustiga ustama** (VED hisoblagan narx ustiga siz qo'shadigan foyda) qancha bo'lsin? a) foizda — necha foizligini yozing · b) dollarda — har bir hisobga necha dollarligini yozing · ⭐ c) hozircha bo'sh qolsin. Bo'sh bo'lsa: AI mijozga VED narxining o'zini aytadi (ustiga hech narsa qo'shilmaydi), va AI o'zi chegirma bera olmaydi — har bir chegirma so'rovi sizga bitta tugma bo'lib keladi (23-javobingiz). Shuni ham biling: ustama bo'sh bo'lsa, mijozga aytilib kartaga yoziladigan narx VED narxining o'zi bo'ladi — uni sotuvchilar ham ko'radi (bugun sotuvchi VED narxini ko'rmaydi). Shu savolga javob berguningizcha «VED narxi» katagini yoqmaslikni maslahat beramiz: yoqilmasa, VED narxi mijozga o'zi ketmaydi, sizga karta bo'lib keladi. [4-6 · 6.11-1; 0-1A §4.0 chores 1-2 (R9)]

**2.** **Avia** (javobingiz: «saytda 9-17 $/kg, 3-5 kun»). Ikki qism:

2a) Narx qanday aytilsin: ⭐ 1) bugungidek bitta narx — kg × sozlamadagi stavka (hozir 17 $ — oraliqning eng yuqorisi), oraliq aytilmaydi · 2) mijozga oraliq aytiladi («9-17 $/kg, tovarga qarab») — alohida ish · 3) tovar turiga qarab narx jadvali (jadvalni siz berasiz), AI «tovar turi?» deb so'raydi — alohida ish.

2b) Muddat: ⭐ 1) «3-5 kun» — yozganingizdek (⚠ bugun AI avvalgi javobingiz bo'yicha «2-5 kun» deydi — shu almashadi) · 2) «2-5 kun» qolsin.

[4-6 · 4.11-7]

**3.** **Qashqarda hozir yuk qabul qilamizmi, va manzili qanday?** ⭐ Javobingizgacha: Qashqardan yuk so'ralsa, narx «Tarif» sahifasidagi Qashqar ustunidan aytiladi, manzilni esa har safar o'zingiz berasiz. [4-6 · 4.11-1]

### 1a dan oldin

**4.** **Tunda narx** (tun — 22:00-08:00). Mijoz tunda narx so'rasa: ⭐ a) jadval narxi (yo'lkira va avia — tarif jadvalidan) 2 daqiqadan keyin o'zi ketadi, VED narxi ertalabni kutadi. Shuni biling: tunda ⏸ ni hech kim bosmaydi — jadval narxi siz ko'rmasdan ketadi · b) hech qanday narx tunda ketmaydi — mijoz ertalabgacha narxsiz kutadi · c) VED narxi ham tunda ketadi (⚠ avval VED narxi uchun «faqat kunduzi» degansiz — c) shuni o'zgartiradi). [0-1A · 1]

**5.** **Hisoblatishga yuborish.** Mijoz hamma ma'lumotni bergach, AI ishni VEDga yuboradi va mijozga «hisoblatishga yubordim» deydi. Bu: ⭐ a) narx kabi 2 daqiqa kutadi — shu vaqt ichida ⏸ bosib to'xtata olasiz (VEDga noto'g'ri ish tushmaydi; mijoz 2 daqiqa ko'proq kutadi) · b) darhol ketadi (to'xtatib bo'lmaydi). [0-1A · 2]

**6.** **Kunlik tekshiruv qayerda bo'lsin.** Har oqshom AIning 10 ta javobini 👍/👎 bilan baholaysiz (9-javobingiz). ⭐ a) sahifada — Telegramga bitta eslatma keladi, bosib sahifani ochasiz · b) Telegramning o'zida — tugmalari bilan o'nta alohida xabar. [0-1A · 4]

**7.** **Saytdan kelganlar** (6-javobingiz: saytda «Telegram»ni bosgan yuk mijozlari AIga boradi; «sotib olib berish» odamlarda qoladi). Ikki qism:

7a) Saytda xizmat turi tanlanmagan «Umumiy» so'rovlar: ⭐ 1) ular ham AIga (sotuvchilarga saytdan faqat «sotib olib berish» qoladi) · 2) odamlarda qoladi.

7b) Qachon yoqamiz: ⭐ 1) 2-bosqichdan keyin — AI rasm va faylni o'qiy boshlaganda (⚠ 6-javobingiz o'zgarmaydi, faqat kechikadi: o'sha kungacha saytdan kelganlar bugungidek sotuvchilarga boradi; tugmani xohlagan kuni o'zingiz yoqasiz) · 2) birinchi bosqich (1a) chiqqandan bir hafta keyin · 3) darhol (AI hali rasm va faylni o'qiy olmaydi — bunday mijozga «yozib yuboring» deydi).

[0-1A · 5]

**8.** **Sotuvchisi yo'q mijozlarga bot orqali ketadigan bitta xabar** (7-javobingiz; uni «Xabar yuborish» sahifasidan o'zingiz yuborasiz). Taklif qilinayotgan matn: «Assalomu alaykum! GSR LOGISTICSda savollaringizga tez javob beradigan yangi raqam ochildi: @… (GSR sotuv menejeri ‹AI ismi›). Narx, yuk holati va manzillar bo'yicha shu raqamga yozishingiz mumkin.» ⭐ a) shu matn — faqat ism bilan (mijoz «botmisiz?» deb so'rasa, AI rostini o'zi aytadi) · b) matnning o'zida ochiq «AI yordamchi» deb yoziladi · c) matnni o'zingiz yozib berasiz. [0-1A · 6]

**9.** **Tili bilinmaydigan kirillcha birinchi xabar.** Mijoz faqat «5 куб 800 кг» deb yozsa — rusmi, kirillcha yozadigan o'zbekmi, bilib bo'lmaydi. ⭐ a) bugungidek: shunday suhbatdagi birinchi javob sizning bitta ✅ingizni kutadi (keyingilari o'zi ketadi) · b) ruscha javob o'zi ketadi (o'zbek mijozga ruscha borib qolishi mumkin). [0-1A · 7]

**10.** **Fors va xitoy tilidagi tayyor matnlar.** Tayyor matn — AI emas, tizim o'zi qo'yadigan, oldindan tasdiqlangan jumla (masalan: «Ovozli xabaringizni hozir eshita olmayapman — iltimos, yozib yuboring»). Bu ikki tilni o'qiy olmaysiz; qoida keyingi hamma bosqichdagi tayyor matnlarga ham tegishli. ⭐ a) har birining o'zbekcha tarjimasini ko'rib, bir marta tasdiqlaysiz · b) bu ikki tilda tayyor matn ketmaydi — o'rniga sizga karta keladi (⚠ avval «forscha va xitoycha ham gaplashaversin» degansiz — b) buni toraytiradi). [0-1A · 8; 1B §6.3; 2 §6.3; 3A §6.3; 3B §6.5]

**82.** **Oddiy javob ichida va'da chiqib qolsa.** Tekshirish uchun ataylab yozilgan 303 ta xavfli javobdan 244 tasini bugungi qoidalar ushlaydi; 55 tasini hech qaysi qoida ushlamaydi. Bu 55 ta gap: qarzga berish va'dasi («oy oxirida hisob-kitob qilamiz») · chegirma («sizga narxda yon beramiz») · bepul xizmat («qadoqlash bizning hisobimizdan») · bojxona to'lovi bo'yicha va'da («bojxona to'lovlarini o'zimiz yopamiz») · muddat va'dasi · kafolat («hech narsa yo'qolmaydi») · va yana bir nechtasi («yukingiz yetib keldi» degan da'vo, raqamsiz aytilgan narx). To'liq ro'yxat shu xabar bilan birga yuboriladi. AI bunday gapni yozgani hozirgacha ko'rilmagan, ko'rsatmalari ham buni taqiqlaydi. Lekin bugun shunday javob chiqsa, u sizning 2 daqiqangizni kutardi; birinchi bosqichdan (1a) keyin esa «oddiy javob» bo'lib darhol ketadi. Bunday gapni ushlaydigan yangi qo'riqchi 3b-bosqichda quriladi. Qaysi biri:

⭐ a) o'zingiz aytgandek (11-javobingiz) — oddiy javob darhol ketadi; to'r — har kungi 10 ta javob tekshiruvi. Shuni biling: AI shunday gap yozsa, mijoz uni siz ko'rmasdan oladi; kechqurun ko'rasiz, lekin gap aytilgan bo'ladi. Xohlagan kuni sahifadagi «oddiy javob kutishi» katagiga 120 (soniya) yozib, b) ga o'zingiz o'tasiz.

b) ⚠ oddiy javoblar ham 3b-bosqichgacha 2 daqiqa kutadi. 11-javobingiz «oddiy gap darhol ketadi» edi — b) uni vaqtincha o'zgartiradi. Shuni biling: har bir javob mijozga 2 daqiqa kech boradi, har biriga telefoningiz jiringlaydi, va to'xtatish uchun kartani shu 2 daqiqa ichida o'qishingiz kerak.

c) avval shu gaplar eski so'z qoidalariga qo'shiladi, birinchi bosqich undan keyin chiqadi. Shuni biling: bosqich bir necha kunga kechikadi; faqat ro'yxatdagi gaplar ushlanadi (boshqacha aytilgan va'da baribir o'tadi); ba'zi oddiy javoblar ham sizning ✅ingizni kutib qoladi — nechtaligini oldindan o'lchab ko'rsatamiz.

[0-1A · 9, §4.1 «K1, as measured», §6.3 — lead ruling R8. The three numbers are the dry run's: replace them with K1's own committed snapshot before sending, and attach the list — three sentences of each kind in the message, the rest as a file. 1a's package P1 is not merged until he has answered this one; «sen aytgandek» with the list in his hand is an answer (a), silence is not]

### 1b va 1c dan oldin

**11.** **Ish kunlari** — bitta sozlama. Shu bo'yicha yuradi: «sizdan 15 daqiqa javob bo'lmasa, karta o'rinbosarga ham chiqadi» soati (5-javobingiz), hamkasblarga boradigan savol kartalari va «ertasi ish kuni» yuboriladigan eslatmalar. ⭐ a) dushanba-shanba 09:00-19:00, yakshanba ish kuni emas (yakshanbadagi kartalar dushanbani kutadi) · b) har kuni 09:00-19:00. Mijozga AI yakshanba kuni ham javob beraveradi — bu faqat odamlarga boradigan kartalar soati. [1B-1C · 1; 3A · 4 (dam olish kuni); 7-9 · B11-7]

**12.** **Kutish xabari.** AI javobni bilmay sizdan yoki hamkasbdan so'raganda mijozga bitta tayyor matn ketadi: «Savolingizni aniqlashtiryapman — javobini shu yerga yozaman». ⭐ a) shu matn ma'qul · b) matnni o'zingiz yozib berasiz. (Vaqt aytilmaydi: «bir daqiqa», «tez orada» — bu va'da bo'ladi.) [1B-1C · 2]

**13.** **Bir javobda eng ko'pi nechta xabar?** Bugun AI har javobni bitta xabar qilib yozadi; yangi usulda odamdek bir nechta xabarga bo'lishi mumkin. Bu son bitta javobdagi HAMMA xabarni sanaydi: AI yozgan gap ham, tayyor matn ham (masalan, kod va manzil, o'qilgan fayl ro'yxati), kutish xabari ham. ⭐ a) 3 ta · b) 2 ta · c) bugungidek 1 ta. ⚠ «Ban xavfini minimum qilsin» degansiz — xabar soni oshsa, akkaunt xavfi ham oshadi; a) va b) shu xavfni oshiradi. [1B-1C · 3; lead ruling R6]

**14.** **Sinov: eski suhbatlarni qayta o'ynatish.** Yangi suhbat yuritish usulini yoqishdan oldin serverda sinab ko'ramiz: AI so'nggi kunlardagi haqiqiy suhbatlarga yangi usulda qaytadan javob yozadi — mijozga hech narsa ketmaydi, siz eski va yangi javobni sahifada yonma-yon ko'rasiz. ⭐ a) oxirgi 14 kun, 150 tagacha javob (pullik: taxminan 150 ta AI so'rovi) · b) 7 kun, 60 ta · c) kerak emas — sinovsiz yoqamiz. (Sinov sizdan tasdiq kutmaydi — «test bo'lmasin, tasdiqlarim kutib qolmasin» degan javobingizga zid emas.) [1B-1C · 4]

**15.** **Kod xabarida kompaniya boti havolasi.** Kod ochilgach AI mijozga kodini va Xitoydagi sklad manzilini yuboradi. Shu xabarga bot havolasi ham qo'shilsinmi (mijoz yukini botda kuzatishi uchun)? ⭐ a) ha — mijoz kartasida telefon raqami bo'lsa · b) yo'q, faqat kod va manzil. [1B-1C · 5]

**16.** **Telegramda raqami yashirin mijoz va kod.** Ikki qism (b qismi 5-bosqichga tegishli — «5 dan oldin» guruhida):

16a) 1c-bosqichda kodni siz bitta tugma bilan ochasiz. Raqami yashirin mijozga ham ochilsinmi: ⭐ 1) ha; mijoz kartasida «📵» (telefon yo'q) belgisi turadi. Shuni biling: telefonsiz mijoz botga ulana olmaydi · 2) yo'q — AI avval telefon raqamini so'raydi.

[1B-1C · 6]

**17.** **O'rinbosar narx yozilgan javobni ham tasdiqlay oladimi?** ⭐ a) ha, lekin kartada faqat tizimdagi huquqi bo'yicha ko'ra oladigan narxni ko'radi (VED narxi va mijoz narxini birga faqat siz ko'rasiz) · b) narx yozilgan javoblar faqat sizga keladi (⚠ 5-javobingiz «15 daqiqadan keyin o'rinbosarga ham» edi — b) narxli javoblarni bundan chiqaradi). [1B-1C · 7]

### 2 dan oldin

**18.** **Invoysdan VEDga.** Mijoz invoys yuborsa, AI o'qiganini mijozga qaytarib «to'g'rimi?» deb so'raydi. Ish VEDga qachon ketsin: ⭐ a) mijoz «ha» deb yozgandan keyin, o'qilgan qatorlar bilan (⚠ 2-javobingizda invoysning o'zi yetarli edi — a) da mijozning yozma «ha»si ham kerak; javob bermasa, ish ketmaydi) · b) darhol, lekin faqat faylning o'zi bilan — qatorlarni VED qog'ozdan o'zi kiritadi (alohida ish). Mijoz tasdiqlamagan sonlar bilan ish hech qachon yuborilmaydi. [2 · 1]

**19.** **Ovoz qayerga yuboriladi** (ovoz sinovi o'tsa). Mijozning ovozli xabari matnga aylantirish uchun tashqi kompaniya serveriga yuboriladi — ovozi va aytganlari o'sha yerda qayta ishlanadi. Sinovdan bir nechta xizmat o'tsa, qaysi biri tanlansin: ⭐ a) avval O'zbekistondagi; u sinovdan o'tmasa — Yevropadagi, keyin AQSHdagi · b) faqat O'zbekistondagi; u sinovdan o'tmasa, AI ovozni eshitmaydi. [2 · 2]

**20.** **«O'qiganim» xabari.** AI fayl yoki rasmni o'qigach, mijozga o'qiganini qaytaradi va «to'g'rimi?» deb so'raydi. Unda: ⭐ a) 6 tagacha qator va jami (kg, kub, karobka) · b) faqat jami. [2 · 3]

**21.** **Tovar rasmi** (hujjat emas, tovarning o'zi). ⭐ a) AI rasmda nima ko'rganini aytadi («kurtkalar ekan») va kub/kg ni so'raydi (tovarni noto'g'ri tanib qolishi mumkin) · b) AI hech narsa demaydi, sizga karta keladi. [2 · 4]

**22.** **To'lov cheki rasmi** (cheklar buxgalterga o'tadigan 6-bosqich qurilguncha). ⭐ a) mijozga «faylni oldim» deyiladi, chek sizga karta bo'lib keladi — «to'lov qabul qilindi» deyilmaydi · b) mijozga hech narsa deyilmaydi, faqat sizga karta keladi. [2 · 5]

**23.** **Kunlik chegaralar — pulga emas, songa.** ⭐ a) kuniga 100 ta fayl o'qiladi, shundan 20 tasini kuchli (qimmatroq, aniqroq) o'quvchi o'qiydi, bitta mijozdan kuniga 10 ta; ovoz — kuniga 120 daqiqa, bitta xabar 2 daqiqagacha · b) sonlarni o'zingiz yozasiz. ⚠ Avval «chegara qo'yma» degansiz — bular yangi chegaralar (pul bo'yicha chegara yo'qligi — 10-javobingiz — o'zgarmaydi). Chegaradan oshgan fayl o'qilmaydi: AI mijozdan yozib yuborishni so'raydi. [2 · 6]

**24.** **Qog'ozlar sinovi.** 20 ta haqiqiy fayl (invoys, packing list, rasm) ikkala o'quvchiga — arzoniga va kuchlisiga — beriladi; bitta sotuvchi 1 soat sarflab to'g'ri javoblarni belgilaydi (taxminan 40 ta AI so'rovi). ⭐ a) ha, o'tkazamiz · b) kerak emas — hamma faylni kuchli o'quvchi o'qisin (har bir fayl qimmatroq tushadi). [2 · 7]

**25.** **Ovozning birinchi 100 tasi** (ovoz sinovi o'tsa). ⭐ a) ovozli xabarga yozilgan birinchi 100 ta javob «Nazoratda» turadi (AI o'zi yuboradi, siz ro'yxatda ko'rasiz), keyin o'zingiz «O'zi»ga o'tkazasiz; mijozlar 100 tadan 15 tadan ko'pida «noto'g'ri eshitding» desa, AI o'zi «yozib yuboring»ga qaytadi · b) ovozdan kelgan har bir javobni doim o'zingiz tasdiqlaysiz («So'rab»). [2 · 8]

### 3a dan oldin

**26.** **Hamkasbning raqamsiz javobi.** VED, logist yoki buxgalter AI so'ragan savolga javob yozdi, ichida raqam yo'q. ⭐ a) AI uni mijozga o'zi yetkazadi, kunlik tekshiruvda albatta ko'rasiz («Nazoratda»). Shuni biling: hamkasb yozgan va'da («ertaga jo'naydi») siz ko'rmasdan ketadi · b) birinchi oy har biri sizning ✅ingizni kutadi («So'rab»). (Javobda raqam bo'lsa — har doim sizga karta; bu o'zgarmaydi.) [3A · 1]

**27.** **VED va AI raqamidagi suhbatlar.** Bugun VED hamma akkauntdagi suhbatlarni o'qiy oladi — demak AI mijozga aytgan narxni ham ko'radi. ⭐ a) bugungidek qolsin. Shuni biling: VED mijoz narxini ko'rib, o'z narxi bilan solishtirsa, ustamani bilib oladi · b) AI raqamidagi suhbatlarda narx yozilgan xabarlar VEDga ko'rinmasin (⚠ bu 2026-07-31 dagi «VED suhbatlarni ko'rsin» degan qaroringizni toraytiradi). [3A · 2]

**28.** **Hamkasbning mijozi.** Boshqa sotuvchining mijozi AI raqamida pul, chegirma yoki yangi bitim haqida so'radi — savol o'sha sotuvchiga boradi (8-javobingiz). Sotuvchi 15 daqiqada javob bermasa: ⭐ a) savol sizga va o'rinbosarga ham chiqadi (mijoz kutib qolmaydi, lekin sotuvchi o'rniga siz javob berasiz) · b) faqat o'sha sotuvchini kutadi. [3A · 3]

**30.** **Shikoyat kimga boradi.** 14-javobingiz bo'yicha shikoyat — sizga (15 daqiqadan keyin o'rinbosarga ham). Savol faqat nusxa haqida: ⭐ a) boshqa hech kimga · b) mijozning o'z sotuvchisi bo'lsa, unga ham nusxa boradi. [3A · 5]

**31.** **🙋 dan keyin.** 🙋 bilan suhbatni o'zingizga olganingizdan 24 soat o'tganda: ⭐ a) AI sizdan «davom ettiraymi?» deb so'raydi; 10 daqiqa javob bermasangiz, o'zi davom etadi · b) so'ramasdan davom etadi (bugungidek) · c) «AI davom etsin» demaguningizcha jim turadi (unutsangiz, mijoz javobsiz qoladi). [3A · 6]

**32.** **Bir hamkasbda nechta ochiq savol tursin?** Bir odamda javobsiz savollar ko'payib ketsa, yangi savol keyingi odamga yoki sizga o'tadi. ⭐ a) 5 tadan oshsa · b) boshqa son (yozing). [3A · 9]

**33.** **Zavoddan olib kelish va «sotib olib berish» uchun AI nimalarni so'rab yig'sin** (keyin odamga topshiradi — 20-javobingiz)? ⭐ a) shu ro'yxat: zavod nomi va manzili, u yerdagi odam va telefoni, tovar, qachon tayyor bo'lishi; sotib olishda — nima, nechta, qancha pulga · b) ro'yxatni o'zingiz o'zgartirasiz (nimani qo'shish yoki olib tashlashni yozing). [3A · 10]

**34.** **«Kim javob beradi» sahifasi.** Eslatma (savol emas): quyidagilar kimga borishini shu sahifada o'zingiz belgilaysiz, kodda hech kim yozilmaydi — qo'ng'iroq qiladigan odam · zavoddan olib kelish · sotib olib berish · to'lov kartasi raqamini beradigan odam · to'lov cheklarini ko'radigan odam (bo'sh bo'lsa — «pul tushdimi» savoli boradigan odamlar) · «qarzga bering» so'rovi. Bo'sh qolgani sizga va o'rinbosarga keladi. Ikkitasi boshqacha: «katta mijoz kimga o'tadi» va «AI mijozlari kimga beriladi» bo'sh bo'lsa, mijoz hech kimga o'tkazilmaydi. Bitta savol: o'qib bo'lmagan fayl kartasi uchun ham shu sahifada alohida qator kerakmi? ⭐ a) yo'q — sizga va o'rinbosarga keladi · b) ha, alohida odam belgilanadi. [2 · 9; 4-6 · 5.11-8, 6.11-6, 6.11-7]

**35.** **Kodi hali ochilmagan mijozga CRMdan yozish.** Kod ochilmaguncha mijoz tizimda lid bo'lib turadi; bugun CRMda lid suhbatiga yozish oynasi yo'q. ⭐ a) hozircha shunday qoladi: siz AI raqami telefonidan yozasiz, o'rinbosar esa faqat AI tayyorlagan javobni kartadagi ✏️ bilan o'zgartira oladi (⚠ 5-javobingiz «AI raqamidan ikkovingiz yozasiz» edi — a) da o'rinbosar bunday mijozga o'zi yangi xabar yoza olmaydi) · b) lid suhbatiga CRMdan yozish oynasi quriladi — alohida ish. [3A §4.5]

### 3b dan oldin

**36.** **Xitoy manzilidan oldin savol.** Avia yuk boshqa manzilga boradi (uni har safar siz berasiz — 17-javobingiz), shuning uchun avia mijozga avto sklad manzili ketib qolishi — eng qimmat xato. AI manzil yuborishdan oldin «avto yoki avia?» deb so'rasinmi? ⭐ a) ha — har yangi yuk so'rovida bir marta (mijozga bitta ortiqcha savol) · b) faqat suhbatda avia tilga olingan bo'lsa (tezroq, lekin AI aviani so'zlardan taniydi — tanimay qolsa, xato manzil ketadi). [3B · 1]

**37.** **Yangi qo'riqchini qabul qilish o'lchovi.** Yangi qo'riqchi eski so'z qoidalari o'rnini olishidan oldin sinaladi: unga ataylab yozilgan, oldindan yopib qo'yilgan xavfli javoblar to'plami beriladi. Nechta xavfli gap o'tib ketsa qabul qilasiz? ⭐ a) bitta ham o'tmasa — va baribir o'tgan har bir gapni o'zingiz ko'rasiz · b) har bir tur bo'yicha sonni o'zingiz aytasiz. (Va'da turlari — chegirma, qarz, kafolat, «bojsiz», bepul xizmat, pul qaytarish, sana — bunga kirmaydi: ularda eski so'z ro'yxati qoladi.) [3B · 2]

**38.** **Xitoy sklad manzilini yuborish boshida qaysi holatda tursin?** ⭐ a) «Nazoratda» — AI o'zi yuboradi, birinchi ikki hafta har bir yuborilgan manzil ro'yxatingizga tushadi (manzil xato bo'lsa, siz ko'rguningizcha ketgan bo'ladi) · b) «O'zi» — ro'yxatsiz. Keyin sahifada o'zingiz o'zgartira olasiz. [3B · 3]

**39.** **Tarjimasi tasdiqlanmagan fakt.** Bilimlardagi fakt (masalan, to'lov tartibi) boshqa tilda so'raldi, lekin o'sha tildagi tarjimasini hali tasdiqlamagansiz (masalan, rus mijoz so'radi). ⭐ a) javob sizga kartaga tushadi · b) mijozga o'zbekcha asl matn ketadi. [3B · 4]

**40.** **Xato topilsa.** AI o'zi qilayotgan ish turida (masalan, jadval narxini aytish) xato topilsa, o'sha ish turi qaysi holatga tushsin? ⭐ a) «So'rab»ga — har biri sizning tugmangizni kutadi; orqaga qaytarish ham sizning tugmangiz · b) «Nazoratda»ga — AI yuboraveradi, siz ko'rib turasiz. [3B · 5]

**41.** **«Menga yozmang» degan mijoz.** Ikki qism (b qismi 8-bosqichga tegishli — «8 dan oldin» guruhida):

41a) 8-bosqichgacha bunday mijozning suhbatida AI o'zini o'chiradi — keyin mijoz yana yozsa ham AI javob bermaydi, suhbat sizga qoladi. O'chirishni: ⭐ 1) AI o'zi darhol qiladi, sizga xabar keladi · 2) bugungidek — bitta tugma bilan siz tasdiqlaysiz.

[3B · 6]

**42.** **Ikkinchi tekshiruvchi ishlamay qolsa.** Yangi qo'riqchida AI yozgan har bir javobni yuborishdan oldin ikkinchi AI tekshiradi. U ishlamay qolsa: ⭐ a) AI yozgan javoblar sizga kartaga tushadi, tayyor matnlar (narx, manzil, yuk holati) ketaveradi · b) hamma javob to'xtaydi. [3B · 7]

**43.** **Yangi qo'riqchining sinov muddati.** Yangi qo'riqchi avval eski qoidalar bilan yonma-yon ishlaydi (mijozga javob eski qoidalar bo'yicha ketadi) va farqlarini sizga ko'rsatadi. ⭐ a) 14 kun va kamida 200 javob · b) 7 kun. [3B · 8]

**44.** **Menyu nomi.** Bo'lim bugun «AI sotuvchi» deb ataladi; sizga ko'rsatilgan sahifada huquqlar ekrani «AI hodim → Huquqlar» deb yozilgan edi. ⭐ a) menyu «AI sotuvchi» bo'lib qoladi, ichida «Huquqlar» bo'limi ochiladi · b) menyu nomi «AI hodim»ga o'zgartiriladi. [3B §4.5]

### 4 dan oldin

**45.** **«Xorgos narxi = Qashqar narxi»** (18-javobingiz) qanday saqlansin? ⭐ a) «Tarif» sahifasida bitta tanlov: Xorgos doim Qashqar ustunidan o'qiydi (Qashqarni o'zgartirsangiz — ikkalasi o'zgaradi) · b) Qashqar qatorlari Xorgosga bir marta nusxalanadi, keyin ikkalasi alohida yuradi. [4-6 · 4.11-2]

**46.** **Qashqar / Xorgosdan yetkazish muddati** mijozga nima deb aytilsin? ⭐ a) siz yozmaguningizcha muddat aytilmaydi · b) «15-25 kun» (Xitoyning boshqa skladlari bilan bir xil). [4-6 · 4.11-3]

**47.** **AI aytgan jadval narxi kartada qayerga yozilsin** (29-javobingiz: aytilgan narx kartaga yoziladi). Ikki qism:

47a) Qayerga: ⭐ 1) mashina (yo'lkira) narxi kartadagi «Narx» katagiga yoziladi, avia narxi faqat «AI aytgan narx» qismida turadi. Shuni biling: «Narx» katagidagi son keyin shu mijozning fura hisobini oldindan to'ldiradi · 2) hech biri katakka yozilmaydi, faqat «AI aytgan narx» qismida ko'rinadi.

47b) Aytilgan narx necha kun amal qiladi: ⭐ 1) 7 kun · 2) boshqa son (yozing).

[4-6 · 4.11-4]

**48.** **PDF qaysi narxga yuborilsin?** ⭐ a) faqat VED narxiga (rasmiy taklif varag'i bor) · b) jadval narxiga ham — buning uchun «taxminiy» deb yozilgan yangi varaq kerak, alohida ish. [4-6 · 4.11-5]

**49.** **Siz 💵 bilan o'zingiz yozgan narx ham kartaga yozilsinmi?** ⭐ a) ha (⚠ avval «men yozgan narx faqat mijozga ketsin, kartaga yozilmasin» degansiz — a) shuni bekor qiladi; 29-javobingiz AI aytgan narx haqida edi) · b) yo'q — kartaga faqat AI aytgan narx yoziladi. [4-6 · 4.11-6]

**50.** **Past aytilgan narx saqlanganda** (22-javobingiz: farq 50 $ gacha bo'lsa, mijozda aytilgan narx qoladi). Shunda kartadagi narx VED narxidan past bo'lib qoladi — farq kompaniya hisobidan. ⭐ a) kartaga o'zi yoziladi, sizga xabar keladi · b) har biri bitta tugma bilan sizdan o'tadi. [4-6 · 4.11-8]

**51.** **2027-yil tarifini oldindan tasdiqlash.** 31-dekabrda saytdagi narx jadvali tugaydi; 1-yanvardan AI mashina narxini «Tarif» sahifasidagi qatorlardan oladi. Yangi yil qatorlarini oldindan ko'rib tasdiqlab qo'yadigan tugma kerakmi? ⭐ a) ha · b) yo'q, 1-yanvarda o'zingiz bosasiz (bosmaguningizcha birinchi narxli javob sizning ✅ingizni kutadi). [4-6 · 4.11-9]

### 5 dan oldin

**16.** (b qismi) **Raqami yashirin mijoz «Ha» desa.** 5-bosqichda mijoz «Ha» deb yozsa, AI kodni o'zi ochadi (16-javobingiz); lekin bu mijozning telefoni yo'q.

16b) ⭐ 1) uning kodi 1c dagidek bitta tugma bilan sizdan o'tadi · 2) AI mijozdan kontaktini ulashishni so'raydi; ulashsa, o'zi ochadi · 3) telefonsiz ham o'zi ochadi.

[4-6 · 5.11-1]

**52.** **AI ochgan kod bekor qilinganda mijozga nima deyiladi?** (AI ochgan har bir kod sizga ko'rsatiladi va bitta tugma bilan bekor qilasiz — 16-javobingiz.) ⭐ a) ikki tugma chiqadi: «mijozga tizim aytsin» / «o'zim yozaman» · b) doim tizim o'zi aytadi. [4-6 · 5.11-2]

**53.** **Kodni qachongacha bekor qilish mumkin?** ⭐ a) shu kodga yuk yoki to'lov yozilmaguncha · b) faqat ochilganidan keyingi 48 soat ichida. [4-6 · 5.11-3]

**54.** **Yuk kelmagan kod.** AI ochgan kodga yuk umuman kelmasa, necha kundan keyin sizdan «bu kodni yopaymi?» deb so'ralsin (o'zi hech qachon yopmaydi)? ⭐ a) 60 kundan keyin, bitta tugma bilan · b) 30 kundan keyin · c) so'ralmasin. [4-6 · 5.11-4]

**55.** **AI «Kutilayotgan yuk» yozsinmi?** Mijoz yukini aytgach, AI uni «Kutilayotgan yuk» ro'yxatiga yozadi — logist ko'radi; o'lchamlar mijoz aytgani bo'ladi (tekshirilmagan). ⭐ a) ha · b) yo'q. [4-6 · 5.11-5]

**56.** **«AI yutgan mijoz kimniki» sozlamasi oy o'rtasida o'zgartirilsa** (31-javobingiz: kompaniyaniki / birinchi yukdan keyin sotuvchiga / sotuvchidek), yangi qoida: ⭐ a) hali KPI to'lanmagan oylarga ham taalluqli · b) faqat keyingi oydan. [4-6 · 5.11-6]

**57.** **«Kompaniyaniki» rejimida** AI yutgan mijoz jamoa guruhida tabriklansinmi? ⭐ a) ha — «🤖 AI sotuvchi» nomi bilan, GIFsiz · b) yo'q. [4-6 · 5.11-7]

**58.** **Katta mijozni odam-sotuvchiga o'tkazish taklifi.** AI mijozi oyiga necha kub yuk olib kelsa, uni sotuvchiga o'tkazish sizga taklif qilinsin (o'tkazish — bitta tugma bilan; kimga — «Kim javob beradi» sahifasida)? ⭐ a) 30 kub yoki to'liq mashina · b) boshqa son (yozing) · c) taklif kerak emas. [4-6 · 5.11-8]

**59.** **«Har bir kod o'sha daqiqada sizga ko'rsatiladi» degan ikki hafta** (16-javobingiz) qachondan sanalsin? ⭐ a) siz kod ochishni «Nazoratda»ga o'tkazgan kundan · b) AI ochgan birinchi koddan. [4-6 · 5.11-9]

### 6 dan oldin

**60.** **AI ustamaning qanchasini o'zi chegirma qilib bera oladi?** ⭐ a) yarmigacha, bitta bitimga bir marta (⚠ 23-javobingiz «faqat ustama ichidan» edi — a) buni ustamaning yarmi bilan cheklaydi; undan ortig'i sizga tugma bo'lib keladi) · b) hammasini · c) ikki bosqichda: avval chorak, mijoz yana so'rasa — yarmigacha. Shuni biling: AI qancha ko'p bersa, mijoz VED narxini shuncha aniq taxmin qiladi. (Ustama bo'sh bo'lsa — 1-savol — AI hech narsa bera olmaydi.) [4-6 · 6.11-2]

**61.** **Chegirma kartasidagi tayyor tugmalar.** Chegirma so'rovi sizga karta bo'lib kelganda unda tayyor tugmalar bo'ladi (foiz — mijozga aytilgan narxdan). ⭐ a) «3 %» va «5 %» · b) boshqa sonlar (yozing). [4-6 · 6.11-3]

**62.** **Yuk tayyor bo'lganda mijozga qaysi summa aytilsin** (25-javobingiz: summa bir marta aytiladi)? ⭐ a) shu kodning jami qarzi (eski qarzi bo'lsa, u ham ichida) · b) faqat shu mashinadagi yukning narxi (narx hali qo'yilmagan bo'lsa — aytilmaydi). [4-6 · 6.11-4]

**63.** **Botga ulanmagan mijozga summa** (25-javobingiz: summa bot orqali aytiladi; boti yo'q mijoz-chi)? ⭐ a) mijoz AI raqamiga o'zi yozganda, javob ichida bir marta aytiladi (telefoni tasdiqlangan suhbatda) · b) aytilmaydi. [4-6 · 6.11-5]

**64.** **Botda summa aytishni qachon yoqamiz?** Yoqilgach, keyingi kelgan mashinadan boshlab mijozlar «yukingiz yetib keldi» xabarida summani ko'radi. ⭐ a) deploydan keyin o'zingiz yoqasiz · b) deploy bilan birga yoqiladi. [4-6 · 6.11-8]

### 7 dan oldin

**65.** **Kompaniya botidagi AI o'zini kim deb tanishtiradi?** ⭐ a) ismsiz — «GSR AI yordamchisi» · b) AI raqamidagi ism bilan. [7-9 · A11-1]

**66.** **Zaxira raqamni tizimga qachon ulaymiz?** (30-javobingiz: zaxira raqam tayyorlanadi.) ⭐ a) hozir ulab qo'yamiz, AI unda o'chiq turadi (⚠ «ban xavfini minimum qilsin» degansiz — a) da zaxira raqam ham hozirdan Telegramga «norasmiy dastur orqali kirgan» bo'lib ko'rinadi) · b) faqat telefonda turadi, kerak bo'lgan kuni ulaymiz (o'sha kuni ulash va tekshirishga vaqt ketadi). [7-9 · A11-3]

**67.** **Zaxira raqamga o'tilganda** birinchi 14 kun AI undan kuniga nechta javob yozsin? ⭐ a) 20 ta · b) 40 ta · c) sonni o'zingiz yozasiz. ⚠ «Chegara qo'yma» degansiz — bu chegara faqat yangi raqamning birinchi 14 kuni uchun: yangi raqam birdan ko'p yozsa, bloklanish xavfi katta. [7-9 · A11-4]

**68.** **Zaxiraga o'tilganda** eski AI raqamiga yozgan mijozlarga bot orqali bitta xabar («yangi raqamimiz …») yuborilsinmi? ⭐ a) ha — matnini siz tasdiqlaysiz va o'zingiz yuborasiz · b) yo'q. [7-9 · A11-5]

**69.** **Botda AI javob bera olmagan savol** mijozning sotuvchisiga o'tadi (bugungidek). Sotuvchiga boradigan xabarda sababi ham yozilsinmi? ⭐ a) ha, qisqa («narx so'radi») · b) yo'q, bugungidek. [7-9 · A11-6]

**70.** **«Hammasini to'xtatish» tugmasi** kompaniya botidagi AIni ham o'chirsinmi? ⭐ a) ha · b) yo'q — botdagi AI alohida o'chiriladi. [7-9 · A11-7]

### 8 dan oldin

**41.** (b qismi) **«Yozmang» va «🔕» nimani to'xtatadi?** 8-bosqichda AI birinchi bo'lib yoza boshlaydi (eslatma, tabrik).

41b) ⭐ 1) mijoz «yozmang» desa yoki AI raqamini bloklasa — unga so'ralmagan hech narsa yozilmaydi (AI raqamidan ham, botdan ham); o'z savoliga javob va o'z yuki haqidagi xabarlar qoladi. «🔕» tugmasi esa faqat tabriklarni to'xtatadi · 2) ikkalasi ham so'ralmagan hamma narsani to'xtatadi.

[7-9 · B11-1]

**71.** **Hamkasbingizning mijozi** (AI raqamiga yozgan) — AI unga birinchi bo'lib yozadimi? ⭐ a) eslatma — faqat narxni AI aytgan bo'lsa; tabrik — AI raqamidan emas, botdan (⚠ 26-javobingiz bo'yicha AI raqamiga 90 kun ichida yozgan har kim tabrikni AI raqamidan olardi — a) hamkasb mijozlarini bundan chiqaradi) · b) hamkasb mijozlariga AI umuman birinchi yozmaydi. [7-9 · B11-2]

**72.** **Tabrik qaysi tillarda yoziladi?** ⭐ a) o'zbek, rus, fors · b) ingliz tilida ham. (Xitoycha tabrik — hech qachon.) [7-9 · B11-3]

**73.** **Birinchi bo'lib yozishning boshlanishi** (eslatma va tabrik). ⭐ a) birinchi hafta «So'rab» — har bir xabar sizga karta bo'lib keladi, faqat sinov suhbatlarida; keyin o'zingiz «Nazoratda»ga o'tkazasiz · b) birinchi kundan «Nazoratda» — AI o'zi yuboradi, kunlik tekshiruvda ko'rasiz. [7-9 · B11-5]

**74.** **Juma kuni joy yetmasa.** Kuniga 10 ta birinchi xabar — eslatma va tabrik birga (26-javobingiz). Juma kuni 10 tadan oshsa: ⭐ a) avval eslatmalar, qolgan joyga tabriklar; sig'magan tabriklar keyingi jumaga o'tadi · b) avval tabriklar. [7-9 · B11-6]

**75.** **Boshqa tabriklar** (Navro'z, hayit). ⭐ a) faqat botdan; har birini alohida tasdiqlaysiz · b) AI raqamidan ham, juma qoidasi bilan (akkaunt xavfi oshadi). [7-9 · B11-8]

### 9 dan oldin

**76.** **AI sotuvchining KPI puli.** ⭐ a) hisoblanadi va ko'rinadi, lekin to'lanmaydi — «To'lash» tugmasi bo'lmaydi (⚠ 31-javobingiz «bugungidek, sotuvchidek hisoblansin» edi — a) hisobni qoldiradi, faqat to'lov tugmasini olib tashlaydi) · b) bugungidek: tugma turadi · c) «Kim javob beradi» sahifasida rahbar deb belgilangan odamga to'lanadi. (9-bosqichgacha bugungidek turadi.) [7-9 · C11-1]

**77.** **AI ishining haftalik hisoboti** (nechta suhbat, nechta kod, xatolar). ⭐ a) har dushanba 09:10 da, faqat sizga va o'rinbosaringizga · b) jamoa guruhiga ham (pul ko'rsatilmaydi) · c) kerak emas — sahifaning o'zi yetadi. [7-9 · C11-2]

**78.** **Kam ma'lumotli foizlar** (ko'rsatkichlar sahifasida). ⭐ a) 20 tadan kam holat bo'lsa, foiz ko'rsatilmaydi — faqat son · b) baribir foiz ko'rsatiladi. [7-9 · C11-3]

**79.** **Sozlamalar belgisi.** Har bir AI javobiga u qaysi sozlamalar bilan yozilgani belgilab qo'yiladi — keyin «qaysi o'zgarishdan so'ng yomonlashdi» ni ko'rish uchun. ⭐ a) ha, faqat belgi · b) kerak emas. [7-9 · C11-4]

### Keyin, o'z ma'lumotingiz bilan (dizayn §8 — hozir qurilmaydi)

**80.** **Mijozga bojxona TAXMININI aytish.** Avval sizga jadval ko'rsatiladi: o'z ishlaringizda «AI-VED taxmini» VED javobidan qancha farq qilgan. ⭐ a) jadvalni ko'rmaguningizcha mijozga taxmin aytilmaydi · b) hozirdan aytilsin (⚠ avval «AI hisob-kitobga o'zi narx bermaydi, taxmin faqat menga aytilsin» degansiz — b) shuni o'zgartiradi, va taxmin hali o'lchanmagan). [design §8]

**81.** **«Qachon jo'naydi?» savoliga rejadan javob.** Avval sanab ko'rsatiladi: nechta reja jo'nash sanasi bilan yozilgan. ⭐ a) sanoqni ko'rmaguningizcha bunday savol logistdan so'raladi (14-javobingiz) · b) hozirdan rejadan aytilsin (⚠ 14-javobingiz bo'yicha bu savol logistga borardi — b) shuni o'zgartiradi). [design §8]

### So'ralmaydi — 32 ta javobingiz allaqachon hal qilgan

Rejalarda savol bo'lib turibdi, lekin javobi bor — shu quriladi. (This table is the builder's record; it is not sent.)

| Rejadagi savol | Javobingiz | Quriladi |
|---|---|---|
| «Fura» so'zining o'zi signal beradimi [0-1A · 3] | 3 b: «20 kubdan YOKI fura desa» | ha; so'z bo'yicha signal yoqilgan holda chiqadi, o'chirish — sahifadagi o'z tugmasi |
| **29** — Tungi va dam olish kunidagi kartalar hamkasblarga: ish vaqti boshlanganda yoki darhol, ovozsiz [3A · 4] | 4 a: «hamkasblarga kartalar ertalabni kutadi» | ish vaqti boshlanganda boradi (dam olish kuni — 11-savol). 1a dagi «katta yuk» signali 3a-bosqich qurilguncha tunda ovozsiz keladi — tizimning bugungi tungi tartibi |
| O'rinbosar AI raqamidan yoza oladimi [3A · 7] | 5 b: «faqat ikkovingiz yozasiz» | ha (kodi ochilmagan mijoz uchun — 35-savol) |
| To'lov kartasi raqamini AI saqlab, o'zi yuborsinmi [3A · 8] | 21 a: «karta raqami odamdan keladi» | yo'q — har safar belgilangan odam yozadi, siz ✅ bosasiz |
| Botda jadval narxi aytilsinmi [7-9 · A11-2] | 28 a: «holat, manzil, oddiy savollar; qolgani sotuvchiga» | yo'q |
| Botdan tabrik kimga [7-9 · B11-4] | 26 a: «qolgan hammaga botdan, 🔕 tugmasi bilan» | botga ulangan hamma mijozga, oyiga bir marta |
| Bot balansni «Nazoratda» holatida ham aytadimi [7-9, sarlavha] | 25 b + 28 a | ha — bog'langan bot suhbati telefon bilan tasdiqlangan |

---

## F. The first message to send him — before stage 1a (ready Uzbek text)

What it is: the message the building session sends him before a line of stage 1a's package P1 is merged — two opening lines, then the questions of §E's groups «Ochiq qolgan uchta» and «1a dan oldin» **word for word and under the same numbers** (1-10 and 82), then one closing line. The builder's source brackets are left out; nothing else differs from §E. If a word of those eleven questions changes in §E, copy it here again — §E is the wording, this is its copy.

Before sending (for the builder — none of this is in the message):
1. **Question 82 carries three numbers (303 / 244 / 55) measured by a dry run.** Replace them with the counts of stage 1a's own committed snapshot (kernel K1) and ATTACH the list: three sentences of each kind in a second message, the rest as a file (`STAGE-0-1A.md` §6.3, §11 question 9). Never send the ⭐ without the list.
2. Put the persona name he typed where the text says ‹AI ismi› (question 8), and the seat's real @username where it says @….
3. Kernel K and the stage-0 measurements may go on while he reads; **P1 is not cherry-picked until he has answered 82**. «Sen aytgandek» with the list in his hand is answer a); silence is not an answer.
4. When he answers, write his message verbatim, with the date, under «## His answers» in `STAGE-0-1A.md` (questions 4-10, 82) and in `STAGE-4-6.md` (questions 1-3) before a line of code — the contract's §6.
5. Telegram cuts a message at 4 096 characters: send it as the blocks below (opening + the three open ones · 4-10 · 82 with its list), in this order, without re-wording.

```text
Assalomu alaykum! To'liq AI sotuvchining birinchi bosqichini (1a) boshlayapmiz: oddiy savollarga AI darhol o'zi javob beradi, narx 2 daqiqadan keyin ketadi (⏸ bilan to'xtata olasiz), 20 kubdan katta yuk yoki «fura» haqida siz belgilagan odamlarga signal boradi, va har oqshom AIning 10 ta javobini 👍/👎 bilan tekshirasiz.

Boshlashdan oldin 11 ta savolga javobingiz kerak: birinchi uchtasi avvalgi javoblaringizdan ochiq qolgan, qolgan sakkiztasi shu bosqich uchun. Ikki qismli savolda qism harf bilan (2a, 2b), variant raqam bilan belgilangan — "2a — 1, 2b — 2" deb javob bersangiz bo'ladi.

OCHIQ QOLGAN UCHTA

1. VED narxi ustiga ustama (VED hisoblagan narx ustiga siz qo'shadigan foyda) qancha bo'lsin? a) foizda — necha foizligini yozing · b) dollarda — har bir hisobga necha dollarligini yozing · ⭐ c) hozircha bo'sh qolsin. Bo'sh bo'lsa: AI mijozga VED narxining o'zini aytadi (ustiga hech narsa qo'shilmaydi), va AI o'zi chegirma bera olmaydi — har bir chegirma so'rovi sizga bitta tugma bo'lib keladi (23-javobingiz). Shuni ham biling: ustama bo'sh bo'lsa, mijozga aytilib kartaga yoziladigan narx VED narxining o'zi bo'ladi — uni sotuvchilar ham ko'radi (bugun sotuvchi VED narxini ko'rmaydi). Shu savolga javob berguningizcha «VED narxi» katagini yoqmaslikni maslahat beramiz: yoqilmasa, VED narxi mijozga o'zi ketmaydi, sizga karta bo'lib keladi.

2. Avia (javobingiz: «saytda 9-17 $/kg, 3-5 kun»). Ikki qism:

2a) Narx qanday aytilsin: ⭐ 1) bugungidek bitta narx — kg × sozlamadagi stavka (hozir 17 $ — oraliqning eng yuqorisi), oraliq aytilmaydi · 2) mijozga oraliq aytiladi («9-17 $/kg, tovarga qarab») — alohida ish · 3) tovar turiga qarab narx jadvali (jadvalni siz berasiz), AI «tovar turi?» deb so'raydi — alohida ish.

2b) Muddat: ⭐ 1) «3-5 kun» — yozganingizdek (⚠ bugun AI avvalgi javobingiz bo'yicha «2-5 kun» deydi — shu almashadi) · 2) «2-5 kun» qolsin.

3. Qashqarda hozir yuk qabul qilamizmi, va manzili qanday? ⭐ Javobingizgacha: Qashqardan yuk so'ralsa, narx «Tarif» sahifasidagi Qashqar ustunidan aytiladi, manzilni esa har safar o'zingiz berasiz.

1a DAN OLDIN

4. Tunda narx (tun — 22:00-08:00). Mijoz tunda narx so'rasa: ⭐ a) jadval narxi (yo'lkira va avia — tarif jadvalidan) 2 daqiqadan keyin o'zi ketadi, VED narxi ertalabni kutadi. Shuni biling: tunda ⏸ ni hech kim bosmaydi — jadval narxi siz ko'rmasdan ketadi · b) hech qanday narx tunda ketmaydi — mijoz ertalabgacha narxsiz kutadi · c) VED narxi ham tunda ketadi (⚠ avval VED narxi uchun «faqat kunduzi» degansiz — c) shuni o'zgartiradi).

5. Hisoblatishga yuborish. Mijoz hamma ma'lumotni bergach, AI ishni VEDga yuboradi va mijozga «hisoblatishga yubordim» deydi. Bu: ⭐ a) narx kabi 2 daqiqa kutadi — shu vaqt ichida ⏸ bosib to'xtata olasiz (VEDga noto'g'ri ish tushmaydi; mijoz 2 daqiqa ko'proq kutadi) · b) darhol ketadi (to'xtatib bo'lmaydi).

6. Kunlik tekshiruv qayerda bo'lsin. Har oqshom AIning 10 ta javobini 👍/👎 bilan baholaysiz (9-javobingiz). ⭐ a) sahifada — Telegramga bitta eslatma keladi, bosib sahifani ochasiz · b) Telegramning o'zida — tugmalari bilan o'nta alohida xabar.

7. Saytdan kelganlar (6-javobingiz: saytda «Telegram»ni bosgan yuk mijozlari AIga boradi; «sotib olib berish» odamlarda qoladi). Ikki qism:

7a) Saytda xizmat turi tanlanmagan «Umumiy» so'rovlar: ⭐ 1) ular ham AIga (sotuvchilarga saytdan faqat «sotib olib berish» qoladi) · 2) odamlarda qoladi.

7b) Qachon yoqamiz: ⭐ 1) 2-bosqichdan keyin — AI rasm va faylni o'qiy boshlaganda (⚠ 6-javobingiz o'zgarmaydi, faqat kechikadi: o'sha kungacha saytdan kelganlar bugungidek sotuvchilarga boradi; tugmani xohlagan kuni o'zingiz yoqasiz) · 2) birinchi bosqich (1a) chiqqandan bir hafta keyin · 3) darhol (AI hali rasm va faylni o'qiy olmaydi — bunday mijozga «yozib yuboring» deydi).

8. Sotuvchisi yo'q mijozlarga bot orqali ketadigan bitta xabar (7-javobingiz; uni «Xabar yuborish» sahifasidan o'zingiz yuborasiz). Taklif qilinayotgan matn: «Assalomu alaykum! GSR LOGISTICSda savollaringizga tez javob beradigan yangi raqam ochildi: @… (GSR sotuv menejeri ‹AI ismi›). Narx, yuk holati va manzillar bo'yicha shu raqamga yozishingiz mumkin.» ⭐ a) shu matn — faqat ism bilan (mijoz «botmisiz?» deb so'rasa, AI rostini o'zi aytadi) · b) matnning o'zida ochiq «AI yordamchi» deb yoziladi · c) matnni o'zingiz yozib berasiz.

9. Tili bilinmaydigan kirillcha birinchi xabar. Mijoz faqat «5 куб 800 кг» deb yozsa — rusmi, kirillcha yozadigan o'zbekmi, bilib bo'lmaydi. ⭐ a) bugungidek: shunday suhbatdagi birinchi javob sizning bitta ✅ingizni kutadi (keyingilari o'zi ketadi) · b) ruscha javob o'zi ketadi (o'zbek mijozga ruscha borib qolishi mumkin).

10. Fors va xitoy tilidagi tayyor matnlar. Tayyor matn — AI emas, tizim o'zi qo'yadigan, oldindan tasdiqlangan jumla (masalan: «Ovozli xabaringizni hozir eshita olmayapman — iltimos, yozib yuboring»). Bu ikki tilni o'qiy olmaysiz; qoida keyingi hamma bosqichdagi tayyor matnlarga ham tegishli. ⭐ a) har birining o'zbekcha tarjimasini ko'rib, bir marta tasdiqlaysiz · b) bu ikki tilda tayyor matn ketmaydi — o'rniga sizga karta keladi (⚠ avval «forscha va xitoycha ham gaplashaversin» degansiz — b) buni toraytiradi).

82. Oddiy javob ichida va'da chiqib qolsa. Tekshirish uchun ataylab yozilgan 303 ta xavfli javobdan 244 tasini bugungi qoidalar ushlaydi; 55 tasini hech qaysi qoida ushlamaydi. Bu 55 ta gap: qarzga berish va'dasi («oy oxirida hisob-kitob qilamiz») · chegirma («sizga narxda yon beramiz») · bepul xizmat («qadoqlash bizning hisobimizdan») · bojxona to'lovi bo'yicha va'da («bojxona to'lovlarini o'zimiz yopamiz») · muddat va'dasi · kafolat («hech narsa yo'qolmaydi») · va yana bir nechtasi («yukingiz yetib keldi» degan da'vo, raqamsiz aytilgan narx). To'liq ro'yxat shu xabar bilan birga yuboriladi. AI bunday gapni yozgani hozirgacha ko'rilmagan, ko'rsatmalari ham buni taqiqlaydi. Lekin bugun shunday javob chiqsa, u sizning 2 daqiqangizni kutardi; birinchi bosqichdan (1a) keyin esa «oddiy javob» bo'lib darhol ketadi. Bunday gapni ushlaydigan yangi qo'riqchi 3b-bosqichda quriladi. Qaysi biri:

⭐ a) o'zingiz aytgandek (11-javobingiz) — oddiy javob darhol ketadi; to'r — har kungi 10 ta javob tekshiruvi. Shuni biling: AI shunday gap yozsa, mijoz uni siz ko'rmasdan oladi; kechqurun ko'rasiz, lekin gap aytilgan bo'ladi. Xohlagan kuni sahifadagi «oddiy javob kutishi» katagiga 120 (soniya) yozib, b) ga o'zingiz o'tasiz.

b) ⚠ oddiy javoblar ham 3b-bosqichgacha 2 daqiqa kutadi. 11-javobingiz «oddiy gap darhol ketadi» edi — b) uni vaqtincha o'zgartiradi. Shuni biling: har bir javob mijozga 2 daqiqa kech boradi, har biriga telefoningiz jiringlaydi, va to'xtatish uchun kartani shu 2 daqiqa ichida o'qishingiz kerak.

c) avval shu gaplar eski so'z qoidalariga qo'shiladi, birinchi bosqich undan keyin chiqadi. Shuni biling: bosqich bir necha kunga kechikadi; faqat ro'yxatdagi gaplar ushlanadi (boshqacha aytilgan va'da baribir o'tadi); ba'zi oddiy javoblar ham sizning ✅ingizni kutib qoladi — nechtaligini oldindan o'lchab ko'rsatamiz.

"Sen aytgandek" desangiz — har birida ⭐ turgan variant quriladi.
```

---

## G. Owner-eye pass (2026-11-20)

A second reader's pass over THIS file only: the lead's rulings R1-R9 of 2026-11-20 carried into §A-§D, every question of §E read with the owner's eye (is it open · does its ⭐ touch an earlier answer · is it plain Uzbek · does each option change what is built), the first pass's new questions added, and §F written. Logged step by step, as the work went — a line here is what was checked, what was changed and what was left for the lead.

### G.0 Read before anything was changed
- This file whole; design §7, §8, §11 (11.1-11.3); `critic-feasibility.md` §A (the 35 earlier answers); `STAGE-0-1A.md` §11, §4.1 «K1, as measured», §6.3 and BOTH dry runs (the second pass had already written R2, R3, R8, R9 into that plan and added its own question 9 — the 55); the «## Seam check» of `STAGE-1B-1C.md` and of `STAGE-2.md`. The other plans' §11 lists were read at step 3. Nothing was run; no file but this one was edited.
- Noted at the start: `git status` shows `STAGE-0-1A.md`, `STAGE-3A.md`, `STAGE-3B.md`, `STAGE-4-6.md`, `STAGE-7-9.md` modified in the working tree — other readers of this same pass were writing while this one read. What this section says about another plan is «as read at that minute».

### G.1 Step 1 — §A-§D made true to the rulings (done)
Changed in this file (old → new):
- **R1** — §C.6 «the seat's mail» row and §D's `STAGE-1B-1C.md` row said «`readdress` in both writers» → ONE function called by EVERY person-addressed writer of a notification row, the counted allow-list for role / alarm writers, the source-shape fence over `src/`, the EXEMPT set (no «covered-types list»), both ranks each with its own sight, the two test names; stage 5 = buttons only; stage 7 teaches it the set of seats.
- **R2** — §A.3 gained the table of the two readers with their callers (`designated` tells, `designatedRows` lets in / makes an owner) and the sentence «an empty table never widens a door»; §C.1 names both readers. §A row 5 says the pair is read as rows.
- **R3** — §A.2 (loop detector) and §B row 2: `same_inbound` keeps the text-less guard, digits kept, the unit test is `agent-loop-detector.test.ts`.
- **R4, R5, R6, R7** — new §C.9 (four rows). R7 also in §C.3 (the one writer, `mayTuneAuto`).
- **R8** — §B row 1 no longer reads «clean»: the 55, with the pointer to `STAGE-0-1A.md` §4.1 / §6.3, the three choices and «P1 waits for his answer»; §A row 11 and §A.2 point at it.
- **R9** — new §B row 16 (the liveness alarm as a binding condition of taking the hold off talk); §C.8's 1a row says it adds no table. The chore half of R9 («VED narxi» ticked only after the markup answer) is carried by question 1 (step 2).
Sentences that the other plans' seam checks had made untrue, fixed:
- §C.1 «§A.3 lists all fourteen» → sixteen (found by `STAGE-3A.md` / `STAGE-3B.md` «Seam check» 4).
- §A.3 fallback of `big_customer` / `handover_seller` «the pair / no hand-over» → read as ROWS, no fallback (`STAGE-4-6.md` §5.4 as re-written); `reserve_phone` marked «read by nothing».
- §C.3 stage-4 entry lacked «widens `tell_west_price`»; «5 widens `open_code`» now says to «Nazoratda», never «O'zi»; «8 widens» now says to what («So'rab» / «Nazoratda»). §A row 16 follows.
- §C.5 `reminder`: «no writer — he chose no reminders» was FALSE (his 24 a IS two reminders) → no writer because a reminder is a `followup` draft and stage 6's amount rides the bot's notice.
- §A row 4: «question 29 below» → not asked, decided by 4 a (step 2).
Left for the lead (not this file's to decide):
- `reserve_phone` is minted by stage 7 and read by nothing (`STAGE-3B.md` «Seam check» 4, item 4): give the account alarm that audience, or do not mint it. **→ Ruled by the lead:** stage 7's alarm tells the reserve SIM's holder when it offers the reserve door (`STAGE-7-9.md` §A3, §A7).
- 1a's source-shape list «no role key, uuid or name» names five files; R9's new `liveness.ts` addresses the pair and is not on it (`STAGE-0-1A.md` §7, the designation row). **→ Done by the lead:** six files (`STAGE-0-1A.md` §7 and its Conformance item 3).
- `STAGE-1B-1C.md` «Seam check» still lists as OPEN three things the rulings closed (R6 the count, R1 both ranks, R7 `mayTuneAuto`), and `STAGE-2.md` «Seam check» two (R5, R6) — as read at this minute; their plans' bodies may already carry the ruling. **→ Done by the lead:** each seam check ends with «Closed by the lead, 2026-11-20», and `STAGE-1B-1C.md` §4.0 states the queue rule (members of `agent.event` for events about a conversation; `agent.read`, `agent.block_text`, `agent.channel_inbound` the listed exceptions).

### G.2-G.5 Steps 2-5 — the list, the new questions, §F, the counts (finished by the lead, 2026-11-20)

This reader was stopped by a usage limit after §E and §F were written and before steps 2-5 were logged. The lead
checked what it had written instead of re-doing it:
- **Numbering (script, not by eye):** §E carries 1-82 with 29 unused and 16 / 41 in two parts under one number —
  nothing else missing, nothing doubled.
- **Every plan question reaches §E (script):** all 76 questions of the seven plans' «Questions for the owner»
  sections (0-1A 9 · 1B-1C 7 · 2 9 · 3A 10 · 3B 8 · 4-6 26 · 7-9 19) are cited in a bracket of §E or of its
  «So'ralmaydi» table; no bracket cites a question that does not exist.
- **§F is §E's copy (script):** questions 1-10 and 82 in §F's text block are word for word §E's, the builder's
  brackets left out. §F is 6.9 thousand characters, so it goes as the blocks its note 5 names.
- **One consequence added to question 1** (in §E and §F alike): with an empty markup the price told and written on
  the card IS the VED's figure, and sellers see it — the one place his 23 c / 29 b and law 4 meet, said to him
  before he chooses.
- **«Ha» to the customs offer lands as `podklyuch`** (`STAGE-0-1A.md`'s own choice): not asked — his 2 a's words
  are «rastamojka bilan hisoblab beraymi», i.e. the road AND customs together, which is what podklyuch is. Watch
  the first live job.
- **Not re-measured:** the three numbers of question 82 (303 / 244 / 55) are the first dry run's; §F's note 1 and
  `STAGE-0-1A.md` §6.3 tell the builder to replace them with K1's committed snapshot and attach the list before
  sending.

