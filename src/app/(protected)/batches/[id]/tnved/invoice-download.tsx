'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Overlay } from '@/components/ui/overlay';
import { followDownload } from '@/components/download-url';
import { mergeQuery, type InvoiceGroupsView } from '@/modules/wms/documents/invoice-rows';

/**
 * «Invoys» on the Bojxona tab (the owner's item 6, 2026-11-10): «TNVED kod
 * bir xil bo'lib nomi farq qilsa — alohida oyna ochilsin, shunday holatlar
 * bor bo'lsa shularni ko'rsatib qo'shaymi yo'qmi deb so'rasin va invoice
 * bersin».
 *
 * Press → the list of codes that hold two or more rows (`…/invoice/groups`,
 * the same source rows the file is written from). None → the file at once,
 * as before. Some → this dialog; an unanswered group stays «Alohida», which
 * is what a bare address prints. The answers travel in the file's ADDRESS
 * (`?merge=code.sig,…`), so the download still goes through a signed link —
 * Telegram's in-app browser cannot fetch a file any other way.
 *
 * A BUTTON, never a link with an onClick: the layout's download listener
 * takes a press on an `/api/…` link in the capture phase, before React hears
 * it — on a phone the file would come unmerged AND the dialog would open.
 *
 * The device remembers this truck's last answers (a convenience, never a
 * record): a group is pre-selected only while its key — code AND the names
 * it was shown with — is still the same.
 *
 * The file is asked for only right after the LIST was read — at the press
 * and again at «Invoysni olish» (the review of the built round, two defects
 * with one cure). A download is a navigation of THIS tab: when the address
 * answers with a page instead of a file — the server recreated by a deploy,
 * the session run out — the Bojxona screen is replaced by that page and
 * every code typed or suggested and not saved goes with it. So a list that
 * cannot be read is SAID and nothing is followed; the person stays where
 * they are. And a dialog left open while a colleague saved a code or a
 * tarkib would have sent answers about a list that no longer exists: the
 * second read shows the new list and asks again instead of handing over a
 * file that ignores the answer.
 */

const STORE = (batchId: string) => `gsr.invoys.merge.${batchId}`;

function remembered(batchId: string, view: InvoiceGroupsView): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORE(batchId));
    const keys: unknown = raw ? JSON.parse(raw) : [];
    const known = new Set(view.groups.map((g) => g.key));
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string' && known.has(k)) : []);
  } catch {
    return new Set();
  }
}

function remember(batchId: string, keys: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORE(batchId), JSON.stringify([...keys]));
  } catch {
    /* a private window or a full store: the next press simply asks afresh */
  }
}

