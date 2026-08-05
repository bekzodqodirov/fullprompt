import { Icon } from '@/components/ui/icon';
import { saveCardFieldsAction } from '@/modules/platform/lists/card-fields-action';
import type { CardFieldSpec } from '@/modules/platform/lists/card-fields';

/**
 * «What do I want on a card» — a fold in the board's header.
 *
 * A native `<details>`, for the reasons every other fold in this app is one:
 * it works inside a server component, ships no JavaScript, and closes with the
 * page. The panel is positioned rather than in flow, so the CLOSED menu costs
 * the board no height — which matters because the board's height is a viewport
 * calculation and anything above it has to be paid for (round 65).
 *
 * `relative` goes on the header's actions ROW, not on this button: anchoring a
 * popover to its own trigger put the panel's left edge off-screen at 360 px in
 * round 51 and pushed the document to 487 px in round 57. Both times the fix
 * was the same one.
 */
export function CardFieldsMenu({
  board,
  specs,
  chosen,
  labels,
}: {
  board: string;
  specs: CardFieldSpec[];
  /** What is on today — the resolved set, defaults already applied. */
  chosen: Set<string>;
  labels: { title: string; save: string; field: (key: string) => string };
}) {
  const save = saveCardFieldsAction.bind(null, board);
  return (
    <details className="shrink-0" data-testid="card-fields-menu">
      <summary
        className="btn-secondary btn-icon cursor-pointer list-none marker:content-none"
        aria-label={labels.title}
        data-testid="card-fields-open"
      >
        <Icon name="menu" className="h-4 w-4" />
      </summary>
      <form
        action={save}
        className="absolute right-0 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] space-y-1.5 rounded-xl border border-line bg-surface-raised p-3 text-left shadow-card"
      >
        <p className="text-xs font-semibold text-ink-700">{labels.title}</p>
        {specs.map((spec) => (
          <label key={spec.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="field"
              value={spec.key}
              defaultChecked={chosen.has(spec.key)}
              data-testid={`card-field-${spec.key}`}
              className="h-4 w-4 shrink-0 accent-brand-600"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{labels.field(spec.labelKey)}</span>
          </label>
        ))}
        <button type="submit" data-testid="card-fields-save" className="btn-primary w-full !min-h-8">
          {labels.save}
        </button>
      </form>
    </details>
  );
}
