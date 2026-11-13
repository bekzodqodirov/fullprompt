import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notificationLabels } from '@/modules/platform/notifications/labels';
import { FOUNDERS } from '@/modules/platform/notifications/mutes';
import {
  alertOfDealState,
  arrivalAlertOf,
  arrivalOpensDealPicker,
  arrivalTotals,
  ARRIVAL_LOTS_SHOWN,
  isReceiptArrival,
  receiptArrivalText,
  RECEIPT_DEAL_ANCHOR,
  RECEIPT_DEAL_STATES,
} from '@/modules/platform/notifications/receipt-arrival';
import { composeStaffMessage, renderTelegramText, rowTypeFor } from '@/modules/platform/notifications/service';
import { receiptFilesKeyboard, receiptFilesReopenKeyboard } from '@/modules/platform/telegram/receipt-files';
import { buttonsFor, parseCallback, PRESS_REPEAT } from '@/modules/platform/telegram/staff-bot';

/**
 * «Prixod keldi» — the ONE message a prixod's seller gets, with its two
 * buttons (the owner, 2026-11-11: «prixod kelganda bitim tuzilmagan va prixod
 * keldi deb 2 marta sms boryabti … prixod keldi desin sotuvchiga klient
 * karobka soni tovar nomlari kg kub shunda ikta button bolsin file qoshish va
 * bitim biriktirish»; docs/PRIXOD-XABARI.md §C).
 *
 * Pure: the words, which row is the new message, which alarm it stands for,
 * the mute rule of a row that carries two messages' worth, and the buttons.
 * Who receives what — against real rows and real mute lists — is the
 * integration file's.
 */

const ID = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const LOT_A = { letter: 'A', productNameZh: '键盘', productNameRu: 'Klaviatura', boxCount: 50, totalWeightKg: 200.125, totalVolumeM3: 1.5 };
const LOT_B = { letter: 'B', productNameZh: '鼠标', productNameRu: 'Sichqoncha', boxCount: 50, totalWeightKg: 100, totalVolumeM3: 0.8004 };
const BASE = {
  receiptId: ID,
  number: 'YW-000123',
  warehouseCode: 'YW',
  clientId: 'c-1',
  clientCode: 'GS777',
  clientName: 'Ali Valiyev',
  lots: [LOT_A, LOT_B],
};
const uz = notificationLabels('uz');

const savedUrl = process.env.APP_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedUrl;
});

