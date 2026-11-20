# To'liq AI sotuvchi — PART 3 spec: juma tabrigi (jim qolgan mijozga birinchi yozish) va AI alohida hodim

Builds on parts 1-2. Read `MAP.md` items 3 and 5 first.

## 0. The owner's words (binding)

- «3 jim qolgan mijozni juma kuni toshkent vaqti bilan soat 2 da tabrik yozsin odamga oxshab tabiy chiqsin tabrik»
  + «jumani sen aytgandek rendom odamga oxshab har hil vaqtlarda yozsin soat 2dan boshlab».
- ⭐ told to him for «jim qolgan»: wrote to this number in the last 90 days; nobody wrote in the chat for 7+ days;
  two Friday greetings in a row unanswered → that chat gets none for a month; Uzbek and Russian writers only
  (Persian added: his Afghan/Iranian customers keep Jumu'a too — stated; Chinese/English never).
- «5 ai sotuvchi faqat meniki boladi alohida hodimdek qaralsin va men shu akkountda qarab turaman».
- The account-protection limits stay (part 1 §5.2) — a Friday batch counts toward them.

## 1. Juma tabrigi (item 3, writing first)

1.1 **Migration**: widen `agent_runs_trigger_check` and `agent_drafts_kind_check` with `greeting` (or `followup`);
`agent_greetings` = the claim ledger (manager, peer, friday date, draft id, outcome, answered_at), UNIQUE (manager,
peer, friday) — one per chat per Friday, and the «two unanswered → a month's pause» is read off it.

1.2 **The sweep**: a pg-boss schedule on Fridays from 14:00 Tashkent (09:00 UTC). It selects the quiet chats
(1.0's rule, plus: on the «Ish raqami» account only; not muted / excluded / 🙋 / `off_until` / an agent prospect /
a stranger; an open request at the VED excludes — we owe them an answer, not a greeting; a lost lead excludes) and
SPREADS them: each chat gets a random send time from 14:00 to ⭐ 17:30, with gaps of ⭐ 2-9 minutes between any
two, ordered randomly, and the batch takes at most ⭐ half of what is left of the day's account ceiling (the other half
stays for replies).

1.3 **The text**: the model writes each greeting for that customer, in their language and script (part 1 §4), short,
warm, natural — «Juma muborak» in the customer's own words, at most one soft line («Xitoydan yuk bo'lsa, xizmatdamiz»
style), no price, no figure, no promise, no question that needs an answer. Every draft is different (G10's
same-text fuse must never fire on a Friday — the prompt gives the customer's name and the conversation's last topic
so the words are theirs).

1.4 **The send**: anchored on the newest stored line of the chat (MAP item 3: the send step's anchor checks then mean
«nobody wrote since»); its own clock (the draft lives until 19:00 that Friday); through the auto layer with its own
switch (on by default — he asked for it) so a block and «botmisiz?» step-downs count it; a reply from the customer
retires nothing — it starts an ordinary inbound run.

1.5 **Fuses**: `forceAgentOff` and every disarm stop a pending Friday batch; two blocks within 7 days of a greeting
switch greetings off (a new step-down reason, words in Uzbek); the card he sees in the bot says «🕌 Juma tabrigi» and
offers ⏸ / ❌ like any machine reply.

## 2. AI alohida hodim (item 5)

2.1 **The seat flag**: `agent_config.holder_is_seat boolean NOT NULL DEFAULT false`, set on /suhbatlar/ai by a
super_admin («Bu akkaunt — AI sotuvchi, alohida hodim»). When true, the holder user is a MACHINE seat:
- out of KPI pay and the KPI payable (ONE exclusion in `stampedCartonsSql` / the payable — never per surface),
- out of the Saturday rating and the staff-group celebrations (`heroOf`),
- out of the upsale commission payout (`payableOffersSql`) — part 2's offers,
- out of /hodimlar salary lists,
- still a seller row in /crm/tahlil (it owns its leads — that is «its own result»).
- Fences: a derived test lists every reader of the KPI/rating/payout sets and demands the seat predicate.

2.2 **«AI natijalari»** on /suhbatlar/ai: chats answered, replies sent by itself vs pressed by him, first-reply time,
estimates and calc prices given, calculations submitted, leads moved, leads won (closed_at) — from the agent's own
record (`agent_drafts.lead_id`/`client_id`, verdicts, outbox), by day/week/month, from 2026-10-29.

2.3 **A won seat-lead**: the client's manager becomes the seat (the winner) — the seat's staff bot is linked inside the
same Telegram account, so cargo pushes to «the manager» reach him there; `managersFor` shows the seat's phone (the work
number) to the customer. Verify `canLogIn` readers: if the seat has a login (it does — he connected Telegram as it), it is
an ordinary manager everywhere except 2.1's exclusions.

## 3. Gates

As parts 1-2, plus: the Friday sweep at 13:59 / 14:00 / 17:31 Tashkent (fake clock), the spread (no two sends closer
than the minimum gap), the half-ceiling, the month's pause after two unanswered, the seat exclusions each red-proven.
