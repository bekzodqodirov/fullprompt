import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { WORKER_REGISTRATIONS } from '@/modules/platform/jobs/boss';
import { escapesIntake, HOLAT } from '@/modules/platform/telegram/staff-bot';
import { bothKeyboard, staffKeyboard } from '@/modules/platform/telegram/staff-handlers';
import { ownerSummarySight, readsOwnerSummary } from '@/modules/wms/reports/owner-summary-door';

/**
 * The evening summary's doors and wiring (the owner's 7a). The door itself is
 * the REAL function over hand-built actors (#166, judge 8b): proving «a
 * super_admin whose grants were customised away from the company's money gets
 * nothing» through the database would mean editing the super_admin ROLE's
 * grants in the one database every later spec logs in with (#183).
 */

const read = (path: string) => readFileSync(path, 'utf8');
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const actor = (roles: string[], grants: readonly string[]) => ({
  id: '00000000-0000-0000-0000-000000000001',
  roles,
  permissions: new Set<string>(grants),
});

describe('who reads the evening summary — «faqat sizga»', () => {
  it('the owner: the super_admin ROLE with the company’s money sight', () => {
    expect(readsOwnerSummary(actor(['super_admin'], ROLE_MATRIX.super_admin))).toBe(true);
    expect(ownerSummarySight(actor(['super_admin'], ROLE_MATRIX.super_admin))).not.toBeNull();
  });

  it('a super_admin role whose grants were customised away from finance.reports gets nothing', () => {
    // The dashboard would show him no kassa; the bot must not either.
    const customised = ROLE_MATRIX.super_admin.filter((code) => code !== 'finance.reports');
    expect(readsOwnerSummary(actor(['super_admin'], customised))).toBe(false);
    expect(ownerSummarySight(actor(['super_admin'], customised))).toBeNull();
  });

  it('an admin holding every grant does NOT — the owner said «faqat sizga», not «admins too»', () => {
    expect(readsOwnerSummary(actor(['admin'], ROLE_MATRIX.admin))).toBe(false);
  });

  it('nobody else, whatever they hold: the accountant, the VED, a seller', () => {
    expect(readsOwnerSummary(actor(['accountant'], ROLE_MATRIX.accountant))).toBe(false);
    expect(readsOwnerSummary(actor(['ved_manager'], ROLE_MATRIX.ved_manager))).toBe(false);
    expect(readsOwnerSummary(actor(['sales_manager'], ROLE_MATRIX.sales_manager))).toBe(false);
  });
});

