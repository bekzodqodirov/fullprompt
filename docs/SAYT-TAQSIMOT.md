# Saytdan so'rov → eng bo'sh menejer (round 113)

The owner's ask: «saytdan kelgan zaproslar hodimlar sotuv managerlari orasida
taqsimlansin va hodimlarda belgilaylik qanday zaprosga kim javob beradi», plus
«telegrami ulangan bolmasa ham ularni usernamini kirgazadgan joy bolsin».
Decisions #1045-#1052. Migration 0107 (`lead_assign`, ledger 108).

## The contract with the website (give this to the site's session verbatim)

```
GET https://gsrwms.uz/api/lead/assign?team=cargo&tag=yuk&page=/narxlar/&lang=uz&lead=GSR-7F3K2A9Q
```

- Call it from the visitor's BROWSER (a normal `fetch`, no custom headers, no
  credentials) at the moment of the LAST button — not when the questionnaire
  opens. Every answered question counts as a visitor handed to a manager.
- `team`: `cargo` (yig'ma yuk) · `buying` (sotib olib berish) · `general`.
  Anything else is treated as `general`.
- `lead`: the tag, `^GSR-[A-Z0-9]{5,16}$`. Mint it with
  `crypto.getRandomValues`, **8 or more random characters** after `GSR-`
  (5 is the database's minimum, not a recommendation). One tag per visitor;
  the same tag asked twice gets the same answer.
- `tag` (topic): a lowercase slug, `^[a-z0-9][a-z0-9_-]{0,39}$`.
  `page`: a site path starting with `/`. `lang`: `uz` `ru` `en` `zh` `zh-CN`.
  Anything outside these shapes is dropped silently (the visitor still gets
  a manager; the lead card just says less).
- **The answer is always `200 {"username": "…"}` or `200 {"username": null}`.**
  One rule on the site: a non-empty `username` → open
  `https://t.me/<username>?text=<message containing the tag>`; ANYTHING else —
  `null`, a network error, a CORS error, no answer within 1.5 s — use the
  site's own list. There is no 204, 400, 429 or 500 to handle.
- The site's own list should hold the SAME people the system would choose,
  and more than one of them: the panel on /admin/taqsimot prints the current
  list under «Sayt uchun → Zaxira ro'yxat». A list of one sends every slow
  minute's visitors to one person.
- The page must be one of the allowed origins (setting `lead_assign_origins`,
  default `https://gsrlogistics.uz https://www.gsrlogistics.uz`). A test page
  on another address gets `null` until it is added there.

## How the system chooses

- **Who is a candidate:** an active user ticked for the team on
  /admin/taqsimot («Saytdan so'rovlar») who has a Telegram handle — the one
  the listener READ from their connected account (trusted for one hour after
  it was last read), or else the one typed on the panel.
- **Least busy:** the fewest visitors handed to them TODAY (Tashkent's day):
  offers the visitor actually wrote on, offers nobody could see (typed handle
  or the listener down — counted all day), offers that could have been seen
  and were not (counted for 15 minutes only), plus advert leads the taqsimot
  routed to them today. Ties go to whoever was handed one longest ago; nobody
  yet today goes first.
- **Nobody in the team:** `general`, then anybody ticked for the website at
  all, then `null`. Never somebody unticked.

## What happens when the visitor writes

Only for a CONNECTED Telegram (a typed handle is reachable, never captured).
The listener lands the visitor as a lead — owned by whoever received the
message — when the message is incoming, not forwarded, carries a tag we
issued in the last 24 hours that no other person has used, the chat has no
decision on it (an `exclude` always wins), and the chat has NO earlier message
(somebody the manager already talks to is not a website arrival). It goes
through `landInboundLead`, so a known client's question lands on their card
and the same Telegram person already on an open lead is joined. The rest of
the conversation follows through an include rule. A tag seen while the
listener was down is found by the start-up sweep.

## Deploy

`docker compose --profile telegram up -d --build tg-listen` is MANDATORY for
this round. Without it the old listener never reads anybody's handle, and the
panel says «Telegram tinglovchisi yangilanmagan» on every connected person.
