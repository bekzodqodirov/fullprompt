import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { read, srcFiles } from '../fixtures/source-shape';
import {
  clientMintedHtml,
  firstCargoHtml,
  heroHtml,
  leadWonHtml,
  TEMPLATE_COUNTS,
} from '@/modules/wms/staff/celebrate-text';
import { GROUP_ERRORS } from '@/app/(protected)/admin/jamoa-guruhi/errors';
import { WORKER_REGISTRATIONS } from '@/modules/platform/jobs/boss';

/**
 * The staff group's wiring (0134) — the places a behavioural test cannot
 * reach: which doors celebrate, where the bot's swallow sits, what may write
 * the active group, and that every runtime-built key exists in all four
 * bundles (#163). Comments are stripped first (#725).
 */

const BOT = read('src/modules/platform/telegram/bot.ts');
const HANDLERS = read('src/modules/platform/telegram/staff-group-handlers.ts');
const ACTIONS = read('src/app/(protected)/admin/clients/actions.ts');
const CLIENT_SERVICE = read('src/modules/platform/clients/service.ts');
const DRAIN = read('src/modules/platform/notifications/service.ts');
const RATING = read('src/modules/wms/staff/rating.ts');
const MIGRATION = readFileSync('src/modules/platform/db/migrations/0134_staff_group.sql', 'utf8');

describe('the bot never answers into a group', () => {
  it('the staff group registers after the price channel and before every command', () => {
    const channel = BOT.indexOf('registerPriceChannel(bot)');
    const group = BOT.indexOf('registerStaffGroup(bot)');
    expect(channel).toBeGreaterThan(0);
    expect(group).toBeGreaterThan(channel);
    expect(group).toBeLessThan(BOT.indexOf("bot.command('start'"));
    expect(group).toBeLessThan(BOT.indexOf("bot.command('hodim'"));
    expect(group).toBeLessThan(BOT.indexOf('registerStaffBot(bot)'));
  });

  it('the swallow ends a group’s update without passing it on', () => {
    const use = HANDLERS.slice(HANDLERS.indexOf('bot.use('));
    expect(use).toMatch(/type === 'group' \|\| type === 'supergroup'\) return;/);
  });

  it('membership updates ride the price channel’s one serial chain', () => {
    const member = HANDLERS.slice(HANDLERS.indexOf("bot.on('my_chat_member'"), HANDLERS.indexOf("bot.on('message:migrate_to_chat_id'"));
    expect(member).toContain('serialMembership(');
  });
});

