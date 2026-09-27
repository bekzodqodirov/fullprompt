'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  boxWord,
  CLIENT_LOCALES,
  clientLabels,
  fillLabel,
  formatDay,
  formatEtaRange,
  journeyLabel,
  stageLabel,
  txView,
  type ClientLabels,
  type ClientLocale,
} from '@/modules/platform/telegram/client-labels';
import { groupDigits, usd } from '@/modules/platform/telegram/format';
import {
  MILESTONES,
  milestoneCounts,
  milestoneOf,
  type Milestone,
} from '@/modules/wms/client-cabinet/stages';
import type { CabinetContact, CabinetPayload } from '@/modules/wms/client-cabinet/miniapp';
import { CabinetMap } from './cabinet-map';

/**
 * What the customer sees (owner: "kubi kilosi soni rasimi hammasini to'liq
 * ko'rsa yaxshi bo'lar edi … chiroyli interface qilib bersak zor bo'lardi",
 * then: "web appni o'zida ham UI UX designni maksimal darajada yaxshila", and
 * round C: «userlar waaauw degan darajada»).
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
 * Round C put the ANSWER first. The header says where everything is in one
 * line (the same buckets as the bot's «📦 Yuklarim», `milestoneCounts`) and
 * what is owed in one chip; ready cargo gets its own card at the top with the
 * person to call; every lot carries the five-step bar before its sentence;
 * and the manager and the language are at the foot, where a customer looks
 * when the screen has answered everything but «who do I talk to».
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
    notificationOccurred?: (kind: 'success' | 'error' | 'warning') => void;
  };
  /** Bot API 7.7: stop a vertical swipe from minimising the app. */
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
  BackButton?: {
    show?: () => void;
    hide?: () => void;
    onClick?: (cb: () => void) => void;
    offClick?: (cb: () => void) => void;
  };
  /** Opens a t.me link as a CHAT, inside Telegram, without leaving the app for a browser. */
  openTelegramLink?: (url: string) => void;
  /** Back to the chat the app was opened from. */
  close?: () => void;
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
 * render as the data they belong to. The lot a push opened the app on
 * (`?lot=`) travels the same way, for the same reason.
 */
type State =
  | { kind: 'loading'; hint?: string }
  | { kind: 'outside'; hint?: string }
  | { kind: 'error'; blob: string; hint?: string; status?: number; reason?: string }
  | { kind: 'ready'; blob: string; data: CabinetPayload; focus: string | null };

type Fetched =
  | { ok: true; data: CabinetPayload }
  | { ok: false; status?: number; reason?: string };

/**
 * One call for everything. A refusal's REASON is read, not just its status:
 * after 24 hours the blob is `expired` and no retry can work — the app has to
 * say «close me and open me again», which a generic «try again» never will.
 */
