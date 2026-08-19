'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Overlay } from './ui/overlay';
import {
  resolveClientCodeAction,
  winLeadAction,
  type WinLeadState,
} from '@/app/(protected)/crm/actions';

/**
 * «Yutdi» is a ceremony, not a drag (round 107, owner: «kod ochish majburiy
 * bo'lsin yokida eski klient kodga biriktirib bitimga o'tish kerak»). Every
 * won door opens this dialog: mint a client code (name prefilled from the
 * lead) or attach to an existing client by the CODE the seller types — the
 * typed code is echoed back as a NAME before anything is written, because a
 * typo'd but existing code would re-key the lead's calls and chat onto the
 * wrong customer, and there is no undo.
 *
 * A lead already carrying a client (born from the Telegram tray, or won once
 * and revived) skips the choice and confirms only — the sentence says a NEW
 * deal opens, so a re-win is a decision and never an accident.
 *
 * On success the dialog becomes the item-1 banner: the code big and
 * copyable, the deal's number beside it. Kept MOUNTED and toggled — the
 * LostReasonDialog's Overlay close-on-mount trap (round 98).
 */
export interface WonDialogLead {
  id: string;
  /** Prefill for the mint mode's client name. */
  defaultName: string;
  /** Set when the lead already carries a client — confirm-only mode. */
  clientCode: string | null;
  /** The won stage that was pressed (a funnel may hold several). */
  stageId?: string;
}

