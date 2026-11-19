# AI sotuvchi — the finished product, designed from the guard outward

Design for the owner's approval BEFORE any code. Angle of this document: risk and guard architecture first.
Read-only work: the three maps (`map-as-built.md`, `map-sale-doors.md`, `map-senses.md`), `docs/AI-SOTUVCHI.md`
§1-14 and §18.4-18.6, and the code they cite. Nothing here was run against a real Telegram account or a real model.
Paths are relative to `src/modules/` unless they start with `docs/`, `scripts/` or `tests/`.

## 0. Why today's product is a greeting bot, in one paragraph

The AI is built as a DRAFT WRITER whose every sentence is searched, word by word, for something dangerous, and
whose release needs 47 conditions to be true at once (`wms/agent/auto-gate.ts` `AUTO_REFUSALS`). The guard is about
9 000 lines of word readers (`agent/policy.ts` 2 931, `agent/numbers.ts` 1 602, `agent/digits.ts` 1 331,
`agent/auto-send.ts` 1 633, `agent/auto-gate.ts` 542, `agent/locale.ts` 384, `agent/destination.ts` 264). A word
reader cannot tell a promise from a polite sentence, so it holds both. On top of that the release asks the model to
rate its own confidence (`low_confidence`, floor 0.80, while the prompt tells it «Oshirib yuborma: shubha bo'lsa past
qo'y»), refuses the third reply in a row (`streak`, `AUTO_STREAK_MAX = 2`), refuses any message that came with a
photo, file or voice note (`media`), and refuses every price unless a box is ticked. What survives is a greeting.

The finished product turns this around: **the guard watches what the AI DOES and what FACTS leave, not which words
it uses.** A number, an address, a date or a code can leave only when the system itself wrote it from a checked
source. Everything else the AI says is judged for meaning by a second model, bounded by limits the owner sets per
action, and measured after the fact. Under that guard most of the conversation goes alone and the dangerous 5 % is
still impossible, not merely unlikely.

---

## 1. THE FINISHED PRODUCT — one page

**«AI sotuvchi — alohida hodim».** One Telegram number (the AI seat, «BEKZOD AI sotuvchisi», +998902405077) that
takes a stranger from the first «Assalomu alaykum» to cargo handed over in Tashkent, and brings the customer back
for the next partiya. It asks a person only when it meets something the owner has said is a person's.

| Stage of the sale | The AI does ALONE | The AI ASKS a person (and waits, with a holding line to the customer) | Stays HUMAN for ever |
|---|---|---|---|
| **1. First contact** | Answers within a minute, day or night, in the customer's language (uz lotin/kirill, ru, en, zh, fa). Opens the lead itself (already automatic on a work number, `crm/chat-lead.ts leadForChat`). Says once that it is GSR's AI sales assistant. | — | — |
| **2. Qualification** | Asks goods, kub, kg, city in China, service (yo'lkira / rastamojka / podklyuch / avia). LOOKS at product photos, READS invoices and packing lists (Excel for free, PDF and photos by the existing readers), LISTENS to voice notes and repeats every figure it heard back in text. Computes kub from carton sizes. Writes what it learned on the customer's card. | When a file cannot be read or a voice note is unclear after one retry: asks the customer to type; only then a person. | — |
| **3. Price** | (a) Yo'lkira from the tariff table and avia rate x kg — immediately, as «taxminan», up to a size ceiling the owner sets. (b) A customs ESTIMATE of its own as a range marked «rasmiy emas» (the AI-VED pass that already runs, `calc/prefill.ts aiPrefill`) — if the owner allows it. (c) Sends the job to the VED with the customer's files attached, and when the VED answers, tells the customer the official price = VED figure + the owner's markup, with the PDF offer. | The VED, through the calc queue, for every official customs figure. The owner for: rail, Kashgar/Horgos origin, other destination cities, cargo above the ceiling — until he gives tariffs for them. | Setting the tariff, the markup and the floor. The official customs calculation (VED). |
| **4. Objections and negotiation** | Answers «qimmat» with arguments (transit time, photo on receipt, tracking). Gives a concession INSIDE the room the owner set (for example: up to half of its own markup, never below the VED floor plus a minimum margin) — the room is computed by the system, the AI never sees the floor. | Anything beyond the room: one card to the owner with three buttons (accept the customer's price / counter N / refuse). | Below-floor prices, credit («qarzga»), special terms, guarantees. |
| **5. Closing** | Opens the client code (GS…), marks the lead won, opens the deal, sends the China warehouse address for the chosen city and the marking instruction with THAT code («har bir karobkaga GS1042 yozing»), sends the address picture, asks when the supplier delivers and records «kutilayotgan yuk» so Yiwu/Guangzhou expects it, and gives the customer the company bot link for tracking. | — (or one press, if the owner keeps code opening for himself — question 11) | — |
| **6. The cargo's journey** | Answers «yukim qayerda» from the cabinet's own data. Does NOT repeat what the company bot already sends (received in China, arrived in Uzbekistan, handed over — `notices/arrival-jobs.ts`). For a customer who has not linked the bot it passes the same news in its own chat. Links the prixod to its deal and chases a missing price. | The logist when the customer asks WHY a truck is late and no typed reason exists. The warehouse/seller when the customer presses «Xato bor» on received kg/kub. | Disputes about weight, shortage, damage — resolution. |
| **7. Payment and debt** | Tells the balance to a phone-proven customer. Reminds when cargo is ready and the bill is unpaid, on the owner's schedule and wording. Takes «to'ladim» + cheque photo, reads the amount, and files it in the accountant's queue; confirms to the customer only after the accountant does. Records a payment promise date. | The accountant to confirm a payment. The owner for any request to release cargo with debt. | Confirming money received, credit, deferral («muddat»), refunds, compensation, write-offs. |
| **8. Handover** | Tashkent warehouse address, hours, map; reminder when cargo waits 5 and 10 days; a thank-you and one question about the service after handover. | A person the moment the answer is a complaint. | Complaint resolution. |
| **9. Repeat business** | Two to three weeks after handover asks about the next partiya. Writes to quiet customers with a real reason (new tariff, last loading date before Chinese New Year, their usual season). Birthday and Friday greetings as campaigns. | The owner approves each campaign's list and sample once — not each message. | Cold mass outreach to people who never wrote (never from this number). |

Three things the finished AI never does, whatever is switched on: state a number, address, date or code that the
system did not hand it; claim to be a human; touch another customer's data.

---

## 2. A DAY IN THE LIFE

### 2.1 The owner's day

- **08:30** — one message in the staff bot: «AI kecha: 64 suhbat, 9 yangi lid, 6 narx aytildi, 2 yutildi (GS1041,
  GS1042 — 7,5 kub kutilmoqda), 5 ta savol odamlarga ketdi, xarajat $11,40. Akkaunt sog'lom.» Under it: three
  items that wait for HIM (a discount beyond the room, a complaint, a question nobody could answer) and five
  randomly chosen replies of yesterday with «to'g'ri / xato» buttons — two minutes of work.
- **During the day** — he is not shown ordinary replies at all. He gets a card only when a hand-over rule fires
  (section 3.5). Each card is a decision with buttons, not a text to proofread. Questions about customs go to the
  VED, about a truck to the logist, about a payment to the accountant — not to him.
- **Any moment** — «/agent off» stops everything within a minute (exists). New: «pul to'xtasin» keeps the AI
  talking but freezes every price and concession, for the day he changes a tariff.
- **20:00** — the AI line in the evening summary (`reports/ai-spend.ts` already carries the cost).

### 2.2 Scenario A — a new customer, 3 kub of clothes, photos and a voice note

(The $390 is the real table: 420 kg / 3 m3 = 140 kg/m3, band «up to 150» = $130/m3 in
`agent/site-estimate.ts SITE_TARIFF`. Customs and markup figures are illustrations.)

| Time | What happens | Guard at work |
|---|---|---|
| 10:14 | Dilnoza (from an Instagram advert) writes «Assalomu alaykum, Guanchjoudan kiyim olib kelmoqchiman», sends 4 photos of cartons and a 38-second voice note. | Lead opens by itself. Photos and voice are read ONCE each and remembered as text. |
| 10:15 | AI: greets, says it is GSR's AI sales assistant, and repeats what it understood: «25 karobka, har biri 60x40x50 sm — taxminan 3 kub, og'irligi 420 kg atrofida, ayollar kurtkasi. To'g'ri tushundimmi? Faqat yo'lkira kerakmi yoki rastamojkasi bilan?» | A figure heard in a voice note is never used for a price until the customer confirms it in text. |
| 10:17 | «Ha to'g'ri. Rastamojkasi bilan. Invoys bor» + an Excel invoice. | Excel is read without any model (`deals/goods-file.ts readGoodsFile`) — exact rows, zero cost. |
| 10:19 | AI, two messages: (1) the PRICE BLOCK, written by the system: «Yo'lkira taxminan $390 — 3 kub, 420 kg, Guanchjou omborimizdan Toshkentgacha, 15-25 kun. Boj va QQS alohida.» (2) «Bojxona to'lovlari taxminan $1 100 – 1 300 (rasmiy emas). Aniq narxni bojxona bo'limimiz hisoblab beradi — javobi kelishi bilan yozaman.» Same minute the job lands in the VED queue with the invoice attached (`calc/intake-land.ts landIntake`). | Price and estimate are inserted blocks; the model wrote only the sentences around them. |
| 12:40 | The VED presses «Готово»: $1 480. The system adds the owner's markup (say 8 %) and rounds up: $1 599. AI sends the official offer + the PDF sheet, writes the offer on the card, moves the lead to «AI narx aytdi». | Re-priced at the moment of sending (`estimate_moved`, `calc_price_moved` exist). The floor $1 480 never enters the AI's context. |
| 12:52 | «Qimmatroq ekan, 1500 qilib bering.» The AI asks the system what it may do; the answer is «not lower than $1 540». AI: «1 540 gacha tushira olaman — shu oxirgi narxim. Undan pasti bo'lsa rahbarimizga yetkazaman.» Customer agrees. | The concession came from a tool that enforces the room; it is logged on the deal as «AI chegirmasi $59». |
| 12:58 | AI asks for a phone number (the Telegram number is hidden), opens GS1042, marks the lead won, sends the Guangzhou address block with «har bir karobkaga GS1042 yozing» and the address picture, asks when the supplier brings the goods, records «kutilayotgan yuk: 25 karobka, 420 kg, 3 kub, 21-noyabr», and gives the bot link for tracking. | The address is a verbatim block from Bilimlar; the code in it comes from the database. |
| Owner | Saw nothing during the day. Evening line: «Yangi mijoz GS1042 — 3 kub kiyim, $1 540, AI chegirmasi $59.» | — |

### 2.3 Scenario B — a returning customer: «yukim qayerda» and a discount

| Step | What happens | Guard at work |
|---|---|---|
| 1 | Rustam (GS777): «Salom, yukim qayerda? Keyingi safar 12 kub olib kelaman, narxni tushirib bering.» | His phone is on the client card, so cargo and balance may be told (`agent/context.ts chatIdentity` → `cargoAllowed`). |
| 2 | AI, message 1 — the STATUS BLOCK from the cabinet: one lot «Tranzit», expected 24-28 noyabr («va'da emas»); 14 karobka ready at the Tashkent sklad for 3 days. Message 2: «Tayyor yuk bo'yicha qoldiq $420 — to'lab olib ketishingiz mumkin.» | No batch code, no plate; the window is the cabinet's own. The balance goes alone only if the owner allowed it (question 21). |
| 3 | For the next 12 kub the AI asks kg (2 100 kg → 175 kg/m3 → $160/m3 → $1 920 from the table) and sends the price block. | Table price, inserted. |
| 4 | Discount on a table price is outside the AI's room (if the owner chose so). AI: «Narx jadval bo'yicha $1 920. Chegirma so'rovingizni rahbarimizga yetkazdim, bugun javob beraman.» The owner gets one card: [3 % ber] [5 % ber] [Yo'q] [O'zim yozaman]. He taps «3 %». AI tells Rustam $1 862 and writes it on the new deal. | A holding line, a routed decision, one tap. The promise «bugun» is the AI's own SLA — if nobody answers in N hours it escalates and says so. |
| 5 | «Nega Xorgosda turibdi?» The logist typed a 2-day wait on the queue panel, so the AI says so. Had there been no typed reason, the question would go to the logist's inbox and the AI would come back with the answer. | A reason is told only when a source exists. |

---

## 3. THE AUTONOMY MODEL — what replaces «everything waits for the tick»

### 3.1 Risk tiers per ACTION

Every thing the AI can do is one of about twenty named actions. Each action has a tier, a dial, a limit and a
record. The tier comes from two questions: does it commit the company to money, and can it be undone.

| Tier | What it is | Actions | Can it be undone | Guard that applies | Default |
|---|---|---|---|---|---|
| **T0 — Talk** | No fact of ours leaves, nothing is promised | converse, ask, explain from Bilimlar, answer an objection with arguments, pass a VED hand-back question, a holding line | the next message corrects it | reviewer model only | alone |
| **T1 — Facts out** | A fact from the system is told | cargo status and ETA window; China address + marking; Tashkent address; balance; yo'lkira/avia table price; AI customs estimate (range, «rasmiy emas») | correctable, but a wrong address or price costs real money | fact inserted by the system from a tool + identity proof (cargo, balance) + size ceiling (price) + reviewer | alone, each on its own dial |
| **T2 — Internal work** | The CRM changes, the customer is not committed | open/attach a lead, notes, customer facts, open-stage moves, calc to the VED, task or question to a colleague, «kutilayotgan yuk», link prixod to deal, payment claim to the accountant, payment promise date | a person can reverse every one | the door's own checks + `agent/machine-owner.ts machineMayTouch` + daily caps | alone |
| **T3 — Commitments inside limits** | The customer is told something we must stand behind, or something irreversible is created | official price (VED + markup) with the PDF and the offer on the card; a concession inside the room; opening a GS code; winning the lead; a payment reminder; writing first (follow-up, journey news); a campaign | no (a code goes on cartons; an offer is an offer) | everything of T1 + a hard limit enforced inside the tool + re-check at the moment of sending + its own daily count + sampled audit | alone with limits; each opened separately |
| **T4 — A person's, for ever** | Outside any limit | below the floor; credit, deferral, cargo released with debt; refund, compensation; guarantee or legal promise; resolving a complaint; confirming a payment; tariffs and markup; another seller's customer's money; cold outreach | — | the AI cannot do it: no tool exists; a reply that tries is held | hand-over |

The important change from today: **the tier is decided by what the message contains and what it does — never by
the model's own label** (`category`) **or its own confidence** (`low_confidence`).

### 3.2 The dials — one settings page («AI sotuvchi huquqlari»)

One row per action: **level** (O'chiq → Avval karta → O'zi, N soniya to'xtatish imkoni bilan → O'zi), **limit**
(a number), **who is asked** when the limit is hit. Global dials underneath.

| Dial | What the owner sets | Exists today |
|---|---|---|
| Level per action | off / card first / alone with a hold / alone | only as 7 «kinds» in `agent_auto_config.categories`; `price`, `calc`, `calc_price` ship unticked |
| Table-price ceiling | «o'zi aytadi: N kubgacha yoki $N gacha» | no (`agent/estimate.ts YOLKIRA_GUARDS` is a constant: 100 m3, 20 t, min $50) |
| Customs estimate to the customer | off / range only / up to $N | no — forbidden in three places (`calc/prefill.ts` header, `tests/unit/estimate-wire.test.ts`, prompt rule 11) |
| Markup on a VED answer | % or $ | yes: settings `agent_calc_markup_kind/value` (ships empty = no markup) |
| Negotiation room | share of the markup the AI may give back; minimum margin above the floor; monthly total it may give away | no — any discount word is blocked (`agent/policy.ts PROMISE_TABLE`, category `discount`) |
| Code opening | on/off; at most N a day; needs phone + goods + kub | no — prompt rule 12 «GS kodni Bekzod o'zi ochadi» |
| Avia address, rail, other cities | give the AI the data, or keep the question for a person | partly: `agent_config.avia_usd_per_kg`; avia address and rail always go to him |
| Whose customers | only its own and unassigned / also colleagues' customers for T0-T1 | fixed in code: `machineMayTouch` |
| Quiet hours | replies at night to a customer who just wrote: yes/no; proactive: never at night (rule) | constants `nightFromHour 22`, `nightToHour 8`, `nightFreshMs 2 h` |
| Pace | messages per chat per day, per hour, per day | per hour/day yes (`agent_send_caps`, max 100 / 200); per chat no (`perChatPerDay 12` constant) |
| Reply window | how old a customer's unanswered message may be (today 24 h → 7 days suggested) | constant `anchorMaxAgeMs` |
| Writing first | off / follow-ups only / + quiet customers; how many a day | no — nothing can write first |
| Budget | dollars a day for the AI; documents and voice minutes a day | tokens and runs only (`daily_token_cap` 3 000 000, `daily_draft_cap` 150) |
| Audit sample | how many sent replies a day come back for «to'g'ri / xato», and to whom | no |
| Routing | which colleague answers which kind of question, and how long before it climbs to the owner | no — only the account holder is asked |
| Persona | the name it uses, the «AI yordamchiman» sentence | no — the prompt still says it writes Bekzod's draft in the first person |
| Kill switches | all off (exists) / money frozen / writing-first off / one chat off (exists) | partly |

### 3.3 How trust is earned and measured

He refused a proof gate before («50 talik test bolmasin»), and he was right that waiting for his own presses
measures his patience, not the AI. So nothing below delays switching an action on. It decides when an action is
switched back DOWN, and it gives him a number to look at.

1. **Fact accuracy (must be 100 %).** Every night a checker compares each price, address, code, status and
   balance the AI sent with what the database said at that minute. Because those are inserted by the system, one
   mismatch is a defect in the system, not a judgement call: that action pauses itself and an alarm goes out.
2. **Audited error share — the number that says «safe».** A random sample of sent replies (default 10 a day,
   weighted toward T3) is marked «to'g'ri / xato» by the owner or a person he trusts. Shown per action as
   «oxirgi 30 kun: 212 tekshirildi, 3 xato — ko'pi bilan 3,6 %» (the upper 95 % bound, the same Wilson arithmetic
   as `agent/calibration.ts`, which today gates nothing). Suggested reading: T0 green up to 5 %; T1 and T3 green
   up to 2 % over at least 100 checked.
3. **Customer signals.** Blocks per 100 chats, «botmisiz?» count, «odam bilan gaplashaman» requests, chats that
   went silent right after an AI reply.
4. **Step-down is automatic, step-up is always his press.** Two confirmed wrong replies of one action in 7 days →
   that action alone drops one level (to «card first») with an alarm. This extends today's `AUTO_STEP_DOWN`
   (`agent/auto-send.ts`: 2 bad marks in 7 days, a block within 7 days, a second «botmisiz?» chat), which disarms
   EVERYTHING at once.
5. **The employee's numbers** (what a sales manager is judged by): median time to first reply, lead → priced →
   won, kub and kg brought, money won, concessions given, share of conversations handed to a person and why,
   cost per conversation and per won deal — beside the human sellers.

Before a new brain or a new rule goes live it sits an exam (section 4, block H): the dangerous cases the project
already collected must still be held, and the result is printed as a number.

### 3.4 What makes the AI hand over to a person

| Trigger | Goes to |
|---|---|
| The customer asks for a person, or asks a second time the same thing the AI could not answer | the customer's manager, else the owner |
| Anger, complaint, damage, shortage, «pulimni qaytaring», anything legal | owner (or the person he names) — the AI apologises, collects the facts (which code, photo) and stops |
| A price request beyond the room; below the floor; credit; cargo with debt | owner, with buttons |
| A customs question the Bilimlar cannot answer; a VED hand-back the customer cannot resolve | VED |
| «Nega kech?», a truck question with no typed reason | logist |
| «To'ladim», a cheque, a disputed balance | accountant |
| Pickup time, a box not found, «Xato bor» on kg/kub | warehouse / the customer's seller |
| The reviewer model refuses the AI's reply twice | owner's inbox, with the reason in words |
| Identity not proven and the customer insists on cargo or balance | the customer's manager |
| A customer the owner marked «faqat men» | owner |
| A limit, budget or cap is reached; the account is unhealthy | owner, as an alarm |

A hand-over is three things at once: a short honest line to the customer («mas'ul xodimimizga yetkazdim, … ichida
javob beramiz»), a complete card to the right person, and a clock — no answer in N minutes and it climbs one step
up. Today the holding line was dropped because the AI's own newer message cancels its waiting reply
(`human_replied` in `agent/send-step.ts`); the new conversation engine removes that limit.

### 3.5 How a person takes over and gives back

- **Answer through the AI** (the commonest): the person types the answer on the card; the AI passes it on in its
  own words and keeps the conversation. This is his «sotuvchi javob bersa ushani olsin» — it exists for one person
  (the answer card, `agent/owner-answer.ts`), and must work for every colleague the routing names. A figure the
  person typed is a trusted source (the rule «his price outranks the machine» exists: `ownerPricedChain`).
- **Take the chat**: «Suhbat meniki» — the AI goes silent in that chat (exists: `human_until`, 24 h). Because the
  seat is nobody's personal phone, the person writes from the seat's number through the CRM chat screen; that
  needs a named permission (question 25).
- **Give back**: «AI davom etsin», or automatically after the person has been silent for the pause the owner set
  (`human_pause_min`, exists). Before leaving, the person may write one line («5 % berdim, to'lov juma kuni») —
  it is stored as a fact about this customer so the AI does not contradict it.
- **Stop one message**: while an action is on the «with a hold» level, the card shows a countdown and a stop
  button (exists). New: «qaytarib ol» — Telegram lets an account delete its own message for both sides; if the
  customer has not read it yet, a wrong reply can be withdrawn.

### 3.6 THE GUARD — five walls

**Wall 1 — facts come only from tools (exists, keep).** The AI knows no price, address, cargo or balance by
itself. Its toolset is a closed list (`agent/tools.ts TOOL_SPECS`), the tools read the customer the SERVER resolved
(never an id the model passes), cargo and balance need a proven phone.

**Wall 2 — numbers and addresses are INSERTED, not written (new; this is what lets the word readers go).**
The model writes sentences. A price, an address with its marking line, a status, a balance, a date and a client
code are **blocks the system renders** from the tool's result, in wording the owner approved once per language —
so the price block always carries «taxminan», what it is for (kub, kg), «Toshkentgacha» and «boj va QQS alohida»,
because code wrote it, not because a rule searched for the words afterwards. After rendering, one small exact
check: the model's own sentences may contain no digit except the customer's own figures repeated back, no
currency word, no phone, no link, no code shape, and no text of an address outside its block. Any hit → one
automatic rewrite, then hold. This replaces `digits.ts`, most of `numbers.ts`, `auto-money.ts`, the hedge-sentence
matchers (`estimate_unhedged`, `warehouse_condition`, `destination_unsaid`, `estimate_unnamed`) and the whole avia
address reader family — a few dozen lines instead of several thousand.

**Wall 3 — the action gate: limits live inside the tools (new, replaces the 47-code gate).** Each action checks
its dial, its limit and its daily count in code, at the moment it runs. The concession tool answers «the lowest
price you may say is $1 540» — the model cannot argue with it and never sees the floor (law 4 stays:
`recordOffer` with `mayApprove:false`, never commission — `calc/upsale.ts payableOffersSql({machineOffers})`).
The code-opening tool refuses the eleventh code of the day. Prices are recomputed when the message is actually
sent, as today.

**Wall 4 — a second model reads every outgoing message (new).** A separate call, with its own instructions and
none of the writer's reasoning, sees the conversation, the message and the list of inserted blocks, and answers a
fixed checklist: is anything promised (the eight kinds the project already named in `PROMISE_CATEGORIES`:
discount, guarantee, credit, refund, free extras, a dispatch date, «customs included», «no duty»)? any claim with
no block behind it? another customer mentioned? the right language? is the customer angry or asking for a person?
does it claim to be human? Verdict: send / rewrite once with my notes / hand over. T3 messages are reviewed by the
stronger model. A short list of trigger words per language is kept — not as a judge (today a hit BLOCKS) but as
a tripwire that sends the message to the stronger reviewer; a false alarm then costs one extra model call instead
of one press of the owner.

**Wall 5 — after sending: measure and brake (partly exists).** The nightly fact check, the audit sample, customer
signals, per-action step-down (3.3), withdrawal of an unread message, and the account brakes that exist today and
stay untouched (`agent/forced-off.ts FORCED_OFF_REASONS`: `account_paused`, `flood_repeat`, `blocks`,
`telegram_notice`).

**What stays deterministic, for ever, no matter how good the reviewer is:** money figures, addresses, client and
system codes, phones, links, dates, identity before cargo or balance, every limit, the re-price at sending, the
floor never in context, the closed toolset. The reviewer judges MEANING; it is never the only wall in front of a
number.

**Audit trail.** For every customer-visible message: the action and tier, each block with the tool call that
produced it, the reviewer's verdict, the dial and limit state at that minute, who or what released it, model and
cost. Most of the raw material exists (`agent_runs.tool_calls`, `agent_drafts.policy`, `agent_auto_verdicts`,
audit rows `via:'auto'` / `via:'ai'`, `agent_offers`); new is one «why did the AI say this» view per message and
a ledger of limit consumption (concessions given this month, codes opened today).

**Kill switches.** All off (`/agent off`, exists, one minute). Money frozen (new). Writing-first off (new). One
action off (the dial). One chat off (exists). Automatic: the four forced-off reasons, the budget, the per-action
step-down, and a watchdog the other way round — a customer waiting more than N minutes with no reply and no
hand-over raises an alarm, so the AI can never go silent unnoticed.

### 3.7 Today's rules: delete, keep, or turn into a dial

**DELETE (they exist because the old guard reads words or trusts a self-rating):**

| Rule today | Where | Replaced by |
|---|---|---|
| `low_confidence` (model's own 0.80) | `auto-gate.ts` | nothing as a gate; walls 2-4. Kept only as a logged signal |
| `category` by the model's own label; `complaint` / `other` never | `auto-gate.ts`, `auto-categories.ts` | the tier of what the message contains and does |
| `streak` (third reply in a row waits) | `AUTO_STREAK_MAX = 2` | a loop detector (two robots talking) + the per-chat daily cap |
| `media`, `media_only` (silence, no card), `voice_only`, a later media line cancelling an approved reply | `auto-send.ts burstHadMedia`, `worthy.ts draftWorthy`, `send-step.ts asksAnew` | the AI reads the photo, file, voice note |
| `questions` (more than one «?») | `policy.ts` | nothing |
| `wrong_script`, `language`, `gloss_missing` | `policy.ts`, `locale.ts` | the reviewer's language check; an Uzbek gloss only on a supervisor's card |
| `too_long` 400 / 700 | `auto-gate.ts`, `policy.ts` | split into two or three messages |
| `warnings` and `notes` as one lump; the late note | `auto-gate.ts`, `run.ts lateNote` | each is either information or a named stop |
| `not_reply` (a VED hand-back question never goes alone) | `auto-gate.ts` | T0 |
| `owner_figure`, `answer_stale` | `auto-gate.ts` | a person's answer is passed on as given |
| «no card on his phone, no send»; the 120-second hold counted from the card ringing | `auto-send.ts` (`unseen`, `countdownMayRide`) | a hold only where the dial asks for one |
| `repeat` (an impatient customer repeating the question gets silence) | `eligibility.ts` | answer |
| the promise word tables: about 1 200 lines incl. `timePromise`, `dayPromise`, `vagueTravelTime` | `policy.ts PROMISE_TABLE` | wall 4 (meaning) + wall 2 (a date can only be a block) |
| the price-sentence matchers | `policy.ts` G11, `auto-money.ts`, `destination.ts` | wall 2: the block is written by code |
| the avia road readers (`chatRoadOf`, `aviaSpokenOf`, address anchors) | `run.ts`, `numbers.ts`, `policy.ts` | the address is a block from a tool that is told the road; the reviewer checks the road matches the chat |
| `calc_recent` (14 days) | `calc-submit.ts` | the AI's judgement «is this the same cargo»; the VED can merge |
| the 12-per-chat run and send caps as constants | `limits.ts` | dials with higher defaults |
| `human_active` after a person's message on the seat | `eligibility.ts` | only the explicit takeover (nobody types by hand on the seat) |

**KEEP as they are (cheap, exact, about money or other people's data):**
tool-only facts and the closed toolset; identity proof (`cargoAllowed`); `other_client_code`, `system_code`,
`foreign_phone`, a colleague's full name, `canary`, links only from Bilimlar, `mention`; `ai_denial` (never «men
bot emasman»); the re-price at sending (`estimate_moved`, `calc_price_moved`, `offer_gone`); a person's price
outranks the machine (`calc_owner_priced`, `calc_person_offer`, `answer_noted`, `discounted`); the floor never in
context; `tariff_unconfirmed` (a changed tariff freezes prices until one press); size sanity
(`YOLKIRA_GUARDS`, the 1 kub / 100 kg minimum); `staff_peer`, `excluded`, `muted`, `not_private_user`,
`auto_sent`, `echo`; `identity_changed`; and every account brake of section 4-E.

**TURN INTO OWNER DIALS:** which actions go alone; hold seconds; price ceiling; customs estimate; negotiation
room; code opening; rail / avia address / other cities; whose customers (`machineMayTouch`); night; reply window
(24 h → days); messages per chat and per day; writing first; budget; audit sample; routing; persona; Pashto.

---

## 4. THE STRUCTURE — building blocks

| Block | Exists today | Change | New |
|---|---|---|---|
| **A. Senses** | Every photo (≤ 10 MiB), voice note, file (≤ 20 MiB) the customer sends is already stored (`scripts/tg-listen.ts saveMediaFor`). Three readers exist for staff: `receipts/tarkib-read-ai.ts readTarkibDocument` (one document → rows with pcs, kg, m3), `calc/intake-ai.ts analyzeIntake` (many files → a calc request), `deals/goods-file.ts readGoodsFile` (Excel with no model). `agent/calc-files.ts chatFilesForJob` already finds a chat's files. | The run's context must carry attachment ids (`agent/context.ts chatMessages` reads only type and name); the model seam must carry images (`platform/ai/model.ts ModelBlock` has no image member). | A «read this file» tool with read-once memory per attachment and a daily limit; speech-to-text (an outside service — the installed AI SDK has no audio input) with a transcript store; the rule «a heard or read figure is repeated back before it prices anything». |
| **B. Brain and tools** | One customer burst → one model run → ONE text message ≤ 700 chars; 9 tools; 3 actions (`calc_submit`, `set_followup`, `mute`); the prompt opens with «qoralama … Bekzod o'qiydi»; `next_step` is written and read by nobody. | A conversation engine: a goal (bring this lead to an order), a sale stage, a plan with a next step and a time, 1-3 messages per turn, its own newer message no longer cancelling the earlier one, a larger budget per turn; the stronger model for negotiation, complaints and documents. | Tools: customer profile, receiving address (told the road), truck plan, customs estimate, concession, read file. Actions: open code, win lead, expected cargo, link prixod, note, question or task to a colleague, payment claim, follow-up that ACTS, send file / picture / location, hand-over. |
| **C. Customer memory** | The last 100 messages of this chat; the remembered language; facts only the owner pressed in (`kb_facts` scope client/lead); 14 seeded company facts (`agent/seed-kb.ts`). | A customer fact may be written by the AI itself, marked as heard in chat, visible and editable on the client card, never a company-wide fact. | A profile per customer (what he ships, usual kub, city, road, last price, what was promised and by whom); a summary of older history; the result of every file read. |
| **D. The guard** | Walls 1 and part of 5; the re-price at sending; law 4; the leak fences. | `policy.ts` shrinks to the exact checks of 3.7 «keep»; the 47-code gate becomes the action gate. | Blocks (wall 2), the reviewer (wall 4), tiers + limits ledger (wall 3), the nightly fact check and the audit sample (wall 5). |
| **E. Sender and account protection** | The careful send: verify → mark read → pause → «yozmoqda» → verify → send (`agent/send-step.ts`, `agent/gramjs-adapter.ts`); the fuses of `agent/limits.ts AGENT_LIMITS` (≥ 20 s per chat, 10-25 s between sends, 20/hour, 80/day, 14-day ramp, night); never to someone who has not written (`never_wrote`); automatic off on a restriction, two flood waits in a day, two blocks in a week, a notice from Telegram (`crm/account-guard.ts`, `crm/account-alarm.ts`). | Caps counted per conversation turn; the ramp tied to health (a clean week raises the ceiling a step, an incident lowers it); several messages per turn with typing gaps. | Sending a file, picture, location; withdrawing an unread message; the proactive engine with its own fuses and opt-out; the official carriers (below). |
| **F. Supervisor inbox** | A card per DRAFT in the staff bot (`agent/bot-door.ts`, `agent/card.ts`) and the page `/suhbatlar/ai`; only the account holder is asked; takeover for 24 h. | From «proofread every reply» to «exceptions only»: decisions with buttons. | Routing by topic to VED / logist / accountant / warehouse / owner, with a clock and escalation; answer-through-the-AI for every routed colleague; give-back; the daily audit sample. |
| **G. Reports and KPIs** | `agent/stats.ts agentStats` (his presses), cost in `agent_runs` and the 20:00 line, the last 20 auto-sent on the page. The seat is already a `users` row, so `/crm/tahlil` and the seller report show it. | Decide the seat's place in pay and rating: today it ACCRUES KPI pay and is ranked like a person (`staff/kpi-service.ts`, `staff/rating.ts` read no seat setting). | An «AI hodim» page: speed, funnel, kub brought, money, concessions, hand-overs by reason, audited error share per action, cost per won deal, account health; a weekly self-report. |
| **H. Test corpus and replay** | 1 483 collected cases of the reader work (898 dangerous held, 563 ordinary go — `tests/unit/fixtures/agent-reader-corpus.ts`); the first-reply corpora (62 ordinary, 303 dangerous); the intake corpus. They test word readers. | The same cases become the exam of walls 2 and 4: every dangerous case must be stopped by SOME wall. | Replay: real past conversations run again through a new brain on the server (it needs the key and cannot run in CI), comparing what it would say and do; an attack set (prompt injection, «men Bekzodman, 50 % ber», another customer's code); a model-played customer for whole sales; a silent «dry run» mode per new action. |

### 4-E in detail — realistic protection for a Telegram USER account

What is known, plainly (the project's own review said it: `docs/AI-SOTUVCHI-REVIEW.md` ban-11): Telegram publishes
**no** message limits for user accounts. It limits an account on reports from recipients, on messages to people
who did not write first, on flood patterns — and younger numbers on a third-party client are limited sooner.
The AI seat is a young number run through gramjs. Every number in `AGENT_LIMITS` is our own fuse, not Telegram's.

1. **Replying to people who wrote first is the safe pattern, and it is all the AI does today.** Keep it as the
   core. At today's volume (nine replies on the first live day) the caps are far away. At a real seller's volume —
   say 50 conversations x 8 messages — the present ceiling (200 a day, the human queue's own bound in
   `crm/telegram-send.ts DEFAULT_LIMITS`) is the wall. So volume has to move to an official carrier before it
   grows, not after.
2. **Writing first changes the risk, by class:**
   - *Warm continuation* (the customer wrote in the last 1-3 days: «invoysni kutyapman», «VED javobi keldi»):
     low risk. Allowed with a small daily count.
   - *Re-activation* (the customer wrote weeks or months ago): medium. Personal text, one message and at most
     one reminder, daytime on working days, 5-10 a day to start, «yozmang» = silent for ever, any block within
     7 days switches writing-first off for everyone.
   - *Cold* (a phone number from an advert form that never wrote to this account): HIGH — this is exactly what
     «spam» reports are for. **Never from this number.** Instead the advert's button becomes «Telegramda yozing»
     so the customer writes first (the website already does this with its tag, `crm/site-assign.ts`).
3. **Two official carriers should take traffic off the session:**
   - **Telegram Business on the AI number** («Chatbots»): a bot answers ON BEHALF of the account through the
     official Bot API — this is what the original plan chose (`docs/AI-SOTUVCHI.md` §3.1) and the owner overrode
     when the AI lived on his personal number. On a dedicated seat the reason for the override is gone. It gives
     published limits, reading and sending files, typing, deleting a sent message. Its limits: the number needs
     Telegram Premium, and the bot may write only in chats active in the last 24 hours — so it carries REPLIES,
     not re-activation. To check on a test phone before choosing: whether the customer sees any «via bot» mark.
   - **The company bot** (the cabinet): no ban risk at all, and it may write first to anyone who pressed start.
     It should carry every operational message (it already sends received / arrived / handed over), the payment
     reminders, «yukingiz 5 kundan beri kutyapti», and re-activation for linked customers; and the AI should
     ANSWER customers who write to the bot (today their text is only relayed to a manager,
     `platform/telegram/client-cabinet.ts forwardClientMessage`). The lever is to link every new customer to the
     bot at closing — which also repairs today's gap that an unlinked customer gets no pushes at all.
4. **Hygiene and continuity:** a Business profile on the seat (hours, location, greeting); two-step password and
   recovery e-mail; one listener process only; the SIM kept alive; **a second, already warmed number in
   reserve**; and the fact that a ban of the seat stops one channel, not the company — the chat history is in the
   CRM, the customers are reachable through the bot and the office. The seat not being anybody's personal number
   already satisfies the old plan's condition «a ban never costs a person's account» (§18.4).

---

## 5. THE ROAD

Sizes are rough: S = days, M = one to two weeks, L = three weeks or more, at this project's usual pace with a
design review before code and a review after.

| # | Stage | What is built | What the owner can STOP doing | Depends on | Size |
|---|---|---|---|---|---|
| **1** | **«Qo'yib yuborish»** — release the safe majority | Remove the holds that protect nothing (3.7 delete list, first half: `low_confidence`, `streak`, the label `category`, `questions`, `language`, the lumped `warnings`/`notes`, `not_reply`, `owner_figure`, `repeat`, the card-must-ring hold); table price, calc-to-VED and VED-price kinds on by default; long replies split in two; 12 → 40 per chat; reply window 24 h → 7 days by day; the prompt rewritten: an AI seller with a goal, not Bekzod's draft; when the customer wants «rastamojkasi bilan» the job goes to the VED without asking which section. The OLD strict money rules stay as the guard for this stage. | Pressing the tick on greetings, questions, addresses, cargo status, table prices, VED prices, and every third reply. | His answers 1-4, 6, 26. Nothing external. | S-M |
| **2** | **«Ko'z va quloq»** — eyes and ears | The AI reads photos, PDF, Excel from the customer (wiring the readers that exist), repeats what it read, attaches it to the VED job; voice notes through a speech-to-text service after a trial on ten real notes; `media` holds removed. | Answering every chat that contains a photo, an invoice or a voice note himself. | Stage 1; his answers 14, 15. For voice: a provider and a key. | M (eyes) + S-M (ears) |
| **3** | **«Yangi qo'riqchi va istisnolar qutisi»** — the new guard and the exceptions inbox | Blocks, the reviewer, tiers and the dial page, the limits ledger, the nightly fact check, the audit sample; the inbox by exception with routing to VED / logist / accountant / warehouse, clocks and escalation, the holding line, answer-through-the-AI for colleagues; the word tables deleted once the exam shows every dangerous case stopped. | Being the only person the AI can ask; reading cards that need no decision. | Stage 1; his answers 24, 25, 28, 29. | L |
| **4** | **«Narx va yopish»** — price and close | The AI's own customs estimate to the customer (if allowed); the PDF offer and pictures sent by the AI; opening the GS code; winning the lead; the address block with the code and the address picture; «kutilayotgan yuk»; the bot link at closing; linking the prixod to the deal. | Opening codes, forwarding offers, sending addresses and marking instructions, entering expected cargo. | Stages 2-3; his answers 5, 10-13, 32. | L |
| **5** | **«Savdolashish va to'lov»** — negotiation and money | The concession tool and the room dials; one-tap discount cards beyond the room; balance and payment reminders; «to'ladim» → the accountant's queue; payment promise dates. | Handling the standard «qimmat, tushiring»; reminding about bills; passing cheques to the accountant. | Stage 3; his answers 7-9, 21, 22. | M |
| **6** | **«Kanalni mustahkamlash»** — harden the channel | Telegram Business on the seat as the reply carrier (if he agrees); the AI answering inside the company bot; the reserve number; health-tied ramp. | Worrying that more volume means more ban risk. | His answers 16, 17, 20; a test phone. | M |
| **7** | **«O'zi yozadi»** — it writes first | Follow-ups that act on their date; journey news for customers without the bot; cargo-waiting and after-handover messages; re-activation of quiet customers; campaigns with one approval (Friday, birthdays). | Chasing silent leads; remembering who to write to; the Friday greetings. | Stage 6 first — never before the channel is hardened; his answers 18, 19, 27. | M-L |
| **8** | **«AI — hodim»** | The employee page and weekly self-report; pay and rating rules for the seat; the replay lab; later other channels (WhatsApp, Instagram) on the same guard. | Asking «is it working?» — he reads it. | Stage 3's records; his answers 30, 31. | M, then ongoing |

Stage 1 is first because it removes the daily pain he named with the least new risk: it deletes refusals, it adds
no new power, and the strict money rules built so far keep standing until stage 3 replaces them.

---

## 6. QUESTIONS FOR THE OWNER

Each has one recommended option, marked (REC), with the reason in the line after the dash.

**Who the AI is**
1. How does it introduce itself? a) (REC) openly: «GSR kompaniyasining AI sotuv yordamchisiman», once, at the first
   hello b) as Bekzod in the first person, as today c) a human name, AI not mentioned.
   — The account is already called «AI sotuvchisi»; an honest opening removes the whole «botmisiz?» problem.
2. «Botmisiz?» — a) (REC) one honest line and it continues b) every time to a person, as today.
   — It may never deny it anyway; handing over each time loses the customer.

**What goes alone**
3. Ordinary conversation (greeting, questions, explanations, addresses, cargo status): a) (REC) alone, no card
   b) alone, with a 2-minute card to stop it c) as today. — This is nine tenths of the volume and carries no money.
