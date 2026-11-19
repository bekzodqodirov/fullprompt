# Critic — the running cost of SPEC-TOLIQ-v1, as numbers he can plan with

Read-only review, 2026-11-19. Nothing measured: no key and no Telegram here. Every dollar below is arithmetic over the
code's own price map and sizes; the script is `scratchpad/fullai-cost-scripts/model.py`. **His own `agent_runs` rows and
the 20:00 «🤖 AI (oxirgi 24 soat)» line already hold the truth for today — the spec never asks for them.**

## Verdict

1. **«Today ≈ $5-7/day» is wrong as a statement about today.** `docs/AI-SOTUVCHI.md` §18.1 says «about $5-7 a day **at 150
   runs**» — the bill at the daily cap. On 11-15 the AI drafted nine replies (CLAUDE.md, #1800): ≈ $0.3-1 a day.
   Replace with «2-5 cents a reply; the day's figure is on his 20:00 message».
2. **«$15-40 on a busy day, $600-1 200 a month» is right only at ≈ 60 conversations a day** and the spec names no
   volume. At 20 a day it is $7-14 ($220-420 a month); at 150 it is $48-91 ($1 400-2 700). «Busy day × 30» is not a month.
3. **The three designs disagree 5× on a full sale** ($0.3-0.8 operations, $0.5-1.2 product, $1.5-3 risk) and the spec
   adopted none. Mine: **≈ $0.9** as the spec reads (0.7 lean, 1.7 careless). The $1.5-3 is the careless build.
4. **The spec leaves open the three choices that double the bill** (§4 below): which model the reviewer is, whether
   «hard» turns go to the stronger writer, how much the writer thinks.
5. **Q29's «$25» has nothing to enforce it.** The code caps runs (150), tokens (3 000 000, cache reads free) and
   readings by count; no gate is in dollars, speech-to-text has no ledger, and a model with no entry in the price map is
   counted and never priced — a reviewer on a third model would be outside any dollar budget.
6. **Under today's send limits the bill caps itself**: 80 AI messages a day by default, 200 at most
   (`SEND_CAP_BOUNDS` = the human queue's), 12 per chat. That is ≈ $3-11 a day whatever the demand. The 60 and 150
   rows are real only after stage 7.

## 1. Where each number comes from

| Input | Value | Source |
|---|---|---|
| Cheaper model (`claude-sonnet-5`, the AI seller's) | in $2 · out $10 · cache read $0.20 · cache write $2.50 per M tokens | **code**: `platform/ai/model.ts MODEL_USD_PER_MTOK` |
| Stronger model (`claude-opus-5`, every document reader) | in $5 · out $25 · read $0.50 · write $6.25 | **code**, same map |
| Smallest tier (`claude-haiku-5-5`) | in $0.10 · out $0.50; counts ≈ 30 % more tokens | **outside**: the provider's list as cached 2026-11-03; not in the code's map |
| Batch (answer within a day) | −50 % on every token | **outside**: provider reference |
| Cache | 5-minute life only; one cache per model; 1-hour write costs 2× | **code** (`ephemeral`) + provider reference |
| Run shape | ≤ 6 rounds, 1 500 output tokens a round, chat block cached per run, ≤ 24 000 chars of history | **code**: `agent/run.ts`, `agent/limits.ts` |
| Document readers | 32 000 output tokens, effort medium, 150 s; photo ≤ 1568 / 2000 px | **code**: `calc/intake-ai.ts`, `receipts/tarkib-read-ai.ts`, `tarkib-file.ts` |
| Image tokens | ≈ 1 per 28×28 px: 1568 px ≈ 2 350-3 140; 2000 px ≈ 3 800-4 784 | **outside**: provider reference (map-senses §5.6 uses the same) |
| PDF page | 1 500-3 000 tokens | **outside**, not checked against a real invoice |
| Speech-to-text | **$0.006 a minute — ASSUMPTION**, shown ×5 | given by the task; critic-stt found $0.0017-0.016 |
| Head of the prompt | 8 000 tokens today → **12 000 target** (seller role, playbooks, ≈ 18 tools) | today: map-senses §5.5; target: **my assumption** |
| Output per round | 300 (tool round), 800 (final), 1 100 (2-3 messages) | map-senses §5.5 + **assumption**. The seam sends no effort setting, so the model thinks at its default and thinking bills as output: the least certain number here (×2 shown) |
| Cache hit share of the head | 70 % at 20 conversations a day · 90 % at 60 · 97 % at 150 | **assumption** (arrival gaps over a 14-hour day) |
| Mix | ⅓ of turns price turns; photo 40 % (2 photos); document 20 % (half become a VED job); voice 30 % (2 notes of 30 s + one read-back turn); 0.5 follow-up per conversation; reviewer asks for a rewrite on 8 % | task + **assumptions** |

## 2. What one unit costs (cheaper model unless said)

| | Unit | ≈ $ | Note |
|---|---|---|---|
| a | Ordinary text turn, warm head | **0.016-0.027** | 1-2 rounds. Cold head +0.028. A 100-message history: 0.03-0.04 |
| b | Turn with tool rounds and a price (4 rounds) | **0.044-0.049** | cold 0.07-0.08; the code's worst case (6 full rounds) 0.15 |
| c | Reviewer, once per TURN | smallest tier **0.0004** · cheaper **0.007** · stronger **0.022** | per MESSAGE is ×2-3. With rewrites and a 10 % tripwire: 0.003 / 0.011 / 0.025 a turn. Only on turns with blocks or commitments (≈ 35 %): 0.003 cheaper, 0.009 stronger |
| d | Photo read once, kept as text | **0.010** (0.008 at 1280 px); stronger 0.035 | left in the loop as an image: +0.0055 per round ≈ **0.11 per photo** over eight more turns |
| e | Invoice / packing list read once | Excel **0** (no model) · cheaper reader **≈ 0.045** · existing stronger reader **0.10-0.28**, worst 0.83 | the multi-file request reader (`analyzeIntake`): ≈ 0.33, worst 1.15. A table does not fit the run's 1 500 tokens — it must be a separate reader call |
| f | Voice note, 30 s | **0.003** (×5: 0.015) | the real cost is the read-back turn it forces: +0.016-0.027. ×5 on the price moves a conversation by 2 % |
| g | Proactive follow-up | **0.02-0.03**; templated reminder **0**; prepared in a batch ≈ 0.012 | |
| h | Nightly fact check, daily sample of 10 | **0** | database comparisons — true once sent facts are stored as blocks. Morning report: 0 as a template, ≈ 0.03 a day if a model writes it |
| + | A turn on the stronger WRITER | 0.07-0.12 warm, **0.14-0.19 cold** | its cache is separate and rare turns find it cold: 6-7 ordinary turns each |
| + | AI-VED passes per job the AI lands; a customs estimate (Q6) | ≈ 0.05-0.30 each | existing calc ledger, stronger model; not sized from data |
| + | One replay of 200 real chats; one pass of the 1 201 dangerous cases through a reviewer | **≈ $50-85**; $8 cheaper / $26 stronger | in no ledger and under no budget in the spec; half price as a batch |

## 3. Volume scenarios (×30 days; won deal = $ per conversation ÷ conversion)

«Spec» = cheaper writer on every turn, same-tier reviewer on every turn + stronger on a 10 % tripwire, documents by
the existing stronger reader, photos read once. «Lean» and «careless» are §4's settings.

| Conversations a day | Turns | Build | $ / conversation | $ / day | $ / month | $ / won deal at 10 % | at 20 % |
|---|---|---|---|---|---|---|---|
| 20 | 6 | lean / **spec** / careless | 0.29 / **0.37** / 0.65 | 6 / **7** / 13 | 170 / **220** / 390 | 2.9 / **3.7** / 6.5 | 1.4 / **1.8** / 3.2 |
| 20 | 12 | | 0.57 / **0.70** / 1.24 | 11 / **14** / 25 | 340 / **420** / 740 | 5.7 / **7.0** / 12.4 | 2.9 / **3.5** / 6.2 |
| 60 | 6 | | 0.25 / **0.33** / 0.61 | 15 / **20** / 37 | 450 / **600** / 1 100 | 2.5 / **3.3** / 6.1 | 1.3 / **1.7** / 3.1 |
| 60 | 12 | | 0.50 / **0.63** / 1.17 | 30 / **38** / 70 | 900 / **1 130** / 2 100 | 5.0 / **6.3** / 11.7 | 2.5 / **3.2** / 5.8 |
| 150 | 6 | | 0.24 / **0.32** / 0.60 | 36 / **48** / 90 | 1 070 / **1 430** / 2 690 | 2.4 / **3.2** / 6.0 | 1.2 / **1.6** / 3.0 |
| 150 | 12 | | 0.48 / **0.61** / 1.14 | 71 / **91** / 171 | 2 150 / **2 720** / 5 140 | 4.8 / **6.1** / 11.4 | 2.4 / **3.0** / 5.7 |

- In «spec» the writer is 50-60 % of every row, the reviewer ≈ 22 %, all media and VED passes together 10-20 %.
- If the writer's output is twice my guess: +24 % on every row.
- Status questions from existing customers cost and never convert. The KPI page must divide the MONTH's bill by the
  month's won deals, not use these two columns.
- Against today's caps: 60 × 12 is 720 runs and ≈ 4.8 M counted tokens (caps 150 and 3 M); 150 × 12 is 1 800 runs,
  above the cap's editable maximum of 1 000; a 12-turn chat sits exactly on `runsPerChatPerDay` = 12 and above
  `perChatPerDay` = 12 sends once a turn is 2-3 messages.

## 4. The three choices that move the bill most (at 60 conversations × 12 turns)

| # | Choice | Costs | Cheap alternative | Saves |
|---|---|---|---|---|
| 1 | **Reviewer: which model, how often.** §3 wall 4 says «a second model reads every outgoing message» and names none | stronger on every turn **+$17 a day**; same tier +$6 | Exact checks first (free). One call per turn, not per message. Smallest tier on every turn, stronger only on a tripwire or a commitment. **The exam decides**: run each tier over the 898 + 303 cases and print catch rate beside price | $6-17 a day |
| 2 | **A stronger writer for negotiation, complaint, closing** (both designs ask for it; the spec is silent) | 20 % of turns: **+$16 a day**, +45 % | Keep the cheaper writer on every turn through stage 6: money is the tools' and the blocks', not the model's. Stronger model only as tripwire reviewer and reader fallback | $16 a day |
| 3 | **How much the writer writes and thinks** (no effort setting on the seam; «bigger turn budget», 2-3 messages) | output ×2: **+$9 a day**, +24 % | Low effort on talk and status turns, more only on price and closing turns; keep a hard ceiling per turn and per chat per day | up to $9 a day |
| 4 | Documents by the stronger reader (what Q15's «$0.1-0.3» assumes) | +$2-4 a day; a cap by COUNT does not bound it — 50 readings a day (the existing reader's cap) × 32 000 output tokens is **$41 a day** worst case | Excel through the model-free reader; PDF and photo on the cheaper reader; stronger only when rows are `unsure` or totals disagree. §10's trial must compare both models on the same 20 papers, with cost per paper | ≈ 75 % of the line |
| 5 | Images or PDFs re-sent each round | +$4 a day; never ends for a returning customer's 100-message history | Rule in §4 of the spec: **no image or PDF block ever enters the run loop** — one reading per attachment id, stored as text. (Stage 2 already says «read once»; §1's «reads photos» does not) | ≈ 90 % of the line |
| 6 | Cold prompt head at low volume | ≈ 15 % of the bill at 20 a day ($1-2) | a keep-alive every 4-5 minutes in working hours (≈ $0.45 a day) or the 1-hour cache (≈ $0.8) | ≈ $0.5-1.5 a day |

## 5. What to change in the spec

1. **§7 stage 0, add a measurement**: 30 days of `agent_runs` — runs a day, the four token columns per run, cache-read
   share, $ per run — and his last seven 20:00 lines. Free, on his server now. Every table above gets a real column.
2. **§3 wall 4**: name the reviewer's tier ladder, «once per turn», and «the exam picks the model».
3. **§4 brain**: rule «the cheaper writer on all turns through stage 6»; give the turn a ceiling in tokens and in dollars
   (today's caps bound a run at $0.15 and a chat at $1.80 a day; «a bigger turn budget» removes that silently).
4. **§4 senses**: «no image or PDF in the loop»; Excel model-free; the reader's tier; one reading per attachment.
5. **§2 dials and §6, new block «one meter»**: one dollar figure across runs, reviewer, readings, speech minutes,
   follow-ups and tests; a price entry for every model before it ships; a ledger kind for the AI's readings (the map
   notes none exists); separate ceilings for replies / documents / writing-first / tests — a replay must not spend
   the customers' day.
6. **Say what happens at the ceiling.** Q29 does not; the operations design says «open conversations go to people».
   Proposed: 80 % warn; 100 % → writing-first and file reading stop, replies continue; 150 % → hand over, alarm.
7. **§6 test tools**: price the replay lab and the corpus runs (≈ $50-85 and $8-26 each), run them as batches.
8. **Non-model running costs are absent**: Telegram Premium on the AI number (Q26), the reserve SIM, the speech key,
   later WhatsApp's per-message fees. One line each in §9.
9. **Q15**: «Excel — free; PDF or photo — ≈ 5 cents (10-30 on the stronger reader); a daily ceiling in documents AND dollars».
   **Q16**: «≈ 0.3 cent a note (0.1-1.5); 100 notes a day ≈ $0.3; the real cost is one extra AI reply, 2-3 cents».

## 6. Corrected sentences

**§9, running cost** — replace with:
> Estimates from the code's own prices; his 20:00 «🤖 AI» line replaces them from the first week. Today: 2-5 cents a
> reply, under $1 a day at the present handful of replies ($5-7 is the bill at the 150-replies cap). Target: a short
> conversation (6 turns) ≈ $0.3, a long one (12) ≈ $0.6, a full sale with a document, two photos and a voice note
> ≈ $0.9. By volume: 20 conversations a day ≈ $7-14 a day, $220-420 a month · 60 ≈ $20-38, $600-1 150 · 150 ≈ $48-91,
> $1 400-2 700. Per won deal at 10-20 % conversion: $1.6-7. Three settings can double these (the reviewer's model, a
> stronger writer for hard turns, how much the writer thinks). Until the send limits change (80 messages a day now,
> 200 at most) the bill cannot pass ≈ $3-11 a day.

**Q29** — replace with (one budget = the AI seller, the files and voice it reads, what it writes first):
> a) $10 a day — ≈ 30 short or 15 long conversations; enough for stages 1-6 under today's send limits
> ⭐ b) $25 a day, warning at 80 % — ≈ 75 short or 40 long; at most ≈ $750 a month
> c) $50 a day — ≈ 150 short or 80 long; at most ≈ $1 500 a month
> And at the ceiling: ⭐ i) it stops writing first and reading files, keeps answering, tells you · ii) everything goes to people.
> Tests and replays have their own small monthly sum (⭐ $50) and never spend this one.
