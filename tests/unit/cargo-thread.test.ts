import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_MATRIX, WAREHOUSE_SCOPED_ROLES, type RoleCode } from '@/modules/platform/rbac/catalog';
import { inScope } from '@/modules/platform/rbac/scope';
import { fillVars, notificationLabels, textLocaleOf } from '@/modules/platform/notifications/labels';
import { composeStaffMessage } from '@/modules/platform/notifications/service';
import { takeOwnLink } from '@/modules/platform/notifications/staff-html';
import { THREAD_KINDS, idsByKind } from '@/modules/platform/notifications/thread-ref';
import { REPLY_SENTENCES, mediaSentenceFor } from '@/modules/platform/telegram/reply-door';
import { THREAD_REPLY_BUTTON, buttonsFor } from '@/modules/platform/telegram/staff-bot';
import { mayOpenBatchCard } from '@/modules/wms/batches/card-door';
import { cargoNowLine, writesFromStanding } from '@/modules/wms/crm/cargo-thread';
import { threadPingText } from '@/modules/wms/crm/internal-chat';
import { isThreadWriteBehind } from '@/modules/wms/crm/thread';
import { cargoThreadDoorOf, mayHaveThreads, type ThreadReader } from '@/modules/wms/crm/thread-door';
import {
  roadWordOf,
  standOf,
  truckStageOf,
  truckStand,
  truckWordOf,
  type CargoStand,
} from '@/modules/wms/inventory/stands';

/**
 * The cargo threads' pure half (round 2, 0129 — the owner's E6 c warehouse
 * half, E7 b, Q4 a): where a truck's cargo stands and how it is spoken of,
 * the cargo door over EVERY seeded role, who a writer writes FROM, the ONE
 * place line in two languages, the ping's frame, the frame's buttons, the
 * half-applied deploy's error rule, the id grouping, the dock tab and the
 * media sentence. Each block names the edit that turns it red.
 */

const YW = '00000000-0000-4000-8000-0000000000a1';
const TAS1 = '00000000-0000-4000-8000-0000000000a2';
const AND = '00000000-0000-4000-8000-0000000000a3';
const KA = '00000000-0000-4000-8000-0000000000a4';
const ME = '00000000-0000-4000-8000-000000000001';
const CODES = new Map([
  [YW, 'YW'],
  [TAS1, 'TAS1'],
  [AND, 'AND'],
  [KA, 'KA'],
]);

const STATUSES = ['forming', 'loading', 'in_transit', 'arrived', 'unloaded', 'closed', 'cancelled'] as const;
const truck = (status: string) => ({ status, originWarehouseId: YW, destWarehouseId: TAS1 });

describe('1. a truck’s audience stage — over every status of the CHECK × aboard', () => {
  it('forming/loading/cancelled → origin; in transit → both; arrived/unloaded/closed → both while aboard, else dest', () => {
    const expected: Record<string, [string[], string[]]> = {
      forming: [[YW], [YW]],
      loading: [[YW], [YW]],
      cancelled: [[YW], [YW]],
      in_transit: [[YW, TAS1], [YW, TAS1]],
      arrived: [[TAS1], [YW, TAS1]],
      unloaded: [[TAS1], [YW, TAS1]],
      closed: [[TAS1], [YW, TAS1]],
    };
    for (const status of STATUSES) {
      const [at0, at3] = expected[status]!;
      expect(truckStand(truck(status), 0).warehouseIds, `${status} aboard 0`).toEqual(at0);
      expect(truckStand(truck(status), 3).warehouseIds, `${status} aboard 3`).toEqual(at3);
      for (const aboard of [0, 3]) {
        for (const w of truckStand(truck(status), aboard).warehouseIds) expect([YW, TAS1]).toContain(w);
      }
    }
    expect(truckStageOf('whatever', 3)).toBeNull();
    expect(truckStand(truck('whatever'), 3)).toEqual({ warehouseIds: [], places: [] });
  });
});

