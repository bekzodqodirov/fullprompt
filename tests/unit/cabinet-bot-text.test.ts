import { describe, expect, it } from 'vitest';
import { htmlToPlain, visibleLength } from '@/modules/platform/telegram/format';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import {
  MAX_PHOTO_BUTTONS,
  balanceMessages,
  cargoMessages,
  cargoSummaryLine,
  forwardStaffText,
  historyMessages,
  lotBlock,
  managerCards,
  orderLotsForBot,
  photoButtonRows,
  photoCaption,
  photoSource,
  prettyPhone,
  startGreetingHtml,
  throttledHtml,
} from '@/modules/wms/client-cabinet/bot-text';
import type { CabinetLot, CargoGroup, DebtSummary } from '@/modules/wms/client-cabinet/service';

/**
 * What a customer reads in the bot (round C). Every one of these used to be
 * assembled inside a grammy handler that no test could reach; the rules below
 * are the ones the scouts found broken there — an overdue truck at «100%», a
 * total that netted one code's credit against another's debt, a list silently
 * cut at 4000 characters, two «📷 A» buttons nobody could tell apart.
 */

const NBSP = ' ';
const uz = clientLabels('uz');

function lot(over: Partial<CabinetLot> & { groups?: CargoGroup[] } = {}): CabinetLot {
  const groups = over.groups ?? [{ stage: 'cn_warehouse', n: 4, transit: null }];
  return {
    lotId: over.lotId ?? `lot-${Math.random().toString(36).slice(2)}`,
    letter: 'A',
    productNameZh: '杂货',
    productNameRu: 'Kurtka',
    journey: [{ key: 'received', atIso: '2026-09-01T06:00:00.000Z' }],
    total: groups.reduce((s, g) => s + g.n, 0),
    warehousePlaces: ['Yiwu'],
    hasPhotos: false,
    weightKg: 40,
    volumeM3: 0.35,
    perBoxKg: 10,
    perBoxM3: 0.0875,
    photoCount: 0,
    readyCleared: 0,
    ...over,
    groups,
  };
}

const road = (etaFromIso: string | null, etaToIso: string | null, progress = 0.4) => ({
  fromPlace: 'Kashgar',
  toPlace: 'Tashkent 1',
  progress,
  etaFromIso,
  etaToIso,
});

