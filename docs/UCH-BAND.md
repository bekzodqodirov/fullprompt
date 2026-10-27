# Uch band — his three items of 2026-10-27

Status: **BUILT (§8).** Scouted (5 readers + 5 refuters, workflow `wf_b69e331d-290`), questions
sent the same day (Q1-Q7 below, answered «3b / 4 a / 5 a / 6 a / 7 b»), design judged before code
(§6), absorbed (§7). His message, verbatim:

> 1 kartada narx aytilgan bolsa usha narx qanday xisoblanganini korish uchun link
> qoldirish kerak yani ved narx berdi shu narxni hisoblaydigan oynasiga link bolsin
> chunki qayta hisoblash kerak bolganda qidirib qolinyabti
> 2 Har so'rovga yangi bitim. Boshqa sotuvchining mijozi bo'lsa, jo'natganning CRM'ida
> yangi lid ochiladi hozir CRMdan bitimga yutildi deb otkazganda bitim bor deb
> qaytaryabti agar klient code boyicha clientga biriktirmohchi bolsa va telegramdan
> hsoblaganda ham clinetga deb hisoblatmohchi bolsa 2 3 hisoblatishga reques 1 bitim
> ichiga tushib qolyabti. shuni client code boycha hsoblatishga berilganda telegramdan
> shu hisob yangi bitim bolib ochilsin va crmdan bitimga yutildi deb otkizadgan bolsak
> ham yangi bitim ochilishi kerak
> 3 Bitta qatorli tarkib va packing list'dagi «шт» ustuni tarkib 1 qatorlik bolsa ham
> ruxsat berish hozir kamida 2 ta majburiy bolib qolgan. 2va packing listda dona
> ustuni kerak

Items 2 and 3 are the OTHER session's planned rounds R4 and R8 (`docs/SAKKIZ-BAND.md`
§7, §9, §10 on PR #127's branch), with his 2026-10-21 answers recorded there: **6.8 b**
(a request a seller sends for ANOTHER seller's client opens a new LEAD in the SENDER's
funnel) and **8.5** (a «шт» column BEFORE the carton count, blank when unknown); every
other 6.x / 8.x letter was the ⭐. He gave them to this session on 2026-10-27; the
owner was told to tell the other session (one sentence in the reply), because the two
sessions cannot message each other. Item 1 appears in neither of its docs.

Numbering: main ends at DECISIONS #1454; PR #127 holds #1455-#1468 (and reserves
#R2-N placeholders), so this round starts at **#1469** and renumbers at the merge if
that PR lands first. Migration: one, **0136** (`when` …115) — PR #127 adds none.
Ledger after deploy: **137**.

## 1. Item 1 — the link from a price to its calculation