describe('the message', () => {
  it('a deal-less prixod, whole — his own words, the goods, the count, kg and kub, the link last and alone', () => {
    const text = receiptArrivalText({ ...BASE, dealState: 'none' }, uz, 'https://gsrwms.uz');
    expect(text).toBe(
      [
        '📥 Prixod keldi — YW-000123',
        'Mijoz: GS777 (Ali Valiyev)',
        '⚠️ Narxlangan bitimi yo‘q — narxlatib qo‘ying',
        'Sklad: YW',
        '',
        'A — 键盘 (Klaviatura): 50 kor., 200.13 kg, 1.5 m³',
        'B — 鼠标 (Sichqoncha): 50 kor., 100 kg, 0.8 m³',
        'Jami: 100 kor. · 300.13 kg · 2.3 m³',
        '',
        `https://gsrwms.uz/receipts/${ID}#bitim`,
      ].join('\n'),
    );
  });

  it('the deal line follows the state, and only a prixod with no deal of its own opens at the picker', () => {
    const at = (payload: Record<string, unknown>) => receiptArrivalText({ ...BASE, ...payload }, uz, 'https://x.uz').split('\n');
    const attachable = at({ dealState: 'attachable', openDealCodes: ['B-000012', 'B-000015'] });
    expect(attachable[2]).toBe('📎 Bitimga biriktirilmagan — biriktirib qo‘ying');
    expect(attachable[3]).toBe('Ochiq bitimlar: B-000012, B-000015');
    expect(attachable.at(-1)).toBe(`https://x.uz/receipts/${ID}#${RECEIPT_DEAL_ANCHOR}`);

    const unpriced = at({ dealState: 'unpriced', dealCode: 'B-000012' });
    expect(unpriced[2]).toBe('💰 B-000012 bitimida narx yo‘q — narx qo‘ying');
    expect(unpriced.at(-1)).toBe(`https://x.uz/receipts/${ID}`);

    const priced = at({ dealState: 'priced', dealCode: 'B-000012' });
    expect(priced[2]).toBe('🔗 Bitim: B-000012');
    expect(priced.at(-1)).toBe(`https://x.uz/receipts/${ID}`);
  });

  it('the claim door says «biriktirildi», never «keldi» — cargo given its owner may have come weeks ago', () => {
    const text = receiptArrivalText({ ...BASE, dealState: 'none', via: 'assign' }, uz, '');
    expect(text.split('\n')[0]).toBe('📥 Prixod mijozga biriktirildi — YW-000123');
    expect(text).not.toContain('keldi');
  });

  it('«Jami» is what a person adding the printed lines gets — and is not drawn for one lot', () => {
    const lots = [
      { ...LOT_A, totalVolumeM3: 0.3336, totalWeightKg: 12.004 },
      { ...LOT_B, totalVolumeM3: 0.3336, totalWeightKg: 0.446 },
    ];
    const text = receiptArrivalText({ ...BASE, lots, dealState: 'priced', dealCode: 'B-1' }, uz, '');
    // Each line rounds as the customer's push does (kg 2, m³ 3)…
    expect(text).toContain('12 kg, 0.334 m³');
    expect(text).toContain('0.45 kg, 0.334 m³');
    // …and the total is the lines' own sum, not the raw sum rounded (0.667).
    expect(text).toContain('Jami: 100 kor. · 12.45 kg · 0.668 m³');
    expect(arrivalTotals(lots)).toEqual({ boxCount: 100, weightKg: 12.45, volumeM3: 0.668 });

    expect(receiptArrivalText({ ...BASE, lots: [LOT_A], dealState: 'none' }, uz, '')).not.toContain('Jami');
  });

  it(`a prixod of forty goods lists ${ARRIVAL_LOTS_SHOWN} and counts the rest`, () => {
    const lots = Array.from({ length: 40 }, (_, i) => ({ ...LOT_A, letter: `L${i}` }));
    const lines = receiptArrivalText({ ...BASE, lots, dealState: 'none' }, uz, '').split('\n');
    expect(lines.filter((line) => line.startsWith('L'))).toHaveLength(ARRIVAL_LOTS_SHOWN);
    expect(lines).toContain('… yana 28 ta');
    expect(lines.find((line) => line.startsWith('Jami'))).toContain('2000 kor.');
  });

  it('in the reader’s language', () => {
    const ru = receiptArrivalText({ ...BASE, dealState: 'none' }, notificationLabels('ru'), '');
    expect(ru).toContain('📥 Приход поступил — YW-000123');
    expect(ru).toContain('⚠️ Нет сделки с ценой — назначьте цену');
    expect(ru).toContain('Итого: 100 кор.');
  });
});

describe('which row is the new message — one predicate', () => {
  it('a payload with a deal state, under any of its three types; nothing else', () => {
    for (const state of RECEIPT_DEAL_STATES) {
      expect(isReceiptArrival('ReceiptConfirmed', { dealState: state })).toBe(true);
      expect(isReceiptArrival('UnquotedCargo', { dealState: state })).toBe(true);
      expect(isReceiptArrival('UnlinkedCargo', { dealState: state })).toBe(true);
    }
    expect(isReceiptArrival('ReceiptConfirmed', { ...BASE })).toBe(false);
    expect(isReceiptArrival('ReceiptConfirmed', { dealState: 'folded' })).toBe(false);
    expect(isReceiptArrival('DealDeviation', { dealState: 'none' })).toBe(false);
  });

  it('a row written before the fold renders exactly as it did — the prixod and both alarms', () => {
    // No `dealState`: the years of stored rows (#688). The marker test pins
    // their words; here, that the new renderer does not touch them.
    const old = renderTelegramText('ReceiptConfirmed', { ...BASE, dealLinked: false, openDealCodes: [] }, 'uz');
    expect(old.split('\n')[0]).toBe('📥 Prixod YW-000123');
    expect(old).toContain('⚠️ Bitimi yo‘q — narxlatib qo‘ying');
    const alarm = renderTelegramText('UnquotedCargo', { ...BASE, volumeM3: 1.4, weightKg: 180, boxCount: 10 }, 'uz');
    expect(alarm.split('\n')[0]).toBe('💰❓ Narxi kelishilmagan yuk — YW-000123');
  });

  it('the admins’ copy — typed as the alarm — is the same message, with the client on it', () => {
    const text = renderTelegramText('UnquotedCargo', { ...BASE, dealState: 'none' }, 'uz');
    expect(text.split('\n')[0]).toBe('📥 Prixod keldi — YW-000123');
    expect(text).toContain('Mijoz: GS777 (Ali Valiyev)');
    expect(text).not.toContain('undefined');
  });
});