4. Yo'lkira from the table and avia by kg: a) alone always b) (REC) alone up to a size you name (suggested: 15 kub
   or $3 000), above it a person c) always a person. — A table price is public already; the ceiling bounds a mistake.
5. A customs estimate by the AI itself, before the VED answers: a) never, only the VED's figure (today)
   b) (REC) a range marked «taxminiy, rasmiy emas» at once, and the exact figure from the VED c) the AI's figure is
   final for small cargo. — The customer gets an answer in minutes instead of hours; the official price stays the VED's.
6. The VED's figure becomes the customer's price with a markup: a) (REC) a percent — which? b) a fixed sum per kub —
   which? c) no markup (today's empty setting). And does that price go alone? a) (REC) yes b) card first.
   — Without a markup the AI sells at cost; the figure is recomputed at the moment of sending.
7. May the AI give a discount by itself? a) never (today) b) (REC) only on VED-priced jobs, up to a share of ITS
   markup you name, never below the floor plus a minimum margin c) also on table prices for volume (for example
   from 10 kub up to 3 %) d) only for repeat customers. — It gives away only money it added itself; the floor is untouched.
8. A discount request beyond that: a) (REC) one card to you with buttons (3 % / 5 % / no / I write) b) the AI
   refuses by itself c) to the customer's seller. — One tap instead of a conversation.
