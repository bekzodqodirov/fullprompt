-- His 0.2 a (2026-10-21): the read-only measurement behind rounds 2-10 of
-- docs/SAKKIZ-BAND.md. It changes NOTHING — the whole file runs inside a
-- READ ONLY transaction that is rolled back. Run on the server:
--
--   docker compose exec -T postgres psql -U gsr -d gsr -f - < scripts/sakkiz-olchash.sql
--
BEGIN TRANSACTION READ ONLY;

\echo '1. VED: kimga nechta hisoblash tushgan (oxirgi 30 kun)'
SELECT coalesce(u.full_name, '— (hech kimga)') AS ved,
       count(*) AS tushgan,
       count(*) FILTER (WHERE r.completed_at IS NULL) AS hozir_ochiq,
       count(*) FILTER (WHERE r.completed_via = 'returned') AS qaytarilgan
  FROM calc_requests r
  LEFT JOIN users u ON u.id = r.assignee_id
 WHERE r.requested_at > now() - interval '30 days'
 GROUP BY 1 ORDER BY 2 DESC;

\echo '2. Hisoblashlar qanday yopilgan (oxirgi 30 kun)'
SELECT section, coalesce(completed_via, '— ochiq') AS qanday, count(*)
  FROM calc_requests
 WHERE requested_at > now() - interval '30 days'
 GROUP BY 1, 2 ORDER BY 1, 3 DESC;

\echo '3. AI chaqiruvlari kuniga (oxirgi 14 kun; kunlik limit 200)'
SELECT (created_at AT TIME ZONE 'Asia/Tashkent')::date AS kun, kind, count(*) AS chaqiruv,
       sum(input_tokens) AS kirish_token, sum(output_tokens) AS chiqish_token
  FROM ai_calc_passes
 WHERE created_at > now() - interval '14 days'
 GROUP BY 1, 2 ORDER BY 1 DESC, 2;

\echo '4. Bojxona import fayllari'
SELECT file_name, status, row_count, skipped_rows, period_from, period_to,
       (uploaded_at AT TIME ZONE 'Asia/Tashkent')::date AS yuklangan
  FROM customs_import_batches ORDER BY uploaded_at DESC LIMIT 10;

\echo '5. Bir nechta ochiq bitimi bor mijozlar va bir nechta hisoblash so''rovi bor bitimlar'
SELECT 'mijozlar, 2+ ochiq bitim' AS nima, count(*) FROM (
  SELECT d.client_id FROM deals d JOIN deal_stages s ON s.id = d.stage_id
   WHERE s.kind = 'open' AND d.client_id IS NOT NULL
   GROUP BY d.client_id HAVING count(*) >= 2) x
UNION ALL
SELECT 'bitimlar, 2+ hisoblash so''rovi', count(*) FROM (
  SELECT entity_id FROM calc_requests WHERE entity_type = 'deal'
   GROUP BY entity_id HAVING count(*) >= 2) y;

\echo '6. Hisoblatishga yuborilgan fayllar turi bo''yicha (oxirgi 60 kun)'
SELECT CASE
         WHEN file_name ~* '\.xls$' THEN '.xls (eski Excel)'
         WHEN file_name ~* '\.xlsx$' THEN '.xlsx'
         WHEN file_name ~* '\.csv$' THEN '.csv'
         WHEN file_name ~* '\.pdf$' THEN '.pdf'
         WHEN file_name ~* '\.(heic|heif)$' THEN 'HEIC rasm'
         WHEN content_type LIKE 'image/%' THEN 'rasm'
         WHEN file_name ~* '\.docx?$' THEN 'Word'
         ELSE 'boshqa'
       END AS tur, count(*)
  FROM attachments
 WHERE entity_type = 'crm_activity' AND file_name ~* '^(hisoblatish|.+\.(xls|xlsx|csv|pdf|heic|heif|docx?))'
   AND created_at > now() - interval '60 days'
 GROUP BY 1 ORDER BY 2 DESC;

ROLLBACK;
