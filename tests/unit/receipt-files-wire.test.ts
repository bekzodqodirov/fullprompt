import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupHistory, removedFile } from '@/modules/platform/audit/history';
import { RECEIPT_DEAL_ANCHOR } from '@/modules/platform/notifications/receipt-arrival';
import { bornWithVerdict } from '@/modules/wms/receipts/deal-state';

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
    // …and the way BACK from the new-deal form is a query the block reads: a
    // server action's redirect drops a `#fragment` (the browser spec found
    // the card opening at its top).
    expect(read('src/app/(protected)/bitimlar/actions.ts')).toContain('redirect(`/receipts/${receiptId}?bitim=1`);');
    expect(read('src/app/(protected)/bitimlar/actions.ts')).not.toContain('#bitim`)');
    expect(read('src/app/(protected)/receipts/[id]/deal-link.tsx')).toContain("get('bitim') !== '1'");
  });

  it('a file sent through the bot is stored as a PAPER, and its delete rule is stated', () => {
    expect(read(`${T}/receipt-files-door.ts`)).toContain('asPaper: true,');
    expect(read('src/modules/platform/files/service.ts')).toContain("kind: isPhoto && !opts.asPaper ? 'photo' : 'file',");
    expect(read('src/modules/platform/files/service.ts')).toMatch(/\n  receipt: 'shared',\n/);
  });
});

