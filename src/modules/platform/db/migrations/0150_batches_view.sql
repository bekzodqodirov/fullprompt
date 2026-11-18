-- The sellers see the trucks (2026-11-18, his «sotuvchilarga ham skladdagi yuklarni korishga ruxsat ochib berish
-- kerak furalarga va skladlarni korishga ruxsat kerak», answered «hammasi sening taklifing» = 8a «hamma
-- sotuvchilarga avtomatik»): ONE new permission, `batches.view` — the board, the trucks list, «Yo'lda» and the map,
-- read-only. Every code that opened them before is a power to ACT.
--
-- THE FIRST MIGRATION THAT WRITES A GRANT. Until now a new code reached a role only through the seed, and the seed
-- steps away from any role an admin has edited on /admin/roles (`grants_customised`, #170) — so on his database a
-- customised «Sotuvchi» would never get it, and a customised «Super admin» would not hold it either, which makes it
-- grantable by nobody (`grantableBy` offers only codes the editor holds, #179). The seed still runs after this on
-- every deploy and writes the same rows ON CONFLICT DO NOTHING.
--
-- Who gets it here:
--   * `sales_manager` — always: the code did not exist, so no admin refused it, and his 8a asks for every seller.
--   * `super_admin` — always: so it can be granted to anybody from /admin/roles (#179). It reads nothing new.
--   * `admin` — only when not customised, or when it already holds one of the five codes that read trucks. A
--     customised admin with NONE of them is one he cut off from the trucks with checkboxes; this must not open
--     them again (the design judge's DEP-4).
--
-- On a FRESH database the roles do not exist yet when migrations run (the seed makes them), so the second
-- statement grants nothing and the seed's matrix does it. Re-running either statement inserts nothing.
-- `permissions.id` has no default (0000): the id is minted here.
INSERT INTO "permissions" ("id", "code") VALUES (gen_random_uuid(), 'batches.view')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "source")
SELECT r."id", p."id", 'seed'
  FROM "roles" r
  JOIN "permissions" p ON p."code" = 'batches.view'
 WHERE r."code" IN ('sales_manager', 'super_admin')
    OR (r."code" = 'admin'
        AND (NOT r."grants_customised"
             OR EXISTS (SELECT 1
                          FROM "role_permissions" rp
                          JOIN "permissions" q ON q."id" = rp."permission_id"
                         WHERE rp."role_id" = r."id"
                           AND q."code" IN ('scan.load', 'scan.unload', 'ved.docs', 'plans.manage', 'batches.depart_close'))))
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
