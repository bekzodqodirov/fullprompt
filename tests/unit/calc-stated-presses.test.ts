import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * K's three stated presses (docs/SAKKIZ-R3.md §5, K11) and the callback
 * vocabulary they ride on (K12). Everything else K changes is behaviour-
 * unchanged by construction; these three are the exceptions, each pinned so a
 * red proof can show it:
 *  - the certificate buttons carry their value — a press delivered twice is
 *    the same answer twice, never a flip;
 *  - a restart pressed from the message that opened the live collection, or
 *    a restart whose claim is already held, RESUMES instead of wiping;
 *  - «▶️ Yo‘q, davom etaman» is `c:resume` and re-prompts the live stage
 *    (it was `c:more`, which threw a reviewed collection back to material).
 *
 * Plus the dispatcher's `ownsPress` gate, which K answers `true` and P1
 * fills: asked here with a stand-in that says «not this collection's».
 */
const stub = vi.hoisted(() => ({ claimed: true, owns: true }));
vi.mock('@/modules/platform/telegram/staff-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/staff-bot')>()),
  staffForChat: async () => ({ id: 'staff-1', fullName: 'Sotuvchi' }),
}));
vi.mock('@/modules/platform/telegram/once', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/once')>()),
  claimOnce: async () => stub.claimed,
}));
vi.mock('@/modules/platform/telegram/calc-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/calc-store')>()),
  ownsPress: () => stub.owns,
}));

import {
  CALC_STEP_REPEAT,
  PRESS_REPEAT,
  parseCallback,
  type CalcStep,
} from '@/modules/platform/telegram/staff-bot';
import { activeIntake, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-store';
import { aiConfirmKeyboard, CLIENT_QUESTION, restartKeyboard } from '@/modules/platform/telegram/calc-keyboards';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { deliverNextStep } from '@/modules/platform/telegram/calc-dialog';
import type { OnceKey } from '@/modules/platform/telegram/once';
import { read } from '../fixtures/source-shape';

const UUID = '01234567-89ab-7def-8123-456789abcdef';
const STALE = 'Bu tugma eskirgan.';

let seq = 0;
const chats: bigint[] = [];
function chat(): bigint {
  seq += 1;
  const id = BigInt(-7_400_000_000) - BigInt(seq);
  chats.push(id);
  return id;
}
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  stub.claimed = true;
  stub.owns = true;
});

/** A press from message `messageId` (null = a press that carries no message). */
function pressFrom(messageId: number | null) {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  const ctx = {
    reply: async (text: string, extra?: Record<string, unknown>) => {
      replies.push({ text, extra });
      return { message_id: 9000 + replies.length };
    },
    ...(messageId === null ? {} : { callbackQuery: { message: { message_id: messageId } } }),
    api: {
      editMessageText: async () => {
        throw new Error('no edit in a test — the prompt is sent fresh');
      },
    },
  };
  return { ctx, replies, last: () => replies.at(-1)?.text ?? '' };
}

const buttonsOf = (extra?: Record<string, unknown>) =>
  ((extra?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)
    ?.inline_keyboard ?? []).flat();

describe('the certificate buttons carry their value (K11, durability-2)', () => {
  it('«bor» delivered twice is «bor» — never a flip back', async () => {
    const id = chat();
    startIntake(id, 'rastamojka', { ai: true, staffId: 'staff-1' });
    updateIntake(id, { stage: 'review', hasCertificate: false });
    const { ctx, replies } = pressFrom(null);
    await handleCalcCallback(ctx, id, 'cert_y');
    await handleCalcCallback(ctx, id, 'cert_y');
    expect(activeIntake(id)?.hasCertificate).toBe(true);
    // The keyboard then offers the OTHER answer, as the one shown.
    expect(buttonsOf(replies.at(-1)?.extra).map((b) => b.callback_data)).toContain('c:cert_n');
    await handleCalcCallback(ctx, id, 'cert_n');
    await handleCalcCallback(ctx, id, 'cert_n');
    expect(activeIntake(id)?.hasCertificate).toBe(false);
    expect(replies.at(-1)?.text).toContain('Sertifikat YO‘Q');
  });

  it('the old toggle is «eskirgan» and changes nothing', async () => {
    const id = chat();
    startIntake(id, 'rastamojka', { ai: true, staffId: 'staff-1' });
    updateIntake(id, { stage: 'review', hasCertificate: true });
    const { ctx, last } = pressFrom(null);
    await handleCalcCallback(ctx, id, 'cert');
    expect(last()).toBe(STALE);
    expect(activeIntake(id)?.hasCertificate).toBe(true);
  });

  it('the keyboard draws only the two value-carrying buttons', () => {
    const data = (cert: boolean) => aiConfirmKeyboard(cert).inline_keyboard.flat().map((b) => b.callback_data);
    expect(data(true)).toContain('c:cert_n');
    expect(data(false)).toContain('c:cert_y');
    expect([...data(true), ...data(false)]).not.toContain('c:cert');
  });
});