/** Codes typed or suggested on this screen and not saved yet (the editor's own marker). */
function unsavedCodes(): number {
  const marker = document.querySelector('[data-tnved-unsaved]');
  const n = Number(marker?.getAttribute('data-tnved-unsaved') ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function InvoiceDownload({ batchId, label }: { batchId: string; label: string }) {
  const t = useTranslations('invoys');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<InvoiceGroupsView | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [unsaved, setUnsaved] = useState(0);
  const [listFailed, setListFailed] = useState(false);
  /** The list changed while the dialog stood open — it is shown afresh and asked again. */
  const [moved, setMoved] = useState(false);
  const base = `/api/batches/${batchId}/invoice`;

  /** The asked groups, or null when the list cannot be read (offline, a deploy, a session that ran out). */
  async function readGroups(): Promise<InvoiceGroupsView | null> {
    try {
      const res = await fetch(`${base}/groups`, { cache: 'no-store' });
      if (!res.ok) return null;
      return (await res.json()) as InvoiceGroupsView;
    } catch {
      return null;
    }
  }

  async function press() {
    if (busy) return;
    setBusy(true);
    setListFailed(false);
    setMoved(false);
    const drafts = unsavedCodes();
    setUnsaved(drafts);
    try {
      const body = await readGroups();
      // Nothing is followed: the file's address would fail for the same
      // reason, and a failed download REPLACES this screen.
      if (!body) {
        setListFailed(true);
        return;
      }
      if (body.groups.length === 0 && drafts === 0) {
        await followDownload(base);
        return;
      }
      setView(body);
      setChosen(remembered(batchId, body));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  const query = view ? mergeQuery(view, chosen) : '';
  const set = (key: string, merge: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (merge) next.add(key);
      else next.delete(key);
      return next;
    });

  async function download() {
    if (!view || query === null || busy) return;
    setBusy(true);
    setListFailed(false);
    try {
      const now = await readGroups();
      if (!now) {
        setListFailed(true);
        return;
      }
      if (now.fp !== view.fp) {
        // The answers that still name a group stand; the rest are asked again.
        const known = new Set(now.groups.map((g) => g.key));
        setView(now);
        setChosen(new Set([...chosen].filter((key) => known.has(key))));
        setMoved(true);
        return;
      }
      setMoved(false);
      remember(batchId, chosen);
      await followDownload(`${base}${query}`);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const groups = view?.groups ?? [];
  return (
    <>
      <button
        type="button"
        className="btn-secondary flex-1 whitespace-nowrap px-3"
        data-testid="invoice-download"
        disabled={busy}
        onClick={() => void press()}
      >
        {label}
      </button>
      {listFailed && !open && (
        <p className="basis-full text-xs font-semibold text-bad" data-testid="invoice-list-failed">
          {t('listFailed')}
        </p>
      )}
      {/* Kept MOUNTED and toggled: an Overlay mounted already open closes
          itself on the frame it appears (its close-on-navigation effect). */}
      <Overlay
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        closeLabel={t('close')}
        testId="invoice-dialog"
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl bg-surface-raised shadow-xl md:inset-x-auto md:left-1/2 md:top-1/2 md:bottom-auto md:max-h-[80dvh] md:w-[40rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
      >
        <div className="space-y-1 border-b border-line p-4 pb-3">
          <p className="text-base font-bold">{t('title')}</p>
          {groups.length > 0 && <p className="text-sm text-ink-500">{t('intro')}</p>}
          {unsaved > 0 && (
            <p className="text-sm font-semibold text-warn" data-testid="invoice-unsaved">
              ⚠ {t('unsaved', { n: unsaved })}
            </p>
          )}
          {moved && (
            <p className="text-sm font-semibold text-warn" data-testid="invoice-moved">
              ⚠ {t('moved')}
            </p>
          )}
          {listFailed && (
            <p className="text-sm font-semibold text-bad" data-testid="invoice-list-failed">
              {t('listFailed')}
            </p>
          )}
          {view?.sent && <p className="text-sm text-warn">{t('sent')}</p>}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {groups.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-500">{t('all')}</span>
              <button
                type="button"
                className="btn-secondary"
                data-testid="invoice-merge-all"
                onClick={() => setChosen(new Set(groups.map((g) => g.key)))}
              >
                {t('merge')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                data-testid="invoice-merge-none"
                onClick={() => setChosen(new Set())}
              >
                {t('apart')}
              </button>
            </div>
          )}
          {groups.map((group) => {
            const merge = chosen.has(group.key);
            return (
              <section
                key={group.key}
                className="space-y-2 rounded-xl border border-line p-3"
                data-testid="invoice-group"
                data-key={group.key}
                data-merge={merge ? 'yes' : 'no'}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="font-mono text-sm font-semibold">{group.code}</p>
                  {group.customs && (
                    <p className="text-xs text-ink-500">
                      {group.customs.kind === 'client'
                        ? t('customsClient', { name: group.customs.name })
                        : t('customsFirm', { name: group.customs.name })}
                    </p>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {group.names.map((row, i) => (
                    <li key={`${row.name}|${row.unit}|${i}`} className="text-sm">
                      <span className="break-words font-medium">{row.name}</span>
                      <span className="text-ink-500">
                        {' '}
                        · {row.quantity} {row.unit}
                        {row.unit === 'шт' ? ` · ${(row.kgTenths / 10).toFixed(1)} кг` : ''}
                      </span>
                      <span className="block break-words text-xs text-ink-500">{row.labels.join(', ')}</span>
                    </li>
                  ))}
                </ul>
                {group.merged.mixedUnits && <p className="text-xs text-warn">⚠ {t('mixedUnits')}</p>}
                {merge && (
                  <p className="break-words text-xs text-ink-500" data-testid="invoice-merged-as">
                    {t('mergedAs', {
                      name: group.merged.name,
                      quantity: String(group.merged.quantity),
                      unit: group.merged.unit,
                    })}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={merge ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
                    aria-pressed={merge}
                    data-testid="invoice-merge-yes"
                    onClick={() => set(group.key, true)}
                  >
                    {t('merge')}
                  </button>
                  <button
                    type="button"
                    className={merge ? 'btn-secondary flex-1' : 'btn-primary flex-1'}
                    aria-pressed={!merge}
                    data-testid="invoice-merge-no"
                    onClick={() => set(group.key, false)}
                  >
                    {t('apart')}
                  </button>
                </div>
              </section>
            );
          })}
          {view && view.red.length > 0 && <p className="text-xs text-ink-500">{t('redNote')}</p>}
          {query === null && <p className="text-sm text-warn">{t('tooMany')}</p>}
        </div>

        <div className="flex gap-2 border-t border-line p-4 pb-safe">
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
            {t('close')}
          </button>
          <button
            type="button"
            className="btn-primary flex-1"
            data-testid="invoice-get"
            disabled={busy || query === null}
            onClick={() => void download()}
          >
            ⬇️ {t('get')}
          </button>
        </div>
      </Overlay>
    </>
  );
}