describe('the cargo list', () => {
  it('escapes every typed value — a name with «<» cannot become markup', () => {
    const [msg] = cargoMessages(
      { clientCode: 'GS777', name: 'A&B <shop>' },
      [lot({ productNameRu: '<b>Kurtka</b> & co', warehousePlaces: ['Sklad <1>'] })],
      'uz',
    );
    expect(msg).toContain('A&amp;B &lt;shop&gt;');
    expect(msg).toContain('&lt;b&gt;Kurtka&lt;/b&gt; &amp; co');
    expect(msg).toContain('Sklad &lt;1&gt;');
    expect(msg).not.toContain('<shop>');
    // …and the words a customer reads are exactly the words that were typed.
    expect(htmlToPlain(msg!)).toContain('A&B <shop>');
  });

  it('counts every box once at its step — a truck at customs is NOT lost (STRIP-1)', () => {
    const lots = [
      lot({ groups: [{ stage: 'ready', n: 7, transit: null }] }),
      lot({ groups: [{ stage: 'customs_done', n: 1, transit: null }, { stage: 'in_uz', n: 3, transit: null }] }),
      lot({ groups: [{ stage: 'export_transit', n: 6, transit: null }] }),
      lot({ groups: [{ stage: 'cn_warehouse', n: 4, transit: null }] }),
    ];
    // Nearest the customer first: ready · Uzbekistan · transit · China.
    expect(htmlToPlain(cargoSummaryLine(lots, 'uz'))).toBe(
      `${uz.sumReady}: 7 · ${uz.sumUz}: 4 · ${uz.sumTransit}: 6 · ${uz.sumChina}: 4`,
    );
  });

  it('says nothing about a step with nothing on it', () => {
    const line = htmlToPlain(cargoSummaryLine([lot({ groups: [{ stage: 'hub', n: 2, transit: null }] })], 'uz'));
    expect(line).toBe(`${uz.sumTransit}: 2`);
  });

  it('a moving truck names WHERE the estimate lands, and never a percentage (CX-9)', () => {
    const block = htmlToPlain(
      lotBlock(
        lot({
          groups: [
            { stage: 'export_transit', n: 5, transit: road('2026-09-29T12:00:00Z', '2026-10-02T12:00:00Z', 0.37) },
          ],
        }),
        'uz',
      ),
    );
    expect(block).toContain('🗓 Yetib borishi (Tashkent 1): taxminan 29.09 – 02.10');
    expect(block).not.toContain('%');
    expect(block).toContain('🟩🟩⬜⬜⬜');
  });

  it('an OVERDUE truck prints its rung alone — no «100%», no date', () => {
    const block = htmlToPlain(
      lotBlock(lot({ groups: [{ stage: 'export_transit', n: 5, transit: road(null, null, 1) }] }), 'uz'),
    );
    expect(block).not.toContain('%');
    expect(block).not.toContain('🗓');
    expect(block).toContain(`${uz.msTransit} · ${uz.stgExport_transit}`);
  });

  it('a rung that IS its step is said once, not twice', () => {
    const block = htmlToPlain(lotBlock(lot({ groups: [{ stage: 'ready', n: 2, transit: null }] }), 'uz'));
    expect(block).toContain(`🟩🟩🟩🟩⬜ ${uz.stgReady}`);
    expect(block).not.toContain(`${uz.msReady} · `);
  });

  it('a split lot draws the bar for its bulk and one line per group', () => {
    const block = htmlToPlain(
      lotBlock(
        lot({
          groups: [
            { stage: 'cn_warehouse', n: 6, transit: null },
            { stage: 'cn_transit', n: 4, transit: road('2026-09-29T12:00:00Z', '2026-09-30T12:00:00Z') },
          ],
        }),
        'uz',
      ),
    );
    expect(block).toContain(`🟩⬜⬜⬜⬜ ${uz.msChina}`);
    expect(block).toContain(`• 6 quti — ${uz.stgCn_warehouse}`);
    expect(block).toContain(`• 4 quti — ${uz.stgCn_transit}`);
    expect(block).toContain('🗓 Yetib borishi (Tashkent 1)');
    expect(block).toContain(`10 quti · 40 kg · 0.35 m³ · 📍 Yiwu`);
  });

  it('counts boxes in the reader’s plural and groups thousands with a no-break space', () => {
    const block = htmlToPlain(
      lotBlock(lot({ groups: [{ stage: 'ready', n: 3, transit: null }], weightKg: 12845.5 }), 'ru'),
    );
    expect(block).toContain('3 коробки');
    expect(block).toContain(`12${NBSP}845.5 кг`);
  });

  it('puts the cargo nearest the customer first, then by letter (Z before AA)', () => {
    const ordered = orderLotsForBot([
      lot({ letter: 'A', lotId: 'china' }),
      lot({ letter: 'AA', lotId: 'ready-aa', groups: [{ stage: 'ready', n: 1, transit: null }] }),
      lot({ letter: 'Z', lotId: 'ready-z', groups: [{ stage: 'ready', n: 1, transit: null }] }),
      lot({ letter: 'B', lotId: 'transit', groups: [{ stage: 'hub', n: 1, transit: null }] }),
    ]);
    expect(ordered.map((l) => l.lotId)).toEqual(['ready-z', 'ready-aa', 'transit', 'china']);
  });

  it('a big customer gets several messages, every lot whole and none lost', () => {
    const lots = Array.from({ length: 80 }, (_, i) =>
      lot({ letter: `L${i}`, lotId: `l${i}`, productNameRu: `Tovar raqami ${i} — ${'x'.repeat(40)}` }),
    );
    const messages = cargoMessages({ clientCode: 'GS1', name: 'Katta mijoz' }, lots, 'uz');
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(visibleLength(m)).toBeLessThanOrEqual(3800);
    const all = messages.map(htmlToPlain).join('\n');
    for (let i = 0; i < 80; i += 1) {
      expect(all.split(`L${i} · Tovar raqami ${i} —`).length - 1, `lot ${i}`).toBe(1);
    }
    expect(htmlToPlain(messages[0]!)).toMatch(/^📦 GS1 — Katta mijoz/);
  });

  it('an empty cabinet says so in one line', () => {
    expect(htmlToPlain(cargoMessages({ clientCode: 'GS9', name: 'X' }, [], 'uz')[0]!)).toBe(`📦 GS9 — ${uz.noCargo}`);
  });
});

