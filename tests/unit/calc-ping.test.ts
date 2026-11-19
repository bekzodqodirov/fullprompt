import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { CALC_PING_TYPES, calcPingOpenLabel } from '@/modules/platform/notifications/calc-ping';
import { notificationLabels } from '@/modules/platform/notifications/labels';
import { composeStaffMessage } from '@/modules/platform/notifications/service';
import { buttonsFor } from '@/modules/platform/telegram/staff-bot';
import {
  calcPingText,
  donePerM3,
  renderCalcPing,
  type CalcPing,
  type CalcRequestFacts,
  type PingReader,
  type PingResolved,
} from '@/modules/wms/calc/request-head';
import { bodyOf, strip } from '../fixtures/source-shape';

/**
 * The five calc pings said in full (the owner's answers of 2026-11-19, his 9:
 * «$/kub ham qo‘shilsin») — the renderer's gates per reader, its fallbacks,
 * the per-m³ arithmetic and the button's word. The database half (who is
 * told, the sealed V, the stored figure) is calc-ping.integration.
 */

const APP = 'https://gsrwms.uz';
const REQ = '0b8f6a1c-3d2e-4f50-8a9b-7c6d5e4f3a21';
const DEAL = '1c9f7b2d-4e3f-4061-9b8a-8d7e6f5a4b32';
const LEAD = '2da08c3e-5f40-4172-ac9b-9e8f7a6b5c43';

const reader = (codes: readonly string[], id = 'me'): PingReader => ({ id, permissions: new Set(codes) });
const role = (r: RoleCode, id = 'me') => reader(ROLE_MATRIX[r], id);
const SELLER = role('sales_manager');
const VED = role('ved_manager');
const OPERATOR = role('warehouse_operator');
const SELLER_ALL = reader(['crm.leads', 'crm.leads.view_all']);

const NONE: PingResolved = { quoteNo: null, takerName: null };

const dealFacts = (over: Partial<CalcRequestFacts> = {}): CalcRequestFacts => ({
  requestId: REQ,
  entityType: 'deal',
  entityId: DEAL,
  cardLabel: 'B-00123',
  clientCode: 'GS777',
  clientName: 'Bobur aka',
  dealTitle: 'Kurtkalar partiyasi',
  leadPhone: null,
  leadCompany: null,
  leadOwnerId: null,
  cardOwnerId: 'me',
  requestedBy: 'me',
  section: 'rastamojka',
  fromCity: 'Yiwu',
  toCity: 'Toshkent',
  weightKg: 1250,
  volumeM3: 30,
  goodsFirst: ['Kurtka', 'Shim', 'Krossovka'],
  goodsCount: 7,
  ...over,
});

const leadFacts = (over: Partial<CalcRequestFacts> = {}): CalcRequestFacts =>
  dealFacts({
    entityType: 'lead',
    entityId: LEAD,
    cardLabel: 'Anvar Toshkent',
    clientCode: null,
    clientName: null,
    dealTitle: null,
    leadPhone: '+998901234567',
    leadCompany: 'Anvar Savdo',
    leadOwnerId: 'me',
    ...over,
  });

const DONE: CalcPing = { type: 'CalcDone', amount: 1200.46, currency: 'USD', sellerNote: 'Mijozga ayting' };
const SEALED: CalcPing = {
  type: 'CalcSealed',
  versionId: 'v',
  totalUsd: 1200,
  perM3Usd: 40,
  validUntil: new Date('2026-11-25T08:00:00Z'),
};

const lines = (text: string) => text.split('\n');