describe('the alarm a prixod stands for', () => {
  it('one per state — and none for a priced prixod', () => {
    expect(alertOfDealState('none')).toBe('UnquotedCargo');
    expect(alertOfDealState('attachable')).toBe('UnlinkedCargo');
    expect(alertOfDealState('unpriced')).toBe('UnquotedCargo');
    expect(alertOfDealState('priced')).toBeNull();
  });

  it('folded into the confirm’s event only: never an old event, never the claim door', () => {
    expect(arrivalAlertOf({ dealState: 'none' })).toBe('UnquotedCargo');
    expect(arrivalAlertOf({ dealState: 'attachable' })).toBe('UnlinkedCargo');
    expect(arrivalAlertOf({ dealState: 'priced' })).toBeNull();
    expect(arrivalAlertOf({ dealLinked: false })).toBeNull();
    // The claim door has never run price control and emits no alert event.
    expect(arrivalAlertOf({ dealState: 'none', via: 'assign' })).toBeNull();
  });
});

describe('a row that carries two messages’ worth is silenced only by somebody who muted both', () => {
  const both = { type: 'ReceiptConfirmed', alsoType: 'UnquotedCargo' };
  const operations = [...FOUNDERS.operations];
  const alerts = [...FOUNDERS.alerts];

  it('nothing muted: the prixod', () => {
    expect(rowTypeFor([], both)).toEqual({ type: 'ReceiptConfirmed', muted: false });
    expect(rowTypeFor(null, both)).toEqual({ type: 'ReceiptConfirmed', muted: false });
  });
  it('«Operatsiya xabarlari» ticked, the alarms kept: still heard, typed as the alarm it is', () => {
    expect(rowTypeFor(operations, both)).toEqual({ type: 'UnquotedCargo', muted: false });
  });
  it('the alarms ticked, operations kept: still hears every prixod', () => {
    expect(rowTypeFor(alerts, both)).toEqual({ type: 'ReceiptConfirmed', muted: false });
  });
  it('both ticked, or «all»: silent', () => {
    expect(rowTypeFor([...operations, ...alerts], both)).toEqual({ type: 'ReceiptConfirmed', muted: true });
    expect(rowTypeFor(['all'], both)).toEqual({ type: 'ReceiptConfirmed', muted: true });
  });
  it('an ordinary row is its own type and its own mute, as it always was', () => {
    expect(rowTypeFor(operations, { type: 'ReceiptConfirmed' })).toEqual({ type: 'ReceiptConfirmed', muted: true });
    expect(rowTypeFor(alerts, { type: 'ReceiptConfirmed' })).toEqual({ type: 'ReceiptConfirmed', muted: false });
  });
});

describe('the two buttons', () => {
  it('«📎 Fayl qo‘shish» on every new row, under any of its types — lowercased, the one shape the parser takes', () => {
    for (const type of ['ReceiptConfirmed', 'UnquotedCargo', 'UnlinkedCargo']) {
      const rows = buttonsFor(type, { dealState: 'none', receiptId: ID.toUpperCase() });
      expect(rows).toEqual([[{ text: '📎 Fayl qo‘shish', callback_data: `pf:${ID}` }]]);
      const drawn = rows![0]![0] as { callback_data: string };
      expect(parseCallback(drawn.callback_data)).toEqual({ kind: 'receipt_files', receiptId: ID });
    }
    // The claim door's row too: its seller needs the papers as much.
    expect(buttonsFor('ReceiptConfirmed', { dealState: 'attachable', via: 'assign', receiptId: ID })).not.toBeNull();
  });

  it('a prixod message from before the fold keeps the keyboard it never had', () => {
    expect(buttonsFor('ReceiptConfirmed', { receiptId: ID })).toBeNull();
    expect(buttonsFor('UnquotedCargo', { receiptId: ID })).toBeNull();
    expect(buttonsFor('ReceiptConfirmed', { dealState: 'none', receiptId: 'r-1' })).toBeNull();
  });

  it('«🔗 Bitim biriktirish» is the card link, lifted — only where there is a deal to attach', () => {
    process.env.APP_URL = 'https://gsrwms.uz';
    const none = composeStaffMessage('ReceiptConfirmed', { ...BASE, dealState: 'none' }, 'uz');
    expect(none.urlRow).toEqual([{ text: '🔗 Bitim biriktirish', url: `https://gsrwms.uz/receipts/${ID}#bitim` }]);
    expect(none.html).not.toContain('https://');
    // The admins' copy, typed as the alarm, carries the same button.
    expect(composeStaffMessage('UnlinkedCargo', { ...BASE, dealState: 'attachable', openDealCodes: ['B-1'] }, 'ru').urlRow).toEqual([
      { text: '🔗 Привязать сделку', url: `https://gsrwms.uz/receipts/${ID}#bitim` },
    ]);
    const priced = composeStaffMessage('ReceiptConfirmed', { ...BASE, dealState: 'priced', dealCode: 'B-1' }, 'uz');
    expect(priced.urlRow).toEqual([{ text: '↗️ Ochish', url: `https://gsrwms.uz/receipts/${ID}` }]);
    const old = composeStaffMessage('ReceiptConfirmed', { ...BASE }, 'uz');
    expect(old.urlRow).toEqual([{ text: '↗️ Ochish', url: `https://gsrwms.uz/receipts/${ID}` }]);
    expect(arrivalOpensDealPicker('ReceiptConfirmed', { dealState: 'unpriced' })).toBe(false);
  });

  it('where the link cannot be a button it stays in the text, so the prixod is still one tap away', () => {
    process.env.APP_URL = 'http://localhost:3000';
    const message = composeStaffMessage('ReceiptConfirmed', { ...BASE, dealState: 'none' }, 'uz');
    expect(message.urlRow).toBeNull();
    expect(message.html).toContain(`http://localhost:3000/receipts/${ID}#bitim`);
  });
});