9. A monthly ceiling on what the AI may give away in total: a) none b) (REC) a sum you name, shown on the page
   c) per deal only. — A bounded, visible cost.
10. «Qachon jo'naydi?»: a) only «15-25 kun, va'da emas» (today) b) (REC) the next planned loading from the truck
    board, said as «reja» c) a person. — Sellers win with a date; «reja» is honest and has a source.

**Closing**
11. The client code (GS…): a) (REC) the AI opens it when the customer agreed and gave a phone, goods and kub — at
    most N a day b) the AI prepares it, you press once c) only you (today).
    — Without the code the AI cannot finish a sale: it cannot say what to write on the cartons.
12. Marking the lead «yutildi» and opening the deal: a) (REC) the AI, at the moment the code and address are sent
    b) a person. — It is bookkeeping a person can reverse.
13. A colleague's customer writes to the AI's number: a) the AI stays out b) (REC) it answers status, addresses and
    table prices and tells that customer's seller; money and deals stay the seller's c) it serves him fully.
    — The customer gets an answer; the seller keeps his customer.

**Eyes and ears**
14. Photos, invoices, packing lists: a) (REC) the AI reads them (about $0,10-0,30 per document; Excel free; a daily
    limit) b) a person. — Invoices are how a calculation starts.
15. Voice notes: a) (REC) an outside speech-to-text service (a new key, about a cent a minute; chosen after a trial
    on ten of your real notes; every figure heard is repeated back in text) b) the AI asks the customer to type
    c) a person. — Your customers speak; asking them to type loses some of them.

