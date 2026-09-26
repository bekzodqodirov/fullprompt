# Saytdan so'rov → eng bo'sh menejer (round 113)

The owner's ask: «saytdan kelgan zaproslar hodimlar sotuv managerlari orasida
taqsimlansin va hodimlarda belgilaylik qanday zaprosga kim javob beradi», plus
«telegrami ulangan bolmasa ham ularni usernamini kirgazadgan joy bolsin».
Decisions #1056-#1064. Migration 0110 (`lead_assign`, ledger 111).

Section 1 is the spec for the AI that builds the website (gsrlogistics.uz).
**Give it to that AI verbatim.** Every sentence in it was checked against the
code by four read-only verifiers and a critic (2026-09-26); the file:line
references are in the round's record, not here, because the site's AI cannot
open this repository.

---

## 1. For the website's AI — the integration spec

### What this does

At the questionnaire's FINAL button, the website asks the GSR system which
sales manager's Telegram should get this visitor (the least busy one in the
right team). It then opens a Telegram chat with that manager, with a message
already typed that carries a one-off code. When the visitor sends that
message, the GSR system opens a lead for that manager by itself. If the
system does not answer, the website uses its own list of managers. The
visitor must never see an error.

### 1. The call

- URL, exactly: `https://gsrwms.uz/api/lead/assign`
  - singular `lead`; `/api/leads/...` is a different endpoint;
  - no trailing slash;
  - https only.
- Make it ONLY from the visitor's browser, inside the click handler of the
  final button, exactly once per submission.
  - Never call it from the site's server, SSR, a server action, a proxy or a
    relay. A server has no `Origin` header, so every answer is `null`, and all
    visitors would share one rate bucket.
  - Never call it on page load, on each step or on hover. Every answered call
    counts as a visitor handed to a manager.
