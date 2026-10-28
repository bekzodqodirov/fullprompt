# Sakkiz band — ROUND 5: the newest models, strong reasoning, and AI spending in dollars

Build contract for a kernel commit (K) and six worktree packages:
P1 «Ekran» (the AI screen, prices, the spend warnings), P2 «Hisob» (the calc pass: the
bot's reading, the grouping, the pick, ✨), P3 «Eshiklar» (the three small doors: the
Bojxona tab's 🤖, «📈 Oldingi narx» 🤖, the deal goods import), P4 «Suhbat» (the card's
chat door as a queued pass), P5 «Yordamchi» (the staff assistant), P6 «Solishtirish» (the
one-off comparison). Item 3 of his 2026-10-20 message, diagnosed in `docs/SAKKIZ-BAND.md`
§4; his answers 3.1-3.8 and 2.9 (2026-10-21, §11 — all ⭐) are binding.

**You, the session building this, are the lead.** K, every package (directly or through
worktree agents), the cherry-picks, the M step, the report to him, and the post-deploy
walk-through (§18) are yours. Wherever this file says «the lead», it means you. You
talk to the owner: in Uzbek, plain text, numbered questions with options — never an
`AskUserQuestion` dialog (CLAUDE.md, «Who you are talking to»).

The companion file `SAKKIZ-R5-MAP.md` is the code map: every file and function this round
touches, its line as read, what it does today and the change. This file is the contract;
the map is where to look. **Both travel together**: they are committed at handoff as
`docs/SAKKIZ-R5.md` and `docs/SAKKIZ-R5-MAP.md`; §16.7 only adds K's hash to them.

- **Start gate (observable).** Do not cut K until ALL of these hold on `origin/main`
  (`git fetch origin main` first): (1) round 2 is merged — `docs/SAKKIZ-R2.md` exists and
  `docs/SAKKIZ-BAND.md` §10 marks R2 SHIPPED; (2) round 3 is merged — a migration file
  `*_calc_intake_durable.sql` exists in `src/modules/platform/db/migrations/`,
  `docs/SAKKIZ-R3.md` exists, and §10 marks R3 SHIPPED. Round 2 was on the branch as
  `r2-on-tip` @ `52171ca` when this was written (a late pass was still open); round 3 was
  a spec only (`docs/SAKKIZ-R3.md` once merged — this file cites it by that path). Every
  line number below marked «(head)» was read at `62a23bf`, «(R2)» at `52171ca`, «(R3
  spec)» is a line of R3's spec. **Re-read every function named in §15 on the merged
  tree before K.** Where this spec and the merged code disagree about what R2/R3 built,
  the code wins and this spec is re-fitted, never the other way round. If round 4
  (another session) merged first, read its landing too (§15.3).
- **Branch and PR.** Work on a branch `sakkiz-r5` cut from that `origin/main`; packages
  are worktree branches off K, cherry-picked onto `sakkiz-r5`; the PR is opened from
  `sakkiz-r5`. Commits end with the `Co-Authored-By` and `Claude-Session` trailers the
  harness supplies; the PR body ends with the attribution lines the harness supplies.
- **Migration: one, additive, numbered AFTER whatever `main` holds when R5 starts.** Main
  was at 136 entries (0000-0135) when this was written; round 3 takes the next
  (`calc_intake_durable`); rounds 4 and 8 are other sessions and may take numbers too.
  So: read `src/modules/platform/db/migrations/meta/_journal.json`'s tail, take the next
  index and the next `when` (#1040). The text below calls it **`0137_ai_spend`** for
  readability; the real number is what the tail says. It must run AFTER R3's
  `calc_intake_durable` migration (it re-creates a CHECK that migration made). The ledger
  must then read the journal's length. *(2026-10-28: round 4/8 shipped as the other
  session's Uch band and took **0136** `lead_client_many`; round 3 is now **0137**
  `calc_intake_durable` (`when` …116, `docs/SAKKIZ-R3.md` §13) — so R5's migration is
  **0138** at the earliest, `when` …117 or later.)*
- DECISIONS numbers are `#R5-1…`; the lead renumbers them at the merge after fetching the
  tail.
- **Naming in this file.** «R1»…«R10» and «round N» are the Sakkiz band rounds (R1 =
  DECISIONS #1455-#1462, the intake's honest failures; R2 = `docs/SAKKIZ-R2.md`; R3 =
  `docs/SAKKIZ-R3.md`). The older 2026-09-25 owner answers that CLAUDE.md also calls
  R1-R7 are always written «the 09-25 answer R1» (a cost's dollars FROZEN at their first
  conversion, DECISIONS #1009+) or «the 09-25 answer R5» (`tashkentDay`, the 19:00-24:00
  UTC test window).
- **No model identifier anywhere in this round's pushed work** — source, tests, docs,
  i18n, migration comments, Telegram texts, commit messages (CLAUDE.md hard rule; his
  3.2 a). The code knows TIERS («og‘ir» = heavy, «tez» = fast) and JOBS; the owner picks
  a MODEL per tier on a screen, from Anthropic's live list, and the id lives in the
  database only. This file follows the same rule: tiers and jobs, never a name or a
  version. A model's id appears only in chat with him (chat is not pushed). **The one
  permitted exception** is the attribution trailer the harness appends to each commit
  message (CLAUDE.md requires it): it is never quoted into a tracked file, and the fence
  (§1) scans tracked FILES only, never commit messages.
- **Where model names and prices come from (for the chat with him only).** Anthropic's
  pricing page and models overview (`https://platform.claude.com/docs/en/about-claude/pricing`
  — reachable from this container through the agent proxy, measured 2026-10-27) and the
  session's `claude-api` skill; the live Models API needs HIS key, so candidate names
  come from the docs, not from the API, until the screen runs on his server. If the
  docs and his Anthropic console disagree, his console wins and he types that.
  Nothing from these sources is written into a tracked file.
- **Judged before code — done.** This file was judged on 2026-10-27 by five lenses
  (money, regression, durability, product-fit, handoff), each objection checked by a
  refuter; 111 objections, 109 absorbed (confirmed or partial), 2 refuted. §20 lists every
  one with its verdict and what changed. Do NOT re-run a judge over this file; a re-judge
  is needed only for the parts you re-fit to the merged R2/R3 code (say which in the
  report).
- **His questions 3.9-3.18 (below) were SENT on 2026-10-27 by the session that wrote
  this handoff.** Read `docs/SAKKIZ-BAND.md` §11 for his answers first; if none are
  recorded there, send §19.1 VERBATIM, as plain Uzbek text, BEFORE K is cut; record his answers in `docs/SAKKIZ-BAND.md` §11 (the
  place the 3.x answers live); build ⭐ for every question he has not answered by the
  time K is cut. An answer that arrives mid-build is applied through the table at the
  end of «Questions for the owner» (which K/P artifacts each non-⭐ answer changes).

## Questions for the owner

His 3.1-3.8 do not settle these ten. ⭐ = what is built if he does not answer (his own
convention: «hammasi ⭐»). The Uzbek wording, numbered 3.9-3.18 to follow his list, is in
§19.1.

1. **How many picks on the screen.** His 3.6 a puts the ordinary staff's assistant on the
   FAST tier and the admin's data questions on the STRONG tier; his 3.1 a puts the heavy
   calc work on the strong tier.
   - a) ⭐ Two picks: «Og‘ir ishlar» (invoice/photo/PDF reading, TNVED grouping, the import
     pick, the Bojxona 🤖, «📈», the admin's assistant) and «Tez ishlar» (the ordinary
     staff's assistant). Each with its own fallback. Two prices per picked model.
   - b) Three picks: the admin's assistant gets its own («Admin yordamchisi»).
2. **A model Anthropic no longer serves** (the saved pick was retired; every call answers
   «model not found»). His 3.7 a named only the safety filter.
   - a) ⭐ The call is retried once on the tier's fallback model too, and the owner gets one
     Telegram message a day saying what happened («zaxira model o‘qidi» / «zaxira model
     ham topilmadi» / «zaxira yo‘q — qo‘lda»).
   - b) Only the safety filter uses the fallback; a retired model stops the AI in words
     until he picks.
3. **What `ai_monthly_ceiling_usd = 0` means.**
   - a) ⭐ No paid AI at all: every door does its model-free half and says «AI o‘chirilgan
     (oylik chegara 0)» — its own sentence, never «the money ran out». The same meaning 0
     has for the assistant's daily cap today.
   - b) No ceiling (the meaning 0 has for the calc daily cap today).
4. **A model with no price typed.** Anthropic's model list carries no price; he types the
   two prices per model on the screen. Deploy morning keeps today's heavy model running
   with no price until he types it.
   - a) ⭐ The AI keeps working. Those calls are counted against the ceiling at the
     HIGHEST price typed for any model (marked «taxminiy»); while NO price has been typed
     at all the ceiling cannot count them, and he gets a Telegram reminder once a day
     until he types one. When he types the price, this month's calls get their real
     dollars. A new pick cannot be saved without its two prices.
   - b) The AI stops on a model with no price until he types it.
5. **Who gets the AI's Telegram messages** (80 % / 100 %, «model topilmadi», «kalit rad
   etildi», «narx kiritilmagan», «xarajat yozilmayapti»).
   - a) ⭐ Whoever may open the AI screen: the super_admin ROLE holding
     `admin.settings.manage` (today: him).
   - b) Also the accountant.
6. **The chat door's timing (3.5 b).** «botdagidek» is built as: the press is saved at
   once, the model reads it in the background, THEN the request lands in the VED queue
   with the model's reading, and the prefill's answer reaches the card.
   - a) ⭐ As above: the job reaches /hisoblash up to ~3 minutes after the press (longer
     only while the server is being updated). Nothing the model reads can arrive after the
     VED has started. A yo‘lkira request whose typed text already names the route, kg and
     m³ lands at once (the tariff answers it without the model).
   - b) The request lands at once with the typed reading; the model's reading arrives on
     the card's lenta later as a note for the VED (it does NOT change the job's rows).
7. **When the fallback model answered** (the strong tier's filter refused a medicine/
   chemistry invoice and the previous model read it).
   - a) ⭐ The seller's chat says nothing extra; the card's lenta note carries one line
     «ℹ️ Asosiy AI xavfsizlik filtri sababli o‘qimadi — zaxira AI o‘qidi.»; the AI screen
     counts fallbacks per month.
   - b) The seller's chat says it too.
8. **The comparison's spend (3.8 a, ~$20-60).**
   - a) ⭐ Not counted against the $100 (he approved it separately); the script prints its
     own bill, and the screen's month total will be lower than Anthropic's invoice by that
     amount — said in the report.
   - b) Counted (the script writes ledger rows through a second, writable connection).
9. **The ordinary staff's assistant until he picks «Tez ishlar».** Today it runs on a
   cheaper model than the calc work, but that model is recorded nowhere the deploy can
   copy it from (the assistant was never metered), and no model id may be written in the
   code.
   - a) ⭐ Until he picks «Tez ishlar», the staff assistant runs on the «Og‘ir ishlar»
     model (it works, but each question costs more — the lead gives him the ratio in
     chat); picking «Tez ishlar» is his FIRST step on the screen after the deploy.
   - b) Until he picks, the staff assistant answers «AI modeli tanlanmagan» (staff lose it
     for those minutes or hours).
10. **The day limits beside the dollar ceiling.** His 2.9 c said «measure, then a dollar
    ceiling»; it did not say whether today's count limits stay (calc 200 a day, «📈» 50 a
    day, the assistant 40 a day per person).
    - a) ⭐ They stay as a runaway backstop (about 20× today's measured use, so the dollars
      bind first). A refused call and its fallback count as two calls of the day.
    - b) Removed — only the dollar ceiling (and the assistant's 40 per person, which is a
      fairness rule, stays).

**What a non-⭐ answer changes** (apply it on the branch; if it arrives after K, as a K
follow-up commit before the packages that consume it are picked):

| Answer | Changes |
|---|---|
| 1 b | the migration's `ai_tiers_tier_check`, the ledger's `ai_calc_passes_tier_check`, `AI_TIERS`, `AI_JOBS['assistant.admin'].tier`, every `Record<AiTier, …>`, the screen's third card, `aiModels.tier.*` / `tierHint.*` ×4, the alarm's `{tierWord}` |
| 2 b | K5 step 10 (no fallback hop on a 404; still the alarm), the alarm text, §14.1 item 9 |
| 3 b | `aiMonthSpend`'s ceiling rule (0 = no ceiling, `ceilingState 'none'`), `aiReady` never `'off'`, the `off` words become unused (keep the keys; a fence would otherwise demand them), the setting's four descriptions, §14.1 item 16 |
| 4 b | `aiReady` refuses a model with no price (`model_not_chosen`-like word `unpriced`), the unpriced reminder retires, §3.3's estimate is unused |
| 5 b | `door.ts` `aiManagers()` adds the accountant ROLE holding `finance.reports`; the `/profile` `mute_ai` box drawn for them too |
| 6 b | P4's job (§9.3) lands at the PRESS and writes the reading as a lenta note later; `calc.threadQueued*` texts |
| 7 b | the bot's reply after a fallback reading gains §2.5's ℹ️ line (`staff-handlers.ts`, the reading's reply) |
| 8 b | P6 gets a second, writable connection and writes `kind`-tagged ledger rows (a new kind `compare` in the CHECK, excluded from `CALC_BUDGET_KINDS`) |
| 9 b | `tierPlan('fast')` never borrows (§5 K2), the fast card's `autoBorrowed` line becomes `notChosen` |
| 10 b | `dayBudgetLeft('calc' / 'similar')` retire; `aiReady`'s `dayCap` argument becomes `null` at every door; the two settings stay unread (never deleted in the release that stops reading them) |

---

## 0. His answers, and what each one becomes

| # | His answer | What is built | Package |
|---|---|---|---|
| 3.1 **a** | The heavy work runs on the newest strong tier with STRONG reasoning. | The tier «og‘ir» (heavy) serves the invoice/photo/PDF reading, the TNVED grouping and the import pick (his list) at effort `high`, plus the Bojxona 🤖 (`medium`), «📈» (`low`) and the admin's assistant (`medium`) — today on the same model; the effort per door is stated to him (§19.2.4). Effort is set EXPLICITLY per job (§4) — the newest strong tier's default is one level below strong. It is SENT only for a pick that carries a capability snapshot (a person's save): until he saves, or for a model whose list entry carries no capabilities, the model runs at its own default and the tier card SAYS so in a sentence (§2.7). `max_tokens` is raised per job so the thinking (counted inside `max_tokens`) never cuts the JSON (R1's 4096 trap, five sites over) — sized against the org's output-token rate limit (§4). Every heavy call STREAMS under its own abort leash. | K + P2 + P3 |
| 3.2 **a** | The owner picks the model per tier on a settings screen, from Anthropic's LIVE model list; switching needs no deploy; no model id in source. | `/admin/ai` («AI: modellar va xarajat»): the live list (Models API), a primary and a fallback per tier, the two prices per picked model, this month's dollars. Picks live in `ai_tiers`, prices in `ai_model_prices`; one resolver `tierPlan(tier)` (pool, 60 s cache on `globalThis`, invalidated by the save). The two id constants in `platform/ai/model.ts` are deleted; a derived fence refuses an id-shaped string anywhere in the tracked files. Deploy morning: the migration copies the model that last answered a calc call into the HEAVY tier only, so the calc work runs on exactly today's model; the FAST tier stays unchosen and borrows the heavy pick until he picks (⭐ Question 9) — a stated change for the staff assistant, never «nothing changes». | K + P1 + M |
| 3.3 **b** | A monthly DOLLAR ceiling of $100; a Telegram warning at 80 %; above the ceiling the AI work is done by hand. | Prices typed per model; each call's dollars FROZEN on its ledger row at write time (computed in SQL from the row's tokens and the typed price); `ai_monthly_ceiling_usd` = 100. ONE readiness question every door asks before its paid step (`aiReady`): key → tier → month → (day cap where one exists); the runner asks the month again before EVERY attempt. The month counts a row with no frozen price at the live price, and a row whose model has no price at all at the highest typed price («taxminiy»); with no price anywhere a daily Telegram reminder says the ceiling cannot count (⭐ Question 4). Above the ceiling every door does its model-free half and SAYS so (§2) — never a silent manual path, never $0; a ceiling of 0 says «AI o‘chirilgan». 80 % and 100 % announced once per Tashkent month each, also when HE moves the ceiling or a price. Soft, stated: calls already in flight may cross it — about $5-15 in a busy minute (§3.4). A mistyped price is corrected for THIS month (§3.1). | K + P1 + every door |
| 3.4 **b** | The bot may wait up to 3 minutes with «⏳ AI o‘qiyapti…». | His three minutes are the SELLER's wait in Telegram, not the model's time. Round 1 set the model's leash to 150 s so that the files (≤ 30 s) plus the model (≤ 150 s) fit three minutes, and round 3 moved the reading to the `calc.intake-read` job with a SUM-pinned clock. **R5 keeps both unchanged** (`INTAKE_TIMEOUT_MS` 150 000, R3's expiry): the refusal fallback (3.7 a) lives INSIDE the same leash (no fallback with under 30 s left). Streaming makes the leash REAL: the SDK's `timeout` stops bounding a stream once its headers arrive (measured), so every call carries its own `AbortSignal`. If the comparison's p90 for the reading exceeds 120 s, the lead ASKS him before raising anything (§11.6). | K + P2 |
| 3.5 **b** | The card's chat door works like the bot: the request is saved and the AI answer reaches the card later. | One press («VEDga yuborish») validates, prechecks what the landing would refuse, fences and enqueues a pg-boss job `calc.thread-read` (~1 s); the job reads the selection with the heavy tier, lands the request through the unchanged `threadCalcSend`, and R2's prefill answers on the card's lenta and in the seller's Telegram. A yo‘lkira chat whose typed text already names route + kg + m³ lands at once (R2's instant tariff answer); otherwise it is read like the others. No AI available at the press (no key / ceiling / off / day cap / no model) → lands AT ONCE with the typed reading and the island NAMES why. While a reading runs the card says so and the same selection cannot be sent twice. The synchronous 20 s read and the preview are deleted (stated to him, §19.2). Metered (`kind 'intake'`, R3's note anchor). ⭐ of Question 6. | P4 |
| 3.6 **a** | The staff assistant: ordinary staff on the fast tier, the admin's data questions on the strong tier. | `assistantTier(actor)` beside `isAnalyst` (the ROLE super_admin/admin — the predicate that already chooses the model and the screen's intro): analyst → heavy job `assistant.admin`, everyone else → fast job `assistant.staff`. Resolved ONCE per question. Every round billed (`kind 'assistant'`, anchor = the `ai_questions` row). Thinking blocks round-trip unchanged between tool rounds. A refused round re-runs on the fallback and the question stays on it. The admin's wall clock: 180 s in the bot (inside his three minutes), 240 s on `/ai`. | P5 |
| 3.7 **a** | When the newest tier's safety filter refuses goods (medicine, chemistry, lab kits), retry automatically on the PREVIOUS model. | ONE client-side rule in ONE runner (`platform/ai/run.ts`): `stop_reason === 'refusal'` → exactly one more attempt on the tier's FALLBACK model (picked on the same screen), inside the same leash, when the fallback can do the job, the month still allows it and ≥ 30 s remain. At most three requests per call, ever (§5 K5). Both refused → the new word `refused_fallback`, and the customs answer SAYS the filter stopped it (§2.2). Each attempt billed at its own model's price. ⭐ of Question 2 extends it to a retired model, with an alarm sent AFTER the fallback with what really happened. The beta server-side `fallbacks` parameter is NOT used (§17). | K + every door |
| 3.8 **a** | Before he picks, a one-off comparison of candidate models on his real failed cases and the last sealed calculations (~$20-60). | `scripts/ai-solishtirish.ts`, run once through the `migrate` container, READ-ONLY by connection parameter, DRY RUN by default (free token counts, worst-case dollars); `--run --max-usd N` (N ≤ 60, refused above) spends under a HARD per-row reservation, one line per finished cell appended to a results file so a dropped SSH session loses nothing (`--resume`). Answer key = confirmed groups of sealed requests; his cases named by request code (`--requests`); candidates = the priced, capable HEAVY candidates the lead names. Prints an Uzbek report (no client names) that the lead reads to him before he picks. | P6 |
| 2.9 **c** | Measure first, then a dollar ceiling (3.3). | Round 2 fixed the COUNT (a call counts when the model answered). R5 adds the DOLLARS on the same rows and the ceiling. The day caps (`ai_calc_daily_limit` 200, `price_history_ai_daily_limit` 50, `ai_daily_limit` 40 per person) STAY as runaway backstops (⭐ Question 10); the calc cap's predicate becomes a POSITIVE kind list so the new kinds never eat the VED's day. | K |

### 0.1 Interpretations stated to him (in the round's Uzbek report, §19.2)