describe('the collection’s own buttons', () => {
  it('every callback the keyboards draw is one the parser takes (#939), and each press is classed', () => {
    const drawn = [
      ...receiptFilesKeyboard({ receiptId: ID.toUpperCase(), files: [{}] }).inline_keyboard.flat(),
      ...receiptFilesReopenKeyboard({ receiptId: ID.toUpperCase(), number: 'YW-000123' }).inline_keyboard.flat(),
    ].map((button) => button.callback_data);
    expect(drawn).toEqual([`pf:ok:${ID}`, `pf:no:${ID}`, `pf:${ID}`]);
    expect(drawn.map((data) => parseCallback(data))).toEqual([
      { kind: 'receipt_files_done', receiptId: ID },
      { kind: 'receipt_files_cancel', receiptId: ID },
      { kind: 'receipt_files', receiptId: ID },
    ]);
    for (const data of drawn) expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(PRESS_REPEAT.receipt_files).toBe('prompt');
    expect(PRESS_REPEAT.receipt_files_done).toBe('cas');
    expect(PRESS_REPEAT.receipt_files_cancel).toBe('cas');
  });

  it('«↩️ Bekor qilish» only once there is something to take back', () => {
    expect(receiptFilesKeyboard({ receiptId: ID, files: [] }).inline_keyboard).toHaveLength(1);
    expect(receiptFilesKeyboard({ receiptId: ID, files: [{}] }).inline_keyboard).toHaveLength(2);
  });

  it('a press the parser must refuse: no prixod named, or a shape nothing draws', () => {
    for (const data of ['pf:ok', 'pf:no', `pf:${ID.toUpperCase()}`, `pf:xx:${ID}`, 'pf:']) {
      expect(parseCallback(data)).toBeNull();
    }
  });
});

describe('a wait kind has three homes, and the table refuses the one that is forgotten', () => {
  // Durable writes are off in almost every test, so memory serves and all is
  // green while production logs one warning and the collection stops
  // surviving a deploy. Derived: the union's own members, against the newest
  // migration that re-makes the CHECK and against the schema's mirror.
  const root = path.resolve(__dirname, '../..');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
  const union = read('src/modules/platform/telegram/waits.ts');
  const body = union.slice(union.indexOf('export type WaitKind ='), union.indexOf('/** Unix SECONDS'));
  const kinds = [...body.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]!);

  it('reads the union', () => {
    expect(kinds).toContain('task');
    expect(kinds).toContain('receipt_files');
    expect(kinds.length).toBeGreaterThanOrEqual(9);
  });

  it('the newest migration that re-makes the CHECK lists every kind', () => {
    const dir = 'src/modules/platform/db/migrations';
    const last = readdirSync(path.join(root, dir))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .filter((name) => /ADD CONSTRAINT "telegram_chat_waits_kind_check"/.test(read(`${dir}/${name}`)))
      .at(-1)!;
    const sql = read(`${dir}/${last}`);
    const check = sql.slice(sql.indexOf('ADD CONSTRAINT "telegram_chat_waits_kind_check"'));
    const listed = [...check.slice(0, check.indexOf(');')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...listed].sort()).toEqual([...kinds].sort());
  });

  it('…and so does the schema’s mirror', () => {
    const schema = read('src/modules/platform/db/schema/platform.ts');
    const line = schema.split('\n').find((l) => l.includes("check('telegram_chat_waits_kind_check'"))!;
    const listed = [...line.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).filter((name) => name !== 'telegram_chat_waits_kind_check');
    expect([...listed].sort()).toEqual([...kinds].sort());
  });
});
