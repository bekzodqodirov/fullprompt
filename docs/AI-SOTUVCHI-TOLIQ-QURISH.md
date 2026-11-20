# To'liq AI sotuvchi — the BUILD contract (handoff to the building session)

Written 2026-11-20, the day the owner answered the design's 32 questions and said:
«sen qanday qurishni yozib ket, boshqa model ishni davom ettiradi». **Nothing of this is built.**

**You, the session building this, are the lead.** Every stage — its re-check against the code, its judges, its
kernel and packages, the reviews, the merge, the deploy steps you give him, and the walk-through of the first live
day — is yours. You talk to the owner (Bekzod): in Uzbek, plain text, numbered questions with options and a ⭐ —
never an `AskUserQuestion` dialog (CLAUDE.md, «Who you are talking to»). He answers «sen aytgandek» often, so the ⭐
you offer IS what gets built: never put a ⭐ on something that reverses an earlier answer of his without a ⚠ line
that says so.

## 1. What to read, and what outranks what

| # | File | What it is |
|---|---|---|
| 1 | `docs/AI-SOTUVCHI-TOLIQ.md` | The design. **§11 = his answers of 2026-11-20 — binding over everything else here.** §3 the guard ruling, §7 the road. |
| 2 | this file | How the build is run, stage by stage; the rules no stage may undo. |
| 3 | `docs/ai-toliq/qurish/STAGE-*.md` | One build plan per stage, written against the code at the HEAD each names, references checked by a second pass. `COVERAGE.md` there traces every answer to the stage that builds it and ends with the questions still to ask him. |
| 4 | `docs/ai-toliq/critic-*.md` | Why the design is what it is. `critic-feasibility.md` §A = the 35 earlier answers the design touches; `critic-guard.md` §C.2 = the measurement that must run before any word rule is deleted; `critic-stt.md` §4 = the speech trial; `critic-telegram.md` = what Telegram publishes. |
| 5 | `docs/ai-toliq/map-*.md`, `design-*.md` | The code maps and the three designs the synthesis came from. Second-hand and dated 2026-11-19. |
| 6 | `docs/AI-SOTUVCHI.md` §17-§18.9 | What exists today and why — phase 1, auto-send, the full seller's parts 1, 1b and 2. |

Precedence: **§11 of the design → a stage plan → the design's §1-§10 → the critics.** About what EXISTS in the
code, the code wins over every document: re-read each function a plan names on the tree you start from, and where
they disagree re-fit the plan, never the code.

## 2. Start gate (observable)

1. `git fetch origin main`; these documents are on it. Read the tail of
   `src/modules/platform/db/migrations/meta/_journal.json` — the next migration is the next index and the next
   `when` (#1040), whatever number a plan's text uses for readability.
2. **Ask him what is live.** When this was written his server was confirmed at ledger 150; PR #154 (the confidence
   box and the seat's arming, no migration) and PR #155 (migration 0150, ledger 151) were merged and their deploy
   was NOT confirmed. Ask for `select count(*) from drizzle.__drizzle_migrations` and
   `curl -s https://gsrwms.uz/api/version` before stage 1a's deploy list is written.
3. The first production day of the seat (2026-11-15): nine replies, all waited; none carried a VED job. His answer
   2 a now SETS that rule, so the cause no longer blocks — but the day's chats were never read (the eleven-band
   dump he was sent came back without band 11). Stage 0's scripts read them.
4. Open with him (design §11.3): the markup on a VED price (empty), avia inside «$9-17/kg», whether cargo is
   received in Kashgar. None blocks stage 1a.

## 3. The stages

One stage = one branch = one pull request = one deploy = his confirmation, before the next begins. He chose the
order as written (32 a).

| Stage | Uzbek name | Plan | Size | He gets |
|---|---|---|---|---|
| 0 | Bugun, kodsiz | `qurish/STAGE-0-1A.md` | — | his chores done with him; four read-only measurements; the speech trial |
| 1a | To'siqlar olib tashlanadi | `qurish/STAGE-0-1A.md` | S-M | talk goes at once, prices after 2 minutes; own name; an honest line to a photo or voice note; night answers; the big-cargo signal; the designation table; the morning line. Package «Hajm»: the website's visitors (6 c) and the number told to seller-less clients (7 b) |
| 1b | Suhbatni yuritish | `qurish/STAGE-1B-1C.md` | L | several messages a turn, the holding line, acts before speech, the deputy, the dry replay |
| 1c | Kod va manzil — bir tugma | `qurish/STAGE-1B-1C.md` | M-L | one tap opens the code; the AI sends code and address |
| — | 2026-12-31 | `qurish/STAGE-4-6.md` (part 4) | a date | the website truck table ends; the price moves to the tariff page's column — rehearse before the date wherever the road stands |
| 2 | Ko'radi va eshitadi | `qurish/STAGE-2.md` | M-L + M | photos, invoices, PDF, Excel read once and read back; voice only if the trial passes |
| 3a | Hamkasblardan so'raydi | `qurish/STAGE-3A.md` | M-L | topics routed to the right person with a clock; one inbox; call-backs; hand-overs |
| 3b | Yangi qo'riqchi | `qurish/STAGE-3B.md` | L | the rights page; the measurement shown to him; word rules leave only after it |
| 4 | Narxni oxirigacha aytadi | `qurish/STAGE-4-6.md` | M-L | Horgos by the Kashgar column; the price on the card; the PDF from the seat |
| 5 | Savdoni o'zi yopadi | `qurish/STAGE-4-6.md` | L | the code alone (≤ 10 a day, shown to him for two weeks); the ownership setting |
| 6 | Savdolashadi, pulni eslatadi | `qurish/STAGE-4-6.md` | M-L | discount out of the markup; the balance when asked; the amount once through the bot |
| 7 | Xavfsiz kanal | `qurish/STAGE-7-9.md` | M | the AI inside the company bot; the reserve number |
| 8 | O'zi yozadi | `qurish/STAGE-7-9.md` | M-L | two reminders on a silent quote; the Friday greeting |
| 9 | Hodim sifatida o'lchanadi | `qurish/STAGE-7-9.md` | M | the AI's KPI page and weekly report |

