'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  clientLabels,
  formatEtaRange,
  stageLabel,
  type ClientLabels,
} from '@/modules/platform/telegram/client-labels';
import { CARGO_STAGES, stageIndex } from '@/modules/wms/client-cabinet/stages';
import type { CabinetPayload } from '@/modules/wms/client-cabinet/miniapp';

/**
 * What the customer sees (owner: "kubi kilosi soni rasimi hammasini to'liq
 * ko'rsa yaxshi bo'lar edi … chiroyli interface qilib bersak zor bo'lardi",
 * then: "web appni o'zida ham UI UX designni maksimal darajada yaxshila").
 *
 * Three tabs over one fetch: a client on a mobile connection in Tashkent pays
 * for one round trip and then swipes instantly. The identity is the signed
 * `initData` blob, sent as a header on every call — never a client id in a
 * URL, which is a client id somebody can change.
 *
 * It is built to feel like part of Telegram rather than like a website inside
 * it: the app's own colours, its haptics, its back button, and a first paint
 * that already has the shape of the answer.
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
  themeParams?: { bg_color?: string; secondary_bg_color?: string };
  initDataUnsafe?: { user?: { language_code?: string } };
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: {
    impactOccurred?: (style: string) => void;
    selectionChanged?: () => void;
  };
  BackButton?: {
    show?: () => void;
    hide?: () => void;
    onClick?: (cb: () => void) => void;
    offClick?: (cb: () => void) => void;
  };
}

function webApp(): TelegramWebApp | null {
  return (globalThis as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null;
}

/** A light tap on anything the client chose to do. Absent outside Telegram. */
function tap(kind: 'select' | 'open' = 'select') {
  const h = webApp()?.HapticFeedback;
  if (kind === 'select') h?.selectionChanged?.();
  else h?.impactOccurred?.('light');
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
  const [zoom, setZoom] = useState<string | null>(null);

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
    // Telegram paints the strip above the page and the area below it in its
    // own colours unless told otherwise, which leaves the app floating in a
    // rectangle of a different shade. Matching them is what makes it read as
    // one screen rather than an embedded website.
    const bg = app?.themeParams?.bg_color;
    if (bg) {
      app?.setHeaderColor?.(bg);
      app?.setBackgroundColor?.(bg);
    }
    // `load` sets state on its first line when there is no blob, which the
    // lint rule sees as a cascading render. It is the case the rule's own
    // escape hatch is for: whether Telegram is here AT ALL is external state
    // that exists only in the browser, and deciding it during render would
    // make the server's paint differ from the client's. One extra render at
    // mount, none after.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(app?.initData ?? '', app?.initDataUnsafe?.user?.language_code);
  }, [load]);

  /**
   * An open photograph is closed by Telegram's OWN back button.
   *
   * On a phone the gesture for "go back" is the one at the top left, and an
   * app that puts a close cross somewhere else is an app people close entirely
   * by mistake.
   */
  useEffect(() => {
    const back = webApp()?.BackButton;
    if (!back) return;
    if (!zoom) {
      back.hide?.();
      return;
    }
    const close = () => setZoom(null);
    back.onClick?.(close);
    back.show?.();
    return () => {
      back.offClick?.(close);
      back.hide?.();
    };
  }, [zoom]);

  // Until the client's own choice arrives with the data, Telegram's own
  // interface language is the best guess at what they read.
  const t = clientLabels(state.kind === 'ready' ? state.data.locale : state.hint);

  if (state.kind === 'outside') return <Notice icon="💬" text={t.openInTelegram} />;
  if (state.kind === 'loading') return <Skeleton />;
  if (state.kind === 'error') {
    return (
      <Notice icon={state.status === 403 ? '🔗' : '⚠️'} text={state.status === 403 ? t.notLinkedApp : t.loadError}>
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
        <div className="cab-title">
          <span>{t.appTitle}</span>
          <small>{data.clients.map((c) => c.clientCode).join(' · ')}</small>
        </div>
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
              onClick={() => {
                tap();
                setTab(key);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="cab-body" key={tab}>
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
                <p className="cab-empty">
                  <span className="cab-empty-icon">📦</span>
                  {t.noCargo}
                </p>
              ) : (
                client.cargo.map((lot) => (
                  <Lot
                    key={lot.lotId}
                    lot={lot}
                    t={t}
                    locale={data.locale}
                    initData={blob}
                    onZoom={setZoom}
                  />
                ))
              ))}

            {tab === 'balance' && <Balance client={client} t={t} />}

            {tab === 'history' &&
              (client.history.length === 0 ? (
                <p className="cab-empty">
                  <span className="cab-empty-icon">🗄</span>
                  {t.noHistory}
                </p>
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

      {zoom && (
        <button
          type="button"
          className="cab-lightbox"
          aria-label={t.close}
          data-testid="cab-lightbox"
          onClick={() => setZoom(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL, not a file the optimiser can reach */}
          <img src={zoom} alt="" />
        </button>
      )}
    </>
  );
}

type CabinetLotView = CabinetPayload['clients'][number]['cargo'][number];

function Lot({
  lot,
  t,
  locale,
  initData,
  onZoom,
}: {
  lot: CabinetLotView;
  t: ClientLabels;
  locale: string | null;
  initData: string;
  onZoom: (url: string) => void;
}) {
  // Sorted biggest-first by the service, so the ladder is drawn for the bulk
  // of the cargo and any remainder is named under it.
  const main = lot.groups[0];
  const at = main ? stageIndex(main.stage) : 0;
  // One 🗓 line per distinct date, not per group: two lots on the same truck
  // would otherwise print the same sentence twice.
  const etas = [
    ...new Map(
      lot.groups
        .filter((g) => g.eta)
        .map((g) => [`${g.eta!.toPlace}|${g.eta!.fromIso}|${g.eta!.toIso}`, g.eta!]),
    ).values(),
  ];
  return (
    <article className="cab-lot" data-testid="cab-lot">
      <div className="cab-lot-top">
        <span className="cab-letter">{lot.letter ?? '·'}</span>
        <span className="cab-name">{lot.productNameRu?.trim() || lot.productNameZh}</span>
      </div>

      <div className="cab-dims">
        <div className="cab-dim">
          <b>{lot.total}</b>
          <span>{t.pieces}</span>
        </div>
        <div className="cab-dim">
          <b>{lot.weightKg}</b>
          <span>{t.kg}</span>
        </div>
        <div className="cab-dim">
          <b>{lot.volumeM3}</b>
          <span>{t.m3}</span>
        </div>
      </div>

      {lot.warehousePlaces.length > 0 && (
        <div className="cab-where">📍 {lot.warehousePlaces.join(', ')}</div>
      )}

      {/* The owner's own ladder — «htoyda qabul → … → olib ketdingiz» — as
          nine segments filled up to where the cargo stands. It replaced a
          proportional bar of BOX STATUSES, which showed how the boxes were
          split without ever saying how far along the road any of them were:
          the question every customer opens this screen to ask. */}
      <div className="cab-track" data-testid="cab-track" title={t.journey}>
        {CARGO_STAGES.map((stage, i) => (
          <i key={stage} className={i < at ? 'done' : i === at ? 'now' : ''} />
        ))}
      </div>

      {main && (
        <div className="cab-stage" data-testid="cab-stage">
          {stageLabel(main.stage, t)}
        </div>
      )}

      {etas.map((eta) => (
        <div className="cab-eta" key={eta.toIso} data-testid="cab-eta">
          🗓 {eta.toPlace}: {t.etaAbout} {formatEtaRange(eta.fromIso, eta.toIso, locale)}
        </div>
      ))}

      {/* Only when the lot is split. One chip is the sentence above, repeated. */}
      {lot.groups.length > 1 && (
        <div className="cab-chips">
          {lot.groups.map((g) => (
            <span
              className="cab-chip"
              key={g.stage}
              style={{ '--chip': stageColor(g.stage) } as React.CSSProperties}
            >
              <b>{g.n}</b> {stageLabel(g.stage, t)}
            </span>
          ))}
        </div>
      )}

      {lot.photoCount > 0 && (
        <Photos lotId={lot.lotId} count={lot.photoCount} initData={initData} onZoom={onZoom} />
      )}
    </article>
  );
}

/**
 * A rung's colour, read from the stylesheet rather than repeated here.
 *
 * Nine rungs share the five hues the palette already carries, by KIND —
 * standing still is grey, being loaded amber, on the road purple, in
 * Uzbekistan blue, in the customer's hands green. That keeps the stylesheet's
 * own «cool → warm → green reads as progress» promise true without inventing
 * nine colours a customer would have to learn.
 */
const STAGE_HUE: Record<string, string> = {
  cn_warehouse: 'in_stock',
  hub: 'in_stock',
  cn_loading: 'loading',
  hub_loading: 'loading',
  cn_transit: 'in_transit',
  export_transit: 'in_transit',
  in_uz: 'planned',
  customs_done: 'planned',
  ready: 'ready_for_pickup',
  issued: 'ready_for_pickup',
};

function stageColor(stage: string): string {
  return `var(--st-${STAGE_HUE[stage] ?? 'in_stock'}, var(--muted))`;
}

/**
 * Photographs, fetched WITH the signed header rather than by URL.
 *
 * An `<img src>` cannot carry a header, so the alternative would be putting
 * `initData` in the query string — where it lands in logs and browser history.
 * Fetching each thumbnail as a blob keeps the credential out of every URL, and
 * the object URLs are released on unmount.
 */
function Photos({
  lotId,
  count,
  initData,
  onZoom,
}: {
  lotId: string;
  count: number;
  initData: string;
  onZoom: (url: string) => void;
}) {
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
        <button
          key={url}
          type="button"
          onClick={() => {
            tap('open');
            onZoom(url);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL, not a file the optimiser can reach */}
          <img src={url} alt="" loading="lazy" />
        </button>
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
      <div className="cab-balance" data-owing={owes} data-testid="cab-balance">
        <b>${Math.abs(client.balanceUsd).toFixed(2)}</b>
        <span>{owes ? t.debtYes : client.balanceUsd < -0.009 ? t.credit : t.debtNo}</span>
      </div>
      {client.recent.length > 0 && (
        <div className="cab-lot">
          <div className="cab-code">{t.recentMoves}</div>
          {client.recent.map((r, i) => (
            <div className="cab-row" key={i} data-kind={r.type === 'charge' ? 'charge' : 'payment'}>
              <span>
                {r.txDate} · {r.type === 'charge' ? t.charged : t.paid}
              </span>
              <span>
                {r.type === 'charge' ? '' : '+'}
                {r.amount} {r.currency}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The first paint, with the shape of the answer already in it.
 *
 * A client opening this is on a phone in a warehouse town; the round trip is
 * felt. Grey blocks in the layout of the real thing read as "nearly there",
 * where the word "Loading…" reads as "nothing happened".
 */
function Skeleton() {
  return (
    <div className="cab-body" data-testid="cab-skeleton">
      <div className="cab-skel cab-skel--head" />
      <div className="cab-skel" />
      <div className="cab-skel" />
    </div>
  );
}

function Notice({
  text,
  icon,
  children,
}: {
  text: string;
  icon?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="cab-body cab-notice">
      {/* The icon sits OUTSIDE the sentence: it is decoration, and a screen
          reader announcing "link emoji" before the message helps nobody. */}
      {icon && (
        <div className="cab-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="cab-empty" data-testid="cab-notice">
        {text}
      </p>
      {children}
    </div>
  );
}