describe('the 📷 buttons', () => {
  it('letter AND product, newest receipt first, twelve at most, two to a row (CX-12)', () => {
    const lots = Array.from({ length: 14 }, (_, i) =>
      lot({
        lotId: `p${i}`,
        letter: 'A',
        productNameRu: `Tovar ${i}`,
        hasPhotos: true,
        journey: [{ key: 'received', atIso: new Date(Date.UTC(2026, 8, 1 + i)).toISOString() }],
      }),
    );
    lots.push(lot({ lotId: 'nophoto', hasPhotos: false, journey: [{ key: 'received', atIso: '2027-01-01T00:00:00Z' }] }));
    const rows = photoButtonRows(lots);
    const buttons = rows.flat();
    expect(buttons).toHaveLength(MAX_PHOTO_BUTTONS);
    expect(rows.every((r) => r.length <= 2)).toBe(true);
    expect(buttons[0]).toEqual({ text: '📷 A · Tovar 13', callback_data: 'ph:p13' });
    expect(buttons.map((b) => b.callback_data)).not.toContain('ph:nophoto');
    expect(buttons.map((b) => b.callback_data)).not.toContain('ph:p0');
  });

  it('a long name is cut to a button Telegram will take', () => {
    const button = photoButtonRows([lot({ hasPhotos: true, productNameRu: 'y'.repeat(200) })])[0]![0]!;
    expect(button.text.length).toBeLessThanOrEqual(40);
    expect(button.text.startsWith('📷 A · ')).toBe(true);
  });

  it('says what the photos are, on the first one', () => {
    expect(photoCaption({ clientCode: 'GS777', letter: 'A', name: 'Kurtka <x>', boxes: 120 }, 'uz')).toBe(
      '<b>GS777 · A</b> · Kurtka &lt;x&gt; · 120 quti',
    );
  });

  it('sends the thumbnail, an original only when Telegram will take it', () => {
    expect(photoSource({ storageKey: 'o.jpg', thumb800Key: 't.jpg', contentType: 'image/png', sizeBytes: 50e6 })).toEqual({
      key: 't.jpg',
      contentType: 'image/jpeg',
    });
    expect(photoSource({ storageKey: 'o.jpg', thumb800Key: null, contentType: 'image/jpeg', sizeBytes: 2e6 })).toEqual({
      key: 'o.jpg',
      contentType: 'image/jpeg',
    });
    expect(photoSource({ storageKey: 'o.jpg', thumb800Key: null, contentType: 'image/jpeg', sizeBytes: 11 * 1024 * 1024 })).toBeNull();
    expect(photoSource({ storageKey: 'o.pdf', thumb800Key: null, contentType: 'application/pdf', sizeBytes: 10 })).toBeNull();
  });
});

