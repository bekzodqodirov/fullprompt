# GSR LOGISTICS ERP — Phase 1: WMS

Modular ERP platform for a China→Uzbekistan cargo consolidation company.
Phase 1 is the Warehouse Management System. Specification: [`docs/SPEC.md`](docs/SPEC.md) ·
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Work plan: [`docs/PLAN.md`](docs/PLAN.md) ·
Decisions: [`DECISIONS.md`](DECISIONS.md)

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
| `pnpm dev` / `pnpm build` / `pnpm start` | run / build / serve |
| `pnpm db:generate` | generate Drizzle migration from schema |
| `pnpm db:migrate` | apply migrations |
| `pnpm db:seed` | idempotent seed (demo warehouses/users/clients) |
| `pnpm typecheck` / `pnpm lint` | static checks |
| `pnpm test` | unit tests (Vitest) |
| `pnpm e2e` | Playwright e2e at 360×800 mobile viewport |

## Deployment

`docker-compose.yml` runs app + Postgres + MinIO + nightly backup on a VPS
(HK/SG region for VPN-free mainland-China access). All assets self-hosted —
no Google/Facebook CDNs. See `ops/backup.sh` and `.env.example`.

## Project layout

```
src/app/                     Next.js routes (login, home, admin, api)
src/modules/platform/        cross-module core: db, auth, rbac, audit,
                             events, settings, files, jobs, i18n
src/modules/wms/             WMS domain (M1+)
messages/                    i18n message catalogs (ru, uz, zh-CN)
scripts/seed.ts              seed script
docs/                        SPEC, ARCHITECTURE, PLAN
```