- Query parameters (build them with `URLSearchParams`, and add only the ones
  you have a value for; never pass `undefined`):

  | param | required | value |
  |---|---|---|
  | `lead` | **yes** | the one-off code, see §3. Missing or malformed → the answer is always `null`. |
  | `team` | yes | exactly `cargo` (yig'ma yuk / consolidated cargo), `buying` (tovar sotib olib berish / buying goods for the client) or `general`. Map the site's own categories to these three in code. Anything else is treated as `general`. |
  | `tag` | no | the TOPIC, a lowercase ASCII slug `^[a-z0-9][a-z0-9_-]{0,39}$` (e.g. `yuk`, `narx`, `xitoydan-olib-kelish`). NOTE: `tag` is the topic, NOT the code; the code goes in `lead`. |
  | `page` | no | `location.pathname` only: no query string, no `#`. |
  | `lang` | no | exactly one of `uz` `ru` `en` `zh` `zh-CN` (case-sensitive). Omit it for anything else. |

  A wrongly shaped `tag`, `page` or `lang` is silently dropped, and the visitor
  still gets a manager. Do not send the visitor's name, phone or answers in
  the URL; the server ignores them.
- The request must be a plain `fetch(url, { signal })`:
  - no `headers` object;
  - no `credentials`;
  - no `mode: 'no-cors'` (its body cannot be read);
  - no body.

  Any custom header, including tracing headers added by Sentry, Datadog or
  OpenTelemetry, or an axios interceptor, fails the CORS preflight. Exclude
  `gsrwms.uz` from every tracing library's propagation targets.
- Time limit: 1.5 s, using `AbortController` + `setTimeout`. Do not use
  `AbortSignal.timeout`, which is missing on older iOS and in-app webviews.
  Put `<link rel="preconnect" href="https://gsrwms.uz" crossorigin>` on the
  questionnaire page.
- If the site sends a Content-Security-Policy, add `https://gsrwms.uz` to
  `connect-src`.

### 2. The answer

- `200 {"username":"ali_gsr"}` means use this manager. The username has no
  `@`, and its case is kept.
- `200 {"username":null}` means use your own list.
- ONE rule covers everything. Use the username only if
  `typeof j.username === 'string' && /^[A-Za-z0-9_]+$/.test(j.username)`.
  Everything else means «use the site's own list», silently:
  - `null`;
  - any other status;
  - a CORS error or network error;
  - a timeout;
  - a body that is not JSON.

  Never show an error, never hide the Telegram button, never retry
  automatically. Wrap the fetch, `res.json()` and the property access in one
  `try/catch`.
- Do not add a minimum length or a «starts with a letter» check; some valid
  handles are short.

### 3. The code (`lead`)

- Format: `GSR-` + 10 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
  That alphabet has 32 characters: no I/O/0/1, and no modulo bias. Generate
  it with `crypto.getRandomValues`, never `Math.random` and never
  `crypto.randomUUID`, whose hyphens are not allowed.
  - The server accepts `^GSR-[A-Z0-9]{5,16}$`.
- Mint it ONCE per submission, in the click handler, before the fetch. Use
  the SAME string in `lead=` and in the Telegram message, on the success path
  AND the fallback path.
- Keep `{tag, team, at}` in `sessionStorage` (never `localStorage`). Reuse it
  only when the same visitor presses again within 60 minutes with the same
  `team`: the server answers the same person and adds no load. Otherwise mint
  a new one. A different `team` needs a new code.
- A code the server first saw more than 24 hours ago, or whose manager has
  since left, now answers `null` (use your own list). A code can open a lead
  only within 24 hours anyway.

### 4. Opening Telegram

- Message text:
  - first line `Kod: GSR-XXXXXXXXXX` (the word may be translated: `Код:`,
    `Code:`);
  - then ONE short line summarising the answers, joined with ` · `, e.g.
    `Yig'ma yuk · 12 kub · Guangzhou → Toshkent`.

  Keep it at or under ~300 characters. The manager reads this summary on the
  lead, and newlines there become spaces.
- The code must stand alone:
  - before it: start of text, a space, `:`, `#`, `(` or a newline — never a
    letter, digit or `-`;
  - after it: a space, newline, `.`, `)` or end of text — never a letter or
    digit, and never `_` followed by more letters.

  Exactly ONE code per message. Build the string in JavaScript and never pass
  it through a translation, typography or markdown layer.
- Link: `'https://t.me/' + username + '?text=' + encodeURIComponent(text)`.
  - Use `encodeURIComponent` for the text only.
  - Never put `@` in the URL.
  - No `start=`.
  - Do not use `tg://` as the main link.
- Navigate the SAME tab with `window.location.assign(tgUrl)` after the fetch
  resolves or fails. Never `window.open` after an `await`: Safari, iOS,
  Firefox and the Instagram/Facebook/TikTok in-app browsers block it.
- Before navigating, render a result screen with:
  - a normal `<a href="{tgUrl}">` «Telegram'da yozish» button, no `target`;
  - the manager as text (`@username`; the `@` is for display only);
  - the prepared message with a «Nusxa olish» (copy) button;
  - one sentence: «Tayyor xabarni o'zgartirmasdan, birinchi xabar qilib
    yuboring» / «Отправьте готовое сообщение первым, не меняя его».

  A lead opens only if the coded message is the visitor's FIRST message to
  that manager. If they write «Salom» first, no lead opens.
- The GSR system never writes to the visitor and never calls the website
  back. There is no webhook. Do not promise «a manager will contact you»; the
  visitor writes, the manager answers.
- Disable the button on the first click. Re-enable it on back navigation:
  `addEventListener('pageshow', e => { if (e.persisted) reset() })`.
- If the questionnaire lives in an iframe, t.me refuses to load inside a
  frame. Navigate `window.top`, and the iframe's own origin must be allowed
  (§6).

### 5. The site's own list (fallback)

- One editable config value holding at least 2 Telegram usernames, given by
  the owner. They are printed in the GSR admin under «Arizalar taqsimoti →
  Sayt uchun → Zaxira ro'yxat».
- Pick one uniformly at random with `crypto.getRandomValues`. If the list is
  empty, use the company's main Telegram account. Use the same link format
  and the same code in the message.
- Visitors sent through the fallback reach a person but normally do NOT open
  a lead by themselves. That is expected.

### 6. Where it works

- Only pages on `https://gsrlogistics.uz` and `https://www.gsrlogistics.uz`
  are allowed.
- Any other place is refused with a CORS error, which is expected:
  - `http://` pages;
  - `localhost`;
  - staging or preview domains;
  - another subdomain;
  - an iframe from another host.

  In all these cases the fallback list is used. For a real extra host, give
  the owner the exact `location.origin` (https, no path). He adds it in the
  GSR admin (Sozlamalar → `lead_assign_origins`), and it starts working
  within a minute.
- Limits: 20 calls per 10 minutes per visitor IP, 120 per minute overall,
  4 at once. Beyond them the answer is `null`, which means fallback, which is
  fine.

### 7. Before and after the GSR deploy

- Until the owner deploys this part of the GSR system, the endpoint answers
  404 or a CORS error, so every visitor gets the fallback list. Ship the site
  code anyway.
- Do not store a «feature off» flag anywhere, and do not add a circuit
  breaker that outlives the page. The routing starts working the moment the
  owner deploys and ticks the managers.
- Test sparingly: every answered test call is real load for a real manager
  for the rest of the day, and there is no test mode. A curl test must send
  the Origin header:
  `curl -s -H 'Origin: https://gsrlogistics.uz' 'https://gsrwms.uz/api/lead/assign?team=general&lead=GSR-TESTAB2345'`
- The integration is done only after one real end-to-end test:
  - use a Telegram account that has NEVER written to that manager;
  - fill the questionnaire;
  - send the prepared message unchanged;
  - the owner confirms a new lead with source «Sayt» in the CRM.
- Check the prefilled text by hand on iOS Safari, Android Chrome, the
  Instagram in-app browser, Telegram Desktop, and a machine without Telegram.

### 8. Reference implementation

```js
const GSR_ENDPOINT = 'https://gsrwms.uz/api/lead/assign';
const FALLBACK_USERNAMES = ['manager_one', 'manager_two']; // from the owner
const COMPANY_USERNAME = 'company_account';                // from the owner
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // 32 chars

function mintCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'GSR-' + Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
}

function codeFor(team) {
  try {
    const s = JSON.parse(sessionStorage.getItem('gsr_code') || 'null');
    if (s && s.team === team && Date.now() - s.at < 60 * 60 * 1000) return s.code;
  } catch {}
  const code = mintCode();
  try { sessionStorage.setItem('gsr_code', JSON.stringify({ code, team, at: Date.now() })); } catch {}
  return code;
}

async function askManager({ team, code, topic, lang }) {
  const qs = new URLSearchParams({ team, lead: code, page: location.pathname });
  if (topic) qs.set('tag', topic);
  if (lang) qs.set('lang', lang);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${GSR_ENDPOINT}?${qs}`, { signal: ctrl.signal });
    const body = await res.json();
    const u = body && body.username;
    return typeof u === 'string' && /^[A-Za-z0-9_]+$/.test(u) ? u : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fallbackUsername() {
  const list = FALLBACK_USERNAMES.filter(Boolean);
  if (!list.length) return COMPANY_USERNAME;
  return list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
}