export function WonDialog({
  open,
  lead,
  onClose,
  onWon,
}: {
  open: boolean;
  lead: WonDialogLead | null;
  onClose: () => void;
  /** Called when the person closes the success banner — refresh lives here. */
  onWon: () => void;
}) {
  const t = useTranslations('crm');
  const tq = useTranslations('quick');
  const [mode, setMode] = useState<'mint' | 'attach'>('mint');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [attachCode, setAttachCode] = useState('');
  const [checked, setChecked] = useState<{ code: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<NonNullable<WinLeadState['result']> | null>(null);
  const [copied, setCopied] = useState(false);
  // The lead the fields were typed for: a dialog opened on card A must not
  // hand card B the leftovers.
  const [forLead, setForLead] = useState<string | null>(null);
  if (lead && forLead !== lead.id) {
    setForLead(lead.id);
    setMode('mint');
    setName(lead.defaultName);
    setCode('');
    setAttachCode('');
    setChecked(null);
    setError('');
    setResult(null);
  }

  // A literal map, the useMoveErrors rule: the i18n tripwire cannot see a key
  // built at runtime.
  const errors: Record<string, string> = {
    client_not_found: t('won.errors.clientNotFound'),
    client_inactive: t('won.errors.clientInactive'),
    code_exists: t('won.errors.codeExists'),
    code_format: t('won.errors.codeFormat'),
    stage_not_found: t('won.errors.stageGone'),
    forbidden: t('won.errors.forbidden'),
    validation: t('won.errors.failed'),
    failed: t('won.errors.failed'),
  };

  async function check() {
    setBusy(true);
    setError('');
    const res = await resolveClientCodeAction(attachCode);
    setBusy(false);
    if (!res.ok) {
      setChecked(null);
      setError(errors[res.error ?? 'failed'] ?? res.error ?? '');
      return;
    }
    setChecked({ code: res.clientCode!, name: res.name! });
  }

  async function confirm() {
    if (!lead) return;
    setBusy(true);
    setError('');
    const res = await winLeadAction(lead.id, {
      stageId: lead.stageId,
      ...(lead.clientCode
        ? {}
        : mode === 'attach'
          ? { attachCode: checked?.code ?? attachCode }
          : { clientCode: code, name }),
    });
    setBusy(false);
    if (!res.ok || !res.result) {
      setError(errors[res.error ?? 'failed'] ?? res.error ?? '');
      return;
    }
    setResult(res.result);
  }

  async function copyCode() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.clientCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard permission — the code is on screen, selectable.
    }
  }

  return (
    <Overlay
      open={open}
      onClose={() => {
        if (result) {
          setResult(null);
          onWon();
        } else {
          onClose();
        }
      }}
      closeLabel={t('cancelMove')}
      testId="won-dialog"
      className="absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-2xl bg-surface-raised p-4 pb-safe shadow-xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[26rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
    >
      {result ? (
        <div className="space-y-3" data-testid="won-made">
          <p className="text-sm font-bold">{result.minted ? tq('codeTitle') : t('won.existing')}</p>
          <div className="rounded-2xl border-2 border-good bg-good/10 p-4 text-center">
            <p
              className="font-mono text-3xl font-bold tracking-widest text-good"
              data-testid="won-client-code"
            >
              {result.clientCode}
            </p>
            <p className="mt-1 font-mono text-sm font-semibold" data-testid="won-deal-code">
              {t('won.deal')}: {result.dealCode}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="won-copy-code"
              onClick={() => void copyCode()}
              className="btn-secondary !min-h-10 flex-1"
            >
              {copied ? tq('copied') : tq('copy')}
            </button>
            <Link
              href={`/admin/clients/${result.clientId}`}
              data-testid="won-to-card"
              className="btn-ghost !min-h-10 text-xs"
            >
              {tq('toCard')}
            </Link>
          </div>
          <button
            type="button"
            data-testid="won-done"
            onClick={() => {
              setResult(null);
              onWon();
            }}
            className="btn-primary w-full"
          >
            {tq('done')}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-bold">{t('won.title')}</p>

          {lead?.clientCode ? (
            // Already a client: the choice was made once; what this press adds
            // is a NEW deal, and the sentence says so.
            <p className="rounded-xl bg-surface-sunken p-3 text-sm">
              {t('won.existing')}:{' '}
              <span className="font-mono font-bold">{lead.clientCode}</span>
              <br />
              <span className="text-ink-500">{t('won.confirmExisting')}</span>
            </p>
          ) : (
            <>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-testid="won-mode-mint"
                  onClick={() => {
                    setMode('mint');
                    setError('');
                  }}
                  className={mode === 'mint' ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
                >
                  {t('won.mint')}
                </button>
                <button
                  type="button"
                  data-testid="won-mode-attach"
                  onClick={() => {
                    setMode('attach');
                    setError('');
                  }}
                  className={mode === 'attach' ? 'btn-primary flex-1' : 'btn-secondary flex-1'}
                >
                  {t('won.attach')}
                </button>
              </div>

              {mode === 'mint' ? (
                <div className="space-y-2">
                  <input
                    className="input"
                    value={name}
                    data-testid="won-name"
                    aria-label={t('won.name')}
                    placeholder={t('won.name')}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <input
                    className="input font-mono"
                    value={code}
                    data-testid="won-code"
                    aria-label={t('won.codeOptional')}
                    placeholder={t('won.codeOptional')}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      className="input flex-1 font-mono"
                      value={attachCode}
                      data-testid="won-attach-code"
                      aria-label={t('won.attachCode')}
                      placeholder={t('won.attachCode')}
                      onChange={(event) => {
                        setAttachCode(event.target.value.toUpperCase());
                        setChecked(null);
                      }}
                    />
                    <button
                      type="button"
                      data-testid="won-check"
                      disabled={busy || attachCode.trim().length < 2}
                      onClick={() => void check()}
                      className="btn-secondary shrink-0"
                    >
                      {t('won.check')}
                    </button>
                  </div>
                  {/* The echo: who this code IS, read before anything is
                      written — the attach has no undo. */}
                  {checked && (
                    <p className="rounded-xl bg-good/10 p-2 text-sm" data-testid="won-checked">
                      <span className="font-mono font-bold">{checked.code}</span> — {checked.name}
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {error && (
            <p className="text-sm font-semibold text-bad" data-testid="won-error">
              {error}
            </p>
          )}

          <button
            type="button"
            data-testid="won-confirm"
            disabled={
              busy ||
              (!lead?.clientCode &&
                (mode === 'attach' ? !checked : name.trim().length < 2))
            }
            onClick={() => void confirm()}
            className="btn-primary w-full"
          >
            {t('won.confirm')}
          </button>
          <button type="button" data-testid="won-cancel" className="btn-ghost w-full" onClick={onClose}>
            {t('cancelMove')}
          </button>
        </div>
      )}
    </Overlay>
  );
}
