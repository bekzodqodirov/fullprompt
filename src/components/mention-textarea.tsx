'use client';

import { useRef, useState } from 'react';
import { autogrow } from '@/components/composer';
import { mentionCandidates, type MentionPerson } from '@/modules/wms/crm/mentions';

/**
 * A note box that understands "@" — phase 4's whole UI.
 *
 * Type @ and a few letters: a small list of colleagues appears above the
 * box; arrows move, Enter/Tab or a tap inserts the canonical `@Full Name`.
 * The canonical form matters: mentions are plain text, and the save-time
 * parser finds exactly what this dropdown inserted. No library — the
 * dropdown is a listbox and a regex.
 *
 * Safe with Enter: none of the boxes this replaces send on Enter (a note is
 * multi-line prose by design), so accepting a mention with Enter steals
 * nothing.
 */
const AT_QUERY = /(^|\s)@([^\s@]*)$/u;

export function MentionTextarea({
  name,
  placeholder,
  required = false,
  people,
  testid,
  bare = false,
}: {
  name: string;
  placeholder: string;
  required?: boolean;
  people: MentionPerson[];
  testid: string;
  /**
   * Round 73: inside a composer SHELL the box loses its own border — the
   * shell carries the focus ring for the whole group, and a bordered input
   * inside a bordered card reads as a form, not a place to talk.
   */
  bare?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const match = AT_QUERY.exec(before);
    setQuery(match ? match[2]! : null);
    setIndex(0);
  };

  const accept = (person: MentionPerson) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    const match = AT_QUERY.exec(before);
    if (!match) return;
    const start = caret - match[2]!.length - 1;
    el.value = `${el.value.slice(0, start)}@${person.name} ${el.value.slice(caret)}`;
    const position = start + person.name.length + 2;
    el.setSelectionRange(position, position);
    autogrow(el);
    setQuery(null);
    el.focus();
  };

  const candidates = query !== null && people.length > 0 ? mentionCandidates(query, people) : [];
  const open = candidates.length > 0;

  return (
    <div className="relative min-w-0 flex-1">
      {open && (
        <div
          data-testid="mention-list"
          className="absolute bottom-full left-0 z-20 mb-1 w-64 max-w-full space-y-0.5 rounded-xl border border-line bg-surface-raised p-1 shadow-pop"
        >
          {candidates.map((person, i) => (
            <button
              key={person.id}
              type="button"
              data-testid="mention-option"
              // Before blur/selection change, so a tap lands.
              onPointerDown={(event) => {
                event.preventDefault();
                accept(person);
              }}
              className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm font-semibold ${
                i === index ? 'bg-brand-50 text-brand-700' : ''
              }`}
            >
              @{person.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        name={name}
        rows={1}
        required={required}
        placeholder={placeholder}
        onChange={(event) => {
          autogrow(event.target);
          sync();
        }}
        onKeyUp={sync}
        onClick={sync}
        onBlur={() => setQuery(null)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex((i) => Math.min(i + 1, candidates.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            accept(candidates[index]!);
          } else if (event.key === 'Escape') {
            setQuery(null);
          }
        }}
        className={
          bare
            ? 'max-h-40 min-h-14 w-full resize-none border-0 bg-transparent px-1.5 py-2 text-sm outline-none placeholder:text-ink-400'
            : 'input-sm max-h-32 min-h-9 w-full resize-none py-2'
        }
        data-testid={testid}
      />
    </div>
  );
}