describe('«📊 Holat» on the keyboard', () => {
  const labels = (kb: { keyboard: { text: string }[][] }) => kb.keyboard.flat().map((b) => b.text);

  it('drawn only when the door said yes — the option is REQUIRED, so nobody can forget to ask', () => {
    expect(labels(staffKeyboard({ holat: true }))).toContain(HOLAT);
    expect(labels(staffKeyboard({ holat: false }))).not.toContain(HOLAT);
    expect(labels(bothKeyboard('uz', { holat: true }))).toContain(HOLAT);
    expect(labels(bothKeyboard('uz', { holat: false }))).not.toContain(HOLAT);
  });

  it('every staff button escapes a live collection — read off the keyboard itself (judge 8c)', () => {
    for (const label of labels(staffKeyboard({ holat: true }))) {
      expect(escapesIntake(label), label).toBe(true);
    }
    expect(escapesIntake('/holat')).toBe(true);
  });

  it('no caller names a staff keyboard without asking the person (13A, source shape)', () => {
    for (const path of [
      'src/modules/platform/telegram/bot.ts',
      'src/modules/platform/telegram/staff-handlers.ts',
      'src/modules/platform/telegram/client-cabinet.ts',
      'src/modules/platform/telegram/keyboards.ts',
    ]) {
      const source = strip(read(path));
      expect(source, path).not.toMatch(/staffKeyboard\(\)/);
    }
    const keyboards = strip(read('src/modules/platform/telegram/keyboards.ts'));
    expect(keyboards).toContain('await holatFor(chatId)');
    expect(keyboards).toContain('bothKeyboard(loc, { holat })');
    expect(keyboards).toContain('staffKeyboard({ holat })');
  });

  it('the /holat command is offered through the same door', () => {
    const commands = strip(read('src/modules/platform/telegram/commands.ts'));
    expect(commands).toContain('await holatFor(BigInt(chatId))');
    expect(commands).toMatch(/\.\.\.\(holat \? \[\{ command: 'holat'/);
  });
});

describe('the handler sits where a button is safe', () => {
  const handlers = read('src/modules/platform/telegram/staff-handlers.ts');

  it('below the cabinet pass-through, ABOVE both captures and the paid model', () => {
    const cabinet = handlers.indexOf('if (isCabinetText(ctx.message.text)) return next();');
    const holat = handlers.indexOf("if (ctx.message.text === HOLAT || ctx.message.text === '/holat')");
    const capture = handlers.indexOf('const capture = activeCapture(chatId);\n    if (capture) {');
    const task = handlers.indexOf('const pendingTask = takeTaskPending(chatId);');
    const model = handlers.indexOf('void answerWithAssistant(chatId, text, thinking.message_id);');
    for (const [name, at] of Object.entries({ cabinet, holat, capture, task, model })) {
      expect(at, `re-anchor: ${name} moved`).toBeGreaterThan(-1);
    }
    expect(cabinet).toBeLessThan(holat);
    expect(holat).toBeLessThan(capture);
    expect(holat).toBeLessThan(task);
    expect(holat).toBeLessThan(model);
  });

  it('the compose runs OFF the poller behind an immediate «⏳», one per chat (#706, judge 7)', () => {
    const body = handlers.slice(handlers.indexOf('async function answerHolat('));
    const end = body.indexOf('\n}\n');
    const fn = body.slice(0, end);
    expect(fn).toContain('holatInFlight.has(key)');
    expect(fn).toContain("await ctx.reply('⏳ Hisoblanmoqda…');");
    expect(fn).toMatch(/void \(async \(\) => \{[\s\S]*ownerSummaryFromBot\(chatId\)/);
    expect(fn).toContain('holatInFlight.delete(key)');
    // The door is asked on EVERY press, before anything is computed.
    expect(fn.indexOf('await holatFor(chatId)')).toBeLessThan(fn.indexOf('ownerSummaryFromBot(chatId)'));
  });
});

describe('the token and the reads (round B, O6)', () => {
  it('composeOwnerSummary demands the sight token — not nullable, not a boolean', () => {
    const source = strip(read('src/modules/wms/reports/owner-summary.ts'));
    expect(source).toMatch(/export async function composeOwnerSummary\(\s*actor: SummaryActor,\s*sight: CompanyMoneySight,/);
    // The one caller outside the job asks the door before it composes.
    const pull = source.slice(source.indexOf('export async function ownerSummaryForActor('));
    expect(pull.indexOf('ownerSummarySight(actor)')).toBeGreaterThan(-1);
    expect(pull.indexOf('ownerSummarySight(actor)')).toBeLessThan(pull.indexOf('composeOwnerSummary('));
  });

  it('the job hands the token only after the door, per person', () => {
    const job = strip(read('src/modules/wms/reports/owner-summary-jobs.ts'));
    expect(job).toContain('const sight = ownerSummarySight(actor);');
    expect(job).toContain('if (!sight) continue;');
    expect(job).toContain("usersWithRoles(['super_admin'])");
  });

  it('every money source of the attention list waits on the token', () => {
    const sources = strip(read('src/modules/wms/reports/attention-sources.ts'));
    expect(sources).toContain('const money = g.sight !== null;');
    for (const loader of ['loadAging()', 'loadTrips()', 'loadGaps()', 'loadUnbilled(scopeKey)']) {
      expect(sources, loader).toContain(`money ? ${loader} : null`);
    }
    expect(sources).toContain('money ? (have.balance ?? loadBalanceParts()) : null');
  });

  it('the dashboard section builds no row of its own — the facts are the one list', () => {
    const section = strip(read('src/app/(protected)/dashboard/sections/attention.tsx'));
    expect(section).not.toMatch(/push\(\{/);
    expect(section).not.toMatch(/t\('att\./);
    expect(section).toContain('attentionFacts(gates, sources, w)');
    expect(section).toContain('sight: CompanyMoneySight | null;');
  });
});

describe('the /profile switch', () => {
  const page = strip(read('src/app/(protected)/profile/page.tsx'));

  it('is drawn by the same door the job and the button ask', () => {
    expect(page).toContain('const ownerReader = actor ? readsOwnerSummary(actor) : false;');
    expect(page).toMatch(/\{ownerReader \? \([\s\S]{0,200}?name="mute_owner"/);
  });

  it('a choice already made survives a save by somebody the box is not drawn for (#171)', () => {
    // The form is replace-all: an absent box reads as «off», so a person who
    // muted it and then lost the super_admin role must not be un-muted by
    // saving an unrelated switch.
    expect(page).toContain('mutes.groups.owner && !mutes.all && <input type="hidden" name="mute_owner" value="on" />');
    const action = strip(read('src/app/(protected)/profile/actions.ts'));
    expect(action).toContain('formData.get(`mute_${g}`) === \'on\'');
  });
});

describe('the evening job', () => {
  it('is registered, and fires at 20:00 Tashkent = 15:00 UTC', () => {
    expect(WORKER_REGISTRATIONS.map(([name]) => name)).toContain('owner-summary');
    const job = strip(read('src/modules/wms/reports/owner-summary-jobs.ts'));
    expect(job).toContain("boss.schedule(JOB_OWNER_SUMMARY, '0 15 * * *')");
  });

  it('the once-a-day guard binds the day through drizzle, never a raw Date in sql (#156)', () => {
    const job = strip(read('src/modules/wms/reports/owner-summary-jobs.ts'));
    expect(job).toContain('gte(notifications.createdAt, tashkentDayStart(summary.day))');
    expect(job).toMatch(/pg_advisory_xact_lock\(hashtext\(/);
    // The drain is kicked after the commit, never inside it (#714).
    const deliver = job.slice(job.indexOf('async function deliverOnce('), job.indexOf('export async function sendOwnerSummaries('));
    expect(deliver).not.toContain('enqueue(');
  });
});