describe('2. a truck’s WORDS — a separate answer from its audience', () => {
  it('loading, cancelled, road, unloading/arrived, missing/arrived — and a carton’s road word by its truck', () => {
    expect(truckWordOf('forming', 0)).toBe('loading');
    expect(truckWordOf('loading', 3)).toBe('loading');
    expect(truckWordOf('cancelled', 0)).toBe('cancelled');
    expect(truckWordOf('in_transit', 3)).toBe('road');
    expect(truckWordOf('arrived', 3)).toBe('unloading');
    expect(truckWordOf('arrived', 0)).toBe('arrived');
    expect(truckWordOf('unloaded', 3)).toBe('missing');
    expect(truckWordOf('closed', 3)).toBe('missing');
    expect(truckWordOf('unloaded', 0)).toBe('arrived');
    expect(truckWordOf('closed', 0)).toBe('arrived');
    expect(truckWordOf('whatever', 0)).toBeNull();
    expect(roadWordOf('in_transit')).toBe('road');
    expect(roadWordOf('arrived')).toBe('unloading');
    expect(roadWordOf('unloaded')).toBe('missing');
    expect(roadWordOf('closed')).toBe('missing');
  });
});

/** A role as a thread reader: the seeded grants and the seeded scope, at the warehouses given. */
function reader(role: RoleCode, warehouseIds: string[] = [YW]): ThreadReader {
  const scoped = WAREHOUSE_SCOPED_ROLES.includes(role);
  return { id: ME, permissions: new Set<string>(ROLE_MATRIX[role]), warehouseScoped: scoped, warehouseIds: scoped ? warehouseIds : [] };
}

/** The five cards, each with its receiving warehouse and its stand stated. */
type Card = { kind: 'receipt'; receiving: string; stands: string[] } | { kind: 'batch'; origin: string; dest: string; stands: string[] };
const CARDS: Record<string, Card> = {
  R1: { kind: 'receipt', receiving: YW, stands: [YW] },
  R2: { kind: 'receipt', receiving: YW, stands: [TAS1] },
  R3: { kind: 'receipt', receiving: TAS1, stands: [TAS1] },
  T1: { kind: 'batch', origin: YW, dest: TAS1, stands: [YW, TAS1] },
  T2: { kind: 'batch', origin: YW, dest: TAS1, stands: [TAS1] },
};

/**
 * The card's own door, from its REAL rule: a truck by `mayOpenBatchCard`; a
 * prixod by the receiving warehouse (read-door.ts) or a carton standing at
 * one of the reader's warehouses (the shelf half of near.ts) — true for the
 * unscoped.
 */
function cardDoorOf(actor: ThreadReader, card: Card): boolean {
  if (card.kind === 'batch') return mayOpenBatchCard(actor, { originWarehouseId: card.origin, destWarehouseId: card.dest });
  return inScope(actor, card.receiving) || card.stands.some((w) => actor.warehouseIds.includes(w));
}

function rowOf(actor: ThreadReader, cards: Record<string, Card> = CARDS): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(cards).map(([name, card]) => [
      name,
      cargoThreadDoorOf(actor, { stands: card.stands, cardDoor: cardDoorOf(actor, card) }),
    ]),
  );
}

const none = { R1: false, R2: false, R3: false, T1: false, T2: false };
const all = { R1: true, R2: true, R3: true, T1: true, T2: true };