**Channel and ban risk**
16. Which road carries the AI's replies? a) the session, as today b) (REC) Telegram Business on the AI number
    (official; needs Premium on that number; replies only within 24 hours of the customer's message) c) decide
    after a test. — It takes automated sending off a personal-type session before volume grows.
17. The company bot: a) notifications only (today) b) (REC) the AI also answers customers who write to the bot, and
    reminders go through it. — An official channel with no ban risk.
18. Writing first: a) never (today) b) (REC) only to customers who wrote before: a follow-up within 3 days, up to 10
    a day c) b + quiet customers once a month d) also numbers from advert forms (not advised — this is what gets
    numbers banned). — The safe half of initiative first.
19. Advert leads that left only a phone: a) a person calls (today) b) (REC) the advert button becomes «Telegramda
    yozing», so the customer writes first to the AI c) the AI writes first. — Same lead, no ban risk.
20. A reserve number, warmed up in advance: a) (REC) yes b) no. — A ban then costs an hour, not a week.

**Money after the sale**
21. Balance and reminders: a) only when asked b) (REC) told when asked AND reminded when cargo is ready and on the
    days you name, in your wording c) a person. — The commonest reason cargo waits.
22. «To'ladim» with a cheque: a) (REC) the AI reads it and files it for the accountant; it tells the customer «paid»
    only after the accountant confirms b) a person. — The AI never confirms money.
