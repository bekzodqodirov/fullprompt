import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_ZONE_ROUTES,
  escapesIntake,
  isZoneStep,
  parseCallback,
  zonePressAnswer,
} from '@/modules/platform/telegram/staff-bot';
import { zoneKeyboard } from '@/modules/platform/telegram/staff-handlers';
import { KNOWN_TARIFF_ZONES, OWNER_TARIFF_ZONES, ownerTariffRows } from '@/modules/wms/calc/tariff-seed';
import { ZONE_ROUTE } from '@/modules/wms/calc/prefill';

/**
 * The «🤖 AI rastamojka» door (the owner's own words, 2026-09-05).
 *
 * A grammy handler cannot be exercised without a Telegram, so what a shell
 * can prove is proven behaviourally (the callback vocabulary) and the rest is
 * SOURCE SHAPE — the rules whose breach leaves every screen rendering and
 * every test green while the seller's collection is silently discarded, the
 * certificate never reaches the request, or the machine quotes freight it was
 * told never to quote.
 *
 * Comments are stripped first (#725).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the callback vocabulary', () => {
  it('carries the AI door, the restart twins, the certificate and the skip', () => {
    for (const step of [
      'ai',
      'go_ai',
      'go_rastamojka',
      'cert',
      'skip',
      // Item 13: the podklyuch door, its restart twin and the two zones.
      'aipk',
      'go_aipk',
      'zone_cn',
      'zone_kashgar',
      // The Horgos round: a third zone button.
      'zone_horgos',
    ]) {
      expect(parseCallback(`c:${step}`), step).toEqual({ kind: 'calc', step });
    }
  });

  it('still refuses anything that is not a step', () => {
    expect(parseCallback('c:drop_table')).toBeNull();
    expect(parseCallback('c:')).toBeNull();
    expect(parseCallback('x:ai')).toBeNull();
  });
});

describe('the rules a shell cannot exercise', () => {
  const handlers = read('src/modules/platform/telegram/staff-handlers.ts');

  it('the AI door opens rastamojka OR podklyuch — never a section the engine lacks', () => {
    // Decision 8 («no freight») was overturned by the owner on 2026-09-26
    // (item 13): «ai» is still rastamojka, and «aipk» is podklyuch, which
    // carries the road. A `startIntake(chatId, 'ai')` would be a section the
    // whole engine does not have.
    expect(handlers).toContain("startIntake(chatId, opening === 'ai' ? 'rastamojka' : opening");
    expect(handlers).toContain("startIntake(chatId, 'podklyuch', { ai: true })");
  });

  it('every zone button is a zone the app can name, and the reply names each one', () => {
    // REWRITTEN in the Horgos round, with the reason: this used to assert the
    // buttons EQUAL the seeded zones, because a button for a zone the tariff
    // lacks stores NULL (openCalcRequest drops it) and quotes «zona
    // tanlanmagan» after the seller chose one. «horgos» is a zone he prices
    // himself (answer 22), so that gate moved to RUNTIME — the keyboard draws
    // only priced zones and a press re-checks (the two tests below). What
    // stays static is that every button names a zone the app knows.
    const zones = Object.values(AI_ZONE_ROUTES).map((r) => r.zone);
    for (const z of zones) {
      expect(KNOWN_TARIFF_ZONES as readonly string[], z).toContain(z);
      expect(ZONE_ROUTE[z], z).toBeTruthy();
    }
    // …and the seed still writes his two and nothing for Horgos.
    expect([...new Set(ownerTariffRows().map((r) => r.zone))].sort()).toEqual([...OWNER_TARIFF_ZONES].sort());
  });

  it('draws a zone button only for a zone the tariff prices today', () => {
    const steps = (priced: string[]) =>
      zoneKeyboard(priced)
        .inline_keyboard.flat()
        .map((b) => b.callback_data)
        .filter((d) => d !== 'c:cancel');
    expect(steps(['cn', 'kashgar'])).toEqual(['c:zone_cn', 'c:zone_kashgar']);
    // Every known zone priced (and one nobody has a button for): three, each
    // parsed — an unparsed callback spins for fifteen seconds (#937).
    const all = steps([...KNOWN_TARIFF_ZONES, 'almaty']);
    expect(all).toHaveLength(3);
    for (const data of all) expect(parseCallback(data), data).not.toBeNull();
    // Cancel is always there: the question must stay answerable.
    expect(zoneKeyboard([]).inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['c:cancel']);
  });

  it('a zone press whose price is gone is refused in words, before anything is written', () => {
    expect(zonePressAnswer('zone_horgos', ['cn', 'kashgar'])).toEqual({
      ok: false,
      text: expect.stringContaining('narxi hali kiritilmagan'),
    });
    expect(zonePressAnswer('zone_horgos', ['cn', 'kashgar', 'horgos'])).toEqual({
      ok: true,
      route: { zone: 'horgos', fromCity: 'Horgos', toCity: 'O‘zbekiston' },
    });
    // `hasOwn`: a step that merely resolves on the prototype is no zone.
    expect(isZoneStep('toString')).toBe(false);
    expect(isZoneStep('zone_cn')).toBe(true);
  });

  it('both zone questions ask the tariff NOW, and a press is judged before it is written', () => {
    // The keyboard is pure, so the two sites that draw it are where «only
    // priced zones» lives — a site that forgot would draw a stale list.
    expect(handlers.match(/zoneKeyboard\(await pricedZonesNow\(\)\)/g)).toHaveLength(2);
    expect(handlers).not.toMatch(/zoneKeyboard\(\)/);
    const judged = handlers.indexOf('zonePressAnswer(step, await pricedZonesNow())');
    const written = handlers.indexOf("updateIntake(chatId, { route, stage: 'client' })");
    expect(judged, 'the press is no longer judged — re-anchor this fence').toBeGreaterThan(-1);
    expect(judged).toBeLessThan(written);
    expect(handlers).toContain('if (isZoneStep(step))');
  });

  it('the zone travels from the collection to the request row', () => {
    const bot = read('src/modules/platform/telegram/staff-bot.ts');
    expect(bot).toContain('freightZone: state.route?.zone ?? null');
    expect(read('src/modules/wms/calc/intake-land.ts')).toContain(
      'freightZone: input.freightZone ?? null',
    );
  });

  it('a live collection is never replaced without asking', () => {
    // The restart question is what stands between «I pressed the wrong
    // button» and twenty forwarded messages gone.
    const at = handlers.indexOf("if (!step.startsWith('go_') && activeIntake(chatId))");
    expect(at, 'the restart guard has moved — re-anchor this fence').toBeGreaterThan(-1);
    // …and it must come BEFORE the state is minted, or it guards nothing.
    expect(at).toBeLessThan(handlers.indexOf('startIntake(chatId, opening'));
  });

  it('the entry labels and the day screen escape the material capture', () => {
    // Both were swallowed: pressing the button again filed its own label as
    // material, and «📋 Bugun» answered with silence mid-collection.
    //
    // Anchored on the PREDICATE's name, not on the expression: the zametkalar
    // round added a third escape, and a fence matching an expression that has
    // to be rewritten every time a button is added tells you nothing about
    // whether the escapes survived. The escapes themselves are asserted
    // behaviourally in tests/unit/zametka-bot.test.ts.
    expect(handlers).toContain('if (intake && !escapesIntake(ctx.message.text))');
    expect(escapesIntake('🧮 Hisoblatish')).toBe(true);
    expect(escapesIntake('🤖 AI rastamojka')).toBe(true);
    expect(escapesIntake('📋 Bugun')).toBe(true);
  });

  it('the certificate answer reaches the request, through the landing', () => {
    expect(read('src/modules/platform/telegram/staff-bot.ts')).toContain(
      'hasCertificate: state.hasCertificate',
    );
    expect(read('src/modules/wms/calc/intake-land.ts')).toContain(
      'hasCertificate: input.hasCertificate ?? true',
    );
    expect(read('src/modules/wms/calc/service.ts')).toContain(
      'hasCertificate: input.hasCertificate ?? true',
    );
  });

  it('a photo sent before the customer is named gets an answer', () => {
    // It used to fall through to the cabinet, which answers a staff chat
    // with nothing at all — the first thing a seller does after pressing the
    // button vanished.
    expect(handlers).toContain("if (state.stage === 'client') {");
    expect(handlers).toContain('Avval mijozni yozing');
  });

  it('the Telegram file download has a deadline', () => {
    // grammy's poller is sequential: a socket that accepts and then stops
    // sending held every customer's cabinet with it.
    expect(handlers).toContain('AbortSignal.timeout(FILE_DOWNLOAD_MS)');
  });

  it('the invoice reader answers a DOCX in words rather than «no goods»', () => {
    // A DOCX is a zip like an xlsx, so the sniff would call it a workbook and
    // the parser would answer nothing at all — silence where the seller is
    // waiting for a figure.
    expect(handlers).toContain('DOCX o‘qilmaydi');
  });
});