describe('3. the cargo door over EVERY seeded role (E7 b)', () => {
  it('the office — logist, admin, super_admin — reads every cargo thread', () => {
    for (const role of ['logist', 'admin', 'super_admin'] as RoleCode[]) expect(rowOf(reader(role)), role).toEqual(all);
  });

  it('the YW staff read exactly where the cargo stands at YW — never the prixod it received that left, never the truck that arrived', () => {
    for (const role of ['warehouse_manager', 'warehouse_operator'] as RoleCode[]) {
      expect(rowOf(reader(role)), role).toEqual({ ...none, R1: true, T1: true });
    }
  });

  it('the seller, the VED, the accountant and the viewer read none', () => {
    for (const role of ['sales_manager', 'ved_manager', 'accountant', 'viewer'] as RoleCode[]) {
      expect(rowOf(reader(role)), role).toEqual(none);
    }
  });

  it('every seeded role is covered above', () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual(
      ['accountant', 'admin', 'logist', 'sales_manager', 'super_admin', 'ved_manager', 'viewer', 'warehouse_manager', 'warehouse_operator'],
    );
  });

  it('the arm is the SCOPE, not a grant: a scoped role with only reports.own_warehouse reads; an unscoped one with a YW row does not', () => {
    const scopedThin: ThreadReader = { id: ME, permissions: new Set(['reports.own_warehouse']), warehouseScoped: true, warehouseIds: [YW] };
    expect(rowOf(scopedThin)).toEqual({ ...none, R1: true, T1: true });
    const unscopedWithRow: ThreadReader = { id: ME, permissions: new Set(['reports.own_warehouse']), warehouseScoped: false, warehouseIds: [YW] };
    expect(rowOf(unscopedWithRow)).toEqual(none);
  });

  it('a SCOPED logist is judged as staff — never through the card door’s wider arms', () => {
    const scopedLogist: ThreadReader = {
      id: ME,
      permissions: new Set([...ROLE_MATRIX.logist, ...ROLE_MATRIX.warehouse_operator]),
      warehouseScoped: true,
      warehouseIds: [TAS1],
    };
    const R4: Card = { kind: 'receipt', receiving: TAS1, stands: [AND] };
    expect(cardDoorOf(scopedLogist, R4), 'the card admits him (the receiving warehouse)').toBe(true);
    expect(rowOf(scopedLogist, { ...CARDS, R4 })).toEqual({ R1: false, R2: true, R3: true, T1: true, T2: true, R4: false });
  });

  it('the card door is an INPUT: no card door, no thread — whatever the stand says', () => {
    expect(cargoThreadDoorOf(reader('warehouse_operator'), { stands: [YW], cardDoor: false })).toBe(false);
    expect(cargoThreadDoorOf(reader('logist'), { stands: [YW], cardDoor: false })).toBe(false);
  });
});

describe('4. who writes FROM the cargo', () => {
  const stand = (ids: string[]): CargoStand => ({ warehouseIds: ids, places: [] });
  it('a standing warehouse’s scoped person — the scope, not the role', () => {
    expect(writesFromStanding(reader('warehouse_operator', [YW]), stand([YW]))).toBe(true);
    expect(writesFromStanding(reader('warehouse_operator', [YW]), stand([TAS1]))).toBe(false);
    expect(writesFromStanding(reader('logist'), stand([YW]))).toBe(false);
    const scopedLogist: ThreadReader = { ...reader('logist'), warehouseScoped: true, warehouseIds: [YW] };
    expect(writesFromStanding(scopedLogist, stand([YW])), 'stated: scope makes him staff').toBe(true);
    expect(writesFromStanding(null, stand([YW]))).toBe(false);
  });
});

