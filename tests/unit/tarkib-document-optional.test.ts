import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The client's document is OPTIONAL (0143; the owner, 2026-11-10 — «tarkib
 * qo'shganda tasdiq so'rash rasm file»; docs/TARKIB-TUZATISH.md §2): the two
 * halves an integration test on a migrated database cannot reach.
 *
 * (1) ONE MIGRATION BEHIND. The save with no document is a NULL the old
 * column still refuses (23502, measured on postgres.js: `table_name`
 * `lot_compositions`, `column_name` `attachment_id`). The action answers
 * «server yangilanmoqda» for THAT column and rethrows any other NULL.
 * (2) THE EDITOR'S SHAPE: only a drawn chip's id travels, and an upload that
 * throws says so.
 */

const thrown = vi.hoisted(() => ({ err: null as unknown }));

vi.mock('@/modules/platform/rbac/authorize', async (original) => ({
  ...(await original<typeof import('@/modules/platform/rbac/authorize')>()),
  requireActor: async () => ({ id: '00000000-0000-4000-8000-000000000001', permissions: new Set(['ved.docs']) }),
}));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'tarkib-document-optional.test' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/modules/wms/receipts/lot-composition', async (original) => ({
  ...(await original<typeof import('@/modules/wms/receipts/lot-composition')>()),
  saveComposition: async () => {
    throw thrown.err;
  },
}));

import { saveLotCompositionAction } from '@/app/(protected)/receipts/[id]/composition-actions';

const PAYLOAD = { lotId: '00000000-0000-4000-8000-0000000000aa' };

describe('a tarkib saved with no document, one migration behind', () => {
  beforeEach(() => {
    thrown.err = null;
  });

  it('the old NOT NULL on lot_compositions.attachment_id answers «server_behind», never the error page', async () => {
    thrown.err = Object.assign(new Error('null value in column "attachment_id"'), {
      code: '23502',
      table_name: 'lot_compositions',
      column_name: 'attachment_id',
    });
    expect(await saveLotCompositionAction(PAYLOAD)).toEqual({ ok: false, error: 'server_behind' });
  });

  it('…also when drizzle wrapped the driver’s error', async () => {
    thrown.err = Object.assign(new Error('Failed query'), {
      cause: { code: '23502', table_name: 'lot_compositions', column_name: 'attachment_id' },
    });
    expect(await saveLotCompositionAction(PAYLOAD)).toEqual({ ok: false, error: 'server_behind' });
  });

  it('a NULL in any OTHER column is a fault and is rethrown — by name, never a blanket 23502', async () => {
    thrown.err = Object.assign(new Error('null value in column "saved_by"'), {
      code: '23502',
      table_name: 'lot_compositions',
      column_name: 'saved_by',
    });
    await expect(saveLotCompositionAction(PAYLOAD)).rejects.toMatchObject({ code: '23502' });
    thrown.err = Object.assign(new Error('null value'), { code: '23502', table_name: 'receipt_lots', column_name: 'attachment_id' });
    await expect(saveLotCompositionAction(PAYLOAD)).rejects.toMatchObject({ code: '23502' });
  });
});

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

describe('the document is asked of nobody — the shape', () => {
  const service = read('src/modules/wms/receipts/lot-composition.ts');
  const panel = read('src/app/(protected)/receipts/[id]/composition-panel.tsx');

  it('`document_required` is gone from the service, the editor and the four bundles — deleted, not unreferenced', () => {
    expect(service).not.toContain('document_required');
    expect(panel).not.toContain('document_required');
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
        tarkib: { errors: Record<string, string>; document: string };
      };
      expect(Object.keys(bundle.tarkib.errors), locale).not.toContain('document_required');
    }
  });

  it('a cited document is still locked and checked — inside the `attachmentId !== null` branch only', () => {
    const from = service.indexOf('if (attachmentId !== null) {');
    expect(from).toBeGreaterThan(-1);
    const branch = service.slice(from, service.indexOf('const header = await lockCompositionHeader', from));
    expect(branch).toContain('FOR KEY SHARE');
    expect(branch).toContain("'document_not_on_receipt'");
    expect(branch).toContain("'document_is_photo'");
  });

  it('the editor posts a document only when its chip is DRAWN (a stale draft’s id never travels unseen)', () => {
    expect(panel).toContain('attachmentId: doc !== null && docs.some((d) => d.id === doc) ? doc : null');
  });

  it('an upload that THROWS speaks: `addDocument` has a catch, and the two named refusals keep their own words', () => {
    const at = panel.indexOf('async function addDocument(');
    const body = panel.slice(at, panel.indexOf('async function removeDocument(', at));
    expect(body).toMatch(/catch\s*\{[\s\S]*setRefusal\(\{ error: 'upload_failed' \}\)/);
    expect(body).toContain("res.error === 'failed' ? 'upload_failed' : res.error");
    expect(panel).toContain("case 'too_large':");
    expect(panel).toContain("case 'unsupported_type':");
  });
});
