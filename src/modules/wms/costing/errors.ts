/**
 * A cost door's refusal (docs/YOLKIRA-TAQSIMOT.md §5). A zero-import leaf so
 * the copy, column and probe modules can throw it without importing
 * `./service` — a static cycle inside costing would crash a later top-level
 * `extends CostError` at module load. `./service` re-exports it, so no caller
 * changes.
 *
 * `params` carry what a sentence needs to NAME the thing to fix (the
 * warehouse, the column, the date, the densities); the action forwards them
 * whole through `costRefusal`, never by hand.
 */
export class CostError extends Error {
  constructor(
    public readonly code: string,
    public readonly params?: Record<string, string | number>,
  ) {
    super(code);
  }
}
