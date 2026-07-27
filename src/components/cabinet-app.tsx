'use client';

import { useCallback, useEffect, useState } from 'react';
import { clientLabels, statusLabel, type ClientLabels } from '@/modules/platform/telegram/client-labels';
import type { CabinetPayload } from '@/modules/wms/client-cabinet/miniapp';

/**
 * What the customer sees (owner: "kubi kilosi soni rasimi hammasini to'liq
 * ko'rsa yaxshi bo'lar edi … chiroyli interface qilib bersak zor bo'lardi").
 *
 * Three tabs over one fetch: a client on a mobile connection in Tashkent pays
 * for one round trip and then swipes instantly. The identity is the signed
 * `initData` blob, sent as a header on every call — never a client id in a
 * URL, which is a client id somebody can change.
 *
 * Deliberately absent: where the truck is. The owner asked for that to wait
 * until every client can see their own cargo on a real map.
 */

type Tab = 'cargo' | 'balance' | 'history';

interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  colorScheme?: string;
  initDataUnsafe?: { user?: { language_code?: string } };
}

function webApp(): TelegramWebApp | null {
  return (globalThis as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null;
}

/**
 * Telegram's signed blob and its language hint travel INSIDE the state rather
 * than beside it.
 *
 * Both exist only in the browser, so a first render that used them would
 * differ from the server's and React would throw the whole tree away — inside
 * Telegram that reads as a blank app. Carrying them on the state `load` sets
 * means the first paint is identical on both sides and they appear in the same
 * render as the data they belong to.
 */
type State =
  | { kind: 'loading'; hint?: string }
  | { kind: 'outside'; hint?: string }
  | { kind: 'error'; blob: string; hint?: string; status?: number }
  | { kind: 'ready'; blob: string; data: CabinetPayload };

export function CabinetApp() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('cargo');

  const load = useCallback(async (blob: string, hint?: string) => {
    // No blob at all means the page was opened in an ordinary browser rather
    // than inside Telegram. Said plainly rather than as an error: nothing is
    // wrong, it is simply the wrong door.
    if (!blob) {
      setState({ kind: 'outside' });
      return;
    }
    setState({ kind: 'loading', hint });
    try {
      const res = await fetch('/api/cabinet/data', {
        headers: { 'x-telegram-init-data': blob },
        cache: 'no-store',
      });
      if (!res.ok) {
        setState({ kind: 'error', blob, hint, status: res.status });
        return;
      }
      setState({ kind: 'ready', blob, data: (await res.json()) as CabinetPayload });
    } catch {
      setState({ kind: 'error', blob, hint });
    }
  }, []);

  useEffect(() => {
    const app = webApp();
    app?.ready();
    app?.expand();
    // `load` sets state on its first line when there is no blob, which the
    // lint rule sees as a cascading render. It is the case the rule's own
    // escape hatch is for: whether Telegram is here AT ALL is external state
    // that exists only in the browser, and deciding it during render would
    // make the server's paint differ from the client's. One extra render at
    // mount, none after.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(app?.initData ?? '', app?.initDataUnsafe?.user?.language_code);
  }, [load]);

  // Until the client's own choice arrives with the data, Telegram's own
  // interface language is the best guess at what they read.
  const t = clientLabels(state.kind === 'ready' ? state.data.locale : state.hint);

  if (state.kind === 'outside') return <Notice text={t.openInTelegram} />;
  if (state.kind === 'loading') return <Notice text={t.loading} />;
  if (state.kind === 'error') {
    return (
      <Notice text={state.status === 403 ? t.notLinkedApp : t.loadError}>
        {state.status !== 403 && (
          <button
            type="button"
            className="cab-btn"
            onClick={() => void load(state.blob, state.hint)}
          >
            {t.retry}
          </button>
        )}
      </Notice>
    );
  }

  const { data, blob } = state;
  return (
    <>
      <header className="cab-head">
        <strong>{t.appTitle}</strong>
        <div className="cab-totals">
          <div className="cab-total">
            <b>{data.totals.boxes}</b>
            <span>{t.totalBoxes}</span>
          </div>
          <div className="cab-total">
            <b>{data.totals.weightKg}</b>
            <span>{t.kg}</span>
          </div>
          <div className="cab-total">
            <b>{data.totals.volumeM3}</b>
            <span>{t.m3}</span>
          </div>
        </div>
        <div className="cab-tabs" role="tablist">
          {(
            [
              ['cargo', t.btnCargo],
              ['balance', t.btnBalance],
              ['history', t.btnHistory],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className="cab-tab"
              data-testid={`cab-tab-${key}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="cab-body">
        {data.clients.map((client) => (
          <section key={client.id}>
            {/* Only worth a heading when the person holds more than one code —
                the owner's reality: 777, 555, 444 in one pair of hands. */}
            {data.clients.length > 1 && (
              <h2 className="cab-code">
                {client.clientCode} — {client.name}
              </h2>
            )}

            {tab === 'cargo' &&
              (client.cargo.length === 0 ? (
                <p className="cab-empty">{t.noCargo}</p>
              ) : (
                client.cargo.map((lot) => (
                  <Lot key={lot.lotId} lot={lot} t={t} initData={blob} />
                ))
              ))}

            {tab === 'balance' && <Balance client={client} t={t} />}

            {tab === 'history' &&
              (client.history.length === 0 ? (
                <p className="cab-empty">{t.noHistory}</p>
              ) : (
                <div className="cab-lot">
                  {client.history.map((row, i) => (
                    <div className="cab-row" key={i}>
                      <span>
                        {row.letter ?? '·'} — {row.productNameRu?.trim() || row.productNameZh}
                      </span>
                      <span>
                        {row.n} {t.pieces} · {new Date(row.lastAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
          </section>
        ))}
      </div>
    </>
  );
}

function Lot({
  lot,
  t,
  initData,
}: {
  lot: CabinetPayload['clients'][number]['cargo'][number];
  t: ClientLabels;
  initData: string;
}) {
  return (
    <article className="cab-lot" data-testid="cab-lot">
      <div className="cab-lot-top">
        <span className="cab-letter">{lot.letter ?? '·'}</span>
        <span className="cab-name">{lot.productNameRu?.trim() || lot.productNameZh}</span>
      </div>
      <div className="cab-dims">
        <span>
          {lot.total} {t.pieces}
        </span>
        <span>
          {lot.weightKg} {t.kg}
        </span>
        <span>
          {lot.volumeM3} {t.m3}
        </span>
        {lot.warehouseCodes.length > 0 && <span>📍 {lot.warehouseCodes.join(', ')}</span>}
      </div>
      <div className="cab-chips">
        {Object.entries(lot.statuses).map(([status, n]) => (
          <span className="cab-chip" key={status}>
            <b>{n}</b> {statusLabel(status, t)}
          </span>
        ))}
      </div>
      {lot.photoCount > 0 && <Photos lotId={lot.lotId} count={lot.photoCount} initData={initData} />}
    </article>
  );
}

/**
 * Photographs, fetched WITH the signed header rather than by URL.
 *
 * An `<img src>` cannot carry a header, so the alternative would be putting
 * `initData` in the query string — where it lands in logs and browser history.
 * Fetching each thumbnail as a blob keeps the credential out of every URL, and
 * the object URLs are released on unmount.
 */
function Photos({ lotId, count, initData }: { lotId: string; count: number; initData: string }) {
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    void (async () => {
      // A cap, not a page: nobody scrolls forty thumbnails of their own boxes,
      // and a lot with that many would cost a client real megabytes.
      for (let i = 0; i < Math.min(count, 8); i += 1) {
        try {
          const res = await fetch(`/api/cabinet/photo/${lotId}?i=${i}`, {
            headers: { 'x-telegram-init-data': initData },
          });
          if (!res.ok) continue;
          const url = URL.createObjectURL(await res.blob());
          made.push(url);
          if (cancelled) break;
          setUrls((prev) => [...prev, url]);
        } catch {
          /* one missing photo must not empty the strip */
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [lotId, count, initData]);

  if (urls.length === 0) return null;
  return (
    <div className="cab-photos" data-testid="cab-photos">
      {urls.map((url) => (
        // eslint-disable-next-line @next/next/no-img-element -- a blob URL, not a file the optimiser can reach
        <img key={url} src={url} alt="" loading="lazy" />
      ))}
    </div>
  );
}

function Balance({
  client,
  t,
}: {
  client: CabinetPayload['clients'][number];
  t: ClientLabels;
}) {
  const owes = client.balanceUsd > 0.009;
  return (
    <>
      <div className="cab-balance">
        <b>${Math.abs(client.balanceUsd).toFixed(2)}</b>
        <span>
          {owes ? t.debtYes : client.balanceUsd < -0.009 ? t.credit : t.debtNo}
        </span>
      </div>
      {client.recent.length > 0 && (
        <div className="cab-lot">
          <div className="cab-code">{t.recentMoves}</div>
          {client.recent.map((r, i) => (
            <div className="cab-row" key={i}>
              <span>
                {r.txDate} · {r.type === 'charge' ? t.charged : t.paid}
              </span>
              <span>
                {r.amount} {r.currency}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Notice({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="cab-body">
      <p className="cab-empty" data-testid="cab-notice">
        {text}
      </p>
      {children}
    </div>
  );
}