**Today** (main 7bea305): the 🧮 panel (`components/calc-panel.tsx`, on the deal card,
the lead card and the VED's karta) prints every standing seal and the standing «Готово»
answer, but the STANDING SEAL block has no link to its own calculation for any reader.
The only «#» links are on the previous chain version (`calc-seal-prev`), an OPEN request
(`calc-open-link`) and the newest answer line (`calc-last-answer-link`), all for
`ved.docs` only. The deal card's «Narx» row (`bitimlar/[id]/page.tsx` deal-compare) and
the lead card's «Narx» fact print the number with no link. The truck card's «Narx» tab
draws a «🧮 Bitim hisobi» CalcSheet with no link. «Qayta hisoblash» exists only on
`/hisoblash/[id]` (a `ved.docs` page) and only for `admin.settings.manage`.

**Who reads the link.** `/hisoblash/[id]` IS the cost breakdown (customs/freight/
extras, bazas, the sheet): law 10 and his 2A (2026-09-04) — a seller never sees it, and
the page redirects anyone without `ved.docs`. So the link is drawn **only for `ved.docs`
holders** (VED, admin, super_admin); a seller keeps the price and gets no link. The
accountant (`finance.reports` without `ved.docs`) is not in the audience either: the
prixod card's existing «Karta» link (`receipts/[id]/calc-link.tsx`) is drawn under
`calcControlScopeFor ≠ none`, which admits him, and bounces him home — fixed here to the
same `ved.docs` rule.

**The rule, ONE home.** `calcWorkspaceHref(actor, requestId)` in `calc/card-door.ts`:
`ved.docs` → `/hisoblash/<id>`, else `null`. `threadHrefsFor`'s calc arm
(`crm/thread.ts`) calls it for its `ved.docs` branch, so the two card→calc rules cannot
drift (#513). Every new link goes through it.

**Where it is drawn** (label «🧮 Hisob-kitob», `calc.openCalc` ×4, with the chain's V-no):
1. Every seal block in the panel — standing (`calc-seal-link`) and dead/expired
   (`calc-seal-dead-link`); the open-request row and the answer line keep their testids
   (a dozen e2e specs read `calc-open-link`) and only change their text from «#» to the
   label. Testids avoid the `calc-open-` and `calc-job-` prefixes (#1270).
2. The deal card's «Narx» row and the lead card's «Narx» fact — pointing at the job that
   WROTE that number. `quoteLockedFor` (crm/service.ts) already decides the writer (the
   newest standing seal of any job vs the newest released offer, by clock) but returns a
   bare number pinned by ~10 tests and two refusals; its body is extracted into
   `quoteWriterFor(entity) → { requestId, kind: 'seal' | 'offer', amount } | null`,
   which `quoteLockedFor` calls and maps (return type unchanged). An offer's request is
   resolved through its anchor (`version_id → calc_versions.request_id`, or `request_id`
   for an answer offer). A hand-typed number (writer null) gets no link.
3. A WON lead: its requests moved to the deal (`rekeyLeadCalcRequests`), so the lead card
   prints «Hisob bitimga o'tdi: B-… →» (`calc.kartaWonDeal` reused, testid
   `lead-calc-won-deal`) — the karta's own derivation (`kartaCardFor.wonDealId`, through
   the request's materials note) generalised into a helper both read. Drawn for whoever
   may open that deal (`canWriteDeal` or the VED's `mayOpenCalcCard`), not only ved.docs:
   it is a card link, not the breakdown.
4. The truck «Narx» tab's per-deal CalcSheet and CalcAnswers — ved.docs only (that tab's
   audience includes the accountant).
5. The two ✏️ forms' 🔒 locked-quote rows (`deal-quote-locked`, `lead-quote-locked`) —
   the page passes the href in (both forms are client components).

**Not changed (Q1 ⭐ a):** «Qayta hisoblash» stays `admin.settings.manage`. Recorded
reason, from the scout: a correction supersedes its parent, and `payableOffersSql` stops
paying an offer on a superseded request — a VED pressing it would end a seller's upsale
(law 4: the VED does not control the seller's commission). Q1 b would widen it.

## 2. Item 2A — every coded request from Telegram is a new deal

**Today.** Two bot doors («🧮 Hisoblatish», «🤖 AI rastamojka/podklyuch»: one collector,
`landCollectedIntake` → `landIntake`) and the chat door's CLIENT entity
(`threadCalcSend`, mounted on /suhbatlar/<client>, the client card's chat, and the lead
card's chat when that lead's phone resolves to one client) call `dealFor`
(`calc/intake-land.ts`): the client's newest OPEN deal of any owner, else a new
«Hisoblatish — <section>» deal. Seeded Skladda/Yo'lda/Yetkazildi are kind `open`, nothing
closes a deal by itself, so a client's requests pile into one long-lived deal. Verified
money consequences of mixing: a second seal overwrites the deal's quote
(`workspace.ts` seal → card write), DealDeviation compares the whole deal's cargo with one
job's quote, the upsale cargo factor counts every prixod of the deal against one job's
m³ (overpay) and a paid «Готово» reduces a later job (underpay), `answerFloorStandsSql`
drops an answer once anything later stands, `stampCalcLink` suggests nothing once two
seals stand.

**The rule** — `calcCardFor({ client, section, goods, senderId })` replaces `dealFor`
(same file; both doors call it; corrections, the card form and the deal-card/lead-card
own-entity chat are NOT routed through it — a correction is the same sale on the same
card):

| sender | client's seller (logs in) | lands on |
|---|---|---|
| a SELLER (Q3 ⭐: holds deal terms and no office role — `admin`, `super_admin`, `logist`) | the sender, or none | a NEW deal, owner = sender |
| a seller | another person | a LEAD in the sender's funnel (6.8 b), §2.1 |
| office (admin/super_admin/logist) | someone | a NEW deal, owner = the client's seller |
| office | none | a NEW deal, owner = sender |
| no deal terms (VED, warehouse) | someone / none | a NEW deal, owner = the client's seller / nobody (G2 a, unchanged) |

- **The new-client shell** (round 111, `openDealForNewClient`: title = client name,
  bottom of column) is ADOPTED by the first request when it is untouched — no calc
  request, no quote, no deal line, no linked prixod, no money row, no offer — and its
  owner equals the computed owner; adopting renames it.
- **The title** reads apart: `«Rastamojka — <first goods name> +N»` (section word from
  one map, goods from the request's lines, capped), never «Hisoblatish — rastamojka».
- **Refusals before minting.** The sender's open-request cap (`too_many_open`, per
  REQUESTER) and `too_many_items` are checked by one exported pre-check BEFORE any card
  is minted; on main a refusal after the mint leaves an empty deal (chat door) or a
  deal holding only the note (bot). The chat door's `note_taken` likewise moves ahead of
  the mint.
- **Idempotent on the note.** The bot's note id is minted by the caller and reused on a
  retried «Saqlash» (a failed landing keeps the collection). `landIntake` first looks
  the note up: if it exists, the earlier attempt's card is the target (and an existing
  request on that note is returned as already queued) — a retry never mints a second
  deal.
- **Stage.** A minted deal starts on the funnel's first open stage; the bot's existing
  forward-only move to `deal_calc_stage` applies to it as before (one DealStageChanged
  per request — automation rules on that stage fire per request, stated).
- **The ✅ reply** names what happened: «yangi bitim B-…» / «yangi lid (GS777 — Murodning
  mijozi)». The review message before saving is unchanged (PR #127 rewrites it).
- **Strangers (no code).** `openLeadForPhone` joins only an OPEN-stage, unbound lead of the
  same last-nine digits (never a lost one — a returning lost prospect is a new enquiry,
  `inbound.ts`'s rule). Several requests on one lead become several deals at the win
  (Q5 ⭐ a, §3).
- **Top-ups (Q4 ⭐ a).** There is no «add to this request» door on main or PR #127 (its
  R3). Until it exists a re-sent top-up is a new request on a new deal — stated to him,
  shipped anyway at his ⭐.

### 2.1 The lead for a colleague's client (6.8 b)

A lead in the SENDER's funnel: name = the client's name, phone = the client's first
phone, note «GS777 — Murodning mijozi · Telegram bot: hisoblatish (rastamojka)», owner
= sender. **Unbound** (`client_id` NULL): binding it would drop it off the sender's call
list and open-lead count (`followUps`/`openLeadCount` read `isNull(leads.clientId)` as
«not yet converted»), make the dialog confirm-only, and give its owner involvement in
the colleague's client threads. Which client it is about is kept in a SIDE table
`lead_about_client (lead_id PK → leads ON DELETE CASCADE, client_id → clients,
created_at)` — never a column on `leads` (one of the three hottest tables, #1381). It is
read by: the bot (a second request for the same client joins the sender's OPEN lead
about it), the won dialog (prefills the attach code, the echo names the client's
seller), and the lead card (a chip «GS777 — Murodning mijozi»). A deploy one migration
behind (42P01) degrades to «no side row» silently in readers and skips the insert with a
log line in the writer.

When it is won (Q2 ⭐ a, today's rule): the deal belongs to the lead's owner (the
sender — the upsale and the group celebration follow the deal), the client's seller is
unchanged, and the cargo's KPI stamp stays with the client's seller (`staff/stamp.ts`,
his 2a «stamp never moves»).

## 3. Item 2B — «Yutildi» into an existing code always opens a new deal

**Today.** `winLead` ALWAYS creates a deal — but before that the attach-by-code branch
refuses `client_has_lead` («Bu kodda lid allaqachon bor — mijoz uchun yangi kod oching
yoki o'sha lidni oching»), at the echo (`resolveClientCodeAction`) and in `winLead`
(pre-check + 23505 from 0021's partial unique index `leads_client_unique`). His
«bitim bor» is that sentence (no bundle string mentions a deal). `winLead` is the only
writer of `leads.client_id`, so every client that ever came through the funnel holds
one lead for good and can never be attached again.

**The change.** Migration **0136 `lead_client_many`**: `DROP INDEX leads_client_unique`,
`CREATE INDEX leads_client_idx ON leads (client_id) WHERE client_id IS NOT NULL`, and the
§2.1 side table. Schema.ts follows in the same commit. `winLead` loses the pre-check;
the echo loses the lead refusal and gains the client's seller name for a TYPED code
(the hit list already shows it) — the last brake on a mistyped existing code is the
echo, so it must name whose client it is. The 23505 mapping stays only for the
one-migration-behind morning. Old leads: nothing to migrate.

**Several jobs on one lead (Q5 ⭐ a).** `rekeyLeadCalcRequests` moves EVERY request and
offer of the lead onto the ONE deal `winLead` opens — the CRM-side source of «2-3
requests in one deal». At the win the lead's jobs are grouped by correction CHAIN
(`supersedes_request_id`, a chain is one sale and never splits); the chain that wrote
the lead's quote (`quoteWriterFor('lead', …)`, read BEFORE the re-key) — else the
newest — goes to the main deal (which carries the lead's quote and FTL as today); every
other chain gets its own deal on the same client and owner, titled like §2, quoted with
that chain's own standing figure (newest seal total, or the released offer price —
what the seal would have written on the card), its requests AND their offers moved
together. A lead with one job is exactly today.

## 4. Item 3 — one-line tarkib and the «шт» column

**Today.** `MIN_LINES = 2` (`receipts/composition-math.ts`) refuses one line
(`lines_count`, «Kamida 2 ta … Bitta tovar bo'lsa — lot nomini logist o'zgartiradi» —
his 1a of 2026-10-01, #1263, fenced in `lot-composition-fence.test.ts`). 0122 has no
count CHECK, so no migration. The same constant is also every READER's torn-header guard
(`compositionsFor`, `paperCompositionsFor`, `paperStampFor`, the freeze copy, and
`saveComposition`'s own before/after audit).

**The change** (his 8.x ⭐ = the «A+» recommendation of SAKKIZ §9, plus 8.5):
- **Writer**: 1-20 lines. **Readers**: the torn-header guard becomes its own explicit
  rule (`lines.length > 0`), independent of the writer's minimum, in all five places,
  with a red-proven test (no test pins it today).
- **Editor**: opens with ONE row, ✕ hidden while one row is left, the alohida/aralash
  toggle hidden for one line (both print the same numbers). A «Bitta tovar» button fills
  the row from the lot: name (Russian, else Chinese), kg, m³, cartons, the TNVED code
  from the memory (so the invoice — which prints only a line's own code, fence 4 — keeps
  it), and pieces from the prixod's linked job when the link is CONFIRMED and the job
  has exactly one item counted in dona (8.8). The extra reads are passed only when
  `mayWriteComposition` holds (the receipt card is opened by warehouse staff too), and
  never surface the job's money.
- **Derived ✅** «hujjat bo'yicha» (YUK-TEKSHIRUV 3a): a one-line tarkib earns it only
  when its line name equals the lot's own name (ru or zh, trimmed, case-folded) — 8.6;
  two or more lines as today. SQL `tarkibStandsSql` and the plan editor's pure twin
  move together (pinned against each other, #1267).
- **Yellow «taxminiy»** on a truck carrying part of the lot: a one-line tarkib's kg/m³/
  cartons ARE the truck's own figures, so it is yellow only when pieces are written
  (the only proportional figure) — 8.7.
- **Packing lists** (Q7 ⭐ a: «Packing (rasmlar)» and the draft packing list; the
  invoice already prints шт in «Ед.изм / Количество», the agent file unchanged): a
  «Кол-во, шт / Pieces» column BEFORE «Коробок», blank when unknown (null or a share
  that rounds to 0 — never «0»), never totalled (different goods do not add). Pieces
  leave the product cell (no «— 1000 шт» twice). Q6 ⭐ a: a composed lot's product cell
  is the line name plus the lot's Chinese name. «Packing (rasmlar)»'s `PHOTO_START_COL`
  7 → 8 with a NEW test reading the image anchors (nothing pins them today). PR #127's
  hunks in that file are the photo pipeline only; untouched.
- **Words**: `tarkib.errors.lines_count` («Ko'pi bilan 20 ta tovar»), the lot-check
  sentence that sent the VED to the logist (now: write a one-line 🧩; ask the logist to
  rename only for the warehouse screens — labels/stock/plans keep the lot's own name, the
  fence's DENY list), `tarkib.clearConfirm`.
- **The fence** is rewritten as the recorded reversal of 1a (new DECISIONS entry), not
  loosened.

## 5. Questions sent (2026-10-27) — ⭐ = built if unanswered

1. Who presses «Qayta hisoblash»? ⭐ a admin (today) · b the VED too.
2. A colleague's-client lead won: ⭐ a deal = sender, KPI stays with the client's seller
   · b deal → client's seller · c the cargo stamped to the sender (own design).
3. Who is «another seller»? ⭐ a a SELLER (office → deal to the client's seller) ·
   b admins/logists too.
4. Top-ups before the add door: ⭐ a ship now (a re-send = a new deal) · b wait.
5. A lead with several jobs, won: ⭐ a one deal per job · b one deal (today).
6. Composed lot on packing lists keeps the Chinese name: ⭐ a yes · b line name only.
7. «шт» column files: ⭐ a Packing (rasmlar) + draft packing list · b the agent file too.

**His answers (2026-10-27, verbatim):** «3b / 4 a / 5 a / 6 a / 7 b». Q1 and Q2 unnamed =
the ⭐. So: **Q1 a** recalc stays admin; **Q2 a** a colleague's-client deal is the
sender's, the KPI stamp stays with the client's seller; **Q3 b** admins and logists are
«sellers» too — whoever has a funnel (`crm.leads`) gets the LEAD for a colleague's client,
whatever his role; **Q4 a** ship without the add door; **Q5 a** one deal per job at the
win; **Q6 a** the Chinese name stays; **Q7 b** the agent file gets the «шт» column too.

## 6. Judge

Five lenses before code (money/law 4, regression/tests/fences, concurrency/idempotency,
deploy/migration/one-behind, product-fit/words), each objection given to a skeptic told to
refute it (workflow `wf_f3b609e6-d8f`, 10 agents). **83 objections, 0 refuted** (52
confirmed, 31 partial). Every one is absorbed in §7 by its id or stated there as not
built, with the reason. The ones that moved the design:

- **money-1 (blocker)** — a won lead's jobs split by correction CHAIN resurrected a Готово
  answer the money rules had already retired: `answerFloorStandsSql` is CARD-keyed (a
  newer answer or a later seal on the same card outranks it), so moved alone onto its
  own deal it stood again, its offer stood, locked the deal and became payable.
- **money-2 (blocker)** — a re-send (Q4 a) on a new deal escapes the A18 «one sale»
  fence: paid on deal 1's answer, the prixod re-filed to deal 2, paid again.
- **conc-1/2/3 (blockers)** — the card and its note committed separately (a retried
  save minted twice); the chat door's `note_taken` became permanent after a post-note
  failure; the split named no transaction.
- **regression-1 (blocker)** — a one-line tarkib naming another good read «stale»
  everywhere instead of ❓.
- **product-1 (blocker)** — «Bitta tovar» put a job's WHOLE piece count into one lot when
  the job arrived in several prixods.

## 7. After the judge — what is built

**Item 3 (one-line tarkib, «шт»)** — regression-1: the vouch is a THIRD term
(`tarkibVouchesSql`, `productKeySql` — the TNVED memory's key, one rule for «the same
name»): a one-line tarkib that does not vouch falls through to the person's check and
then to ❓, never to «stale»; `documentStale` needs a tarkib that would vouch; the card
says «🧩 Tarkibda lotdan boshqa nom yozilgan — logist lot nomini to'g'rilasa ✅»
(`documentOtherName`). regression-2/3/4: every positional reader of the packing files is
re-anchored on its HEADER; the one-line refusal fixture became a zero-line one; m9zzx adds
the second row before filling it. regression-5: a one-line tarkib of the lot's OWN good
with no code, while the memory holds one, is refused `tnved_would_vanish` naming the code
(the invoice prints a line's own code, fence 4 kept). product-1: «Bitta tovar» prefills
pieces only when the link is a person's, the job counts ONE dona good, the prixod has ONE
lot and NO other live prixod is linked to that job. product-8: a line prints the lot's
Chinese name only when the line IS the lot's good (the vouch's own key) — «Мышь (键盘)»
named the wrong good. product-17: «1 tadan 20 tagacha tovar». product-20: the editor says
when a one-line name will not vouch. Q7 b: the agent file's «шт» = a ONE-good lot's pieces,
blank for several (each good's pieces are in the contents text). deploy-2: UPDATE.md's
«going below» block. MIN_STORED_LINES is the readers' own guard, red-proven.

**Item 1 (links)** — money-3/regression-10: `quoteWriterFor → {kind, requestId, amount,
stands}`, `quoteLockedFor` = its amount while it stands; the «Narx» row links the writer's
job only when the card's number IS the writer's (`writerWroteCard`) — a hand-typed figure
links nothing. regression-9/11/12/13, money-11, product-15/19: the fences re-anchored, the
truck sheet takes `calcHref` before `sight`, every card→calc link asks `calcWorkspaceHref`
(fenced: no `/hisoblash/${…}` literal outside its home, the workspace tree and three named
platform copies), the prixod's PICKER stays the accountant's and only its anchor is the
VED's, labelled «🧮 Hisob-kitob». money-12/product-14: a won lead lists EVERY deal its jobs
moved to.

**Item 2A (a new card per coded request)**:
- Q3 b + money-14 + product-3: `calcCardFor` asks permission codes — a sender with a
  funnel (`crm.leads`) and a client whose seller is somebody else → a LEAD in the
  sender's funnel; otherwise a NEW deal owned by `calcDealOwnerFor` (G2 a).
- conc-1/conc-7: the card AND its note are ONE commit (`createDealInTx`, `insertLeadTx`,
  `insertActivityTx`; every pooled read first, #714); a retry finds the card through the
  note (`cardOfNote`, the sender's own note on THIS client's card only — anything else is
  `note_taken`, conc-2) and an already-queued ROOT request on that note is returned, not
  opened again or re-sent to the AI (conc-10/13).
- conc-5/deploy-5/money-13: the round-111 shell is recognised POSITIVELY (title = the
  client's name, the client's first deal, within five minutes of the code, the same
  owner) and claimed by the title change inside the card transaction, re-checking that
  nothing — request, offer, line, prixod, money, note, task, FTL, discount, deferral — has
  touched it; a second adopter finds the title moved and mints.
- conc-9/product-7: the open-request cap is checked BEFORE a coded card is minted
  (`calcOpenRefusal`, one home with `openCalcRequest`); the bot answers the refusal in its
  own words and keeps the collection; the stranger path keeps main's order (its lead is
  needed anyway, so the material is never lost).
- conc-8: `openCalcRequest` takes the lead FOR SHARE and refuses `lead_closed` on a won
  lead; the split takes it FOR UPDATE, so a request can no longer land on a lead between
  the split and the won move.
- product-11/deploy-4: a stranger joins an OPEN, unbound lead by phone and never a lead
  ABOUT a client (both phone joiners).
- product-16/18: the ✅ says what happened (new / taken over / joined / the earlier
  attempt's card); the title falls back to «Rastamojka — <code> · dd.mm» with no goods.
- money-2: a prixod whose deal has PAID a seller's upsale cannot be re-filed or detached
  (`upsale_paid`) — the cross-deal double pay needs exactly that move.

**Item 2.1 (lead about a colleague's client)** — deploy-3: both FKs CASCADE, an index on
`client_id`, `leadAboutReady()` asked first, never joined into a list's own query.
money-8: `winLead` on such a lead refuses a mint and any other code (`lead_about_client`);
the dialog prefills the code and names whose client it is.

**Item 2B (Yutildi)** — deploy-1: after 0136 a 23505 from the attach is the one-behind
morning → `server_behind`. conc-6: the dialog posts a win token; the deals' ids derive from
it (uuidv5), so a double press or a retry converges on the same deals. money-1/money-4/
conc-3/conc-4/conc-12/deploy-8/product-4: the split groups the lead's jobs by SALE —
chain edges plus «outranked» edges (an answer that does not stand on the lead joins every
request that answered or sealed after it) — the writer's component is the main deal, every
other component with something standing or still open gets its own deal, dead history
stays with the main deal; each deal is quoted by its component's own writer (seal: amount,
volume, weight, sealed_at/sealed_by; a later standing offer: its amount), carries the
lead's FTL, and its requests and offers move BY ANCHOR, all in ONE transaction (requests
FOR UPDATE → lead FOR UPDATE → re-read, the won stage written inside, announced after).

**Stated, not built** (told to him in the reply): money-5 (a truck price for a client with
two deals aboard names no deal — deferral and deal profit then see none; asked as Q8);
money-6 (on a colleague's-client deal only an OFFICE FTL mark reaches the cargo); money-7
(the upsale is paid to whoever makes the newest offer on the job — Q2's sentence corrected);
money-9 (unaccepted quotes stay in the open-deals sum until somebody closes them);
money-10/product-12 (the deal card's own 🧮 form still puts a second job on the same deal);
product-6 (a VED's send in the client's seller's name tells that seller nothing — owed);
product-9 (a one-line tarkib still needs the client's paper on the prixod); product-13 (a
bot re-send is a new job, not a recalc); product-21 (each attach-win celebrates); product-22
(the photo quality half of 8.5 ships with PR #127); deploy-10 (merge surface with PR #127,
§8).

## 8. As built (2026-10-27) — where the code differs from §7, and what proves it

- **Item 2B lives in `crm/service.ts` `winLead` + `calc/win-split.ts`.** The client part keeps main's order (own
  statement, before the transaction — `createClient` opens its own); everything after it is ONE transaction:
  requests `FOR UPDATE` in id order → the lead `FOR UPDATE` → the main deal's id checked (a second press that
  waited on the lock finds the first one's deals) → the jobs re-read and compared with the pooled plan
  (`jobsDigest` + the lead's quote; a difference is `changed`) → `createDealInTx` per deal (explicit `id`) →
  `rekeyLeadCalcJobsTx` (requests by id, offers by request OR version) → `writeLeadStageTx` (moveLead's write,
  extracted; announced after the commit). `rekeyLeadCalcRequests` survives only as the tests' one-deal shorthand
  (fenced: no production caller).
- **The outranked edge asks `answerFloorStandsSql`'s own terms**, now one fragment, `outrankingAnswerSql`
  (version-set.ts), shared by the money rule and the split; a seal outranks by ANY of the request's versions.
- **The result names the other deals** (`WinLeadResult.otherDeals`), drawn under the banner as links; a retried
  press answers the main deal alone (the lead card lists every deal through `wonDealsOfLead`).
- **The dialog**: a token per OPENING (not per lead); a lead about a colleague's client opens on that client
  (`winPrefillAction`, lazy, no board query) and offers no fresh code; the echo names the client's seller
  (`resolveClientCodeAction.sellerName`); new words `serverBehind`, `leadAboutClient`, `changed`, `sellerOf`,
  `noSeller`, `aboutColleague`, `otherDeals` ×4. `client_has_lead` stays mapped for an old server's answer.
- **Titles**: `calc/deal-title.ts` (moved out of intake-land so the split names a sale's deal the bot's way).
- **Proofs**: `win-split.integration.test.ts` (money-1 on the real fragment, the seal-priced sibling, the FTL pair,
  the token, `lead_closed`, money-8) + `win-split.test.ts` (pure); `calc-intake` (a new deal per request, the
  retried note, the colleague lead, the stranger skip), `deal-ved` (v)/(vii) rewritten, (x) the shell taken over
  once and a touched shell left alone; `thread-calc` (the client door per request, the lead's client thread);
  `calc-landed-words`; fences re-anchored (won-law, ftl-wire, calc-queue, calc-rekey, deal-terms-wire,
  thread-calc-wire, calc-credit-fence). 17 red proofs for item 2 by string edit, each restored by the reverse
  edit.
- **Reviewed as built** (four lenses + refuters, 3 confirmed, DECISIONS #1478): `recalcFromSealed` reads its card
  off the locked parent and asks the lead open in the win's order; `openCalcRequest` refuses a closed lead before
  writing and writes the card's note inside its transaction; the panel takes `takesJobs`. Proven by a held-lock
  race test and a red proof in main's order.