1. **The ceiling is soft.** It is read before every model request and written after the
   answer; calls already running when it is reached finish and are billed — about $5-15
   in a busy minute at worst (§3.4). A hard lock would hold the database across a network
   call (#714's family).
2. **Thinking cannot be switched off on the newest tiers**, and the code never tries: it
   sends no `thinking` parameter at all and controls depth with effort only — and effort
   is sent only for a model he has SAVED on the screen (the save records what the model
   supports). Until then the model thinks at its own default.
3. **Prices are his to type.** Anthropic's model list carries none. The lead gives him the
   numbers in chat; the screen refuses a pick without its two prices, refuses an output
   price below the input price («almashtirib yubormadingizmi?»), and shows what the month
   becomes before a save that moves it past 80 %. A price CORRECTION re-prices this
   Tashkent month's calls of that model; earlier months stay as they were (a record).
4. **The model's id lives in the database, never in the code.** The screen shows the
   name Anthropic gives it and its id in small print.
5. **The chat door still reads TEXT only** (as the question told him). Its photos and files
   are round 6's («one reader over all material»). Its «O‘qish» preview is gone: one press
   sends, and what is missing comes in the AI's answer (Telegram and the lenta).
6. **Every refused, cut or unreadable answer is billed**, and so is any reading whose
   stream had begun, however it ended (the clock stopped it, the connection broke,
   Anthropic sent an error mid-way) — Anthropic bills what it generated. Its output is
   then not known, so it is counted at a safe upper estimate and marked «taxminiy». A
   call that never reached the model (no key, network, a 4xx) costs nothing and is not
   recorded — R2's rule, refined for streams. A call killed by a server restart or deploy
   is not recorded at all (a few cents per deploy).
7. **The day limits stay** (⭐ Question 10): calc 200, «📈» 50, the assistant 40 per
   person — and a refused call plus its fallback is two calls of the day.
8. **The comparison runs on the day after the deploy, before he picks «Og‘ir ishlar».**
   Until then the calc work runs on exactly today's model (copied by the migration).
9. **The staff assistant runs on the «Og‘ir ishlar» model until he picks «Tez ishlar»**
   (⭐ Question 9) — that pick is his first step after the deploy and needs no comparison.
10. **The screen's month is Tashkent's** (it starts 5 hours before Anthropic's UTC invoice
    month) and leaves out the comparison and any reading a restart killed mid-call, so
    the screen and the invoice will not match exactly.
11. **A ceiling of 0 switches the paid AI off** (⭐ Question 3), and every door says «AI
    o‘chirilgan», not «the money ran out».
12. **The admin's data question in the bot waits up to 3 minutes**, on `/ai` up to 4.
13. **An assistant answer cut by its length limit is still shown**, with a line saying it
    was cut (he paid for it).
14. **The Bojxona «🤖 hammasi» press handles at most 30 products** and says how many remain
    (one press could otherwise spend a large share of the month on a big truck).
15. **The «✨ AI taklifi» press works for at most 3 minutes**; a larger request is finished
    by pressing ✨ again (it continues where it stopped).

---


## 1. Laws this round keeps (and the fences that hold them)

- **No model identifier in any tracked file.** Fence `tests/unit/no-model-id.test.ts`
  (§16, step M): every file `git ls-files` lists, minus binaries and the lockfile, is
  scanned case-insensitively for the vendor prefix, a separator, a lowercase word, a
  separator and a digit — `/claude[- ][a-z]+[- ]\d/i`, built in the test from two string
  pieces so the test does not match itself (#725). Comments are NOT stripped (a comment is
  pushed too). An exact false positive is allowlisted by `file:line-content`, never by
  file. Commit messages are not files: the harness's attribution trailer is the one
  permitted occurrence there (header), and it is never quoted into a file. **Red proof:**
  put one id back into `model.ts` → red.
- **Law 1 stays: the model never reaches a number.** No new `baza_source`, no new rate
  source; the runner changes HOW a call is made, never what an answer may write. The
  existing fences stay green unchanged except where their subject moved
  (`ai-advisory.test.ts` follows the pick's schema to its new home, §14).
- **One rule, one home (#513).**

  | Rule | Its one home |
  |---|---|
  | The tier, effort and need vocabulary (`AiTier`, `AiEffort`, `EFFORT_ORDER`, `AiNeed`) | `platform/ai/tiers.ts` (profiles.ts imports them type-only — no cycle) |
  | Which model a tier uses, with its capability snapshot; the fast tier's borrowing | `platform/ai/tiers.ts` `tierPlan` |
  | Effort, `max_tokens`, leash and needs per job | `platform/ai/profiles.ts` `AI_JOBS` |
  | How a call is made (stream, abort leash, the month gate before each attempt, one transient retry honouring `retry-after`, one model hop, clamp, the started-stream bill, failure word) | `platform/ai/run.ts` `runModel` (+ `countTokens` for the comparison's dry run) |
  | SDK error → failure word | `platform/ai/failure.ts` `aiFailureOf` (MOVED from `wms/calc/intake-ai.ts`) |
  | One call's tokens, as the SDK reported them (the final `message_delta` merged in) | `platform/ai/ledger.ts` `usageOf` |
  | Dollars from tokens | `platform/ai/ledger.ts` `aiCostSql` (+ the pure twin `aiCostUsd`, pinned equal) |
  | Writing the ledger | `platform/ai/ledger.ts` `recordAiCall` (`recordAiPass` is its wrapper, forwarding every usage field) |
  | This month's spend (the gate, the claim, the screen) | `platform/ai/ledger.ts` `aiMonthSpendSql()` — one SQL fragment; `aiMonthSpend` selects it, the 80/100 % claim embeds it |
  | «May a paid call start now?» | `platform/ai/ready.ts` `aiReady` |
  | Which kinds spend the VED's day | `CALC_BUDGET_KINDS` (positive list) |
  | Who manages the AI (screen, saves, alarms, /profile box) | `platform/ai/door.ts` `mayManageAi` / `aiManagers` |
  | The 80 / 100 % step | `platform/ai/alarms.ts` `nextSpendLevel` (pure) |
  | The once-a-month / once-a-day claims | `platform/diagnostics/signals.ts` (the table's one writer) |
  | Which assistant tier a person gets | `platform/ai/tools.ts` `assistantTier` |
  | A typed money figure: the comma question, the column's scale | `platform/numbers/number-cell.ts` `readNumberCell`, `platform/numbers/fit-numeric.ts` `fitNumeric` (MOVED in K, §5 K0; the wms files re-export them) |
  | «Is a chat reading pending for this card / selection?» | `wms/calc/thread-read.ts` `threadReadsPending` |

- **Layering.** `platform` never imports `wms`. Every new shared piece is in
  `platform/ai/`; `wms/calc/ai-cost.ts` keeps `recordAiPass` / `aiCalcBudgetLeft` /
  `attachIntakePasses` as thin wrappers so round 2/3 callers do not churn, and re-exports
  `aiReady`. The two number helpers move DOWN into `platform/numbers/` (pure, zero-import)
  so the platform price parser can use them.
- **#714, the pool of ten.** `tierPlan`, `aiReady`, `aiMonthSpend` and `recordAiCall` are
  pool reads/writes; none runs inside a `db.transaction`. The derived
  `tests/unit/tx-pool.test.ts` closes over them transitively once they reach `db` — it must
  stay green. Every transaction this round opens takes the caller's `tx` for every read
  inside it (the spend claim computes its level IN the claim statement, §6.6); recipients
  are read BEFORE it.
- **The runner never throws.** `runModel` is total: an internal read failure is a WORD
  (`server_behind`), the attempts made so far are always returned, and a throwing `read`
  becomes `unreadable` (§5 K5). So every model function keeps today's contract — «a model
  failure is a value, not an exception» (R3 §7.2.4).
- **Never $0, never a code.** Every new failure is a sentence in a `Record<Union, …>` map,
  so a missing entry is a compile error. A call with no price prints «narxsiz», never
  `$0.00`; an estimated figure prints «taxminiy». Money columns refuse NaN (`<>
  'NaN'::numeric`, round 110) and typed prices are rounded to the column's scale BEFORE
  the `> 0` test (`fitNumeric`, #917).
- **Bounded work.** Every model call carries an `AbortSignal` leash; every person-facing
  door has a WALL that includes the call in flight (✨ 180 s, the deal import 180 s, the
  admin assistant 180 s in the bot); every clock that a longer call moves is pinned by a
  SUM test (R3's shape): the thread job (§9.3), the customs pass (§7.6), the ✨ claim and
  the «📈» claim (§7.5, §8.3).
- **The comparison never runs in CI** (no key there). The OBJECT-LITERAL keys `purpose:
  'compare'` and `effortOverride:` with a value occur only under
  `src/modules/wms/calc/compare/` and in `scripts/ai-solishtirish.ts`; their declarations
  in `platform/ai/run.ts` and the `run?` pass-throughs in the model files are exempt
  (derived fence, §11.6).
- **House rules this round must not break** (CLAUDE.md, named here because the new
  surfaces sit right on them): no `AskUserQuestion` — questions go as plain Uzbek text;
  no segment-level `loading.tsx` under `(protected)` (#98) — `/admin/ai` awaits the Models
  API, bound that wait (§6.2), never add a loading file; no `<Suspense>` around action
  buttons and no `router.push` right after an action (#1242) — the tier and price forms
  render outside any Suspense; Tailwind compiles only literal classes — the screen's
  state badges use a literal lookup map (`STAGE_CLASS`-style); Postgres dies between
  turns — start it with CLAUDE.md's ritual, and «every test skipped» means it is down.
- **Process.** Red proofs are made and undone by string edit only (#430 — never
  `git checkout`, never `git stash`). Each gate runs with its own exit code and its own
  failure marker grepped (#803). `pnpm typecheck` before every commit. Trailers as the
  harness supplies them.

---

## 2. What the bot and the screens print — exact Uzbek

Apostrophe `‘` (U+2018) in bot strings, as `intake.ts` and `ai-reply.ts` already write.
In i18n bundles, match the apostrophe of the keys around the anchor. `money(n)` =
`` `$${n.toFixed(2)}` `` (unchanged).

### 2.1 The reading's failure words (`wms/calc/intake.ts` `AI_READ_FAILURE`, K)

The union grows by six; each gets its sentence and `retry` flag:

| Member | `text` | `retry` |
|---|---|---|
| `model_not_chosen` | `AI modeli tanlanmagan — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin.` | false |
| `model_unavailable` | `Tanlangan AI modeli Anthropic’da topilmadi (eskirgan bo‘lishi mumkin) — admin «Boshqaruv → AI: modellar va xarajat» sahifasida boshqasini tanlasin.` | false |
| `server_behind` | `Tizim yangilanmoqda — bir daqiqadan keyin qayta urinib ko‘ring.` | true |
| `ceiling` | `Bu oy AI uchun ajratilgan pul chegarasi tugadi — VED qo‘lda ko‘radi.` | false |
| `off` | `AI o‘chirilgan (oylik chegara 0) — VED qo‘lda ko‘radi.` | false |
| `refused_fallback` | `AI ham, zaxira AI ham bu materialni o‘qishdan bosh tortdi (xavfsizlik filtri) — VED qo‘lda ko‘radi.` | false |

`refused` keeps R1's sentence (no fallback chosen, the fallback cannot do the job, the
month gate closed, or under 30 s left). `threadAiAdvice` needs no edit: it reads the
`retry` flag, so every new non-retry member is `admin`.

### 2.2 The prefill reply's tail (`wms/calc/ai-reply.ts`, P2)

`budgetSpent?: boolean` becomes `aiStood?: AiStood | null` with
`type AiStood = 'day' | 'month' | 'off' | 'model' | 'refused' | 'month_mid'`. The first
four come from the readiness asked BEFORE the pass; the last two (and `model` again) from
what happened DURING it (§7.6) — the before-pass value wins when both exist. One line
each, under the existing «AI sozlanmagan» line's `else if`:

- `day` → `AI kunlik limiti tugadi — muhrlangan xotira va bojxona faylidan hisoblandi.`
  (today's sentence, unchanged)
- `month` → `Bu oy AI uchun ajratilgan pul chegarasi tugadi — muhrlangan xotira va bojxona faylidan hisoblandi.`
- `off` → `AI o‘chirilgan (oylik chegara 0) — muhrlangan xotira va bojxona faylidan hisoblandi.`
- `model` → `AI modeli tanlanmagan yoki topilmadi — muhrlangan xotira va bojxona faylidan hisoblandi.`
- `refused` → `AI xavfsizlik filtri sababli bu tovarlarni ko‘rmadi — kodini VED qo‘yadi.`
- `month_mid` → `Hisob paytida AI oylik chegarasi tugadi — qolganini VED qo‘lda ko‘radi.`

### 2.3 The assistant (`AskOutcome`, K adds the statuses and BOTH maps; P5 produces them)

`AskOutcome['status']` gains `ceiling | off | refused | model_not_chosen |
model_unavailable | server_behind | truncated`; the `truncated` member carries the
partial answer (`{ status: 'truncated'; answer: string; … }`) — today a round cut by
`max_tokens` returns its text as an ordinary answer, and R5 keeps that text (he paid for
it) and adds one line. The bot's map (`staff-handlers.ts` `answerWithAssistant`) is
retyped `Record<Exclude<AskOutcome['status'], 'ok' | 'gave_up'>, string>` — today it is
`Record<string, string>` with a silent `?? replies.error`, which would read every new status
as «AI javob berolmadi». The web chat's ternary chain (`ai/chat.tsx:33-42`) becomes an
exhaustive map over the same union.

| Status | Bot (Uzbek, in code) | Web key `assistant.*` (uz) |
|---|---|---|
| `ceiling` | `Bu oy AI uchun ajratilgan pul tugadi — yordamchi oy oxirigacha ishlamaydi. Kod bilan qidiruv ishlayveradi (GS777, YW26-000123, CR-…).` | `ceiling`: `Bu oy AI uchun ajratilgan pul tugadi — yordamchi oy oxirigacha ishlamaydi.` |
| `off` | `AI o‘chirilgan (oylik chegara 0). Kod bilan qidiruv ishlayveradi (GS777, YW26-000123, CR-…).` | `off`: `AI o‘chirilgan (oylik chegara 0).` |
| `refused` | `AI bu savolga javob bermadi (xavfsizlik filtri). Savolni boshqacha yozib ko‘ring.` | `refused`: same |
| `model_not_chosen` | `AI modeli tanlanmagan — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin.` | `modelNotChosen`: same |
| `model_unavailable` | `Tanlangan AI modeli topilmadi — admin «Boshqaruv → AI: modellar va xarajat» sahifasida boshqasini tanlasin.` | `modelUnavailable`: same |
| `server_behind` | `Tizim yangilanmoqda — bir daqiqadan keyin qayta so‘rang.` | `serverBehind`: same |
| `truncated` | the partial answer, then a new line `✂️ Javob shu yerda kesildi — to‘liq javob uchun savolni toraytirib bering.` | `truncated`: the line, printed under the partial answer |

The bot's `not_configured` word stays «Topilmadi. Mijoz kodi…» (it runs after the free
lookup missed — round 100's reason).

### 2.4 The Telegram alarms (`platform/ai/alarms.ts`, P1) — pre-rendered

Five types, all in the new mute group `ai` (§6.5). `{spent}`, `{ceiling}` = `money(…)`;
`{pct}` = whole percent, rounded DOWN. **Every alarm ends with `${APP_URL}/admin/ai` on its
own last line** — the drain turns an own-origin last line into a «↗️ Ochish» button
(`notifications/staff-html.ts` `LINK_LINE`), so he gets one tap, not a menu path.

- `AiSpendLevel` 80 %:
  ```
  🤖 AI xarajati: bu oy {spent} sarflandi — {ceiling} chegaraning {pct} foizi.
  Chegaraga yetganda AI ishlari to‘xtaydi va qo‘lda qilinadi.
  {extraLines}
  {APP_URL}/admin/ai
  ```
- `AiSpendLevel` 100 %:
  ```
  🤖 AI xarajati bu oy {ceiling} chegaraga yetdi ({spent}).
  Oy oxirigacha AI ishlamaydi: so‘rovlar saqlanadi, VED qo‘lda hisoblaydi, yordamchi javob bermaydi.
  Chegarani shu sahifadan oshirish mumkin.
  {extraLines}
  {APP_URL}/admin/ai
  ```
  `{extraLines}` = zero to two lines, each only when true this month:
  `⚠️ {n} ta chaqiruvning narxi kiritilmagan — eng yuqori narx bilan taxminiy sanaldi.` and
  `ℹ️ {m} ta chaqiruv taxminiy hisoblangan (to‘xtatilgan yoki juda katta so‘rov).`
- `AiUnpriced` — once a Tashkent day while this month has calls whose model has no price
  (claim key `ai:unpriced`, detail = the Tashkent day):
  ```
  ⚠️ AI narxi kiritilmagan: bu oy {n} ta chaqiruvning dollardagi narxi noma’lum.
  {how}
  Narxni AI sahifasida yozing.
  {APP_URL}/admin/ai
  ```
  `{how}` = `Oylik {ceiling} chegara ularni eng yuqori kiritilgan narx bilan taxminiy sanayapti.`
  when any price exists, else `Hech qanday narx kiritilmagan — oylik {ceiling} chegara ularni sanay olmayapti.`
- `AiModelMissing` (⭐ of Question 2) — sent AFTER the fallback attempt, with its outcome;
  once a Tashkent day per tier and model (claim key `ai:model:<tier>`, detail
  `<YYYY-MM-DD>:<model>`):
  ```
  ⚠️ AI modeli topilmadi: «{displayName}» ({tierWord}) Anthropic’da yo‘q — eskirgan bo‘lishi mumkin.
  {fallbackLine}
  Yangisini AI sahifasida tanlang.
  {APP_URL}/admin/ai
  ```
  `{tierWord}` = `og‘ir ishlar` | `tez ishlar`; `{fallbackLine}` =
  `Zaxira model («{fallbackDisplayName}») o‘qidi — hozircha shunda ishlanmoqda.` (the
  fallback answered) | `Zaxira model («{fallbackDisplayName}») ham topilmadi — shu ishlar qo‘lda bajariladi.`
  (the fallback 404'd too) | `Zaxira model bu ishni qila olmadi — shu ishlar qo‘lda bajariladi.`
  (chosen but refused, unable, out of time or out of month) | `Zaxira model tanlanmagan — shu ishlar AIsiz, qo‘lda bajariladi.`
  `{displayName}` is the snapshot's display name, or the id when the snapshot has none
  (data, not source).
- `AiKeyRefused` — once a Tashkent day (claim key `ai:key`), when any call or the screen's
  list gets `auth`:
  ```
  ⚠️ Anthropic AI kalitini rad etdi — AI ishlari to‘xtadi.
  Yangi kalitni serverdagi .env fayliga (ANTHROPIC_API_KEY) qo‘ying va «app» ni qayta ishga tushiring.
  {APP_URL}/admin/ai
  ```
- `AiLedgerFailed` — once a Tashkent day (claim key `ai:ledger`), when `recordAiCall` could
  not write a row:
  ```
  ⚠️ AI chaqiruvlari xarajat hisobiga yozilmayapti — oylik chegara ularni sanamayapti.
  Xato: {code}. Dasturchiga ayting.
  {APP_URL}/admin/ai
  ```

### 2.5 The chat door (P4)

- Island, the one button keeps `calc.threadSendBtn` («VEDga yuborish»).
- Result `queued`, entity lead or deal → new key `calc.threadQueued`:
  `✅ Qabul qilindi — AI o‘qiyapti (odatda 3 daqiqagacha). So‘rov VED navbatiga va shu kartaga tushadi, javob Telegramda ham keladi.`
- Result `queued`, entity client → `calc.threadQueuedClient` (says only what is certain at
  the press — which card it lands on is decided in the job, and round 4 may send it to a
  new lead): `✅ Qabul qilindi — AI o‘qiyapti (odatda 3 daqiqagacha). So‘rov VED navbatiga tushadi, javob Telegramda ham keladi.`
- Result `landed` (no model was asked) → the existing `calc.threadSent` + link; when a
  failure is set, the REASON first — new `calc.threadAiReason.<member>` (§13.2, one key per
  member of `ThreadPressFailure` = `not_configured | model_not_chosen | server_behind |
  ceiling | off | budget | network`, the only failures the press itself can land with) —
  then the existing `calc.threadAiFailed` + the advice line (unchanged keys).
- Refusals at the press, as words (`calc.threadErrors.*`): `bad_note` (new: `Tanlov eskirgan —
  sahifani yangilang.`), `already_reading` (new: `Bu xabarlar hozir AI o‘qiyapti — tugashini kuting.`),
  `too_many_open` / `not_found` (the existing `calc.errors.*` sentences, prechecked).
- The card's pending line, while a reading of this card stands (server-rendered from
  `threadReadsPending`): `calc.threadPending` `🧮 AI o‘qiyapti — {time} da yuborilgan ({count} ta).`
- The landing note's machine line, when a request landed without a reading (intake.ts
  `intakeNoteText`, before the material block — BOTH doors, the bot and the chat):
  `⚠️ AI o‘qimadi: {AI_READ_FAILURE[f].text}`
- When the fallback served (⭐ Question 7), the same note gets, under its heading:
  `ℹ️ Asosiy AI xavfsizlik filtri sababli o‘qimadi — zaxira AI o‘qidi.`
- The job's words to the presser when it cannot land (Telegram, type `CalcPrefilled`, AND a
  lenta note on the card he pressed on — §9.3; not the note when the grant was revoked):
  - grant revoked / cannot log in: `🧮 Suhbatdan hisoblatish bajarilmadi: sizda endi bu kartaga ruxsat yo‘q.`
  - messages gone (purged): `🧮 Suhbatdan hisoblatish bajarilmadi: tanlangan xabarlar endi yo‘q (chat o‘chirilgan bo‘lishi mumkin).`
  - a `CalcError` at landing: `🧮 Suhbatdan hisoblatish bajarilmadi: {calc.errors.<code> in uz}`
    — read with next-intl's `createTranslator` over the imported `messages/uz.json`, exactly
    as `wms/reports/owner-summary-text.ts` does; a code with no uz sentence →
    `kutilmagan xato ({code})`, and a unit test pins that every `threadCalcSend` refusal
    code HAS one.
  - the job gave up for good (last attempt, any unexpected error): `🧮 Suhbatdan hisoblatish bajarilmadi (tizim xatosi) — qayta yuboring.`

### 2.6 The small doors' words (i18n ×4, K adds the keys, P2/P3 produce the codes)

| Key | uz |
|---|---|
| `calc.errors.ai_ceiling` | `Bu oy AI uchun pul chegarasi tugadi — guruhlarni qo‘lda tuzing.` |
| `calc.errors.ai_off` | `AI o‘chirilgan (oylik chegara 0) — guruhlarni qo‘lda tuzing.` |
| `calc.errors.ai_refused` | `AI bu tovarlarni guruhlashdan bosh tortdi (xavfsizlik filtri) — guruhlarni qo‘lda tuzing.` |
| `calc.errors.ai_model` | `AI modeli tanlanmagan yoki topilmadi — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin.` |
| `calc.errors.ai_claim_lost` | `AI taklifi to‘xtatildi — kimdir ✨ ni qayta bosdi. Natijani yangilang.` |
| `calc.proposeBusy` | `AI o‘ylayapti… (3 daqiqagacha)` |
| `calc.proposeSkipped` | `AI {done} / {total} tovarni ko‘rdi — qolganlari uchun ✨ ni qayta bosing.` |
| `tnved.aiCeiling` | `AI oylik chegarasi tugadi — kodni qo‘lda yozing.` |
| `tnved.aiOff` | `AI o‘chirilgan (oylik chegara 0) — kodni qo‘lda yozing.` |
| `tnved.aiRefused` | `AI bu tovarni ko‘rib chiqishdan bosh tortdi (xavfsizlik filtri) — kodni qo‘lda yozing.` |
| `tnved.aiModel` | `AI modeli tanlanmagan yoki topilmadi — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin.` |
| `tnved.suggestProgress` | `AI: {i} / {n}` |
| `tnved.suggestCapped` | `Bir bosishda {cap} ta — yana {left} ta qoldi, qayta bosing.` |
| `finance.priceHistoryAiError.ceiling` | `AI oylik chegarasi tugadi` |
| `finance.priceHistoryAiError.off` | `AI o‘chirilgan (oylik chegara 0)` |
| `finance.priceHistoryAiError.refused` | `AI bu tovardan bosh tortdi (xavfsizlik filtri)` |
| `finance.priceHistoryAiError.model` | `AI modeli tanlanmagan — adminga ayting` |
| `deals.importAiFailed` | `AI javob bermadi: har tovar alohida qator bo‘ldi, kodlar xotiradan.` |
| `deals.importAiCeiling` | `AI oylik chegarasi tugadi: har tovar alohida qator bo‘ldi, kodlar xotiradan.` |
| `deals.importAiOff` | `AI o‘chirilgan (oylik chegara 0): har tovar alohida qator bo‘ldi, kodlar xotiradan.` |
| `deals.importAiRefused` | `AI bu tovarlardan bosh tortdi (xavfsizlik filtri): har tovar alohida qator bo‘ldi.` |
| `deals.importAiModel` | `AI modeli tanlanmagan yoki topilmadi: har tovar alohida qator bo‘ldi.` |
| `deals.importAiPartial` | `AI {grouped} / {total} tovarni guruhladi — qolganini qo‘lda guruhlang.` |

ru / en / zh-CN for every key are in §13.2. `deals.importNoAi` stays and is now shown ONLY
for `ai_not_configured` (today it is printed for every `aiError`, which is the very
«AI mavjud emas» sentence his 2026-10-21 screenshot complained about).

### 2.7 The AI screen (`/admin/ai`, P1) — i18n namespace `aiModels` ×4

Full key table in §13.3. Its states, each a sentence (uz):

| State | Sentence |
|---|---|
| no key (`not_configured`) — the CI state | `Serverda ANTHROPIC_API_KEY yo‘q — AI o‘chiq. Kalit qo‘yilgach ro‘yxat chiqadi.` (saved picks shown read-only; no network call is made) |
| key refused (`auth`) | `Kalit ishlamayapti — Anthropic rad etdi. Yangi kalit kerak.` |
| unreachable / timeout | `Anthropic’ga ulanib bo‘lmadi — «🔄 Yangilash» ni bosing.` |
| busy (`rate_limited` / `overloaded`) | `Anthropic band — bir daqiqadan keyin «🔄 Yangilash».` |
| a saved model not in the live list | `⚠️ Anthropic ro‘yxatida yo‘q (eskirgan bo‘lishi mumkin) — boshqasini tanlang.` |
| the heavy tier with no model | `Tanlanmagan — bu ishlar AIsiz, qo‘lda bajariladi.` |
| the fast tier with no model, the heavy one set (⭐ Q9) | `Tanlanmagan — hozircha «Og‘ir ishlar» modelida ishlayapti (qimmatroq). Hodimlar yordamchisi uchun tez modelni tanlang.` |
| a picked model with no price | `⚠️ Narx kiritilmagan — xarajat taxminiy sanalmoqda.` |
| a pick made by the migration, not by a person | `Avtomatik: oxirgi ishlagan model. Tanlab saqlang — shunda fikrlash kuchi yuboriladi.` |
| the effort each tier's jobs will SEND (from the snapshot) | `🧠 Fikrlash kuchi: {list}` (e.g. «o‘qish va guruhlash — kuchli; Bojxona 🤖, admin yordamchisi — o‘rtacha; «📈» — yengil») |
| effort not sent (snapshot null, or the model reports no effort levels) | `⚠️ Fikrlash kuchi yuborilmaydi — Anthropic bu model haqida ma’lumot bermadi (yoki model hali saqlanmagan); model o‘z standart kuchida ishlaydi.` |
| capabilities unknown | `⚠️ Anthropic bu modelning imkoniyatlarini aytmadi — rasm/PDF o‘qishi tekshirilmagan.` |
| a model lacking a capability the tier needs | `Bu model rasm o‘qiy olmaydi — og‘ir ishlar uchun yaramaydi.` / `Bu model PDF o‘qiy olmaydi — og‘ir ishlar uchun yaramaydi.` / `Bu model tuzilgan javob bera olmaydi — og‘ir ishlar uchun yaramaydi.` (three whole sentences, the same keys as the save refusals) |
| calls the ledger could not record this month | `⚠️ {n} ta chaqiruv xarajat hisobiga yozilmadi — oxirgi xato: {code}.` |
| estimated rows this month | `ℹ️ {n} ta chaqiruv taxminiy hisoblangan (to‘xtatilgan yoki juda katta so‘rov).` |

---


## 3. The money: prices, the formula, the ceiling arithmetic

### 3.1 The price table (owner-typed data; the Models API carries no price)

`ai_model_prices`: one row per model id — `input_usd_mtok`, `output_usd_mtok` (dollars per
million tokens, both required, `> 0 AND < 1000 AND <> 'NaN'`), `cache_read_usd_mtok`
(optional; blank = 0.1 × input, an over-count, the safe side for a ceiling). The screen
draws ONLY the two required inputs: no call uses prompt caching this round, so a cache
field would be jargon he cannot fill that affects nothing (the column stays; its input is
drawn the round caching ships, §17).

- Typed on the AI screen beside each pick, and for any model in the live list or already
  in `ai_tiers` / the ledger (the comparison's candidates; a model whose price a stale
  list cannot confirm still takes a price — §6.3). No hand-typed ids.
- Parsed as a money figure by the platform's ONE reader of typed numbers
  (`platform/numbers/number-cell.ts` `readNumberCell`, moved down from `wms` in K0):
  «4,5» and «4.5» are 4.5; ONE comma followed by exactly three digits («2,500») is
  ambiguous and is ASKED, never guessed — the refusal `ambiguous_price` carries the
  cell's own question «2.5 dollarmi yoki 2500 dollarmi?» and the form keeps the typed
  values. Then `fitNumeric(v, 10, 4)` (`platform/numbers/fit-numeric.ts`) BEFORE `> 0`, so
  a per-TOKEN price typed by mistake (0.000004) is refused in words «1 million token
  uchun narx yozing» (`per_token_price`).
- **Output cheaper than input is refused** (`price_swapped`: «Chiqish narxi kirish
  narxidan arzon bo‘lmaydi — almashtirib yubormadingizmi?»): no Anthropic model prices
  output below input, and a swap would make the gate under-count every answer.
- **Before a write that moves the month** the form shows the effect: «Shu narx bilan bu
  oy: {X} (hozir {Y})», computed by `aiCostUsd` over this month's rows of that model; when
  the save alone takes the month past 80 % of the ceiling, the save asks for a second
  press (`confirm_needed` + the projection; the form re-posts with `confirm=1`).
- **A price CORRECTION re-prices this Tashkent month's rows of that model** (`repriceMonth`,
  §3.2), audited with the row count and the before/after sums, then `checkSpendLevel()`.
  Earlier months stay frozen — a closed month is a record, the open month is still being
  counted. This is what makes a typo (40 for 4, a dropped digit) correctable; without it
  a 10× price trips the ceiling at a tenth of the real spend for the rest of the month.

### 3.2 One call's dollars — ONE SQL home, frozen at write

```
cost_usd = round((
      input_tokens                               × in
    + (cache_write_tokens − cache_write_1h_tokens) × in × 1.25
    + cache_write_1h_tokens                       × in × 2
    + cache_read_tokens                           × coalesce(read, in × 0.1)
    + output_tokens                               × out          -- thinking is INSIDE output_tokens
  ) / 1 000 000, 6)
```
- `input_tokens` is the UNCACHED input (the SDK's own split). The two cache-write
  multipliers are Anthropic's published structure; the lead confirms them on the pricing
  page (header) before K (they are constants `AI_CACHE_WRITE_5M = 1.25`,
  `AI_CACHE_WRITE_1H = 2`, `AI_CACHE_READ_DEFAULT = 0.1`). No call uses prompt caching
  today, so every cache count is 0 on every row today; they are recorded anyway.
- Written by `INSERT … SELECT … ${aiCostSql(v, p)} FROM (VALUES …) v LEFT JOIN
  ai_model_prices pa ON pa.model = v.model LEFT JOIN ai_model_prices pr ON pr.model =
  v.requested_model`, the price being `pa`'s row when it exists, else `pr`'s (`CASE WHEN pa.model IS NOT
  NULL THEN pa.x ELSE pr.x END` per column — never a column-by-column coalesce, which would
  mix two models' cache prices) — every VALUES parameter CAST explicitly (`$n::int`, `$n::text`, `$n::boolean`,
  `$n::uuid`): postgres.js sends a JS number untyped (`node_modules/postgres/src/types.js`
  oid 0), so an untyped VALUES column resolves to `text` and the arithmetic fails —
  #156's family, for every row, silently (the writer swallows). NULL when neither model
  has a price. Postgres numeric is exact; JS never computes a stored dollar.
- **Two ids per row**: `model` = `response.model` (the model that ANSWERED, never a
  constant) and `requested_model` = the id the runner sent. The price is the answered
  model's, else the requested one's — so an id the API answers with that differs from the
  listed one the save priced (an alias resolved to a snapshot) is still priced.
- **Frozen**: a row is priced once, at the first moment a price exists for it — at write
  time; or by `fillUnpriced(tx, model)` inside the price save; or by `fillUnpricedAll()`
  (one `UPDATE … FROM ai_model_prices … WHERE cost_usd IS NULL`, the partial index
  `ai_calc_passes_unpriced_idx` makes it an index probe) at the start of every
  `checkSpendLevel()` — which heals the READ COMMITTED race in which a ledger INSERT that
  began before the price commit and committed after the save's fill would otherwise stay
  NULL for ever. The one exception is a CORRECTION of this month (§3.1):
  `repriceMonth(tx, model, monthStart)` re-prices this Tashkent month's rows of that model
  (the 09-25 answer R1's rule — a cost's dollars are frozen at their first conversion —
  still holds for every CLOSED month).
- The pure twin `aiCostUsd(usage, price): number | null` exists for the comparison script,
  the screen's projection and the save's preview. It computes in INTEGER micro-dollars
  (`BigInt` tokens × price × 10⁴, half-up to 10⁻⁶ — the way postgres rounds exact
  numeric), so a unit test pins it EQUAL to the SQL, not approximately, on 50 rows drawn
  from a SEEDED generator (the `v_client_balance_usd` equivalence precedent, 0080).
- **Estimated rows («taxminiy»)**, derived at read time (no column): a row whose
  `stop_reason` is `'aborted'` or `'stream_error'` (its output is the runner's safe upper
  estimate, §5 K5 step 6), or whose `input + cache_read + cache_write` tokens exceed
  200 000 (Anthropic's long-prompt pricing is not modelled; the row is under-counted, said
  so). The screen and the alarms count them.
- Not modelled, stated: a workspace geography premium, a long-prompt tier (marked as
  above), fast mode, priority tier (the app requests none). Each row stores
  `service_tier` and `inference_geo` raw so a later round can re-price.

### 3.3 The month and the ceiling

- Month = the Tashkent month:
  `created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'`
  (the day budget's own idiom, `ai-cost.ts:94`). Never a JS `Date` interpolated raw
  (#156). The month's LABEL is computed in the SAME statement
  (`to_char(now() AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM')`), never in JS — two clocks
  straddle the boundary.
- `aiMonthSpendSql()` is the one fragment (the gate, the 80/100 % claim and the screen
  read it). Per row of this month:
  - priced (`cost_usd` NOT NULL) → `cost_usd`;
  - NULL, and a price row exists NOW for `model` or `requested_model` → `aiCostSql(row, that
    price)` (counted as spent; the next `fillUnpricedAll` freezes it);
  - NULL, and no price for either → **estimated** at the HIGHEST typed prices (`max(input)`,
    `max(output)` over `ai_model_prices`) applied to the row's own tokens. Such a row is
    counted in `unpricedCalls` either way; when `ai_model_prices` is empty its estimate is 0
    (`noPriceAtAll`) — the ceiling cannot count it, and the daily reminder says so.
  ```ts
  export interface AiMonthSpend {
    month: string;               // 'YYYY-MM', Tashkent, from SQL
    spentUsd: number;            // priced + priced-now rows
    estimatedUsd: number;        // rows of a model with no price, at the highest typed price
    ceilingUsd: number;
    ceilingState: 'set' | 'off' | 'default';  // 'off' = 0 (⭐ Q3 a); 'default' = unreadable → 100
    pct: number | null;          // floor((spent + estimated) / ceiling × 100); null when off
    unpricedCalls: number;       // rows whose model has no price anywhere
    noPriceAtAll: boolean;       // ai_model_prices is empty
    estimatedCalls: number;      // §3.2's «taxminiy» rows + the estimated-price rows
  }
  ```
- `ceiling` = setting `ai_monthly_ceiling_usd` (default **100**). A finite number ≥ 0 is
  the ceiling; anything else (a hand-written jsonb string, NaN, a negative — the
  validator stops the screen from writing one, but a seed or a hand edit can) reads as
  the DEFAULT 100 with a `[ai-cost] ceiling unreadable` warning, never as Infinity (the
  day cap's «unreadable = no cap» rule fails OPEN and must not be copied onto money).
  ⭐ Question 3 a: 0 = off.
- Gate (`spendGateMonth`): ceiling 0 → `'off'`; `spent + estimated >= ceiling` →
  `'month'`; else `'ok'`. Then, for a door that has a day cap, the day cap (today's logic,
  moved).
- Warning: level = 100 when `pct >= 100`, 80 when `pct >= 80`, else 0. Announced on the way
  UP, once per Tashkent month per level; on the way DOWN (he raised the ceiling, or
  corrected a price) the stored level is lowered silently so the next crossing is
  announced again. Re-judged after EVERY event that moves the month or the ceiling: a
  ledger write, a price save or correction, a tier save, and a save of
  `ai_monthly_ceiling_usd` on /admin/settings (§5 K7) — otherwise a ceiling lowered under
  the month's spend closes every door with no message (no call reaches the ledger again).

### 3.4 Worked example (illustrative rates — the shape of the arithmetic, not a price list)

Take a heavy tier at $4 / $20 per MTok and a fast tier at $2 / $10.

| Call | Input | Output (thinking incl.) | Dollars |
|---|---|---|---|
| Bot reading, 2 photos + a PDF + a 40-line sheet | 30 000 | 12 000 | 0.12 + 0.24 = **$0.36** |
| Grouping, one batch of ≤ 200 goods | 6 000 | 10 000 | 0.024 + 0.20 = **$0.224** |
| Import pick, ≤ 40 rows | 8 000 | 4 000 | 0.032 + 0.08 = **$0.112** |
| **One full AI rastamojka job** | | | **≈ $0.70** |
| A refused reading + its fallback (fallback at $5 / $25) | 30 000 + 30 000 | 0 + 12 000 | 0.12 + (0.15 + 0.30) = **$0.57** |
| A reading the 150 s leash stopped after 120 s of streaming (estimate: 120 s × 200 tok/s = 24 000 out) | 30 000 | 24 000 (estimated) | 0.12 + 0.48 = **$0.60 taxminiy** |
| Staff assistant question, 3 rounds × (5 000 in, 1 000 out) on fast | | | 3 × 0.02 = **$0.06** |
| Admin data question, 4 rounds × (15 000 in, 3 000 out) on heavy | | | 4 × 0.12 = **$0.48** |
| Bojxona «🤖 hammasi», one press of 30 products × (3 000 in, 6 000 out) | | | 30 × 0.132 = **≈ $4** |

- $100 ≈ **140 full jobs a month** (≈ 4-5 a working day) BEFORE the assistant, ✨ presses,
  the 🤖 buttons and R2/R3's now-counted failed and abandoned readings. 80 % = $80 ≈ 114
  jobs. This matches the questions' own estimate (~$0.6-0.8 per job). **R0 (the
  measurement round of `docs/SAKKIZ-BAND.md` §10) has not been run**: the jobs-a-day figure
  below is an ASSUMPTION, to be replaced by the comparison's per-job dollars and the first
  month of the ledger. Say it to him in numbers (§19.2): if the bot brings ~10 jobs a day,
  the ceiling is reached around the 12th-15th of the month.
- **The soft overshoot, derived.** A call's dollars reach the ledger only when it returns,
  and the runner asks the month before EVERY request (primary, transient retry, fallback),
  so the overshoot is the set of requests IN FLIGHT at the instant the month crosses the
  ceiling: up to 4 bot readings (R3's workers) + 2 chat readings (P4's workers) + 1
  customs pass (one grouping batch or one pick) + the ✨ presses open at that moment (one
  per request being worked) + the deal imports being uploaded + the Bojxona and «📈»
  buttons being pressed + the assistant questions in flight (the bot's are dispatched off
  the poller, so one person can have several). Each worst heavy request ≈ 32 000 out ×
  $20/MTok ≈ $0.64, about $1.3 when it is a refusal followed by its fallback. In a busy
  minute that is **about $5-15** over the ceiling — stated as such, never claimed to be
  zero. A hard ceiling would need an in-process reservation of every in-flight worst case
  (all paid calls run in the one app process); it is NOT built (§17), because his 3.3 b
  asked for a ceiling that stops the work, not one that is exact to the cent.

---

## 4. The per-job profile (code: `platform/ai/profiles.ts`, written WHOLE in K)

Tiers are data (settings), jobs are code. A profile change is a review; a model change is
a press. The values below are the build defaults; the comparison (P6) measures latency,
output size and cost at them, and the lead adjusts a value in a one-line follow-up when
the measurement says so (§11.6).

```ts
// tiers.ts owns the vocabulary (no import cycle: profiles.ts imports these type-only):
export const AI_TIERS = ['heavy', 'fast'] as const;               // ⭐ Question 1 (b) adds a third
export type AiTier = (typeof AI_TIERS)[number];
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_ORDER: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export type AiNeed = 'images' | 'pdfs' | 'structured';

// profiles.ts:
import type { AiTier, AiEffort, AiNeed } from './tiers';
export type AiJob =
  | 'intake.read' | 'intake.thread' | 'grouping' | 'pick' | 'tnved' | 'similar'
  | 'assistant.staff' | 'assistant.admin';
export interface AiJobProfile {
  tier: AiTier;             // 'heavy' | 'fast'
  effort: AiEffort;         // ASKED; clamped to the model (§5 K5)
  maxTokens: number;        // ASKED; clamped to the model's own output cap
  leashMs: number;          // the WHOLE call incl. a retry and a fallback, unless the caller passes less
  needs: readonly AiNeed[]; // a model lacking one cannot serve this job (never a 400)
}
export const AI_JOBS: Readonly<Record<AiJob, AiJobProfile>>;
export const FALLBACK_FLOOR_MS = 30_000;  // under this much leash left, no fallback attempt
```

| Job | Site | Tier | effort | max_tokens | leash | needs | Why |
|---|---|---|---|---|---|---|---|
| `intake.read` | `analyzeIntake` from R3's `calc.intake-read` | heavy | `high` | 32 000 | **150 000** = `INTAKE_TIMEOUT_MS`, unchanged (R3's job passes less near its deadline) | images, pdfs, structured | his 3.1 a; photos + up to 3 PDFs + sheets; his 3.4 b is the seller's three minutes = files 30 s + model 150 s |
| `intake.thread` | `analyzeIntake` from P4's `calc.thread-read` | heavy | `high` | 32 000 | **120 000** | structured | the same reading on text (3.5 b «botdagidek»); material 10 + model 120 + landing 40 = 170 s ≤ the island's «3 daqiqagacha» (pinned, §9.3) |
| `grouping` | `proposeGoodsGrouping` (✨, prefill, deal import) | heavy | `high` | 32 000 | 240 000 per batch — the door's WALL caps it (✨ / deal import 180 s total; the prefill's deadline) | structured | ≤ 200 goods' JSON + thinking; 8192 today is R1's trap |
| `pick` | `pickImportRows` | heavy | `high` | 16 000 | 150 000 | structured | his 3.1 a; ≤ 40 rows of small JSON; 4096 today |
| `tnved` | `suggestTnved` (Bojxona 🤖) | heavy | `medium` | 16 000 | 90 000 | images, structured | one product + one photo; a VED waits at the button; 2048 today |
| `similar` | `pickSimilarLots` («📈» 🤖) | heavy | `low` | 8 000 | 60 000 | structured | ≤ 5 indexes among 60 short names; 1024 today (the likeliest of all to be cut) |
| `assistant.staff` | `realCallModel`, non-analyst | fast | `low` | 8 000 | 60 000 per round | — | his 3.6 a; chat + lookups |
| `assistant.admin` | `realCallModel`, analyst | heavy | `medium` | 16 000 | 120 000 per round | — | his 3.6 a; SQL over a 60-table card, money answers |

- The assistant's WALL clock per question: staff 120 000 ms (today, both surfaces); admin
  **180 000 ms in the bot** (inside his three minutes for a Telegram answer) and 240 000 ms
  on `/ai` (a person at a desk watching «O‘ylayapman…») — `assistant.ts`, P5. A round's
  leash = `min(profile.leashMs, wall − elapsed)`; under 10 s left the loop stops as
  `gave_up`.
- `similar` stays on heavy (today's model; a door he did not name does not change model),
  at `low` effort because its answer is five indexes.
- **`max_tokens` and the output rate limit.** These values are CEILINGS for thinking room,
  not targets — but Anthropic's rate limiter may reserve output tokens from `max_tokens`
  when a request STARTS. Before K, the lead reads Anthropic's rate-limits page (through
  the proxy, header) and records in the report whether output-tokens-per-minute is
  estimated from `max_tokens`. Either way: the runner logs each attempt's
  `anthropic-ratelimit-output-tokens-limit` / `-remaining` and `retry-after` response
  headers (§5 K5 step 14), the comparison prints each job's p99 output and the org's
  limits (§11.6), and after the comparison each job's `maxTokens` becomes measured p99 +
  50 % (never below today's value at that site), in the one-line follow-up. If a 429 storm
  appears after the deploy, that follow-up comes first.
- `AI_STREAM_OUT_TOK_PER_S = 200` (profiles.ts): the safe-side output rate used to ESTIMATE
  a started-but-unfinished stream's output (§5 K5 step 6) — deliberately above any
  measured model's real rate (the comparison prints the measured tokens/second per
  candidate; if one exceeds 200 the constant is raised in the follow-up).
- Never sent by any job: `thinking` (the newest tiers refuse turning it off; omitting it is
  adaptive), `temperature` / `top_p` / `top_k`, a forced `tool_choice`, an assistant
  prefill, the beta `fallbacks` parameter. A unit test asserts the runner's request body
  has none of these keys.

---

## 5. K — the lead's kernel commit (before any package; behaviour unchanged)

One commit, cut from `sakkiz-r5` once the start gate (header) holds. Gates: typecheck,
lint, the AI/calc/thread unit and integration suites green on a fresh `gsr_ci`. K is
behaviour-unchanged: the runner, the ledger, the gate and the tiers exist and are tested,
but no call site uses the runner yet; the wrappers and the widened types reproduce today
exactly. Every package branches from K. Write K's hash at the top of `docs/SAKKIZ-R5.md`.

### K0. The two number helpers move DOWN into `platform/numbers/`
- `src/modules/platform/numbers/number-cell.ts` ← the WHOLE of `wms/calc/number-cell.ts`
  (zero-import, pure); `wms/calc/number-cell.ts` becomes `export * from
  '@/modules/platform/numbers/number-cell';` so its ten importers do not churn.
- `src/modules/platform/numbers/fit-numeric.ts` ← `fitNumeric` from
  `wms/customs/import-parse.ts:264` (pure; it uses no import); `import-parse.ts` re-exports
  it. Reason: P1's price parser lives in `platform/ai/` and platform never imports wms.
- The existing `number-cell` / `import-parse` tests stay green unchanged (they import the
  wms path, which re-exports).

### K1. Migration `0137_ai_spend` + the drizzle schema
- The SQL is §12, verbatim. Journal entry with the next `when`. Drizzle:
  `platform/db/schema/platform.ts` gains `aiTiers`, `aiModelPrices`;
  `platform/db/schema/wms.ts` `aiCalcPasses` (≈ `:3823-3850` (R2)) gains the columns, the
  rewritten CHECKs and `staffId` `onDelete: 'set null'`; `calcRequests` gains `aiClaimId`.
- Probe it on a copy at R3's ledger: every existing row passes every new CHECK; the
  continuity INSERT copies the newest answering model into the HEAVY tier and leaves the
  fast tier NULL; a fresh database leaves both tiers with `model NULL`.

### K2. `src/modules/platform/ai/tiers.ts` (new)
```ts
// The vocabulary (one home — profiles.ts imports these type-only):
export const AI_TIERS = ['heavy', 'fast'] as const;               // ⭐ Question 1 (b) adds a third
export type AiTier = (typeof AI_TIERS)[number];
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_ORDER: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export type AiNeed = 'images' | 'pdfs' | 'structured';
/** What the screen saved about a model, from the live list at save time — stored as
 * exactly this object (camelCase keys) in `ai_tiers.model_info` / `fallback_info`.
 * null = unknown (never read as «false»: a null-capabilities answer must not make every
 * model unusable). A stored jsonb that does not parse into this shape reads as all-null. */
export interface ModelSnapshot {
  displayName: string | null;
  maxTokens: number | null;
  efforts: AiEffort[] | null;     // the levels the list says are supported; [] = none
  images: boolean | null;
  pdfs: boolean | null;
  structured: boolean | null;
}
export interface ModelChoice extends ModelSnapshot { id: string }
export interface TierPlan {
  tier: AiTier;
  primary: ModelChoice;
  fallback: ModelChoice | null;
  /** chosen_at IS NOT NULL — a person saved this tier (never derived from chosen_by,
   * which is SET NULL when that person is deleted). false = the migration's continuity pick. */
  chosenByPerson: boolean;
  /** true = the FAST tier is unchosen and this is the HEAVY tier's plan, lent (⭐ Question 9 a). */
  borrowed: boolean;
}
export type TierAnswer =
  | { ok: true; plan: TierPlan }
  | { ok: false; reason: 'model_not_chosen' | 'server_behind' };
/** Pool read of `ai_tiers`, cached 60 s per tier on globalThis (the bot and the pg-boss
 * workers run in the app process; a module-level `let` may be a different module instance
 * from the one the save action clears — db/ledger.ts's reason). TOTAL: 42P01/42703 and
 * every other error → `server_behind` (logged `[ai] tier read failed`), never a throw.
 * `tierPlan('fast')` with fast.model NULL and heavy.model set → the heavy plan with
 * `borrowed: true` (⭐ Q9 a; under 9 b → model_not_chosen). NEVER inside a db.transaction (#714). */
export async function tierPlan(tier: AiTier, now?: number): Promise<TierAnswer>;
/** The save action calls it so this process uses the new pick at once. */
export function forgetTierPlans(): void;
/** Pure: the snapshot's highest supported level ≤ asked; null when unknown or none. */
export function clampEffort(asked: AiEffort, efforts: AiEffort[] | null): AiEffort | null;
/** Pure: min(asked, the model's own output cap) — the cap only when known. */
export function clampMaxTokens(asked: number, cap: number | null): number;
/** Pure: false only when the snapshot SAYS the model lacks a need (null = unknown = usable). */
export function canServe(model: ModelSnapshot, needs: readonly AiNeed[]): boolean;
```

### K3. `src/modules/platform/ai/profiles.ts` (new, WHOLE — §4's table)
`AiJob`, `AiJobProfile`, `AI_JOBS`, `FALLBACK_FLOOR_MS`, `AI_STREAM_OUT_TOK_PER_S`. Written
once in K so no package edits it. `INTAKE_TIMEOUT_MS` stays exported from `intake-ai.ts`
at **150 000** (unchanged by this round); `AI_JOBS['intake.read'].leashMs` carries its own
`150_000` (`import { INTAKE_TIMEOUT_MS }` would make platform import wms — forbidden), and a
unit test pins `AI_JOBS['intake.read'].leashMs === INTAKE_TIMEOUT_MS` from the test side
(tests may import both) — GREEN in K, since neither value moves.

### K4. `src/modules/platform/ai/failure.ts` (new) — the SDK-error rule, MOVED
- `aiFailureOf` and `retryAfterPause` (+ `AI_ATTEMPTS = 2`, `AI_RETRY_PAUSE_MS = 2_000`)
  MOVED verbatim from `wms/calc/intake-ai.ts:178-213` (R2). `intake-ai.ts` re-exports them
  under the old names (`INTAKE_ATTEMPTS`, `INTAKE_RETRY_PAUSE_MS`, `aiFailureOf`,
  `retryAfterPause`) so `intake-round1.test.ts`, `intake-ai-wire.test.ts` and the corpus
  keep importing from where they do.
- **The pause honours the server.** `retryPauseMs(err): number` (new, beside them) = the
  error's `retry-after-ms` header, else `retry-after` (seconds), else
  `AI_RETRY_PAUSE_MS` — the SDK did exactly this before its one retry at the five sites
  that used `maxRetries: 1` (`node_modules/@anthropic-ai/sdk/client.js:736-745`), and the
  runner turns SDK retries off, so it must take the rule over. `retryAfterPause` gains the
  pause as an argument (default `AI_RETRY_PAUSE_MS`, so R1's callers and tests are
  unchanged): retry only when `leash − elapsed − pause ≥ leash / 2`.
- The union the runner speaks:
  ```ts
  export type AiCallFailure =
    | 'not_configured' | 'model_not_chosen' | 'server_behind' | 'ceiling' | 'off'
    | 'refused' | 'refused_fallback' | 'truncated' | 'timeout' | 'rate_limited'
    | 'overloaded' | 'auth' | 'rejected' | 'model_unavailable' | 'unreadable' | 'network';
  ```
  `AiReadFailure` (intake.ts) becomes `AiCallFailure | 'nothing_to_read' | 'budget'`.
- Two additions, both unreachable today (nothing streams; the id constants are served):
  1. **A mid-stream SSE error** arrives as a bare `APIError` with `status === undefined`
     (measured, frame in K10): before the generic `APIError → 'rejected'` line, read
     `err.error?.error?.type`: `overloaded_error` | `api_error` → `'overloaded'`,
     `rate_limit_error` → `'rate_limited'`, anything else → `'network'`. Today it would read
     «fayllarni boshqacha yuboring», no retry.
  2. `Anthropic.NotFoundError` (404 — a retired or mistyped model) → `'model_unavailable'`,
     before the generic `APIError` line. Today it reads «fayllarni boshqacha yuboring».
- Tested only with errors BUILT BY THE SDK (#1209): the stand-in returning the status /
  streaming the SSE `event: error`.

### K5. `src/modules/platform/ai/run.ts` (new) — THE runner, complete, used by nobody in K
```ts
export type AiPurpose = 'work' | 'compare';
/** What every model function takes as its optional last argument (inert in K, §K7). */
export interface AiRunOptions {
  plan?: TierPlan;                  // injected (tests, the comparison); else tierPlan(profile.tier)
  purpose?: AiPurpose;              // default 'work'
  effortOverride?: AiEffort;        // the comparison's extra columns ONLY (fence §11.6)
  signal?: AbortSignal;             // the caller's own stop (the deal import's request.signal)
}
export interface AiAttempt extends AiCallUsage {
  role: 'primary' | 'fallback';
  ms: number;
}
export type AiRun<T> =
  | { ok: true; value: T; attempts: AiAttempt[]; servedBy: 'primary' | 'fallback'; message: Anthropic.Message }
  | { ok: false; failure: AiCallFailure; attempts: AiAttempt[];
      /** The last message, when one arrived (refused / truncated / unreadable) — the
       * assistant shows a truncated answer's text (§10.3); nobody else reads it. */
      message?: Anthropic.Message };
export interface AiRunInput<T> extends AiRunOptions {
  job: AiJob;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** output_config.format — EXACTLY this shape. Never an SDK helper object that carries
   * `parse` (the SDK would parse inside the stream at message_stop and THROW on a refusal
   * or a cut JSON before stop_reason is read — the refusal would read as `network`). */
  format?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Called only on a message that is neither a refusal nor cut. A throw is caught → 'unreadable'. */
  read: (m: Anthropic.Message) => { ok: true; value: T } | { ok: false; failure: 'unreadable' };
  /** The caller's leash; default the profile's. The WHOLE call: retry and fallback included. */
  leashMs?: number;
  startOn?: 'primary' | 'fallback'; // the assistant's sticky fallback (§10)
}
export async function runModel<T>(input: AiRunInput<T>): Promise<AiRun<T>>;
/** The comparison's free dry run: `client.messages.countTokens` with the runner's client
 * options. Called only from `wms/calc/compare/` (fence §11.6). */
export async function countTokens(model: string, body: Omit<Anthropic.MessageCountTokensParams, 'model'>): Promise<number | null>;
```
**`runModel` never throws.** The whole body sits in one `try`; an unexpected throw anywhere
(a pool read, a jsonb parse, a logger) becomes `{ ok: false, failure: isServerBehind(err) ?
'server_behind' : 'network', attempts }` with every attempt made so far KEPT — a paid call
is never lost to an exception, and every model function keeps «a failure is a value».

The rule, in order (each step a named, tested branch):
0. `deadline = now + (input.leashMs ?? profile.leashMs)`; `left() = Math.floor(deadline −
   Date.now())` — an INTEGER, because `AbortSignal.timeout` throws `ERR_OUT_OF_RANGE` for a
   non-integer or negative delay (measured, Node 22). `left() < 1_000` before any request
   → `timeout`, no request.
1. `aiConfigured()` false → `not_configured`, NO request.
2. `plan = input.plan ?? await tierPlan(profile.tier)`; not ok → its reason (`tierPlan` is
   total).
3. **The budget of one call: at most ONE transient retry** (on whichever model is current)
   **and at most ONE model hop** (refusal or 404), **and never more than THREE requests in
   all.** Examples: [529 → retry → answer] = 2; [refusal → fallback 529 → retry] = 3 (the
   retry was unspent); [529 → retry → refusal] = 3 and the hop is NOT taken (it would be a
   fourth) → `refused`; [404 → fallback 529] with the retry unspent → 3. The attempt index
   passed to `retryAfterPause` is the CALL-wide count of requests made.
4. **Before EVERY request** (the first, the retry, the fallback), when `purpose === 'work'`:
   `spendGateMonth()` — `'off'` → failure `off`, `'month'` → failure `ceiling`, no request,
   the attempts so far kept. (The DOOR asked the whole `aiReady` before its paid
   preparation; the runner asks the month again right before each network request — two
   readers of one predicate, not two predicates.) `spendGateMonth` is total: a read that
   throws is logged and answers `'ok'` for that request (the day cap's fail-open stance; a
   stored value that is unreadable is NOT this case — it reads as the default 100, §3.3).
5. `model = startOn === 'fallback' && plan.fallback ? plan.fallback : plan.primary`.
   Request body: `model: model.id`, `max_tokens: clampMaxTokens(profile.maxTokens,
   model.maxTokens)`, `system`, `messages`, `tools?`, `output_config: { effort?:
   clampEffort(effortOverride ?? profile.effort, model.efforts), format? }` (`effort`
   omitted when the clamp is null). Never `thinking`, sampling, `tool_choice`, `fallbacks`,
   `betas`.
6. **Stream, under our own abort**: `const client = new Anthropic({ timeout: left(),
   maxRetries: 0 })`; `const stream = client.messages.stream(body, { signal:
   AbortSignal.any([AbortSignal.timeout(left()), ...(input.signal ? [input.signal] : [])]) })`;
   `stream.on('streamEvent', …)` records the `message_start` time and keeps the LAST
   `message_delta` event's `usage`; `const msg = await stream.finalMessage()`. The client
   `timeout` covers only the pre-header phase (measured: a stalled stream completes after
   its `timeout` without the signal); the signal is what bounds it. An abort surfaces as
   `APIUserAbortError` → `timeout` (or, when `input.signal` fired, `timeout` too — the
   caller knows it stopped). **A stream that had BEGUN** (`message_start` arrived) and then
   ended any other way than a final message — the abort, a mid-stream SSE `error`, a
   socket reset (the SDK wraps it as a bare `AnthropicError`), «stream ended without
   producing a Message» — is still a BILLED attempt: `stopReason` `'aborted'` (our signal)
   or `'stream_error'` (anything else), input from `message_start`, and `outputTokens` =
   `max(the snapshot's output_tokens, min(clamped max_tokens, ceil(seconds since
   message_start × AI_STREAM_OUT_TOK_PER_S)))` — a safe-side ESTIMATE (the snapshot keeps
   `message_start`'s ~1 output token until the final `message_delta`, measured in
   `MessageStream.js:448-468`, so the raw figure would bill a leash-stopped 30 000-token
   reading at ~$0). The row is «taxminiy» by its `stopReason` (§3.2).
7. **Transient failure** (`rate_limited` | `overloaded` | `network`, including a
   mid-stream one — that attempt RAN and is billed per step 6): one more request on the
   SAME model when the call's one retry is unspent and `retryAfterPause(failure, requests,
   elapsed, leash, retryPauseMs(err))` agrees. SDK retries are OFF everywhere (one retry
   rule, R1's, now honouring `retry-after`).
8. `msg.stop_reason === 'refusal'` — checked BEFORE any content is read — → the refusal
   branch: ONE fallback request when `purpose === 'work'`, `plan.fallback` is set, its id
   differs from the refused model's, `canServe(plan.fallback, profile.needs)`,
   `stop_details?.category !== 'reasoning_extraction'` (a property of OUR prompt, not of
   the goods — logged, never retried), the hop is unspent and the call has made ≤ 2
   requests, step 4's gate is `'ok'`, and `left() >= FALLBACK_FLOOR_MS`. The same body with
   the fallback's clamps, the remaining leash. Its refusal → `refused_fallback`; a
   transient failure may use the call's unspent retry (step 7); any other failure → that
   failure; no further hop, ever. Otherwise → `refused` (with `message`).
9. `'max_tokens'` or `'model_context_window_exceeded'` → `truncated` (with `message`).
   Never a fallback (the INPUT is the cause).
10. `NotFoundError` on the primary (⭐ Question 2 a) → the fallback exactly as step 8 (same
    conditions). AFTER that attempt (or after deciding none can be made):
    `void noteModelUnavailable(tier, { model, fallback, outcome })` — dispatched, its own
    `.catch`, never awaited inside the leash — with `outcome` =
    `'served' | 'fallback_missing' | 'fallback_failed' | 'no_fallback'` so the alarm's
    words are true (§2.4). A fallback's own 404 → `model_unavailable` and outcome
    `fallback_missing`. Under Question 2 b this step is just `model_unavailable` + the
    alarm with `no_fallback`.
11. `auth` (401/403) on any request → `void noteKeyRefused()` (dispatched, own catch),
    failure `auth`.
12. Otherwise `read(msg)` inside a `try`: a throw → `unreadable` (with `message`).
13. Every attempt that got a message OR had begun streaming → one `AiAttempt` =
    `usageOf(msg ?? snapshot, { tier, job, fallback: role === 'fallback', requestedModel:
    model.id, lastDelta, estimatedOutput })` + `{ role, ms }`, in the returned `attempts` —
    the refused one included (R2's rule: a call counts when the model answered it).
    `usageOf` merges the last `message_delta`'s `output_tokens_details.thinking_tokens`
    and `cache_creation` over the snapshot (the SDK's accumulator drops them — measured,
    `thinking_tokens` read null on every streamed call otherwise). The RUNNER NEVER
    WRITES THE LEDGER: the caller knows the anchor, and bills each attempt with `await`,
    each in its own `try`, right after the runner returns (R2's rule — bookkeeping never
    stands in front of the work). A derived fence (§14.1) pins that every `runModel(`
    caller in `src/` also bills or returns its attempts.
14. One log line per attempt: `logger.info({ job, tier, model, requested, role, stop,
    category, in, out, thinking, estimated, ms, rlOutLimit, rlOutRemaining, retryAfter },
    '[ai] model tokens')` — the three rate-limit fields read from `stream.response?.headers`
    (`anthropic-ratelimit-output-tokens-limit` / `-remaining`, `retry-after`); its own `try`.
- `purpose === 'compare'`: steps 4, 7 and the hops of 8 and 10 are SKIPPED — no gate, no
  retry, no fallback (the comparison must see each candidate's OWN refusals and transient
  failures, and its budget reserves exactly one request per cell, §11.5); steps 10's and
  11's alarms are not sent.

### K6. `src/modules/platform/ai/{ledger,ready,door,alarms}.ts` (new) + `wms/calc/ai-cost.ts` wrappers
```ts
// ledger.ts
export const AI_CALL_KINDS = ['intake', 'grouping', 'pick', 'invoice', 'similar', 'assistant', 'tnved', 'deal_import'] as const;
export type AiCallKind = (typeof AI_CALL_KINDS)[number];
/** One answered (or begun) call, as the SDK reported it. Extras OPTIONAL so today's three
 * literal shapes ({model, inputTokens, outputTokens}) still type-check (they default to 0/null). */
export interface AiCallUsage {
  model: string;                       // response.model — the model that ANSWERED, never a constant
  requestedModel?: string | null;      // the id the runner SENT (priced when `model` has no price)
  inputTokens: number;
  outputTokens: number;                // billed total, thinking included (estimated for a broken stream)
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number | null;      // the last message_delta's output_tokens_details?.thinking_tokens
  stopReason?: string | null;          // 'refusal' | 'max_tokens' | … | 'aborted' | 'stream_error'
  refusalCategory?: string | null;     // stop_details?.category
  tier?: AiTier | null;
  job?: AiJob | null;
  fallback?: boolean;
  serviceTier?: string | null;
  inferenceGeo?: string | null;
}
/** CLAMPS so a CHECK never drops a bill line: cacheWrite1h ≤ cacheWrite, thinking ≤ output,
 * every count ≥ 0 and integer. */
export function usageOf(m: Anthropic.Message, meta: {
  tier: AiTier; job: AiJob; fallback: boolean; requestedModel: string;
  lastDelta?: Anthropic.MessageDeltaUsage | null; estimatedOutput?: number | null;
}): AiCallUsage;
export type AiCallAnchor =
  | { kind: 'similar'; requestId: null }
  | { kind: 'intake'; requestId: string; intakeNoteId?: string | null }
  | { kind: 'intake'; requestId: null; intakeNoteId: string }
  | { kind: 'assistant'; questionId: string }
  | { kind: 'tnved'; lotId: string }
  | { kind: 'deal_import'; dealId: string }
  | { kind: 'grouping' | 'pick' | 'invoice'; requestId: string };
/** Never throws. INSERT with the frozen cost (aiCostSql over the two LEFT JOINs of
 * ai_model_prices, every VALUES parameter cast, §3.2); a failed write is logged
 * `[ai-cost] call not recorded` AND `void noteLedgerFailure(code)`; then
 * `await checkSpendLevel()` in its own try. */
export async function recordAiCall(anchor: AiCallAnchor & { staffId?: string | null }, usage: AiCallUsage): Promise<void>;
/** R3's attachIntakePasses, MOVED (the body unchanged). */
export async function attachIntakeCalls(noteId: string, requestId: string): Promise<number>;
/** Fill the rows that waited for this model's price (model OR requested_model). Takes the caller's tx. */
export async function fillUnpriced(tx: TxHandle, model: string): Promise<number>;
/** Every NULL row whose model (or requested model) now has a price — the race heal (§3.2). Pool. */
export async function fillUnpricedAll(): Promise<number>;
/** A price CORRECTION: this Tashkent month's rows of that model, re-priced. Takes the caller's tx. */
export async function repriceMonth(tx: TxHandle, model: string): Promise<{ rows: number; beforeUsd: number; afterUsd: number }>;
export const AI_CACHE_WRITE_5M = 1.25, AI_CACHE_WRITE_1H = 2, AI_CACHE_READ_DEFAULT = 0.1;
export function aiCostSql(row: { input: SQL; output: SQL; cacheWrite: SQL; cacheWrite1h: SQL; cacheRead: SQL },
  price: { input: SQL; output: SQL; cacheRead: SQL }): SQL;
/** Integer micro-dollars inside (BigInt), half-up — equal to aiCostSql, not approximately. */
export function aiCostUsd(u: AiCallUsage, p: { inputUsdMtok: number; outputUsdMtok: number; cacheReadUsdMtok: number | null } | null): number | null;
/** Kinds counted against the calc DAY cap — a POSITIVE list: a new door must not eat the
 * VED's Telegram day (0119's own argument, inverted). Bound with inArray / sql.join, never
 * a raw JS array in sql``. */
export const CALC_BUDGET_KINDS = ['intake', 'grouping', 'pick', 'invoice'] as const;
/** The one spend fragment (§3.3). `dbOrTx` so the claim can run it inside its statement. */
export function aiMonthSpendSql(): SQL;
export async function aiMonthSpend(dbOrTx?: DbOrTx): Promise<AiMonthSpend>;
/** TOTAL: a thrown read → 'ok' (logged). */
export async function spendGateMonth(): Promise<'ok' | 'month' | 'off'>;
```
```ts
// ready.ts — the ONE question every door asks before its paid step
export type AiReadiness = 'ok' | 'not_configured' | 'model_not_chosen' | 'server_behind' | 'month' | 'off' | 'day';
export async function aiReady(input: { tier: AiTier; dayCap: 'calc' | 'similar' | null }): Promise<AiReadiness>;
// order: aiConfigured() → tierPlan(tier) → spendGateMonth() → the day cap. TOTAL: every read
// it makes is total (tierPlan → server_behind; the month → 'ok' on a throw; the day cap → Infinity on a throw).
/** The day cap's ONE home — aiCalcBudgetLeft's body MOVED here (`similar` counts
 * `kind = 'similar'`, `calc` counts CALC_BUDGET_KINDS via inArray; a non-positive or
 * unreadable setting = Infinity, today's rule — a COUNT backstop, not money). */
export async function dayBudgetLeft(budget: 'calc' | 'similar'): Promise<number>;
```
```ts
// door.ts — who manages the AI (screen, saves, alarms, the /profile box). ⭐ Question 5.
export function mayManageAi(actor: { roles: readonly string[]; permissions: ReadonlySet<string> }): boolean; // super_admin ROLE && admin.settings.manage
export async function aiManagers(): Promise<string[]>;  // the same rule as user ids (usersWithRoles ∩ usersWithPermission), pool
```
```ts
// alarms.ts — INERT in K (P1 fills the bodies); every one never throws
export async function checkSpendLevel(): Promise<void>;                                   // K: {}
export type ModelGoneOutcome = 'served' | 'fallback_missing' | 'fallback_failed' | 'no_fallback';
export async function noteModelUnavailable(tier: AiTier, report: { model: string; fallback: string | null; outcome: ModelGoneOutcome }): Promise<void>; // K: {}
export async function noteKeyRefused(): Promise<void>;                                    // K: {}
export async function noteLedgerFailure(code: string): Promise<void>;                     // K: {}
export function nextSpendLevel(prev: number, pct: number | null): { level: 0 | 80 | 100; announce: boolean }; // pure, K: real
```
- `wms/calc/ai-cost.ts` becomes the wrapper module. **`recordAiPass` gets an EXACT new
  type**: `recordAiPass(input: AiPassAnchor & { staffId?: string | null } & AiCallUsage)`,
  with `AiPassAnchor` = R3's union widened by `{ kind: 'assistant'; questionId }`,
  `{ kind: 'tnved'; lotId }`, `{ kind: 'deal_import'; dealId }`, and the body forwarding
  EVERY `AiCallUsage` field to `recordAiCall` (a spread that reaches the row). Today's flat
  input type would silently DROP a spread usage's extra fields (measured: TypeScript does
  not excess-check spread members), so `fallback` / `stopReason` / `tier` / thinking would
  read NULL on every row. Every caller passes the WHOLE usage (`{ kind, requestId,
  staffId, ...usage }`) — named one by one in §7.1, §8 and §15.2, incl. R3's
  `runIntakeRead` step 5 (P2 edits it) — and a derived fence pins it (§14.1).
  `attachIntakePasses` = `attachIntakeCalls`; `aiCalcBudgetLeft(budget)` keeps its
  signature and DELEGATES to `dayBudgetLeft` — now counting `CALC_BUDGET_KINDS` (positive)
  for `'calc'`, behaviour-unchanged today because no other kind exists yet; re-exports
  `aiReady` (the collector's factory mocks of this module add one line each — §14.2, K10).
- The three copies of the usage shape become aliases: `AiUsage` (`wms/tnved/service.ts`
  ≈`:260`), `PickUsage` (`prefill-ai.ts:41`), `SimilarUsage` (`similar-ai.ts:36`) =
  `AiCallUsage`. Callers compile unchanged.

### K7. The words, the unions and the signatures every package consumes (frozen after K)
- `wms/calc/intake.ts`: `AiReadFailure` = `AiCallFailure | 'nothing_to_read' | 'budget'`;
  `AI_READ_FAILURE` gains §2.1's six sentences. `intakeNoteText` gains two OPTIONAL inputs
  (inert in K, nobody passes them): `aiFailure?: AiReadFailure | null` → the line
  `⚠️ AI o‘qimadi: …` before the material block; `fallbackServed?: boolean` → the
  `ℹ️ …zaxira AI o‘qidi.` line under the heading (§2.5). Export the two note markers as
  constants (`NOTE_AI_STEPS_MARK = '\nAI izohi:\n'`, `NOTE_MATERIAL_MARK =
  '\nSotuvchi yuborgani (asl matn):\n'`, today's literals at `intake.ts:778-779` (R2)) and
  use them in `intakeNoteText` — P6's `materialOfNote` reads them.
- **The usage shapes become ARRAYS** (a fallback means two attempts), mechanically, with
  today's one element:
  - `proposeGoodsGrouping` returns `TnvedGrouping & { usages: AiUsage[] }` (was
    `usage?`); `TnvedError` takes `usages: AiUsage[] = []` (was `usage?`), and its code
    union gains `'ai_ceiling' | 'ai_off' | 'ai_refused' | 'ai_model'`;
  - `suggestTnved` returns `TnvedSuggestion & { usages: AiUsage[] }`;
  - `PickOutcome = { answers; usages: PickUsage[]; refused?: boolean }` (was `usage`);
  - `pickSimilarLots(…)` returns `{ picks: SimilarPick[] | null; usages: SimilarUsage[];
    failure?: AiCallFailure }` — the `failure` frozen HERE, not added by P3;
    `opts.onUsage` is DELETED (R2 removed the same callback from the pick for the same
    reason: a `void` inside it could never make the ledger write finish);
  - `AiIntakeOutcome` gains `servedBy?: 'primary' | 'fallback'`.
  - Every reader updated mechanically in K: `proposeGroups` records each of `usages`
    (success and `err.usages`), `pickBazas` each of `usages`, the similar route each of
    `usages` (still `void` in K — P3 makes it `await`).
- **The inert run options (so P4 and P6 typecheck off K).** `analyzeIntake`'s input gains
  `job?: 'intake.read' | 'intake.thread'`; `analyzeIntake`, `proposeGoodsGrouping`,
  `pickImportRows`, `suggestTnved` and `pickSimilarLots` each gain a trailing optional
  `run?: AiRunOptions`. In K they are typed and IGNORED; P2/P3 wire them to `runModel`.
- `platform/ai/assistant.ts` `AskOutcome` gains §2.3's seven statuses (`truncated` carrying
  `answer`); the bot map in `staff-handlers.ts` `answerWithAssistant` (≈`:1960-1990` (R2))
  becomes the exhaustive `Record` with §2.3's words (the truncated entry prints the answer,
  then its line); the web `ai/chat.tsx:33-42` an exhaustive map over `assistant.*` keys.
  Nothing produces the new statuses in K.
- i18n: every key of §13 except `aiModels.*` (P1's) is added in K, ×4, at its anchor;
  `components/similar-ai-button.tsx` ERRORS gains `ceiling`/`off`/`refused`/`model`;
  `batches/[id]/tnved/tnved-editor.tsx`'s error words become one exhaustive map that names
  the four new `TnvedError` codes; `bitimlar/import-lines.tsx` maps EVERY `aiError` code
  to its own key (`ai_not_configured` → `importNoAi`, `ai_failed` → `importAiFailed`,
  `ai_off` → `importAiOff`, …) and prints `importAiPartial` when the response carries
  `aiPartial` (no route sends it in K). `calc.threadQueued` / `calc.threadQueuedClient` /
  `calc.threadAiReason.*` / `calc.threadPending` / `calc.threadErrors.bad_note` /
  `calc.threadErrors.already_reading` / `calc.proposeBusy` / `calc.proposeSkipped` /
  `tnved.suggestProgress` / `tnved.suggestCapped` are added (unused until P2-P4).
- **Settings.** `ai_monthly_ceiling_usd: 100` in `SETTING_DEFAULTS` (beside
  `ai_calc_daily_limit`, `settings/service.ts:115`), a `SETTING_VALIDATORS` entry and four
  descriptions (§13.1). **The refusal sentence per key**: the settings page
  (`admin/settings/page.tsx:57-62`) prints `settings.badValueFor.<key>` when that key
  exists, else today's `badValue` — whose text is a DATE sentence («sana … yozing; bo‘sh =
  o‘chiq»), wrong for money and wrong for `lead_assign_origins` too (fixed on the way); K
  adds `badValueFor.ai_monthly_ceiling_usd` and `badValueFor.lead_assign_origins` ×4.
  **The ceiling's save re-judges the month**: `updateSettingAction`
  (`admin/settings/actions.ts:18-62`) calls `checkSpendLevel()` after a successful save of
  `ai_monthly_ceiling_usd` (post-commit, own catch; inert in K, live once P1 fills it).

### K8. The thread job's skeleton (so P4 never touches `boss.ts`)
- `src/modules/wms/calc/thread-read.ts` (new): `JOB_CALC_THREAD_READ = 'calc.thread-read'`,
  `JOB_CALC_THREAD_SWEEP = 'calc.thread-read-sweep'`, `ThreadReadJob`, the constants of
  §9.3, `runThreadRead(data, retryCount)` = return (K), `sweepThreadReads()` = return (K),
  `threadReadsPending(entityId)` = `[]` (K), and `registerCalcThreadReadWorker(boss)` =
  `createQueue` + `THREAD_READ_WORKERS` × `boss.work(JOB_CALC_THREAD_READ, {
  includeMetadata: true, batchSize: 1 }, async (jobs) => { for (const job of jobs) await
  runThreadRead(job.data, job.retryCount ?? 0) })` — the `includeMetadata` shape of
  `wms/calc/jobs.ts:219-221`; without it `retryCount` is undefined and the last-attempt
  branch never fires — plus `createQueue(JOB_CALC_THREAD_SWEEP)`, `boss.schedule(
  JOB_CALC_THREAD_SWEEP, '*/10 * * * *')` and its `boss.work` → `sweepThreadReads`.
- `platform/jobs/boss.ts` `WORKER_REGISTRATIONS` (≈`:65-95`) gains
  `['calc-thread-read', async (b) => (await import('../../wms/calc/thread-read')).registerCalcThreadReadWorker(b)]`.

### K9. What P6 consumes (extractions, verbatim)
- `wms/calc/prefill-steps.ts` (R2): the «empty bazas → `PickRequest[]`» half of `pickBazas`
  extracted VERBATIM into `export async function pickRequestsFor(requestId: string):
  Promise<PickRequest[]>` (reads the pool, writes nothing); `pickBazas` calls it at the same
  spot. Behaviour identical.
- `platform/telegram/calc-files.ts` (R3): `reduceForModel` exported if R3 did not export it
  (no storage write — the comparison reduces in memory).

### K10. Tests K itself adds (the seams' own proofs) and the mechanical updates
- `tests/unit/helpers/anthropic-stand-in.ts` (new, ONE helper, built WHOLE in K —
  packages never edit it; a missing mode is a K follow-up commit): a local
  `http.createServer` on `ANTHROPIC_BASE_URL`, a per-request SCRIPT QUEUE (each request
  takes the next mode; the last repeats) and a request log (method, path, parsed body,
  time). Modes, with the frames they send (one `event: <name>\ndata: <json>\n\n` each):
  - `json-error(status, type, headers?)` on any path — body `{"type":"error","error":
    {"type":"<type>","message":"stand-in"}}` (e.g. 529 `overloaded_error`, 401
    `authentication_error`, 404 `not_found_error`, 429 `rate_limit_error` with
    `retry-after: 5`).
  - `sse-message(model, content, usage, stop, stopDetails?, deltaUsage?)` — `content` is
    any of `{type:'text',text}`, `{type:'thinking',thinking,signature}`,
    `{type:'tool_use',id,name,input}`. Frames: `message_start` `{"type":"message_start",
    "message":{"id":"m","type":"message","role":"assistant","model":"<model>","content":[],
    "stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":<in>,
    "output_tokens":1}}}`; per block `content_block_start` (`{"type":"content_block_start",
    "index":i,"content_block":{"type":"text","text":""}}` / `{"type":"thinking",
    "thinking":"","signature":""}` / the tool_use block with `"input":{}`),
    `content_block_delta` (`text_delta` / `thinking_delta` + `signature_delta` /
    `input_json_delta` with `partial_json`), `content_block_stop`; then `message_delta`
    `{"type":"message_delta","delta":{"stop_reason":"<stop>","stop_sequence":null,
    "stop_details":<stopDetails|absent>},"usage":{"output_tokens":<out>,
    "output_tokens_details":{"thinking_tokens":<n>}}}` — thinking tokens ONLY here, as the
    API sends them; then `message_stop` `{"type":"message_stop"}`.
  - `sse-refusal(model, category)` = `sse-message` with no blocks, stop `refusal`,
    `stopDetails` `{"type":"refusal","category":"<category>","explanation":null}`.
  - `sse-stall(afterStart)` — headers and `message_start` at once, then nothing (the
    connection held open).
  - `sse-error(type)` — `message_start`, then `event: error` `{"type":"error","error":
    {"type":"overloaded_error","message":"Overloaded"}}`, then the connection closes.
  - `hang` — accept the request, never send headers.
  - `models-pages(pages)` on `GET /v1/models` — each page `{"data":[ModelInfo…],
    "has_more":bool,"first_id":"…","last_id":"…"}`, the next page chosen by the
    `after_id` query parameter; a `ModelInfo` = `{"id","type":"model","display_name",
    "created_at","max_tokens","max_input_tokens","capabilities":null|{…}}`.
  The two measured SDK facts the modes exist to pin (SDK 0.114.0): a stalled stream
  COMPLETES after its client `timeout` when no signal is passed (the timeout bounds only
  the pre-header phase); a mid-stream `event: error` throws a bare `APIError` with
  `status === undefined` and the type at `err.error.error.type`. The scout probes that
  first measured them are not committed; the frames above are their content.
  `intake-ai-wire.test.ts`'s own JSON server stays (errors only) or moves onto it.
- `tests/unit/ai-run.test.ts` (new, stand-in): §14.1 items 1-14 with their red proofs.
- `tests/unit/ai-failure.test.ts` (new): the 404, the mid-stream SSE error and
  `retryPauseMs` on a 429 with `retry-after-ms` / `retry-after`, all SDK-built.
- `tests/unit/ai-tiers.test.ts` (pure): `clampEffort`, `clampMaxTokens`, `canServe`
  (null = usable), a malformed `model_info` → an all-null snapshot.
- `tests/integration/ai-ledger.integration.test.ts` (new): §14.1 items 15-27.
- **Staged fences** (each is GREEN in K and tightens later — §14.1):
  `ai-run-callers.test.ts` in K asserts the `runModel(` callers are a SUBSET of the
  allowed five and that `new Anthropic(` outside `platform/ai/` appears ONLY at today's
  five sites, listed by path (`intake-ai.ts`, `prefill-ai.ts`, `tnved/service.ts` ×2,
  `similar-ai.ts`; `model.ts` is inside platform/ai) — P2, P3 and P5 each DELETE their
  entries from that allowlist as they move the call; M replaces the subset with the exact
  list and the allowlist with `models-list.ts` + `run.ts` alone.
- **Mechanical updates in K** (behaviour unchanged, so they are safe in K and they keep
  P2 from fighting six files):
  - `tests/integration/ai-cost.integration.test.ts:115,151` write a neutral
    `'test-model-a'` instead of today's literal id; and its two oracle queries
    (`:141-150`, `:156-176`, `kind <> 'similar'`) are re-anchored on the POSITIVE list
    (`kind IN (…CALC_BUDGET_KINDS)` through `inArray` / `sql.join`) — otherwise an
    `'assistant'` / `'tnved'` / `'deal_import'` row another file wrote today in CI's one
    database enters the oracle and not the function: green alone, red in CI's order
    (#1377). **Red proof:** insert one `'assistant'` row for today first → the old oracle
    fails.
  - every `vi.mock('@/modules/wms/calc/ai-cost', …)` factory WITHOUT `importOriginal`
    gains `aiReady: async () => 'ok'` — on the R2 tree five: `intake-corpus.test.ts:35`,
    `intake-collector-r3.test.ts:16`, `intake-collector-r4.test.ts:18`,
    `intake-collected-goods.test.ts:12`, `totals-question.test.ts:18` — plus whatever R3
    added (its `tests/unit/helpers/calc-read-drive.ts` and every new collector file: find
    them by the grep, not by this list); `intake-usage.integration.test.ts:21-35` (which
    SPREADS the real module) overrides `aiReady: async () => 'ok'` in its spread. A new
    unit fence `tests/unit/ai-cost-mocks.test.ts` reads every test file and refuses an
    `ai-cost` factory mock that does not name `aiReady` (a vitest factory mock with a
    missing export THROWS on access). **Red proof:** drop it from one file.
  - every test that injected a pick / grouping / similar usage updated to the array
    shapes; `intake-round1.test.ts:97-105`'s hand-listed «every failure has a sentence»
    reads the union from the source instead (or lists the six new members).

---

## 6. P1 «Ekran» — the AI screen, prices, the spend warnings (3.2 a, 3.3 b)

### 6.1 Files OWNED
- New: `platform/ai/models-list.ts`, `platform/ai/tier-save.ts`, `platform/ai/prices.ts`,
  `platform/ai/spend-report.ts`; `app/(protected)/admin/ai/{page.tsx, actions.ts,
  errors.ts, tier-form.tsx, price-form.tsx, state-class.ts}`.
- Fills (K's inert bodies): `platform/ai/alarms.ts`.
- Edits: `platform/diagnostics/signals.ts` (the claim functions — the table's one
  writer), `platform/notifications/mutes.ts` (group `ai`), `app/(protected)/profile/page.tsx`
  + its mutes action (the `mute_ai` box), `app/(protected)/admin/hub-doors.ts` (the door),
  `messages/*.json` (`aiModels.*` only).
- Tests: §6.8.

### 6.2 The live list — `models-list.ts`
```ts
export interface ListedModel extends ModelSnapshot { id: string; createdAt: string }
export type ListState = 'not_configured' | 'auth' | 'timeout' | 'network' | 'rate_limited' | 'overloaded' | 'rejected';
export type ModelList = { ok: true; models: ListedModel[]; fetchedAt: string } | { ok: false; reason: ListState };
/** PURE: the SDK's ModelInfo → ListedModel; null capabilities → nulls, NEVER false. */
export function toListedModel(info: Anthropic.ModelInfo): ListedModel;
/** ONE AbortSignal.timeout(10_000) over the WHOLE pagination; maxRetries 0. */
export async function liveModels(opts?: { fresh?: boolean }): Promise<ModelList>;
/** The last ok list if it is ≤ 10 min old, else null (the saves' fallback, §6.3). */
export function cachedModels(): ListedModel[] | null;
```
- `aiConfigured()` first: no key → `not_configured` with ZERO requests (the CI state).
- `new Anthropic({ maxRetries: 0 })` (the round's one retry rule — no SDK retries
  anywhere) and ONE `AbortSignal.timeout(10_000)` passed to every page request, so a hang
  costs ten seconds in all, never ten per page; `for await (const m of
  client.models.list({ limit: 100 }, { signal }))` bounded at 5 pages (a list that never
  ends is a hang, round 97). Newest first (the API's own order).
- Cached on `globalThis`: an ok list 10 min, a failure **2 min** (a dead Anthropic must not
  re-hang every reload after 30 s); `fresh: true` bypasses (the save asks fresh first).
- **Failure → `ListState`**, through `aiFailureOf` (K4): `not_configured` / `auth` /
  `timeout` / `network` / `rate_limited` / `overloaded` → themselves; EVERYTHING else
  (`rejected`, `model_unavailable`, `unreadable`, `server_behind`, …) → `rejected`. An
  `auth` also dispatches `noteKeyRefused()` (§6.6).
- **`toListedModel`, field by field** (SDK 0.114.0, `resources/models.d.ts:54-150`):

  | Snapshot field | SDK path | Rule |
  |---|---|---|
  | `displayName` | `display_name` | as given |
  | `maxTokens` | `max_tokens` | as given; null stays null |
  | `images` | `capabilities?.image_input?.supported` | `capabilities` null → null |
  | `pdfs` | `capabilities?.pdf_input?.supported` | same |
  | `structured` | `capabilities?.structured_outputs?.supported` | same |
  | `efforts` | `capabilities?.effort` | null `capabilities` → null; `effort.supported === false` → `[]` (no effort is ever sent); else the levels of `EFFORT_ORDER` whose `effort.<level>?.supported` is true — `xhigh` is typed nullable: `null` → not offered (absent), never «unknown» |
  | `createdAt` | `created_at` | as given |
- The call path NEVER calls the Models API; only the screen, the saves and the comparison
  do.

### 6.3 Saving a tier — `tier-save.ts`
```ts
export type TierSaveRefusal =
  | 'forbidden' | 'bad_tier' | 'bad_price' | 'per_token_price' | 'ambiguous_price' | 'price_swapped'
  | 'not_listed' | 'list_unavailable' | 'lacks_images' | 'lacks_pdfs' | 'lacks_structured'
  | 'same_as_primary' | 'price_missing' | 'confirm_needed' | 'server_behind';
export async function saveTierChoice(
  input: { tier: AiTier; model: string; fallback: string | null;
           prices: Record<string, { input: string; output: string }>; confirm?: boolean },
  actor: Actor, ctx: AuditContext,
): Promise<{ ok: true } | { ok: false; refusal: TierSaveRefusal;
            question?: { decimalText: string; thousandsText: string };        // ambiguous_price
            projection?: { nowUsd: number; afterUsd: number; ceilingUsd: number } }>; // confirm_needed
```
In order:
1. `mayManageAi(actor)`; parse (`AI_TIERS`, ids non-empty).
2. **The list, without letting a stale list block a correction** (durability): an id
   EQUAL to the one already stored for that slot needs no list — it keeps its stored
   snapshot, and is refreshed from the list when the list answers; a NEW id needs
   `liveModels({ fresh: true })` ok and holding it, falling back to `cachedModels()` (≤ 10
   min) when the fresh read fails; neither → `list_unavailable`; a list that answers
   without it → `not_listed`. An id equal to the stored one that the list ANSWERS without
   → `not_listed` too (the form drew it as a ⚠ option, §6.4, so keeping a retired pick is
   an explicit choice the server refuses — never a silent swap).
3. For `heavy`, primary AND fallback must not have `images`/`pdfs`/`structured === false`
   (null = allowed, the screen shows ⚠).
4. `fallback !== model` (`same_as_primary`).
5. Each chosen model has a price row or a typed price (else `price_missing`). A typed
   price is read by `readNumberCell` (`platform/numbers`, K0): `ambiguous` →
   `ambiguous_price` with the cell's question; `bad` → `bad_price`; then
   `fitNumeric(v, 10, 4)` BEFORE `> 0` (`per_token_price` when the rounding zeroed it);
   `output < input` → `price_swapped`.
6. The projection (§3.1): when a typed price is NEW or CHANGED, `aiCostUsd` over this
   month's rows of that model gives the month after the save; when that crosses 80 % of
   the ceiling (and `confirm` is not set) → `confirm_needed` with the projection.
7. THEN one `db.transaction` (every read inside on `tx`, the list read BEFORE it): upsert
   `ai_tiers` (snapshots, `chosen_by`, `chosen_at`), upsert the typed prices, per newly
   priced model `fillUnpriced(tx, m)`, per CHANGED price `repriceMonth(tx, m)`, one audit
   row (`entity_type 'settings'`, `SETTINGS_AUDIT_ID`, before/after
   `{ ai_tier_<tier>: { model, fallback }, ai_price_<model>: {...}, ai_reprice_<model>: {
   rows, beforeUsd, afterUsd } }` — one history with the generic screen).
8. After commit: `forgetTierPlans()`, `await checkSpendLevel()` (a typed price can push
   the month past 80 % retroactively), `revalidatePath('/admin/ai')`. No pool read inside
   the transaction (#714).

`prices.ts` `setModelPrice(model, prices, actor, ctx, { confirm })` is the same price half
alone, for a model that is not (yet) a pick — the comparison's candidates — or to CORRECT
a price. Same parse, same refusals (minus the tier ones), same projection, same fill /
re-price, same audit, and the same `checkSpendLevel()` after commit. A model already in
`ai_tiers` or in the ledger takes a price with NO list at all (a list outage must never
block pricing the model the tiers already run on — deploy step 1, §18).

### 6.4 The screen — `/admin/ai`
- Gate: the page's own (#198) `mayManageAi(actor)` → else `redirect('/')`; every action
  `authorize('admin.settings.manage')` AND `mayManageAi` (pair-gate idiom). Hub door
  `{ href: '/admin/ai', label: 'aiModels.title', icon: 'sparkle', allow:
  ['admin.settings.manage'], roles: ['super_admin'] }` (the `/admin/xatolar` precedent,
  `hub-doors.ts:78-84`).
- Half-applied deploy: `isServerBehind` (42P01/42703) → the generic «Tizim yangilanmoqda»
  card (the `narx-kanali/page.tsx` precedent).
- Render order: the database first (the month, the saved picks, the prices), then the
  list's ONE bounded read (≤ 10 s, cached). No `loading.tsx` (#98) and no `<Suspense>`
  around anything that holds a form (#1242) — the bound is what keeps the page honest.
- Sections, in order:
  1. **Bu oy** — `aiMonthSpend()` + `aiMonthBreakdown()` (`spend-report.ts`, screen-only,
     grouped statements over `aiMonthSpendSql()`): a bar `Bu oy: $X / $100 (Y %)` (or
     `monthOff` when the ceiling is 0); `⚠ N ta chaqiruv narxsiz` with the models it
     names and whether they are estimated; `ℹ️ N ta taxminiy`; the ledger-failure line
     when `ai:ledger` has a row this month; Σ by kind (door) and by model; this month's
     refusals and fallbacks; a link to `/admin/settings#setting-ai_monthly_ceiling_usd`
     (the input carries that id, `settings/page.tsx:35-51`).
  2. **Og‘ir ishlar** and **Tez ishlar** — one card per tier: the current primary and
     fallback (display name · id in mono with `break-all` · date · badges 🖼 / 📄 / 🧠
     effort levels / max tokens · the states of §2.7, INCLUDING the effort line: what each
     of the tier's jobs will SEND from the snapshot, or the «yuborilmaydi» sentence); a
     form: two selects over the live list — each select ALWAYS renders the SAVED id as an
     option (marked ⚠ «ro‘yxatda yo‘q» when the list lacks it), so a form can never post a
     different id than the one the person sees; the heavy card filters out models the
     snapshot says lack images/PDF/structured output and marks unknown ones with the
     «imkoniyatlari tekshirilmagan» sentence; and for each chosen model with no price row
     the two price inputs (no cache input, §3.1). Fallback optional: «yo‘q — rad etilsa
     qo‘lda». The fast card, while unchosen and borrowing, says so (§2.7).
  3. **Narxlar** — every priced model (its two prices, editable — a correction shows the
     projection and the re-priced row count) and every model seen in this month's ledger
     with no price; a price form for any model in the live list (the comparison's
     candidates).
  4. «🔄 Yangilash» (the list, fresh).
- The tier selects and price inputs are plain POST forms; a refused save keeps every
  typed value (#377/#463: a form that can be refused holds its inputs — controlled
  inputs, or the refusal re-renders with the posted values); `ambiguous_price` shows the
  question with the two readings as buttons that re-post the chosen text; `confirm_needed`
  shows the projection and a second «Ha, saqlash» button that re-posts with `confirm=1`.
- State badges use a literal class map (`state-class.ts`, the `STAGE_CLASS` shape —
  Tailwind compiles only classes it can see).
- Measured at 360×800 and 1280×900; the document width equals the viewport at both (the
  model ids are long — `break-all` on the mono id, #400's rescale).

### 6.5 Who hears the alarms — the mute group
- `mutes.ts`: new group `ai: ['AiSpendLevel', 'AiModelMissing', 'AiUnpriced',
  'AiKeyRefused', 'AiLedgerFailed']`, `FOUNDERS.ai` the same five (born whole in this
  round — never added to `system`, whose «born whole» test pins its three, nor to `alerts`,
  muted for anyone holding its founders: the `debt` group's argument,
  `mutes.ts:233-241`).
- `/profile`: the `mute_ai` box drawn only for `mayManageAi(actor)`; a choice already made
  is re-posted hidden when not drawn (#171, the `debt` block `profile/page.tsx:342-355`);
  the «⚠ Telegram ulanmagan» line for a receiver with no linked chat (the `owner`
  precedent).

### 6.6 `alarms.ts` — the bodies (every one never throws: own `try`, logs)
- `checkSpendLevel()`: `await fillUnpricedAll()` (the race heal, §3.2) → read
  `aiManagers()` (pool) BEFORE the transaction → ONE transaction, every read on `tx`:
  `claimAiSpendLevel(tx)` (signals.ts) is ONE statement that computes the month's level
  INSIDE itself from `aiMonthSpendSql()` and the setting row, and either claims an UP step
  or lowers the stored level silently:
  ```sql
  WITH s   AS (<aiMonthSpendSql() + the ceiling: one row — month, pct (NULL when off), counts>),
       old AS (SELECT level, detail FROM system_signals WHERE key = 'ai:spend'),
       lvl AS (SELECT month, CASE WHEN pct >= 100 THEN 100 WHEN pct >= 80 THEN 80 ELSE 0 END AS level
                 FROM s WHERE pct IS NOT NULL),
       up  AS (INSERT INTO system_signals (key, level, detail)
               SELECT 'ai:spend', level, month FROM lvl
               ON CONFLICT (key) DO UPDATE
                  SET level = EXCLUDED.level, detail = EXCLUDED.detail, updated_at = now(),
                      since = CASE WHEN system_signals.detail IS DISTINCT FROM EXCLUDED.detail
                                   THEN now() ELSE system_signals.since END
                WHERE system_signals.detail IS DISTINCT FROM EXCLUDED.detail
                   OR system_signals.level <> EXCLUDED.level
               RETURNING level, detail)
  SELECT up.level, up.detail, old.level AS prev_level, old.detail AS prev_detail, s.*
    FROM up LEFT JOIN old ON true, s
  ```
  — `old` is read in the statement's own snapshot (before the upsert), so the caller
  learns `nextSpendLevel(prev, level)`: announce only when the level went UP within the
  month, or the month is new and the level > 0; a DOWN step is the silent lowering; no
  row returned = no change. `pct` null (ceiling 0 = off) → nothing. When it announces:
  `queueStaffTelegram(tx, { userIds, type: 'AiSpendLevel', text })` (§2.4, with the
  `{extraLines}` from the same statement's counts); commit; `kickTelegramDrain()`. Because
  the level is computed in the claiming statement, a worker that read 85 % before he raised
  the ceiling cannot announce a stale 80 % after another worker lowered the row. Then, in
  its own `try`: `noteUnpriced(spend)` (below). Two workers crossing 80 % in the same
  second → one message (the `claimReviewMonth` shape, `wms/calc/review.ts:29-42`). No
  other `system_signals` reader is disturbed: today's readers select `telegram:bot` and
  `disk:%` only.
- `noteUnpriced(spend)`: when `spend.unpricedCalls > 0`, claim key `ai:unpriced` with detail = the Tashkent DAY (`ON CONFLICT … WHERE detail IS
  DISTINCT FROM EXCLUDED.detail RETURNING key`) → `AiUnpriced` (§2.4, the `{how}` line by
  `noPriceAtAll`). Once a day while it is true — so the deploy-morning window in which the
  ceiling cannot count is SAID, not only drawn on a screen he must open.
- `noteModelUnavailable(tier, report)`: the same day-claim under key `ai:model:<tier>`,
  detail `<YYYY-MM-DD Tashkent>:<model>`; text §2.4 with `{fallbackLine}` chosen by
  `report.outcome` (the display names from the tier's snapshot).
- `noteKeyRefused()`: day-claim key `ai:key` → `AiKeyRefused`.
- `noteLedgerFailure(code)`: ONE upsert on key `ai:ledger` — `level` = this month's count
  of unrecorded calls (reset to 1 when the month in `detail` changes), `detail` =
  `<YYYY-MM-DD>:<code>` — RETURNING whether the DAY changed; when it did →
  `AiLedgerFailed`. The screen reads the count and the last code from the same row.

### 6.7 Settings
`ai_monthly_ceiling_usd` is K's (§13.1). The screen DISPLAYS it and links to
`/admin/settings#setting-ai_monthly_ceiling_usd` (one door edits it — the generic one, with
its validator, its own refusal sentence, and K's `checkSpendLevel()` after the save).
Stated: the admin ROLE can change the ceiling there, as it can every setting today; only
the super_admin picks models.

### 6.8 Tests (P1) — red proofs by string edit
1. `models-list.test.ts` (pure): `toListedModel` per §6.2's table — null capabilities →
   nulls; `effort.supported false` → `[]`; `xhigh: null` → absent; the three flags; the
   `aiFailureOf` → `ListState` map (an unlisted failure → `rejected`). **Red:** map null →
   false.
2. `models-list-wire.test.ts` (stand-in `models-pages`, `json-error`, `hang`): two pages
   via `after_id` → every id, newest first; 401 → `auth` (and `noteKeyRefused` called once);
   a `hang` on page 2 → `timeout` within ~10 s IN ALL; no key → `not_configured` with ZERO
   requests; a failure cached 2 min (injected clock). **Red:** drop the `aiConfigured()`
   guard → the stand-in logs a request.
3. `ai-tier-save.integration.test.ts` (stand-in list + real db): a not-listed new id →
   `not_listed`; same fallback → `same_as_primary`; heavy pick with `pdf_input: false` →
   `lacks_pdfs`; `'NaN'` / `0.000004` / `'2,500'` / output < input → `bad_price` /
   `per_token_price` / `ambiguous_price` (with the question) / `price_swapped`; no price →
   `price_missing`; a list outage with the stored id kept → saves (snapshot kept); a list
   that answers WITHOUT the stored primary and a post changing only the fallback →
   `not_listed`, row unchanged; a save whose projection crosses 80 % → `confirm_needed`,
   then saves with `confirm`; a good save → the row, the snapshot, `chosen_at` set, the
   audit row under `SETTINGS_AUDIT_ID`, the month's NULL rows of that model FILLED; a price
   correction (40 → 4) → this month's rows re-priced, last month's untouched, the audit
   carries the counts; the YW operator → `forbidden`. Every price row it types is on a
   PRIVATE model id, and `afterAll` deletes the price rows AND the ledger rows it filled
   or wrote (a leftover price is CONFIGURATION and moves the e2e's month, #183); the tier
   rows snapshotted and restored. **Red:** remove the list check → a not-listed id saves;
   **red:** drop `repriceMonth` → the corrected month keeps the 10× dollars.
4. `ai-spend-alarm.integration.test.ts`: two concurrent `checkSpendLevel()` after crossing
   80 % → exactly ONE `AiSpendLevel` row per recipient; 100 % → one more; a new month
   (detail mismatch) → one again; raising the ceiling → the level drops silently, and the
   next crossing is announced; a ceiling LOWERED below the spend through
   `updateSettingAction`'s hook → one 100 % row; a held-open «stale» worker (its own
   connection) cannot announce after the ceiling was raised (the level is computed in the
   statement); 50 rows of a model with no price and ceiling 1 → gate `'month'` once any
   price exists (the highest-price estimate), and exactly ONE `AiUnpriced` row per day;
   a ledger INSERT held open across a price save and committed after the fill → priced by
   the next `checkSpendLevel` (two connections). Rows priced on a PRIVATE test model id,
   deleted in `afterAll`; the ceiling set RELATIVE to the measured spend (the
   `ai-cost.integration.test.ts:140-153` way), the setting snapshotted once in `beforeAll`
   (#716). **Red:** drop the `WHERE` from the ON CONFLICT → two rows; **red:** sum a NULL
   row as 0 → the 50-row gate stays `'ok'`.
5. `notification-mutes.test.ts`: every literal `Record<MuteGroup, boolean>` gains `ai:`
   (typecheck names each); «the ai box alone silences all five». **Red:** put
   `AiSpendLevel` into `system` → red (and `kuzatuv.test.ts:350-360` red too).
6. `ai-models-i18n.test.ts`: every runtime-built `aiModels.error.*` / `list.state.*` /
   `kind.*` key exists ×4, anchored on the exported tuples (`errors.ts`, `ListState`,
   `AI_CALL_KINDS`, `TierSaveRefusal`) — the `price-channel-i18n.test.ts` shape (#163).
   **Red:** delete one uz key.
7. `admin-chrome.test.ts` / `workspaces.test.ts`: the door starts with `/admin/` and is in
   the `/admin` union — run, extend if their derivation needs the new door named.
8. e2e `m9zzzg-ai-sahifa.spec.ts` (the next free name after the tail): as the demo
   super_admin, `/admin/ai` renders the no-key sentence (CI has no key) and the month
   bar's SHAPE (`/^Bu oy: \$\d+\.\d{2} \/ \$100\.00/` — never the literal «$0.00»: CI's one
   database carries the vitest run's rows); as the YW operator, bounced.
   `m9zz-ish-joylari.desktop` stays green (the door is drawn only for the super_admin and
   answers 200).

---

## 7. P2 «Hisob» — the calc pass on the runner (3.1 a, 3.4 b, 3.7 a for the heavy work)

### 7.1 Files OWNED
- `wms/calc/intake-ai.ts`, `wms/calc/prefill-ai.ts`, `wms/tnved/service.ts` (BOTH
  `proposeGoodsGrouping` and `suggestTnved` — one file, one owner), `wms/calc/workspace.ts`
  (`proposeGroups`, `releaseAiClaim`, the heartbeat — nothing else),
  `wms/calc/prefill.ts`, `wms/calc/prefill-steps.ts`, `wms/calc/ai-reply.ts`,
  `wms/calc/jobs.ts` (the pin's comment only), `wms/calc/intake-land.ts` (the two note
  inputs' pass-through only), `platform/telegram/calc-intake.ts` (`analyzeCollected`'s
  gate and `readByFallback`), `platform/telegram/calc-read.ts` (R3's `runIntakeRead` step 5
  — the bill passes the WHOLE usage — and `settleAnalysis`'s copied fields), the one place
  R3 builds the landing input from the state (`landCollectedIntake` in `staff-bot.ts`, or
  R3's `landRequestHalf` caller — whichever R3 shipped).
- In `app/(protected)/hisoblash/actions.ts`: `proposeAction` ONLY (P4 owns the thread
  actions in the same file — the hunks are apart, and P2 is picked first).
- In `app/(protected)/hisoblash/[id]/items-table.tsx`: the ✨ button's busy text and the
  `skipped` notice only.
- Tests: §7.8.

### 7.2 `analyzeIntake` on the runner
- Signature kept; K already added `input.job?: 'intake.read' | 'intake.thread'` (default
  `intake.read`) and the trailing `run?: AiRunOptions`. Body: build the content exactly as
  today (`intakeContent`), then `runModel({ job, system: SYSTEM, messages: [{ role:
  'user', content }], format: { type: 'json_schema', schema: FACTS_JSON_SCHEMA }, leashMs:
  input.timeoutMs ?? AI_JOBS[job].leashMs, read, ...run })`. The SDK client and its retry
  loop leave the file (the runner owns both).
- `read` = `readIntakeResponse`, kept PURE and kept as the second fence for refusal and
  `max_tokens` (`intake-round1.test.ts:58-79` stays green); its input type gains an
  OPTIONAL `model?: string` (the runner always passes it; `intake-weight-basis.test.ts:91`
  and `intake-corpus.test.ts:1185` call it with today's shape) and its usage records
  `response.model` — never a constant (once a refusal falls back, the constant would bill
  the fallback's call at the primary's price).
- The outcome: `answered = run.attempts` (every attempt, the refused one included);
  `servedBy = run.servedBy`; a runner failure maps 1:1 onto `AiReadFailure` (the union
  contains every `AiCallFailure`).
- **`INTAKE_TIMEOUT_MS` stays 150 000** (R1's value). His 3.4 b is the seller's wait: files
  ≤ 30 s + the model ≤ 150 s = three minutes; the refusal fallback lives INSIDE the 150 s
  (no fallback with under 30 s left). The comment says so; `INTAKE_MAX_TOKENS` retires (the
  profile's 32 000).
- **For P6**: the `run` argument passes `plan` / `purpose` / `effortOverride` straight to
  `runModel`; production never passes them (the derived fence of §11.6).

### 7.3 The bot reading's gate — `analyzeCollected` (R3 shape `(state, files, { timeoutMs })`)
- Replace the day-budget read (`calc-intake.ts:1360-1366` (R2)) with
  `const ready = await aiReady({ tier: 'heavy', dayCap: 'calc' })` imported from
  `wms/calc/ai-cost` (the re-export; K already gave every factory mock an `aiReady`).
  Map: `day → 'budget'`, `month → 'ceiling'`, `off`, `model_not_chosen`,
  `not_configured`, `server_behind` → themselves; `ok` → `analyzeIntake(…)`. (`aiReady` is
  total, so today's `.catch(() => Infinity)` fail-open is preserved inside it.)
- **`readByFallback`**: set in `analyzeCollected` on the analysed state it returns —
  `true` when `outcome.servedBy === 'fallback'`, `undefined` otherwise (so the fixtures
  comparing states with `toEqual` do not shift) — AND added to `settleAnalysis`'s explicit
  list of fields copied from `analysed` (R3's moved copy in `calc-read.ts`; on the R2 tree
  `staff-handlers.ts:1910-1949`) — `settleAnalysis` never sees the outcome, so setting it
  there alone would lose it. Persisted with the state (R3's store keeps the jsonb).
- **The bot's landing passes BOTH note inputs** to `intakeNoteText`: `fallbackServed:
  state.readByFallback === true` and `aiFailure: state.aiFailure ?? null` (the state
  carries it — `calc-intake.ts:263`, set at `:1429`), so the commonest door's note says
  WHY it landed without a reading, like the chat door's. Under ⭐ Question 7 the seller's
  chat says nothing extra.

### 7.4 The bot reading's clock — R3's, UNCHANGED
- `INTAKE_TIMEOUT_MS` stays 150 000 and R3's `INTAKE_READ_EXPIRE_S` and its SUM pin
  (`10 + 30 + 150 + 70 + 30 = 290 ≤ 290`) stay exactly as R3 built them; `ANALYSIS_STALE_MS`
  does not move. R3's `calc-read-press.test.ts` stays green untouched — that is the
  evidence.
- The notice «⏳ AI o‘qiyapti… (3 daqiqagacha)» stays (R3's `pressAnalyse`) and is true.
- The fallback lives INSIDE the leash (K5 step 8), so the pin has no new term. If the
  comparison's p90 for `intake.read` exceeds 120 s (leaving the fallback < 30 s), the
  report says so and the lead ASKS him before raising either constant (§11.6) — the
  three minutes are his word.

### 7.5 The grouping (✨ and the prefill) — `proposeGroups` and `proposeGoodsGrouping`
- `proposeGoodsGrouping(goods, run?)`: `runModel({ job: 'grouping', …, format, ...run })`;
  returns `{ groups, usages: run.attempts }`; failures → `TnvedError(code, run.attempts)`
  with code `'ai_refused'` (refused / refused_fallback), `'ai_ceiling'` (ceiling),
  `'ai_off'` (off), `'ai_model'` (model_not_chosen / model_unavailable),
  `'ai_not_configured'`, else `'ai_failed'` (server_behind included — a deploy minute;
  «AI javob bermadi — keyinroq» is true advice). The `> 200` refusal stays (callers batch
  with `planBatches`).
- `suggestTnved(input, run?)`: `runModel({ job: 'tnved', … })`; returns `{ …suggestion,
  usages }`; the same failure codes; EVERY failure carries its `usages`. (P3 wires its
  DOOR.)
- `proposeGroups(requestId, ctx, opts)` — R3's `opts: { expectRev?, handsOff? }` gains
  `deadline?: number`:
  1. **Read the uncoded count FIRST** (today's query, no claim needed). Nothing uncoded →
     no gate at all: the pricing tail runs as today (a free operation must not be refused
     by the ceiling or a missing model).
  2. **Before the claim** (something to send): `aiReady({ tier: 'heavy', dayCap: null })` —
     a person's ✨ is never refused by the machine's day cap (it is counted, as today) →
     `'month'` → `CalcError('ai_ceiling')`; `'off'` → `CalcError('ai_off')`;
     `model_not_chosen` → `CalcError('ai_model')`; `not_configured` →
     `CalcError('ai_not_configured')`; `server_behind` → rethrow the route's own
     server-behind word. The prefill pass asked the whole gate already (§7.6); asking again
     is the same predicate.
  3. **The claim gets a TOKEN**: `const mine = randomUUID()`; the claim UPDATE (R3's, with
     `AND rev = $expect` when given) also sets `ai_claim_id = mine`.
  4. **A heartbeat before EVERY batch**: `UPDATE calc_requests SET ai_proposal_started_at =
     now() WHERE id = $id AND ai_claim_id = $mine RETURNING 1`; zero rows → the claim was
     healed by someone else → stand down BEFORE `applyProposal` with
     `CalcError('ai_claim_lost')` (the batches already answered are billed; nothing is
     applied). Never a timestamp comparison (µs in SQL vs ms in JS never match — the
     read-mark lesson).
  5. **Between batches, and as each batch's leash**: `opts.deadline` set → each batch runs
     with `leashMs = min(AI_JOBS.grouping.leashMs, deadline − now)`; under 30 s left → no
     NEW batch (the rest counted `failed`, returned as `skippedByDeadline: n` items);
     `spendGateMonth()` re-asked → `'month'` / `'off'` → stop, the rest counted `failed`,
     returned as `stoppedByCeiling: 'month' | 'off'`. The batches that ANSWERED before a
     deadline or a ceiling ARE applied (so pressing ✨ again continues with what is still
     uncoded); only a lost claim applies nothing.
  6. Each batch's attempts billed with `await recordAiPass({ kind: 'grouping', requestId,
     staffId, ...usage })` — the WHOLE usage, the success's `usages` and `err.usages`
     alike.
  7. All batches failed: every failure a refusal → `CalcError('ai_refused')`; stopped by
     the ceiling with nothing done → `CalcError('ai_ceiling' | 'ai_off')`; else today's
     `ai_failed`. The return value gains `refusedBatches`, `skippedByDeadline`,
     `stoppedByCeiling` (the prefill's reply reads them, §7.6).
  8. `releaseAiClaim(requestId, mine)`: `SET ai_proposal_started_at = NULL, ai_claim_id =
     NULL WHERE id = $1 AND ai_claim_id = $mine` — today's release is UNCONDITIONAL
     (`workspace.ts:3073-3078` (R2)), so a pass that outlived its claim cleared the claim of
     the press that healed it. Both release sites (before the pricing tail, and the
     `finally`) pass the token.
- **✨ has a wall** (it is a server action on the request path): `proposeAction` (P2,
  `hisoblash/actions.ts:805`) passes `deadline = Date.now() + ACTION_AI_WALL_MS`
  (`ACTION_AI_WALL_MS = 180_000`, exported from `workspace.ts`) and returns
  `{ ok: true, skipped }` when `skippedByDeadline > 0` (`ProposeFormState extends
  CalcFormState { skipped?: { done: number; total: number } }`); `items-table.tsx` prints
  `calc.proposeSkipped` and, while the press runs, `calc.proposeBusy` («AI o‘ylayapti… (3
  daqiqagacha)») beside the disabled ✨ (`calc-propose`, `:1869-1876`). Without the wall a
  1 000-goods request was 5 × 240 s of one HTTP request, the claim refusing the VED's
  own saves throughout.
- **The pins** (unit, `calc-ai-claim.test.ts`): `AI_CLAIM_STALE_MS >= AI_JOBS.grouping.leashMs
  + 60_000` (600 ≥ 300) and `ACTION_AI_WALL_MS + 60_000 <= AI_CLAIM_STALE_MS` (240 ≤ 600).
  The claim window stays 10 minutes; the heartbeat, not a longer window, carries a long
  proposal (a crashed pass must not brick the table for 30 minutes after a deploy).
  `calc-row-draft.test.ts:525-535` and `calc-phone.integration.test.ts:227-240` pin «10 / 11
  minutes» as literals — re-anchor on the constant (`AI_CLAIM_STALE_MS + 60_000`), reason
  recorded.

### 7.6 The customs pass — `aiPrefill` and its clock
- **The test seam stays two-sided** (`prefill.ts:265-267` (R2)): `deps.configured === true`
  means readiness `'ok'` WITHOUT calling `aiReady`; `deps.configured === false` means
  `'not_configured'`; a new `deps.ready?: AiReadiness` replaces the gate outright (for the
  ceiling / off / model cases). Only with neither seam: `const ready = await aiReady({
  tier: 'heavy', dayCap: 'calc' })`. (Without this, every R2 test that drives the AI half
  with `configured: true` and an injected `propose`/`pick` would hit the REAL gate —
  `not_configured` in CI, `model_not_chosen` on a fresh `gsr_ci` — and either go red or
  pass VACUOUSLY: calc-regroup's `.not.toContain(remembered)` over an empty `asked`.)
  `configured = ready === 'ok'`.
- **`aiStood`** (§2.2): from `ready` — `day` / `month` / `off` / `model` (for
  `model_not_chosen`); else from the pass itself — `proposeGroups`' thrown CalcError
  `ai_refused` → `refused`, `ai_ceiling` / `stoppedByCeiling 'month'` → `month_mid`,
  `ai_off` / `stoppedByCeiling 'off'` → `off`, `ai_model` → `model`; and the pick's
  `refused` (every pick request refused by both models) → `refused`. A thrown proposal
  stays logged as today AND now reaches the reply — a medicine invoice both models refused
  says so to the seller instead of a silent «⚠️ Kod topilmadi». `budgetSpent` retires.
  `deps.configured` short-circuits as above.
- **A reading the filter refused twice is not sent to the grouping model again**: when
  the request's attached `'intake'` ledger rows show the reading ended
  `refused_fallback` (a row with `stop_reason 'refusal'` AND `fallback` true and no served
  intake row — derived from the ledger, no new column), the prefill SKIPS the grouping's
  model step (the memory and the import file still run) and the reply's tail is
  `refused`. The VED's ✨ stays his free choice.
- Step 1 passes `deadline` into `proposeGroups` (R2 guarded the pick and the medians and
  NOT the grouping: `prefill.ts` (R2) checks `PASS_DEADLINE_MS` before the pick and the
  medians only — a long proposal overran `PASS_EXPIRE_S` and pg-boss would re-deliver a
  pass still running).
- The pick (`prefill-steps.ts` `pickBazas`): `pickImportRows` on the runner (`job:
  'pick'`), returning `{ answers, usages, refused? }`; each usage billed with `await
  recordAiPass({ kind: 'pick', requestId, staffId, ...usage })`.
- **The pin** (unit, beside R2's): `PASS_DEADLINE_MS + AI_JOBS.grouping.leashMs +
  PASS_TAIL_SLACK_MS ≤ PASS_EXPIRE_S·1000 − 60_000`, with `PASS_TAIL_SLACK_MS = 300_000`
  (new, exported from `prefill.ts`: the medians' budget, the saves and the reply) — 600 +
  240 + 300 = 1140 ≤ 1740. The deadline admits at most ONE step past it; the longest step is
  a grouping batch. `jobs.ts`'s comment on `PASS_EXPIRE_S` («each up to 2 × 60 s») is
  rewritten to cite the pin. **Red:** `PASS_EXPIRE_S = 1000` → red.

### 7.7 The reply's tail — `ai-reply.ts`
`budgetSpent?: boolean` → `aiStood?: AiStood | null`; §2.2's six lines, `day`'s text
unchanged. R2's `ai-reply.test.ts` re-anchored on the field (reason: renamed, one sentence
added each).

### 7.8 Tests (P2) — red proofs by string edit
Every unit file that runs a REAL model function now reaches the runner, so it mocks
`@/modules/platform/ai/tiers` (an injected plan, no fallback unless the case needs one)
AND `@/modules/platform/ai/ledger`'s `spendGateMonth` (→ `'ok'`) — otherwise the runner
touches Postgres from a unit run (failing, not skipping, when the container's Postgres is
down) and adds a cold pool connect to the timing pins (c0794 < 3000 ms, c0790
1900-3500 ms). The files: `intake-ai-wire.test.ts`, `intake-answered.test.ts`,
`intake-corpus.test.ts` (`realAnalyze`, `:687-718`, `:1113-1132`, `:1519-1542`). Integration
files that call a real door take the gate through ONE seam:
`vi.mock('@/modules/platform/ai/ready', async (orig) => ({ ...(await orig()), aiReady:
async () => 'ok' }))` (the `wms/calc/ai-cost` re-export follows the mock).
1. `intake-ai-wire.test.ts` (stand-in, extended): the body carries `model` FROM THE TIER,
   `output_config.effort: 'high'`, `max_tokens` 32 000 (clamped to a snapshot's 16 000 when
   the snapshot says so), no `thinking` key; a scripted `sse-refusal` then `sse-message` →
   two requests, the second naming the FALLBACK, `answered` holds two usages with two
   models, `servedBy 'fallback'`. **Red:** stamp `usage.model` with the plan's primary →
   the second usage's model is wrong.
2. Same file: `sse-stall` with `timeoutMs: 1500` → `timeout` at ≈ 1.5 s, the attempt carries
   `inputTokens`, `stopReason 'aborted'` and an ESTIMATED `outputTokens > 1`. **Red:** drop
   the `signal` → the call completes after the stall.
3. `intake-answered.test.ts` (R2's — named nowhere before; it breaks three ways): its
   stand-in moves to `sse-message` frames (a JSON 200 body cannot be read by a streaming
   client), `answered` is asserted with `toMatchObject` on the three original fields plus
   `role`/`fallback`, and the tier/gate mocks above. It is also the home of «a
   refused-then-served reading bills two attempts».
4. `intake-billing.integration.test.ts` (R3's, extended): a refused-then-served reading →
   TWO `'intake'` rows on the note anchor, two models, `fallback` true on the second,
   `stop_reason` 'refusal' on the first; after the landing both carry `request_id`; the
   note carries the ℹ️ line. **Red:** list `model` + tokens by hand in `runIntakeRead`'s
   `recordAiPass` (no spread) → `fallback` reads false.
5. `calc-read-press.test.ts` (R3's SUM pin) — green, UNTOUCHED (R5 does not move the clock).
6. `calc-ai-claim.integration.test.ts` (new): a foreign token holds the claim → our
   heartbeat returns 0 → `ai_claim_lost`, no `applyProposal`; our release leaves the
   foreign claim set; a deadline 1 s away → one batch applied, `skippedByDeadline` counts
   the rest; a fully coded request at the ceiling → the tail runs, no CalcError. **Red:**
   unconditional release → the foreign claim is cleared; **red:** gate before the uncoded
   count → the coded request is refused.
7. `calc-ai-claim.test.ts` (unit): both claim pins. **Red:** `AI_CLAIM_STALE_MS = 200_000`.
8. `calc-prefill.integration.test.ts` (R2's, 11 cases with `configured: true`): stays
   green through the two-sided seam; new cases with `deps.ready: 'month'` → §2.2's `month`
   line, no model call, the model-free half still ran; a proposal that throws
   `ai_refused` → the `refused` line; `stoppedByCeiling` → `month_mid`. **Red:** read
   `budgetSpent` instead → the day sentence is printed.
9. `calc-regroup.integration.test.ts:188-192`: assert `asked.length > 0` BEFORE its
   `.not.toContain(remembered)` fence (an empty `asked` must never pass it). **Red:** drop
   the seam's `configured === true → 'ok'` → `asked` is empty and the new assertion is red.
10. `customs-estimate.integration.test.ts` (9) (`:300`, `:441-452`): «no pick past the
    deadline» must fail for the DEADLINE, so the case sets `deps.configured: true` and
    asserts the pick spy saw zero calls BECAUSE `now > deadline` (a second case with the
    deadline far → one call). **Red:** remove the deadline check → the far-deadline twin
    passes and the near one goes red.
11. `calc-table.integration.test.ts:436-457` («the CLAIM heals on the same clock the lock
    does»): the gate mocked `'ok'` through the seam; `proposeGoodsGrouping` mocked to read
    `calc_requests.ai_claim_id` WHILE it runs; assert the first press under a live claim
    still answers `ai_running`, and after the 11-minute-old claim the press TOOK the claim
    (a new non-null token seen inside the mock) — a positive assertion, so a gate refusal
    can never pass for a heal. **Red:** make `aiClaimLive` ignore the age → the second half
    stays `ai_running`.
12. `grouping-count.integration.test.ts` (R2's, `:11-21` mocks `messages.create`, which a
    streaming runner never calls): moves onto K10's stand-in (`sse-refusal`,
    `sse-message` with stop `max_tokens`, `json-error`, `sse-stall`) with a mocked
    `tierPlan` (no fallback, so the counts stay one call each) and the gate seam; the
    refusal expectation re-anchored to `ai_refused` (reason recorded: R5 names the
    refusal); «no answer → no row» kept; the pick half moves to `usages: []` / `[u]`.
13. `proposal-wire.test.ts` (R2's, kept): the claim is released before the tail — now WITH
    the token.
14. Grouping: all batches refused (scripted refusal on both models) → `ai_refused` and one
    `'grouping'` row per attempt. **Red:** map refusal to `ai_failed`.
15. The pass pin (§7.6). **Red:** as stated.
16. `intake-weight-basis.test.ts:91`, `intake-corpus.test.ts:1185`: compile unchanged (the
    optional `model?`) — named so nobody «fixes» them.

---

## 8. P3 «Eshiklar» — the three small doors (metered, gated, worded)

### 8.1 Files OWNED
- `app/(protected)/batches/[id]/tnved/actions.ts`, `…/tnved-editor.tsx` (the loop only),
  `wms/finance/similar-ai.ts`, `app/api/pricing/similar/[lotId]/route.ts`,
  `app/api/deals/[id]/lines/import/route.ts`.
- Tests: §8.5.

### 8.2 The Bojxona tab's 🤖 — `suggestTnvedForLotAction` (`actions.ts:45-108` (R2))
- Order (the door before any spend, pinned by `batch-door-wire.test.ts:214-230` by source
  position — extend it): role, uuid, card door, lot, aboard (today's `:49-65`) → **`aiReady({
  tier: 'heavy', dayCap: null })`** (imported from `@/modules/platform/ai/ready` — the
  test seam, §7.8) → `month` → `{ ok: false, error: 'ai_ceiling' }`; `off` → `'ai_off'`;
  `model_not_chosen` → `'ai_model'`; `not_configured` → `'ai_not_configured'` → the photo
  read (`:67-95`) → `suggestTnved` → **bill each of `usages` (success) or `err.usages` of
  EVERY `TnvedError` (refused, truncated, unreadable — a call counts when the model
  answered) with `await recordAiPass({ kind: 'tnved', lotId, staffId: actor.id, ...usage
  })`** → return. The action's comment «the AI budget paid for it» (`:38-39`) becomes true.
- `tnved-editor.tsx` `suggestAllMissing` (≈`:108`): the loop STOPS at the first
  `ai_ceiling` / `ai_off` / `ai_model` (one sentence, not forty); it shows
  `tnved.suggestProgress` «AI: {i} / {n}» while it walks; and one press handles at most
  `TNVED_SUGGEST_ALL_CAP = 30` products (`tnved.suggestCapped` «Bir bosishda 30 ta — yana
  {left} ta qoldi, qayta bosing.») — a truck of a few hundred uncoded lots is otherwise
  ONE press worth ≈ $0.05-0.32 a lot on the heavy tier (§3.4: ≈ $4 per 30), which only the
  month gate would stop.

### 8.3 «📈 Oldingi narx» 🤖 — `pickSimilarLots` and its route
- `similar-ai.ts`: `runModel({ job: 'similar', …, format, ...run })`; returns `{ picks,
  usages, failure? }` (K froze the shape, failure included); refusal → `picks: null`,
  `failure` kept.
- Route (`route.ts`): `aiConfigured` (`:78`) + the day budget (`:79`) → ONE `aiReady({ tier:
  'heavy', dayCap: 'similar' })`: `not_configured` / `day` (→ `'budget'`) / `month` (→
  `'ceiling'`) / `off` (→ `'off'`) / `model_not_chosen` (→ `'model'`), BEFORE the free
  search and the claim (the `similar-ai.test.ts:99-115` position pin, re-anchored on
  `aiReady`). After the call each usage billed with `await recordAiPass({ kind: 'similar',
  requestId: null, ...usage })` (was `void` inside `onUsage`); `lot_similar_picks.model` =
  the model of the attempt that ANSWERED (data, not source; `route.ts:147`). `picks ===
  null` with failure `refused`/`refused_fallback` → `refuse('refused')`; other failures →
  `refuse('failed')`.
- **The pin** (unit, `similar-ai.test.ts`): `SIMILAR_CLAIM_STALE_MS >=
  AI_JOBS.similar.leashMs + 60_000` (`wms/finance/price-history.ts:663`, 10 min ≥ 120 s) —
  the «📈» claim guards its model call exactly as ✨'s does, and only ✨'s was pinned.

### 8.4 The deal goods import — `POST /api/deals/[id]/lines/import`
- Before the model: `aiReady({ tier: 'heavy', dayCap: null })` → its code
  (`ai_ceiling` / `ai_off` / `ai_model` / `ai_not_configured`); the file still parses and
  the grouping is manual (DEALS.md answer 6c, unchanged).
- **Batched, under ONE wall that includes the call in flight**: today the whole list
  (≤ 500, `MAX_GOODS_ROWS`) goes to ONE call that refuses > 200 → a silent `ai_failed`.
  Now `planBatches(goods.length)` (`wms/calc/grouping.ts`), batches SEQUENTIAL, each
  batch's `item_indexes` shifted by its offset before the groups are concatenated;
  `DEAL_IMPORT_AI_WALL_MS = 180_000` from the first batch, and each batch runs with
  `leashMs = min(AI_JOBS.grouping.leashMs, wall − elapsed)` — under 30 s left → no new
  batch; `spendGateMonth()` re-asked between batches; the route passes `run: { signal:
  request.signal }` so a closed browser or a reload STOPS the call in flight and no new
  batch starts (money is not spent after the person has gone). The worst case is three
  minutes behind the upload's spinner, stated to him (§19.2). Goods of a skipped or
  failed batch stay ungrouped (manual), and the response says so: `aiPartial: { grouped,
  total }` when some but not all goods were grouped.
- Each attempt billed `await recordAiPass({ kind: 'deal_import', dealId, staffId, ...usage
  })`.
- The response's `aiError` is now one of `ai_not_configured | ai_failed | ai_ceiling |
  ai_off | ai_refused | ai_model` (all worded by K's UI map).

### 8.5 Tests (P3)
1. `batch-door-wire.test.ts` (extended): `aiReady(` after the aboard check and BEFORE
   `getStorage().get`; `recordAiPass(` with `kind: 'tnved'` after `suggestTnved(`, in the
   success branch AND in the `TnvedError` branch without a code filter. **Red:** move the
   gate below the photo read.
2. `batch-door.integration.test.ts` (mocks `suggestTnved`, `:35-41`; extended): the gate
   through the seam (`vi.mock('@/modules/platform/ai/ready', …)` → `'ok'`), so «answers for
   a lot on the truck» (`:408-415`) still reaches the mock in CI; a suggestion writes one
   `'tnved'` row on the lot anchor; a refusal with usages writes it too; a TRUNCATED one
   writes it too; the gate answering `'month'` → `ai_ceiling`, NO model call, NO row.
   Its rows are deleted in `afterAll` (lot anchor) — they would otherwise sit in CI's one
   database for the day (§14.2, `ai-cost.integration`'s oracle).
3. `similar-ai.test.ts` (re-anchored): `aiReady(` before the pending claim; the record is
   `await`ed; the claim pin. **Red:** put back `void recordAiPass`.
4. `price-icons-matrix.integration.test.ts:134-155` (the anchor CHECK by raw INSERT in a
   rolled-back tx) extended to every new kind: `assistant` needs `question_id`, `tnved`
   `lot_id`, `deal_import` `deal_id`, each refused without its anchor and with a
   `request_id`.
5. `deal-import-ai.integration.test.ts` (new, `proposeGoodsGrouping` mocked, the gate
   seam): 450 goods → 3 batches, offsets applied (group of batch 2 names indexes 200-399),
   each batch billed; batch 2 refused → `aiPartial: { grouped: 250, total: 450 }`; a wall
   reached after batch 1 → batch 3 not called; an aborted `request.signal` → no further
   batch. **Red:** drop the offset → batch 2's groups name goods 0-199.
6. e2e `m9u-deal-money` stays green (the keyless manual path: `ai_not_configured` →
   `importNoAi`, the sentence it has always printed).

---

## 9. P4 «Suhbat» — the card's chat door as a queued pass (3.5 b, ⭐ Question 6 a)

### 9.1 Files OWNED
- `wms/calc/from-thread.ts`, `wms/calc/thread-read.ts` (fills K8's skeleton),
  `components/thread-calc.tsx`, the two server places that render `<ThreadCalc>`
  (`components/telegram-thread.tsx:180` and `app/(protected)/suhbatlar/[clientId]/page.tsx`
  — they pass `pending`), `app/(protected)/hisoblash/actions.ts` (the thread actions only;
  `proposeAction` is P2's, the rest untouched).
- Tests: §9.6.

### 9.2 The press — `threadCalcAccept` (replaces `threadCalcAnalyze` as the island's only call)
```ts
/** The gate, MOVED verbatim from actions.ts `threadCalcGate` (≈:932-946 (R2)) so the action
 * AND the job ask it (one rule, two askers — a revoked grant in the queue is honoured). */
export function threadCalcRefusal(actor: ThreadCalcActor, entity: ThreadCalcEntity, section: string):
  'forbidden' | 'deal_terms_only' | 'bad_section' | null;
/** What these functions actually read of an Actor — so the job can rebuild one without a session. */
export type ThreadCalcActor = Pick<Actor, 'id' | 'fullName' | 'roles' | 'permissions'>;
/** The only failures the PRESS can land with (each has `calc.threadAiReason.<member>` ×4). */
export type ThreadPressFailure =
  | 'not_configured' | 'model_not_chosen' | 'server_behind' | 'ceiling' | 'off' | 'budget' | 'network';
export type ThreadCalcAccepted =
  | { kind: 'queued'; entityKind: ThreadCalcEntity['kind'] }
  | { kind: 'landed'; target: { kind: 'deal' | 'lead'; id: string };
      aiFailure: ThreadPressFailure | null; aiAdvice: ThreadAiAdvice | null };
export async function threadCalcAccept(
  actor: ThreadCalcActor,
  input: { entity: ThreadCalcEntity; section: CalcSection; messageIds: string[]; noteId: string },
  ctx: AuditContext,
): Promise<ThreadCalcAccepted>;
/** `sha1(entity.id + ':' + sorted messageIds)` — the same selection is one reading. */
export function threadSelectionKey(entity: ThreadCalcEntity, messageIds: string[]): string;
```
In order:
1. `threadCalcRefusal` (the action asks it first and returns the code, as today).
2. `isUuidShaped(noteId)` else `CalcError('bad_note')` — worded by K's
   `calc.threadErrors.bad_note` ×4 («Tanlov eskirgan — sahifani yangilang.»);
   `calc-error-words.test.ts` derives every `new CalcError('…')` under `wms/calc` and
   demands that key.
3. `threadMaterial(actor, entity, messageIds)` — `empty` / `too_many` / `not_yours`
   answered at once, before anything is queued.
4. The note id is unused (no `crm_activities` row, no `calc_requests.note_id`) else
   `note_taken` (the island shows it as «already sent», not as an error).
5. **Prechecks of what the landing would refuse three minutes later** — the same cheap
   pool reads the service makes before its transaction (`service.ts:308-321`):
   `too_many_open` (20 open requests on the card) and `not_found` → refused at the press
   with the existing `calc.errors.*` sentences, as today. (The landing still checks; the
   precheck only stops a paid reading that could never land.)
6. **Already reading this selection?** `threadReadsPending(entity.id)` (`thread-read.ts`:
   `SELECT data->>'selectionKey', created_on FROM pgboss.job WHERE name =
   'calc.thread-read' AND state IN ('created','retry','active') AND data->'entity'->>'id'
   = $1`) holds this press's `threadSelectionKey` → `CalcError('already_reading')`
   («Bu xabarlar hozir AI o‘qiyapti — tugashini kuting.»). pg-boss 10.4.2's `singletonKey`
   enforces nothing on a standard-policy queue (`node_modules/pg-boss/src/plans.js:336-348`
   — its unique indexes exist only for the short/singleton/stately policies), so the
   lookup is ours; the race of two presses inside the same second by one seller is
   accepted, stated.
7. **Will a model read it?** `section === 'yolkira'` AND the typed reading
   (`parseManualFacts` over the text) already has from-city, to-city, kg AND m³ → no (R2's
   instant tariff answer must not wait for a reading it does not need). Every other
   yo‘lkira chat is READ like the other sections — today `threadCalcAnalyze` reads every
   section (`from-thread.ts:180-192`) and the bot reads yo‘lkira too (`intake-ai.ts:659`
   carries a yo‘lkira line), so skipping it always would lose the cities, kg and m³ that
   the manual parser misses and turn the tariff's answer into a refusal. Then `aiReady({
   tier: 'heavy', dayCap: 'calc' })`: anything but `ok` → land NOW with the typed reading:
   `facts = threadReadFacts({ text, bodies, section, outcome: { ok: false, failure } })`,
   `threadCalcSend(actor, { …, facts, steps: [], aiFailure: failure }, ctx)` →
   `{ kind: 'landed', … }` (the complete yo‘lkira passes `aiFailure: null` — it was never
   meant to be read). `failure` = `day → 'budget'`, `month → 'ceiling'`, the rest
   themselves.
8. Otherwise `await enqueue(JOB_CALC_THREAD_READ, { actorId, entity, section, messageIds,
   noteId, selectionKey }, { id: noteId, expireInSeconds: THREAD_READ_EXPIRE_S,
   retryLimit: THREAD_READ_RETRY })` (R3's `options.id`; pg-boss 10.4.2 inserts with
   `ON CONFLICT DO NOTHING`, so a double press of one island session enqueues nothing). An
   enqueue that throws → land now as in 7 with `aiFailure: 'network'` (a request is never
   lost because a queue was down — `queueCalcPrefill`'s own stance).
- The action `threadCalcSendAction` keeps its name and gate, calls `threadCalcAccept`, posts
  NO `facts`/`steps` from the browser (the browser no longer claims anything about the
  cargo), returns `{ ok: true, accepted }`, `revalidatePath('/hisoblash')` and the card's
  path (so the pending line appears at once). `threadCalcAnalyzeAction` is DELETED.

### 9.3 The job — `calc.thread-read` (`thread-read.ts`)
```ts
export interface ThreadReadJob {
  actorId: string; entity: ThreadCalcEntity; section: CalcSection;
  messageIds: string[]; noteId: string; selectionKey: string;
}
export const THREAD_READ_WORKERS = 2;
export const THREAD_READ_RETRY = 2;            // three attempts; the LAST never calls the model
export const THREAD_MATERIAL_BUDGET_MS = 10_000;
export const THREAD_LAND_RESERVE_MS = 40_000;  // the landing, its in-process retry, the bills
export const THREAD_STEP_SLACK_MS = 30_000;
export const THREAD_READ_EXPIRE_S = 240;
export const THREAD_PROMISE_MS = 180_000;      // the island's «odatda 3 daqiqagacha»
```
**The pins** (unit `thread-read-sum.test.ts`): `THREAD_MATERIAL_BUDGET_MS +
AI_JOBS['intake.thread'].leashMs + THREAD_LAND_RESERVE_MS + THREAD_STEP_SLACK_MS ≤
THREAD_READ_EXPIRE_S·1000 − 10_000` (10 + 120 + 40 + 30 = 200 ≤ 230) AND
`THREAD_MATERIAL_BUDGET_MS + AI_JOBS['intake.thread'].leashMs + THREAD_LAND_RESERVE_MS ≤
THREAD_PROMISE_MS` (170 ≤ 180 — the words the seller reads are true when the queue is
idle; «odatda» covers a deploy, which can add the expiry plus pg-boss's 120 s maintenance
tick), with `THREAD_READ_WORKERS` pinned beside them. Its own queue: not R3's
`calc.intake-read` (whose handler is the bot collection's), not `calc.prefill` (a
ten-minute customs pass would hold a seller's reading).

`runThreadRead(data, retryCount)` — the worker wrapper (K8) calls it inside a `try`; on the
LAST attempt (`retryCount >= THREAD_READ_RETRY`) ANY throw is caught, the presser is told
(`tellPresser`, below, «tizim xatosi — qayta yuboring») and nothing is rethrown — a request
the island called «Qabul qilindi» is never dropped in silence (R3's last-attempt shape):
1. **Already landed?** `calc_requests WHERE note_id = noteId` → `queueCalcPrefill({ requestId,
   staffId: actorId, section })` (R3's atomic ticket makes it a no-op when a pass stands),
   `attachIntakePasses(noteId, requestId)`, return. Covers a death between the landing's
   commit and the job's end.
2. `actor = await threadActorFor(actorId)` — the `users` row + `actorGrants(actorId)`
   (`rbac/authorize.ts:114`, the «actor without a session» the bot and the evening summary
   use); cannot log in (`canLogIn`) or `threadCalcRefusal(…) !== null` → words to the
   presser (§2.5, Telegram ONLY — he may no longer see the card), return, no retry.
3. `material = await threadMaterial(actor, …)` — `not_yours` (purged / rehomed since) →
   `tellPresser`, return.
4. The outcome:
   - `retryCount >= THREAD_READ_RETRY` → NO model: `{ ok: false, failure: 'timeout' }` (a
     job that keeps dying inside the model call still lands; never lost);
   - else `aiReady({ tier: 'heavy', dayCap: 'calc' })` AGAIN (the month may have run out in
     the queue) → a failure as in §9.2.7;
   - else `analyzeIntake({ job: 'intake.thread', section, text: material.lines.join('\n'),
     fileCount, timeoutMs: leash })`, `leash = min(AI_JOBS['intake.thread'].leashMs,
     deadline − now − THREAD_LAND_RESERVE_MS)`, `deadline = start + THREAD_READ_EXPIRE_S·1000
     − 10_000`; under 30 s left → `timeout` without a call (R3's rule).
5. **Bill at answer time**: each of `outcome.answered` → `await recordAiPass({ kind:
   'intake', requestId: null, intakeNoteId: noteId, staffId: actorId, ...usage })`, each in
   its own `try`. The day cap and the month count it from this moment.
6. `facts = threadReadFacts({ text, bodies: material.bodies.join('\n'), section, outcome })`.
7. **Land, with an in-process retry**: `landed = await threadCalcSend(actor, { entity,
   section, messageIds, noteId, facts, steps: ai?.steps ?? [], aiFailure: outcome.ok ? null :
   outcome.failure, fallbackServed: outcome.servedBy === 'fallback' }, { actorId, ip: null,
   userAgent: null })`; a NON-`CalcError` throw (a database blip) is retried in-process
   ONCE after 2 s, inside `THREAD_LAND_RESERVE_MS` — the reading is already paid for, and a
   pg-boss redelivery would read it AGAIN with the model (R3 stores its reply for the same
   reason):
   - `CalcError('note_taken')` → a duplicate run won → step 1's branch;
   - any other `CalcError` (`too_many_open`, `not_found`, `too_many_items`, …) →
     `tellPresser` with the uz sentence (§2.5), return (a refusal is not retried: each
     retry would re-read with the model);
   - a non-`CalcError` throw on the second try → rethrow (pg-boss redelivers; step 1 finds
     a committed landing; on the last attempt the wrapper's catch tells the presser). The
     second paid reading of a redelivery after a failed landing is STATED (§19.2), not
     prevented.
8. `attachIntakePasses(noteId, landed.requestId).catch(log)`.
9. Nothing else: `threadCalcSend` queued the prefill, whose `sayOnce` reply reaches the
   seller's Telegram and whose lenta copy reaches the card (`ChatPulse`'s 120 s floor
   redraws an open card — no new polling code).
- **`tellPresser(data, text, { note })`**: `notifyStaffTelegram({ userIds: [actorId], type:
  'CalcPrefilled', text })` AND (when `note`) one lenta note on the card he pressed on,
  written with a deterministic id `uuidv5(noteId, THREAD_FAIL_NS)` and `ON CONFLICT (id) DO
  NOTHING RETURNING id` through the module the landing's own pre-minted note uses (#180 —
  find which writer accepts a pre-minted id on the merged tree); the Telegram message is
  sent only by the caller whose INSERT returned the row, so a redelivery or the sweep never
  says it twice. The note is what reaches a seller with no linked staff chat or who muted
  «Ish jarayoni» (`CalcPrefilled`'s group) — both stated.
- **The sweep** `sweepThreadReads()` (K8's 10-minute schedule): failed `calc.thread-read`
  jobs (`pgboss.job WHERE name = 'calc.thread-read' AND state = 'failed'` — pg-boss 10.4.2
  keeps a failed job there 12 h before archiving it, `src/attorney.js:199`, and the app
  sets no other interval) whose `noteId` has no `calc_requests` row → `tellPresser(…,
  «tizim xatosi — qayta yuboring», { note: true })`; the note's ON CONFLICT makes the
  repeated sightings say it once. This is the one path no catch reaches: an attempt
  killed by its expiry (a deploy, an OOM) on the LAST attempt fails in pg-boss's
  maintenance without any handler running.
- No `revalidatePath` from the worker (no request context).
- Redelivery cost, stated: a process killed inside the model call re-reads on the next
  attempt; Anthropic bills both, the ledger bills the attempt that answered or had begun
  streaming (§0.1.6) — a killed process writes no row for its own.

### 9.4 The pure merge and the send
- `threadReadFacts(input: { text; bodies; section; outcome: AiIntakeOutcome }): CalcFacts` —
  the body of R2's `threadCalcAnalyze` from `parseManualFacts` to the `facts` object
  (`from-thread.ts:184-212` (R2)) MOVED VERBATIM (manual wins; an ambiguous total stays
  blank; `typedGoods = readGoodsLines(bodies, { labelledOnly: ai !== null })`;
  `goods: ai?.facts.goods?.length ? ai.facts.goods : typedGoods`), so the corpus pins move by
  PATH only. `threadCalcAnalyze` and `ThreadCalcPreview` are deleted; `threadAiAdvice`
  stays.
- `threadCalcSend`: `actor: Actor` → `ThreadCalcActor`; `input.aiFailure?` and
  `input.fallbackServed?` → `intakeNoteText` (K7); returns `{ kind, id, queued, requestId }`
  (the job needs it). Round 4's client path (`dealFor`, ≈`:330` (R2)) is NOT touched — §15.3.

### 9.5 The island — `thread-calc.tsx`
- Press 1 («O‘qish»), the preview block and every use of `threadCalcAnalyzeAction` are
  deleted; ONE button `threadSendBtn` → `threadCalcSendAction({ entity, section,
  messageIds, noteId })`.
- `queued` → `t('threadQueued')` (or `threadQueuedClient` for a client entity, where the
  landing card is decided in the job); `landed` → `t('threadSent')` + the card link, and
  when `aiFailure` is set FIRST `t('threadAiReason.' + aiFailure)` (the reason — «this
  month's AI money is spent» is not «the key is dead») then `threadAiFailed` + the advice
  line; `note_taken` → shown as done; `already_reading` → its sentence.
- **`pending` prop** (server-rendered by the two render sites from
  `threadReadsPending(entity.id)`): when non-empty, the island shows
  `calc.threadPending` («🧮 AI o‘qiyapti — {time} da yuborilgan ({count} ta).») above the
  button, so a reload or a trip to another card does not hide a reading that runs.
- Keys removed ×4 after their uses: `calc.threadAnalyze`, `calc.threadReading`,
  `calc.threadRead`, `calc.threadMissing` (`i18n-keys.test.ts` refuses a literal `t('…')`
  with no key, so delete the uses first).

### 9.6 Tests (P4)
1. `thread-read-job.integration.test.ts` (new; `analyzeIntake` and the sender mocked, a
   real database): the press → one job; `runThreadRead` → one request with `note_id =
   noteId`, the AI's lines, `source 'card'`, one `'intake'` row that now carries
   `request_id`; `queueCalcPrefill` called once. **Red:** drop `attachIntakePasses` → the
   row keeps `request_id NULL`.
2. Same: a redelivery after the landing → no second request, no model call, the prefill
   not doubled. **Red:** remove step 1 → `note_taken` thrown into a retry.
3. Same: the last attempt → no model call, lands, the note carries «⚠️ AI o‘qimadi».
   **Red:** drop the `retryCount` branch → the model spy is called on attempt 3.
4. Same: the ceiling reached between press and job → no model call, lands, the note names
   `ceiling`; a revoked grant → nothing lands, the presser gets ONE Telegram message and NO
   lenta note; `too_many_open` at landing → one message AND one lenta note, no throw; the
   landing throws a non-CalcError once → the in-process retry lands it, ONE `'intake'` row,
   one request; on the last attempt a throw → one message, one note, no rethrow; the same
   `tellPresser` called twice → one message (the note's ON CONFLICT). **Red:** rethrow on
   the last attempt → the wrapper's promise rejects.
5. Same: `sweepThreadReads` over a scripted `failed` job row with no request → one
   message, one note; a second sweep → nothing.
6. `thread-read-sum.test.ts`: both pins. **Red:** `THREAD_READ_EXPIRE_S = 200` → red;
   `THREAD_LAND_RESERVE_MS = 60_000` → the promise pin red.
7. `thread-calc.integration.test.ts` (kept through `threadCalcSend`, extended; the gate
   through the seam): no key → lands at once with `aiFailure 'not_configured'`; a complete
   yo‘lkira chat (route + kg + m³ typed) → lands at once with NO model call even with a
   key (**red:** drop the completeness check → the spy counts 1); an INCOMPLETE yo‘lkira
   chat → queued (**red:** restore «yolkira → never read» → it lands at once); a second
   press after `queued` (same island) → nothing enqueued, no error; a second press from a
   fresh island on the SAME selection while the job stands → `already_reading`; 20 open
   requests → refused at the press with no job.
8. `thread-calc-wire.test.ts` (re-anchored): the gate body now in `from-thread.ts`
   `threadCalcRefusal`; the action posts no `facts`/`steps`; the island imports no analyze
   action; `analyzeIntake(` in `src/` is called only from `intake-ai.ts`'s own exports'
   callers: the bot's reader, `thread-read.ts` and `wms/calc/compare/inputs.ts` (derived
   grep).
9. `deal-terms-wire.test.ts:89-93` and `deal-ved.integration.test.ts:626-638` re-anchored:
   the VED is refused `deal_terms_only` by `threadCalcSendAction` (the analyze action is
   gone) — reason recorded.
10. The corpus pins that name `threadCalcAnalyze`'s lines (`intake-corpus.test.ts` c0268,
    c0764, c0766, the advice cases; `intake-typed.test.ts:163-168, 248-262`;
    `intake-typed-r2.test.ts:326-340`) move to `threadReadFacts` by path; c0766's «typed read
    AFTER `await analyzeIntake(`» becomes «after the `outcome` parameter». Never deleted
    (#166).
11. A unit fence: every `ThreadPressFailure` member has `calc.threadAiReason.<member>` ×4
    (the union read out of `from-thread.ts`, the `price-channel-i18n` shape).

---

## 10. P5 «Yordamchi» — the staff assistant on two tiers (3.6 a)

### 10.1 Files OWNED
- `platform/ai/model.ts`, `platform/ai/assistant.ts`, `platform/ai/tools.ts`
  (`assistantTier` only). The bot's and the web's outcome maps are K's (K7).
- Tests: §10.5.

### 10.2 `model.ts`
- `ModelBlock` gains the two thinking members, mapped BOTH ways verbatim:
  `{ type: 'thinking'; thinking: string; signature: string }` and
  `{ type: 'redacted_thinking'; data: string }`. Today `realCallModel`'s `flatMap`
  (`model.ts:87-100`) keeps only text and tool_use, so every tool round after the first is
  replayed WITHOUT its thinking — the newest tiers' guide says to pass thinking blocks back
  unchanged (the API itself drops, unbilled, a block the current model cannot read — e.g.
  after a fallback switch — so the code never strips one).
- `ModelRequest` loses `model` and `maxTokens` (the profile decides both) and gains
  `job: 'assistant.staff' | 'assistant.admin'`, `plan?: TierPlan`, `startOn?: 'primary' |
  'fallback'`, `leashMs: number`.
- `ModelResponse` gains OPTIONAL `attempts?: AiAttempt[]`, `failure?: AiCallFailure`,
  `servedBy?: 'primary' | 'fallback'` (optional so the scripted `CallModel`s in
  `ai-assistant.integration.test.ts` keep compiling; a scripted response bills nothing).
- `realCallModel` = `runModel({ job, system, messages, tools, leashMs, plan, startOn,
  read: (m) => ({ ok: true, value: m }) })`, mapping the message back to `ModelResponse`
  (text, tool_use, thinking, redacted_thinking). On a runner failure: `{ stopReason: null,
  content: <the failure's message content when the failure is `truncated`, else []>,
  attempts, failure }`. The two id constants (`model.ts:51-52`) are no longer imported by
  this file; the lead deletes them at the merge (§16).

### 10.3 `assistant.ts` — `askAssistant`
`deps` gains two test seams: `ready?: AiReadiness` (replaces the gate — so a test can
inject `'month'` without a key or a tier row) and `plan?: TierPlan | null` (the scripted
path takes the injected plan and never calls `tierPlan`).
1. Question empty → `error` (today).
2. `!deps.callModel && !aiConfigured()` → `not_configured` (today).
3. **NEW**, between the key and the day's slot: `const job = assistantTier(actor)`;
   `const ready = deps.ready ?? (deps.callModel ? 'ok' : await aiReady({ tier:
   AI_JOBS[job].tier, dayCap: null }))` — `month` → `{ status: 'ceiling' }`, `off` →
   `{ status: 'off' }`, `model_not_chosen`, `server_behind` → themselves. Asked BEFORE
   `reserveQuestion` so a refused question never spends the person's daily slot.
4. `reserveQuestion` (today; its own transaction).
5. **After** that transaction returns: `plan = deps.plan !== undefined ? deps.plan : await
   tierPlan(AI_JOBS[job].tier)` — resolved ONCE per question, so a mid-question save on the
   screen never switches models inside one answer; never inside the reserve's transaction
   (#714). A non-ok answer here (the pick was cleared between step 3 and step 5 — seconds)
   finishes the question with that status; the slot STAYS spent (stated: the reserve row is
   the audit and the cap, and un-reserving would be a second writer of the cap).
6. The loop (`MAX_ROUNDS` 6): round leash `= min(AI_JOBS[job].leashMs, wall − elapsed)`,
   `wall = job === 'assistant.admin' ? (surface === 'bot' ? 180_000 : 240_000) : 120_000` —
   the bot's admin answer stays inside his three minutes for an AI answer in Telegram; a
   person at `/ai` gets four. Under 10 s left → stop as `gave_up`. `callModel({ job, plan,
   startOn, leashMs, system, messages, tools })`.
7. After each call: bill each of `response.attempts` with `await recordAiCall({ kind:
   'assistant', questionId, staffId: actor.id }, usage)` (own try each). `response.servedBy
   === 'fallback'` → `startOn = 'fallback'` for the rest of the question (sticky; a
   single-shot calc call is per call).
8. `response.failure` → finish the question (`ok: false`) and return the status:
   `refused` / `refused_fallback` → `refused`; `ceiling`; `off`; `model_not_chosen`;
   `model_unavailable`; `server_behind`; `truncated` → `{ status: 'truncated', answer:
   <this round's text, else the last text> }` (today a round cut by `max_tokens` returned its
   text as an `ok` answer — the person paid for it, so the text is KEPT and the line of §2.3
   is added); everything else → `error`. A REFUSED round's partial text is NEVER returned:
   today `if (text) lastText = text` runs before the stop check (`assistant.ts:179`), so a
   refused round's half sentence became the answer — the runner now returns the failure
   before any content is read.
9. `messages.push({ role: 'assistant', content: response.content })` pushes the thinking
   blocks with everything else (append-only — the system prompt and the tools are fixed
   per question; `today` is constant inside one question).

### 10.4 `tools.ts`
```ts
/** His 3.6 a: the admin's data questions on the strong tier, everyone else on the fast one.
 * Keyed on `isAnalyst` (the ROLE super_admin/admin) — the predicate that already chooses
 * the analyst's prompt and the screen's intro (`ai/page.tsx:31`). NOT `hasMoneyTier`: that
 * would hand a customised admin without finance.reports the fast tier while his own screen
 * promises the analyst. */
export function assistantTier(actor: { readonly roles: readonly string[] }): 'assistant.admin' | 'assistant.staff';
```
Until he picks «Tez ishlar», `tierPlan('fast')` lends the heavy plan (`borrowed: true`,
⭐ Question 9 a) — `askAssistant` needs no branch for it.

### 10.5 Tests (P5)
1. `ai-assistant.integration.test.ts` (extended): a scripted `CallModel` that records
   `req.job` — an analyst actor gets `assistant.admin`, a staff actor `assistant.staff`;
   the scripted path passes `deps.plan` (no tier read). **Red:** swap the ternary in
   `assistantTier`.
2. Same: `deps.ready: 'month'` → `ceiling`, and `ai_questions` has NO new row for that
   person (the slot was not spent); `'off'` → `off`. **Red:** move the gate below
   `reserveQuestion`.
3. Same: a scripted response with two `attempts` (primary refused, fallback served) → two
   `'assistant'` rows on the question's anchor, and the NEXT round's request carries
   `startOn: 'fallback'`. **Red:** drop the sticky assignment.
4. Same: a scripted `failure: 'refused_fallback'` after a round that had text → status
   `refused`, the text not returned; a scripted `failure: 'truncated'` with content →
   `truncated` WITH that text.
5. Same, `afterAll`: deletes the file's `ai_calc_passes` rows (`question_id IN (its
   questions)`) BEFORE its `ai_questions` and its fixture user (`:75-81`). The migration
   also makes `ai_calc_passes.staff_id` `ON DELETE SET NULL` (§12), so a forgotten row
   never blocks a fixture user's delete with 23503 again — but a row left behind is still
   a row in CI's one database (§14.2).
6. `ai-assistant-wire.test.ts` (stand-in `sse-message`, real `realCallModel`, the tier and
   gate mocks of §7.8): round 1 answers with a `thinking` block + a `tool_use`; round 2's
   REQUEST body carries that thinking block verbatim (signature included). **Red:** restore
   the `flatMap` drop → the block is absent.
7. `bot-ai-dispatch.test.ts:65-72` (pinned `new Anthropic({…timeout` in `model.ts`) —
   re-anchored on the runner: `run.ts` carries `AbortSignal.timeout(` and `maxRetries: 0`;
   `model.ts` contains no `new Anthropic` at all. Reason recorded (the subject — round 101's
   «a deadline of its own» — moved into the one runner; #166: re-anchored, not deleted).
   Same for `:104-109` (`intake-ai.ts`) and `similar-ai.test.ts:86-88`.
8. Exhaustive maps: a unit test reads `AskOutcome`'s members out of `assistant.ts` and
   asserts every one except `ok`/`gave_up` has a bot sentence AND an `assistant.*` key ×4
   (R2's freight-answer fence idiom).
9. The wall per surface: a scripted slow `CallModel` on `surface: 'bot'` for an analyst
   stops at ≈ 180 s of (injected) clock, on `'web'` at ≈ 240 s.

---

## 11. P6 «Solishtirish» — the one-off comparison (3.8 a)

P6 is built LAST, in a worktree branched from `sakkiz-r5` AFTER P1 and P2 are picked (it
calls P1's `liveModels` and P2's wired `run?` arguments; K's inert signatures are not
enough to test it).

### 11.1 Files OWNED
- `scripts/ai-solishtirish.ts` (glue only: arguments, the read-only URL, the loop, the
  results file, stdout).
- `src/modules/wms/calc/compare/`: `select.ts` (the SQL, reads only), `inputs.ts`
  (rebuilds each job's input through PRODUCTION's builders, and is the one caller of
  `analyzeIntake` / `proposeGoodsGrouping` / `pickImportRows` with `purpose: 'compare'`),
  `score.ts` (pure), `budget.ts` (pure), `report.ts` (pure, the Uzbek text),
  `note-material.ts` (pure `materialOfNote`), `results.ts` (the JSON-lines file: append,
  read back, resume).
- Tests: §11.7.

### 11.2 What it measures against
- **The answer key** = confirmed groups of sealed requests: `calc_groups.tnved_code` with
  `confirmed_at IS NOT NULL` of requests with a current version and no correction
  (`currentVersionSql()` / `notSupersededSql()` from `calc/version-set.ts`, the predicate
  `calc/memory.ts` reads), items through `calc_request_items.group_id`.
  ```sql
  SELECT r.id, r.section, r.note_id, r.weight_kg, r.volume_m3, r.source, v.sealed_at
    FROM calc_requests r
    JOIN calc_versions v ON v.request_id = r.id AND ${currentVersionSql()}
   WHERE r.section IN ('rastamojka','podklyuch') AND ${notSupersededSql()}
     AND EXISTS (SELECT 1 FROM calc_groups g WHERE g.request_id = r.id
                  AND g.confirmed_at IS NOT NULL AND g.tnved_code IS NOT NULL)
   ORDER BY v.sealed_at DESC LIMIT ${n}
  ```
  Default `--sealed 25`.
- **His failed cases**:
  (a) **`--requests <code,code,…>`** — the request numbers or card codes he sends in chat
  (what he sees on /hisoblash and on the card), resolved to landed requests and read
  through the same `materialOfNote` + attachments path as (b) below. This is how HIS
  cases are named; he builds nothing on the server.
  (b) a heuristic set from the last 60 days — a landed rastamojka/podklyuch request whose
  landing note has material or files but no `NOTE_AI_STEPS_MARK` block (cap
  `--failed 20`); after R5 the ledger's `stop_reason` makes this exact for later runs.
  (c) `--cases DIR` — a LEAD-ONLY option (not in his deploy steps), mounted read-only:
  `DIR/<case>/text.txt` + any `.jpg/.png/.pdf/.xlsx/.csv` + optional `expected.json`
  `{ "section": "rastamojka", "codes": ["…"] }` (without it a case is measured for read /
  refused / lines / time / $ only) — for a case that never landed anywhere.
  His medicine/chemistry cases go through (a) or (c): they measure each candidate's
  REFUSAL rate before he picks (3.7's question).
- **A free baseline**: `calc_groups.ai_proposal` (what the model said at the time, written by
  `applyProposal`) scored against the confirmed codes — $0, printed as «o‘sha paytdagi AI»
  (a reference, not a control: its input was pre-R1/R2).
- **A no-AI column**: `parseManualFacts` + `readGoodsLines` on the same text, $0.

### 11.3 Rebuilding each job's input — production's builders, never a copy (#513)
| Job | Input |
|---|---|
| intake | `materialOfNote(noteText)` (the inverse of `intakeNoteText`'s two markers, K7) + the note's attachments (`entity_type 'crm_activity'`, `entity_id = note id`): photos through `reduceForModel` IN MEMORY, PDFs as document blocks, sheets through `readGoodsFile` (mapped goods → `knownGoods`, the rest → `sheets`) → `analyzeIntake` |
| grouping | the sealed request's items through R2's `groupingListing` into `proposeGoodsGrouping`, ≤ 200 per call (`planBatches`) |
| pick | `pickRequestsFor(requestId)` (K9) → `pickImportRows` |

All three model functions are PURE calls (no database write — verified); the script never
calls `aiPrefill`, `proposeGroups`, `pickBazas` or `saveTable` (all write).

### 11.4 Calling a candidate
- Every model function takes its optional `run?: AiRunOptions` (K7; wired by P2) and the
  script passes `{ plan, purpose: 'compare' }` — no gate, no ledger, NO fallback and NO
  transient retry (the column must show the candidate's OWN refusals and failures, and the
  budget reserves exactly one request per cell). `--effort high,xhigh` adds (model, effort)
  columns for the strongest candidate only (`effortOverride`).
- **Candidates**: the models named by `--models` (display name or id — operator input at
  run time, never source). The documented command (§18.5) passes the HEAVY candidates the
  lead names in chat: the newest strong model, today's heavy model (the control, and his
  3.7 a fallback), optionally the strongest for 3.1's effort columns — never the fast
  model, which never does these three jobs under ⭐ Question 1 a. Without `--models`, every
  model with a row in `ai_model_prices` whose live-list snapshot (`liveModels()`) does not
  say it lacks images, PDF or structured output, plus the heavy tier's CURRENT model. A
  candidate with no price is EXCLUDED with the words «narxi yozilmagan — AI sahifasida
  kiriting» (never run uncapped). The report says «Tez ishlar (hodimlar yordamchisi)
  solishtirilmadi» — the assistant is not one of the three measured jobs.
- The dry run's free token count: `countTokens(model, body)` from `platform/ai/run.ts` (K5)
  — never a `new Anthropic(` in `compare/` (K's fence refuses it outside `platform/ai/`).

### 11.5 Read-only, provably; the cap, hard; nothing lost to a dropped session
- `process.env.DATABASE_URL = readOnlyUrl(…)` BEFORE the first import of the db client —
  `default_transaction_read_only=on`, exactly `scripts/zavod-tekshir.ts:24-43`. Storage:
  `getStorage().get` only. No `notifyStaffTelegram`, no `enqueue`, no `revalidatePath`.
  No ledger rows (⭐ Question 8 a); the bill is PRINTED and kept in the results file.
- `--run` is required to spend; without it a DRY RUN: the selection, the candidates,
  `countTokens` per case × candidate (free), and the WORST-CASE dollars (`input × in +
  max_tokens × out`, summed over EVERY call a cell makes — a grouping case of 450 goods is
  three calls). An «expected» figure is printed only labelled «eski model o‘rtachasi
  bo‘yicha — yangi model ko‘proq yozishi mumkin» (this ledger's averages were recorded on
  the old model at the 4 096 / 8 192 caps with no effort).
- `--max-usd N` required with `--run`; `N > 60` refused in words «ruxsat $20-60 edi».
- **Interleaved case-major**: for each case all candidates run; the WHOLE row's worst case
  (every candidate × every call of the case) is reserved before it starts (`spent +
  reserved + rowWorst ≤ cap`), settled after to the actual — and an attempt that ended
  with an ESTIMATED output (a broken stream, §5 K5 step 6) settles at its reservation,
  never below it. A stop leaves every candidate on the same cases (a fair table) and the
  cap is never crossed.
- **`--parallel 1` by default** (`--parallel N` explicit): the comparison shares the
  production key's rate limits with the live bot; run it OFF-HOURS (§18.5).
- **The results file** (`--out FILE`, default `/misollar/ai-solishtirish.jsonl` — the
  documented command mounts a host folder there): ONE JSON line appended per finished
  (case, candidate, job) cell — tokens, $, ms, outcome, refusal category, output tokens
  per second — flushed as it completes. `--resume FILE` skips the cells already in the
  file and counts their dollars toward `--max-usd`; `--report-from FILE` renders the Uzbek
  tables offline from the file alone. A dropped SSH session or a Ctrl-C after $40 loses
  nothing but the cell in flight.
- A transient failure (`rate_limited` / `overloaded` / `network` / `timeout` before the
  stream began) is scored «o‘lchanmadi», never «o‘qimadi», and re-queued ONCE at the end of
  the run (its own reservation).
- Order: `--requests`, `--cases` and the failed set first (they are the point), then
  sealed by recency.
- `aiConfigured()` false → refuses to `--run`, in words. Never in CI.

### 11.6 The report (stdout, Uzbek, numbers only) and the fences
- Head: cases (sealed / failed-before / his own), with an answer key, the cap, the spend;
  the org's rate limits as the last response headers reported them.
- One table per job: model (display name) · effort | o‘qidi / jami | kod to‘g‘ri 10 / 6 / 4
  raqam | rad etdi (and in which category) | kesildi | o‘lchanmadi | vaqt p50 / p90 |
  chiqish token p99 | token/s | $ jami · bitta ish uchun; plus the free «AIsiz» and
  «o‘sha paytdagi AI» rows.
- «Bitta to‘liq AI rastamojka ishi ≈ $X» per candidate (intake + grouping + pick at the
  measured averages) — the number the ceiling arithmetic (§3.4) is re-stated with.
- **What the lead does with it** (the one-line profile follow-up, §4): each job's
  `maxTokens` → measured p99 output + 50 % (never below today's value at that site);
  `AI_STREAM_OUT_TOK_PER_S` raised if any candidate's measured tokens/second exceeds it.
  **If the p90 of `intake.read` at the chosen effort exceeds 120 s** (leaving the fallback
  under 30 s of the 150 s leash), the report says so and the lead ASKS him in plain Uzbek
  before changing anything — «AI o‘qishi 3 daqiqaga sig‘mayapti: kutishni 4 daqiqa
  qilamizmi, yoki fikrlash kuchini bir pog‘ona pasaytiramizmi?» — because the three
  minutes are his word, not the code's.
- Never `$0` for an unpriced cell («narxi yo‘q»). Cases named `#<first 8 of the request
  id>` + the section — no client name, phone or material text (the report is pasted into
  chat). `--json` prints JSON lines instead.
- **Derived fences** (`tests/unit/ai-compare-fence.test.ts`): the OBJECT-LITERAL key-value
  pairs `purpose: 'compare'` and `effortOverride:` (with a value) occur only in files under
  `src/modules/wms/calc/compare/` and in `scripts/ai-solishtirish.ts`; their declarations
  in `platform/ai/run.ts` and the `run?` pass-throughs in the five model files (`...run`,
  `run?: AiRunOptions`) are exempt by name. `countTokens(` is called only under `compare/`.

### 11.7 Tests (P6)
`tests/unit/ai-compare.test.ts`:
1. Score: a 10-digit match is also 6 and 4; an ungrouped item is wrong; recall over a
   multiset.
2. Budget: three rows in flight never exceed the cap; a row's worst case sums every call
   of a multi-batch grouping case; an estimated attempt settles at its reservation; N = 61
   refused. **Red:** reserve per CALL instead of per ROW → the third candidate's last case
   is cut alone and the fairness assertion fails.
3. Report: an unpriced cell prints «narxi yo‘q»; a transient failure prints «o‘lchanmadi»;
   the fast-tier sentence is present. **Red:** `?? 0`.
4. `materialOfNote(intakeNoteText(x))` returns `x.material`. **Red:** change one marker's
   literal in `intakeNoteText` without the constant.
5. `aiCostUsd` equals `aiCostSql` on 50 seeded rows (the integration half lives in K's
   `ai-ledger.integration.test.ts`).
6. Results: a run killed after N cells and resumed never exceeds the cap and renders the
   same table as an uninterrupted run (`--report-from` over the file).

---

## 12. The migration `0137_ai_spend` (additive) — read the journal tail first

```sql
-- Sakkiz band round 5 (docs/SAKKIZ-R5.md), item 3: the models per tier are picked on a screen
-- from Anthropic's live list (his 3.2 a — the code holds no model id; the id is DATA here),
-- and AI spending is measured in DOLLARS against a monthly ceiling (his 3.3 b, 2.9 c).
-- Prices are not in Anthropic's model list, so the owner types them per model; a call's
-- dollars are FROZEN on its ledger row at write time, and a row written before its model had
-- a price waits with cost_usd NULL and is filled ONCE when the price exists.
-- Runs AFTER round 3's calc_intake_durable migration: it re-creates that one's anchor CHECK.
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on the new tables.

-- (1) The pick per tier. NULL model = «tanlanmagan». chosen_at NULL = the migration's
-- continuity pick («avtomatik»); a person's save sets chosen_at (chosen_by may later be
-- SET NULL when that person is deleted — it never decides «avtomatik»).
CREATE TABLE "ai_tiers" (
  "tier" text PRIMARY KEY,
  "model" text,
  "model_info" jsonb,
  "fallback_model" text,
  "fallback_info" jsonb,
  "chosen_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "chosen_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_tiers_tier_check" CHECK ("tier" IN ('heavy','fast')),
  CONSTRAINT "ai_tiers_fallback_check" CHECK (
    ("model" IS NOT NULL OR "fallback_model" IS NULL)
    AND ("fallback_model" IS NULL OR "fallback_model" <> "model"))
);
--> statement-breakpoint
-- (2) Continuity: deploy morning runs the CALC work on exactly today's model. The newest
-- model that answered a calc call is copied into the HEAVY tier only. The FAST tier stays
-- NULL: the staff assistant's model was never metered, so it is nowhere in this database,
-- and copying the heavy model there would silently move every staff question to it — until
-- he picks, the fast jobs BORROW the heavy pick, said on the screen (tierPlan, ⭐ Q9 a).
-- A fresh database (CI) copies nothing: both tiers read «tanlanmagan», and CI has no key.
INSERT INTO "ai_tiers" ("tier", "model")
VALUES ('heavy', (SELECT "model" FROM "ai_calc_passes"
                   WHERE "model" IS NOT NULL AND "model" <> '' ORDER BY "created_at" DESC LIMIT 1)),
       ('fast', NULL)
ON CONFLICT ("tier") DO NOTHING;
--> statement-breakpoint
-- (3) Prices per MODEL (two tiers on one model have ONE price; the ledger prices the model
-- that ANSWERED, else the model it asked for, a fallback included).
CREATE TABLE "ai_model_prices" (
  "model" text PRIMARY KEY,
  "input_usd_mtok" numeric(10,4) NOT NULL,
  "output_usd_mtok" numeric(10,4) NOT NULL,
  "cache_read_usd_mtok" numeric(10,4),
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_model_prices_input_check"  CHECK ("input_usd_mtok"  > 0 AND "input_usd_mtok"  < 1000 AND "input_usd_mtok"  <> 'NaN'::numeric),
  CONSTRAINT "ai_model_prices_output_check" CHECK ("output_usd_mtok" > 0 AND "output_usd_mtok" < 1000 AND "output_usd_mtok" <> 'NaN'::numeric),
  CONSTRAINT "ai_model_prices_read_check"   CHECK ("cache_read_usd_mtok" IS NULL OR ("cache_read_usd_mtok" >= 0 AND "cache_read_usd_mtok" < 1000 AND "cache_read_usd_mtok" <> 'NaN'::numeric))
);
--> statement-breakpoint
-- (4) The one ledger, widened (never a second table: two ledgers of one fact is #513, and a
-- new table would strand R3's attachIntakePasses).
ALTER TABLE "ai_calc_passes" ADD COLUMN "requested_model" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "cache_write_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "cache_write_1h_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "cache_read_tokens" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "thinking_tokens" integer;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "cost_usd" numeric(12,6);
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "tier" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "job" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "fallback" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "stop_reason" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "refusal_category" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "service_tier" text;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "inference_geo" text;
--> statement-breakpoint
-- Loose pointers, NO foreign key: a money ledger must never shrink by a cascade nor block a
-- delete (23503), and ON DELETE SET NULL cannot sit beside a CHECK that spans the column (#809).
ALTER TABLE "ai_calc_passes" ADD COLUMN "deal_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "lot_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD COLUMN "question_id" uuid;
--> statement-breakpoint
-- The staff pointer (0096, a plain FK with no ON DELETE) becomes SET NULL — the house rule
-- for users FKs (a test suite deletes fixture users, 0135's precedent). staff_id spans no
-- CHECK, so #809 does not apply. The assistant now writes rows with staff_id = the asker.
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_staff_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_staff_id_fkey";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_staff_id_fkey"
  FOREIGN KEY ("staff_id") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_kind_check";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_kind_check" CHECK ("kind" IN
  ('intake','grouping','pick','invoice','similar','assistant','tnved','deal_import'));
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_tokens_check";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_tokens_check" CHECK (
  "input_tokens" >= 0 AND "output_tokens" >= 0
  AND "cache_write_tokens" >= 0 AND "cache_read_tokens" >= 0
  AND "cache_write_1h_tokens" >= 0 AND "cache_write_1h_tokens" <= "cache_write_tokens"
  AND ("thinking_tokens" IS NULL OR ("thinking_tokens" >= 0 AND "thinking_tokens" <= "output_tokens")));
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_cost_check"
  CHECK ("cost_usd" IS NULL OR ("cost_usd" >= 0 AND "cost_usd" <> 'NaN'::numeric));
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_tier_check"
  CHECK ("tier" IS NULL OR "tier" IN ('heavy','fast'));
--> statement-breakpoint
-- R3's CASE (its calc_intake_durable migration), extended by the three new doors. Dropped BY
-- NAME, so this file must run after that one.
ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_anchor_check";
--> statement-breakpoint
ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_anchor_check" CHECK (
  CASE "kind"
    WHEN 'similar'     THEN "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'intake'      THEN "request_id" IS NOT NULL OR "intake_note_id" IS NOT NULL
    WHEN 'assistant'   THEN "question_id" IS NOT NULL AND "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'tnved'       THEN "lot_id" IS NOT NULL AND "request_id" IS NULL AND "intake_note_id" IS NULL
    WHEN 'deal_import' THEN "deal_id" IS NOT NULL AND "request_id" IS NULL AND "intake_note_id" IS NULL
    ELSE "request_id" IS NOT NULL AND "intake_note_id" IS NULL
  END);
--> statement-breakpoint
CREATE INDEX "ai_calc_passes_unpriced_idx" ON "ai_calc_passes" ("model") WHERE "cost_usd" IS NULL;
--> statement-breakpoint
-- (5) The ✨ claim's token: a pass proves the claim is still ITS OWN before each batch and
-- releases only its own (today's release is unconditional).
ALTER TABLE "calc_requests" ADD COLUMN "ai_claim_id" uuid;
```

The staff FK's NAME: 0096 created it inline (`"staff_id" uuid REFERENCES "users"("id")`),
so postgres named it `ai_calc_passes_staff_id_fkey`; the two `DROP … IF EXISTS` lines cover
that and drizzle's naming. **Read the real name on the merged tree** (`\d ai_calc_passes`)
before K and keep only the line that matches — a drop that names nothing leaves the old FK
beside the new one.

Why each:
- **(1) a table, not settings keys.** `SettingKey` is a static union (a price per model is a
  dynamic key); an object default is drawn as hand-editable JSON on /admin/settings
  (`page.tsx:50-55`) — a second, unvalidated door into the pick; and a setting's validator
  cannot ask the live list (it is synchronous). `tier` has a CHECK: a third tier (Question
  1 b) is a migration, said.
- **(2) in the migration, not the seed.** The migration runs first on every deploy
  (`migrate` = `db:migrate && db:seed`); the seed fills only absent rows anyway. The copied
  model is DATA from his own ledger; no id is written in source. Heavy only — the reason
  is in the comment, and the fast tier's borrowing is `tierPlan`'s (§5 K2).
- **(3) per model, not per tier**: the ledger prices the model that answered; a tier price
  would be wrong the day he switches the pick.
- **(4)** every existing row satisfies every new CHECK (old kinds unchanged, new columns
  default/NULL). `job` has NO CHECK on purpose: the job list is code's (`AI_JOBS`) and a new
  job must not need a migration; the column is informational (the screen's per-door split
  of `intake` into the bot and the chat door). `requested_model` is the id the runner sent
  (§3.2). `request_id … ON DELETE CASCADE` (0096) is left as it is and STATED: no app path
  deletes a `calc_requests` row (tests only), and the new anchors are loose.
- **(5)** a token, not a longer window (§7.5).

Deploy: the ledger must read the journal's length. `docker compose build migrate app`, then
`docker compose up -d`. The bot runs in `app`; `tg-listen` is untouched (it makes no AI
call). A code-ahead-of-migration minute: `tierPlan` answers `server_behind` (42P01/42703)
and every door says «Tizim yangilanmoqda».

---

## 13. Settings and i18n

### 13.1 The setting (K)
- `ai_monthly_ceiling_usd: 100` in `SETTING_DEFAULTS` beside `ai_calc_daily_limit`.
- `SETTING_VALIDATORS.ai_monthly_ceiling_usd = (raw) => /^\d{1,6}(\.\d{1,2})?$/.test(raw.trim())
  && Number(raw) <= 100_000` — the generic action's `Number()` drops a typo SILENTLY
  (`admin/settings/actions.ts:33-35`) and `Number('') === 0` would switch the AI off; the
  validator refuses `''`, `'100$'`, `'1,5'` in words — its OWN words,
  `settings.badValueFor.ai_monthly_ceiling_usd` (§13.2), because today's `badValue` is a
  DATE sentence («sana … yozing; bo‘sh = o‘chiq») that would tell him to type a date and that
  empty means off, the opposite of this setting's rule. The page prints
  `badValueFor.<key>` when it exists, else `badValue` (K7); `lead_assign_origins` gets its
  own sentence on the way (its refusal reads the same date sentence today).
  `tests/unit/unpriced-gate.test.ts:72`'s shape for the validator test; a locales test
  asserts every `SETTING_VALIDATORS` key that is not a date setting has a `badValueFor`
  key ×4.
- The READ rule (`aiMonthSpend`, §3.3): a finite number ≥ 0 is the ceiling (0 = off);
  anything else reads as the default 100 with a `[ai-cost] ceiling unreadable` warning —
  never Infinity.
- The SAVE re-judges the month: `updateSettingAction` calls `checkSpendLevel()` after a
  successful save of this key (K7).
- Descriptions (`settings.descriptions.ai_monthly_ceiling_usd`, all four — the locales
  tripwire takes /admin/settings down otherwise):
  - uz: `AI uchun oylik pul chegarasi, dollarda (0 — pullik AI ishlari o‘chiq). 80 % da Telegramda ogohlantirish; chegaradan keyin AI ishlari qo‘lda bajariladi.`
  - ru: `Месячный лимит расходов на ИИ, в долларах (0 — платный ИИ выключен). На 80 % — предупреждение в Telegram; после лимита работа ИИ делается вручную.`
  - en: `Monthly AI spending ceiling, in dollars (0 — paid AI off). A Telegram warning at 80 %; above the ceiling the AI work is done by hand.`
  - zh-CN: `每月 AI 费用上限（美元，0 表示关闭付费 AI）。达到 80% 时在 Telegram 提醒；超过上限后由人工完成。`
- Kept, unchanged in meaning and description: `ai_calc_daily_limit`,
  `price_history_ai_daily_limit`, `ai_daily_limit`.

### 13.2 Keys K adds (×4, at the anchors named)
| Key | uz | ru | en | zh-CN |
|---|---|---|---|---|
| `assistant.ceiling` | Bu oy AI uchun ajratilgan pul tugadi — yordamchi oy oxirigacha ishlamaydi. | Месячный лимит на ИИ исчерпан — ассистент не работает до конца месяца. | This month's AI budget is spent — the assistant is off until the month ends. | 本月 AI 预算已用完——助手到月底前不可用。 |
| `assistant.off` | AI o‘chirilgan (oylik chegara 0). | ИИ выключен (месячный лимит 0). | The AI is switched off (monthly ceiling 0). | AI 已关闭（月度上限为 0）。 |
| `assistant.refused` | AI bu savolga javob bermadi (xavfsizlik filtri). Savolni boshqacha yozib ko‘ring. | ИИ не ответил на этот вопрос (фильтр безопасности). Сформулируйте иначе. | The AI declined this question (safety filter). Try wording it differently. | AI 拒绝回答此问题（安全过滤）。请换个说法。 |
| `assistant.modelNotChosen` | AI modeli tanlanmagan — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin. | Модель ИИ не выбрана — администратор выбирает её в «Управление → ИИ: модели и расходы». | No AI model chosen — an admin picks one under Administration → AI: models and spending. | 尚未选择 AI 模型——请管理员在「管理 → AI：模型与费用」中选择。 |
| `assistant.modelUnavailable` | Tanlangan AI modeli topilmadi — admin «Boshqaruv → AI: modellar va xarajat» sahifasida boshqasini tanlasin. | Выбранная модель ИИ недоступна — администратор выбирает другую в «Управление → ИИ: модели и расходы». | The chosen AI model is no longer available — an admin picks another under Administration → AI: models and spending. | 所选 AI 模型已不可用——请管理员在「管理 → AI：模型与费用」中另选。 |
| `assistant.serverBehind` | Tizim yangilanmoqda — bir daqiqadan keyin qayta so‘rang. | Система обновляется — спросите через минуту. | The system is updating — ask again in a minute. | 系统正在更新——请一分钟后再问。 |
| `assistant.truncated` | ✂️ Javob shu yerda kesildi — to‘liq javob uchun savolni toraytirib bering. | ✂️ Ответ обрезан здесь — для полного ответа сузьте вопрос. | ✂️ The answer was cut here — narrow the question for a full answer. | ✂️ 回答在此处被截断——请缩小问题范围以获得完整回答。 |
| `calc.errors.ai_ceiling` | Bu oy AI uchun pul chegarasi tugadi — guruhlarni qo‘lda tuzing. | Месячный лимит на ИИ исчерпан — сгруппируйте вручную. | This month's AI budget is spent — group by hand. | 本月 AI 预算已用完——请手动分组。 |
| `calc.errors.ai_off` | AI o‘chirilgan (oylik chegara 0) — guruhlarni qo‘lda tuzing. | ИИ выключен (месячный лимит 0) — сгруппируйте вручную. | The AI is switched off (monthly ceiling 0) — group by hand. | AI 已关闭（月度上限为 0）——请手动分组。 |
| `calc.errors.ai_refused` | AI bu tovarlarni guruhlashdan bosh tortdi (xavfsizlik filtri) — guruhlarni qo‘lda tuzing. | ИИ отказался группировать эти товары (фильтр безопасности) — сгруппируйте вручную. | The AI declined to group these goods (safety filter) — group by hand. | AI 拒绝对这些商品分组（安全过滤）——请手动分组。 |
| `calc.errors.ai_model` | AI modeli tanlanmagan yoki topilmadi — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin. | Модель ИИ не выбрана или недоступна — администратор выбирает её в «Управление → ИИ: модели и расходы». | No usable AI model — an admin picks one under Administration → AI: models and spending. | 无可用 AI 模型——请管理员在「管理 → AI：模型与费用」中选择。 |
| `calc.errors.ai_claim_lost` | AI taklifi to‘xtatildi — kimdir ✨ ni qayta bosdi. Natijani yangilang. | Предложение ИИ остановлено — кто-то снова нажал ✨. Обновите страницу. | The AI proposal was stopped — someone pressed ✨ again. Refresh. | AI 建议已停止——有人再次点击了 ✨。请刷新。 |
| `calc.proposeBusy` | AI o‘ylayapti… (3 daqiqagacha) | ИИ думает… (до 3 минут) | The AI is thinking… (up to 3 minutes) | AI 正在思考……（最多 3 分钟） |
| `calc.proposeSkipped` | AI {done} / {total} tovarni ko‘rdi — qolganlari uchun ✨ ni qayta bosing. | ИИ обработал {done} из {total} товаров — для остальных нажмите ✨ ещё раз. | The AI covered {done} of {total} products — press ✨ again for the rest. | AI 已处理 {total} 个商品中的 {done} 个——其余请再次点击 ✨。 |
| `calc.threadQueued` | ✅ Qabul qilindi — AI o‘qiyapti (odatda 3 daqiqagacha). So‘rov VED navbatiga va shu kartaga tushadi, javob Telegramda ham keladi. | ✅ Принято — ИИ читает (обычно до 3 минут). Запрос попадёт в очередь ВЭД и на эту карточку, ответ придёт и в Telegram. | ✅ Accepted — the AI is reading (usually up to 3 minutes). The request reaches the VED queue and this card; the answer also comes in Telegram. | ✅ 已接收——AI 正在读取（通常最多 3 分钟）。请求将进入 VED 队列和本卡片，答复也会发到 Telegram。 |
| `calc.threadQueuedClient` | ✅ Qabul qilindi — AI o‘qiyapti (odatda 3 daqiqagacha). So‘rov VED navbatiga tushadi, javob Telegramda ham keladi. | ✅ Принято — ИИ читает (обычно до 3 минут). Запрос попадёт в очередь ВЭД, ответ придёт и в Telegram. | ✅ Accepted — the AI is reading (usually up to 3 minutes). The request reaches the VED queue; the answer also comes in Telegram. | ✅ 已接收——AI 正在读取（通常最多 3 分钟）。请求将进入 VED 队列，答复也会发到 Telegram。 |
| `calc.threadPending` | 🧮 AI o‘qiyapti — {time} da yuborilgan ({count} ta). | 🧮 ИИ читает — отправлено в {time} ({count}). | 🧮 The AI is reading — sent at {time} ({count}). | 🧮 AI 正在读取——{time} 发送（{count} 条）。 |
| `calc.threadAiReason.not_configured` | Serverda AI kaliti yo‘q. | На сервере нет ключа ИИ. | There is no AI key on the server. | 服务器上没有 AI 密钥。 |
| `calc.threadAiReason.model_not_chosen` | AI modeli tanlanmagan («Boshqaruv → AI: modellar va xarajat»). | Модель ИИ не выбрана («Управление → ИИ: модели и расходы»). | No AI model chosen (Administration → AI: models and spending). | 尚未选择 AI 模型（「管理 → AI：模型与费用」）。 |
| `calc.threadAiReason.server_behind` | Tizim yangilanmoqda edi. | Система обновлялась. | The system was updating. | 系统正在更新。 |
| `calc.threadAiReason.ceiling` | Bu oy AI uchun ajratilgan pul tugadi. | Месячный лимит на ИИ исчерпан. | This month's AI budget is spent. | 本月 AI 预算已用完。 |
| `calc.threadAiReason.off` | AI o‘chirilgan (oylik chegara 0). | ИИ выключен (месячный лимит 0). | The AI is switched off (monthly ceiling 0). | AI 已关闭（月度上限为 0）。 |
| `calc.threadAiReason.budget` | AI kunlik limiti tugadi. | Дневной лимит ИИ исчерпан. | The AI's daily limit is used up. | AI 每日额度已用完。 |
| `calc.threadAiReason.network` | AI navbatiga qo‘yib bo‘lmadi. | Не удалось поставить в очередь ИИ. | Could not queue the AI reading. | 无法加入 AI 队列。 |
| `calc.threadErrors.bad_note` | Tanlov eskirgan — sahifani yangilang. | Выбор устарел — обновите страницу. | The selection is stale — refresh the page. | 选择已过期——请刷新页面。 |
| `calc.threadErrors.already_reading` | Bu xabarlar hozir AI o‘qiyapti — tugashini kuting. | Эти сообщения уже читает ИИ — дождитесь окончания. | The AI is already reading these messages — wait for it to finish. | AI 正在读取这些消息——请等待完成。 |
| `tnved.aiCeiling` | AI oylik chegarasi tugadi — kodni qo‘lda yozing. | Месячный лимит ИИ исчерпан — введите код вручную. | The monthly AI budget is spent — type the code by hand. | 本月 AI 预算已用完——请手动填写编码。 |
| `tnved.aiOff` | AI o‘chirilgan (oylik chegara 0) — kodni qo‘lda yozing. | ИИ выключен (месячный лимит 0) — введите код вручную. | The AI is switched off (monthly ceiling 0) — type the code by hand. | AI 已关闭（月度上限为 0）——请手动填写编码。 |
| `tnved.aiRefused` | AI bu tovarni ko‘rib chiqishdan bosh tortdi (xavfsizlik filtri) — kodni qo‘lda yozing. | ИИ отказался рассматривать этот товар (фильтр безопасности) — введите код вручную. | The AI declined this product (safety filter) — type the code by hand. | AI 拒绝处理该商品（安全过滤）——请手动填写编码。 |
| `tnved.aiModel` | AI modeli tanlanmagan yoki topilmadi — admin «Boshqaruv → AI: modellar va xarajat» sahifasida tanlasin. | Модель ИИ не выбрана или недоступна — администратор выбирает её в «Управление → ИИ: модели и расходы». | No usable AI model — an admin picks one under Administration → AI: models and spending. | 无可用 AI 模型——请管理员在「管理 → AI：模型与费用」中选择。 |
| `tnved.suggestProgress` | AI: {i} / {n} | ИИ: {i} / {n} | AI: {i} / {n} | AI：{i} / {n} |
| `tnved.suggestCapped` | Bir bosishda {cap} ta — yana {left} ta qoldi, qayta bosing. | За одно нажатие {cap} — осталось ещё {left}, нажмите снова. | {cap} per press — {left} left, press again. | 每次最多 {cap} 个——还剩 {left} 个，请再次点击。 |
| `finance.priceHistoryAiError.ceiling` | AI oylik chegarasi tugadi | Месячный лимит ИИ исчерпан | Monthly AI budget spent | 本月 AI 预算已用完 |
| `finance.priceHistoryAiError.off` | AI o‘chirilgan (oylik chegara 0) | ИИ выключен (месячный лимит 0) | The AI is switched off (ceiling 0) | AI 已关闭（上限为 0） |
| `finance.priceHistoryAiError.refused` | AI bu tovardan bosh tortdi (xavfsizlik filtri) | ИИ отказался (фильтр безопасности) | The AI declined (safety filter) | AI 拒绝（安全过滤） |
| `finance.priceHistoryAiError.model` | AI modeli tanlanmagan — adminga ayting | Модель ИИ не выбрана — сообщите администратору | No AI model chosen — tell the admin | 未选择 AI 模型——请告知管理员 |
| `deals.importAiFailed` | AI javob bermadi: har tovar alohida qator bo‘ldi, kodlar xotiradan. | ИИ не ответил: каждый товар — отдельная строка, коды из памяти. | The AI did not answer: one line per product, codes from memory. | AI 未响应：每个商品单独一行，编码取自记忆。 |
| `deals.importAiCeiling` | AI oylik chegarasi tugadi: har tovar alohida qator bo‘ldi, kodlar xotiradan. | Месячный лимит ИИ исчерпан: каждый товар — отдельная строка, коды из памяти. | The monthly AI budget is spent: one line per product, codes from memory. | 本月 AI 预算已用完：每个商品单独一行，编码取自记忆。 |
| `deals.importAiOff` | AI o‘chirilgan (oylik chegara 0): har tovar alohida qator bo‘ldi, kodlar xotiradan. | ИИ выключен (месячный лимит 0): каждый товар — отдельная строка, коды из памяти. | The AI is switched off (monthly ceiling 0): one line per product, codes from memory. | AI 已关闭（月度上限为 0）：每个商品单独一行，编码取自记忆。 |
| `deals.importAiRefused` | AI bu tovarlardan bosh tortdi (xavfsizlik filtri): har tovar alohida qator bo‘ldi. | ИИ отказался от этих товаров (фильтр безопасности): каждый товар — отдельная строка. | The AI declined these goods (safety filter): one line per product. | AI 拒绝处理这些商品（安全过滤）：每个商品单独一行。 |
| `deals.importAiModel` | AI modeli tanlanmagan yoki topilmadi: har tovar alohida qator bo‘ldi. | Модель ИИ не выбрана или недоступна: каждый товар — отдельная строка. | No usable AI model: one line per product. | 无可用 AI 模型：每个商品单独一行。 |
| `deals.importAiPartial` | AI {grouped} / {total} tovarni guruhladi — qolganini qo‘lda guruhlang. | ИИ сгруппировал {grouped} из {total} товаров — остальные сгруппируйте вручную. | The AI grouped {grouped} of {total} products — group the rest by hand. | AI 已对 {total} 个商品中的 {grouped} 个分组——其余请手动分组。 |
| `settings.badValueFor.ai_monthly_ceiling_usd` | Faqat dollar summasini raqam bilan yozing, masalan 100 yoki 150.50 (0 — pullik AI o‘chiq). Hech narsa saqlanmadi. | Укажите только сумму в долларах числом, например 100 или 150.50 (0 — платный ИИ выключен). Ничего не сохранено. | Type only a dollar amount as a number, e.g. 100 or 150.50 (0 — paid AI off). Nothing was saved. | 请只填写美元金额数字，例如 100 或 150.50（0 表示关闭付费 AI）。未保存任何内容。 |
| `settings.badValueFor.lead_assign_origins` | Faqat https:// bilan boshlanadigan sayt manzillarini, oxirida «/» va yo‘lsiz, bo‘sh joy bilan ajratib yozing (masalan https://gsrlogistics.uz). Hech narsa saqlanmadi. | Укажите только адреса сайтов, начинающиеся с https://, без «/» и пути в конце, через пробел (например https://gsrlogistics.uz). Ничего не сохранено. | Type only site addresses starting with https://, with no trailing «/» or path, separated by spaces (e.g. https://gsrlogistics.uz). Nothing was saved. | 请只填写以 https:// 开头的网站地址（末尾不带「/」或路径），用空格分隔（例如 https://gsrlogistics.uz）。未保存任何内容。 |

Removed by P4 (after their uses): `calc.threadAnalyze`, `calc.threadReading`,
`calc.threadRead`, `calc.threadMissing`.

### 13.3 The screen's namespace `aiModels` (P1)
| Key | uz | ru | en | zh-CN |
|---|---|---|---|---|
| `title` | AI: modellar va xarajat | ИИ: модели и расходы | AI: models and spending | AI：模型与费用 |
| `intro` | Og‘ir va tez ishlar uchun modelni Anthropic ro‘yxatidan tanlang, narxini yozing. Xarajat dollarda shu yerda ko‘rinadi. | Выберите модель для тяжёлых и быстрых задач из списка Anthropic и укажите цену. Расходы в долларах видны здесь. | Pick the model for heavy and fast work from Anthropic's list and type its price. Spending in dollars shows here. | 从 Anthropic 列表中为繁重和快速任务选择模型并填写价格。美元费用在此显示。 |
| `monthTitle` | Bu oy | Этот месяц | This month | 本月 |
| `monthBar` | Bu oy: {spent} / {ceiling} ({pct} %) | В этом месяце: {spent} / {ceiling} ({pct} %) | This month: {spent} / {ceiling} ({pct} %) | 本月：{spent} / {ceiling}（{pct} %） |
| `monthOff` | Chegara 0 — pullik AI o‘chiq | Лимит 0 — платный ИИ выключен | Ceiling 0 — paid AI is off | 上限为 0——付费 AI 已关闭 |
| `unpriced` | ⚠️ {count} ta chaqiruv narxsiz — eng yuqori kiritilgan narx bilan taxminiy sanalmoqda | ⚠️ {count} вызовов без цены — считаются приблизительно по самой высокой введённой цене | ⚠️ {count} calls with no price — estimated at the highest price typed | ⚠️ {count} 次调用无价格——按已填写的最高价格估算 |
| `unpricedNone` | ⚠️ {count} ta chaqiruv narxsiz — hech qanday narx kiritilmagan, chegara ularni sanay olmayapti | ⚠️ {count} вызовов без цены — ни одной цены не введено, лимит их не учитывает | ⚠️ {count} calls with no price — no price typed at all, the ceiling cannot count them | ⚠️ {count} 次调用无价格——尚未填写任何价格，上限无法计入 |
| `estimated` | ℹ️ {count} ta chaqiruv taxminiy hisoblangan (to‘xtatilgan yoki juda katta so‘rov) | ℹ️ {count} вызовов посчитаны приблизительно (прерванные или очень большие запросы) | ℹ️ {count} calls are estimated (stopped, or very large requests) | ℹ️ {count} 次调用为估算（被中断或请求过大） |
| `ledgerFailed` | ⚠️ {count} ta chaqiruv xarajat hisobiga yozilmadi — oxirgi xato: {code} | ⚠️ {count} вызовов не записаны в учёт расходов — последняя ошибка: {code} | ⚠️ {count} calls were not recorded in the spend ledger — last error: {code} | ⚠️ {count} 次调用未记入费用账——最后错误：{code} |
| `byKind` | Ish turi bo‘yicha | По видам работ | By door | 按任务类型 |
| `byModel` | Model bo‘yicha | По моделям | By model | 按模型 |
| `refusals` | Rad etilgan: {count}, zaxira model o‘qigan: {fallbacks} | Отказов: {count}, прочитано резервной моделью: {fallbacks} | Refused: {count}, read by the fallback: {fallbacks} | 拒绝：{count}，备用模型读取：{fallbacks} |
| `ceilingLink` | Chegarani o‘zgartirish (Sozlamalar) | Изменить лимит (Настройки) | Change the ceiling (Settings) | 修改上限（设置） |
| `tier.heavy` | Og‘ir ishlar | Тяжёлые задачи | Heavy work | 繁重任务 |
| `tier.fast` | Tez ishlar | Быстрые задачи | Fast work | 快速任务 |
| `tierHint.heavy` | Invoys, rasm va PDF o‘qish, TNVED guruhlash, bojxona bazasini tanlash, Bojxona 🤖, «📈», admin yordamchisi | Чтение инвойсов, фото и PDF, группировка ТН ВЭД, выбор таможенной базы, 🤖 таможни, «📈», ассистент администратора | Reading invoices, photos and PDFs, TNVED grouping, the customs-baza pick, the customs 🤖, «📈», the admin's assistant | 读取发票、照片和 PDF，TNVED 分组，海关基价选择，海关 🤖，「📈」，管理员助手 |
| `tierHint.fast` | Oddiy hodimlarning AI yordamchisi | ИИ-ассистент сотрудников | The staff's AI assistant | 员工 AI 助手 |
| `primary` | Asosiy model | Основная модель | Primary model | 主模型 |
| `fallback` | Zaxira model | Резервная модель | Fallback model | 备用模型 |
| `fallbackNone` | Yo‘q — rad etilsa qo‘lda | Нет — при отказе вручную | None — by hand when refused | 无——被拒时人工处理 |
| `fallbackHint` | Xavfsizlik filtri rad etsa, shu modelda bir marta qayta uriniladi | Если фильтр безопасности откажет, повторим один раз на этой модели | When the safety filter refuses, the call is retried once on this model | 安全过滤拒绝时，将在此模型上重试一次 |
| `priceInput` | 1 million token kirish, $ | 1 млн входных токенов, $ | 1M input tokens, $ | 每百万输入 token，$ |
| `priceOutput` | 1 million token chiqish, $ | 1 млн выходных токенов, $ | 1M output tokens, $ | 每百万输出 token，$ |
| `save` | Saqlash | Сохранить | Save | 保存 |
| `saved` | ✅ Saqlandi | ✅ Сохранено | ✅ Saved | ✅ 已保存 |
| `refresh` | 🔄 Yangilash | 🔄 Обновить | 🔄 Refresh | 🔄 刷新 |
| `auto` | Avtomatik: oxirgi ishlagan model. Tanlab saqlang — shunda fikrlash kuchi yuboriladi. | Автоматически: последняя работавшая модель. Выберите и сохраните — тогда будет передаваться уровень рассуждений. | Automatic: the last model that worked. Pick and save — then the reasoning effort is sent. | 自动：最后一次工作的模型。请选择并保存——之后才会发送推理强度。 |
| `autoBorrowed` | Tanlanmagan — hozircha «Og‘ir ishlar» modelida ishlayapti (qimmatroq). Hodimlar yordamchisi uchun tez modelni tanlang. | Не выбрана — пока работает на модели «Тяжёлые задачи» (дороже). Выберите быструю модель для ассистента сотрудников. | Not chosen — running on the «Heavy work» model for now (costlier). Pick a fast model for the staff assistant. | 未选择——暂时使用「繁重任务」模型（更贵）。请为员工助手选择快速模型。 |
| `notListed` | ⚠️ Anthropic ro‘yxatida yo‘q (eskirgan bo‘lishi mumkin) — boshqasini tanlang. | ⚠️ Нет в списке Anthropic (возможно, снята) — выберите другую. | ⚠️ Not in Anthropic's list (may be retired) — pick another. | ⚠️ 不在 Anthropic 列表中（可能已下线）——请另选。 |
| `noPrice` | ⚠️ Narx kiritilmagan — xarajat taxminiy sanalmoqda. | ⚠️ Цена не введена — расходы считаются приблизительно. | ⚠️ No price — the spend is estimated. | ⚠️ 未填写价格——费用为估算。 |
| `notChosen` | Tanlanmagan — bu ishlar AIsiz, qo‘lda bajariladi. | Не выбрана — эти задачи выполняются вручную, без ИИ. | Not chosen — this work is done by hand, without AI. | 未选择——这些任务将不使用 AI，由人工完成。 |
| `effortLine` | 🧠 Fikrlash kuchi: {list} | 🧠 Уровень рассуждений: {list} | 🧠 Reasoning effort: {list} | 🧠 推理强度：{list} |
| `effortNotSent` | ⚠️ Fikrlash kuchi yuborilmaydi — Anthropic bu model haqida ma’lumot bermadi (yoki model hali saqlanmagan); model o‘z standart kuchida ishlaydi. | ⚠️ Уровень рассуждений не передаётся — Anthropic не сообщил данных об этой модели (или она ещё не сохранена); модель работает на своём уровне по умолчанию. | ⚠️ No reasoning effort is sent — Anthropic gave no data on this model (or it is not saved yet); the model runs at its own default. | ⚠️ 不发送推理强度——Anthropic 未提供该模型的信息（或尚未保存）；模型按其默认强度运行。 |
| `unknownCaps` | ⚠️ Anthropic bu modelning imkoniyatlarini aytmadi — rasm/PDF o‘qishi tekshirilmagan. | ⚠️ Anthropic не сообщил возможности модели — чтение фото/PDF не проверено. | ⚠️ Anthropic did not state this model's capabilities — image/PDF reading is unchecked. | ⚠️ Anthropic 未说明该模型的能力——图片/PDF 读取未经检查。 |
| `effort.low` | yengil | лёгкий | light | 轻度 |
| `effort.medium` | o‘rtacha | средний | medium | 中等 |
| `effort.high` | kuchli | сильный | strong | 强 |
| `effort.xhigh` | juda kuchli | очень сильный | very strong | 很强 |
| `effort.max` | eng kuchli | максимальный | maximum | 最强 |
| `job.intake.read` | botdagi o‘qish | чтение в боте | the bot's reading | 机器人读取 |
| `job.intake.thread` | chatdagi o‘qish | чтение из чата | the chat reading | 聊天读取 |
| `job.grouping` | TNVED guruhlash | группировка ТН ВЭД | TNVED grouping | TNVED 分组 |
| `job.pick` | bojxona bazasini tanlash | выбор таможенной базы | the customs-baza pick | 海关基价选择 |
| `job.tnved` | Bojxona 🤖 | 🤖 таможни | the customs 🤖 | 海关 🤖 |
| `job.similar` | «📈» | «📈» | «📈» | 「📈」 |
| `job.assistant.staff` | hodimlar yordamchisi | ассистент сотрудников | the staff assistant | 员工助手 |
| `job.assistant.admin` | admin yordamchisi | ассистент администратора | the admin assistant | 管理员助手 |
| `notListedOption` | ⚠️ ro‘yxatda yo‘q | ⚠️ нет в списке | ⚠️ not in the list | ⚠️ 不在列表中 |
| `projection` | Shu narx bilan bu oy: {after} (hozir {now}) | С этой ценой этот месяц: {after} (сейчас {now}) | With this price this month: {after} (now {now}) | 按此价格本月：{after}（当前 {now}） |
| `confirmSave` | Ha, saqlash | Да, сохранить | Yes, save | 是，保存 |
| `repriced` | Bu oyning {rows} ta chaqiruvi qayta hisoblandi: {before} → {after} | Пересчитано {rows} вызовов этого месяца: {before} → {after} | {rows} calls of this month re-priced: {before} → {after} | 已重新计算本月 {rows} 次调用：{before} → {after} |
| `pricesTitle` | Narxlar | Цены | Prices | 价格 |
| `notifMuteAi` | 🤖 AI xarajati va modellar | 🤖 Расходы и модели ИИ | 🤖 AI spending and models | 🤖 AI 费用与模型 |
| `list.state.not_configured` | Serverda ANTHROPIC_API_KEY yo‘q — AI o‘chiq. Kalit qo‘yilgach ro‘yxat chiqadi. | На сервере нет ANTHROPIC_API_KEY — ИИ выключен. Список появится после ввода ключа. | No ANTHROPIC_API_KEY on the server — AI is off. The list appears once the key is set. | 服务器上没有 ANTHROPIC_API_KEY——AI 已关闭。设置密钥后将显示列表。 |
| `list.state.auth` | Kalit ishlamayapti — Anthropic rad etdi. Yangi kalit kerak. | Ключ не работает — Anthropic отклонил его. Нужен новый ключ. | The key does not work — Anthropic refused it. A new key is needed. | 密钥无效——Anthropic 拒绝。需要新密钥。 |
| `list.state.timeout` | Anthropic’ga ulanib bo‘lmadi — «🔄 Yangilash» ni bosing. | Не удалось подключиться к Anthropic — нажмите «🔄 Обновить». | Could not reach Anthropic — press «🔄 Refresh». | 无法连接 Anthropic——请点击「🔄 刷新」。 |
| `list.state.network` | Anthropic’ga ulanib bo‘lmadi — «🔄 Yangilash» ni bosing. | Не удалось подключиться к Anthropic — нажмите «🔄 Обновить». | Could not reach Anthropic — press «🔄 Refresh». | 无法连接 Anthropic——请点击「🔄 刷新」。 |
| `list.state.rate_limited` | Anthropic band — bir daqiqadan keyin «🔄 Yangilash». | Anthropic занят — «🔄 Обновить» через минуту. | Anthropic is busy — «🔄 Refresh» in a minute. | Anthropic 繁忙——请一分钟后「🔄 刷新」。 |
| `list.state.overloaded` | Anthropic band — bir daqiqadan keyin «🔄 Yangilash». | Anthropic занят — «🔄 Обновить» через минуту. | Anthropic is busy — «🔄 Refresh» in a minute. | Anthropic 繁忙——请一分钟后「🔄 刷新」。 |
| `list.state.rejected` | Anthropic ro‘yxatni bermadi — keyinroq «🔄 Yangilash». | Anthropic не отдал список — «🔄 Обновить» позже. | Anthropic did not return the list — «🔄 Refresh» later. | Anthropic 未返回列表——请稍后「🔄 刷新」。 |
| `error.forbidden` | Ruxsat yo‘q | Нет доступа | Not allowed | 无权限 |
| `error.bad_tier` | Noma’lum daraja | Неизвестный уровень | Unknown tier | 未知级别 |
| `error.bad_price` | Narxni raqam bilan yozing (masalan 4.5) | Укажите цену числом (например 4.5) | Type the price as a number (e.g. 4.5) | 请用数字填写价格（例如 4.5） |
| `error.per_token_price` | 1 million token uchun narx yozing, bitta token uchun emas | Укажите цену за 1 млн токенов, а не за один токен | Type the price per 1M tokens, not per token | 请填写每百万 token 的价格，而非单个 token |
| `error.ambiguous_price` | {decimal} dollarmi yoki {thousands} dollarmi? Birini tanlang. | {decimal} долларов или {thousands} долларов? Выберите. | {decimal} dollars or {thousands} dollars? Pick one. | 是 {decimal} 美元还是 {thousands} 美元？请选择。 |
| `error.price_swapped` | Chiqish narxi kirish narxidan arzon bo‘lmaydi — almashtirib yubormadingizmi? | Цена вывода не бывает ниже цены ввода — не перепутаны ли они? | Output is never cheaper than input — were the two swapped? | 输出价格不会低于输入价格——是否填反了？ |
| `error.confirm_needed` | Bu narx bilan oylik xarajat chegaraning 80 foizidan oshadi — rostdan saqlaysizmi? | С этой ценой расходы месяца превысят 80 % лимита — точно сохранить? | With this price the month passes 80 % of the ceiling — save anyway? | 按此价格本月费用将超过上限的 80%——仍要保存吗？ |
| `error.not_listed` | Bu model Anthropic ro‘yxatida yo‘q | Этой модели нет в списке Anthropic | This model is not in Anthropic's list | 该模型不在 Anthropic 列表中 |
| `error.list_unavailable` | Anthropic ro‘yxati o‘qilmadi — saqlab bo‘lmaydi, keyinroq urinib ko‘ring | Список Anthropic не получен — сохранить нельзя, попробуйте позже | Anthropic's list could not be read — cannot save, try later | 无法读取 Anthropic 列表——无法保存，请稍后再试 |
| `error.lacks_images` | Bu model rasm o‘qiy olmaydi — og‘ir ishlar uchun yaramaydi | Модель не читает изображения — не подходит для тяжёлых задач | This model cannot read images — unfit for heavy work | 该模型无法读取图片——不适合繁重任务 |
| `error.lacks_pdfs` | Bu model PDF o‘qiy olmaydi — og‘ir ishlar uchun yaramaydi | Модель не читает PDF — не подходит для тяжёлых задач | This model cannot read PDFs — unfit for heavy work | 该模型无法读取 PDF——不适合繁重任务 |
| `error.lacks_structured` | Bu model tuzilgan javob bera olmaydi — og‘ir ishlar uchun yaramaydi | Модель не даёт структурированный ответ — не подходит для тяжёлых задач | This model cannot give structured output — unfit for heavy work | 该模型无法输出结构化结果——不适合繁重任务 |
| `error.same_as_primary` | Zaxira model asosiysidan boshqa bo‘lsin | Резервная модель должна отличаться от основной | The fallback must differ from the primary | 备用模型须与主模型不同 |
| `error.price_missing` | Tanlangan model uchun ikkala narxni yozing | Укажите обе цены для выбранной модели | Type both prices for the chosen model | 请为所选模型填写两个价格 |
| `error.server_behind` | Tizim yangilanmoqda — bir daqiqadan keyin | Система обновляется — через минуту | The system is updating — in a minute | 系统正在更新——请一分钟后 |
| `kind.intake` | O‘qish (bot va suhbat) | Чтение (бот и чат) | Reading (bot and chat) | 读取（机器人与聊天） |
| `kind.grouping` | TNVED guruhlash | Группировка ТН ВЭД | TNVED grouping | TNVED 分组 |
| `kind.pick` | Bojxona bazasini tanlash | Выбор таможенной базы | Customs-baza pick | 海关基价选择 |
| `kind.invoice` | Invoys | Инвойс | Invoice | 发票 |
| `kind.similar` | «📈 Oldingi narx» | «📈 Прошлая цена» | «📈 Past price» | 「📈 历史价格」 |
| `kind.assistant` | Yordamchi | Ассистент | Assistant | 助手 |
| `kind.tnved` | Bojxona 🤖 | 🤖 таможни | Customs 🤖 | 海关 🤖 |
| `kind.deal_import` | Bitim tovarlari importi | Импорт товаров сделки | Deal goods import | 交易商品导入 |



---
## 14. Tests

### 14.1 K's own tests (each with a red proof by STRING EDIT — never `git checkout`)
Every unit test of the runner mocks `@/modules/platform/ai/ledger`'s `spendGateMonth`
(scripted per case) and passes `plan` — no Postgres in a unit run.

`tests/unit/ai-run.test.ts` (the stand-in, §5 K10):
1. An answer → `ok`, one attempt whose `model` is the MESSAGE's and whose
   `requestedModel` is the plan's; the request body carries `model` from the injected plan,
   `output_config.effort`, `max_tokens`, and NONE of `thinking`, `temperature`, `top_p`,
   `top_k`, `tool_choice`, `fallbacks`, `betas`. **Red:** add `thinking: { type:
   'adaptive' }` to the body.
2. `sse-refusal` then `sse-message` → the second body names the FALLBACK, `servedBy
   'fallback'`, two attempts with roles. **Red:** delete the fallback branch → `refused`,
   one body.
3. Both refuse → `refused_fallback`, two attempts.
4. No fallback / fallback = primary / `canServe` false / left < `FALLBACK_FLOOR_MS` /
   category `reasoning_extraction` / the month gate `'month'` before the hop → `refused`,
   ONE body each. **Red:** drop the floor check → a fallback with 1 s left.
5. `sse-stall`, leash 1.5 s → `timeout` at ≈ 1.5 s; the attempt has `inputTokens`,
   `stopReason 'aborted'` and `outputTokens` = the estimate (> 1, ≤ the clamped
   `max_tokens`). **Red:** drop the `signal` → completes after the stall; **red:** take
   the snapshot's `output_tokens` → 1.
6. `sse-error` (`overloaded_error` after `message_start`) → ONE billed attempt with
   `stopReason 'stream_error'`, then one retry on the same model. **Red:** revert K4's
   branch → `rejected`, no retry.
7. 529 then an answer → the primary retried; the fallback never called; a 429 with
   `retry-after: 5` and a 20 s leash → the second request ≥ 5 s after the first; with a
   6 s leash → no retry (it would not fit). **Red:** ignore the header → the retry comes
   at 2 s.
8. `max_tokens` / `model_context_window_exceeded` → `truncated` WITH `message`, no fallback
   request.
9. 404 on the primary → the fallback served and `noteModelUnavailable` called ONCE with
   `outcome 'served'` AFTER the fallback; 404 + fallback 404 → `model_unavailable`, outcome
   `fallback_missing`; 404 + `canServe` false → outcome `fallback_failed` (⭐ Q2 a).
   **Red:** drop the 404 branch → `model_unavailable` with one request.
10. Clamp: asked `high`, snapshot efforts `['low','medium']` → body `medium`; snapshot null
    → no `effort` key; efforts `[]` → no `effort` key; `max_tokens` clamped to the
    snapshot's cap. **Red:** always send the asked effort.
11. No key → `not_configured`, ZERO requests; tier NULL → `model_not_chosen`, zero
    requests; the gate `'month'` → `ceiling`, `'off'` → `off`, zero requests; the gate
    flipping to `'month'` between the primary's 529 and its retry → `ceiling`, ONE
    request, the attempt kept; `purpose 'compare'` → a request even over the ceiling, and
    no retry and no fallback after a 529 / a refusal.
12. **The budget**: table test over [529, 529, refusal], [refusal, 529, 529], [404, 529,
    529], [529, refusal] — the stand-in's request count never exceeds 3 and each final
    word is as §5 K5 step 3 says. **Red:** count the retry per model → a 4th request.
13. **Never throws**: `tierPlan` mocked to throw → `server_behind`, zero requests;
    `spendGateMonth` mocked to throw before the fallback → the fallback still runs (the
    gate fails open) and the refused attempt is kept; a `read` that throws →
    `unreadable` with one attempt; a leash of 0 and of 1500.5 → `timeout` / a request with
    a 1500 ms signal (never a RangeError). **Red:** remove the outer catch → the promise
    rejects.
14. **Thinking tokens**: an `sse-message` whose `thinking_tokens` arrive ONLY in
    `message_delta` → the attempt carries them. **Red:** read the final snapshot alone →
    null. And `auth` (401) → `noteKeyRefused` called once, failure `auth`.

`tests/integration/ai-ledger.integration.test.ts` (real database; a PRIVATE test model id;
its price row and its ledger rows deleted in `afterAll`; the ceiling setting snapshotted
once in `beforeAll` (#716) and set RELATIVE to the measured spend; month-boundary rows at
`monthStart ± 1 s` computed with `tashkentDayStart(tashkentMonthStart())`, never «now minus
a day» — the 09-25 answer R5's 19:00-24:00 UTC lesson):
15. Cost: 1 234 in / 5 678 out / 100 cache-write (10 of them 1 h) / 50 cache-read at typed
    rates → the hand-computed literal to 6 places. **Red:** `AI_CACHE_WRITE_1H = 1.25`.
16. Frozen: a price edited after the row's MONTH closed → the row unchanged; a NULL row
    filled once by `fillUnpriced`, then frozen; a correction inside the month →
    `repriceMonth` re-prices this month only. **Red:** drop `AND cost_usd IS NULL` from the
    fill.
17. A raw INSERT of a `'NaN'` price is refused by the CHECK. **Red:** remove `<> 'NaN'`.
18. The month window counts `+1 s` and not `−1 s`; the SQL text contains `AT TIME ZONE
    'Asia/Tashkent'` and the month label comes from the same statement. **Red:** drop the
    zone.
19. `spendGateMonth`: ceiling = the measured spend → `'month'`; +0.01 → `'ok'`; ceiling 0 →
    `'off'` (⭐ Q3 a); a raw jsonb string `'"abc"'` as the setting → read as 100 with the
    warning (never `'ok'` for ever). **Red:** `>` for `>=`; **red:** unreadable → Infinity.
20. The day cap's positive list: an `'assistant'` row does not move
    `aiCalcBudgetLeft()`. **Red:** restore `kind <> 'similar'`.
21. `aiCostUsd` equals the SQL EXACTLY on 50 rows from a seeded generator, including
    half-micro ties. **Red:** compute the twin in floats → a tie row differs.
22. `tierPlan`: NULL model → `model_not_chosen`; fast NULL + heavy set → the heavy plan,
    `borrowed: true`; the 60 s cache (injected `now`); `forgetTierPlans` → fresh at once;
    `chosenByPerson` from `chosen_at`. Tier rows snapshotted and restored (#183).
23. The migration's continuity INSERT, run in a rolled-back transaction: copies the newest
    model into `heavy`, leaves `fast` NULL; a ledger with no rows copies NULL (the 0099
    backfill-test precedent).
24. **The unpriced gate**: rows of a model with no price + one other priced model → the
    month counts them at the HIGHEST typed price (`estimatedUsd > 0`), `unpricedCalls` = n;
    no price anywhere → `noPriceAtAll`, estimated 0. A row whose `requested_model` has a
    price but whose answered `model` has none → priced at write. **Red:** sum NULL as 0.
25. **The race heal**: a ledger INSERT held open on a second connection across a price
    save, committed after the save's fill → NULL; `fillUnpricedAll()` → priced.
26. **Explicit casts**: `recordAiCall` with every numeric field a JS number writes a row
    (the VALUES are cast). **Red:** drop the `::int` casts → the row is missing and
    `noteLedgerFailure` was called.
27. **The wrapper forwards everything**: `recordAiPass({ kind: 'grouping', requestId,
    ...usage })` with `fallback: true, stopReason: 'refusal', tier: 'heavy', thinkingTokens:
    50` → the row carries all four. **Red:** restore today's flat input type → the four read
    default.

`tests/unit/ai-ledger-writer.test.ts` (derived): no `.ts` / `.tsx` file in `src/` except
`platform/ai/ledger.ts` contains `insert(aiCalcPasses`, `update(aiCalcPasses`, `INSERT INTO
ai_calc_passes` or `UPDATE ai_calc_passes` (comments stripped FIRST, #725; the fence's own
pattern built from pieces; the hand-written `.sql` migrations under `src/` are out of
scope). **Red:** put a raw INSERT back into `intake-land.ts`.

`tests/unit/ai-bill-spread.test.ts` (derived): every `recordAiPass(` / `recordAiCall(` call
in `src/` passes a usage object by SPREAD (`...u`, `...usage`) or as the second argument —
never `model:` plus token counts listed by hand (comments stripped). **Red:** list them by
hand in `runIntakeRead`.

`tests/unit/ai-run-callers.test.ts` (derived, STAGED — §5 K10): in K, the files calling
`runModel(` in `src/` are a SUBSET of `platform/ai/model.ts`, `wms/calc/intake-ai.ts`,
`wms/calc/prefill-ai.ts`, `wms/tnved/service.ts`, `wms/finance/similar-ai.ts`, and
`new Anthropic(` outside `platform/ai/` appears only at the allowlisted sites still
waiting for their package; at M the subset becomes EXACTLY that list (a new caller is added
on purpose), each of their exported model functions returns its attempts (`answered` /
`usages` / `attempts`), and `new Anthropic(` exists only in `platform/ai/run.ts` and
`platform/ai/models-list.ts`. No `messages.parse(` anywhere in `src/` and no object with a
`parse` key passed as `format` (durability: a parsing format throws before `stop_reason`
is read). **Red:** a stray `new Anthropic(` in `tnved/service.ts` after P2.

`tests/unit/ai-tiers.test.ts`, `tests/unit/ai-failure.test.ts`, `tests/unit/ai-profiles.test.ts`
(`AI_JOBS['intake.read'].leashMs === INTAKE_TIMEOUT_MS` from the test side — green in K,
both 150 000; every job's `maxTokens ≥ 8 000` — R1's trap stated as a floor),
`tests/unit/ai-cost-mocks.test.ts` (K10).

### 14.2 Existing tests that pin today — re-run, re-anchor with the reason recorded, never delete (#166)
| File | Pins | R5 |
|---|---|---|
| `tests/unit/intake-round1.test.ts:43-105` | `readIntakeResponse` outcomes + usage on failed reads; `aiFailureOf` with SDK classes; every failure has words | `model` = the message's (optional input); the moved `aiFailureOf` re-exported; the six new members worded |
| `tests/unit/intake-weight-basis.test.ts:91`, `tests/unit/intake-corpus.test.ts:1185` | call `readIntakeResponse` with today's shape | compile unchanged (`model?` optional) |
| `tests/unit/intake-ai-wire.test.ts` | prompt text, cut notes, retry timings (stand-in) | extended (P2 §7.8); mocks `tiers` and `spendGateMonth`, or every case reads `model_not_chosen` / touches Postgres |
| `tests/unit/intake-answered.test.ts` (R2) | the reading's bill against a real `analyzeIntake` | P2 §7.8.3: SSE frames, the two mocks, `toMatchObject` |
| `tests/unit/intake-corpus.test.ts:690-718` (`withStandIn` / `realAnalyze`), `:1118-1122`, `:1523` | the real `analyzeIntake` against error stand-ins (timing pins c0790, c0794) | mock `@/modules/platform/ai/tiers` and `spendGateMonth` in the same file (one block) |
| every `vi.mock('@/modules/wms/calc/ai-cost', …)` factory (on the R2 tree: `intake-corpus.test.ts:35`, `intake-collector-r3.test.ts:16`, `intake-collector-r4.test.ts:18`, `intake-collected-goods.test.ts:12`, `totals-question.test.ts:18`; plus R3's `tests/unit/helpers/calc-read-drive.ts` and new collector files) and `tests/integration/intake-usage.integration.test.ts:21-35` (spreads the real module) | `aiCalcBudgetLeft: async () => 100` | K adds `aiReady: async () => 'ok'` to each (K10); `ai-cost-mocks.test.ts` refuses a factory without it — a missing export THROWS, and the real gate in the spread answers `not_configured` in CI |
| `tests/unit/bot-ai-dispatch.test.ts:65-72`, `:104-109`; `tests/unit/similar-ai.test.ts:86-88` | each client carries its own `timeout` | re-anchored on `run.ts` (`AbortSignal.timeout(`, `maxRetries: 0`) — P5 §10.5.7 |
| `tests/unit/similar-ai.test.ts:99-115` | no paid step before the claim; the day budget named | re-anchored on `aiReady(` and its position (P3); + the claim pin |
| `tests/unit/ai-advisory.test.ts:95-124` | the pick's schema slice between `type: 'json_schema'` and `messages: [` in `prefill-ai.ts` | the slice follows the schema's new home (it moves into the `format:` argument of `runModel` in the same file) — reason: moved |
| `tests/unit/batch-door-wire.test.ts:214-230` | `suggestTnved({` after the door | + `aiReady(` before the photo read; the bill in both branches (P3) |
| `tests/integration/ai-cost.integration.test.ts:109-183` | row per call; never throws; the two day budgets apart | the literal ids at `:115`, `:151` → `'test-model-a'` AND both oracle queries on the positive list (K10) |
| `tests/integration/price-icons-matrix.integration.test.ts:134-155` | the anchor CHECK by raw INSERT | extended to the three new kinds (P3 §8.5.4) |
| `tests/integration/ai-assistant.integration.test.ts` | the tool loop with a scripted `CallModel`; the atomic daily cap | extended (P5 §10.5); the scripted responses compile unchanged (`attempts` optional); `afterAll` deletes its ledger rows first (§10.5.5) |
| `tests/integration/calc-regroup.integration.test.ts:35-58`, `:188-192` | mocks `proposeGoodsGrouping`; the `.not.toContain(remembered)` fence | mocks return `usages: []`; `asked.length > 0` asserted first (P2 §7.8.9) |
| `tests/integration/batch-door.integration.test.ts:35-41`, `:408-415` | mocks `suggestTnved`; «answers for a lot on the truck» | `usages: []`; the gate through the `ready` seam (P3 §8.5.2) |
| `tests/integration/calc-prefill.integration.test.ts` (11 cases with `configured: true`, e.g. `:205-208`, `:290`, `:454-458`, `:587-588`) | the AI half with injected `propose`/`pick` | green through the two-sided seam (P2 §7.6); new `deps.ready` cases |
| `tests/integration/customs-estimate.integration.test.ts:300`, `:441-452` | «no pick past the deadline» | re-anchored so it fails for the DEADLINE (P2 §7.8.10) |
| `tests/integration/calc-table.integration.test.ts:436-457` | the claim heals on the lock's clock (its comment: «this container has no key») | the gate seam + a POSITIVE claim assertion (P2 §7.8.11) |
| `tests/integration/grouping-count.integration.test.ts:11-21`, `:146-176`, `:202-221` | the count rule via a mocked `messages.create` | onto the SSE stand-in; `ai_refused`; arrays (P2 §7.8.12) |
| `tests/unit/calc-row-draft.test.ts:525-535`, `tests/integration/calc-phone.integration.test.ts:227-240` | the 10/11-minute claim literals | re-anchored on `AI_CLAIM_STALE_MS` (P2 §7.5) |
| `tests/unit/proposal-wire.test.ts:53-69` | the claim released before the tail | kept; the release now carries the token |
| `tests/unit/calc-clock.test.ts:77` | `proposeGroups` exempt from the rev clock («its claim is the serialization») | still true with the token |
| `tests/unit/calc-error-words.test.ts:20-66` | every `new CalcError('…')` in `wms/calc` has words ×4 | `bad_note`, `already_reading` (K's `calc.threadErrors.*`); `ai_off` (K's `calc.errors.ai_off`) |
| `tests/unit/locales.test.ts:176-210` | every setting described ×4 | the new setting; + the `badValueFor` rule (§13.1) |
| `tests/unit/i18n-keys.test.ts` | every literal `t('…')` key exists | P4 deletes uses before keys |
| `tests/unit/notification-mutes.test.ts:29-90`, `tests/unit/kuzatuv.test.ts:350-360` | literal group records; `system` born whole | `ai:` added (five types); `system` untouched |
| `tests/unit/migration-journal.test.ts` | order, holes, no placeholder | the new file |
| `tests/unit/tx-pool.test.ts` | no pool read inside a transaction | must stay green (the new pool readers join its set; the claim reads on `tx`) |
| R3: `calc-read-press.test.ts` (SUM pin), `calc-read-job.integration.test.ts` (leash shrink), `intake-billing.integration.test.ts` | the reading's clock and bill | the clock UNCHANGED (green untouched); the bill gains the fallback row and the whole usage (P2) |
| R2: `intake-usage.integration.test.ts`, the grouping/pick count tests | the count rule | the count unchanged; arrays; dollars added |
| `tests/unit/thread-calc-wire.test.ts`, `tests/unit/deal-terms-wire.test.ts:89-93`, `tests/integration/deal-ved.integration.test.ts:626-638`, `tests/integration/thread-calc.integration.test.ts`, the corpus/typed thread pins | the chat door's two presses | P4 §9.6 |
| e2e `m9u-deal-money`, `m9zz-ish-joylari.desktop`, `m9g-access` | the keyless deal import; every menu link 200; the operator bounced | green; the new door covered by P1's e2e (the month bar asserted by SHAPE) |

**CI's one database** (CLAUDE.md ritual 5): every new vitest file that writes ledger rows,
price rows or tier rows deletes them in `afterAll` (a price row is CONFIGURATION, #183), and
every oracle over `ai_calc_passes` is filtered by kind, anchor or a private model id —
never «today's rows».

---


## 15. The seams — R5 starts from `main` AFTER R2 and R3 are merged

### 15.1 Round 2 (`docs/SAKKIZ-R2.md`) — what it changed that R5 also touches
| Function / constant | R2 did | R5 does |
|---|---|---|
| `pickImportRows` (`prefill-ai.ts`) | returns `PickOutcome { answers, usage }` (K5) | `usages[]` (+ `refused?`); on the runner (`job 'pick'`) |
| `pickBazas` (moved to `prefill-steps.ts`) | `await recordAiPass({ kind: 'pick' })` | records each of `usages` by spread; K9 extracts `pickRequestsFor` from it verbatim |
| `proposeGoodsGrouping`, `groupingListing`, `TnvedError(code, usage?)` | richer listing; usage on every answered exit | `usages[]`; on the runner; four new codes |
| `proposeGroups` | records `err.usage` | uncoded-count first, token + heartbeat + deadline + gate between batches; records `usages` by spread; the answered batches applied on a deadline |
| `aiPrefill` (`prefill.ts`) | `PASS_DEADLINE_MS`; the flag `hasKey && budgetLeft > 0`; the deadline before the pick and the medians; `deps.configured` | `aiReady` behind a TWO-sided `deps.configured` seam + `deps.ready`; `aiStood` incl. the mid-pass outcomes; the deadline passed into `proposeGroups`; the refused-reading skip |
| `PASS_EXPIRE_S` (`jobs.ts`) | 1800, «2 × 60 s per step» in a comment | re-derived and PINNED (§7.6) |
| `aiVedReplyText` (`ai-reply.ts`) | `budgetSpent?: boolean` | `aiStood` (§2.2) |
| `analyzeIntake` / `AiIntakeOutcome` / `INTAKE_TIMEOUT_MS` | `answered: AiUsage[]`; prompt edits; 150 000 kept | on the runner; `servedBy`; `job` input; `INTAKE_TIMEOUT_MS` UNCHANGED |
| `IntakeState.usages`, `landIntake`'s records | appended per analysis; recorded at landing | (R3 retires both — see 15.2) |
| `threadCalcAnalyze` / `cleanFacts` / `threadCalcSend` | section, `totalWeightFrom`, `volumeAmbiguous`, `weightNetto` | the merge MOVED verbatim into `threadReadFacts`; `threadCalcAnalyze` deleted |
| `queueCalcPrefill` / `sayOnce` / the two queues | sections; one machine message per request | relied on by the thread job (unchanged) |
| The count rule (R2 §7.5) | a call counts when the model answered it | unchanged; refined for streams (any attempt whose stream had begun is billed, its output estimated, §0.1.6) |
| R2's tests that R5 re-anchors | `intake-answered.test.ts`, `grouping-count.integration.test.ts`, `calc-prefill.integration.test.ts`, `calc-regroup.integration.test.ts`, `customs-estimate.integration.test.ts` | §7.8 items 3, 8-12 |

### 15.2 Round 3 (`docs/SAKKIZ-R3.md`) — what it changes that R5 also touches
| Function / constant | R3 does | R5 does |
|---|---|---|
| `calc.intake-read` job: `runIntakeRead`, `pressAnalyse` (`platform/telegram/calc-read.ts`) | the reading on pg-boss, 4 workers, one wall clock | step 5's `recordAiPass({ kind: 'intake', requestId, intakeNoteId, staffId, … })` passes the WHOLE usage by spread (P2 owns this edit) |
| `INTAKE_READ_EXPIRE_S` + the SUM pin (`calc-read-press.test.ts`) | 300; 290 ≤ 290 | UNCHANGED (R5 keeps `INTAKE_TIMEOUT_MS` 150 000) |
| `ANALYSIS_STALE_MS` | derived from the expiry | unchanged |
| `analyzeCollected(state, files, { timeoutMs })` | the reading's call, the day-budget gate kept | the gate becomes `aiReady`; sets `readByFallback` on the analysed state (P2 §7.3) |
| `settleAnalysis` | its usage assignment retired; an explicit list of fields copied from `analysed` | `readByFallback` ADDED to that list |
| `ai-cost.ts` `AiPassAnchor` + `attachIntakePasses` (K15) | the note anchor; the landing attaches | the union grows (three kinds); the body moves to `platform/ai/ledger.ts` (`attachIntakeCalls`), the wrapper keeps the name; `recordAiPass` gets the exact type of §5 K6 |
| the `calc_intake_durable` migration: `ai_calc_passes.intake_note_id` + the anchor CHECK (CASE) | added | the CASE extended BY NAME in R5's migration (must run after it) |
| `proposeGroups(id, ctx, { expectRev, handsOff })` (K15) | claim `AND rev = $expect` | the token sits beside it in the same UPDATE; `deadline` added |
| `queueCalcPrefill({ …, pass, atRev })` ticket | one pass per landing | the thread job's step 1 relies on it |
| `enqueue(…, { id, startAfter })` returns the id; `jobState` | added | the thread press uses `options.id = noteId`; `threadReadsPending` reads `pgboss.job` the way `jobState` does |
| `landRequestHalf` / the landing input | extracted; attaches instead of recording | passes `fallbackServed` AND `aiFailure` to `intakeNoteText` |
| `calc-files.ts` `reduceForModel` / `loadIntakeFiles` | moved, the model-sized copy | `reduceForModel` exported for P6 (K9) |
| `tests/unit/helpers/calc-read-drive.ts`, the collector source list (K16), new collector test files | the drive helper; the fence list | every `ai-cost` factory mock gains `aiReady` (K10, found by grep) |

### 15.3 Round 4 (another session — a new deal per request, 6.8 b's lead)
- Round 4 owns `dealFor` / `calcDealOwnerFor` and `threadCalcSend`'s CLIENT path. R5 does not
  touch that block (P4 only narrows the actor type and adds two optional inputs).
- **R5 makes `threadCalcSend` re-runnable by pg-boss** (the thread job). R3 §14.3 already
  obliges round 4 to make a landing idempotent by the note id (a stamp on the new deal/lead,
  found first on a re-land, or the target and the note in ONE transaction) — for the BOT
  path. R5 asks round 4 to make the SAME contract cover `threadCalcSend`'s client path,
  because today `dealFor` runs BEFORE `openCalcRequest` (`from-thread.ts:330` (R2)), so a job
  killed between the deal and the note would mint a second, empty deal on redelivery.
- **`landIntake`'s input type** is edited by three rounds: R3 removes `usages`, round 4
  extends it, R5 P2 adds the two note inputs (`fallbackServed?`, `aiFailure?`) on its way
  to `intakeNoteText` (R3 named this conflict: `docs/SAKKIZ-R3.md`, its judge's regression-19 b). On a
  conflict: round 4's fields, no `usages`, plus R5's two optional inputs.
- **`calc.threadQueuedClient`** says only «So‘rov VED navbatiga tushadi» — true whichever
  card round 4 sends a client's request to (his 6.8 b sends another seller's client to a
  NEW LEAD in the sender's funnel). If round 4 merged first, re-read its client path and
  confirm the sentence still holds.
- If round 4 merged before R5 starts: read its landing and confirm the note-id contract
  covers the thread path; the thread job's step 1 («already landed?») then covers the rest.
  If it has not: build R5 as specified, and STATE the exposure (one empty deal per process
  death inside a few milliseconds of one press) in the report and to round 4's session.

### 15.4 Round 8 (another session — one-line tarkib)
No code overlap (no AI). Two shared resources only: the migration number (read the
journal tail) and `messages/*.json` (anchor R5's hunks at the keys named in §13).

---

## 16. Merge, gates, verification (the lead — you)

1. **The start gate, then K.** Check the header's start gate on `origin/main`; cut
   `sakkiz-r5`; send §19.1 to him if not yet sent. Before K: read Anthropic's pricing page
   (the cache multipliers, §3.2) and rate-limits page (the output-tokens rule, §4) through
   the proxy and record both findings in the report. Fresh `gsr_ci`: migrate, seed,
   `seed:demo`. `pnpm typecheck` / `pnpm lint` / the AI, calc, thread, intake unit and
   integration suites — each with its own exit code and its own failure marker grepped
   (#803). K is behaviour-unchanged: every new seam's K value reproduces today (the runner
   unused, `checkSpendLevel` inert, the arrays of one element, the positive kind list equal
   to `<> 'similar'` while no other kind exists, `INTAKE_TIMEOUT_MS` and the profile both
   150 000, the staged fences in their K form). The full calc suite passing unchanged,
   apart from the named mechanical updates (K10), is the proof. Commit; write the hash at
   the top of `docs/SAKKIZ-R5.md`.
2. **Packages in worktrees off K** (4 CPUs → two workflow agents at a time, #1339; resume a
   restarted build IN PLACE). Wave 1: P1, P2, P3, P4, P5 — each typechecks off K because K
   froze every shape and added the inert `job?` / `run?` parameters (P4 mocks
   `analyzeIntake` in its tests). Wave 2: P6, branched from `sakkiz-r5` AFTER P1 and P2 are
   picked (it calls P1's `liveModels` and P2's wired `run?`). Each package: typecheck, lint,
   its touched unit and integration tests against its own `gsr_<pkg>` database; every red
   proof by string edit; commit; report its branch. A worktree agent starts at the last
   MERGE, not the branch head — name the base commit (K's hash, or the wave-2 base).
   Packages never edit K's files (`platform/ai/{tiers,profiles,failure,run,ledger,ready,
   door}.ts`, the stand-in helper); a gap there is a K follow-up commit on `sakkiz-r5`,
   picked before the package.
3. **Cherry-pick order: P2 → P3 → P5 → P4 → P1 → P6.** P4 consumes P2's wired
   `analyzeIntake({ job })` at runtime; P6 consumes every model function's `run?` and P1's
   list; P1, P3, P5 are independent. File sets are disjoint (§6.1-§11.1) except
   `hisoblash/actions.ts` (P2: `proposeAction`; P4: the thread actions — hunks apart, P2
   first); `messages/*.json` hunks are anchored apart (K added nearly all keys; P1 adds
   `aiModels.*`; P4 removes four). After each pick: `pnpm typecheck`.
4. **M — the no-id step (the lead, after every pick):**
   - Rewrite, with the tier word («og‘ir daraja modeli» / «tez daraja modeli»), exactly the
     comments that name a model family — on the R2 tree: `platform/telegram/calc-intake.ts:1357`,
     `platform/telegram/staff-handlers.ts:2741`, `wms/calc/intake-ai.ts:119`,
     `tests/integration/calc-prefill.integration.test.ts:480`,
     `tests/unit/bot-ai-dispatch.test.ts:78` — re-found on the merged tree with `git grep
     -n -i -w` of the two constants' middle words (read them in `model.ts:51-52` before
     deleting the constants).
   - **NOT touched**: the same grep also finds the Ogg voice codec, whose name is one of
     those words — as CODE in the upload allowlist (`platform/files/service.ts:41`, `:82`)
     and the voice-note planner (`wms/crm/telegram-import.ts:440`, `:453`), and in comments
     ABOUT the codec (`telegram-import.ts:381`, `:546`, `app/api/calls/audio/route.ts:34`,
     `tests/unit/tg-media-plan.test.ts:45`, `:64`). Never `sed` the word: a mechanical
     rewrite breaks voice-note storage (`isStorableType`) and makes the codec comments
     false.
   - Delete `ANALYST_MODEL` / `STAFF_MODEL`; `pnpm typecheck` names any straggler.
   - Sweep the docs: `git grep -n -i -E "claude[- ][a-z]+[- ][0-9]" -- . ':!pnpm-lock.yaml'`
     — at `62a23bf` it found `docs/AI-VED-RASTAMOJKA-MAP.md` (≈25 lines, a few of them false
     positives), `docs/AI-VED-RASTAMOJKA.md` (2), `docs/RASTAMOJKA-TUZATISH.md` (1),
     `CLAUDE.md` (3, the round-100 paragraph and two calc paragraphs), `DECISIONS.md` (3),
     `src/` (2), `tests/` (2). Replace each id with «og‘ir daraja modeli» / «tez daraja
     modeli». A QUOTED commit trailer (`docs/RASTAMOJKA-TUZATISH.md:53`,
     `docs/AI-VED-RASTAMOJKA-MAP.md:2157` and `:2241`) becomes «the attribution trailers
     used throughout the history». DECISIONS and CHANGELOG entries are records: only the
     literal is replaced, the sentence keeps its meaning — the hard rule covers every
     pushed artifact. Your own commits keep the harness's trailer (header).
   - Add `tests/unit/no-model-id.test.ts` (§1) and run it; allowlist a true false positive
     by exact `file:line-content`. Tighten `ai-run-callers.test.ts` to its M form (§14.1).
5. **On the merge:** `pnpm typecheck`, `pnpm lint`; the full vitest on a fresh `gsr_ci`,
   seeded once; Playwright WITHOUT re-seeding (CI's order); `fuser -k 3000/tcp` before e2e;
   no `CI=1`. `grep -rhoE "https://[a-z.]+/" .next/static/` (no new browser library is
   expected; the Models API is called server-side only).
6. **Measured, not argued, before the push:**
   - the migration on a copy at R3's ledger: every CHECK passes, the continuity copies the
     newest model into `heavy` and leaves `fast` NULL, the staff FK is SET NULL (by its real
     name), the count reads the journal's length;
   - `aiMonthSpend()` and the claim statement on 50 000 synthetic month rows (one index
     range scan on `ai_calc_passes_day_idx`) — record the times;
   - screenshots of `/admin/ai` (no key; and with a stand-in list via `ANTHROPIC_BASE_URL`:
     a borrowed fast tier, an unknown-capabilities model, an unpriced model, a refused save
     that kept its values) and of the `/profile` box at 360×800 and 1280×900, document width
     = viewport at both; the chat island at 360 (queued, pending, landed-with-reason);
   - **not measurable here**: a real model call and the live Models API — both need HIS
     key (the API answers 401 without one; Anthropic's docs ARE reachable through the
     proxy). The comparison IS that measurement, on his server, after the deploy (§18).
     Say so.
7. **Docs:** `docs/SAKKIZ-R5.md` and `docs/SAKKIZ-R5-MAP.md` were committed at handoff —
   update them with K's hash and anything re-fitted; `docs/SAKKIZ-BAND.md` §4 status + §10
   «R5 SHIPPED» with the DECISIONS range, and §11 his answers to 3.9-3.18; DECISIONS
   `#R5-*` renumbered after a fetch; CHANGELOG in Uzbek; CLAUDE.md: the state paragraph
   (migration, ledger, «the AI screen exists — pick «Tez ishlar» first, type prices, run the
   comparison, then pick «Og‘ir ishlar»») and a row in «Where the truth lives»;
   `docs/AI-VED-RASTAMOJKA.md` «What differed» (the model from the screen, effort, the
   fallback, dollars); **`docs/UPDATE.md` gains an Uzbek section «AI modellar va xarajat —
   tekshiruv tartibi»** carrying §18's steps in his language (the backup per UPDATE.md §1,
   the build, the count read off the repo + `/api/version`, the screen steps in order, the
   comparison commands, «loglarni yuboring») — the list he actually deploys from.

---

## 17. Not this round (said to him)

- **Anthropic's server-side fallback parameter.** It routes inside one request, but a
  fallback outside the primary's allowed list makes EVERY call of the tier a 400 (his free
  pick on the screen could be one), its simplest form is not typed in SDK 0.114.0, and
  billing would have to walk per-hop usage. The client-side retry does exactly what 3.7 a
  asked. A later round may adopt it after an SDK bump.
- **Prompt caching** — and with it the cache-read price input on the screen (the column
  exists). The admin assistant's schema card is the obvious candidate; the ledger already
  records cache tokens, so the saving will be visible when it comes.
- **The chat door reading photos and files** — round 6 («one reader over all material»). The
  job payload carries message ids, so round 6 adds the attachments without a payload
  change.
- **The silent input cuts**, stated: the typed material at 20 000 characters
  (`intakeContent`), the pick listing at 40 000 characters (cut mid-row), «📈»'s question at
  20 000. A stronger model reading more is round 6's subject.
- **A hard ceiling** (an in-process reservation of every in-flight worst case — §3.4),
  per-person or per-door dollar caps.
- **The «chuqur o‘qish» button** (his 3.1 c, not chosen).
- **Effort or `max_tokens` on the screen** — code only (a review, not a press).
- **Re-pricing a CLOSED month when a price is edited** — frozen by design; only the open
  month is corrected (§3.1).
- **An AI-spend tile on the admin dashboard** — the screen and the Telegram messages only.
- **Removing the day caps** — kept as runaway backstops (⭐ Question 10).
- **Per-message effort, task budgets, fast mode, the Batch API, priority tier.**
- **Counting the comparison in the $100** (⭐ Question 8).
- **Modelling the long-prompt price** — such rows are marked «taxminiy» instead (§3.2).
- **Preventing a second paid reading when a chat job's landing fails twice and pg-boss
  redelivers** — the landing retries once in-process; beyond that it is stated (§9.3).
- **`tg-listen`** — it makes no AI call.

---

## 18. Deploy notes — and what he does on the screen after it

These steps go into `docs/UPDATE.md` IN UZBEK (§16.7) — that is the list he deploys from;
this English text is the lead's. He runs every command; the lead cannot reach his server.

1. **Backup first** — the commands of `docs/UPDATE.md` §1, and the dump checked non-zero
   (CLAUDE.md: a verified non-zero backup before every production update). Then the merged
   PR → on the server: `git pull`, `docker compose build migrate app`, `docker compose up -d`
   (the bot runs in `app`; `tg-listen` untouched).
2. **Count the ledger** (`drizzle.__drizzle_migrations`) — it must equal the journal's length
   (read it off the repo, `ls src/modules/platform/db/migrations/*.sql | wc -l`, never carry
   it over), AND read `curl -s https://gsrwms.uz/api/version` (the build stamp). Anything
   short → read the `migrate` container's own output; fix with `docker compose run --rm
   migrate`.
3. What is true the minute it is up, said to him BEFORE he opens the screen:
   - the calc work runs on exactly today's model (the migration copied it into «Og‘ir
     ishlar»), without the strong reasoning until he SAVES a pick (the save records what the
     model supports);
   - the ordinary staff's assistant runs on that same heavier model until he picks «Tez
     ishlar» (⭐ Question 9) — costlier per question;
   - the $100 ceiling cannot count anything until he types a price; a Telegram reminder
     comes once a day until he does.
4. **He opens «Boshqaruv → AI: modellar va xarajat»** and, in this order:
   1. **«Tez ishlar»**: picks the fast model the lead names in chat, types its two prices,
      saves. It needs no comparison (the comparison measures the calc jobs only).
   2. Types the two prices of the model «Og‘ir ishlar» runs on today (marked «Avtomatik»)
      — this month's earlier calls get their dollars at once.
   3. Types the prices of the HEAVY candidates the lead names in chat (the newest strong
      model; today's model is already priced and is the control and his 3.7 a fallback).
      The lead takes names and prices from Anthropic's pricing page; if his Anthropic
      console says otherwise, the console wins.
5. **The comparison (3.8 a)**, off-hours (it shares the key's rate limits with the live
   bot), the lead walks him through it. He sends the lead his failed cases' request codes
   (what he sees on /hisoblash or the card) in chat first; the lead gives him the exact
   `--models` and `--requests` values:
   ```
   mkdir -p ai-misollar
   # dry run — spends nothing; prints the cases, the candidates and the worst-case dollars
   docker compose run --rm -v "$PWD/ai-misollar:/misollar" migrate \
     pnpm exec tsx scripts/ai-solishtirish.ts --models "<lead gives>" --requests "<his codes>"
   # the run, DETACHED so a dropped SSH session loses nothing; one line per finished cell
   # is written to ai-misollar/ai-solishtirish.jsonl as it goes
   docker compose run -d --name ai-solishtirish -v "$PWD/ai-misollar:/misollar" migrate \
     pnpm exec tsx scripts/ai-solishtirish.ts --models "<…>" --requests "<…>" --run --max-usd 50
   docker logs -f ai-solishtirish          # watch it; Ctrl-C here does NOT stop it
   # if it stopped half-way: the same run command with --resume /misollar/ai-solishtirish.jsonl
   # the report, from the file, any time:
   docker compose run --rm -v "$PWD/ai-misollar:/misollar" migrate \
     pnpm exec tsx scripts/ai-solishtirish.ts --report-from /misollar/ai-solishtirish.jsonl
   docker rm ai-solishtirish
   ```
   (`migrate` has `.env` and the storage; it is the build stage, so `tsx` and the source are
   there — never a `package.json` script, #1228.) He copies the printed report into the
   chat; the lead reads it to him in Uzbek and states the per-job dollar figure and the
   month's arithmetic (§3.4) with the measured numbers — and, if the reading's p90 is over
   120 s, asks the question of §11.6 before anything else changes.
6. **He picks** «Og‘ir ishlar» = the strong model, its fallback = the model used today
   («oldingi model», his 3.7 a). The save takes the capability snapshot; from then on the
   strong reasoning is sent (the card says so).
7. The ceiling is $100 from the deploy (the setting's default); he changes it on the AI
   page's link to Sozlamalar if he wants another figure.
8. **The first real calls**: he runs `docker compose logs --since 1h app | grep "\[ai\]
   model tokens" | tail -5` and sends the five lines to the lead (job, tier, the model that
   answered, tokens, the rate-limit headroom). The lead cannot read the server.

---

## 19. For the lead's Uzbek report (⭐ = built default)

### 19.1 Savollar (the ten of «Questions for the owner», in his language — send BEFORE K)

**3.9** Sozlamalar sahifasida nechta tanlov bo‘lsin:
- a) ikkita: «Og‘ir ishlar» (invoys, rasm, PDF, TNVED, bojxona bazasi, Bojxona 🤖, «📈» va admin yordamchisi) va «Tez ishlar» (oddiy hodimlar yordamchisi) — har biriga zaxira model bilan ⭐
- b) uchta: admin yordamchisi uchun alohida tanlov

**3.10** Tanlangan modelni Anthropic olib tashlasa («model topilmadi»):
- a) zaxira modelda bir marta qayta uriniladi va sizga kuniga bir marta nima bo‘lgani haqida xabar keladi («zaxira model o‘qidi» yoki «zaxira ham topilmadi — qo‘lda») ⭐
- b) faqat xavfsizlik filtri zaxiraga o‘tadi; model topilmasa AI to‘xtaydi va ish qo‘lda qilinadi

**3.11** Oylik chegarani 0 qilsangiz:
- a) pullik AI umuman ishlamaydi — hamma joyda «AI o‘chirilgan (oylik chegara 0)» deb yoziladi ⭐
- b) chegara yo‘q degani

**3.12** Narxi kiritilmagan model bilan:
- a) AI ishlayveradi. Narxi yo‘q chaqiruvlar chegaraga eng yuqori kiritilgan narx bilan taxminiy sanaladi; hali HECH QANDAY narx kiritilmagan bo‘lsa, chegara ularni sanay olmaydi — narx yozguningizcha har kuni bir marta Telegramda eslatma keladi. Narxni yozganingiz zahoti shu oyning xarajati dollarda hisoblanadi ⭐
- b) narx yozilmaguncha AI to‘xtaydi

**3.13** AI haqidagi Telegram xabarlari (80 % / 100 %, «model topilmadi», «kalit rad etildi», «narx kiritilmagan», «xarajat yozilmayapti») kimga borsin:
- a) AI sahifasini ochadigan odamga — super_admin (siz) ⭐
- b) buxgalterga ham

**3.14** Kartadagi chatdan hisoblatish (3.5 b) qanday ishlasin:
- a) bosilgan zahoti saqlanadi, AI o‘qiydi, keyin so‘rov AI o‘qigani bilan VED navbatiga tushadi (odatda 3 daqiqagacha; server yangilanayotganda ko‘proq). Yo‘lkira so‘rovida yo‘nalish, kg va kub yozilgan bo‘lsa — darhol tushadi ⭐
- b) so‘rov darhol yozilganidan tushadi, AI o‘qigani keyinroq kartadagi lentaga VED uchun izoh bo‘lib keladi

**3.15** Asosiy AI xavfsizlik filtri sababli rad etib, zaxira model o‘qisa:
- a) sotuvchiga hech narsa demaymiz; kartadagi lentada «zaxira AI o‘qidi» degan qator va AI sahifasida oylik soni ⭐
- b) sotuvchining chatida ham aytamiz

**3.16** Modellarni solishtirish (~$20-60) $100 ga kirsinmi:
- a) yo‘q, alohida ruxsat bergansiz; skript o‘z xarajatini yozib beradi ⭐
- b) ha, kiradi

**3.17** «Tez ishlar» modelini tanlaguningizcha hodimlar yordamchisi:
- a) «Og‘ir ishlar» modelida ishlaydi (ishlaydi, lekin har savol qimmatroq); deploydan keyin birinchi qadamingiz — «Tez ishlar»ni tanlash ⭐
- b) «AI modeli tanlanmagan» deb javob beradi, siz tanlaguningizcha

**3.18** Dollar chegarasi yonida kunlik limitlar (hisoblash 200, «📈» 50, yordamchi kishiga 40) qolsinmi:
- a) qolsin — «qochib ketgan» ishga qarshi to‘siq sifatida (hozirgi ishlatishdan ~20 barobar ko‘p, dollar chegarasi oldinroq to‘xtatadi); rad etilgan chaqiruv va uning zaxirasi kunlik limitdan ikkita sanaladi ⭐
- b) olib tashlansin — faqat dollar chegarasi (yordamchining kishiga 40 tasi qoladi)

### 19.2 Aytiladi, so‘ralmaydi (stated, not asked)

1. **Hisob taxminan:** bitta to‘liq AI rastamojka ishi ~$0.6-0.8 (solishtirish aniq sonni
   beradi). $100 ≈ oyiga ~140 ta ish (kuniga 4-5 ta), yordamchi va tugmalar alohida. Kuniga
   nechta ish kelishi hali o‘lchanmagan — agar botga kuniga ~10 ta ish kelsa, chegara oyning
   12-15-sanasida tugaydi; keyin chegarani oshirasiz yoki ish qo‘lda qilinadi. Birinchi oyning
   hisobi aniq sonni beradi.
2. **Chegara «yumshoq»:** chegaraga yetgan paytda ishlab turgan AI so‘rovlari tugaydi — band
   paytda $5-15 gacha oshib ketishi mumkin.
3. **Kunlik limitlar qoladi** (⭐ 3.18: hisoblash 200, «📈» 50, yordamchi kishiga 40) — pul
   emas, «qochib ketgan» ishlarga qarshi to‘siq; rad etilgan chaqiruv va uning zaxirasi
   ikkita sanaladi.
4. **Fikrlash kuchi har ish uchun alohida:** invoys/rasm/PDF o‘qish, TNVED guruhlash va
   bojxona bazasini tanlash — kuchli; Bojxona 🤖 va admin yordamchisi — o‘rtacha; «📈» —
   yengil (javobi 5 ta raqam); hodimlar yordamchisi — yengil. Eng yangi modellarda
   fikrlashni o‘chirib bo‘lmaydi. Fikrlash kuchi modelni sahifada SAQLAGANINGIZDAN keyin
   yuboriladi — shungacha model o‘z standart kuchida ishlaydi (sahifada yozilgan).
5. **Narxlarni siz yozasiz** — Anthropic ro‘yxatida narx yo‘q; men chatda yozib beraman
   (Anthropic sahifasidan; sizning Anthropic kabinetingizda boshqacha bo‘lsa — kabinetdagisi
   to‘g‘ri). Chiqish narxi kirishdan arzon bo‘lsa sahifa qabul qilmaydi; narxni tuzatsangiz
   shu oyning chaqiruvlari qayta hisoblanadi, o‘tgan oylar o‘zgarmaydi.
6. **Model nomi kodda yo‘q** — faqat bazada, siz tanlaganingizda.
7. **Kartadagi chat faqat matnni o‘qiydi** (rasm va fayllar — 6-raund). «O‘qish» va oldindan
   ko‘rish endi yo‘q — bitta «VEDga yuborish»; nima yetishmasligi AI javobida (Telegram va
   lenta) keladi. AI o‘qiyotganda kartada «🧮 AI o‘qiyapti» yozuvi turadi.
8. **Rad etilgan, kesilgan yoki o‘qilmagan javob ham pullik** — hisobga kiradi; to‘xtatilgan
   yoki uzilgan o‘qish «taxminiy» summa bilan sanaladi. Server qayta ishga tushganda uzilib
   qolgan chaqiruv hisobga yozilmaydi (deploy uchun bir necha sent).
9. **Telegramda kutish 3 daqiqagacha qoladi** (fayllar 30 soniya + AI 150 soniya); zaxira
   modelga o‘tish ham shu vaqt ichida. Admin yordamchisi botda 3 daqiqagacha, saytda
   (/ai) 4 daqiqagacha kutadi.
10. **Solishtirish deploydan keyin, «Og‘ir ishlar»ni tanlashdan oldin** — shu orada hisob
    ishlari bugungi modelda ishlaydi; hodimlar yordamchisi «Tez ishlar»ni tanlaguningizcha
    og‘ir modelda (⭐ 3.17).
11. **Sahifadagi oy Toshkent oyi** — Anthropic hisob-fakturasidan 5 soat oldin boshlanadi va
    solishtirish xarajati hamda uzilib qolgan chaqiruvlar unga kirmaydi, shuning uchun
    sahifa va hisob-faktura aniq teng chiqmaydi.
12. **Yordamchi javobi uzunligi sababli kesilsa ham ko‘rsatiladi**, oxirida «✂️ Javob shu
    yerda kesildi» qatori bilan.
13. **Bojxona «🤖 hammasi» bir bosishda 30 ta tovar** qiladi va nechta qolganini aytadi
    (katta mashinada bitta bosish oylik pulning katta qismini yeb qo‘ymasin).
14. **«✨ AI taklifi» bir bosishda 3 daqiqagacha ishlaydi**; katta so‘rovda qolganini ✨ ni
    qayta bosib davom ettirasiz. Bitim tovarlari importida AI ham 3 daqiqagacha ishlaydi,
    qolgan tovarlar qo‘lda guruhlanadi.
15. **Ikkala model ham xavfsizlik filtri sababli rad etsa**, sotuvchiga (Telegram va kartadagi
    lenta) ketadigan hisob javobida shu yoziladi («AI xavfsizlik filtri sababli bu tovarlarni ko‘rmadi — kodini VED
    qo‘yadi»), jim qolmaydi.

---

## 20. Judged before code

Judged on 2026-10-27 by five lenses — **money, regression, durability, product-fit,
handoff** — each objection then checked by its own refuter (read against the R2 tree
`52171ca`, the installed SDK 0.114.0 and pg-boss 10.4.2, with probes where a claim was
measurable). Every confirmed and partial objection is absorbed in the text above; the
refuted ones changed nothing. This replaces the judge the earlier draft asked the lead
to run — do not run another over this file (header).

| Lens | Objections | Confirmed | Partial | Refuted |
|---|---|---|---|---|
| money | 22 | 14 | 8 | 0 |
| regression | 26 | 21 | 3 | 2 |
| durability | 16 | 13 | 3 | 0 |
| product-fit | 24 | 19 | 5 | 0 |
| handoff | 23 | 19 | 4 | 0 |
| **all** | **111** | **86** | **23** | **2** |

Absorbed: 109 (confirmed + partial). Refuted: 2 (regression-11, regression-22).

| Id | Severity | Verdict | What changed |
|---|---|---|---|
| money-1 | defect | partial | §3.3 `aiMonthSpendSql` counts a NULL row at the live price and a no-price row at the highest typed price («taxminiy»); daily `AiUnpriced` reminder (§2.4, §6.6); Question 4 and 3.12 reworded so his Uzbek says the ceiling cannot count until a price exists; §18.3 |
| money-2 | nit | confirmed | `fillUnpricedAll()` at the start of every `checkSpendLevel`, and the gate prices NULL rows at the live price (§3.2, §3.3); two-connection test (§6.8.4, §14.1.25) |
| money-3 | defect | confirmed | K5 step 6: a begun stream, however it ended, is billed with output = min(clamped max_tokens, seconds × `AI_STREAM_OUT_TOK_PER_S`), «taxminiy» (§3.2); P6 settles such an attempt at its reservation (§11.5); test §14.1.5 |
| money-4 | defect | confirmed | K5 keeps the last `message_delta` usage and `usageOf` merges `thinking_tokens` / `cache_creation`; the stand-in sends thinking ONLY in `message_delta` (K10); test §14.1.14 |
| money-5 | defect | confirmed | the migration copies into HEAVY only; FAST stays NULL and borrows the heavy plan (`tierPlan`, `borrowed`); stated in §0, §0.1.9, §12, §18.3; new Question 9; «Tez ishlar» is the first deploy step; tests §14.1.22-23 |
| money-6 | defect | partial | the month gate is asked before EVERY request incl. the transient retry (K5 step 4); §3.4's overshoot derived and restated as ~$5-15; the in-process reservation listed as not built (§17) |
| money-7 | defect | confirmed | `repriceMonth` re-prices the OPEN Tashkent month on a correction, audited; `price_swapped` refusal; §17 narrowed to closed months (§3.1, §3.2, §6.3); tests §6.8.3, §14.1.16 |
| money-8 | nit | partial | the READ rule: unreadable → the default 100 with a warning, never Infinity (§3.3, §13.1); test §14.1.19 |
| money-9 | nit | confirmed | `updateSettingAction` calls `checkSpendLevel()` after saving the ceiling (K7); `setModelPrice` calls it after commit (§6.3); test §6.8.4 |
| money-10 | nit | confirmed | `runModel` never throws; a throwing `read` → `unreadable` with its attempt (K5, §1); test §14.1.13 |
| money-11 | nit | confirmed | the job's landing retries in-process once before rethrowing (§9.3 step 7); the residual second reading stated (§17) |
| money-12 | nit | confirmed | the month label comes from the same SQL statement (§3.3); the Tashkent-vs-invoice and restart differences stated (§0.1.10, §19.2.11) |
| money-13 | nit | partial | §8.2 bills `err.usages` of EVERY `TnvedError`; a truncated suggestion's row tested (§8.5.2) |
| money-14 | nit | partial | explicit casts in the VALUES (§3.2) + test §14.1.26; `usageOf` clamps (K6); a failed ledger write raises `AiLedgerFailed` once a day and is counted on the screen (§2.4, §6.6) |
| money-15 | nit | confirmed | compare makes no transient retry (K5); a row's worst case sums every call; «expected» labelled «eski model o‘rtachasi» (§11.5); test §11.7.2 |
| money-16 | nit | partial | stated (Question 10 / 3.18, §0.1.7, §19.2.3): a refused call plus its fallback is two calls of the day; the counting unchanged |
| money-17 | nit | confirmed | Bojxona «🤖 hammasi» capped at 30 per press with progress and a «yana N ta» line (§8.2); the per-press dollars in §3.4 and §19.2.13 |
| money-18 | nit | confirmed | `AiRunOptions.signal` combined with the leash (`AbortSignal.any`, K5 step 6); the import route passes `request.signal` and starts no batch after it (§8.4); test §8.5.5 |
| money-19 | nit | partial | `requested_model` column; the price is the answered model's, else the requested one's (§3.2, §12); test §14.1.24 |
| money-20 | nit | confirmed | the twin computes in BigInt micro-dollars, half-up; seeded rows, exact equality (§3.2, §14.1.21) |
| money-21 | nit | partial | rows over 200 000 input+cache tokens are «taxminiy» on the screen and in the alarms (§3.2, §2.4) |
| money-22 | nit | confirmed | the level is computed INSIDE the claim statement from `aiMonthSpendSql()` (§6.6); a stale-worker test (§6.8.4) |
| regression-1 | blocker | confirmed | `deps.configured` two-sided (`true` = 'ok' without `aiReady`) + `deps.ready` (§7.6); calc-prefill, calc-regroup and customs-estimate named, calc-regroup's `asked.length > 0` red proof (§7.8.8-10, §14.2) |
| regression-2 | blocker | confirmed | ONE gate seam `vi.mock('@/modules/platform/ai/ready')` named per door (§7.8, §8.2); calc-table re-anchored with a POSITIVE claim assertion (§7.8.11); batch-door.integration through the seam (§8.5.2); both in §14.2 |
| regression-3 | blocker | confirmed | grouping-count moved onto the SSE stand-in with a mocked `tierPlan`; refusal → `ai_refused` (§7.8.12, §14.2) |
| regression-4 | defect | confirmed | intake-answered named and re-anchored: SSE frames, the two mocks, `toMatchObject` (§7.8.3, §14.2) |
| regression-5 | defect | confirmed | the runner and `aiReady` are total (words; the month read fails open) (K5, K6, §1); the unit files that run real model functions mock `tiers` + `spendGateMonth`, listed (§7.8, §14.1, §14.2) |
| regression-6 | defect | confirmed | K updates every `ai-cost` factory mock (five on the R2 tree incl. totals-question, plus R3's) and intake-usage's spread; fence `ai-cost-mocks.test.ts` (K10, §14.2) |
| regression-7 | defect | confirmed | ai-cost.integration's two oracles re-anchored on the positive list in K, with a red proof (K10, §14.2) |
| regression-8 | defect | confirmed | the migration makes `staff_id` ON DELETE SET NULL (§12); ai-assistant.integration deletes its ledger rows first (§10.5.5) |
| regression-9 | defect | confirmed | as money-5 (heavy-only continuity, the fast tier borrows, stated, Question 9) |
| regression-10 | defect | partial | `askAssistant` gains `deps.ready` and `deps.plan`; a non-ok `tierPlan` after the reserve finishes with that status and keeps the slot (stated) (§10.3); tests §10.5.1-2 |
| regression-11 | defect | refuted | no change — R3 K2 keeps `note_taken` on the card path; §9.3 step 7 and §9.6.2 stand as written |
| regression-12 | defect | confirmed | yo‘lkira is read like the other sections unless the typed text already has route + kg + m³ (§9.2 step 7, Question 6); tests §9.6.7 |
| regression-13 | defect | confirmed | `recordAiPass`'s exact type forwards every usage field; every caller spreads; R3's `runIntakeRead` step 5 given to P2; fence `ai-bill-spread.test.ts`; test §14.1.27 (K6, §7.1, §15.2) |
| regression-14 | defect | confirmed | `calc.threadErrors.bad_note` ×4 added in K (§2.5, §9.2, §13.2) |
| regression-15 | defect | partial | the M step lists the exact comment sites to rewrite and the codec sites NOT to touch; «never sed the word» (§16.4) |
| regression-16 | defect | confirmed | `retryPauseMs` reads `retry-after-ms` / `retry-after`; the runner's one retry honours it (K4, K5 step 7); test §14.1.7 |
| regression-17 | nit | confirmed | `proposeGroups` reads the uncoded count first and asks `aiReady` only when the model has work (§7.5 step 1); test §7.8.6 |
| regression-18 | nit | confirmed | `readByFallback` set in `analyzeCollected` AND added to `settleAnalysis`'s copied fields (§7.3, §15.2) |
| regression-19 | nit | confirmed | `readIntakeResponse`'s `model` input optional; the two other callers named (§7.2, §7.8.16, §14.2) |
| regression-20 | nit | confirmed | the e2e asserts the bar's SHAPE; vitest files price private ids and delete price and ledger rows (§6.8.3, §6.8.8, §14.2) |
| regression-21 | nit | confirmed | `truncated` keeps the partial text with a «✂️ … kesildi» line (§2.3, §10.3 step 8, §0.1.13) |
| regression-22 | nit | refuted | no change — §10.2 keeps the thinking blocks round-tripping as the API documents |
| regression-23 | nit | confirmed | `countTokens` lives in `platform/ai/run.ts`, called only from `compare/` (K5, §11.4, §11.6) |
| regression-24 | nit | partial | the ledger-writer fence scans `.ts`/`.tsx` only (§14.1) |
| regression-25 | nit | confirmed | the deal import's 180 s wall includes the call in flight (leash = min(240 s, wall − elapsed)); worst case stated (§8.4, §19.2.14) |
| regression-26 | nit | confirmed | §15.3 states the `landIntake` input conflict rule |
| durability-1 | defect | confirmed | `runModel` total; `left()` floored, < 1 s → `timeout`; a malformed `model_info` → an all-null snapshot (K2, K5); tests §14.1.13 |
| durability-2 | defect | confirmed | every begun stream is billed whatever ended it (`aborted` / `stream_error`), output estimated; the transient comment corrected; deploy-killed calls stated (K5 steps 6-7, §0.1.6, §19.2.8) |
| durability-3 | defect | partial | the call budget written: ≤ 1 transient retry, ≤ 1 hop, ≤ 3 requests, call-wide attempt index (K5 step 3); table test §14.1.12 |
| durability-4 | defect | confirmed | `noteModelUnavailable` dispatched AFTER the hop with its outcome; four true fallback lines; a fallback 404 alarmed (K5 step 10, §2.4, §6.6); test §14.1.9 |
| durability-5 | defect | confirmed | `AiKeyRefused` daily alarm on `auth` from any call or the list (K5 step 11, §2.4, §6.5-6.6) |
| durability-6 | defect | partial | half 1 absorbed as money-5; half 2 (null effort = today's behaviour) made VISIBLE on the card and in §19.2.4 instead of a background job (with product-fit-5) |
| durability-7 | defect | confirmed | ✨ gets `ACTION_AI_WALL_MS` 180 s, per-batch leash = min(profile, deadline − now), answered batches applied, `calc.proposeSkipped`; pin `ACTION_AI_WALL_MS + 60 s ≤ AI_CLAIM_STALE_MS` (§7.5); the deal import as regression-25 |
| durability-8 | defect | confirmed | the last attempt never rethrows and tells the presser; a 10-minute sweep tells him about a job pg-boss failed; a second press on the same selection is refused (`already_reading`); the island says «odatda» (§2.5, §9.2-9.3, K8) |
| durability-9 | defect | confirmed | an unchanged id needs no list; a ≤ 10-min cached list is the fallback; a price for a model already in tiers/ledger needs no list; the selects always render the saved id with ⚠ (§6.3, §6.4); tests §6.8.3 |
| durability-10 | defect | confirmed | verify the output-tokens rule before K; log the rate-limit headers per attempt; P6 prints limits and p99 output; `maxTokens` = p99 + 50 % in the follow-up; the comparison `--parallel 1`, off-hours (§4, K5 step 14, §11.5-11.6, §16.1, §18.5) |
| durability-11 | defect | confirmed | one JSON line per finished cell, `--resume`, `--report-from`, run detached; a transient failure is «o‘lchanmadi», re-queued once (§11.5, §18.5); test §11.7.6 |
| durability-12 | nit | confirmed | one 10 s signal over the whole pagination, `maxRetries: 0`, a failure cached 2 min, the database rendered first (§6.2, §6.4) |
| durability-13 | nit | confirmed | as money-9 |
| durability-14 | nit | partial | a reading both models refused (read off the ledger) skips the prefill's grouping model step and the reply says `refused` (§7.6) |
| durability-15 | nit | confirmed | `format` typed exactly, with the reason; fence: no `messages.parse(` and no parse-bearing format (K5, §14.1) |
| durability-16 | nit | confirmed | the profile and `INTAKE_TIMEOUT_MS` both stay 150 000, so K's equality pin is green (K3); `SIMILAR_CLAIM_STALE_MS` pinned against its leash (§8.3) |
| product-fit-1 | defect | confirmed | `INTAKE_TIMEOUT_MS` stays 150 000 and R3's clock is untouched; the chat door's leash 120 s with a pin that its 3 minutes hold; §0, §7.2, §7.4, §9.3, §19.2.9 rewritten; a p90 over 120 s becomes a question to him (§11.6) |
| product-fit-2 | defect | partial | the admin assistant's wall is 180 s in the bot, 240 s on /ai, stated (§4, §10.3, §0.1.12, §19.2.9) |
| product-fit-3 | defect | partial | as money-1 (the daily reminder and the reworded 3.12) |
| product-fit-4 | defect | confirmed | as money-5, plus the fast card's own `autoBorrowed` sentence and «Tez ishlar» as deploy step 4.1 (§2.7, §13.3, §18.4) |
| product-fit-5 | defect | confirmed | each tier card prints the effort it will send, or the «yuborilmaydi» / unknown-capabilities sentences; §19.2.4 says effort follows a save (§2.7, §6.4, §13.3) |
| product-fit-6 | defect | confirmed | `settings.badValueFor.<key>` printed when present; keys for the ceiling and `lead_assign_origins` ×4; a locales rule (K7, §13.1-13.2) |
| product-fit-7 | defect | confirmed | the press prechecks `too_many_open` / `not_found`; `already_reading` by selection key; a server-rendered pending line; a failed landing writes a lenta note too; the unlinked chat stated (§9.2, §9.3, §9.5) |
| product-fit-8 | defect | confirmed | the island prints `calc.threadAiReason.<failure>` before the advice for every press-landed failure (`ThreadPressFailure`), fenced (§2.5, §9.5, §9.6.11) |
| product-fit-9 | defect | confirmed | `aiStood` carries the mid-pass outcomes (`refused` / `month_mid` / `off` / `model`) from `proposeGroups` and the pick (§2.2, §7.5, §7.6); tests §7.8.8 |
| product-fit-10 | nit | confirmed | the bot's landing passes `aiFailure` to `intakeNoteText` too (§7.3, §15.2) |
| product-fit-11 | defect | partial | `--requests <codes>` names his cases; `--cases` is lead-only; the report is printed and copied (§11.2, §18.5) |
| product-fit-12 | nit | confirmed | the documented command passes `--models` with heavy candidates only; the report says the fast tier was not compared (§11.4, §18.4-18.5) |
| product-fit-13 | nit | partial | new Question 10 / 3.18 asks whether the day limits stay; the double count stated |
| product-fit-14 | nit | confirmed | «sababli», «… {pct} foizi», and three whole «lacks» sentences replace the `{what}` template (§2.4, §2.5, §2.7, §13.3) |
| product-fit-15 | nit | confirmed | every alarm ends with `${APP_URL}/admin/ai` (the drain's button); the screen named in full; the ceiling link carries `#setting-ai_monthly_ceiling_usd` (§2.4, §6.4) |
| product-fit-16 | defect | confirmed | an Uzbek section in docs/UPDATE.md carries §18; the backup step names UPDATE.md §1; he runs the log command and sends the lines (§16.7, §18) |
| product-fit-17 | nit | confirmed | the cache-read input is not drawn; the column and its default stay (§3.1, §13.3, §17) |
| product-fit-18 | nit | confirmed | `calc.threadQueuedClient` says only «So‘rov VED navbatiga tushadi»; §15.3 re-checks it after round 4 |
| product-fit-19 | nit | partial | ✨ shows «AI o‘ylayapti… (3 daqiqagacha)» while busy; the 🤖 loop shows «{i} / {n}» (§7.5, §8.2, §13.2) |
| product-fit-20 | nit | confirmed | §19.2.4 states the effort per door |
| product-fit-21 | nit | confirmed | the comma example fixed («2,500»); an `ambiguous_price` refusal carries the cell's own question (§3.1, §6.3, §13.3) |
| product-fit-22 | nit | confirmed | readiness / failure `off` with its own sentence at every door (§2, §3.3, K4, K6, §13.2) |
| product-fit-23 | nit | confirmed | the save shows the month's projection and asks a second press past 80 %; `price_swapped`; a correction re-prices the open month (§3.1, §6.3) |
| product-fit-24 | nit | confirmed | §0.1.5 and §19.2.7 state the preview's removal |
| handoff-1 | defect | confirmed | K's fences staged (ai-run-callers a subset + the five-site allowlist, exact at M); the leash stays 150 000 so the equality pin is green in K (K3, K10, §14.1) |
| handoff-2 | defect | confirmed | K adds the inert `job?` and `run?: AiRunOptions` parameters; P6 branches after P1 + P2 are picked (wave 2) (K7, §11, §16.2) |
| handoff-3 | defect | confirmed | this table; the header says the judge was run on 2026-10-27 and is not to be re-run |
| handoff-4 | defect | confirmed | the header: 3.9-3.18 are NOT sent — send §19.1 as plain Uzbek text before K, build ⭐ otherwise, record in SAKKIZ-BAND §11; the answer → artifact table under the questions |
| handoff-5 | defect | partial | K10 inlines every stand-in mode's SSE frames and the two measured facts; the probes named as not committed |
| handoff-6 | defect | confirmed | the stand-in's full mode set (`models-pages`, `hang`, `sse-message` with thinking / tool_use, a script queue) built whole in K; packages never edit it (K10, §16.2) |
| handoff-7 | defect | confirmed | K0 moves `fitNumeric` and `readNumberCell` into `platform/numbers/`, re-exported by wms (K0, §1, §3.1, §6.3) |
| handoff-8 | defect | confirmed | the header rules the harness's attribution trailer the one permitted occurrence in commit messages; the fence scans files only; the quoted-trailer sites named (§1, §16.4) |
| handoff-9 | defect | partial | the header names the source (Anthropic's pricing page through the proxy, the `claude-api` skill), his console wins; §16.6 corrected (docs reachable; the Models API needs his key) |
| handoff-10 | defect | confirmed | as regression-13 |
| handoff-11 | defect | confirmed | the compare fences restated as object-literal key-value pairs with named exempt declarations; `compare/inputs.ts` added to the `analyzeIntake` callers (§1, §9.6.8, §11.6) |
| handoff-12 | nit | confirmed | the header's naming rule; «the 09-25 answer R1 / R5» where those are meant (§3.2, §14.1) |
| handoff-13 | nit | confirmed | `docs/SAKKIZ-R3.md` path; both R5 files committed to docs/ at handoff; §16.7 «update» |
| handoff-14 | nit | confirmed | the observable start gate in the header; §12 «after R3's calc_intake_durable migration» |
| handoff-15 | nit | confirmed | `tiers.ts` owns `AiTier`, `AiEffort`, `EFFORT_ORDER`, `AiNeed`; `profiles.ts` imports type-only (§1, §4, K2-K3) |
| handoff-16 | nit | confirmed | the `toListedModel` field table with both edge rules; `model_info` stores `ModelSnapshot`; `chosenByPerson = chosen_at IS NOT NULL`; the migration comment fixed (§6.2, K2, §12) |
| handoff-17 | nit | confirmed | `pickSimilarLots`' `failure?` frozen in K7; the `AiCallFailure` → `ListState` map (§6.2) |
| handoff-18 | nit | confirmed | K8 registers with `includeMetadata` + `batchSize 1` (`jobs.ts:219-221`); §2.5 names `createTranslator` over `messages/uz.json` (`owner-summary-text.ts`) |
| handoff-19 | nit | confirmed | as regression-15 (the exact lists) |
| handoff-20 | nit | confirmed | `hub-doors.ts:78-84`, `route.ts:147`, `review.ts:29-42` corrected (§6.4, §6.6, §8.3, the map) |
| handoff-21 | nit | partial | the branch `sakkiz-r5` and the PR attribution in the header; §1's «House rules» names #98, #1242, the literal-class map and the Postgres ritual where the new screen meets them |
| handoff-22 | nit | confirmed | the header: «You, the session building this, are the lead» |
| handoff-23 | nit | partial | §3.4 says R0 has not been run and the jobs-a-day figure is an assumption |