// team: 'cargo' | 'buying' | 'general'; topic: slug or ''; lang: 'uz'|'ru'|'en'|'zh'|'zh-CN' or '';
// summary: one short line built from the answers.
async function onFinalButton({ team, topic, lang, summary }, button) {
  button.disabled = true;
  const code = codeFor(team);
  const username = (await askManager({ team, code, topic, lang })) || fallbackUsername();
  const text = `Kod: ${code}\n${summary}`;
  const tgUrl = 'https://t.me/' + username + '?text=' + encodeURIComponent(text);
  showResultScreen({ username, text, tgUrl }); // <a href>, @username, copy button, the sentence from §4
  window.location.assign(tgUrl);
}

addEventListener('pageshow', (e) => {
  if (e.persisted) document.querySelectorAll('[data-gsr-final]').forEach((b) => (b.disabled = false));
});
```

---

## 2. How the system chooses (for us)

- **Who is a candidate:** an active user ticked for the team on
  /admin/taqsimot («Saytdan so'rovlar») who has a Telegram handle. The handle
  is either the one the listener READ from their connected account (trusted
  for one hour after it was last read), or else the one typed on the panel.
- **Least busy:** the fewest units handed to them TODAY (Tashkent's day). A
  unit is any of:
  - an offer the visitor actually wrote on (credited to whoever RECEIVED it);
  - an offer nobody could see (typed handle, or the listener down), counted
    all day;
  - an offer that could have been seen and was not written on, counted for
    15 minutes only;
  - an advert lead the taqsimot routed to them today.

  Ties go to whoever was handed one longest ago; nobody yet today goes first.
- **Nobody in the team:** `general`, then anybody ticked for the website at
  all, then `null`. Never somebody unticked.
- **A repeated code** answers the same person while the offer can still land
  (24 h) and that person is active; otherwise `null` (#1064).

## 3. What happens when the visitor writes

A lead is opened automatically only when all of these hold:

- The account that RECEIVES the message is connected to the system and
  tg-listen runs round-113 code. A typed handle on an unconnected account is
  reachable and never captured.
- An offer row exists for the code, written in the last 24 h. A fallback-list
  visitor normally has none.
- The message is incoming, not forwarded, private, and not from a bot.
- The chat has no `exclude` decision.
- The chat has NO earlier message on that account (first contact).
- The code has not already been claimed by another Telegram person.

The landing goes through `landInboundLead`, with these outcomes:

- A known client's question lands on their card.
- The same Telegram person already on an open lead is joined there; that
  lead keeps its owner.
- A stranger becomes a new lead owned by the RECEIVER, with source «Sayt»,
  the visitor's Telegram name, usually no phone (Telegram hides it from
  non-contacts), and the message in the lenta.

team/topic/page/lang are kept on the offer and in `lead_intakes.fields`; they
reach card fields only if mapped with the tarjimon. A code seen while the
listener was down is found by the start-up sweep (global search per open
offer, 30 newest, 24 h). That sweep is untested against live Telegram.

## 4. Deploy

`docker compose --profile telegram up -d --build tg-listen` is MANDATORY for
this round. Without it the old listener never reads anybody's handle, and the
panel says «Telegram tinglovchisi yangilanmagan» on every connected person.
