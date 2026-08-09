'use client';

import { useState } from 'react';
import { submitArizaAction, type ArizaState } from './actions';

/**
 * The boxes themselves.
 *
 * Controlled inputs, no `action` prop, verdict read before anything is
 * cleared — the shape this codebase arrived at after getting it wrong four
 * times (#377, #419, #463, #519). Here it matters more than anywhere else in
 * the app: the person typing is a stranger who is not signed in, has no card
 * to go back to, and will simply close the tab.
 */

const ERROR_TEXT: Record<NonNullable<ArizaState['error']>, string> = {
  name: 'Ismingizni yozing · Укажите ваше имя',
  phone: 'Telefon raqamini to‘liq yozing · Укажите полный номер телефона',
};

export function ArizaForm({ source, utm }: { source: string; utm: Record<string, string> }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [trap, setTrap] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ArizaState>({});

  if (state.ok) {
    return (
      <div className="card space-y-2 text-center" data-testid="ariza-done">
        <p className="text-2xl">✅</p>
        <p className="font-semibold">Arizangiz qabul qilindi</p>
        <p className="text-sm text-ink-500">
          Menejerimiz tez orada siz bilan bog‘lanadi.
          <br />
          Заявка принята — наш менеджер свяжется с вами.
        </p>
      </div>
    );
  }

  const send = async () => {
    setBusy(true);
    const form = new FormData();
    form.set('ism', name);
    form.set('telefon', phone);
    form.set('izoh', note);
    form.set('manba', source);
    form.set('kompaniya', trap);
    for (const [key, value] of Object.entries(utm)) form.set(key, value);
    const result = await submitArizaAction(state, form);
    setState(result);
    setBusy(false);
  };

  return (
    <div className="card space-y-3">
      <label className="block space-y-1">
        <span className="text-sm text-ink-500">Ismingiz · Ваше имя</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          data-testid="ariza-name"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm text-ink-500">Telefon · Телефон</span>
        <input
          className="input"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+998 90 123 45 67"
          autoComplete="tel"
          data-testid="ariza-phone"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-sm text-ink-500">
          Qanday yuk? · Какой груз?
          {/* Its own line: inline, the bracket broke across two rows and read
              as part of the question. */}
          <span className="block text-xs">ixtiyoriy · необязательно</span>
        </span>
        <textarea
          className="input h-24 resize-none"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Masalan: Guangzhoudan 2 kub kiyim"
          data-testid="ariza-note"
        />
      </label>

      {/* Nobody can see this box, so nobody but a robot fills it in. */}
      <input
        className="absolute left-[-9999px] h-0 w-0"
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        name="kompaniya"
        value={trap}
        onChange={(e) => setTrap(e.target.value)}
      />

      {state.error ? (
        <p className="text-sm text-bad" data-testid="ariza-error">
          {ERROR_TEXT[state.error]}
        </p>
      ) : null}

      <button
        type="button"
        className="btn btn-primary w-full justify-center py-3 text-base"
        onClick={send}
        disabled={busy}
        data-testid="ariza-send"
      >
        {busy ? '…' : 'Yuborish · Отправить'}
      </button>

      <p className="text-center text-xs text-ink-500">
        Raqamingiz faqat siz bilan bog‘lanish uchun ishlatiladi.
        <br />
        Номер используется только для связи с вами.
      </p>
    </div>
  );
}
