-- Every advertising platform, one door (round 86b).
--
-- Round 83 built three doors: Meta's own webhook, the public form, and the
-- bot. What was left over is every platform whose lead form posts to a URL of
-- our choosing — Google Ads (which is also how a YouTube lead form arrives),
-- TikTok through a connector, and the owner's own website. They differ only in
-- where they put the shared secret, so they get ONE endpoint and one secret
-- per source rather than an integration each.

-- The secret for `POST /api/leads/in/<key>`. NULL means the door does not
-- exist for that source and the route 404s — the same fail-closed rule
-- `metaConfig()` keeps, because a webhook that authenticates nothing is a
-- public write into the funnel.
ALTER TABLE lead_sources ADD COLUMN webhook_secret text;

-- A fourth channel. The CHECK widens rather than being dropped: an arrival
-- must still say how it got here, and «webhook» is a different fact from
-- «form» — one was typed by a person on our page, the other was posted by a
-- platform, and only the second can be misconfigured.
ALTER TABLE lead_intakes DROP CONSTRAINT lead_intakes_channel_check;
ALTER TABLE lead_intakes ADD CONSTRAINT lead_intakes_channel_check
  CHECK (channel IN ('form', 'meta', 'telegram', 'webhook'));