describe('5. the ONE place line — uz and zh-CN, literal', () => {
  const uz = notificationLabels('uz');
  const zh = notificationLabels('zh-CN');
  const shelf = (w: string, boxes: number) => ({ kind: 'shelf' as const, warehouseId: w, boxes });
  const road = (truckStatus: string, boxes: number) => ({
    kind: 'road' as const,
    batchId: '00000000-0000-4000-8000-0000000000b1',
    originWarehouseId: YW,
    destWarehouseId: TAS1,
    truckStatus,
    boxes,
  });

  it('a live prixod: its shelves, then what rides — the road word by the TRUCK', () => {
    const live = standOf([shelf(TAS1, 12), road('in_transit', 5)]);
    expect(cargoNowLine(live, CODES, uz)).toBe('📍 Yuk hozir: TAS1 — 12 kor. · yo‘lda YW → TAS1 — 5 kor.');
    expect(cargoNowLine(live, CODES, zh)).toBe('📍 货物现在： TAS1 — 12 箱 · 在途 YW → TAS1 — 5 箱');
    expect(cargoNowLine(standOf([road('arrived', 5)]), CODES, uz)).toBe('📍 Yuk hozir: TAS1 da tushirilmoqda — 5 kor.');
    expect(cargoNowLine(standOf([road('unloaded', 1)]), CODES, uz)).toBe(
      '📍 Yuk hozir: TAS1 da topilmagan (YW → TAS1) — 1 kor.',
    );
  });

  it('nothing live is NEVER under «Yuk hozir:»', () => {
    const gone = standOf([
      { kind: 'issued', warehouseId: TAS1, boxes: 97 },
      { kind: 'lost', warehouseId: KA, boxes: 3 },
    ]);
    expect(cargoNowLine(gone, CODES, uz)).toBe('📍 Faol yuk yo‘q — topshirgan sklad: TAS1 · yo‘qolgan deb yozilgan: KA');
    expect(cargoNowLine(gone, CODES, zh)).toBe('📍 暂无在库或在途货物 — 交付仓库：TAS1 · 登记为丢失：KA');
    const received = (receiptStatus: 'draft' | 'confirmed' | 'voided') =>
      standOf([{ kind: 'received', warehouseId: YW, receiptStatus }]);
    expect(cargoNowLine(received('confirmed'), CODES, uz)).toBe('📍 Faol yuk yo‘q — qabul qilgan sklad: YW');
    expect(cargoNowLine(received('draft'), CODES, uz)).toBe('📍 Qoralama, hali tasdiqlanmagan — sklad: YW');
    expect(cargoNowLine(received('voided'), CODES, uz)).toBe('📍 Bekor qilingan prixod — qabul qilgan sklad: YW');
    expect(cargoNowLine(received('voided'), CODES, zh)).toBe('📍 入库单已作废——收货仓库：YW');
  });

  it('the truck card’s six words', () => {
    const line = (status: string, aboard: number, L = uz) => cargoNowLine(truckStand(truck(status), aboard), CODES, L);
    expect(line('forming', 0)).toBe('📍 Yuk hozir: YW — yuklanmoqda');
    expect(line('in_transit', 8)).toBe('📍 Yuk hozir: yo‘lda YW → TAS1');
    expect(line('arrived', 3)).toBe('📍 Yuk hozir: TAS1 — tushirilmoqda, 3 kor. qoldi');
    expect(line('unloaded', 1)).toBe('📍 Yuk hozir: TAS1 — tushirildi, 1 kor. topilmagan');
    expect(line('closed', 0)).toBe('📍 Yuk hozir: TAS1 — yetib kelgan');
    expect(line('cancelled', 0)).toBe('📍 Mashina bekor qilingan — yuk YW da');
    expect(line('unloaded', 1, zh)).toBe('📍 货物现在： TAS1 — 已卸货，1 箱未找到');
  });

  it('a warehouse with no code prints «—»; an empty stand has no line', () => {
    expect(cargoNowLine(standOf([shelf(TAS1, 2)]), new Map(), uz)).toBe('📍 Yuk hozir: — — 2 kor.');
    expect(cargoNowLine({ warehouseIds: [], places: [] }, CODES, uz)).toBeNull();
  });
});