describe('the balance', () => {
  const debt = (balanceUsd: number, recent: DebtSummary['recent'] = []): DebtSummary => ({ balanceUsd, recent });

  it('the total is what the owing codes owe — never netted against another code’s credit (CX-6)', () => {
    const [msg] = balanceMessages(
      [
        { clientCode: 'GS777', debt: debt(1250) },
        { clientCode: 'GS555', debt: debt(-300) },
        { clientCode: 'GS444', debt: debt(100) },
      ],
      'uz',
    );
    const text = htmlToPlain(msg!);
    expect(text.split('\n')[0]).toBe(`💰 ${uz.balanceTotal}: $1${NBSP}350.00`);
    // Each code still tells its own truth, the credit included.
    expect(text).toContain(`GS555 — ${uz.debtNo} (${uz.credit} $300.00)`);
    expect(text).toContain(`GS777 — ${uz.debtYes}: $1${NBSP}250.00`);
  });

  it('«ortiqcha» leads only when no code owes', () => {
    const text = htmlToPlain(
      balanceMessages([{ clientCode: 'A1', debt: debt(-50) }, { clientCode: 'A2', debt: debt(0) }], 'uz')[0]!,
    );
    expect(text.split('\n')[0]).toBe(`✅ Qarzingiz yo‘q · ${uz.credit} $50.00`);
  });

  it('one code, no total line; rows dated as people read them, grouped, with the dollar figure', () => {
    const text = htmlToPlain(
      balanceMessages(
        [
          {
            clientCode: 'GS1',
            debt: debt(250, [
              { type: 'charge', amount: 250, currency: 'USD', amountUsd: 250, txDate: '2026-09-20', voided: false },
              { type: 'payment', amount: 3150000, currency: 'UZS', amountUsd: 250, txDate: '2026-09-18', voided: false },
              { type: 'payment', amount: 999, currency: 'USD', amountUsd: 999, txDate: '2026-09-17', voided: true },
              { type: 'fx_diff', amount: 1, currency: 'USD', amountUsd: 1, txDate: '2026-09-16', voided: false },
            ]),
          },
        ],
        'uz',
      )[0]!,
    );
    expect(text.startsWith('💰 GS1')).toBe(true);
    expect(text).toContain(`20.09.2026 · ${uz.charged} · 250 USD`);
    expect(text).toContain(`18.09.2026 · ${uz.paid} · +3${NBSP}150${NBSP}000 UZS (≈ $250.00)`);
    expect(text).not.toContain('999');
    expect(text).not.toContain('2026-09');
  });
});

describe('the history', () => {
  it('is HTML with escaped names, and says so when there is nothing', () => {
    expect(htmlToPlain(historyMessages('GS1', [], [], 'uz')[0]!)).toBe(`🗄 GS1 — ${uz.noHistory}`);
    const [msg] = historyMessages(
      'GS1',
      [
        {
          id: 'h1',
          issuedAt: '2026-09-20T06:00:00.000Z',
          place: 'Tashkent 1',
          receiver: 'Aziz <aka>',
          issuedBy: 'Sklad hodimi',
          lots: [
            {
              lotId: 'l1',
              letter: 'D',
              productNameZh: '碗',
              productNameRu: 'Посуда',
              receivedAt: '2026-08-01T06:00:00.000Z',
              n: 6,
              weightKg: 48,
              volumeM3: 0.6,
              photoCount: 0,
            },
          ],
          legs: [
            {
              batchCode: 'YW-017',
              fromPlace: 'Yiwu',
              toPlace: 'Kashgar',
              domestic: true,
              departedAt: '2026-08-03T06:00:00.000Z',
              arrivedAt: null,
              n: 6,
            },
          ],
        },
      ],
      [{ txDate: '2026-09-18', amount: 1300, currency: 'USD' }],
      'uz',
    );
    expect(msg).toContain('Aziz &lt;aka&gt;');
    const text = htmlToPlain(msg!);
    expect(text).toContain('🤝 20.09.2026 · Tashkent 1');
    expect(text).toContain('📦 D · Посуда — 6 quti · 48 kg · 0.6 m³');
    expect(text).toContain(`🚚 ${uz.batchWord} YW-017 (${uz.legDomestic}) Yiwu → Kashgar: ${uz.legDeparted} 03.08.2026`);
    expect(text).toContain(`18.09.2026 · +1${NBSP}300 USD`);
  });
});

