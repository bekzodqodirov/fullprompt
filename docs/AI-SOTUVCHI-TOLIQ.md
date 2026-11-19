# To'liq AI sotuvchi — the target product (design v2, BEFORE any code)

Status: **DRAFT awaiting the owner's answers. Nothing here is built.** Written 2026-11-19 on his «hozirdan toliq ai
sotuvchi qurishni strukturasini qur … ishni qurishni boshlashdan oldin hammasini aniqlashtirib olaylik», after his
«hozir AI sotuvchi emas salomlashadgan bot yasab qoyibsanku». What exists today is `docs/AI-SOTUVCHI.md` §17-§18.9.

How it was made: three code maps → three independent designs (product-first, risk-first, operations-first) → the
lead's synthesis (v1) → six critics (Telegram facts, speech-to-text, feasibility + reversals, owner fit, cost, the
guard). This file is v1 with the critics' corrections applied. The working material is kept beside it in
`docs/ai-toliq/` — where this file is short, the named file is the detail:

| File | What it holds |
|---|---|
| `map-as-built.md`, `map-sale-doors.md`, `map-senses.md` | the run, every wait reason, the whole sale as service doors, the media/readers/cost plumbing |
| `design-product.md`, `design-risk.md`, `design-operations.md` | the three designs (they DISAGREE on the guard — see §3) |
| `SPEC-TOLIQ-v1.md` | the first synthesis, superseded by this file |
| `critic-*.md` | six critiques; `critic-feasibility.md` §A is the table of 35 earlier answers the design touches |
| `toliq-ai-sotuvchi.html` | the page shown to the owner (Uzbek): the product, the road, the 32 questions |

His answers, when they come, are recorded in §11 and become binding over everything above them.

## 0. Diagnosis

