-- The order the owner puts the cards in (round 96; minted as 0073, renumbered to 0075 on merge).
--
-- He: «cartni boshqa etapga otkazganda ularni tartibi ozgarib qolyabti qaysi
-- ketma ketlikda qoysa usha saqlanib qoladgan qilsa boladimi?» — and he was
-- describing exactly what the board did. Both funnels ordered a column by
-- «last touched first» (`leads.updated_at DESC`, `deals.created_at DESC`), so
-- moving A and then B put B above A, and any edit, owner change or automation
-- rule reshuffled a column nobody had touched.
--
-- A double, not an integer: a card dropped between two others takes the
-- midpoint of their two numbers, so ONE row is written per drag instead of
-- renumbering everything below it. The gaps halve, and the placement code
-- renumbers a column when they get too small to split.
--
-- Backfilled from the order the board shows TODAY, so the deploy changes
-- nothing anybody can see: the first drag is the first difference. NULL is
-- left legal and READ as «nobody has placed this» — it sorts first, which is
-- where a brand-new card already appears — so any write path that forgets the
-- column degrades to today's behaviour instead of dropping a card somewhere
-- arbitrary.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS board_order double precision;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS board_order double precision;
--> statement-breakpoint
UPDATE leads SET board_order = ranked.rn * 1000
FROM (
  SELECT id, row_number() OVER (PARTITION BY stage_id ORDER BY updated_at DESC, id) AS rn
  FROM leads
) ranked
WHERE leads.id = ranked.id AND leads.board_order IS NULL;
--> statement-breakpoint
UPDATE deals SET board_order = ranked.rn * 1000
FROM (
  SELECT id, row_number() OVER (PARTITION BY stage_id ORDER BY created_at DESC, id) AS rn
  FROM deals
) ranked
WHERE deals.id = ranked.id AND deals.board_order IS NULL;
--> statement-breakpoint
-- The board reads one column at a time in this order, and so does the
-- per-stage cap that decides which forty cards are sent to the browser.
CREATE INDEX IF NOT EXISTS leads_board_order_idx ON leads (stage_id, board_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deals_board_order_idx ON deals (stage_id, board_order);