describe('a restart resumes when it would reopen what is live (K11, durability-2)', () => {
  it('«🔄 Ha» pressed twice from one message keeps what was sent after the first', async () => {
    const id = chat();
    // A collection opened from some earlier message…
    startIntake(id, 'rastamojka', { staffId: 'staff-1', openedBy: 40 });
    updateIntake(id, { stage: 'material', material: ['eski'] });
    // …restarted from the restart question (message 50): wiped and reopened.
    const first = pressFrom(50);
    await handleCalcCallback(first.ctx, id, 'go_rastamojka');
    expect(activeIntake(id)?.material).toEqual([]);
    expect(activeIntake(id)?.openedBy).toBe(50);
    expect(first.last()).toBe(CLIENT_QUESTION);
    // The seller names the customer and sends the goods…
    updateIntake(id, { stage: 'material', clientHintRaw: 'GS777', material: ['Kurtka 300 dona'] });
    // …and the same «🔄 Ha» arrives again (a double tap, a redelivery).
    const again = pressFrom(50);
    await handleCalcCallback(again.ctx, id, 'go_rastamojka');
    expect(activeIntake(id)?.material).toEqual(['Kurtka 300 dona']);
    expect(activeIntake(id)?.clientHintRaw).toBe('GS777');
    expect(again.last()).toContain('Qabul qilindi');
  });

  it('a restart whose claim is already held resumes the collection live now', async () => {
    const id = chat();
    startIntake(id, 'rastamojka', { staffId: 'staff-1', openedBy: 70 });
    updateIntake(id, { stage: 'client', material: ['Kurtka 300 dona'] });
    stub.claimed = false;
    const { ctx, last } = pressFrom(60);
    await handleCalcCallback(ctx, id, 'go_rastamojka', 'q:-1:60:restart' as OnceKey);
    expect(activeIntake(id)?.material).toEqual(['Kurtka 300 dona']);
    expect(activeIntake(id)?.openedBy).toBe(70);
    expect(last()).toBe(CLIENT_QUESTION);
  });

  it('a restart whose claim is free restarts, as it always did', async () => {
    const id = chat();
    startIntake(id, 'rastamojka', { staffId: 'staff-1', openedBy: 70 });
    updateIntake(id, { stage: 'client', material: ['Kurtka 300 dona'] });
    stub.claimed = true;
    const { ctx } = pressFrom(60);
    await handleCalcCallback(ctx, id, 'go_rastamojka', 'q:-1:60:restart' as OnceKey);
    expect(activeIntake(id)?.material).toEqual([]);
    expect(activeIntake(id)?.openedBy).toBe(60);
  });
});