describe('the deal cell inside the card’s «ties» (after the merge with docs/PRIXOD-KARTA.md)', () => {
  // Comments out: each rule below is explained in the component in the rule's own words.
  const link = read('src/app/(protected)/receipts/[id]/deal-link.tsx')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('«Saqlash» is drawn while a deal of ANOTHER client stands, whatever the select holds', () => {
    // Main's idiom alone — «only once the answer differs from what is shown» — never draws it there:
    // `current` is null and the select opens on its empty option, so the prixod could be moved onto
    // a deal of this client but never taken OFF the other client's.
    expect(link).toContain("{(dealId !== (current?.id ?? '') || foreign !== null) && (");
    expect(link).not.toMatch(/\{dealId !== \(current\?\.id \?\? ''\) && \(/);
  });

  it('the cell keeps the ties’ anatomy: label, ONE value line, the control row — and its sentences under it', () => {
    const at = (testid: string) => link.indexOf(`data-testid="${testid}"`);
    const pick = at('receipt-deal-pick');
    expect(pick).toBeGreaterThan(-1);
    // The void is the one sentence above the control: on a voided prixod there is no factory-trip
    // select for «Bitim»'s to stand level with, and it is what the landing must show first.
    expect(at('receipt-deal-voided')).toBeGreaterThan(-1);
    expect(at('receipt-deal-voided')).toBeLessThan(pick);
    // The foreign sentence is advice about what to pick: under the row, before the new-deal door.
    expect(at('receipt-deal-foreign')).toBeGreaterThan(pick);
    expect(at('receipt-deal-foreign')).toBeLessThan(at('receipt-deal-new'));
    expect(at('receipt-deal-new')).toBeLessThan(at('receipt-deal-compensation'));
  });

  it('the foreign sentence offers only what this reader is offered', () => {
    expect(link).toContain("{t(newDealHref ? 'dealForeign' : 'dealForeignPick', { code: foreign.code })}");
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(read(`messages/${locale}.json`)) as { receipts: Record<string, string>; deals: Record<string, string> };
      const unlink = bundle.deals.unlink!;
      // Both name the empty option by ITS label — the door the sentence sends the reader to.
      expect(bundle.receipts.dealForeign).toContain(unlink);
      expect(bundle.receipts.dealForeignPick).toContain(unlink);
      expect(bundle.receipts.dealForeign).toContain('{code}');
      expect(bundle.receipts.dealForeignPick).toContain('{code}');
      // …and the one for a reader with no new-deal door is the shorter of the two.
      expect(bundle.receipts.dealForeignPick!.length).toBeLessThan(bundle.receipts.dealForeign!.length);
    }
  });

  it('the landing frame is an outline with an offset — the cell has no card of its own to wear a ring', () => {
    expect(link).toContain('target:outline target:outline-2 target:outline-offset-4 target:outline-brand-500');
    // The ?bitim=1 landing wears the SAME four classes, written out so that Tailwind can see them.
    expect(link).toContain("el.classList.add('outline', 'outline-2', 'outline-offset-4', 'outline-brand-500');");
    expect(link).not.toMatch(/ring-2|ring-brand/);
    expect(link).toContain('scroll-mt-20');
  });
});

describe('the «Fayllar» card goes with its last file', () => {
  // Comments out (#725): a commented-out call must not keep these green (the review, T3).
  const code = (file: string) =>
    read(file)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('a reader who may not attach and removes the last file asks the page again — decided from the list the deletes LEFT', () => {
    const panel = code('src/components/attachments-panel.tsx');
    // «May not ATTACH» — its own flag since the owner's «4 b» (2026-11-12): on the card every reader of a live
    // prixod may attach while only an editor removes another's file, so `editable` no longer answers it.
    expect(panel).toContain('if (refreshWhenEmpty && !attachable && removedAny && items.length === 0) router.refresh();');
    expect(panel).toContain('attachable = editable,');
    expect(panel).toContain('{attachable && (');
    expect(panel).toContain('setRemovedAny(true);');
    // Not from the render a press closed over: two ✕ before the first answer each saw the other file (XF-3).
    expect(panel).not.toMatch(/const left = items\.filter/);
    // Only the prixod card asks for it: its «Fayllar» card is drawn only while there is something
    // to list or to attach (`showFiles`), so an emptied one is a heading over nothing.
    const page = code('src/app/(protected)/receipts/[id]/page.tsx');
    expect(page).toMatch(/removableIds=\{ownFileIds\}\n\s+refreshWhenEmpty\n/);
    // Who may attach is the bot's own rule, one predicate for both doors (4b) — never `canEdit`, which also
    // draws the ✏️ lot form and ✕ on everybody's files.
    expect(page).toContain('const mayAttach = mayAttachReceiptFile(receipt) && mayAddReceiptFiles(actor);');
    expect(page).toContain('const showFiles = mayAttach || receiptFiles.length > 0;');
    expect(page).toMatch(/editable=\{canEdit\}\n\s+attachable=\{mayAttach\}/);
  });
});

describe('the ties’ two cells start from what is STORED (the merged card’s review, XF-1 / XF-2)', () => {
  const page = read('src/app/(protected)/receipts/[id]/page.tsx')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('both cells are keyed on the facts they draw, so a client correction that revalidates without a remount resets them', () => {
    expect(page).toContain("key={`deal:${receipt.clientId ?? ''}:${receipt.dealId ?? ''}`}");
    expect(page).toContain("key={`calc:${ownDeal?.id ?? ''}:${receipt.calcRequestId ?? ''}`}");
  });

  it('«Hisob» offers the calculations of the prixod’s OWN deal, and stays drawn while a link stands', () => {
    expect(page).toContain('await calcLinkOptions(ownDeal?.id ?? null)');
    expect(page).not.toContain('calcLinkOptions(receipt.dealId)');
    expect(page).toContain('const showCalcRow = mayLinkCalc && (calcOptions.length > 0 || receipt.calcRequestId !== null);');
  });
});

describe('a deal opened FOR a prixod (the card’s «+ Yangi bitim ochish»)', () => {
  const OWN = 'client-1';
  const row = (over: Partial<Parameters<typeof bornWithVerdict>[0]> = {}) => ({
    status: 'confirmed',
    clientId: OWN,
    dealId: null,
    dealClientId: null,
    ...over,
  });

  it('ONE rule says «this prixod may still be born with a deal» — and a deal of another client on the row is not in its way', () => {
    expect(bornWithVerdict(row(), OWN)).toBeNull();
    // A client correction left the old client's deal on the row: no deal of this prixod's.
    expect(bornWithVerdict(row({ dealId: 'd-1', dealClientId: 'client-0' }), OWN)).toBeNull();
    // Its OWN deal — somebody filed it since the form was drawn.
    expect(bornWithVerdict(row({ dealId: 'd-2', dealClientId: OWN }), OWN)).toBe('receipt_has_deal');
    expect(bornWithVerdict(row({ status: 'voided' }), OWN)).toBe('receipt_not_confirmed');
    expect(bornWithVerdict(row({ status: 'draft' }), OWN)).toBe('receipt_not_confirmed');
    expect(bornWithVerdict(row({ clientId: 'client-2' }), OWN)).toBe('client_mismatch');
    expect(bornWithVerdict(row({ clientId: null }), OWN)).toBe('client_mismatch');
    // The order: whose it is, then whether it stands, then its deal.
    expect(bornWithVerdict(row({ clientId: 'client-2', status: 'voided', dealId: 'd', dealClientId: 'client-2' }), OWN)).toBe(
      'client_mismatch',
    );
  });

  it('the rule is asked three times — the page, the action BEFORE the deal exists, the link under the row lock', () => {
    // Source-shape: each of these «works» without the ask, and the failure is
    // a prixod silently moved off the deal a colleague had just chosen.
    const page = read('src/app/(protected)/bitimlar/new/page.tsx');
    expect(page).toContain('bornWithVerdict(');
    const actions = read('src/app/(protected)/bitimlar/actions.ts');
    const create = actions.slice(actions.indexOf('export async function createDealAction'));
    const body = create.slice(0, create.indexOf('\nexport ', 10));
    const ask = body.indexOf('await bornWithRefusal(receiptId, parsed.data.clientId)');
    const made = body.indexOf('id = await createDeal(');
    expect(ask).toBeGreaterThan(-1);
    expect(made).toBeGreaterThan(ask);
    // …and the answer is OBEYED, not only asked for (the browser spec walks
    // it: a stale form is refused where the person is, and no deal is minted).
    expect(body).toMatch(
      /const refused = await bornWithRefusal\(receiptId, parsed\.data\.clientId\);\s*if \(refused\) throw new DealError\(refused\);/,
    );
    expect(body).toContain('await linkReceipt(receiptId, id, ctx, ftlDoorFor(actor), { bornWith: true });');
    const service = read('src/modules/wms/deals/service.ts');
    const link = service.slice(service.indexOf('export async function linkReceipt('));
    expect(link.slice(0, link.indexOf('\nexport ', 10))).toMatch(/if \(opts\.bornWith && dealId && dealClientId\) \{[\s\S]*?FOR NO KEY UPDATE[\s\S]*?bornWithVerdict\(/);
  });

  it('past the deal’s creation NOTHING becomes an error page: the link is caught whole, and the deal’s card says the prixod is not on it', () => {
    const actions = read('src/app/(protected)/bitimlar/actions.ts');
    const create = actions.slice(actions.indexOf('export async function createDealAction'));
    const body = create.slice(0, create.indexOf('\nexport ', 10));
    // No rethrow in the link's catch: the old `if (!(err instanceof DealError)) throw err;`
    // put a dropped connection on an error page over a form whose next press
    // minted a SECOND deal.
    const from = body.indexOf('{ bornWith: true }');
    const to = body.indexOf('if (state.ok && id && receiptId && linked)');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const caught = body.slice(from, to);
    expect(caught).toContain('} catch (err) {');
    expect(caught).not.toContain('throw err');
    expect(body).toContain('redirect(receiptId ? `/bitimlar/${id}?prixod=yoq` : `/bitimlar/${id}`);');
    expect(read('src/app/(protected)/bitimlar/[id]/page.tsx')).toContain("prixod === 'yoq'");
  });

  it('the prixod card offers the link only where the form would take the prixod, and says «voided» in the block itself', () => {
    const card = read('src/app/(protected)/receipts/[id]/page.tsx');
    expect(card).toContain("!ownDeal && receipt.status === 'confirmed' && mayEditDealTerms(actor.permissions)");
    expect(card).toContain("voided={receipt.status === 'voided'}");
    // «The prixod's deal» on the card is the message's own rule.
    expect(card).toContain('ownDealOf({ dealId: linkedDeal.id, dealClientId: linkedDeal.clientId }, receipt.clientId)');
  });
});

describe('the History of a prixod’s files', () => {
  it('a removed file names itself — a bare «o‘chirdi» on a prixod card reads as cargo data deleted', () => {
    expect(removedFile({ action: 'delete', before: { attachmentId: 'a-1', fileName: 'invoice.pdf' } })).toEqual([
      { key: 'fileName', before: 'invoice.pdf', after: null },
    ]);
    // Only a DELETE, only a file: nothing else of a delete row's `before` is this card's to print.
    expect(removedFile({ action: 'update', before: { fileName: 'invoice.pdf' } })).toEqual([]);
    expect(removedFile({ action: 'delete', before: { name: 'Lead', phone: '+998' } })).toEqual([]);
    expect(removedFile({ action: 'delete', before: null })).toEqual([]);
    expect(removedFile({ action: 'delete', before: { fileName: '' } })).toEqual([]);
    // …and the History's own grouping prints it: the function existing is not the line being drawn.
    const [group] = groupHistory([
      {
        id: '1',
        actorId: 'u-1',
        actorName: 'Dilnoza',
        action: 'delete',
        before: { attachmentId: 'a-1', fileName: 'invoice.pdf' },
        after: null,
        createdAt: new Date('2026-11-11T10:00:00Z'),
      },
    ]);
    expect(group!.changes).toEqual([{ key: 'fileName', before: 'invoice.pdf', after: null }]);
  });

  it('a bot file is recorded under the name it is STORED under — the one its tile on the card reads', () => {
    const door = read(`${T}/receipt-files-door.ts`);
    expect(door).toContain("fileName: saved.fileName ?? (file.isPhoto ? 'rasm' : (file.fileName ?? 'fayl')),");
    const saver = read(`${T}/calc-files.ts`);
    expect(saver).toContain('fileName: storedName,');
    expect(saver).toContain('return { isPhoto, body, attachmentId: id, fileName: storedName };');
  });
});

