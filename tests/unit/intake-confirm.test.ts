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

const VED_ANSWERS = '🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.';

let seq = 0;
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  land.target.mockReset();
});

async function save(section: IntakeState['section'], replyQueued: boolean): Promise<string> {
  seq += 1;
  const chatId = BigInt(-9_900_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section);
  updateIntake(chatId, { stage: 'review', material: ['Kurtka 300 dona'] });
  land.target.mockResolvedValueOnce({
    kind: 'lead',
    id: 'lead-1',
    label: 'Ali aka',
    leadOwnerId: 'staff-1',
    queued: true,
    requestId: 'req-1',
    queueError: null,
    replyQueued,
  });
  const replies: string[] = [];
  await handleCalcCallback({ reply: async (text: string) => replies.push(text) }, chatId, 'save');
  return replies.at(-1) ?? '';
}

describe('the ✅ says where the answer comes from', () => {
  it('a yolkira job whose tariff reply is queued: «alohida xabarda keladi», readable in either order', async () => {
    const said = await save('yolkira', true);
    expect(said).toContain(TARIFF_FOLLOWS);
    expect(said).not.toContain(VED_ANSWERS);
  });

  it('a yolkira job whose reply could not be queued promises nothing it will not send', async () => {
    const said = await save('yolkira', false);
    expect(said).toContain(VED_ANSWERS);
    expect(said).not.toContain(TARIFF_FOLLOWS);
  });

  it('a job with a customs half keeps its sentence — its pass takes minutes, not a poll', async () => {
    for (const section of ['rastamojka', 'podklyuch'] as const) {
      const said = await save(section, true);
      expect(said, section).toContain(VED_ANSWERS);
      expect(said, section).not.toContain(TARIFF_FOLLOWS);
    }
  });
});