describe('who celebrates', () => {
  it('both app doors praise the code’s minter, after the deal hook', () => {
    const calls = ACTIONS.match(/await celebrateNewClient\(row\.id, actor\.id\)/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const at of [...ACTIONS.matchAll(/await celebrateNewClient\(/g)].map((m) => m.index!)) {
      expect(ACTIONS.lastIndexOf('openDealForNewClient(', at)).toBeGreaterThan(-1);
    }
  });

  it('createClient itself never celebrates — the import would post 1,700 times', () => {
    expect(CLIENT_SERVICE).not.toMatch(/celebrat|staff-group/);
  });

  it('the event drain reaches the celebrations by dynamic import, fenced', () => {
    const at = DRAIN.indexOf("await import('../../wms/staff/celebrate')");
    expect(at).toBeGreaterThan(0);
    const tail = DRAIN.slice(at, at + 600);
    expect(tail).toContain('runCelebrations(');
    expect(tail).toMatch(/catch \(err\)/);
  });
});

describe('the active group has one writer', () => {
  it('only telegram/staff-group.ts writes active_from', () => {
    const writers = srcFiles()
      .filter((f) => !f.path.includes('/db/schema/') && !f.path.endsWith('.sql'))
      .filter((f) => /activeFrom\s*:/.test(f.text) || /active_from\s*=/.test(f.text))
      .map((f) => f.path);
    expect(writers).toEqual(['src/modules/platform/telegram/staff-group.ts']);
  });
});

describe('the rating reads the KPI’s own cargo', () => {
  it('one reader (stampedCargo), no second aggregate', () => {
    expect(RATING).toContain('stampedCargo(db');
    expect(RATING).not.toMatch(/FROM receipts/i);
  });

  it('Saturday 18:00 and the 8th at 18:00, in UTC', () => {
    expect(RATING).toContain("boss.schedule(JOB_STAFF_RATING, '0 13 * * 6')");
    expect(RATING).toContain("boss.schedule(JOB_STAFF_CHAMPION, '0 13 8 * *')");
  });

  it('both workers are named registrations', () => {
    const names = WORKER_REGISTRATIONS.map(([name]) => name);
    expect(names).toContain('staff-group');
    expect(names).toContain('staff-rating');
  });
});

describe('the bot command is offered and answered', () => {
  it('/reyting', () => {
    expect(read('src/modules/platform/telegram/commands.ts')).toContain("command: 'reyting'");
    expect(read('src/modules/platform/telegram/staff-handlers.ts')).toContain("ctx.message.text === '/reyting'");
  });
});

describe('every runtime-built key exists in all four bundles (#163)', () => {
  const KINDS = ['client', 'won', 'first_cargo', 'rating', 'champion', 'test'];
  const STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped'];
  const SKIPS = ['no_group', 'stale', 'group_changed'];

  it('the migration’s CHECK lists are the ones the panel renders', () => {
    expect(MIGRATION).toContain(`CHECK ("kind" IN (${KINDS.map((k) => `'${k}'`).join(',')}))`);
    expect(MIGRATION).toContain(`CHECK ("status" IN (${STATUSES.map((k) => `'${k}'`).join(',')}))`);
    expect(MIGRATION).toContain(`("skip_reason" IS NULL OR "skip_reason" IN (${SKIPS.map((k) => `'${k}'`).join(',')}))`);
  });

  for (const locale of ['ru', 'uz', 'en', 'zh-CN']) {
    it(locale, () => {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
      const g = bundle.staffGroup;
      for (const code of GROUP_ERRORS) expect(g.error[code], `error.${code}`).toBeTruthy();
      for (const k of KINDS) expect(g.kind[k], `kind.${k}`).toBeTruthy();
      for (const s of STATUSES) expect(g.status[s], `status.${s}`).toBeTruthy();
      for (const s of SKIPS) expect(g.skip[s], `skip.${s}`).toBeTruthy();
      expect(bundle.settings.descriptions.staff_rating_goal_m3).toBeTruthy();
    });
  }
});

describe('the celebrations’ words', () => {
  const hero = { name: 'Aziz <&>', telegramUserId: '555' };

  it('a name is escaped and becomes a mention only with a linked chat', () => {
    expect(heroHtml(hero)).toBe('<a href="tg://user?id=555"><b>Aziz &lt;&amp;&gt;</b></a>');
    expect(heroHtml({ name: 'Bek', telegramUserId: null })).toBe('<b>Bek</b>');
  });

  it('consecutive posts of a kind never repeat a sentence (his «zerikarli bolmasin»)', () => {
    for (const [kind, n] of Object.entries(TEMPLATE_COUNTS)) {
      const render = (i: number) =>
        kind === 'client'
          ? clientMintedHtml(hero, 'GS512', i)
          : kind === 'won'
            ? leadWonHtml(hero, 'GS512', i)
            : firstCargoHtml(hero, 'GS512', { m3: 2.456, kg: 310, place: 'Yiwu' }, i);
      const seen = new Set(Array.from({ length: n }, (_, i) => render(i)));
      expect(seen.size, kind).toBe(n);
      expect(render(n), kind).toBe(render(0));
      expect(n, kind).toBeGreaterThanOrEqual(4);
    }
  });

  it('carries the code and the cargo, never money', () => {
    const won = leadWonHtml(hero, 'GS512', 0);
    expect(won).toContain('<b>GS512</b>');
    expect(leadWonHtml(hero, null, 0)).not.toContain('null');
    const cargo = firstCargoHtml(hero, 'GS512', { m3: 2.456, kg: 310, place: 'Yiwu' }, 0);
    expect(cargo).toContain('2.46 kub · 310 kg (Yiwu)');
    for (const html of [won, cargo, clientMintedHtml(hero, 'GS512', 0)]) expect(html).not.toMatch(/\$|USD|narx/i);
  });
});
