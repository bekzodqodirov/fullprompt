import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The ✅ after «Tasdiqlash» (judge concurrency-8): a section with no customs
 * half is answered from the tariff table on its own fast queue, and that
 * reply can reach the chat BEFORE this message — so the sentence says the
 * answer comes separately, true in either order. Only when the reply IS
 * queued: otherwise it would promise a message nobody sends.
 *
 * The landing, the link and the keyboard are stand-ins; what is under test is
 * the sentence the save step chooses.
 */
const land = vi.hoisted(() => ({ target: vi.fn() }));
vi.mock('@/modules/platform/telegram/staff-bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/staff-bot')>()),
  staffForChat: async () => ({ id: 'staff-1', fullName: 'Sotuvchi' }),
  landCollectedIntake: land.target,
  landingLinkFor: async () => null,
}));
vi.mock('@/modules/platform/telegram/keyboards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/telegram/keyboards')>()),
  replyKeyboardFor: async () => ({ keyboard: [] }),
}));

import { startIntake, updateIntake, endIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { TARIFF_FOLLOWS, handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { AI_QUEUED, PLAIN_QUEUED, landingReplyText, type LandedTarget } from '@/modules/platform/telegram/calc-dialog';

/** Before the two doors — a NULL door keeps it (docs/IKKI-ESHIK.md §0.2). */
const VED_ANSWERS = '🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.';

let seq = 0;
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  land.target.mockReset();
});

/**
 * «Tasdiqlash» on a collection of `door` — the plain «🧮» one, the AI one, or
 * a seeded collection whose source predates the doors (NULL).
 */
async function save(
  section: IntakeState['section'],
  replyQueued: boolean,
  door: 'plain' | 'ai' | null = 'plain',
  queued = true,
): Promise<string> {
  seq += 1;
  const chatId = BigInt(-9_900_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-test', ai: door === 'ai' });
  updateIntake(chatId, {
    stage: 'review',
    material: ['Kurtka 300 dona'],
    ...(door === null ? { seed: [{ name: 'Kurtka' }], seededFrom: 'req-0' } : {}),
  });
  land.target.mockResolvedValueOnce({
    kind: 'lead',
    id: 'lead-1',
    label: 'Ali aka',
    leadOwnerId: 'staff-1',
    queued,
    requestId: queued ? 'req-1' : null,
    queueError: queued ? null : 'too_many_open',
    replyQueued,
  });
  const replies: string[] = [];
  await handleCalcCallback(
    {
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: replies.length };
      },
    },
    chatId,
    'save',
  );
  return replies.at(-1) ?? '';
}

describe('the ✅ says where the answer comes from', () => {
  it('a yolkira job whose tariff reply is queued: «alohida xabarda keladi», readable in either order', async () => {
    const said = await save('yolkira', true);
    expect(said).toContain(TARIFF_FOLLOWS);
    expect(said).not.toContain(VED_ANSWERS);
  });

  it('a yolkira job whose reply could not be queued promises nothing it will not send — on the plain door, the VED', async () => {
    const said = await save('yolkira', false);
    expect(said).toContain(PLAIN_QUEUED);
    expect(said).not.toContain(TARIFF_FOLLOWS);
  });

  it('the plain door promises the VED, never an AI figure (his 2a/3a, docs/IKKI-ESHIK.md §2.3)', async () => {
    for (const section of ['rastamojka', 'podklyuch'] as const) {
      for (const replyQueued of [true, false]) {
        const said = await save(section, replyQueued);
        expect(said, section).toContain('🧮 VED navbatiga tushdi — VED xodimi hisoblab, javobni shu yerga yuboradi.');
        expect(said, section).not.toContain(TARIFF_FOLLOWS);
        expect(said, section).not.toContain('AI hisoblayapti');
      }
    }
  });

  it('the AI door promises its figure only when that answer IS queued (his 4a, §3.5)', async () => {
    for (const section of ['rastamojka', 'podklyuch'] as const) {
      expect(await save(section, true, 'ai'), section).toContain(
        '🤖 AI hisoblayapti — taxminiy natija bir necha daqiqada shu yerga keladi. Rasmiy narxni VED xodimi beradi.',
      );
      const unqueued = await save(section, false, 'ai');
      expect(unqueued, section).not.toContain(AI_QUEUED);
      expect(unqueued, section).toContain(VED_ANSWERS);
    }
  });

  it('a NULL door (a seeded collection whose source predates the doors) keeps today’s words (§0.2)', async () => {
    const said = await save('rastamojka', true, null);
    expect(said).toContain(VED_ANSWERS);
    expect(said).not.toContain(PLAIN_QUEUED);
    expect(said).not.toContain(AI_QUEUED);
  });

  it('not queued: the refusal, unchanged, on every door', async () => {
    for (const door of ['plain', 'ai', null] as const) {
      const said = await save('rastamojka', false, door, false);
      expect(said, String(door)).toContain('⚠️ Hisoblash navbatiga tushmadi: sizda 20 ta ochiq so‘rov bor');
      expect(said, String(door)).not.toContain('navbatiga tushdi');
    }
  });
});

describe('landingReplyText by door (pure)', () => {
  const target: LandedTarget = { kind: 'deal', label: 'B-00001', queued: true, replyQueued: true };
  it('the four queue lines', () => {
    expect(landingReplyText(target, { link: null, tariffFollows: false, door: 'plain' })).toContain(PLAIN_QUEUED);
    expect(landingReplyText(target, { link: null, tariffFollows: false, door: 'ai' })).toContain(AI_QUEUED);
    expect(landingReplyText(target, { link: null, tariffFollows: false, door: null })).toContain(VED_ANSWERS);
    expect(landingReplyText(target, { link: null, tariffFollows: true, door: 'plain' })).toContain(TARIFF_FOLLOWS);
    expect(landingReplyText({ ...target, replyQueued: false }, { link: null, tariffFollows: false, door: 'ai' })).toContain(VED_ANSWERS);
  });
});