describe('«▶️ Yo‘q, davom etaman» re-prompts the live stage (K7, K9, product-fit-8)', () => {
  it('the restart question offers `c:resume` under ▶️ — ↩️ is the undo’s mark alone', () => {
    const [yes, no] = restartKeyboard('rastamojka').inline_keyboard.flat();
    expect(yes).toEqual({ text: '🔄 Ha, boshqatdan', callback_data: 'c:go_rastamojka' });
    expect(no).toEqual({ text: '▶️ Yo‘q, davom etaman', callback_data: 'c:resume' });
    expect(parseCallback(no!.callback_data)).toEqual({ kind: 'calc', step: 'resume' });
  });

  it('a reviewed collection stays reviewed — `more` threw it back to material', async () => {
    const id = chat();
    startIntake(id, 'rastamojka', { staffId: 'staff-1' });
    updateIntake(id, { stage: 'review', clientHintRaw: 'GS777', material: ['Kurtka 300 dona'] });
    const { ctx, replies } = pressFrom(null);
    await handleCalcCallback(ctx, id, 'resume');
    expect(activeIntake(id)?.stage).toBe('review');
    expect(activeIntake(id)?.material).toEqual(['Kurtka 300 dona']);
    expect(buttonsOf(replies.at(-1)?.extra).map((b) => b.callback_data)).toContain('c:save');
  });

  it('the customer question is asked again, not skipped', async () => {
    const id = chat();
    startIntake(id, 'rastamojka', { staffId: 'staff-1' });
    const { ctx, last } = pressFrom(null);
    await handleCalcCallback(ctx, id, 'resume');
    expect(activeIntake(id)?.stage).toBe('client');
    expect(last()).toBe(CLIENT_QUESTION);
  });

  it('while a reading runs, ▶️ says so — never a stale summary or «Bo‘ldi ni bosing» (K’s review, U5)', async () => {
    // The restart question is reachable during the «AI o‘qiyapti» minutes (a
    // section button pressed meanwhile). A review-stage re-read re-sent the
    // old summary, whose «✅ Tasdiqlash» then only answered this same line.
    for (const stage of ['review', 'material'] as const) {
      const id = chat();
      startIntake(id, 'rastamojka', { staffId: 'staff-1' });
      updateIntake(id, { stage, clientHintRaw: 'GS777', material: ['Kurtka 300 dona'], analysing: 'token-1' });
      const { ctx, replies, last } = pressFrom(null);
      await handleCalcCallback(ctx, id, 'resume');
      expect(last(), stage).toBe('⏳ Tahlil davom etmoqda — natijani kuting.');
      expect(replies, stage).toHaveLength(1);
      expect(activeIntake(id)?.analysing, stage).toBe('token-1');
    }
  });
});

describe('the summary is printed from what was WRITTEN (K’s review, U4)', () => {
  it('a certificate answer that landed while the laws were read is the one the summary and its button show', async () => {
    // The reading runs off the poller and hands `deliverNextStep` its
    // snapshot; a press applied in between is in the store and not in the
    // snapshot. Before K the summary was read off the store after the write.
    const id = chat();
    startIntake(id, 'rastamojka', { ai: true, staffId: 'staff-1' });
    const snapshot = updateIntake(id, { stage: 'review', material: ['Kurtka 300 dona'], hasCertificate: true })!;
    updateIntake(id, { hasCertificate: false });
    const { ctx, replies } = pressFrom(null);
    await deliverNextStep(ctx, id, snapshot);
    expect(activeIntake(id)?.hasCertificate).toBe(false);
    expect(replies.at(-1)?.text).toContain('📄 Sertifikat: yo‘q');
    expect(buttonsOf(replies.at(-1)?.extra).map((b) => b.callback_data)).toContain('c:cert_y');
  });
});

describe('every «own» press acts only on the collection whose message carries it (K11)', () => {
  const own = (Object.entries(CALC_STEP_REPEAT) as [CalcStep, string][])
    .filter(([, v]) => v === 'own')
    .map(([k]) => k);

  it('a press from another collection’s message is «eskirgan» and changes nothing', async () => {
    expect(own.length, 're-anchor: no own step').toBeGreaterThan(5);
    stub.owns = false;
    for (const step of own) {
      const id = chat();
      startIntake(id, 'rastamojka', { ai: true, staffId: 'staff-1' });
      updateIntake(id, { stage: 'review', hasCertificate: false, material: ['Kurtka 300 dona'] });
      const before = activeIntake(id);
      const { ctx, last } = pressFrom(123);
      await handleCalcCallback(ctx, id, step);
      expect(last(), step).toBe(STALE);
      expect(activeIntake(id), step).toEqual(before);
    }
  });

  it('a cancel with no live collection still says «Bekor qilindi.»', async () => {
    stub.owns = false;
    const id = chat();
    const { ctx, last } = pressFrom(123);
    await handleCalcCallback(ctx, id, 'cancel');
    expect(last()).toBe('Bekor qilindi.');
  });

  it('a prompt-class press is not gated: ▶️ from a pause notice still re-prompts', async () => {
    stub.owns = false;
    const id = chat();
    startIntake(id, 'rastamojka', { staffId: 'staff-1' });
    const { ctx, last } = pressFrom(123);
    await handleCalcCallback(ctx, id, 'resume');
    expect(last()).toBe(CLIENT_QUESTION);
  });
});