The AI was built as a DRAFT WRITER whose every sentence is searched for danger. An ordinary reply goes by itself only
when about thirty conditions hold at once (47 refusal codes exist; ~30 apply to a plain reply). The model rates its own
confidence 0.60-0.75 against a 0.80 floor while its instructions tell it to rate low; the third reply in a row waits;
any photo, file or voice note makes the reply wait and the model sees only the word «rasm»; the prompt sends a bare
price question to the website table and forbids choosing the calculation section, opening a code, negotiating. On
2026-11-15 all nine replies waited (#1800). So only greetings survive.

The flip: **judge ACTIONS by what they can cost — not words, and not the model's opinion of itself.**

## 1. The finished product

One Telegram number (the AI seat) that carries a customer from «salom» to a repeat order. Three columns per stage:
what it does alone, what it asks (the customer gets a holding line with NO promised minutes and the AI keeps
answering other questions), what is a person's for ever. Cells that reverse an earlier answer of his are conditional
on the question named.

| Stage | Alone | Asks | A person, for ever |
|---|---|---|---|
| First contact | answers in 1-3 min (at night if Q4 says so); opens the lead; fills the card | «telefon qiling» → a call-back task (Q15) | phone calls; a first message to someone who never wrote |
| Qualifying | reads Excel exactly; reads photos and PDFs and READS BACK what it read; kub from typed sizes; asks «to'liq mashinami?» (FTL); voice ONLY if the trial passes, with a typed confirmation (Q13) | unreadable → «yozib yuboring» + a card; «may this be imported?» → the VED | — |
| Price | truck tariff by density; avia = kg × rate; sends the VED job with its files; the VED price + his markup, PDF | rail (his rule stands); big cargo / FTL (Q3); Kashgar, Horgos (Q18); another city (Q19); factory pickup, «Sotib olib berish» (Q20) | the official customs calculation; tariff and markup; a customs ESTIMATE to the customer — not until he sees his own data (§8 «later, with data») |
| Negotiation | explains the price, offers alternatives | discount = a one-tap card (Q23) | credit; below the floor |
| Closing | (if Q16) phone checked → GS code = lead won + deal → code, marking rule, the China address verbatim from Bilimlar, the company-bot link | phone belongs to another client → him | — |
| Journey | answers «yukim qayerda» with the cabinet's five steps and window; never repeats a bot message | «why late» → logist; «came without a code» → warehouse; the client's ❌ on a prixod → warehouse + him | loss / damage decisions |
| Payment | names the ways to pay; the balance in a phone-proven chat; a cheque photo → the accountant | «qarzga bering» → him or the client's seller (never the 24-h counter approval); reminders per Q25 | posting money; granting debt |
| Handover | where and from whom (the stored Tashkent contact) | off-hours pickup → warehouse | the handover |
| Repeat | «keyingi yuk?» inside the same conversation after a handover | quiet-customer messages and the Friday greeting, one approval per campaign (Q24, Q26) | cold messages — never |
| Complaints | never silent: apologises without admitting fault, collects facts, opens a case | he decides, the AI relays | compensation, refund |

Never, whatever is on: a number, address, date or code the system did not hand it; «I am a person»; another
customer's data; a first message to someone who never wrote to this number.

Missing from v1 and added: factory pickup, «Sotib olib berish» (the site's third team), the client's ❌, unclaimed
cargo, FTL, the call-back, customs through the client's own firm, the Mini App as the answer to «show me» and as the
only identity proof for a hidden number (`critic-owner-fit.md` §B.3).

## 2. The autonomy model

**Rights per ACTION, four positions:** O'zi (does it; journal) · Nazoratda (does it at once AND every such act lands
in the owner's check list) · So'rab (prepares; one tap) · Faqat odam.

**Tiers** by what a turn DOES and CONTAINS (never by the model's label or confidence): T0 talk · T1 facts out ·
T2 internal reversible work · T3 commitments inside limits · T4 a person's for ever.

**One page «AI hodim → Huquqlar»**: a row per action with its position, plus the limits (big-cargo line, codes a day,
discount rule, markup, avia rate, follow-up cadence, night, per-chat/per-day ceilings, the money meter, who answers
which topic and after how many minutes, persona, the stop buttons: one chat / everything about money / writing first /
everything).

**Trust is measured AFTER the act** (he refused a proof gate, #1683): a daily sample of ten sent messages (5-10
minutes, weighted to money acts), a nightly comparison of every price / address / code / status sent against stored
blocks, customer signals, estimate-vs-seal honesty. Step-down is automatic and per action (two confirmed mistakes in
7 days; ONE for an address or a code); step-up is his tap. If nobody marks the sample there is no signal — say so.
Account dangers still stop ALL sending.

**Hand-over:** holding line (system-worded, no minutes) + a case with a three-line summary and buttons to the right
person + a clock that climbs + the decision relayed + «shu savol yana kelsa?». Law 4 binds every card: a card to the
VED never carries a client price; nothing shown to a seller carries the floor; a VED answer is never relayed «as
given» (it is the floor) — it goes through the markup door or to him.

## 3. The guard

The three designs disagreed; v1 took the most aggressive and the guard critic measured it: «no digit in the model's
own sentences» stops ≈ 30 % of the 303 collected dangerous first replies, the echo exception re-opens the project's
first leak, and 117 of 303 would rest on a second model ALONE (`critic-guard.md` §0). **RULING (v2): blocks + permits
+ tripwire-holds, with the reviewer on top.**

1. **Facts only from tools.** Closed toolset; identity before cargo/money. Origins gain `heard` (a transcript) and
   `read` (a file): neither satisfies a tool until the customer confirms in text.
2. **Blocks.** Numbers, addresses, dates, codes, statuses are rendered by the system from tool results in wording he
   approved once per language (fa / zh by back-translation). A structured turn: the model emits segments and block
   references, never the figures. Echo of the customer's own figure only by typed reference with the unit rendered by
   code. The road (truck / avia) is a stored, confirmed fact and is printed in the address block. The numeral readers
   (`digits.ts` normalisation, the currency and numeral lexicons) SURVIVE — the check needs them.
3. **Limits inside the tools.** The concession tool never reveals the floor; codes a day; re-price at the second of
   sending; preconditions as data; idempotent.
4. **Permits and holds.** A promise class (discount, date, guarantee, «bojsiz», free extras, credit, refund) passes
   only with a permit minted by a tool in the same turn; without one the listed phrases HOLD as today. Nothing in
   these classes ever rests on the reviewer alone.
5. **A second model reads the turn** (tone, language, another customer, anger, «I am human»): monotonic (it can only
   stop), fail-closed, pinned model, never the only wall.
6. **After sending:** the nightly comparison, the sample, customer signals, per-action step-down, the account brakes.

**Demolition order.** No word table is deleted until measured: commit the corpora first (the 303 / 293 / 314 sets
live only in session scratch today), run the protocol of `critic-guard.md` §C.2 on the server (the reviewer cannot run
in CI), show HIM the missed list per class, then delete. What truly goes is ≈ 3 000-3 500 lines (the sourcing ledger,
sentence matchers, the 47-code gate), not 9 000; the gain is that a false hit costs a rewrite instead of his press.
All 71 named codes must be classified delete / keep / dial before any is removed (18 are in no list today).

## 4. Structure

Senses in (files, photos, voice, cheque photos, the seat's own staff inbox as events) · the **conversation engine**
(the piece v1 forgot: a conversation record with goal, sale stage, cases, promises; event triggers; acts BEFORE speech
so a closing reply can contain a code that exists; several parts per turn; an inline press) · tools through the doors
a seller uses · customer memory («mijoz pasporti») · the guard · sender and carriers · the exception inbox (Savol,
Ruxsat, Shikoyat, Tekshiruv, Signal) · the morning report, journal, liveness alarm · teaching (price rules as
settings, Bilimlar, playbooks, lessons — only the owner approves knowledge) · the test field (dry replay of real
chats on the server, his exam set, versions).

One early migration should cover the CHECKs every later stage hits (run trigger, draft kind, nullable anchors,
outbox parts/carrier, chat waits, the AI ledger kinds). No image or PDF block ever enters the run loop: one reading
per attachment id, stored as text. One money meter for everything the seat spends, with a rule for the ceiling.

## 5. Channels (`critic-telegram.md` §3; Telegram's pages read 2026-11-19)

- **The seat's own session** — the only road that can do everything and the only one punished at the account. It
  stays for good. Replies to people who wrote first; writes first only in a chat the customer once opened with THIS
  number, in small counts; never cold.
- **Chat Automation (the former Business chatbot)** — an optional add-on, not a replacement. Free since May 2026
  (no Premium). The bot may send only in chats with an incoming message in the last 24 hours: same-day replies only,
  never a follow-up or a next-day VED price; no history, no read receipts; the customer may see the bot's name. A
  one-hour trial in stage 0 decides. If taken: a separate bot, a router per message, a Telegram-side pause is a
  take-over.
- **The company bot** — the only road with no window. Operational first; offers rare, approved per campaign, with an
  opt-out (a customer who blocks it also loses «yukingiz keldi»). The AI answers people who write to it. Leads are
  offered the bot at the FIRST QUOTE.
- **Reserve number** — a real SIM kept alive; continuity only (it may write first to nobody).
- Three restriction states: limited (replies still work), frozen, banned. Who holds the SIM and the phone matters.
- Telegram's terms on AI and platform data are a stated risk (API ToS 1.5, content-licensing terms).

## 6. Control room, teaching, testing, rollout, pay — `design-operations.md` §4.2-§4.8, with the corrections

The morning line names every held reply and why («14 javobdan 11 tasi o'zi ketdi; 3 tasi kutdi: 2 rasm, 1 kod»).
Rollout rings apply to NEW powers only (today's audience — everyone who writes — is not narrowed). The seat is out of
KPI pay, the rating and the staff-group celebrations FROM STAGE 1a (it already accrues). From the stage that opens
codes, everything the system sends «to the client's seller» must reach the supervisor, not the seat's mailbox.

## 7. The road (corrected)

| # | Stage | Built | Size |
|---|---|---|---|
| 0 | Today, no code | his chores (three ticks, markup, «Tarif to'g'ri», the seat button, the two AI stages, confidence 60); two read-only counts on his server (the 11-15 verdicts re-judged under 1a rules; the share of bursts with media); the Chat Automation trial; the speech trial on 25 real notes | — |
| 1a | To'siqlar olinadi | `low_confidence` out; typed warnings/notes; ordinary labels free (`complaint` kept); ONE loop detector replacing `streak` + `repeat`; his Q2 rule in the prompt; persona; an honest reply to media-only bursts; night per Q4; the seat out of pay/rating; the morning line. `language` stays for money messages, `owner_figure` stays | S-M |
| 1b | Kod va manzil — bir tugma | «So'rab» for the code: the AI prepares, he taps, the AI sends code + address | S |
| 1c | Suhbat dvigateli | the conversation record, event triggers, multi-part outbox, the system holding line, supervisor + deputy, the new prompt measured by a dry replay on the server | L |
| — | 2026-12-31 | the website truck table ends — the 2027 tariff must stand in «Tarif» by then | a date |
| 2 | Ko'radi va eshitadi | eyes (two-phase turn, a new source origin) M-L; ears M only after the trial | M-L + M |
| 3a | Hamkasblardan so'raydi | routing by topic with clocks, answers relayed, take-over and give-back, the law-4 card sight | M-L |
| 3b | Yangi qo'riqchi | blocks, permits, reviewer, the rights page, limits ledger, nightly comparison; the exam on the server; word tables go last | L |
| 4 | Narxni oxirigacha | Kashgar/Horgos, avia address, PDF as a file, the quote record, the big-cargo ping | M-L |
| 5 | Savdoni yopadi | codes alone per Q16, deal, expected arrival, the seat's inbox to the supervisor | L |
| 6 | Savdolashadi, pulni eslatadi | discount tool and cards, amount due and reminders (company bot), cheque → accountant | M-L |
| 7 | Xavfsiz kanal | the AI inside the company bot, the official road if chosen (two carriers for ever), the reserve line | L |
| 8 | O'zi yozadi | follow-ups, the Friday greeting, quiet customers, campaigns | M-L |
| 9 | Hodim sifatida o'lchanadi | the KPI page, weekly self-report | M |
| 10 | Other channels | WhatsApp Business, Instagram | L each |

Sizes: S = days, M = 1-2 weeks, L = 2-4 weeks — estimates; in the earlier parts the reviews took longer than the build.

## 8. Questions for the owner

The full Uzbek wording with options is the page (`docs/ai-toliq/toliq-ai-sotuvchi.html`). ⭐ = what «sen aytgandek»
builds. ⚠ = the option reverses a recorded answer of his.

**Fill-ins:** the AI's name · his deputy · the markup on a VED price (empty = none, his A1) · who holds the seat's SIM.

**To start (before 1a):** 1 persona ⚠ (⭐ own name, honest one line to «botmisiz?») · 2 a bare «narxi qancha?» (⭐
table figure at once + «rastamojka bilan hisoblab beraymi?») · 3 big cargo (⭐ ping from 20 kub or «fura») · 4 night ⚠
(⭐ answers, never first) · 5 supervisor + deputy ⚠ (⭐ 15 min, 09-19) · 6 website «Telegram» visitors (⭐ one more
seat in the queue for two weeks) · 7 do existing customers learn the number (⭐ sellerless clients, through the bot) ·
8 a colleague's customer (⭐ status/addresses/table price; money to the seller; the seller's price outranks) · 9
checking (⭐ ten a day for a month) · 10 the money meter ⚠ (⭐ warn $15; at $50 stop writing first and reading files,
keep answering) · 11 the 2-minute hold (⭐ prices wait, talk does not) · 12 the Chat Automation trial ⚠ (⭐ try) ·
13 voice (⭐ trial on 25 notes; until it passes «yozib yuboring» + a card).

**Later (now, or when the stage comes):** 14 whom it asks by topic · 15 «telefon qiling» · 16 GS code ⚠ (⭐ alone,
≤ 10 a day, each shown to him for two weeks) · 17 avia address ⚠ (first: is it ONE address?) · 18 Kashgar/Horgos ·
19 delivery city · 20 other services · 21 payment requisites · 22 quoted too low (⭐ honour to $50) · 23 discount ⚠
(⭐ one-tap card for the first month) · 24 follow-up on a silent quote ⚠ (⭐ twice, then stop) · 25 ready cargo and
its money ⚠ (⭐ once, through the bot) · 26 the Friday greeting and quiet customers ⚠ (⭐ from the seat only to people
who wrote to it; the rest through the bot) · 27 road news unasked (⭐ none) · 28 the AI inside the company bot ·
29 the quote on the card and the PDF through the bot ⚠ 6b · 30 the reserve number · 31 whose are AI-won customers ·
32 order of stages.

**Decided without a question, told to him:** ordinary talk goes alone · rail unchanged · under the minimum → says it,
offers avia · reads files and reads back · complaints as above · no language shown → Uzbek Latin; `language` stays
strict on money messages · a figure in his or a colleague's answer still comes to him as a card · his own typing on
the seat still pauses the AI · ⚠ the two-in-a-row rule goes, a loop detector replaces it · the AI asks the city,
never picks · only he approves knowledge · Pashto → one line asking for Russian or Persian.

**Asked later, with his own data:** a customs estimate to the customer (after a table «AI-VED estimate vs the VED's
answer» on his jobs) · «qachon jo'naydi» from the plan (after counting how many plans carry a date).

## 9. Risks (told to him plainly on the page)

The account (cannot be excluded; the reserve number cannot write first; the more the AI writes by itself, the higher)
· a wrong address or code (the most expensive mistake) · a wrong price · an invented promise (UNMEASURED under the
new guard until the protocol has run) · mis-heard voice · Telegram's terms · customers learning it is an AI · prompt
injection through text or files · nothing can be proven before launch (no Telegram, no model key in the build
environment — one day on staff phones first) · volume: the seat got nine replies on its measured day.

**Cost** (`critic-cost.md`; computed from the code's price map, nothing measured): today 2-5 cents a reply, under $1
a day. Target: a 6-turn conversation ≈ $0.3, 12 turns ≈ $0.6, a full sale ≈ $0.9. 20 conversations a day ≈ $7-14 a
day ($220-420 a month) · 60 ≈ $20-38 ($600-1 150) · 150 ≈ $48-91 ($1 400-2 700). Three settings can double it (the
reviewer's model, a stronger writer for hard turns, how much the writer thinks). Under today's send limits the bill
cannot pass ≈ $3-11 a day. Speech: 0.2-0.8 cent per 30-second note.

## 10. Trials before the stage that needs them

Chat Automation on a spare number (what the customer sees; coexistence with the session) — `critic-telegram.md` §6 ·
speech-to-text on 25 real notes, three services, the protocol of `critic-stt.md` §4 · how the cheaper and the stronger
reader do on the same 20 real papers, with cost per paper · his real volume and media share from the server.

## 11. His answers

_(none yet — the page was sent to him on 2026-11-19)_