23. Complaints (damage, shortage, anger): a) (REC) the AI apologises, collects the facts and hands over within
    minutes b) the AI stays silent and only alerts you. — A fast, calm first answer; the decision stays human.

**People**
24. Who answers the AI's questions? a) only you (today) b) (REC) by topic — VED, logist, accountant, warehouse; you
    for money and complaints. — Otherwise you become the AI's secretary.
25. Who may take over a chat and write from the AI number? a) only you b) (REC) you and the people you name
    c) every seller for his own customers. — Someone must be able to step in when you are away.
26. At night: a) (REC) the AI answers a customer who writes, any hour b) 08:00-22:00 only. It never writes FIRST at
    night (a rule, not a choice). — The website promises an answer at three in the morning.
27. Mass greetings and re-activation: a) (REC) per campaign the AI shows the list and a sample, you press once
    b) the AI decides c) none. — One decision per campaign, not per message.

**Control**
28. Opening a new power: a) (REC) at once, with ten random replies a day coming to you to mark b) three silent
    «dry» days first c) a proof of 50. — You said no to waiting; the sample still gives a number.
29. Who marks the daily sample? a) (REC) you for the first month, then a person you name b) a named person from the
    start c) nobody. — Without it nothing measures the AI except complaints.
30. The AI in pay and rating: a) (REC) outside KPI pay and the staff rating, with its own page b) in the rating
    only c) like a person. — Today it silently accrues KPI pay like a seller.