describe('6. the ping’s frame — the place above the reply, the link LAST', () => {
  const APP = 'https://gsrwms.uz';
  const LINK = `${APP}/receipts/00000000-0000-4000-8000-0000000000c1#ichki`;
  const base = { type: 'InternalNote' as const, author: 'Aziz', label: '📦 R-1 · GS777', note: 'Necha karobka?' };

  it('head · note · place · reply · 🔗 — and the drain still lifts the link', () => {
    const text = threadPingText({ ...base, link: LINK, frame: { place: '📍 Yuk hozir: TAS1 — 2 kor.', reply: '↩️ 回复' } });
    expect(text.split('\n')).toEqual(['📝 Aziz · 📦 R-1 · GS777', 'Necha karobka?', '📍 Yuk hozir: TAS1 — 2 kor.', '↩️ 回复', `🔗 ${LINK}`]);
    expect(takeOwnLink(text, APP).url).toBe(LINK);
  });

  it('a door-less recipient’s frame has no place line', () => {
    const text = threadPingText({ ...base, link: null, frame: { place: null, reply: '↩️ Javob uchun shu xabarga reply qiling' } });
    expect(text.split('\n')).toEqual(['📝 Aziz · 📦 R-1 · GS777', 'Necha karobka?', '↩️ Javob uchun shu xabarga reply qiling']);
    expect(text).not.toContain('📍');
  });

  it('without a frame the text is round 1’s, byte for byte', () => {
    expect(threadPingText({ ...base, link: LINK })).toBe(
      `📝 Aziz · 📦 R-1 · GS777\nNecha karobka?\n↩️ Javob uchun shu xabarga reply qiling\n🔗 ${LINK}`,
    );
  });
});

describe('7. the frame’s two buttons follow the language the text was written in', () => {
  const before = process.env.APP_URL;
  beforeEach(() => {
    process.env.APP_URL = 'https://gsrwms.uz';
  });
  afterEach(() => {
    process.env.APP_URL = before;
  });
  const thread = { kind: 'receipt', id: '00000000-0000-4000-8000-0000000000c1', activityId: '00000000-0000-4000-8000-0000000000c2' };
  const text = `📝 A · 📦 R-1\nx\n↩️ 回复\n🔗 https://gsrwms.uz/receipts/${thread.id}#ichki`;

  it('textLocale zh-CN → «↗️ 打开» and «💬 回复», whatever the reader’s own locale', () => {
    const message = composeStaffMessage('InternalNote', { text, thread, textLocale: 'zh-CN' }, 'ru');
    expect(message.urlRow?.[0]?.text).toBe('↗️ 打开');
    expect(buttonsFor('InternalNote', { text, thread, textLocale: 'zh-CN' })).toEqual([[{ text: '💬 回复', callback_data: 'jy' }]]);
  });

  it('no textLocale (every pre-rendered text before round 2), or a foreign one → Uzbek, as it always was', () => {
    for (const payload of [{ text, thread }, { text, thread, textLocale: 'xx' }]) {
      expect(composeStaffMessage('InternalNote', payload, 'ru').urlRow?.[0]?.text).toBe('↗️ Ochish');
      expect(buttonsFor('InternalNote', payload)).toEqual([[{ text: THREAD_REPLY_BUTTON, callback_data: 'jy' }]]);
    }
    expect(textLocaleOf({})).toBe('uz');
    expect(textLocaleOf(null)).toBe('uz');
  });

  it('the uz words ARE round 1’s literals', () => {
    expect(notificationLabels('uz').threadReplyButton).toBe(THREAD_REPLY_BUTTON);
    expect(notificationLabels('uz').threadReplyHint).toBe('↩️ Javob uchun shu xabarga reply qiling');
  });
});

describe('8. «the server is behind» — the two widened CHECKs by NAME', () => {
  it('names 0129’s two constraints, keeps 42P01/42703, and leaves every other 23514 a real fault', () => {
    expect(isThreadWriteBehind({ code: '23514', constraint_name: 'crm_activities_entity_check' })).toBe(true);
    expect(isThreadWriteBehind({ code: '23514', constraint_name: 'thread_reads_kind_check' })).toBe(true);
    expect(isThreadWriteBehind({ code: '23514', constraint_name: 'crm_activities_tg_pair_check' })).toBe(false);
    expect(isThreadWriteBehind({ code: '42703' })).toBe(true);
    expect(isThreadWriteBehind({ message: 'wrapped', cause: { code: '23514', constraint_name: 'crm_activities_entity_check' } })).toBe(
      true,
    );
    expect(isThreadWriteBehind({ code: '23514' })).toBe(false);
    expect(isThreadWriteBehind(new Error('x'))).toBe(false);
  });
});