describe('who to write to', () => {
  const dilnoza = { name: 'Dilnoza <D>', phone: '+998901234567', telegramUrl: 'https://t.me/dilnoza' };

  it('one card per PERSON across the chat’s codes, the office for the rest', () => {
    const cards = managerCards(
      [
        { clientCode: 'GS777', manager: dilnoza },
        { clientCode: 'GS555', manager: { ...dilnoza } },
        { clientCode: 'GS444', manager: null },
      ],
      { name: 'GSR LOGISTICS', phone: '+998712000000' },
      'uz',
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]!.html).toContain('Dilnoza &lt;D&gt;');
    const first = htmlToPlain(cards[0]!.html);
    expect(first).toContain(`👤 Dilnoza <D> — ${uz.managerTitle}`);
    expect(first).toContain('📞 +998 90 123 45 67');
    expect(first).toContain('🏷 GS777, GS555');
    expect(cards[0]!.url).toBe('https://t.me/dilnoza');
    const office = htmlToPlain(cards[1]!.html);
    expect(office).toContain(`🏢 ${uz.officeTitle} · GSR LOGISTICS`);
    expect(office).toContain('🏷 GS444');
    // Never «no manager has been assigned» — what is TRUE is that writing here
    // reaches a person (CX-1).
    expect(office).toContain(uz.managerNone);
    expect(cards[1]!.url).toBeNull();
  });

  it('offers a button only to a Telegram address', () => {
    const [card] = managerCards(
      [{ clientCode: 'GS1', manager: { name: 'M', phone: null, telegramUrl: 'tg://resolve?domain=x' } }],
      { name: 'GSR', phone: null },
      'uz',
    );
    expect(card!.url).toBeNull();
    expect(htmlToPlain(card!.html)).not.toContain('📞');
  });

  it('prints an Uzbek number the way people say it, anything else as typed', () => {
    expect(prettyPhone('+998901234567')).toBe('+998 90 123 45 67');
    expect(prettyPhone('901234567')).toBe('+998 90 123 45 67');
    expect(prettyPhone('+86 138 0013 8000')).toBe('+86 138 0013 8000');
  });
});

describe('the greeting', () => {
  it('uses Telegram’s own first name, escaped — and no greeting at all without one', () => {
    expect(startGreetingHtml({ codes: ['GS777', 'GS555'], firstName: 'Ali <x>', locale: 'uz' })).toBe(
      `👋 <b>Assalomu alaykum, Ali &lt;x&gt;!</b>\n${uz.yourCodes}: <b>GS777</b>, <b>GS555</b>`,
    );
    expect(htmlToPlain(startGreetingHtml({ codes: ['GS1'], firstName: '  ', locale: 'uz' }))).toBe(
      `${uz.yourCodes}: GS1`,
    );
    expect(htmlToPlain(startGreetingHtml({ codes: ['GS1'], staffName: 'Bekzod', firstName: 'B', locale: 'uz' }))).toBe(
      `👋 Bekzod\n${uz.yourCodes}: GS1`,
    );
  });
});

describe('the staff copy of a customer’s words', () => {
  it('is plain, quotes at most 700 characters, and ends with the card link', () => {
    const text = forwardStaffText({
      codes: ['GS777', 'GS555'],
      name: 'Alisher <aka>',
      text: 'q'.repeat(900),
      media: false,
      cardUrl: 'https://gsrwms.uz/admin/clients/x',
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('💬 GS777, GS555 (Alisher <aka>) botga yozdi:');
    expect(lines[1]!.length).toBe(702);
    expect(lines[1]!.endsWith('…»')).toBe(true);
    expect(lines.at(-1)).toBe('https://gsrwms.uz/admin/clients/x');
  });

  it('a file is announced, with its caption when there is one', () => {
    expect(forwardStaffText({ codes: ['GS1'], name: null, text: null, media: true, cardUrl: null })).toBe(
      '📎 GS1 botga fayl yubordi',
    );
    expect(forwardStaffText({ codes: ['GS1'], name: 'A', text: 'singan', media: true, cardUrl: null })).toBe(
      '📎 GS1 (A) botga fayl yubordi:\n«singan»',
    );
  });
});

describe('the customer is told the TRUTH about a message over the limit (round C review, CONV-1)', () => {
  it('«not passed on», in their language — never «delivered»', () => {
    for (const loc of ['uz', 'ru', 'en'] as const) {
      const html = throttledHtml(loc);
      expect(html).toContain(clientLabels(loc).msgThrottled.slice(0, 20));
      expect(html).not.toContain('✅');
    }
  });
});
