# GSR LOGISTICS ERP — Phase 1: WMS

Modular ERP platform for a China→Uzbekistan cargo consolidation company.
Phase 1 is the Warehouse Management System. Specification: [`docs/SPEC.md`](docs/SPEC.md) ·
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Work plan: [`docs/PLAN.md`](docs/PLAN.md) ·
Decisions: [`DECISIONS.md`](DECISIONS.md) · Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## Stack

Next.js 15 (App Router) · TypeScript strict · PostgreSQL 16 + Drizzle ORM · pg-boss ·
next-intl (ru/uz/zh-CN) · Tailwind CSS · Serwist PWA · Vitest + Playwright

## Quickstart (dev)

```bash
pnpm install
cp .env.example .env          # fill DATABASE_URL etc.
createdb gsr_dev              # any local Postgres 16+
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Log in with any seeded user (see `scripts/seed.ts`), e.g. super admin
`+998900000001` / `demo1234`.

## Commands

| Command | What |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | run / build / serve production build |
| `pnpm db:generate` | generate Drizzle migration from schema |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:seed` | idempotent seed (demo warehouses/users/clients) |
| `pnpm typecheck` / `pnpm lint` | static checks |
| `pnpm test` | unit + integration tests (Vitest) |
| `pnpm e2e` | Playwright e2e at 360×800 mobile viewport |
| `pnpm backup` | manual `pg_dump` to `BACKUP_DIR` (same code as the nightly job) |
| `pnpm restore-test` | restore the latest dump into a scratch DB and sanity-check it |
| `pnpm check:files` | verify every attachment row has its file on disk |
| `pnpm refresh` | install + migrate + build (after `git pull` on the server) |

## Ops runbook

### Serving in production

The app builds with `output: 'standalone'`; **always start it with
`pnpm start`** (which runs `scripts/start-standalone.mjs`) — plain
`next start` can serve a broken client manifest for route-group pages.
The start script also copies static assets into the standalone dir and
resolves `STORAGE_LOCAL_DIR` to an absolute path.

Deploying an update on the server:

```bash
git pull
pnpm refresh       # install + db:migrate + build
# restart the process manager (systemd/pm2) that runs `pnpm start`
```

### Background jobs (pg-boss, in-process)

| Job | Schedule (Tashkent) | What |
|---|---|---|
| `notify.digest` | daily 09:00 | unclaimed/stale-stock digest to logists+admins |
| `db.backup` | daily 02:00 | `pg_dump -Fc` to `BACKUP_DIR`, prune > `BACKUP_RETENTION_DAYS` |
| `db.restore_test` | Sunday 04:00 | restore the latest dump into a scratch DB; admins get a Telegram alert on failure |
| `notify.telegram` / `events.process` | continuous | notification fan-out and Telegram sends with retry |
| `costs.recompute` | on demand | rebuilds cost allocations after entry/FX/depart changes |

### Backups & restore

- Nightly dump: `BACKUP_DIR` (default `.data/backups`), 30-day retention — **local
  disk for now** (owner's decision, off-site to be revisited).
- Weekly fire drill: the `db.restore_test` job (or `pnpm restore-test` by hand)
  restores the newest dump into a scratch database `gsr_restore_test`, checks that
  users/warehouses/clients/receipts/boxes/batches all came back, then drops it.
- Manual restore to the live DB (destructive — take a fresh dump first):

```bash
pg_restore -d gsr_dev --clean --if-exists .data/backups/gsr-YYYY-MM-DD.dump
```

### Telegram bot

Set `TELEGRAM_BOT_TOKEN` in `.env` (BotFather). `TELEGRAM_POLLING=1` makes the
app poll for `/start <link-code>` messages; users connect from **Profile →
✈️ Connect Telegram**. Per-user mutes live on the profile page; delivery
failures are visible under **Admin → Notifications**.

### Monitoring delivery & files

- **Admin → Notifications**: Telegram delivery journal (problems-first).
- **Admin → Audit**: every write, with before/after diffs.
- `pnpm check:files`: attachment rows vs files on disk after storage moves.

### Troubleshooting

- **Login blocked (“too many attempts”)**: the rate limiter allows 5 tries per
  15 min per phone+IP; wait it out or `TRUNCATE login_attempts;` in dev.
- **Photos 404 after a server move**: run `pnpm check:files`; the start script
  self-heals files that landed inside `.next/standalone/.data`.
- **Jobs not running**: pg-boss starts with the app process — check the app
  logs for `pg-boss started`; jobs need the DB user to create the `pgboss`
  schema.

## Deployment

`docker-compose.yml` runs app + Postgres + MinIO + nightly backup on a VPS
(HK/SG region for VPN-free mainland-China access). All assets self-hosted —
no Google/Facebook CDNs. See `ops/backup.sh` and `.env.example`.

## Project layout

```
src/app/                     Next.js routes (login, home, admin, api)
src/modules/platform/        cross-module core: db, auth, rbac, audit,
                             events, settings, files, jobs, backup, i18n
src/modules/wms/             WMS domain: receipts, boxes, crates, plans,
                             batches, scans, issue, inventory, costing,
                             reports, documents
messages/                    i18n message catalogs (ru, uz, zh-CN)
scripts/                     seed, backup, restore-test, standalone start
docs/                        SPEC, ARCHITECTURE, PLAN
```