async function fetchPayload(blob: string): Promise<Fetched> {
  try {
    const res = await fetch('/api/cabinet/data', {
      headers: { 'x-telegram-init-data': blob },
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return { ok: false, status: res.status, reason: typeof body?.error === 'string' ? body.error : undefined };
    }
    return { ok: true, data: (await res.json()) as CabinetPayload };
  } catch {
    return { ok: false };
  }
}

/**
 * The lot a push opened the app on (`/cabinet?lot=<id>`, contract 3). A hint
 * for the SCREEN only: honoured when that lot is among this chat's own cargo,
 * which the data — fetched with the signed chat, never with this id —
 * already decides.
 */
function focusFrom(data: CabinetPayload): string | null {
  let id: string | null = null;
  try {
    id = new URLSearchParams(window.location.search).get('lot');
  } catch {
    id = null;
  }
  if (!id) return null;
  return data.clients.some((c) => c.cargo.some((l) => l.lotId === id)) ? id : null;
}

/** Each language written in itself — nobody looks for «Uzbek» in Russian. The bot's own list. */
const LANGUAGE_NAMES: Record<ClientLocale, string> = {
  uz: '🇺🇿 O‘zbekcha',
  ru: '🇷🇺 Русский',
  en: '🇬🇧 English',
};

/**
 * The header's one line, in the order a customer acts on it: what can be
 * collected, what is in the country, what is on the road, what is still in
 * China. The bot's summary uses the same four buckets in the same order.
 */
const SUMMARY: { step: Milestone; label: keyof ClientLabels }[] = [
  { step: 'ready', label: 'sumReady' },
  { step: 'uz', label: 'sumUz' },
  { step: 'transit', label: 'sumTransit' },
  { step: 'china', label: 'sumChina' },
];

/** The stepper's labels — the short forms, five of which fit under five dots at 360 px. */
const STEP_LABEL: Record<Milestone, keyof ClientLabels> = {
  china: 'msShortChina',
  transit: 'msShortTransit',
  uz: 'msShortUz',
  ready: 'msShortReady',
  issued: 'msShortIssued',
};

const TAB_ICON: Record<Tab, string> = { cargo: '📦', balance: '💰', history: '🗄' };

/** Money as a person writes it: whole amounts bare, anything else to the cent. */
function money(amount: number): string {
  return Number.isInteger(amount) ? groupDigits(amount) : groupDigits(amount, 2);
}

/** «+998 90 123 45 67» — an Uzbek number the way it is read aloud; anything else as typed. */
function prettyPhone(raw: string): string {
  const m = /^998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(raw.replace(/\D/g, ''));
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : raw.trim();
}

function telHref(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  return `tel:${digits}`;
}

type ClientView = CabinetPayload['clients'][number];
type CabinetLotView = ClientView['cargo'][number];

/** The step the bulk of a lot stands at — the service sorts groups biggest first. */
function mainStep(lot: CabinetLotView): number {
  const main = lot.groups[0];
  return main ? milestoneOf(main.stage) : 0;
}

export function CabinetApp() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('cargo');
  const [zoom, setZoom] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [langBusy, setLangBusy] = useState(false);
  const scrolledTo = useRef<string | null>(null);

  const load = useCallback(async (blob: string, hint?: string) => {
    // No blob at all means the page was opened in an ordinary browser rather
    // than inside Telegram. Said plainly rather than as an error: nothing is
    // wrong, it is simply the wrong door.
    if (!blob) {
      setState({ kind: 'outside' });
      return;
    }
    setState({ kind: 'loading', hint });
    const got = await fetchPayload(blob);
    if (!got.ok) {
      setState({ kind: 'error', blob, hint, status: got.status, reason: got.reason });
      return;
    }
    setState({ kind: 'ready', blob, data: got.data, focus: focusFrom(got.data) });
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
   * While the map is open, a drag belongs to the map. Telegram treats a
   * downward swipe as «minimise the app» and the page underneath scrolls —
   * his first look was exactly that: a pinch scrolled everything down. Both
   * are held for as long as the map screen is up, and given back on close.
   */
  useEffect(() => {
    if (!mapOpen) return;
    const app = webApp();
    app?.disableVerticalSwipes?.();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      app?.enableVerticalSwipes?.();
      document.body.style.overflow = prev;
    };
  }, [mapOpen]);

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
    if (!zoom && !mapOpen) {
      back.hide?.();
      return;
    }
    // One back press closes the innermost thing: a photo over the map first.
    const close = () => (zoom ? setZoom(null) : setMapOpen(false));
    back.onClick?.(close);
    back.show?.();
    return () => {
      back.offClick?.(close);
      back.hide?.();
    };
  }, [zoom, mapOpen]);

  /**
   * Opened from a push about one lot: that lot, in the middle of the screen,
   * once. Scrolling on every render would fight the customer's own thumb.
   */
  const focusId = state.kind === 'ready' ? state.focus : null;
  useEffect(() => {
    if (!focusId || tab !== 'cargo' || scrolledTo.current === focusId) return;
    const el = document.querySelector(`[data-lot-id="${CSS.escape(focusId)}"]`);
    if (!el) return;
    scrolledTo.current = focusId;
    el.scrollIntoView({ block: 'center' });
  }, [focusId, tab]);

  // Until the client's own choice arrives with the data, Telegram's own
  // interface language is the best guess at what they read.
  const t = clientLabels(state.kind === 'ready' ? state.data.locale : state.hint);

  /**
   * ↻ — the same one call, without throwing the screen away while it runs:
   * the customer keeps reading what they had until the new answer lands.
   */
  const refresh = async () => {
    if (state.kind !== 'ready' || refreshing) return;
    const { blob, data, focus } = state;
    tap();
    setRefreshing(true);
    const got = await fetchPayload(blob);
    setRefreshing(false);
    if (!got.ok) {
      setState({ kind: 'error', blob, hint: data.locale ?? undefined, status: got.status, reason: got.reason });
      return;
    }
    setState({ kind: 'ready', blob, data: got.data, focus });
  };

  /**
   * The language, from inside the app — the bot's 🌐 Til through the same
   * writer (`/api/cabinet/locale`). The screen switches at once; if the
   * server refuses, it switches BACK, because a screen in a language the chat
   * does not hold is a promise the next message will break.
   */
  const chooseLocale = async (next: ClientLocale) => {
    if (state.kind !== 'ready' || langBusy) return;
    const before = state;
    tap();
    setLangBusy(true);
    setState({ ...before, data: { ...before.data, locale: next, storedLocale: next } });
    try {
      const res = await fetch('/api/cabinet/locale', {
        method: 'POST',
        headers: { 'x-telegram-init-data': before.blob, 'content-type': 'application/json' },
        body: JSON.stringify({ locale: next }),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      webApp()?.HapticFeedback?.notificationOccurred?.('success');
    } catch {
      setState((cur) =>
        cur.kind === 'ready'
          ? {
              ...cur,
              data: { ...cur.data, locale: before.data.locale, storedLocale: before.data.storedLocale },
            }
          : cur,
      );
      webApp()?.HapticFeedback?.notificationOccurred?.('error');
    } finally {
      setLangBusy(false);
    }
  };

  if (state.kind === 'outside') return <Notice icon="💬" text={t.openInTelegram} />;
  if (state.kind === 'loading') return <Skeleton />;
  if (state.kind === 'error') {
    // A day-old window: its signature has run out and nothing but reopening
    // mints a new one, so a retry button would be a button that cannot work.
    if (state.reason === 'expired') {
      return (
        <Notice icon="⏳" text={t.expiredApp}>
          {webApp()?.close && (
            <button type="button" className="cab-btn" onClick={() => webApp()?.close?.()}>
              {t.close}
            </button>
          )}
        </Notice>
      );
    }
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

  const { data, blob, focus } = state;
  const locale = data.locale;
  const counts = milestoneCounts(data.clients.flatMap((c) => c.cargo.flatMap((l) => l.groups)));
  const summary = SUMMARY.filter((s) => counts[s.step] > 0);
  // Never netted across codes (CX-6): a credit on 555 does not pay 777's
  // debt, so what is owed is the sum of what each code owes, and «ortiqcha»
  // is said only when NO code owes anything.
  const owed = data.clients.reduce((s, c) => s + (c.balanceUsd > 0.009 ? c.balanceUsd : 0), 0);
  const credit = data.clients.reduce((s, c) => s + (c.balanceUsd < -0.009 ? -c.balanceUsd : 0), 0);
  const chip =
    owed > 0.009
      ? { owing: true, text: `${t.chipOwe} ${usd(owed)}` }
      : credit > 0.009
        ? { owing: false, text: `${t.chipCredit} ${usd(credit)}` }
        : null;
  const openTab = (key: Tab) => {
    tap();
    setTab(key);
  };

  return (
    <>
      <header className="cab-head">
        <div className="cab-title">
          <div className="cab-title-text">
            <span>{t.appTitle}</span>
            <small>{data.clients.map((c) => c.clientCode).join(' · ')}</small>
          </div>
          {chip && (
            <button
              type="button"
              className="cab-money"
              data-testid="cab-balance-chip"
              data-owing={chip.owing}
              onClick={() => openTab('balance')}
            >
              {chip.text}
            </button>
          )}
          <button
            type="button"
            className="cab-icon-btn"
            data-testid="cab-refresh"
            aria-label={t.refresh}
            title={t.refresh}
            data-busy={refreshing}
            onClick={() => void refresh()}
          >
            <span aria-hidden="true">↻</span>
          </button>
        </div>

        {/* The three numbers the owner asked for, now ONE line: they are the
            size of the whole consignment, not the answer to «where is it». */}
        <div className="cab-totals">
          <b>{groupDigits(data.totals.boxes)}</b> {boxWord(data.totals.boxes, locale)} ·{' '}
          <b>{groupDigits(data.totals.weightKg)}</b> {t.kg} · <b>{groupDigits(data.totals.volumeM3)}</b> {t.m3}
        </div>

        {/* Where everything is — and the map, which is the same question
            drawn, at the end of the same line. */}
        {(summary.length > 0 || data.map.length > 0) && (
          <div className="cab-status" data-testid="cab-status">
            {summary.map((s) => (
              <span key={s.step} data-step={s.step}>
                {t[s.label]} <b>{groupDigits(counts[s.step])}</b>
              </span>
            ))}
            {data.map.length > 0 && (
              <button
                type="button"
                className="cab-map-open"
                data-testid="cab-map-open"
                onClick={() => {
                  tap('open');
                  setMapOpen(true);
                }}
              >
                {t.mapOpen}
              </button>
            )}
          </div>
        )}

        <div className="cab-tabs" role="tablist">
          {(
            [
              ['cargo', t.tabCargo],
              ['balance', t.tabBalance],
              ['history', t.tabHistory],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className="cab-tab"
              data-testid={`cab-tab-${key}`}
              onClick={() => openTab(key)}
            >
              <span aria-hidden="true">{TAB_ICON[key]}</span> {label}
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

            {tab === 'cargo' && (
              <>
                <ReadyHero
                  client={client}
                  office={data.office}
                  t={t}
                  locale={locale}
                  onBalance={() => openTab('balance')}
                />
                {client.cargo.length === 0 ? (
                  <p className="cab-empty">
                    <span className="cab-empty-icon">📦</span>
                    {t.noCargo}
                  </p>
                ) : (
                  // Nearest to the customer first: what can be collected
                  // today is the reason the app was opened.
                  [...client.cargo]
                    .sort((a, b) => mainStep(b) - mainStep(a) || (a.letter ?? '').localeCompare(b.letter ?? ''))
                    .map((lot) => (
                      <Lot
                        key={lot.lotId}
                        lot={lot}
                        t={t}
                        locale={locale}
                        initData={blob}
                        focused={lot.lotId === focus}
                        onZoom={setZoom}
                      />
                    ))
                )}
              </>
            )}

            {tab === 'balance' && <Balance client={client} t={t} />}

            {tab === 'history' && (
              <History client={client} t={t} locale={locale} initData={blob} onZoom={setZoom} />
            )}
          </section>
        ))}

        <Contacts data={data} t={t} />

        <nav className="cab-langs" aria-label={t.languageLabel} data-testid="cab-langs">
          <span className="cab-langs-label">🌐 {t.languageLabel}</span>
          <div className="cab-langs-row">
            {CLIENT_LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                className="cab-lang"
                data-testid={`cab-lang-${l}`}
                // The STORED choice, never Telegram's guess: a customer who
                // has chosen nothing sees nothing chosen.
                aria-pressed={data.storedLocale === l}
                onClick={() => void chooseLocale(l)}
              >
                {LANGUAGE_NAMES[l]}
              </button>
            ))}
          </div>
        </nav>
      </div>

      {mapOpen && (
        <div className="cab-map-screen" data-testid="cab-map-screen">
          <div className="cab-map-bar">
            <b>{t.mapTitle}</b>
            <button type="button" className="cab-map-close" aria-label={t.close} onClick={() => setMapOpen(false)}>
              ✕
            </button>
          </div>
          <CabinetMap
            places={data.map}
            basemap={data.basemap}
            dark={webApp()?.colorScheme === 'dark'}
            t={t}
            locale={locale}
            goodsName={(lot) => lot.productNameRu?.trim() || lot.productNameZh}
          />
        </div>
      )}

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

/**
 * The five steps — China, transit, Uzbekistan, ready, handed over — drawn
 * over the ten-rung sentence, which stays the truth under it. The bulk of the
 * lot is the highlighted dot; a part of it standing elsewhere rings its own
 * step, so a split lot never reads as all in one place.
 */
function Steps({ lot, t }: { lot: CabinetLotView; t: ClientLabels }) {
  const main = lot.groups[0];
  if (!main) return null;
  const now = milestoneOf(main.stage);
  const also = new Set(lot.groups.slice(1).map((g) => milestoneOf(g.stage)));
  return (
    <ol className="cab-steps" data-testid="cab-steps" aria-label={t.journey}>
      {MILESTONES.map((m, i) => (
        <li
          key={m}
          data-state={i < now ? 'done' : i === now ? 'now' : 'todo'}
          data-also={also.has(i) && i !== now ? 'true' : undefined}
          aria-current={i === now ? 'step' : undefined}
        >
          <i aria-hidden="true" />
          <span>{t[STEP_LABEL[m]]}</span>
        </li>
      ))}
    </ol>
  );
}

function Lot({
  lot,
  t,
  locale,
  initData,
  focused,
  onZoom,
}: {
  lot: CabinetLotView;
  t: ClientLabels;
  locale: string | null;
  initData: string;
  focused: boolean;
  onZoom: (url: string) => void;
}) {
  // Sorted biggest-first by the service, so the headline and the road are
  // drawn for the bulk of the cargo and any remainder is named under it.
  const main = lot.groups[0];
  const road = main?.transit ?? null;
  return (
    <article
      className="cab-lot"
      data-testid="cab-lot"
      data-lot-id={lot.lotId}
      data-focus={focused ? 'true' : undefined}
    >
      <div className="cab-lot-top">
        <span className="cab-letter">{lot.letter ?? '·'}</span>
        <span className="cab-name">{lot.productNameRu?.trim() || lot.productNameZh}</span>
      </div>

      <Steps lot={lot} t={t} />

      {main && (
        <div className="cab-stage" data-testid="cab-stage">
          {stageLabel(main.stage, t)}
        </div>
      )}

      {/* The road, when the cargo is ON one: its two ends by name and how
          much of it the schedule says is behind — the owner's ask verbatim,
          «yolni qanchasini bosib otganini korsatadgan». It replaced an
          unlabelled ten-segment strip, which he read as meaning nothing —
          because without names and dates it meant nothing. */}
      {road && (
        <div className="cab-road" data-testid="cab-road">
          <div className="cab-road-ends">
            <span>{road.fromPlace}</span>
            <b>{Math.round(road.progress * 100)}%</b>
            <span>{road.toPlace}</span>
          </div>
          <div className="cab-road-bar">
            <i style={{ width: `${Math.round(road.progress * 100)}%` }} />
            <u style={{ left: `${Math.round(road.progress * 100)}%` }}>🚛</u>
          </div>
          {/* The place is INSIDE the estimate (CX-9): a date on the Kashgar
              leg must not read as the day it reaches Tashkent. The bot says
              the same sentence. */}
          {road.etaFromIso && road.etaToIso && (
            <div className="cab-eta" data-testid="cab-eta">
              🗓{' '}
              <EtaSentence
                template={t.etaTo}
                place={road.toPlace}
                range={formatEtaRange(road.etaFromIso, road.etaToIso, locale)}
              />
            </div>
          )}
        </div>
      )}

      {/* One line, the way a packing list reads — a customer checking against
          the supplier compares numbers, and three tiles cost a third of the
          card for three words. */}
      <div className="cab-dims">
        📦 <b>{groupDigits(lot.total)}</b> {boxWord(lot.total, locale)} · <b>{groupDigits(lot.weightKg)}</b>{' '}
        {t.kg} · <b>{groupDigits(lot.volumeM3)}</b> {t.m3}
      </div>

      {lot.warehousePlaces.length > 0 && (
        <div className="cab-where">📍 {lot.warehousePlaces.join(', ')}</div>
      )}

      {/* What happened and when — dates the database has carried since the
          first scan, finally on the one screen a customer opens. Oldest
          first; the newest line is where the headline above picks up. */}
      {lot.journey.length > 0 && (
        <ol className="cab-journey" data-testid="cab-journey">
          {lot.journey.map((step, i) => (
            <li key={step.key} className={i === lot.journey.length - 1 ? 'now' : ''}>
              <time>{formatEtaRange(step.atIso, step.atIso, locale)}</time>
              <span>{journeyLabel(step.key, t)}</span>
            </li>
          ))}
        </ol>
      )}

      {/* Only when the lot is split. One chip is the sentence above, repeated. */}
      {lot.groups.length > 1 && (
        <div className="cab-chips">
          {lot.groups.map((g) => (
            <span
              className="cab-chip"
              key={g.stage}
              style={{ '--chip': stageColor(g.stage) } as React.CSSProperties}
            >
              <b>{groupDigits(g.n)}</b> {stageLabel(g.stage, t)}
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
 * «Arrival (Kashgar): about 14.08 – 16.08», with the range as ONE unit.
 *
 * A no-break space does not hold it: the en dash is itself a break
 * opportunity, so the phone put «16.08» alone on the next line, where it
 * reads as a second date. The range is a nowrap span inside the sentence.
 */
function EtaSentence({ template, place, range }: { template: string; place: string; range: string }) {
  const [before, after] = template.split('{range}');
  return (
    <>
      {fillLabel(before ?? '', { place })}
      <span className="cab-nowrap">{range}</span>
      {fillLabel(after ?? '', { place })}
    </>
  );
}

/**
 * «Olib ketishga tayyor» — the one fact a customer acts on the same day, at
 * the top of their cargo with WHERE to go, what is owed first, and the person
 * to call.
 *
 * The sentence is the push's own (CX-2): boxes on a truck nobody has marked
 * «rastamojka tugadi» are «yetib keldi — rasmiylashtiruvdan so'ng», not
 * «tayyor», so the app never tells a customer to come for cargo the Uzbek
 * push told them was still in paperwork.
 */
function ReadyHero({
  client,
  office,
  t,
  locale,
  onBalance,
}: {
  client: ClientView;
  office: CabinetPayload['office'];
  t: ClientLabels;
  locale: string | null;
  onBalance: () => void;
}) {
  let cleared = 0;
  let pending = 0;
  for (const lot of client.cargo) {
    const n = lot.groups.filter((g) => g.stage === 'ready').reduce((s, g) => s + g.n, 0);
    if (n === 0) continue;
    if (lot.journey.some((s) => s.key === 'customs')) cleared += n;
    else pending += n;
  }
  if (cleared === 0 && pending === 0) return null;
  const count = (n: number) => `${groupDigits(n)} ${boxWord(n, locale)}`;
  const places = client.readyPlaces ?? [];
  const owes = client.balanceUsd > 0.009;
  const contact: CabinetContact | null =
    client.manager ?? (client.manager === null && office ? { ...office, telegramUrl: null } : null);
  return (
    <section className="cab-hero" data-testid="cab-ready">
      {cleared > 0 && <p className="cab-hero-title">✅ {fillLabel(t.readyHero, { n: count(cleared) })}</p>}
      {pending > 0 && (
        <p className="cab-hero-title">⏳ {fillLabel(t.readyHeroPending, { n: count(pending) })}</p>
      )}
      {places.length > 0 && (
        <p className="cab-hero-place">
          📍 {places.map((p) => (p.address ? `${p.name} — ${p.address}` : p.name)).join(' · ')}
        </p>
      )}
      {owes && (
        <button type="button" className="cab-hero-debt" onClick={onBalance}>
          💰 {t.chipOwe}: {usd(client.balanceUsd)}
        </button>
      )}
      {contact && <ContactActions contact={contact} t={t} chat={!contact.telegramUrl} />}
    </section>
  );
}

/**
 * The two ways to reach a person, as the phone expects them.
 *
 * Telegram through `openTelegramLink` — it opens the CHAT inside Telegram
 * rather than a browser tab — and only for a t.me address, the one kind
 * `managersFor` builds. The phone as a plain `tel:` link with the number
 * itself as the text (CX-11): Telegram's `openLink` throws on anything but
 * http(s), and a number a customer can read and select is useful even on a
 * device that will not dial.
 */
function ContactActions({ contact, t, chat }: { contact: CabinetContact; t: ClientLabels; chat: boolean }) {
  const url = contact.telegramUrl;
  return (
    <div className="cab-actions">
      {url && (
        <a
          className="cab-act cab-act--main"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="cab-contact-write"
          onClick={(e) => {
            const open = webApp()?.openTelegramLink;
            if (!open || !url.startsWith('https://t.me/')) return;
            e.preventDefault();
            tap('open');
            webApp()?.openTelegramLink?.(url);
          }}
        >
          {t.managerWrite}
        </a>
      )}
      {contact.phone && (
        <a className="cab-act" href={telHref(contact.phone)} data-testid="cab-contact-call">
          📞 <span className="cab-num">{prettyPhone(contact.phone)}</span>
        </a>
      )}
      {chat && webApp()?.close && (
        <button type="button" className="cab-act" onClick={() => webApp()?.close?.()}>
          {t.writeInChat}
        </button>
      )}
    </div>
  );
}

/**
 * Who to talk to — one card per distinct person, never one per code: a
 * customer holding 777, 555 and 444 with one manager reads one card, and the
 * codes it answers for are named on it when there is more than one. Codes
 * with no manager share the office card (most codes today — «no manager»
 * would tell them nobody is theirs, CX-1).
 *
 * Nothing is drawn when the server sent neither (an older server mid-deploy):
 * a card with no name and no number is worse than no card.
 */
function Contacts({ data, t }: { data: CabinetPayload; t: ClientLabels }) {
  const people = new Map<string, { contact: CabinetContact; codes: string[] }>();
  const officeCodes: string[] = [];
  for (const c of data.clients) {
    if (c.manager) {
      const key = `${c.manager.name}|${c.manager.phone ?? ''}|${c.manager.telegramUrl ?? ''}`;
      const entry = people.get(key) ?? { contact: c.manager, codes: [] };
      entry.codes.push(c.clientCode);
      people.set(key, entry);
    } else if (c.manager === null) {
      officeCodes.push(c.clientCode);
    }
  }
  const several = data.clients.length > 1;
  const office = officeCodes.length > 0 ? data.office : undefined;
  if (people.size === 0 && !office) return null;
  return (
    <div className="cab-contacts">
      {[...people.values()].map(({ contact, codes }) => (
        <section className="cab-contact" key={codes.join(' ')} data-testid="cab-manager">
          <div className="cab-contact-who">
            <span className="cab-avatar" aria-hidden="true">
              {contact.name.trim().charAt(0).toUpperCase() || '👤'}
            </span>
            <div>
              <b>{contact.name}</b>
              <small>
                {t.managerTitle}
                {several ? ` · ${codes.join(' · ')}` : ''}
              </small>
            </div>
          </div>
          <ContactActions contact={contact} t={t} chat={false} />
        </section>
      ))}
      {office && (
        <section className="cab-contact" data-testid="cab-office">
          <div className="cab-contact-who">
            <span className="cab-avatar" aria-hidden="true">
              🏢
            </span>
            <div>
              <b>{office.name}</b>
              <small>
                {t.officeTitle}
                {several ? ` · ${officeCodes.join(' · ')}` : ''}
              </small>
            </div>
          </div>
          <p>{t.officeWriteHint}</p>
          <ContactActions contact={{ ...office, telegramUrl: null }} t={t} chat />
        </section>
      )}
    </div>
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

/**
 * What was handed over in the last three months, one card per handover — the
 * owner's «alohida topshirilgan yuklar ko'rinib tursin … qaysi partiyada
 * kelgan, ichki tashqi sanalari, rasmlari, kim bergan». Then the money the
 * client PAID in the same window, and only that (no charge, no cost).
 */
function History({
  client,
  t,
  locale,
  initData,
  onZoom,
}: {
  client: ClientView;
  t: ClientLabels;
  locale: string | null;
  initData: string;
  onZoom: (url: string) => void;
}) {
  return (
    <>
      {client.history.length === 0 ? (
        <p className="cab-empty">
          <span className="cab-empty-icon">🗄</span>
          {t.noHistory}
        </p>
      ) : (
        <>
          <div className="cab-code">{t.historyWindow}</div>
          {client.history.map((h) => (
            <article className="cab-lot" key={h.id} data-testid="cab-handover">
              <div className="cab-lot-head">
                <b>🤝 {formatDay(h.issuedAt)}</b>
                <small>
                  {t.issuedAtPlace}: {h.place}
                </small>
              </div>
              <div className="cab-row">
                <span>{t.issuedTo}</span>
                <span>{h.receiver}</span>
              </div>
              <div className="cab-row">
                <span>{t.issuedBy}</span>
                <span>{h.issuedBy}</span>
              </div>
              {h.lots.map((lot) => (
                <div key={lot.lotId} data-testid="cab-handover-lot">
                  <div className="cab-row">
                    <span>
                      {lot.letter ?? '·'} — {lot.productNameRu?.trim() || lot.productNameZh}
                    </span>
                    <span>
                      {groupDigits(lot.n)} {boxWord(lot.n, locale)} · {groupDigits(lot.weightKg)} {t.kg} ·{' '}
                      {groupDigits(lot.volumeM3)} {t.m3}
                    </span>
                  </div>
                  <div className="cab-row cab-row-muted">
                    <span>{t.receivedOn}</span>
                    <span>{formatDay(lot.receivedAt)}</span>
                  </div>
                  {lot.photoCount > 0 && (
                    <Photos lotId={lot.lotId} count={lot.photoCount} initData={initData} onZoom={onZoom} />
                  )}
                </div>
              ))}
              {h.legs.map((leg) => (
                <div className="cab-row" key={leg.batchCode} data-testid="cab-handover-leg">
                  <span>
                    {t.batchWord} {leg.batchCode} · {leg.domestic ? t.legDomestic : t.legAbroad}
                    <br />
                    <small>
                      {leg.fromPlace} → {leg.toPlace}
                    </small>
                  </span>
                  <span>
                    {leg.departedAt && `${t.legDeparted} ${formatDay(leg.departedAt)}`}
                    {leg.departedAt && leg.arrivedAt && <br />}
                    {leg.arrivedAt && `${t.legArrived} ${formatDay(leg.arrivedAt)}`}
                  </span>
                </div>
              ))}
            </article>
          ))}
        </>
      )}
      {client.payments.length > 0 && (
        <div className="cab-lot" data-testid="cab-payments">
          <div className="cab-code">{t.paymentsTitle}</div>
          {client.payments.map((p, i) => (
            <div className="cab-row" key={i} data-kind="payment">
              <span>{formatDay(p.txDate)}</span>
              <span>
                +{money(p.amount)} {p.currency}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Balance({ client, t }: { client: ClientView; t: ClientLabels }) {
  const owes = client.balanceUsd > 0.009;
  return (
    <>
      <div className="cab-balance" data-owing={owes} data-testid="cab-balance">
        <b>{usd(Math.abs(client.balanceUsd))}</b>
        <span>{owes ? t.debtYes : client.balanceUsd < -0.009 ? t.credit : t.debtNo}</span>
      </div>
      {client.recent.length > 0 && (
        <div className="cab-lot">
          <div className="cab-code">{t.recentMoves}</div>
          {client.recent.map((r, i) => {
            // One table for the app and the bot (TX_VIEW): a kind the
            // customer is not shown is not drawn at all.
            const view = txView(r.type, t);
            if (!view) return null;
            return (
              <div className="cab-row" key={i} data-kind={r.type}>
                <span>
                  {formatDay(r.txDate)} · {view.text}
                </span>
                <span className="cab-amount">
                  {view.sign}
                  {money(r.amount)} {r.currency}
                  {/* The balance above is in dollars; a row in som says what
                      it came to, or the two never add up in the reader's head. */}
                  {r.currency !== 'USD' && <small>≈ {usd(r.amountUsd)}</small>}
                </span>
              </div>
            );
          })}
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
