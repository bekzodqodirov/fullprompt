/**
 * Read a checkbox honestly.
 *
 * A browser sends nothing at all for an unchecked box, which is
 * indistinguishable from "the form has no such field" — so a naive read makes
 * "unticked" and "not part of this form" the same answer, and a partial form
 * silently switches a flag off. Every form here pairs the checkbox with a
 * hidden `off` before it, so the LAST value is the real answer and a form that
 * genuinely omits the field still gets the sensible default.
 */
export function checkbox(formData: FormData, name: string, fallback = true): boolean {
  const values = formData.getAll(name);
  return values.length === 0 ? fallback : values[values.length - 1] === 'on';
}
