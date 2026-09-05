import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUGUN,
  ZAMETKALAR,
  escapesIntake,
  parseCallback,
} from '@/modules/platform/telegram/staff-bot';

/**
 * The zametkalar door in the staff bot.
 *
 * A grammy handler cannot be exercised without a Telegram, so the vocabulary
 * and the escape predicate are proven behaviourally and the rest is SOURCE
 * SHAPE — the rules whose breach leaves every test green while a button spins
 * for fifteen seconds on a phone, a person's task result is eaten, or a note
 * is served to somebody it is not visible to.
 *
 * Comments are stripped first (#725).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const handlers = read('src/modules/platform/telegram/staff-handlers.ts');

describe('the callback vocabulary', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  it('carries a note id, the capture controls and paging', () => {
    expect(parseCallback(`n:${uuid}`)).toEqual({ kind: 'note', step: 'send', noteId: uuid });
    for (const step of ['new', 'save', 'cancel', 'share']) {
      expect(parseCallback(`n:${step}`), step).toEqual({ kind: 'note', step });
    }
    expect(parseCallback('n:p2')).toEqual({ kind: 'note', step: 'page', page: 2 });
  });

  it('fits inside Telegram cap of 64 bytes', () => {
    expect(Buffer.byteLength(`n:${uuid}`)).toBeLessThanOrEqual(64);
  });

  it('refuses anything else — an unparsed callback is answered by NOBODY', () => {
    // parseCallback returns null, the handler calls next(), the cabinet's two
    // regexes do not match, and no handler ever calls answerCallbackQuery —
    // so the button simply spins on the phone with no error anywhere.
    expect(parseCallback('n:')).toBeNull();
    expect(parseCallback('n:drop_table')).toBeNull();
    expect(parseCallback('n:p')).toBeNull();
    expect(parseCallback(`x:${uuid}`)).toBeNull();
  });

  it('DERIVED: every n: button the handlers build is one this parser accepts', () => {
    // The class of defect, retired: three buttons were drawn in the design
    // that its own regex could not parse. A sixth turns this red on the day
    // it is added, instead of spinning in a warehouse.
    const literals = [...handlers.matchAll(/callback_data:\s*(['"`])(n:[^'"`]*)\1/g)].map(
      (m) => m[2]!,
    );
    expect(literals.length, 'no n: buttons found — re-anchor this fence').toBeGreaterThanOrEqual(4);
    for (const raw of literals) {
      // A template hole is filled with a real id / page before it is sent.
      const data = raw
        .replace('${row.id}', '123e4567-e89b-12d3-a456-426614174000')
        .replace('${page - 1}', '1')
        .replace('${page + 1}', '3');
      expect(parseCallback(data), data).not.toBeNull();
    }
  });
});

describe('escapesIntake', () => {
  it('lets every keyboard button out of a live collection', () => {
    // A live collection swallows all text, which is what makes forwarding a
    // packing list work — and it swallowed the buttons the seller is looking
    // at, answering with silence. Each escape is asserted by BEHAVIOUR, so
    // adding a button and forgetting the predicate is red here rather than in
    // a warehouse.
    for (const label of [BUGUN, '/bugun', ZAMETKALAR, '/zametka', '🧮 Hisoblatish', '🤖 AI rastamojka']) {
      expect(escapesIntake(label), label).toBe(true);
    }
  });

  it('does not let ordinary material out — that is the collection working', () => {
    expect(escapesIntake('30 kub kurtka')).toBe(false);
    expect(escapesIntake('GS777')).toBe(false);
  });
});

describe('the rules a shell cannot exercise', () => {
  it('the notes branch sits between the cabinet pass-through and the task capture', () => {
    // Earlier and a cabinet label is stolen from a both-chat (round 100's
    // 13A). Later and `takeTaskPending` — which DELETES ON READ — eats the
    // press AND destroys the task capture. Later still and the label reaches
    // the paid model and costs a question out of the daily cap.
    const cabinet = handlers.indexOf('if (isCabinetText(ctx.message.text)) return next();');
    const notes = handlers.indexOf('ctx.message.text === ZAMETKALAR');
    const capture = handlers.indexOf('const capture = activeCapture(chatId);\n    if (capture) {');
    const task = handlers.indexOf('const pendingTask = takeTaskPending(chatId);');
    expect(cabinet, 're-anchor: the cabinet pass-through moved').toBeGreaterThan(-1);
    expect(notes, 're-anchor: the notes branch moved').toBeGreaterThan(-1);
    expect(capture, 're-anchor: the capture branch moved').toBeGreaterThan(-1);
    expect(task, 're-anchor: the task capture moved').toBeGreaterThan(-1);
    expect(cabinet).toBeLessThan(notes);
    expect(notes).toBeLessThan(capture);
    expect(capture).toBeLessThan(task);
  });

  it('the note is sent to the chat it was asked from, under the chat OWN identity', () => {
    // His answer 3a is a property of the SEND CALL: the payload carries a
    // note id and nothing else, and the person is re-derived from the chat.
    expect(handlers).toContain('const staff = await staffForChat(chatId);');
    expect(handlers).toContain('void deliverNote(ctx, chatId, noteId, staff.id);');
    expect(read('src/modules/platform/telegram/note-send.ts')).toContain(
      'const found = await noteWithFiles(noteId, actorId);',
    );
  });

  it('the send is dispatched OFF the middleware — the poller is sequential', () => {
    // Several megabytes of upload awaited inside a callback handler holds
    // every customer's cabinet tap, every /start and every arrival flow with
    // it (#706, round 101's own outage).
    expect(handlers).toMatch(/void deliverNote\(/);
    expect(handlers).toContain("await ctx.answerCallbackQuery({ text: '📤 Yuborilmoqda…' });");
  });

  it('every Telegram call in the sender carries a deadline', () => {
    const sender = read('src/modules/platform/telegram/note-send.ts');
    expect(sender).toContain('AbortSignal.timeout(SEND_TIMEOUT_MS)');
    // …and a 429 is a WAIT, not a failure: a multi-part note is a burst of up
    // to a dozen messages and there is no throttler installed.
    expect(sender).toContain('err.error_code === 429');
  });

  it('the file download the capture makes has a deadline too', () => {
    expect(handlers).toContain('AbortSignal.timeout(FILE_DOWNLOAD_MS)');
  });

  it('one collector at a time, in BOTH directions', () => {
    // A note capture while a calc collection is live is refused in words; and
    // the calc doors refuse while a capture is live, or the capture ages out
    // silently taking whatever was typed with it.
    expect(handlers).toContain('if (await refuseWhileCapturing(ctx, chatId)) return;');
    expect(handlers).toContain("if (activeIntake(chatId)) {");
  });

  it('a media group caches its ids POSITIONALLY, and only when the lengths agree', () => {
    // The one path that can hand a customer the WRONG warehouse's address
    // sheet: the response is an array, and a mis-mapped index writes photo
    // A's id onto attachment B with a cache that looks healthy afterwards.
    const sender = read('src/modules/platform/telegram/note-send.ts');
    expect(sender).toContain('if (out.length === step.files.length) {');
  });

  it('the note sender never buffers a file — it streams from the object store', () => {
    expect(read('src/modules/platform/telegram/note-send.ts')).toContain(
      'new InputFile(() => getStorage().getStream(file.storageKey), file.fileName)',
    );
  });
});