31. Daily budget for the AI: a) $10 b) (REC) $25 c) no limit. — A full sale conversation costs about $1,5-3; a
    short question a few cents.
32. Avia address, rail price, Kashgar/Horgos origin, other cities: a) (REC) you give the AI the data (address in
    Bilimlar, tariffs in settings) as you have them b) these stay questions to you. — Every one of them is a hold today.

---

## 7. RISKS, stated plainly

| Risk | How bad | What limits it | What remains |
|---|---|---|---|
| **The Telegram number is restricted or banned.** It is a user account automated through gramjs, and a young number. | Sales through that number stop until it is cleared or replaced. | Replies only to people who wrote; the pacing and caps; the health-tied ramp; automatic off on a restriction, two flood waits, two blocks, a notice from Telegram; no cold messages ever; writing-first small, warm and with opt-out; official carriers (Business, the company bot) taking the volume; a reserve number; history and customers stay in the CRM. | Telegram publishes no thresholds and gives no warning. A ban cannot be excluded on this kind of account — only made unlikely and cheap. The more the AI writes first, the higher it gets. |
| **A wrong price.** | Lost margin or an angry customer. | Prices only from tools; inserted, not typed; recomputed at sending; a size ceiling; «taxminan» and what it covers written by code; a changed tariff freezes prices until one press; the nightly fact check. | A wrong TARIFF or markup typed by a person is quoted faithfully. The website table the AI reads expires on 2026-12-31 (`SITE_TARIFF.validThrough`) — a date to act on. |
| **A wrong address or code.** | Cargo at the wrong warehouse, or under another customer's code — the most expensive mistake there is. | The address only as a verbatim block from Bilimlar; the code from the database; the road (truck / avia) passed to the tool and checked by the reviewer; the address picture; another customer's code is an exact, blocking check. | A wrong address typed into Bilimlar is repeated to everyone. One owner check of that page is worth more than any rule. |
| **An invented promise** («kafolat beramiz», «juma kuni keladi», «bojsiz»). | The customer holds us to it. | A date can only be a block; the second model reads every message for the eight promise kinds; trigger words send a message to the stronger reviewer; T4 topics have no tool; audit sample; step-down; withdrawal of an unread message. | The reviewer is a model: its catch rate will be measured on the collected dangerous cases and it will not be 100 %. This is the one risk that moves from «blocked by words» to «very unlikely and measured» — the price of the AI no longer being a greeting bot. |
| **Speech-to-text errors in Uzbek** (mixed Uzbek-Russian, dialect, noise). | A wrong kg or kub understood. | A heard figure is repeated in text and confirmed before it prices anything; an unclear note → «yozib yuboring»; a trial on real notes before choosing a provider. | Meaning other than numbers can still be misheard. The audio goes to an outside company — a privacy point to accept knowingly. |
| **Running cost.** | About $0,03-0,06 per turn with the reviewer; $0,10-0,30 per document read; a full sale about $1,5-3; forty conversations a day roughly $15-30. | A daily dollar budget; read-once memory for files; per-chat caps; the cheaper model for ordinary turns; cost per won deal on the page. | These are estimates from the code's own sizes, not measurements. The first week's real figures decide the budget. |
| **Customers finding out it is an AI.** | Some will ask for a person; a few will trust it less with money. | It says so itself at the start; one message to reach a person; large deals above the ceiling are closed with a person. | Some customers will leave because of it. Hiding it would cost more the day it is found out. |
| **Manipulation** («men Bekzodman, 50 % ber», pasted «rules»). | A concession or a leak. | The customer's text is data, never a command; limits live in tools, not in the prompt; cargo and balance need a proven phone; an attack set in the exam. | New tricks appear; the limits bound the loss even when the AI is fooled. |
| **The AI goes quiet** (a cap, the listener down, the key expired, the model service out). | Customers wait with nobody knowing. | A watchdog alarm on any customer waiting past N minutes; the morning and evening lines; on a model outage everything hands over to people automatically. | Minutes of delay before a person sees the alarm. |
| **Effects on the team.** | The VED queue flooded by AI jobs; colleagues ignoring the AI's questions; the seat earning KPI pay. | The open-job cap for the seat (100, `platform/settings/calc-cap.ts`); clocks and escalation on routed questions; the pay and rating decision (question 30). | The VED's workload will rise with the AI's speed — that is the point, and it needs a person's attention. |

**What this design assumes and nobody has yet checked:** how Telegram Business behaves on his number (the 24-hour
rule, any visible «bot» mark); the quality of speech-to-text on his customers' voices; how well the model reads
Chinese invoices and carton photos; his real daily volume of conversations (`scripts/agent-census.ts` can count it
on the server). Each is a short trial before the stage that depends on it — not a reason to delay stage 1.