describe('the callback vocabulary (K12)', () => {
  it('the add door’s three prefixes and the echo’s undo parse, and fit 64 bytes', () => {
    expect(parseCallback(`ca:${UUID}`)).toEqual({ kind: 'calc_add', requestId: UUID, mode: 'plain' });
    expect(parseCallback(`cg:${UUID}`)).toEqual({ kind: 'calc_add', requestId: UUID, mode: 'restart' });
    expect(parseCallback(`cf:${UUID}`)).toEqual({ kind: 'calc_add', requestId: UUID, mode: 'replied' });
    expect(parseCallback('cu:a1b2c3d4')).toEqual({ kind: 'calc_undo', tag: 'a1b2c3d4' });
    for (const data of [`ca:${UUID}`, `cg:${UUID}`, `cf:${UUID}`, 'cu:a1b2c3d4']) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });

  it('anchored: no look-alike parses, and the older prefixes keep their meaning', () => {
    for (const junk of ['ca:short', `ca:${UUID}x`, 'cu:a1b2c3d', 'cu:a1b2c3d4e', 'cu:A1B2C3D4', `cx:${UUID}`, `cgg:${UUID}`]) {
      expect(parseCallback(junk), junk).toBeNull();
    }
    expect(parseCallback(`cl:1:${UUID}:a1b2c3d4`)?.kind).toBe('calc_link');
    expect(parseCallback('c:cancel')).toEqual({ kind: 'calc', step: 'cancel' });
  });

  it('the new calc steps parse, the conflict family stops at three, and the legacy two stay', () => {
    for (const step of ['resume', 'cert_y', 'cert_n', 'cancel_y', 'conf_0_add', 'conf_1_rep', 'conf_2_ved', 'cert', 'skip']) {
      expect(parseCallback(`c:${step}`), step).toEqual({ kind: 'calc', step });
    }
    for (const junk of ['c:conf_3_add', 'c:conf_0_drop', 'c:conf__add']) expect(parseCallback(junk), junk).toBeNull();
  });

  it('every step has a redelivery class, and the restart twins are the keyed ones', () => {
    // A Record over CalcStep: a step without a class does not compile. What a
    // test adds is that the classes are the ones the dispatcher acts on.
    expect(Object.entries(CALC_STEP_REPEAT).filter(([, v]) => v === 'keyed').map(([k]) => k).sort()).toEqual(
      ['go_ai', 'go_aipk', 'go_podklyuch', 'go_rastamojka', 'go_yolkira'],
    );
    for (const step of ['cancel', 'cancel_y', 'save', 'more', 'done', 'reread', 'cert_y', 'cert_n', 'pick_0', 'conf_0_add']) {
      expect(CALC_STEP_REPEAT[step as CalcStep], step).toBe('own');
    }
    expect(PRESS_REPEAT.calc_add).toBe('keyed');
    expect(PRESS_REPEAT.calc_undo).toBe('cas');
  });

  it('every kind but the approval is answered ABOVE the approval guard (#939)', () => {
    const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
    const guard = handlers.indexOf("if (parsed.kind !== 'approval') return;");
    expect(guard, 're-anchor: the approval guard').toBeGreaterThan(-1);
    for (const kind of Object.keys(PRESS_REPEAT).filter((k) => k !== 'approval')) {
      const at = handlers.indexOf(`parsed.kind === '${kind}'`);
      expect(at, kind).toBeGreaterThan(-1);
      expect(at, kind).toBeLessThan(guard);
    }
  });
});