describe('9. ids grouped by kind', () => {
  it('a key for every kind, strict uuids only, lower-cased, deduplicated', () => {
    const upper = '00000000-0000-4000-8000-0000000000AA';
    const grouped = idsByKind([
      { kind: 'receipt', id: upper },
      { kind: 'receipt', id: upper.toLowerCase() },
      { kind: 'batch', id: 'not-a-uuid' },
      { kind: 'lead', id: YW },
    ]);
    expect(Object.keys(grouped).sort()).toEqual([...THREAD_KINDS].sort());
    expect(grouped.receipt).toEqual([upper.toLowerCase()]);
    expect(grouped.batch).toEqual([]);
    expect(grouped.lead).toEqual([YW]);
    expect(grouped.calc).toEqual([]);
  });
});

describe('10. the dock tab is the door’s own people', () => {
  it('every seeded role but the accountant and the viewer; a scoped role with no warehouse — none', () => {
    const answers = Object.fromEntries(
      (Object.keys(ROLE_MATRIX) as RoleCode[]).map((role) => [role, mayHaveThreads(reader(role))]),
    );
    expect(answers).toEqual({
      super_admin: true,
      admin: true,
      logist: true,
      ved_manager: true,
      warehouse_manager: true,
      warehouse_operator: true,
      sales_manager: true,
      accountant: false,
      viewer: false,
    });
    expect(mayHaveThreads(reader('warehouse_operator', []))).toBe(false);
    const scopedPlanner: ThreadReader = { id: ME, permissions: new Set(['plans.manage']), warehouseScoped: true, warehouseIds: [] };
    expect(mayHaveThreads(scopedPlanner), 'arm (a) is the unscoped office’s').toBe(false);
  });
});

describe('11. a photo reply to a cargo ping — a TEXT-only sentence', () => {
  it('cargo → mediaCargo; CRM and calc → mediaCard; a task → mediaTask; a customer → not this door', () => {
    const id = '00000000-0000-4000-8000-0000000000d1';
    expect(mediaSentenceFor({ kind: 'thread', ref: { kind: 'receipt', id }, ping: 'InternalNote' })).toBe(REPLY_SENTENCES.mediaCargo);
    expect(mediaSentenceFor({ kind: 'thread', ref: { kind: 'batch', id }, ping: 'MentionedInNote' })).toBe(REPLY_SENTENCES.mediaCargo);
    expect(mediaSentenceFor({ kind: 'thread', ref: { kind: 'lead', id }, ping: 'InternalNote' })).toBe(REPLY_SENTENCES.mediaCard);
    expect(mediaSentenceFor({ kind: 'calc_task', requestId: id, taskId: id })).toBe(REPLY_SENTENCES.mediaCard);
    expect(mediaSentenceFor({ kind: 'task_question', taskId: id })).toBe(REPLY_SENTENCES.mediaTask);
    expect(mediaSentenceFor({ kind: 'customer' })).toBeNull();
  });
});

describe('12. fillVars', () => {
  it('fills every var — twice where the template says it twice — and leaves an absent one as written', () => {
    expect(fillVars(notificationLabels('uz').cargoMissing, { from: 'YW', to: 'TAS1', n: 1 })).toBe(
      'TAS1 da topilmagan (YW → TAS1) — 1 kor.',
    );
    expect(fillVars('{code} — {n}', { code: 'YW' })).toBe('YW — {n}');
  });
});