describe('the facts are a closed projection — no money, no note, no offer', () => {
  it('pins the keys (a compile-time fence too: a new required field breaks this literal)', () => {
    const facts: CalcRequestFacts = {
      requestId: REQ,
      entityType: 'deal',
      entityId: DEAL,
      cardLabel: 'x',
      clientCode: null,
      clientName: null,
      dealTitle: null,
      leadPhone: null,
      leadCompany: null,
      leadOwnerId: null,
      cardOwnerId: null,
      requestedBy: 'u',
      section: null,
      fromCity: null,
      toCity: null,
      weightKg: null,
      volumeM3: null,
      goodsFirst: [],
      goodsCount: 0,
    };
    const keys = Object.keys(facts).sort();
    expect(keys).toEqual([
      'cardLabel',
      'cardOwnerId',
      'clientCode',
      'clientName',
      'dealTitle',
      'entityId',
      'entityType',
      'fromCity',
      'goodsCount',
      'goodsFirst',
      'leadCompany',
      'leadOwnerId',
      'leadPhone',
      'requestId',
      'requestedBy',
      'section',
      'toCity',
      'volumeM3',
      'weightKg',
    ]);
    for (const key of keys) expect(key).not.toMatch(/usd|price|amount|quote|offer|note|internal|answer|discount|baza|customs/i);
  });

  it('the reader names its columns: none of the internal note, none of a client price, no whole row', () => {
    const src = strip(readFileSync('src/modules/wms/calc/request-head.ts', 'utf8'));
    // A whole-row read names every declared column — the internal note with
    // them (SEC-10) — and never says so in the source.
    expect(src).not.toMatch(/\.select\(\s*\)/);
    expect(src).not.toMatch(/\.query\.\w+\.find(First|Many)\(/);
    expect(src).not.toMatch(/\$inferSelect/);
    const named = (table: string) => [...new Set([...src.matchAll(new RegExp(`\\b${table}\\.(\\w+)`, 'g'))].map((m) => m[1]))].sort();
    expect(named('calcRequests')).toEqual(
      ['entityId', 'entityType', 'fromCity', 'id', 'requestedBy', 'section', 'toCity', 'volumeM3', 'weightKg'].sort(),
    );
    // The deal's price columns (quoted*, discount*, amount) are a CLIENT price.
    expect(named('deals')).toEqual(['clientId', 'code', 'id', 'ownerId', 'title'].sort());
    expect(named('leads')).toEqual(['company', 'id', 'name', 'ownerId', 'phone'].sort());
    expect(named('clients')).toEqual(['clientCode', 'id', 'name'].sort());
  });
});

describe('the head is behind the card’s own door (SEC-9)', () => {
  it('a seller on a deal reads the client, the title, the route and the goods — and his deal card', () => {
    const out = renderCalcPing(DONE, NONE, dealFacts(), SELLER, APP);
    expect(lines(out.text)).toEqual([
      '✅ Hisoblash tayyor: B-00123',
      '👤 Mijoz: GS777 · Bobur aka',
      '📋 Kurtkalar partiyasi',
      '🛃 Rastamojka · Yiwu → Toshkent',
      '📦 Kurtka, Shim, Krossovka +4 · 1 250 kg · 30 m³',
      '💵 1200.46 USD · $40.02/m³',
      '📝 Mijozga ayting',
      `${APP}/bitimlar/${DEAL}`,
    ]);
    expect(out.openAs).toBe('deal');
  });

  it('a reader the deal card bounces keeps the deal code alone, and no link (warehouse staff’s 🧮)', () => {
    const out = renderCalcPing(DONE, NONE, dealFacts(), OPERATOR, APP);
    expect(out.text).not.toContain('GS777');
    expect(out.text).not.toContain('Bobur');
    expect(out.text).not.toContain('Kurtkalar partiyasi');
    expect(out.text).toContain('✅ Hisoblash tayyor: B-00123');
    expect(out.text).not.toContain('https://');
    expect(out.openAs).toBeNull();
  });

  it('the VED on a deal is admitted by the deal card (`ved.docs` writes positions)', () => {
    const out = renderCalcPing(DONE, NONE, dealFacts(), VED, APP);
    expect(out.text).toContain('👤 Mijoz: GS777 · Bobur aka');
    expect(out.openAs).toBe('deal');
  });

  it('a lead’s phone and company go to its owner and the whole funnel — never on `crm.leads` alone', () => {
    const own = renderCalcPing(DONE, NONE, leadFacts(), SELLER, APP);
    expect(own.text).toContain('📞 +998901234567 · 🏢 Anvar Savdo');
    expect(lines(own.text).at(-1)).toBe(`${APP}/crm/leads/${LEAD}`);
    expect(own.openAs).toBe('lead');

    const colleague = renderCalcPing(DONE, NONE, leadFacts({ leadOwnerId: 'other' }), SELLER, APP);
    expect(colleague.text).not.toContain('+998901234567');
    expect(colleague.text).not.toContain('Anvar Savdo');
    expect(colleague.openAs).toBeNull();

    const all = renderCalcPing(DONE, NONE, leadFacts({ leadOwnerId: 'other' }), SELLER_ALL, APP);
    expect(all.text).toContain('📞 +998901234567');
    expect(all.openAs).toBe('lead');
  });

  it('the VED on a lead gets the calculation’s screen and never the phone', () => {
    const out = renderCalcPing(DONE, NONE, leadFacts(), VED, APP);
    expect(out.text).not.toContain('+998901234567');
    expect(lines(out.text).at(-1)).toBe(`${APP}/hisoblash/${REQ}`);
    expect(out.openAs).toBe('calc');
  });
});

describe('it never throws, and a failed read costs lines, never the message (R12)', () => {
  it('no facts: the title with «—» and the money — no head, no link, no read needed', () => {
    expect(renderCalcPing(DONE, NONE, null, SELLER, APP)).toEqual({
      text: '✅ Hisoblash tayyor: —\n💵 1200.46 USD\n📝 Mijozga ayting',
      openAs: null,
    });
    expect(renderCalcPing(SEALED, { quoteNo: 2, takerName: null }, null, SELLER, APP).text).toBe(
      '🧮 Hisob tayyor — V2: —\n💵 $1\u00a0200.00 · $40.00/m³\n⏳ 25.11.2026 gacha amal qiladi',
    );
  });

  it('no grants: every gated line and the link are left out, the rest stands', () => {
    const out = renderCalcPing(DONE, NONE, dealFacts(), null, APP);
    expect(out.text).not.toContain('GS777');
    expect(out.text).toContain('🛃 Rastamojka · Yiwu → Toshkent');
    expect(out.text).not.toContain('https://');
    expect(out.openAs).toBeNull();
  });

  it('a render that throws falls back to the no-read line', () => {
    const broken = { ...dealFacts(), goodsFirst: null } as unknown as CalcRequestFacts;
    expect(() => renderCalcPing(DONE, NONE, broken, SELLER, APP)).toThrow();
    expect(calcPingText(DONE, NONE, broken, SELLER, APP)).toEqual({
      text: '✅ Hisoblash tayyor: —\n💵 1200.46 USD\n📝 Mijozga ayting',
      openAs: null,
    });
  });

  it('even a ping whose own figures cannot be printed still says its kind', () => {
    const bad = { ...SEALED, totalUsd: 'x' } as unknown as CalcPing;
    expect(calcPingText(bad, NONE, null, null, APP)).toEqual({ text: '🧮 —', openAs: null });
  });
});

describe('the five kinds', () => {
  it('a seal carries the CHAIN’s V, its total, its per-m³ and its last day', () => {
    const out = renderCalcPing(SEALED, { quoteNo: 2, takerName: null }, dealFacts(), SELLER, APP);
    expect(lines(out.text)[0]).toBe('🧮 Hisob tayyor — V2: B-00123');
    expect(out.text).toContain('💵 $1\u00a0200.00 · $40.00/m³');
    expect(out.text).toContain('⏳ 25.11.2026 gacha amal qiladi');
  });

  it('an unread V is no «Vnull» — the title is bare', () => {
    const out = renderCalcPing(SEALED, NONE, dealFacts(), SELLER, APP);
    expect(lines(out.text)[0]).toBe('🧮 Hisob tayyor: B-00123');
    expect(out.text).not.toContain('Vnull');
  });

  it('taken / returned / recalc keep their words and gain the head', () => {
    const taken = renderCalcPing({ type: 'CalcTaken', takerId: 'v' }, { quoteNo: null, takerName: 'Ali VED' }, dealFacts(), SELLER, APP);
    expect(lines(taken.text)[0]).toBe('🧮 Hisoblash olindi: B-00123');
    expect(taken.text).toContain('🙋 Oldi: Ali VED');
    expect(taken.text).toContain('👤 Mijoz: GS777');
    const returned = renderCalcPing({ type: 'CalcReturned', reason: 'Tovar nomi yetarli emas' }, NONE, dealFacts(), SELLER, APP);
    expect(lines(returned.text)[0]).toBe('↩️ Hisoblash qaytarildi: B-00123');
    expect(returned.text).toContain('📝 Tovar nomi yetarli emas');
    const recalc = renderCalcPing({ type: 'CalcRecalc' }, NONE, dealFacts(), SELLER, APP);
    expect(lines(recalc.text)[0]).toBe('🔄 B-00123: narx qayta hisoblanmoqda — eski narx endi amal qilmaydi');
    expect(recalc.text).not.toContain('💵');
  });

  it('money is the price alone: no customs, no freight, no $/kg beside it', () => {
    for (const ping of [DONE, SEALED]) {
      const text = renderCalcPing(ping, NONE, dealFacts(), SELLER, APP).text;
      expect(text).not.toMatch(/bojxona|rastamojka:|yo‘lkira:|\/kg/i);
    }
  });

  it('a goods name with its own newlines stays one line; route halves may be missing', () => {
    const out = renderCalcPing(DONE, NONE, dealFacts({ goodsFirst: ['Ayollar\nkurtkasi'], goodsCount: 1, toCity: null }), SELLER, APP);
    expect(out.text).toContain('📦 Ayollar kurtkasi · 1 250 kg · 30 m³');
    expect(out.text).toContain('🛃 Rastamojka · Yiwu → —');
  });
});

describe('$/kub — his 9', () => {
  it('the answer’s per-m³ is the amount over the request’s volume, to the cent', () => {
    expect(donePerM3(1200.46, 'USD', 30)).toBe(40.02);
    expect(donePerM3(480, 'USD', 30)).toBe(16);
  });

  it('nothing with no volume, a zero volume, a so‘m or yuan answer, or a figure that rounds to $0', () => {
    expect(donePerM3(1200, 'USD', null)).toBeNull();
    expect(donePerM3(1200, 'USD', 0)).toBeNull();
    expect(donePerM3(1200, 'USD', -3)).toBeNull();
    expect(donePerM3(15_000_000, 'UZS', 30)).toBeNull();
    expect(donePerM3(9000, 'CNY', 30)).toBeNull();
    expect(donePerM3(0.01, 'USD', 1000)).toBeNull();
    expect(donePerM3(Number.NaN, 'USD', 30)).toBeNull();
  });

  it('rounds by the engine’s own rule, decimal half-up — not a binary Math.round (review P2-1)', () => {
    // 3.015 / 1 in binary is 3.01499…: `Math.round(x * 100) / 100` says 3.01,
    // the engine's `roundCents` (the seal's `perM3Usd`) says 3.02.
    expect(donePerM3(3.015, 'USD', 1)).toBe(3.02);
    expect(donePerM3(1.005, 'USD', 1)).toBe(1.01);
  });

  it('a four-figure cube is spelled as the price channel spells it — grouped digits (review P2-2)', () => {
    const NBSP = ' ';
    const done = renderCalcPing({ ...DONE, amount: 36_000 } as CalcPing, NONE, dealFacts({ volumeM3: 30 }), SELLER, APP).text;
    expect(done).toContain(`💵 36000 USD · $1${NBSP}200.00/m³`);
    const sealed = renderCalcPing({ ...SEALED, perM3Usd: 1250 } as CalcPing, NONE, dealFacts(), SELLER, APP).text;
    expect(sealed).toContain(`· $1${NBSP}250.00/m³`);
  });

  it('the line says none of it then — never «$0.00/m³», never «NaN»', () => {
    const noVolume = renderCalcPing(DONE, NONE, dealFacts({ volumeM3: null }), SELLER, APP).text;
    expect(noVolume).toContain('💵 1200.46 USD\n');
    expect(noVolume).not.toContain('/m³');
    const uzs = renderCalcPing({ ...DONE, amount: 15_000_000, currency: 'UZS' } as CalcPing, NONE, dealFacts(), SELLER, APP).text;
    expect(uzs).toContain('💵 15000000 UZS\n');
    expect(uzs).not.toContain('/m³');
    for (const perM3Usd of [null, 0, 0.004, Number.NaN]) {
      const sealed = renderCalcPing({ ...SEALED, perM3Usd } as CalcPing, NONE, dealFacts(), SELLER, APP).text;
      expect(sealed).toContain('💵 $1\u00a0200.00\n');
      expect(sealed).not.toMatch(/\/m³|NaN/);
    }
  });
});

describe('the button names its door — by TYPE first (R11, D10)', () => {
  const L = notificationLabels('uz');

  it('the three words, only on the five calc pings', () => {
    expect(CALC_PING_TYPES).toEqual(['CalcSealed', 'CalcDone', 'CalcTaken', 'CalcReturned', 'CalcRecalc']);
    for (const type of CALC_PING_TYPES) {
      expect(calcPingOpenLabel(type, { openAs: 'lead' }, L)).toBe('↗️ Lidni ochish');
      expect(calcPingOpenLabel(type, { openAs: 'deal' }, L)).toBe('↗️ Bitimni ochish');
      expect(calcPingOpenLabel(type, { openAs: 'calc' }, L)).toBe('↗️ Hisobni ochish');
      // A ping written before this round has no `openAs` and keeps its word.
      expect(calcPingOpenLabel(type, {}, L)).toBeNull();
      expect(calcPingOpenLabel(type, { openAs: 'bitimlar' }, L)).toBeNull();
    }
    for (const type of ['TaskAssigned', 'InboundLeadArrived', 'InternalNote', 'CalcPrefilled', 'CalcOffer']) {
      expect(calcPingOpenLabel(type, { openAs: 'deal' }, L)).toBeNull();
    }
  });

  it('in the drain: a calc ping’s button says which door, a task’s stays «↗️ Ochish»', () => {
    const saved = process.env.APP_URL;
    process.env.APP_URL = APP;
    try {
      const done = composeStaffMessage('CalcDone', { text: `✅ Hisoblash tayyor: B-1\n${APP}/bitimlar/${DEAL}`, openAs: 'deal' }, 'uz');
      expect(done.urlRow).toEqual([{ text: '↗️ Bitimni ochish', url: `${APP}/bitimlar/${DEAL}` }]);
      const calc = composeStaffMessage('CalcSealed', { text: `🧮 Hisob tayyor: Lid\n${APP}/hisoblash/${REQ}`, openAs: 'calc' }, 'uz');
      expect(calc.urlRow).toEqual([{ text: '↗️ Hisobni ochish', url: `${APP}/hisoblash/${REQ}` }]);
      const task = composeStaffMessage('TaskAssigned', { text: `🆕 Yangi vazifa: X\n${APP}/bitimlar/abc`, openAs: 'deal' }, 'uz');
      expect(task.urlRow).toEqual([{ text: '↗️ Ochish', url: `${APP}/bitimlar/abc` }]);
      const old = composeStaffMessage('CalcDone', { text: `✅ Hisoblash tayyor: B-1\n${APP}/bitimlar/${DEAL}` }, 'uz');
      expect(old.urlRow).toEqual([{ text: '↗️ Ochish', url: `${APP}/bitimlar/${DEAL}` }]);
    } finally {
      if (saved === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = saved;
    }
  });

  it('the payload’s `openAs` adds no button: the URL row is still the only row (Q2 a)', () => {
    for (const type of ['CalcDone', 'CalcSealed', 'CalcReturned', 'CalcTaken', 'CalcRecalc']) {
      for (const openAs of ['lead', 'deal', 'calc']) {
        expect(buttonsFor(type, { text: '✅ Hisoblash tayyor', openAs })).toBeNull();
      }
    }
  });

  it('every locale has the three words', () => {
    for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
      const words = notificationLabels(locale);
      for (const w of [words.openLead, words.openDeal, words.openCalc]) {
        expect(w.startsWith('↗️ ')).toBe(true);
        expect(w).not.toBe(words.openInApp);
      }
    }
  });
});

describe('the five senders all go through the one sender', () => {
  const service = strip(readFileSync('src/modules/wms/calc/service.ts', 'utf8'));
  const workspace = strip(readFileSync('src/modules/wms/calc/workspace.ts', 'utf8'));

  it('no calc ping type is queued by hand any more', () => {
    for (const type of CALC_PING_TYPES) {
      for (const src of [service, workspace]) expect(src).not.toContain(`type: '${type}',\n    text`);
    }
    const pings = [...service.matchAll(/type: '(Calc\w+)'/g), ...workspace.matchAll(/type: '(Calc\w+)'/g)]
      .map((m) => m[1])
      .filter((t) => (CALC_PING_TYPES as readonly string[]).includes(t!));
    expect(pings.sort()).toEqual([...CALC_PING_TYPES].sort());
    expect((service.match(/sendCalcPing\(\{/g) ?? []).length).toBe(3);
    expect((workspace.match(/sendCalcPing\(\{/g) ?? []).length).toBe(2);
  });

  it('after the commit, nothing can throw the ping away: the audit and the task titles are caught (review P2-3, P2-4)', () => {
    // The seal: its post-commit audit sits ABOVE `announceSeal`, so an
    // uncaught throw there costs «🧮 Hisob tayyor» for good.
    const seal = bodyOf(workspace, 'export async function sealCalc(');
    const sealTail = seal.slice(seal.indexOf('retireTaskCopiesSoon'));
    const sealAudit = sealTail.slice(sealTail.indexOf('await writeAudit('), sealTail.indexOf('announceSeal('));
    expect(sealAudit).toMatch(/^await writeAudit\([\s\S]*\}\)\.catch\(/);
    // The hand-back: its audit sits above the CalcReturned ping.
    const back = bodyOf(service, 'export async function returnCalcRequest(');
    const backAudit = back.slice(back.indexOf('await writeAudit('), back.indexOf('sendCalcPing('));
    expect(backAudit).toMatch(/^await writeAudit\([\s\S]*\}\)\.catch\(/);
    // The two task titles read a label with its own fallback — a throw must
    // neither escape a committed take nor skip the task it names.
    const take = bodyOf(service, 'export async function takeCalcRequest(');
    expect(take).toMatch(/requestLabel\(won\.entityType, won\.entityId\)\.catch\(/);
    expect(back).toMatch(/requestLabel\(row\.entityType, row\.entityId\)\.catch\(/);
    // …and the take's own audit, above «🙋 Oldi» (review P2F-2).
    const takeAudit = take.slice(take.lastIndexOf('await writeAudit('), take.indexOf('sendCalcPing('));
    expect(takeAudit).toMatch(/^await writeAudit\([\s\S]*\}\)\.catch\(/);
    // The correction: BOTH its post-commit audits sit above its task and the
    // CalcRecalc ping (review P2F-1) — every one of them caught.
    const recalc = bodyOf(workspace, 'export async function recalcFromSealed(');
    const recalcTail = recalc.slice(recalc.indexOf("throw new CalcError('recalc_open')"), recalc.indexOf('sendCalcPing('));
    const audits = recalcTail.split('await writeAudit(').slice(1);
    expect(audits).toHaveLength(2);
    // The call's own close — the first «})» in each chunk — is followed by its catch.
    for (const audit of audits) expect(audit.slice(audit.indexOf('})'), audit.indexOf('})') + 9)).toBe('}).catch(');
  });

  it('a seal names its version for the V, never the per-request counter (D8)', () => {
    const announce = workspace.slice(workspace.indexOf('async function announceSeal('));
    const ping = announce.slice(0, announce.indexOf('announceAgentCalcSafe'));
    expect(ping).toContain('versionId: result.versionId');
    expect(ping).not.toContain('versionNo');
  });
});
