import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECEIPT_DEAL_ANCHOR } from '@/modules/platform/notifications/receipt-arrival';

/**
 * «📎 Fayl qo‘shish» — where the collection is wired into a ladder it does
 * not own (docs/PRIXOD-XABARI.md §C.5).
 *
 * Source-shape on purpose. Each of these is an ORDER or a CALL SITE in
 * somebody else's function, both versions «work», and the wrong one is
 * silent: a file that Door B offers to make a task of instead of attaching,
 * a collection that goes on taking files after «Hisoblatish» opened, a typed
 * sentence handed to the paid assistant. The behaviour itself is proven
 * through the whole chain in receipt-files-bot.integration.test.ts.
 */
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const T = 'src/modules/platform/telegram';
const handlers = read(`${T}/staff-handlers.ts`);

describe('the media ladder', () => {
  const photos = handlers.slice(handlers.indexOf("bot.on(['message:photo', 'message:document']"));
  const photoBody = photos.slice(0, photos.indexOf('bot.on(', 10));

  it('a photo or a file reaches the prixod’s collection after the calc collection and the zametka — and BEFORE the task door', () => {
    const capture = photoBody.indexOf('if (!capture || late) {');
    const ours = photoBody.indexOf('receiptFileArrives(ctx, chatId)');
    const draft = photoBody.indexOf('if (await draftMedia(ctx, chatId)) return;');
    expect(capture).toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(capture);
    // `draftMedia` is «a live draft takes it» AND Door B's «📌 Topshiriq
    // qilamizmi?» in one call: placed after it, every forward is offered as a
    // task and never reaches the prixod.
    expect(draft).toBeGreaterThan(ours);
  });

  it('a live task draft (or the album a just-made task is still receiving) keeps its part', () => {
    expect(photoBody).toContain(
      'const draftTakes = !late && (activeDraft(chatId) !== null || lingerFor(chatId, ctx.message.media_group_id) !== null);',
    );
    expect(photoBody).toContain('if (!draftTakes && (await receiptFileArrives(ctx, chatId))) return;');
  });

  it('a video or a voice note into a live collection is answered before the task door can offer it', () => {
    const voice = handlers.slice(handlers.indexOf("['message:voice', 'message:audio'"));
    const body = voice.slice(0, voice.indexOf("bot.on('message:text'"));
    const ours = body.indexOf('if (await receiptFilesRefuseOther(ctx, chatId)) return;');
    expect(ours).toBeGreaterThan(body.indexOf('if (!late && activeCapture(chatId)) return next();'));
    expect(body.indexOf('if (await draftMedia(ctx, chatId)) return;')).toBeGreaterThan(ours);
  });

  it('a typed text is told it is not kept BEFORE the paid assistant is asked', () => {
    const answer = handlers.slice(handlers.indexOf('export async function answerStaffText('));
    const ours = answer.indexOf('receiptFilesTextAnswer(chatId)');
    expect(ours).toBeGreaterThan(-1);
    expect(answer.indexOf('void answerWithAssistant(chatId, text, thinking.message_id);')).toBeGreaterThan(ours);
    expect(answer.indexOf('if (!aiConfigured()) {')).toBeGreaterThan(ours);
  });
});

describe('another collector opening closes this one', () => {
  // Beside the three `endBurst(chatId)` lines — the one place each of the
  // three constructors already tells the chat's other state it is over.
  for (const [file, needle] of [
    [`${T}/calc-store.ts`, 'endBurst(chatId);'],
    [`${T}/task-handlers.ts`, 'endBurst(chatId);'],
    [`${T}/staff-handlers.ts`, 'endBurst(chatId);\n    closeReceiptFiles(chatId);\n    startCapture('],
  ] as const) {
    it(`${file.split('/').at(-1)}`, () => {
      const source = read(file);
      const at = source.indexOf(needle);
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 400)).toContain('closeReceiptFiles(chatId);');
    });
  }

  it('…and it is CLOSED, never dropped, there: the next file must be told it was not attached', () => {
    for (const file of [`${T}/calc-store.ts`, `${T}/task-handlers.ts`]) {
      expect(read(file)).not.toContain('endReceiptFiles(');
    }
  });

  it('the state is a leaf: the collectors that close it can import it without a cycle', () => {
    const leaf = read(`${T}/receipt-files.ts`);
    const imports = [...leaf.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./waits']);
  });
});

describe('the card', () => {
  it('the button’s anchor and the deal block’s id are one word', () => {
    expect(RECEIPT_DEAL_ANCHOR).toBe('bitim');
    expect(read('src/app/(protected)/receipts/[id]/deal-link.tsx')).toContain(`id="${RECEIPT_DEAL_ANCHOR}"`);
    expect(read('src/app/(protected)/bitimlar/actions.ts')).toContain('redirect(`/receipts/${receiptId}#bitim`);');
  });

  it('a file sent through the bot is stored as a PAPER, and its delete rule is stated', () => {
    expect(read(`${T}/receipt-files-door.ts`)).toContain('asPaper: true,');
    expect(read('src/modules/platform/files/service.ts')).toContain("kind: isPhoto && !opts.asPaper ? 'photo' : 'file',");
    expect(read('src/modules/platform/files/service.ts')).toMatch(/\n  receipt: 'shared',\n/);
  });
});