## 4. Rules no stage may undo

**From his answers (design §11):**

- **Nobody is named in code.** Who receives a signal, a call-back, a hand-over, a card number, a big customer, a
  topic — and how the AI's customers are counted — is chosen on a screen (§11.2: one designation table from 1a,
  fallback = the supervisor pair). No name, user id or role key in source, a seed or a migration.
- **Nothing stops on dollars** (10 c). Meters and the 20:00 line stay; propose no dollar ceiling.
- **The session only** (12 a): no Telegram Business, no Chat Automation, anywhere.
- **The avia address is his every time** (17 c); **another city is his** (19 c).
- **The seat stays in KPI, the rating and the congratulations** until he flips the setting of Q31 (31 c).
- A migration never flips a choice he stored (the three kind ticks, the markup, the confidence floor).

**From the critics (measured, not opinions):**

- **No word rule is deleted before the measurement of `critic-guard.md` §C.2 has run on the server and he has seen
  the missed list.** The 303 dangerous first replies are in `docs/ai-toliq/corpora/customer-safety/`; the reader
  corpus is `tests/unit/fixtures/agent-reader-corpus.ts`. Any change to a reader runs the whole corpus FIRST
  (DECISIONS #1783) — zero tolerance for a dangerous case let through.
- In 1a the `language` hold on money messages, `owner_figure` (any figure in his or a colleague's answer), the
  `complaint` label and his own-typing pause STAY; `streak` and `repeat` leave only together with one loop detector.
- From 1b on an act happens BEFORE the reply that speaks of it.
- **Law 4 on every card**: a card to the VED carries no client price; nothing shown to a seller carries the floor;
  a VED answer is never relayed «as given» (it is the floor) — it goes through the markup door or to him.
- No image or PDF block ever enters the run loop: one reading per attachment, stored as text.
- A figure that was heard or read from a file satisfies no tool until the customer confirms it in text.
- Every stage with a migration has a readiness probe, so a half-applied deploy degrades instead of throwing; a new
  column on an old hot table is SQL-only that release.

**From this repository's own history (CLAUDE.md, in force):** the verification ritual in CI's order on a fresh
database; `pnpm typecheck` and lint before every push; a test for a fix is shown RED without it, by string edit and
never by `git checkout`; no model identifier in source, tests, docs, i18n, migrations, Telegram texts or commit
messages — the code knows tiers; no secret in chat, the repo or a commit; commits end with the trailers the harness
supplies; before minting a migration or a DECISIONS number, fetch main and read both tails.

## 5. How a stage is run

1. **Re-read** the plan's code references on the tree you start from; re-fit the plan where the code moved.
2. **Judge before code**: independent lenses over the plan (send / leak / regression / the owner's eye), each
   finding checked by a refuter; absorb what survives. Every earlier round here that skipped this paid for it.
3. **Ask him** the plan's open questions — numbered, with a ⭐ and a ⚠ where an option reverses an earlier answer.
4. **Kernel first** (the migration, the shared types, the one home of each new rule), then packages in worktrees,
   cherry-picked; then review AS BUILT, and review the FIXES.
5. **The ritual**: fresh database, migrate, seed, vitest, build with the 3 GB heap, Playwright without re-seeding;
   the reader corpus; typecheck; lint.
6. **PR → green → merge → the deploy list for him** in Uzbek (backup first; `docker compose build migrate app`
   and tg-listen when the plan says so; the count to expect, read off the journal; `/api/version`).
7. **The first live day is the test.** This container has no Telegram and no model key, so nothing the AI says
   can be proven here. Where a stage changes what the AI says, run one day on staff phones first, then read the
   tg-listen log and the morning line with him. Only then the next stage.
8. **Write it down**: DECISIONS entries (why), the CHANGELOG entry in Uzbek (what he got and what he must do),
   CLAUDE.md's state, and «As built» blocks in the stage plan where the build differed.

## 6. What is still his to do or to answer

- Stage 0's chores (`qurish/STAGE-0-1A.md` §stage 0) — with him, this week.
- The questions at the end of `qurish/COVERAGE.md`, starting with the three of design §11.3.
- Things only he has: the keys for the speech trial (typed into the server's `.env` by him, never into chat), the
  reserve SIM, 25 real voice notes and one seller's hour, the 2027 tariff.

The page he read and answered on is https://claude.ai/artifact/VULstuxzWxKtMJ9YPy3TQM (source:
`docs/ai-toliq/toliq-ai-sotuvchi.html`); republish that url when a stage changes what it says.
