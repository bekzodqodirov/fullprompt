import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MUTE_GROUPS, FOUNDERS } from '@/modules/platform/notifications/mutes';
import { WORKER_REGISTRATIONS } from '@/modules/platform/jobs/boss';

/**
 * The halves of qarz nazorati (0114) that call `authorize()`/`getActor()` or
 * live in a page, and so cannot be pressed from an integration test (#531 —
 * a service-level test of a form-fed path proves the service, not the
 * system). The services' own refusals are proven in
 * debt-control.integration.test.ts. Comments are stripped first, or a fence
 * matches the sentence explaining itself (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? undefined : end);
};

describe('every door asks the one predicate, with the person', () => {
  it('the counter action holds no grant check of its own and hands the actor to the service', () => {
    const action = between(read('src/app/(protected)/issue/actions.ts'), 'export async function issueBoxesAction', '\n}');
    expect(action).not.toContain('finance.debt_override');
    expect(action).toContain('issueBoxes(parsed.data, { actorId: actor.id, ...meta }, actor)');
  });

  it('the web decision hands the actor to the service', () => {
    const action = between(read('src/app/(protected)/issue/actions.ts'), 'export async function decideIssueApprovalAction', '\n}');
    expect(action).toMatch(/\{ actorId: actor\.id, \.\.\.meta \},\s*actor,\s*\)/);
  });

  it('the list route draws the tick from mayGrantDebt about THIS client', () => {
    const route = read('src/app/api/issue/list/route.ts');
    expect(route).toContain('const canOverrideDebt = mayGrantDebt(actor, { salesManagerId: owner?.salesManagerId ?? null });');
    expect(route).not.toContain("has('finance.debt_override')");
  });

  it('the deal card draws the «muddat» from mayGrantDebt and the action hands the actor over', () => {
    const page = read('src/app/(protected)/bitimlar/[id]/page.tsx');
    expect(page).toMatch(/\{mayGrantDebt\(actor, \{ salesManagerId: row\.clientSalesManagerId \}\) && \(\s*<Panel title=\{`⏳ \$\{t\('defer'\)\}`\}/);
    const action = between(read('src/app/(protected)/bitimlar/actions.ts'), 'export async function deferPaymentAction', '\n}');
    expect(action).toMatch(/ctx,\s*actor,\s*\),/);
  });

  it('the bot hands the chat’s person to the service and answers the refusal in words', () => {
    const bot = between(read('src/modules/platform/telegram/staff-bot.ts'), 'export async function decideApprovalFromBot', '\n}');
    expect(bot).toContain('{ id: staff.id, permissions: grants }');
    expect(bot).toContain("if (err.code === 'not_your_client') return 'not_your_client';");
    const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
    expect(handlers).toContain('const answers: Record<BotApprovalResult, string> = {');
    expect(handlers).toMatch(/not_your_client: '[^']+'/);
  });

  it('/approvals and the dashboard count read the viewer’s own list', () => {
    const page = read('src/app/(protected)/approvals/page.tsx');
    expect(page).toContain('await pendingApprovals(actor)');
    expect(page).toContain("debtGrantScope(actor) === 'none'");
    expect(page).toContain('data-testid="approvals-none-yours"');
    // The dashboard's sources moved into one reader shared with the evening
    // summary (`reports/attention-sources.ts`) in the same week; the viewer
    // travels to it, and it asks the list with that viewer — REQUIRED, so
    // the summary cannot count somebody else's queue either.
    const attention = read('src/app/(protected)/dashboard/sections/attention.tsx');
    expect(attention).toContain('readAttentionSources(gates, scopeKey, new Date(), { id: viewerId, permissions: perms })');
    const sources = read('src/modules/wms/reports/attention-sources.ts');
    expect(sources).toContain('g.canApprove ? pendingApprovals(viewer) : null');
    expect(sources).toMatch(/viewer: MoneyActor,\s*have:/);
    expect(read('src/modules/wms/reports/owner-summary.ts')).toContain('readAttentionSources(gates, scopeKey, now, actor,');
    expect(read('src/app/(protected)/dashboard/page.tsx')).toContain('viewerId={actor.id}');
  });

  it('the promise doors hold no permission check — the service asks mayGrantDebt with the actor', () => {
    const actions = read('src/app/(protected)/finance/[clientId]/actions.ts');
    expect(actions).not.toContain('authorize(');
    expect(actions).toMatch(/recordPromise\([\s\S]*?\{ actorId: actor\.id, \.\.\.meta \},\s*actor,\s*\)/);
    expect(actions).toContain('await cancelPromise(input.promiseId, { actorId: actor.id, ...meta }, actor);');
    const page = read('src/app/(protected)/finance/[clientId]/page.tsx');
    expect(page).toContain('canPromise={mayGrantDebt(actor, client)}');
  });

  it('the register is the company-money readers’ and links an act only where the act opens', () => {
    const page = read('src/app/(protected)/finance/qarzga-berilgan/page.tsx');
    expect(page).toContain('const sight = companyMoneySight(actor);');
    expect(page).toContain("if (!sight) redirect('/');");
    expect(page).toContain('{mayReadHandoverAct(actor, row.warehouseId) && (');
  });

  it('a register row prints ITS part’s «qaytdi», so debt − qaytdi = qaytmagan on the line', () => {
    const row = between(read('src/app/(protected)/finance/qarzga-berilgan/page.tsx'), 'data-testid="release-money"', '</p>');
    // The handover's whole money since, beside ONE part of a two-part release,
    // read $600 · $500 · $500 (the reviewer). Only a figureless older row,
    // which has no share to print, falls back to it.
    expect(row).toContain("{row.returnedUsd !== null ? (");
    expect(row).toContain("t('releases.returned', { usd: usd(row.returnedUsd) })");
    expect(row.indexOf('row.paidSinceUsd')).toBeGreaterThan(row.indexOf(') : ('));
  });

  it('the lenta’s «went out on debt» mark is the register’s own rule (#513), for the ledger’s readers only', () => {
    const feed = read('src/modules/wms/crm/feed.ts');
    expect(feed).toContain("'debtOverride', ${opts.money ? wentOutOnDebtSql('h') : sql`false`}");
    expect(feed).not.toContain("'debtOverride', h.debt_ok");
    // The register's four branches each stand on the same rule; a branch is
    // an access path to an index, never a second reading of «on debt».
    const parts = between(read('src/modules/wms/debt/releases.ts'), 'export function releasePartsSql', '\n}');
    expect(parts.match(/AND \$\{debtGateOpenedSql\('h'\)\}/g)).toHaveLength(3);
    expect(parts).toContain("AND h.deferrals IS NOT NULL AND ${wentOutOnDebtSql('h')}");
  });

  it('the counter screen, the approval’s snapshot and the gate total the muddat with ONE function', () => {
    const finance = between(read('src/modules/wms/finance/service.ts'), 'export async function deferredBalanceUsd', '\n}');
    expect(finance).toContain('return deferredTotal(await deferredDealsUsd(clientId));');
    const issue = between(read('src/modules/wms/issue/service.ts'), 'export async function issueBoxes', 'const result = await');
    expect(issue).toContain('const deferred = deferredTotal(deferredDeals);');
    expect(issue).not.toMatch(/deferredDeals\.reduce\(/);
  });

  it('the broken-promise alarm can be muted, is a newcomer (never a founder), and has a sweep', () => {
    expect(MUTE_GROUPS.alerts).toContain('PaymentPromiseBroken');
    expect(FOUNDERS.alerts).not.toContain('PaymentPromiseBroken');
    expect(read('src/modules/wms/debt/promises.ts')).toContain("type: 'PaymentPromiseBroken',");
    expect(WORKER_REGISTRATIONS.map(([name]) => name)).toContain('debt-promises');
  });

  it('the sweep claims before it acts, through inArray and «still open»', () => {
    const sweep = between(read('src/modules/wms/debt/promises.ts'), 'export async function sweepPromises', 'async function writeAuditRows');
    expect(sweep).toMatch(/inArray\(\s*paymentPromises\.id,/);
    expect(sweep).toContain("eq(paymentPromises.status, 'open'),");
    expect(sweep.indexOf('.returning(')).toBeLessThan(sweep.indexOf('alertBroken(row)'));
  });
});
